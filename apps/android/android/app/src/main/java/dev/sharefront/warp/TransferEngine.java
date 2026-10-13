package dev.sharefront.warp;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import androidx.documentfile.provider.DocumentFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The single long-lived object that owns discovery, the receiving server and
 * the sending queue. It lives in the process, not in the Activity, so a
 * transfer survives the UI being destroyed; TransferService keeps the process
 * itself alive.
 */
public class TransferEngine {

    private static final String TAG = "WarpEngine";
    private static TransferEngine instance;

    public interface StateListener {
        void onStateChanged();

        void onTextReceived(String text, String fromName);
    }

    public interface ServiceCallback {
        void onBusyChanged(boolean busy, String summary, int percent);
    }

    private final Context context;
    private final Settings settings;
    private final Discovery discovery;
    private final HttpServer server;
    private final Sender sender;
    private final Map<String, Transfers.Incoming> incoming = new ConcurrentHashMap<>();
    /** Transfers the user removed while live, so a re-offer is refused instead of prompting again. */
    private final java.util.Set<String> removedIncoming = ConcurrentHashMap.newKeySet();

    private StateListener stateListener;
    private ServiceCallback serviceCallback;
    private volatile boolean started = false;
    private volatile boolean lastBusy = false;
    private long lastNotify = 0;

    public static synchronized TransferEngine getInstance(Context context) {
        if (instance == null) instance = new TransferEngine(context.getApplicationContext());
        return instance;
    }

    private TransferEngine(Context context) {
        this.context = context;
        this.settings = new Settings(context);
        if (settings.downloadDirectory == null || settings.downloadDirectory.isEmpty()) {
            // A real path inside the app's own storage: full random access, no
            // permission prompt. The user can point this at any folder later.
            File received = new File(context.getExternalFilesDir(null), "Received");
            if (!received.exists()) received.mkdirs();
            settings.downloadDirectory = received.getAbsolutePath();
            settings.save();
        }

        this.discovery = new Discovery(this);
        this.sender = new Sender(this, context.getContentResolver(), new Sender.Callback() {
            @Override
            public void onUpdate(Transfers.Outgoing transfer) {
                notifyState(true);
            }

            @Override
            public void onProgress(Transfers.Outgoing transfer) {
                notifyState(false);
            }
        });
        this.server = new HttpServer(this, new HttpServer.Callback() {
            @Override
            public boolean shouldAutoAccept(Transfers.Incoming transfer) {
                return !settings.confirmIncoming || settings.autoAcceptFrom.contains(transfer.fromId);
            }

            @Override
            public void onOffer(Transfers.Incoming transfer) {
                notifyState(true);
            }

            @Override
            public void onProgress(Transfers.Incoming transfer) {
                notifyState(false);
            }

            @Override
            public void onUpdate(Transfers.Incoming transfer) {
                notifyState(true);
            }

            @Override
            public void onText(String text, String fromName) {
                StateListener listener = stateListener;
                if (listener != null) listener.onTextReceived(text, fromName);
            }
        });
        discovery.setListener(() -> notifyState(true));
    }

    public Settings getSettings() {
        return settings;
    }

    public Sender getSender() {
        return sender;
    }

    public Discovery getDiscovery() {
        return discovery;
    }

    public void setStateListener(StateListener listener) {
        this.stateListener = listener;
    }

    public void setServiceCallback(ServiceCallback callback) {
        this.serviceCallback = callback;
    }

    public synchronized void start() {
        if (started) return;
        started = true;
        try {
            int port = server.start(settings.httpPort);
            Log.i(TAG, "listening on " + port);
        } catch (Exception e) {
            Log.e(TAG, "could not start the transfer server", e);
        }
        sender.setMaxConcurrent(settings.transfer.maxConcurrentTransfers);
        discovery.setEnabled(settings.broadcast, settings.multicast);
        discovery.start();
        for (String host : settings.manualPeers) discovery.probe(host);
    }

    public synchronized void stop() {
        started = false;
        discovery.stop();
        server.stop();
        sender.shutdown();
    }

    public String getSelfId() {
        return settings.getDeviceId();
    }

    public JSONObject selfDeviceJson() throws Exception {
        JSONObject device = new JSONObject();
        device.put("id", settings.getDeviceId());
        device.put("name", settings.deviceName);
        device.put("platform", "android");
        device.put("deviceType", "phone");
        device.put("port", server.getPort() > 0 ? server.getPort() : settings.httpPort);
        device.put("protocol", 1);
        return device;
    }

    // --- incoming ---------------------------------------------------------

    public Transfers.Incoming getIncoming(String id) {
        return incoming.get(id);
    }

    public void putIncoming(Transfers.Incoming transfer) {
        incoming.put(transfer.id, transfer);
    }

    public List<Transfers.Incoming> listIncoming() {
        return new ArrayList<>(incoming.values());
    }

    public boolean wasRemoved(String id) {
        return removedIncoming.contains(id);
    }

    /**
     * Removes a transfer from the list. A live one is cancelled first, so its
     * files are closed and its partials deleted, and a re-offer is refused.
     */
    public void forgetIncoming(String id) {
        Transfers.Incoming transfer = incoming.get(id);
        if (transfer == null) return;
        if ("pending".equals(transfer.state) || "accepted".equals(transfer.state)
                || "sending".equals(transfer.state)) {
            removedIncoming.add(id);
            cancelIncoming(id, "removed");
        }
        incoming.remove(id);
        closeSinks(transfer, false);
        notifyState(true);
    }

    /** Accepts an offer and prepares a destination for every file. */
    public synchronized void acceptIncoming(String id, String destinationOverride) {
        Transfers.Incoming transfer = incoming.get(id);
        if (transfer == null || !"pending".equals(transfer.state)) return;

        String base = destinationOverride != null ? destinationOverride : settings.downloadDirectory;
        String folder = base;
        transfer.subfolder = null;
        if (settings.groupBySender) {
            String safe = Paths.sanitizeRelative(transfer.fromName);
            String name = safe != null ? safe : "Shared";
            if (base.startsWith("content://")) {
                // A SAF tree URI cannot simply be extended with a path; the
                // folder is created inside the tree when the first file lands.
                transfer.subfolder = name;
            } else {
                folder = base + File.separator + name;
            }
        }

        transfer.destination = folder;
        transfer.token = UUID.randomUUID().toString().replace("-", "");
        transfer.state = "accepted";
        notifyState(true);
    }

    /**
     * The sender is retrying a transfer that ended badly.
     *
     * A failure keeps its acceptance, destination and every range that landed,
     * so the retry only fills the holes. A cancellation deleted the partial
     * files, so those start over and the offer goes back to the user; files
     * that were already finished stay finished either way. Returns true when
     * the offer needs a decision again.
     */
    public synchronized boolean reopenIncoming(Transfers.Incoming transfer) {
        boolean wasCancelled = "cancelled".equals(transfer.state);
        transfer.error = null;
        transfer.finishedAt = 0;
        long received = 0;
        for (Transfers.IncomingFile file : transfer.files.values()) {
            file.error = null;
            if (wasCancelled && !file.done) file.ranges.clear();
            received += file.ranges.size();
        }
        transfer.bytesReceived = received;
        if (!wasCancelled) {
            transfer.state = "accepted";
            notifyState(true);
            return false;
        }
        transfer.state = "pending";
        transfer.token = null;
        notifyState(true);
        return true;
    }

    public void declineIncoming(String id) {
        Transfers.Incoming transfer = incoming.get(id);
        if (transfer == null) return;
        transfer.state = "declined";
        notifyState(true);
    }

    public void pauseIncoming(String id) {
        Transfers.Incoming transfer = incoming.get(id);
        if (transfer == null) return;
        transfer.paused = true;
        notifyState(true);
    }

    public void resumeIncoming(String id) {
        Transfers.Incoming transfer = incoming.get(id);
        if (transfer == null) return;
        transfer.paused = false;
        notifyState(true);
    }

    public void cancelIncoming(String id, String reason) {
        Transfers.Incoming transfer = incoming.get(id);
        if (transfer == null) return;
        transfer.state = "cancelled";
        transfer.error = reason;
        closeSinks(transfer, true);
        // The partial files are gone, so the ranges describing them must go too.
        for (Transfers.IncomingFile file : transfer.files.values()) {
            if (!file.done) file.ranges.clear();
        }
        notifyState(true);
    }

    /**
     * Opens (once) the destination for a file. Writes land in a ".part" file so
     * a half-received transfer is never mistaken for a finished one.
     */
    public synchronized FileSink sinkFor(Transfers.Incoming transfer, Transfers.IncomingFile file) throws Exception {
        if (file.sink != null) return file.sink;

        String destination = transfer.destination;
        if (destination == null) throw new IllegalStateException("transfer has no destination");

        if (destination.startsWith("content://")) {
            // The URI is used exactly as the picker returned it: its encoded
            // "%2F"s are part of the document ID and must stay encoded.
            DocumentFile tree = DocumentFile.fromTreeUri(context, Uri.parse(destination));
            if (tree == null) throw new IllegalStateException("cannot open the chosen folder");

            // Recreate the sender's folder structure inside the tree.
            String relative = transfer.subfolder != null
                    ? transfer.subfolder + "/" + file.relativePath
                    : file.relativePath;
            String[] segments = relative.split("/");
            DocumentFile directory = tree;
            for (int i = 0; i < segments.length - 1; i++) {
                DocumentFile child = directory.findFile(segments[i]);
                if (child == null || !child.isDirectory()) child = directory.createDirectory(segments[i]);
                if (child == null) throw new IllegalStateException("cannot create " + segments[i]);
                directory = child;
            }
            String name = partName(transfer, file);
            DocumentFile existing = directory.findFile(name);
            DocumentFile document = existing != null ? existing
                    : directory.createFile("application/octet-stream", name);
            if (document == null) throw new IllegalStateException("cannot create " + name);

            file.finalPath = directory.getUri().toString();
            file.sink = new FileSink(context.getContentResolver(), document.getUri(), file.size,
                    spoolFile(transfer, file));
        } else {
            File target = partFile(transfer, file);
            file.finalPath = new File(destination, file.relativePath).getAbsolutePath();
            file.sink = new FileSink(target, file.size);
        }
        return file.sink;
    }

    /**
     * The partial file's name. Keyed by transfer and file, so two transfers
     * delivering the same name to the same folder never share (and corrupt)
     * one partial - a failed transfer keeps its partial for a retry.
     */
    private static String partName(Transfers.Incoming transfer, Transfers.IncomingFile file) {
        String leaf = file.relativePath.substring(file.relativePath.lastIndexOf('/') + 1);
        return leaf + "." + shortKey(transfer.id + "/" + file.id) + ".part";
    }

    private static File partFile(Transfers.Incoming transfer, Transfers.IncomingFile file) {
        File target = new File(transfer.destination, file.relativePath);
        return new File(target.getParentFile(), partName(transfer, file));
    }

    /** Private stand-in for a SAF document whose provider cannot write at offsets. */
    private File spoolFile(Transfers.Incoming transfer, Transfers.IncomingFile file) {
        File base = context.getExternalCacheDir() != null ? context.getExternalCacheDir() : context.getCacheDir();
        return new File(new File(base, "incoming"), shortKey(transfer.id + "/" + file.id) + ".spool");
    }

    private static String shortKey(String value) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-1")
                    .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 4; i++) hex.append(String.format(java.util.Locale.US, "%02x", digest[i]));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            return Integer.toHexString(value.hashCode());
        }
    }

    /** Deletes a file's partial, wherever it lives, along with any spool. */
    private void deletePartial(Transfers.Incoming transfer, Transfers.IncomingFile file) {
        if (file.sink != null) {
            file.sink.discard();
            file.sink = null;
        }
        if (transfer.destination == null) return;
        if (!transfer.destination.startsWith("content://")) {
            //noinspection ResultOfMethodCallIgnored
            partFile(transfer, file).delete();
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        spoolFile(transfer, file).delete();
        // Only known once the file was opened; before that no partial exists.
        if (file.finalPath == null) return;
        DocumentFile directory = DocumentFile.fromTreeUri(context, Uri.parse(file.finalPath));
        DocumentFile part = directory != null ? directory.findFile(partName(transfer, file)) : null;
        if (part != null) part.delete();
    }

    /** Closes the handle and drops the ".part" suffix. */
    public void finalizeFile(Transfers.Incoming transfer, Transfers.IncomingFile file) {
        try {
            // An empty file never receives a chunk, so nothing has created it yet.
            if (file.sink == null && file.size == 0) sinkFor(transfer, file);
            if (file.sink != null) {
                file.sink.flush();
                // A spooled SAF sink copies its bytes into the document here.
                file.sink.commit();
                file.sink.close();
                file.sink = null;
            }
            if (transfer.destination != null && !transfer.destination.startsWith("content://")) {
                File part = partFile(transfer, file);
                File target = new File(transfer.destination, file.relativePath);
                File unique = target;
                for (int i = 2; unique.exists(); i++) {
                    unique = new File(target.getParentFile(), Paths.withSuffix(target.getName(), i));
                }
                if (part.renameTo(unique)) file.finalPath = unique.getAbsolutePath();
                if (file.mtime > 0) unique.setLastModified(file.mtime);
            } else if (file.finalPath != null) {
                DocumentFile directory = DocumentFile.fromTreeUri(context, Uri.parse(file.finalPath));
                String name = file.relativePath.substring(file.relativePath.lastIndexOf('/') + 1);
                if (directory != null) {
                    DocumentFile part = directory.findFile(partName(transfer, file));
                    if (part != null) part.renameTo(name);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "could not finalize " + file.relativePath, e);
        }
    }

    /** Removes a file the sender dropped from its queue after offering it. */
    public void discardFile(Transfers.Incoming transfer, Transfers.IncomingFile file) {
        try {
            deletePartial(transfer, file);
        } catch (Exception ignored) {
        }
    }

    public void closeSinks(Transfers.Incoming transfer, boolean deletePartials) {
        for (Transfers.IncomingFile file : transfer.files.values()) {
            try {
                if (deletePartials && !file.done) {
                    deletePartial(transfer, file);
                } else if (file.sink != null) {
                    file.sink.close();
                    file.sink = null;
                }
            } catch (Exception ignored) {
            }
        }
    }

    // --- queue passthrough ------------------------------------------------

    public void pauseAll() {
        sender.pauseAll();
        for (Transfers.Incoming transfer : incoming.values()) transfer.paused = true;
        notifyState(true);
    }

    public void resumeAll() {
        sender.resumeAll();
        for (Transfers.Incoming transfer : incoming.values()) transfer.paused = false;
        notifyState(true);
    }

    public boolean isPausedGlobally() {
        return sender.isPausedGlobally();
    }

    public boolean isBusy() {
        if (sender.isBusy()) return true;
        for (Transfers.Incoming transfer : incoming.values()) {
            if ("sending".equals(transfer.state) || "accepted".equals(transfer.state)) return true;
        }
        return false;
    }

    // --- state snapshot ---------------------------------------------------

    public JSONObject snapshot() throws Exception {
        JSONObject state = new JSONObject();
        state.put("self", selfDeviceJson());

        JSONArray peers = new JSONArray();
        for (Discovery.Peer peer : discovery.list()) peers.put(peer.toJson());
        state.put("peers", peers);

        JSONArray transfers = new JSONArray();
        for (Transfers.Outgoing outgoing : sender.list()) {
            outgoing.maxAttempts = settings.transfer.queueAutoRetries;
            transfers.put(outgoing.toSummary(sender.positionOf(outgoing.id)));
        }
        for (Transfers.Incoming item : incoming.values()) transfers.put(item.toSummary());
        state.put("transfers", transfers);

        int queued = 0, running = 0, paused = 0, finished = 0;
        for (Transfers.Outgoing outgoing : sender.list()) {
            switch (outgoing.queueState) {
                case "queued": queued++; break;
                case "running": running++; break;
                case "paused": paused++; break;
                default: finished++;
            }
        }
        JSONObject queue = new JSONObject();
        queue.put("queued", queued);
        queue.put("running", running);
        queue.put("paused", paused);
        queue.put("finished", finished);
        queue.put("pausedGlobally", sender.isPausedGlobally());
        queue.put("concurrency", settings.transfer.maxConcurrentTransfers);
        state.put("queue", queue);

        state.put("settings", settings.toJson());

        JSONArray interfaces = new JSONArray();
        for (String[] local : Discovery.localAddresses()) {
            JSONObject entry = new JSONObject();
            entry.put("name", local[0]);
            entry.put("address", local[1]);
            entry.put("overlay", "1".equals(local[2]));
            interfaces.put(entry);
        }
        state.put("interfaces", interfaces);
        return state;
    }

    /** Pushes state to the UI, and keeps the foreground service in step. */
    private void notifyState(boolean immediate) {
        long now = System.currentTimeMillis();
        if (!immediate && now - lastNotify < 200) return;
        lastNotify = now;

        StateListener listener = stateListener;
        if (listener != null) listener.onStateChanged();

        boolean busy = isBusy();
        ServiceCallback service = serviceCallback;
        if (service != null) {
            long total = 0;
            long moved = 0;
            String label = null;
            for (Transfers.Outgoing outgoing : sender.list()) {
                if (!"running".equals(outgoing.queueState)) continue;
                total += outgoing.totalBytes;
                moved += outgoing.bytesTransferred;
                if (label == null) label = "Sending " + outgoing.label;
            }
            for (Transfers.Incoming item : incoming.values()) {
                if (!"sending".equals(item.state)) continue;
                total += item.totalBytes;
                moved += item.bytesReceived;
                if (label == null) label = "Receiving " + item.label;
            }
            int percent = total > 0 ? (int) Math.min(100, moved * 100 / total) : 0;
            if (busy || lastBusy != busy) {
                service.onBusyChanged(busy, label != null ? label : "Ready", busy ? percent : -1);
            }
            lastBusy = busy;
        }
    }

    public void notifyStateNow() {
        notifyState(true);
    }
}
