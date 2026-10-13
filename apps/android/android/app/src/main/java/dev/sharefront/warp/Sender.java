package dev.sharefront.warp;

import android.content.ContentResolver;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The sending half, with the same two dials as the desktop:
 *   parallelFiles      - how many files move at once
 *   connectionsPerFile - how many ranged requests split one large file
 *
 * Above them sits the queue: how many whole transfers run at a time, with
 * pause, resume, cancel, reorder and per-file removal.
 */
public class Sender {

    private static final String TAG = "WarpSender";

    /** Wait before the first automatic retry of a whole transfer, doubled for each one after it. */
    private static final long AUTO_RETRY_DELAY_MS = 2_000;
    private static final long MAX_AUTO_RETRY_DELAY_MS = 60_000;

    public interface Callback {
        void onUpdate(Transfers.Outgoing transfer);

        void onProgress(Transfers.Outgoing transfer);
    }

    /** One chunk of one file. */
    private static class Chunk {
        final String fileId;
        final long start;
        final long end;
        int attempt;

        Chunk(String fileId, long start, long end) {
            this.fileId = fileId;
            this.start = start;
            this.end = end;
        }
    }

    /** A queued transfer and everything needed to drive it. */
    private class Job {
        final Transfers.Outgoing transfer;
        final Settings.Transfer settings;
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        final AtomicBoolean paused = new AtomicBoolean(false);
        final Object gate = new Object();
        String token;
        int priority;
        Thread thread;
        /** Bumped on every (re)start, so a thread left over from an earlier run cannot overwrite state. */
        int generation;
        /**
         * True from the moment a run's thread starts until it has settled the
         * job's state. Read and written under the Sender lock, so waking a
         * paused run and that run finishing can never interleave.
         */
        boolean runActive;
        /** The generation that set runActive; only that run's thread may clear it. */
        int runGeneration;

        Job(Transfers.Outgoing transfer, Settings.Transfer settings) {
            this.transfer = transfer;
            this.settings = settings;
        }

        void awaitResume() throws InterruptedException {
            synchronized (gate) {
                while (paused.get() && !cancelled.get()) gate.wait(500);
            }
        }

        void wake() {
            synchronized (gate) {
                gate.notifyAll();
            }
        }
    }

    private final TransferEngine engine;
    private final ContentResolver resolver;
    private final Callback callback;
    private final Map<String, Job> jobs = Collections.synchronizedMap(new LinkedHashMap<>());
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile boolean globallyPaused = false;
    private volatile int maxConcurrent = 2;

    public Sender(TransferEngine engine, ContentResolver resolver, Callback callback) {
        this.engine = engine;
        this.resolver = resolver;
        this.callback = callback;
    }

    public void setMaxConcurrent(int value) {
        maxConcurrent = Math.max(1, value);
        pump();
    }

    public boolean isPausedGlobally() {
        return globallyPaused;
    }

    public List<Transfers.Outgoing> list() {
        List<Transfers.Outgoing> result = new ArrayList<>();
        synchronized (jobs) {
            for (Job job : jobs.values()) result.add(job.transfer);
        }
        return result;
    }

    public Transfers.Outgoing get(String id) {
        Job job = jobs.get(id);
        return job != null ? job.transfer : null;
    }

    public int positionOf(String id) {
        int position = 0;
        synchronized (jobs) {
            List<Job> waiting = waitingJobs();
            for (Job job : waiting) {
                if (job.transfer.id.equals(id)) return position;
                position++;
            }
        }
        return -1;
    }

    private List<Job> waitingJobs() {
        List<Job> waiting = new ArrayList<>();
        for (Job job : jobs.values()) {
            if ("queued".equals(job.transfer.queueState)) waiting.add(job);
        }
        waiting.sort((a, b) -> Integer.compare(a.priority, b.priority));
        return waiting;
    }

    /**
     * Waiting jobs that may start now: not backing off, and not still winding
     * down a cancelled run. (A live thread that is not cancelled is a job
     * paused mid-flight; starting it just wakes that thread.)
     */
    private List<Job> startableJobs() {
        long now = System.currentTimeMillis();
        List<Job> startable = new ArrayList<>();
        for (Job job : waitingJobs()) {
            if (job.transfer.retryAt > now) continue;
            if (job.runActive && job.cancelled.get()) continue;
            startable.add(job);
        }
        return startable;
    }


    private int autoRetryLimit() {
        return engine.getSettings().transfer.queueAutoRetries;
    }

    private int runningCount() {
        int count = 0;
        for (Job job : jobs.values()) {
            if ("running".equals(job.transfer.queueState)) count++;
        }
        return count;
    }

    // --- queue ------------------------------------------------------------

    public Transfers.Outgoing enqueue(Discovery.Peer peer, List<Transfers.OutgoingFile> files,
                                      String label, Settings.Transfer settings) {
        Transfers.Outgoing transfer = new Transfers.Outgoing();
        transfer.id = UUID.randomUUID().toString();
        transfer.peer = peer;
        transfer.label = label;
        transfer.startedAt = System.currentTimeMillis();
        long total = 0;
        for (Transfers.OutgoingFile file : files) {
            if (file.id == null) file.id = UUID.randomUUID().toString();
            file.owner = transfer;
            transfer.files.add(file);
            transfer.byId.put(file.id, file);
            total += file.size;
        }
        transfer.totalBytes = total;

        Job job = new Job(transfer, settings);
        // Starting a job sends an offer to the peer, so "hold the queue" has to
        // be decided before anything is pumped.
        boolean startPaused = !settings.autoStartQueue;
        transfer.queueState = startPaused ? "paused" : "queued";
        transfer.paused = startPaused;
        job.paused.set(startPaused);
        job.priority = jobs.size();

        jobs.put(transfer.id, job);
        callback.onUpdate(transfer);
        if (!startPaused) pump();
        return transfer;
    }

    private synchronized void pump() {
        if (globallyPaused) return;
        int free = maxConcurrent - runningCount();
        if (free <= 0) return;
        for (Job job : startableJobs()) {
            if (free-- <= 0) break;
            startJob(job);
        }
    }

    private void startJob(Job job) {
        if (job.runActive && !job.cancelled.get()) {
            // Paused mid-flight and now back at the front of the line: its
            // thread is parked in awaitResume, so wake it instead of starting over.
            job.paused.set(false);
            job.transfer.paused = false;
            job.transfer.queueState = "running";
            job.wake();
            callback.onUpdate(job.transfer);
            return;
        }
        final int generation = ++job.generation;
        job.cancelled.set(false);
        job.paused.set(false);
        job.transfer.paused = false;
        job.transfer.queueState = "running";
        job.transfer.state = "pending";
        job.transfer.retryAt = 0;
        job.transfer.error = null;
        job.transfer.finishedAt = 0;
        job.runActive = true;
        job.runGeneration = generation;
        callback.onUpdate(job.transfer);

        job.thread = new Thread(() -> {
            boolean current = true;
            try {
                boolean done = run(job);
                synchronized (Sender.this) {
                    current = job.generation == generation;
                    if (job.runGeneration == generation) job.runActive = false;
                    if (current && !job.cancelled.get()) {
                        if (done) {
                            job.transfer.queueState = "complete";
                        } else if ("running".equals(job.transfer.queueState)) {
                            // Resumed just as this paused run returned: run it again.
                            job.transfer.queueState = "queued";
                        }
                    }
                }
            } catch (InterruptedException e) {
                synchronized (Sender.this) {
                    current = job.generation == generation;
                    if (job.runGeneration == generation) job.runActive = false;
                    if (current) {
                        job.transfer.state = "cancelled";
                        job.transfer.queueState = "cancelled";
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "transfer failed", e);
                synchronized (Sender.this) {
                    current = job.generation == generation;
                    if (job.runGeneration == generation) job.runActive = false;
                    if (current && !job.cancelled.get()) onFailure(job, e);
                }
            } finally {
                if (current && isFinished(job.transfer.queueState)) {
                    job.transfer.finishedAt = System.currentTimeMillis();
                }
                callback.onUpdate(job.transfer);
                pump();
            }
        }, "warp-send-" + job.transfer.id.substring(0, 8));
        job.thread.setDaemon(true);
        job.thread.start();
    }

    /** Either schedules an automatic retry, with backoff, or marks the job failed. */
    private void onFailure(Job job, Exception e) {
        Transfers.Outgoing transfer = job.transfer;
        String message = String.valueOf(e.getMessage());
        if (job.paused.get()) {
            // The user holds it: keep it held; resuming starts it afresh.
            // Not an automatic retry, so no attempt is spent.
            transfer.state = "pending";
            transfer.queueState = "paused";
            transfer.error = message;
            return;
        }
        if (transfer.attempts < autoRetryLimit()) {
            long delay = Math.min(MAX_AUTO_RETRY_DELAY_MS, AUTO_RETRY_DELAY_MS << transfer.attempts);
            transfer.attempts++;
            transfer.state = "queued";
            transfer.queueState = "queued";
            transfer.error = "retrying after: " + message;
            transfer.retryAt = System.currentTimeMillis() + delay;
            pool.execute(() -> {
                try {
                    Thread.sleep(delay);
                } catch (InterruptedException ignored) {
                    return;
                }
                transfer.retryAt = 0;
                callback.onUpdate(transfer);
                pump();
            });
            return;
        }
        transfer.state = "failed";
        transfer.queueState = "failed";
        transfer.error = message;
    }

    public void pause(String id) {
        Job job = jobs.get(id);
        if (job == null || isFinished(job.transfer.queueState)) return;
        job.transfer.retryAt = 0;
        job.paused.set(true);
        job.transfer.paused = true;
        job.transfer.queueState = "paused";
        callback.onUpdate(job.transfer);
        pump();
    }

    /**
     * Puts a paused job back in line. It still waits for a free slot: pausing
     * let the next job in, and resuming must not exceed the concurrency limit.
     * The job stays held (paused flag set) until startJob actually wakes it.
     */
    public void resume(String id) {
        Job job = jobs.get(id);
        if (job == null || !"paused".equals(job.transfer.queueState)) return;
        job.transfer.queueState = "queued";
        callback.onUpdate(job.transfer);
        pump();
    }

    public void cancel(String id) {
        Job job = jobs.get(id);
        if (job == null) return;
        job.cancelled.set(true);
        job.paused.set(false);
        job.wake();
        job.transfer.retryAt = 0;
        job.transfer.state = "cancelled";
        job.transfer.queueState = "cancelled";
        job.transfer.finishedAt = System.currentTimeMillis();
        callback.onUpdate(job.transfer);
        // Let the peer drop its partial files.
        pool.execute(() -> {
            try {
                post(job.transfer.peer, "/api/transfer/" + job.transfer.id + "/cancel", null, null);
            } catch (Exception ignored) {
            }
        });
        pump();
    }

    /**
     * Re-queues a failed or cancelled job. The cancelled flag stays set until
     * the job actually restarts, so a thread still winding down from the old
     * run stops instead of carrying on beside the new one.
     */
    public synchronized void retry(String id) {
        Job job = jobs.get(id);
        if (job == null || !isFinished(job.transfer.queueState)) return;
        job.generation++;
        job.paused.set(false);
        job.transfer.paused = false;
        job.transfer.error = null;
        job.transfer.state = "queued";
        job.transfer.queueState = "queued";
        job.transfer.attempts = 0;
        job.transfer.retryAt = 0;
        callback.onUpdate(job.transfer);
        pump();
    }

    public void remove(String id) {
        Job job = jobs.get(id);
        if (job == null) return;
        // Cancel while it is still in the map: cancel() looks the job up by id.
        if (!isFinished(job.transfer.queueState)) cancel(id);
        jobs.remove(id);
        pump();
    }

    /** Drops one file without cancelling the rest of the transfer. */
    public boolean removeFile(String transferId, String fileId) {
        Job job = jobs.get(transferId);
        if (job == null || isFinished(job.transfer.queueState)) return false;
        Transfers.OutgoingFile file = job.transfer.byId.get(fileId);
        if (file == null) return false;
        synchronized (job.transfer) {
            if (file.removed || file.done) return false;
            // Take back what it already counted; count() ignores it from now on.
            file.removed = true;
            job.transfer.bytesTransferred -= file.transferred;
            file.transferred = 0;
            job.transfer.totalBytes -= file.size;
        }
        callback.onUpdate(job.transfer);
        return true;
    }

    public void move(String id, String direction) {
        synchronized (jobs) {
            List<Job> waiting = waitingJobs();
            int index = -1;
            for (int i = 0; i < waiting.size(); i++) {
                if (waiting.get(i).transfer.id.equals(id)) {
                    index = i;
                    break;
                }
            }
            if (index < 0) return;
            Job moved = waiting.remove(index);
            int target = "top".equals(direction) ? 0
                    : "up".equals(direction) ? Math.max(0, index - 1)
                    : Math.min(waiting.size(), index + 1);
            waiting.add(target, moved);
            for (int i = 0; i < waiting.size(); i++) waiting.get(i).priority = i;
        }
        callback.onUpdate(jobs.get(id).transfer);
    }

    public void pauseAll() {
        globallyPaused = true;
        synchronized (jobs) {
            for (Job job : jobs.values()) {
                if ("running".equals(job.transfer.queueState)) {
                    job.paused.set(true);
                    job.transfer.paused = true;
                    job.transfer.queueState = "paused";
                }
            }
        }
        callback.onUpdate(null);
    }

    public void resumeAll() {
        globallyPaused = false;
        synchronized (jobs) {
            for (Job job : jobs.values()) {
                if ("paused".equals(job.transfer.queueState)) {
                    // Back in line; startJob wakes or restarts it when a slot is free.
                    job.transfer.queueState = "queued";
                }
            }
        }
        callback.onUpdate(null);
        pump();
    }

    public void cancelAll() {
        List<String> ids = new ArrayList<>();
        synchronized (jobs) {
            for (Job job : jobs.values()) {
                if (!isFinished(job.transfer.queueState)) ids.add(job.transfer.id);
            }
        }
        for (String id : ids) cancel(id);
    }

    public void clearFinished() {
        synchronized (jobs) {
            jobs.values().removeIf(job -> isFinished(job.transfer.queueState));
        }
    }

    public boolean isBusy() {
        synchronized (jobs) {
            for (Job job : jobs.values()) {
                if ("running".equals(job.transfer.queueState)) return true;
            }
        }
        return false;
    }

    private static boolean isFinished(String state) {
        return "complete".equals(state) || "failed".equals(state) || "cancelled".equals(state);
    }

    // --- the actual transfer ---------------------------------------------

    /**
     * One attempt at the whole transfer. Returns false when it stopped only
     * because the job was paused, so a later start has to run it again.
     */
    private boolean run(Job job) throws Exception {
        Transfers.Outgoing transfer = job.transfer;
        List<Transfers.OutgoingFile> active = new ArrayList<>();
        for (Transfers.OutgoingFile file : transfer.files) {
            if (!file.removed) active.add(file);
        }
        if (active.isEmpty()) {
            transfer.state = "complete";
            return true;
        }

        // run() repeats for every retry: rebuild the counters from what the
        // receiver confirms rather than adding to the last attempt's.
        synchronized (transfer) {
            transfer.bytesTransferred = 0;
            transfer.filesCompleted = 0;
            transfer.chunkRetries = 0;
            for (Transfers.OutgoingFile file : active) {
                file.transferred = 0;
                file.done = false;
            }
        }

        // 1. Offer.
        JSONObject offer = new JSONObject();
        offer.put("transferId", transfer.id);
        offer.put("from", engine.selfDeviceJson());
        offer.put("label", transfer.label);
        long total = 0;
        JSONArray files = new JSONArray();
        for (Transfers.OutgoingFile file : active) {
            JSONObject entry = new JSONObject();
            entry.put("id", file.id);
            entry.put("path", file.path);
            entry.put("size", file.size);
            if (file.mtime > 0) entry.put("mtime", file.mtime);
            files.put(entry);
            total += file.size;
        }
        offer.put("files", files);
        offer.put("totalBytes", total);

        String response = post(transfer.peer, "/api/offer", offer.toString(), null);
        JSONObject status = new JSONObject(response);

        // 2. Wait for the human on the other end.
        while ("pending".equals(status.optString("state"))) {
            if (job.cancelled.get()) throw new InterruptedException("cancelled");
            Thread.sleep(600);
            status = new JSONObject(get(transfer.peer, "/api/transfer/" + transfer.id + "/status"));
        }
        if ("declined".equals(status.optString("state"))) {
            transfer.state = "declined";
            return true;
        }
        if ("cancelled".equals(status.optString("state"))) {
            // The receiver removed this transfer; retrying cannot change its mind.
            transfer.state = "cancelled";
            transfer.error = status.optString("error", "cancelled on the other device");
            return true;
        }
        job.token = status.optString("token", null);
        if (job.token == null || job.token.isEmpty()) throw new IOException("peer accepted without a token");

        transfer.state = "sending";
        transfer.savedTo = status.optString("savedTo", null);
        callback.onUpdate(transfer);

        // 3. Resume: ask what the peer already holds.
        Map<String, Transfers.RangeSet> known = new LinkedHashMap<>();
        if (job.settings.resumeEnabled) {
            try {
                JSONObject ranged = new JSONObject(
                        get(transfer.peer, "/api/transfer/" + transfer.id + "/status?ranges=1"));
                JSONObject ranges = ranged.optJSONObject("ranges");
                if (ranges != null) {
                    for (Transfers.OutgoingFile file : active) {
                        known.put(file.id, Transfers.RangeSet.fromJson(ranges.optJSONArray(file.id)));
                    }
                }
            } catch (Exception ignored) {
                // Resume is best-effort.
            }
        }

        // 4. Upload, honouring both dials.
        uploadAll(job, active, known);

        if (job.cancelled.get()) {
            transfer.state = "cancelled";
            return true;
        }
        if (job.paused.get()) {
            // The queue will resume us; do not finalize.
            transfer.state = "sending";
            return false;
        }

        // 5. Finish, telling the peer about anything dropped from the queue.
        JSONObject finish = new JSONObject();
        JSONArray removed = new JSONArray();
        for (Transfers.OutgoingFile file : transfer.files) {
            if (file.removed) removed.put(file.id);
        }
        finish.put("removed", removed);

        String finished = post(transfer.peer, "/api/transfer/" + transfer.id + "/finish",
                finish.toString(), job.token);
        JSONObject finalStatus = new JSONObject(finished);
        transfer.savedTo = finalStatus.optString("savedTo", transfer.savedTo);

        // Anything short of an explicit "complete" means the receiver did not finalize.
        if (!"complete".equals(finalStatus.optString("state"))) {
            transfer.state = "failed";
            transfer.error = finalStatus.optString("error", "the other device reported a problem");
            throw new IOException(transfer.error);
        }
        transfer.state = "complete";
        return true;
    }

    private void uploadAll(Job job, List<Transfers.OutgoingFile> files,
                           Map<String, Transfers.RangeSet> known) throws Exception {
        Settings.Transfer settings = job.settings;
        Transfers.Outgoing transfer = job.transfer;

        final AtomicLong lastSample = new AtomicLong(System.currentTimeMillis());
        final AtomicLong lastBytes = new AtomicLong(transfer.bytesTransferred);
        final AtomicInteger inFlight = new AtomicInteger(0);
        final List<Exception> failures = Collections.synchronizedList(new ArrayList<>());

        // Files move parallelFiles at a time; each one splits across
        // connectionsPerFile ranged requests.
        java.util.concurrent.Semaphore fileSlots = new java.util.concurrent.Semaphore(
                Math.max(1, settings.parallelFiles));
        List<Thread> fileThreads = new ArrayList<>();

        for (Transfers.OutgoingFile file : files) {
            if (job.cancelled.get()) break;
            fileSlots.acquire();

            Thread worker = new Thread(() -> {
                try {
                    if (file.removed) return;
                    List<Chunk> chunks = planChunks(file, settings, known.get(file.id));
                    if (chunks.isEmpty()) {
                        synchronized (transfer) {
                            if (!file.removed) {
                                file.done = true;
                                transfer.filesCompleted++;
                            }
                        }
                        return;
                    }

                    java.util.concurrent.Semaphore connections =
                            new java.util.concurrent.Semaphore(Math.max(1, settings.connectionsPerFile));
                    List<Thread> chunkThreads = new ArrayList<>();

                    for (Chunk chunk : chunks) {
                        if (job.cancelled.get() || file.removed) break;
                        job.awaitResume();
                        connections.acquire();

                        Thread chunkThread = new Thread(() -> {
                            inFlight.incrementAndGet();
                            transfer.activeConnections = inFlight.get();
                            try {
                                sendChunk(job, file, chunk, settings, () -> {
                                    long now = System.currentTimeMillis();
                                    long elapsed = now - lastSample.get();
                                    if (elapsed > 500) {
                                        long moved = transfer.bytesTransferred - lastBytes.get();
                                        transfer.bytesPerSecond = moved * 1000.0 / elapsed;
                                        lastSample.set(now);
                                        lastBytes.set(transfer.bytesTransferred);
                                    }
                                    callback.onProgress(transfer);
                                });
                            } catch (Exception e) {
                                failures.add(e);
                            } finally {
                                connections.release();
                                inFlight.decrementAndGet();
                                transfer.activeConnections = inFlight.get();
                            }
                        }, "warp-chunk");
                        chunkThread.setDaemon(true);
                        chunkThread.start();
                        chunkThreads.add(chunkThread);
                    }

                    for (Thread chunkThread : chunkThreads) chunkThread.join();
                    if (!job.cancelled.get() && failures.isEmpty()) {
                        // Checked under the lock removeFile takes, so the two cannot interleave.
                        synchronized (transfer) {
                            if (!file.removed) {
                                file.done = true;
                                transfer.filesCompleted++;
                            }
                        }
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                } finally {
                    fileSlots.release();
                }
            }, "warp-file");
            worker.setDaemon(true);
            worker.start();
            fileThreads.add(worker);
        }

        for (Thread worker : fileThreads) worker.join();
        transfer.activeConnections = 0;
        transfer.bytesPerSecond = 0;

        if (!failures.isEmpty() && !job.cancelled.get()) throw failures.get(0);
    }

    /**
     * Chunking is independent of the connection count: chunk size sets the
     * granularity (how little is re-sent after a pause), connections set how
     * many are in flight.
     */
    private List<Chunk> planChunks(Transfers.OutgoingFile file, Settings.Transfer settings,
                                   Transfers.RangeSet known) {
        List<Chunk> chunks = new ArrayList<>();
        if (file.size <= settings.splitThresholdBytes || file.size == 0) {
            chunks.add(new Chunk(file.id, 0, file.size));
        } else {
            long perConnection = (long) Math.ceil(file.size / (double) Math.max(1, settings.connectionsPerFile));
            long chunkSize = Math.max(64 * 1024, Math.min(settings.chunkSizeBytes, perConnection));
            for (long start = 0; start < file.size; start += chunkSize) {
                chunks.add(new Chunk(file.id, start, Math.min(file.size, start + chunkSize)));
            }
        }

        if (known == null || known.size() == 0) return chunks;

        // Drop what the peer already holds, and trim the partial pieces.
        List<Chunk> trimmed = new ArrayList<>();
        for (Chunk chunk : chunks) {
            for (long[] gap : known.missing(chunk.end)) {
                long start = Math.max(chunk.start, gap[0]);
                long end = Math.min(chunk.end, gap[1]);
                if (end > start) trimmed.add(new Chunk(chunk.fileId, start, end));
            }
        }
        count(file, known.size());
        return trimmed;
    }

    private void sendChunk(Job job, Transfers.OutgoingFile file, Chunk chunk,
                           Settings.Transfer settings, Runnable onProgress) throws Exception {
        long length = chunk.end - chunk.start;
        if (length <= 0) return;

        int attempt = 0;
        while (true) {
            if (job.cancelled.get()) return;
            job.awaitResume();

            // Bytes this attempt counted, so a failure undoes exactly those.
            long sent = 0;
            HttpURLConnection connection = null;
            try {
                URL url = new URL("http://" + job.transfer.peer.address + ":" + job.transfer.peer.port
                        + "/api/transfer/" + job.transfer.id + "/file/" + file.id);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("PUT");
                connection.setDoOutput(true);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(120_000);
                connection.setRequestProperty("Content-Type", "application/octet-stream");
                connection.setRequestProperty("x-share-token", job.token);
                connection.setRequestProperty("x-share-offset", String.valueOf(chunk.start));
                connection.setRequestProperty("x-share-device", engine.getSelfId());
                connection.setFixedLengthStreamingMode(length);

                try (InputStream source = openAt(file, chunk.start);
                     OutputStream out = new BufferedOutputStream(connection.getOutputStream(), 128 * 1024)) {
                    byte[] buffer = new byte[128 * 1024];
                    long remaining = length;
                    while (remaining > 0) {
                        if (job.cancelled.get()) throw new InterruptedException("cancelled");
                        int wanted = (int) Math.min(buffer.length, remaining);
                        int read = source.read(buffer, 0, wanted);
                        if (read < 0) throw new IOException("source ended early for " + file.path);
                        out.write(buffer, 0, read);
                        remaining -= read;
                        sent += read;
                        count(file, read);
                        onProgress.run();
                    }
                    out.flush();
                }

                int status = connection.getResponseCode();
                if (status == 503) {
                    // The receiver paused. Wait it out rather than burn a retry.
                    count(file, -sent);
                    Thread.sleep(2_000);
                    continue;
                }
                if (status != 200) {
                    throw new IOException("chunk rejected with HTTP " + status);
                }
                return;
            } catch (InterruptedException e) {
                count(file, -sent);
                throw e;
            } catch (Exception e) {
                count(file, -sent);
                if (job.cancelled.get() || attempt >= settings.retries) throw e;
                synchronized (job.transfer) {
                    job.transfer.chunkRetries++;
                }
                Thread.sleep(Math.min(15_000L, settings.retryBackoffMs * (1L << attempt)));
                attempt++;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
    }

    /** Several chunk threads update the same counters; keep the sums exact. */
    private static void count(Transfers.OutgoingFile file, long delta) {
        if (delta == 0) return;
        synchronized (file.owner) {
            // A removed file's bytes were taken out of the totals; late chunks must not add them back.
            if (file.removed) return;
            file.transferred += delta;
            file.owner.bytesTransferred += delta;
        }
    }

    /**
     * Opens a source at a byte offset.
     *
     * Two kinds of source exist on Android: real filesystem paths (the app's
     * own directory) and content:// URIs from SAF or MediaStore. A real path
     * can seek directly, which matters a lot for ranged chunks; a content URI
     * usually cannot, so the offset has to be read away.
     */
    private InputStream openAt(Transfers.OutgoingFile file, long offset) throws IOException {
        String source = file.sourceUri;

        if (source != null && !source.startsWith("content://")) {
            java.io.RandomAccessFile handle = new java.io.RandomAccessFile(new java.io.File(source), "r");
            handle.seek(offset);
            // Closing the stream closes the handle with it.
            return new java.io.BufferedInputStream(new java.io.FileInputStream(handle.getFD()) {
                @Override
                public void close() throws IOException {
                    try {
                        super.close();
                    } finally {
                        handle.close();
                    }
                }
            }, 128 * 1024);
        }

        InputStream stream = resolver.openInputStream(Uri.parse(source));
        if (stream == null) throw new IOException("cannot read " + file.path);
        long skipped = 0;
        while (skipped < offset) {
            long step = stream.skip(offset - skipped);
            if (step <= 0) {
                // Some providers refuse to skip; read the difference away.
                long remaining = offset - skipped;
                byte[] sink = new byte[(int) Math.min(64 * 1024, remaining)];
                int read = stream.read(sink);
                if (read < 0) throw new IOException("cannot seek in " + file.path);
                skipped += read;
                continue;
            }
            skipped += step;
        }
        return stream;
    }

    // --- tiny HTTP client -------------------------------------------------

    /** GET /api/info on a host, used to verify a manually typed address. */
    public String fetchInfo(String host, int port) throws IOException {
        Discovery.Peer probe = new Discovery.Peer();
        probe.address = host;
        probe.port = port;
        return get(probe, "/api/info");
    }

    private String get(Discovery.Peer peer, String path) throws IOException {
        HttpURLConnection connection = (HttpURLConnection)
                new URL("http://" + peer.address + ":" + peer.port + path).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        try {
            return readAll(connection);
        } finally {
            connection.disconnect();
        }
    }

    String post(Discovery.Peer peer, String path, String body, String token) throws IOException {
        HttpURLConnection connection = (HttpURLConnection)
                new URL("http://" + peer.address + ":" + peer.port + path).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        if (token != null) connection.setRequestProperty("x-share-token", token);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
        }
        try {
            return readAll(connection);
        } finally {
            connection.disconnect();
        }
    }

    /** The response body; an error status throws, carrying the peer's reason. */
    private static String readAll(HttpURLConnection connection) throws IOException {
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String body = "{}";
        if (stream != null) {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
            stream.close();
            body = buffer.toString("UTF-8");
        }
        if (status >= 400) {
            String reason = body;
            try {
                reason = new JSONObject(body).optString("error", body);
            } catch (Exception ignored) {
                // Not JSON; use the raw body.
            }
            if (reason.length() > 160) reason = reason.substring(0, 160);
            throw new IOException("HTTP " + status + ": " + reason);
        }
        return body;
    }

    public void shutdown() {
        cancelAll();
        pool.shutdownNow();
    }
}
