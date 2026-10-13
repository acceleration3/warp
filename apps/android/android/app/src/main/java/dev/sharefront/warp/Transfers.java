package dev.sharefront.warp;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Plain data holders shared by the sending and receiving halves. */
public final class Transfers {

    private Transfers() {
    }

    /**
     * Tracks which byte ranges of a file have actually landed.
     *
     * Needed because several connections write into the same file at once, so
     * "bytes written so far" is not a position, and a resume has to know
     * precisely which holes are left.
     */
    public static class RangeSet {
        private final List<long[]> ranges = new ArrayList<>();

        public synchronized void add(long start, long end) {
            if (end <= start) return;
            List<long[]> next = new ArrayList<>();
            long[] cursor = new long[]{start, end};
            boolean inserted = false;

            for (long[] range : ranges) {
                if (range[1] < cursor[0]) {
                    next.add(range);
                } else if (range[0] > cursor[1]) {
                    if (!inserted) {
                        next.add(cursor);
                        inserted = true;
                    }
                    next.add(range);
                } else {
                    cursor = new long[]{Math.min(cursor[0], range[0]), Math.max(cursor[1], range[1])};
                }
            }
            if (!inserted) next.add(cursor);
            next.sort((a, b) -> Long.compare(a[0], b[0]));
            ranges.clear();
            ranges.addAll(next);
        }

        public synchronized boolean isComplete(long total) {
            if (total == 0) return true;
            return ranges.size() == 1 && ranges.get(0)[0] <= 0 && ranges.get(0)[1] >= total;
        }

        public synchronized void clear() {
            ranges.clear();
        }

        public synchronized long size() {
            long sum = 0;
            for (long[] range : ranges) sum += range[1] - range[0];
            return sum;
        }

        public synchronized JSONArray toJson() {
            JSONArray array = new JSONArray();
            for (long[] range : ranges) {
                JSONObject entry = new JSONObject();
                try {
                    entry.put("start", range[0]);
                    entry.put("end", range[1]);
                } catch (Exception ignored) {
                }
                array.put(entry);
            }
            return array;
        }

        /** The gaps inside [0, total) that are still missing. */
        public synchronized List<long[]> missing(long total) {
            List<long[]> gaps = new ArrayList<>();
            long cursor = 0;
            for (long[] range : ranges) {
                if (range[0] > cursor) gaps.add(new long[]{cursor, Math.min(range[0], total)});
                cursor = Math.max(cursor, range[1]);
                if (cursor >= total) break;
            }
            if (cursor < total) gaps.add(new long[]{cursor, total});
            return gaps;
        }

        public static RangeSet fromJson(JSONArray array) {
            RangeSet set = new RangeSet();
            if (array == null) return set;
            for (int i = 0; i < array.length(); i++) {
                JSONObject entry = array.optJSONObject(i);
                if (entry != null) set.add(entry.optLong("start"), entry.optLong("end"));
            }
            return set;
        }
    }

    // --- receiving --------------------------------------------------------

    public static class IncomingFile {
        public String id;
        public String relativePath;
        public long size;
        public long mtime;
        public final RangeSet ranges = new RangeSet();
        public boolean done;
        public boolean removed;
        public String error;
        /** Where the bytes are being written, before the final rename. */
        public FileSink sink;
        public String finalPath;
    }

    public static class Incoming {
        public String id;
        public String fromId;
        public String fromName;
        public String fromPlatform;
        public String fromAddress = "";
        public String label;
        public String state = "pending";
        public String token;
        public String destination;
        /**
         * Folder created inside a SAF tree destination (group by sender).
         * Kept apart from the tree URI, because appending it to the URI does
         * not name a real document.
         */
        public String subfolder;
        public long totalBytes;
        public long bytesReceived;
        public int filesReceived;
        public boolean paused;
        public long startedAt;
        public long finishedAt;
        public String error;
        public final Map<String, IncomingFile> files = new ConcurrentHashMap<>();
        /** Preserves the order the sender listed them in. */
        public final List<String> order = new ArrayList<>();

        public JSONObject toSummary() throws Exception {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("direction", "incoming");

            JSONObject peer = new JSONObject();
            peer.put("id", fromId);
            peer.put("name", fromName);
            peer.put("address", fromAddress);
            peer.put("platform", fromPlatform);
            json.put("peer", peer);

            json.put("label", label);
            json.put("state", state);
            json.put("totalBytes", totalBytes);
            json.put("totalFiles", order.size());
            json.put("bytesTransferred", bytesReceived);
            json.put("filesCompleted", filesReceived);
            json.put("bytesPerSecond", 0);
            json.put("etaSeconds", JSONObject.NULL);
            json.put("activeConnections", 0);
            json.put("activeFiles", new JSONArray());
            json.put("startedAt", startedAt);
            if (finishedAt > 0) json.put("finishedAt", finishedAt);
            if (error != null) json.put("error", error);
            if (destination != null) json.put("savedTo", destination);

            JSONArray offered = new JSONArray();
            JSONArray progress = new JSONArray();
            for (String fileId : order) {
                IncomingFile file = files.get(fileId);
                if (file == null) continue;

                JSONObject entry = new JSONObject();
                entry.put("id", file.id);
                entry.put("path", file.relativePath);
                entry.put("size", file.size);
                offered.put(entry);

                JSONObject item = new JSONObject();
                item.put("fileId", file.id);
                item.put("path", file.relativePath);
                item.put("size", file.size);
                item.put("transferred", file.ranges.size());
                item.put("state", file.removed ? "removed"
                        : file.done ? "done"
                        : file.error != null ? "failed"
                        : file.ranges.size() > 0 ? "active" : "queued");
                progress.put(item);
            }
            json.put("files", offered);
            json.put("fileProgress", progress);

            // Lets the card offer Resume. Only meaningful while bytes can still arrive.
            if (paused && ("accepted".equals(state) || "sending".equals(state))) {
                JSONObject queue = new JSONObject();
                queue.put("state", "paused");
                queue.put("position", -1);
                queue.put("attempts", 0);
                json.put("queue", queue);
            }
            return json;
        }
    }

    // --- sending ----------------------------------------------------------

    public static class OutgoingFile {
        public String id;
        public String path;
        public String sourceUri;
        public long size;
        public long mtime;
        public volatile long transferred;
        public volatile boolean done;
        public volatile boolean removed;
        /** The transfer this file belongs to; its lock guards the byte counters. */
        public Outgoing owner;
    }

    public static class Outgoing {
        public String id;
        public Discovery.Peer peer;
        public String label;
        public volatile String state = "queued";
        public final List<OutgoingFile> files = new ArrayList<>();
        public final Map<String, OutgoingFile> byId = new LinkedHashMap<>();
        public volatile long totalBytes;
        public volatile long bytesTransferred;
        public volatile int filesCompleted;
        public volatile double bytesPerSecond;
        public volatile int activeConnections;
        public volatile boolean paused;
        public volatile String queueState = "queued";
        public volatile int attempts;
        /** Automatic retries allowed; filled in when the summary is built. */
        public volatile int maxAttempts;
        /** Set while an automatic retry is backing off: when it will start. */
        public volatile long retryAt;
        public volatile int chunkRetries;
        public volatile long startedAt;
        public volatile long finishedAt;
        public String error;
        public String savedTo;

        public JSONObject toSummary(int queuePosition) throws Exception {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("direction", "outgoing");

            JSONObject peerJson = new JSONObject();
            peerJson.put("id", peer.id);
            peerJson.put("name", peer.name);
            peerJson.put("address", peer.address);
            peerJson.put("platform", peer.platform);
            json.put("peer", peerJson);

            json.put("label", label);
            json.put("state", state);
            json.put("totalBytes", totalBytes);

            int active = 0;
            for (OutgoingFile file : files) if (!file.removed) active++;
            json.put("totalFiles", active);
            json.put("bytesTransferred", bytesTransferred);
            json.put("filesCompleted", filesCompleted);
            json.put("bytesPerSecond", bytesPerSecond);
            long remaining = Math.max(0, totalBytes - bytesTransferred);
            json.put("etaSeconds", bytesPerSecond > 0 ? remaining / bytesPerSecond : JSONObject.NULL);
            json.put("activeConnections", activeConnections);
            json.put("activeFiles", new JSONArray());
            json.put("startedAt", startedAt);
            if (finishedAt > 0) json.put("finishedAt", finishedAt);
            if (error != null) json.put("error", error);
            if (savedTo != null) json.put("savedTo", savedTo);

            JSONArray progress = new JSONArray();
            for (OutgoingFile file : files) {
                JSONObject item = new JSONObject();
                item.put("fileId", file.id);
                item.put("path", file.path);
                item.put("size", file.size);
                item.put("transferred", file.transferred);
                item.put("state", file.removed ? "removed"
                        : file.done ? "done"
                        : file.transferred > 0 ? "active" : "queued");
                progress.put(item);
            }
            json.put("fileProgress", progress);

            JSONObject queue = new JSONObject();
            queue.put("state", queueState);
            queue.put("position", queuePosition);
            queue.put("attempts", attempts);
            queue.put("maxAttempts", maxAttempts);
            if (retryAt > 0) queue.put("retryAt", retryAt);
            json.put("queue", queue);
            json.put("chunkRetries", chunkRetries);
            return json;
        }
    }
}
