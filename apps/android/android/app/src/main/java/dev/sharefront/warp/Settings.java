package dev.sharefront.warp;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Mirrors the shared AppSettings shape, persisted as one JSON blob. */
public class Settings {

    private static final String PREFS = "warp";
    private static final String KEY_SETTINGS = "settings";
    private static final String KEY_DEVICE_ID = "deviceId";

    /** Speed and reliability dials. */
    public static class Transfer {
        public int maxConcurrentTransfers = 2;
        public int queueAutoRetries = 1;
        public boolean autoStartQueue = true;
        public int parallelFiles = 4;
        public int connectionsPerFile = 2;
        public long splitThresholdBytes = 16L * 1024 * 1024;
        public int chunkSizeBytes = 8 * 1024 * 1024;
        public int retries = 3;
        public long retryBackoffMs = 500;
        public boolean resumeEnabled = true;
        public boolean adaptiveConcurrency = true;
        public long throttleBytesPerSecond = 0;

        JSONObject toJson() throws Exception {
            JSONObject json = new JSONObject();
            json.put("maxConcurrentTransfers", maxConcurrentTransfers);
            json.put("queueAutoRetries", queueAutoRetries);
            json.put("autoStartQueue", autoStartQueue);
            json.put("parallelFiles", parallelFiles);
            json.put("connectionsPerFile", connectionsPerFile);
            json.put("splitThresholdBytes", splitThresholdBytes);
            json.put("chunkSizeBytes", chunkSizeBytes);
            json.put("retries", retries);
            json.put("retryBackoffMs", retryBackoffMs);
            json.put("resumeEnabled", resumeEnabled);
            json.put("adaptiveConcurrency", adaptiveConcurrency);
            json.put("throttleBytesPerSecond", throttleBytesPerSecond);
            return json;
        }

        void readJson(JSONObject json) {
            if (json == null) return;
            maxConcurrentTransfers = clamp(json.optInt("maxConcurrentTransfers", maxConcurrentTransfers), 1, 8);
            queueAutoRetries = clamp(json.optInt("queueAutoRetries", queueAutoRetries), 0, 5);
            autoStartQueue = json.optBoolean("autoStartQueue", autoStartQueue);
            parallelFiles = clamp(json.optInt("parallelFiles", parallelFiles), 1, 32);
            connectionsPerFile = clamp(json.optInt("connectionsPerFile", connectionsPerFile), 1, 16);
            splitThresholdBytes = json.optLong("splitThresholdBytes", splitThresholdBytes);
            chunkSizeBytes = clamp(json.optInt("chunkSizeBytes", chunkSizeBytes), 256 * 1024, 128 * 1024 * 1024);
            retries = clamp(json.optInt("retries", retries), 0, 10);
            retryBackoffMs = json.optLong("retryBackoffMs", retryBackoffMs);
            resumeEnabled = json.optBoolean("resumeEnabled", resumeEnabled);
            adaptiveConcurrency = json.optBoolean("adaptiveConcurrency", adaptiveConcurrency);
            throttleBytesPerSecond = Math.max(0, json.optLong("throttleBytesPerSecond", 0));
        }

        private static int clamp(int value, int min, int max) {
            return Math.min(max, Math.max(min, value));
        }
    }

    public String deviceName;
    /** SAF tree URI, or an absolute path for the app's own storage. */
    public String downloadDirectory = "";
    public boolean groupBySender = true;
    public boolean confirmIncoming = true;
    public boolean notifications = true;
    public String theme = "system";
    public final List<String> autoAcceptFrom = new ArrayList<>();
    public final Transfer transfer = new Transfer();

    public boolean broadcast = true;
    public boolean multicast = true;
    public int httpPort = 47655;
    public final List<String> manualPeers = new ArrayList<>();

    /** Raw picker preferences, passed through untouched from the web UI. */
    public JSONObject picker;

    private final SharedPreferences prefs;
    private String deviceId;

    public Settings(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        deviceId = prefs.getString(KEY_DEVICE_ID, null);
        if (deviceId == null) {
            deviceId = java.util.UUID.randomUUID().toString();
            prefs.edit().putString(KEY_DEVICE_ID, deviceId).apply();
        }
        deviceName = android.os.Build.MODEL != null ? android.os.Build.MODEL : "Android device";
        load();
    }

    public String getDeviceId() {
        return deviceId;
    }

    private void load() {
        String stored = prefs.getString(KEY_SETTINGS, null);
        if (stored == null) return;
        try {
            JSONObject json = new JSONObject(stored);
            deviceName = json.optString("deviceName", deviceName);
            downloadDirectory = json.optString("downloadDirectory", downloadDirectory);
            groupBySender = json.optBoolean("groupBySender", groupBySender);
            confirmIncoming = json.optBoolean("confirmIncoming", confirmIncoming);
            notifications = json.optBoolean("notifications", notifications);
            theme = json.optString("theme", theme);
            transfer.readJson(json.optJSONObject("transfer"));

            JSONObject discovery = json.optJSONObject("discovery");
            if (discovery != null) {
                broadcast = discovery.optBoolean("broadcast", broadcast);
                multicast = discovery.optBoolean("multicast", multicast);
                httpPort = discovery.optInt("httpPort", httpPort);
                manualPeers.clear();
                JSONArray hosts = discovery.optJSONArray("manualPeers");
                if (hosts != null) {
                    for (int i = 0; i < hosts.length(); i++) manualPeers.add(hosts.optString(i));
                }
            }

            autoAcceptFrom.clear();
            JSONArray accepted = json.optJSONArray("autoAcceptFrom");
            if (accepted != null) {
                for (int i = 0; i < accepted.length(); i++) autoAcceptFrom.add(accepted.optString(i));
            }

            picker = json.optJSONObject("picker");
        } catch (Exception ignored) {
            // A corrupt settings blob should never stop the app from starting.
        }
    }

    public synchronized void save() {
        try {
            prefs.edit().putString(KEY_SETTINGS, toJson().toString()).apply();
        } catch (Exception ignored) {
        }
    }

    public JSONObject toJson() throws Exception {
        JSONObject json = new JSONObject();
        json.put("deviceName", deviceName);
        json.put("downloadDirectory", downloadDirectory);
        json.put("groupBySender", groupBySender);
        json.put("confirmIncoming", confirmIncoming);
        json.put("notifications", notifications);
        json.put("theme", theme);
        json.put("transfer", transfer.toJson());

        JSONObject discovery = new JSONObject();
        discovery.put("broadcast", broadcast);
        discovery.put("multicast", multicast);
        discovery.put("httpPort", httpPort);
        discovery.put("interfaces", new JSONArray());
        JSONArray hosts = new JSONArray();
        for (String host : manualPeers) hosts.put(host);
        discovery.put("manualPeers", hosts);
        json.put("discovery", discovery);

        JSONArray accepted = new JSONArray();
        for (String id : autoAcceptFrom) accepted.put(id);
        json.put("autoAcceptFrom", accepted);

        // Always send a complete picker block: the UI reads through it, and a
        // fresh install has never stored one.
        json.put("picker", picker != null ? picker : defaultPicker());
        return json;
    }

    /** The shape the web UI expects before the user has changed anything. */
    private static JSONObject defaultPicker() throws Exception {
        JSONObject filter = new JSONObject();
        filter.put("includeGlobs", new JSONArray());
        filter.put("excludeGlobs", new JSONArray());
        filter.put("extensions", new JSONArray());
        filter.put("categories", new JSONArray());
        filter.put("includeHidden", false);
        filter.put("followSymlinks", false);
        filter.put("useDefaultIgnores", true);

        JSONObject sort = new JSONObject();
        sort.put("key", "name");
        sort.put("direction", "asc");
        sort.put("foldersFirst", true);
        sort.put("natural", true);

        JSONObject picker = new JSONObject();
        picker.put("filter", filter);
        picker.put("sort", sort);
        picker.put("view", "list");
        picker.put("thumbnailSize", 104);
        picker.put("showThumbnails", true);
        picker.put("showHiddenToggleVisible", true);
        picker.put("bookmarks", new JSONArray());
        picker.put("recentLocations", new JSONArray());
        picker.put("presets", new JSONArray());
        return picker;
    }

    /** Applies a partial update coming from the web UI. */
    public void merge(JSONObject patch) {
        if (patch == null) return;
        if (patch.has("deviceName")) deviceName = patch.optString("deviceName", deviceName);
        if (patch.has("downloadDirectory")) downloadDirectory = patch.optString("downloadDirectory", downloadDirectory);
        if (patch.has("groupBySender")) groupBySender = patch.optBoolean("groupBySender", groupBySender);
        if (patch.has("confirmIncoming")) confirmIncoming = patch.optBoolean("confirmIncoming", confirmIncoming);
        if (patch.has("notifications")) notifications = patch.optBoolean("notifications", notifications);
        if (patch.has("theme")) theme = patch.optString("theme", theme);
        if (patch.has("transfer")) transfer.readJson(patch.optJSONObject("transfer"));
        if (patch.has("picker")) picker = patch.optJSONObject("picker");

        JSONObject discovery = patch.optJSONObject("discovery");
        if (discovery != null) {
            broadcast = discovery.optBoolean("broadcast", broadcast);
            multicast = discovery.optBoolean("multicast", multicast);
            httpPort = discovery.optInt("httpPort", httpPort);
            if (discovery.has("manualPeers")) {
                manualPeers.clear();
                JSONArray hosts = discovery.optJSONArray("manualPeers");
                if (hosts != null) {
                    for (int i = 0; i < hosts.length(); i++) manualPeers.add(hosts.optString(i));
                }
            }
        }

        JSONArray accepted = patch.optJSONArray("autoAcceptFrom");
        if (accepted != null) {
            autoAcceptFrom.clear();
            for (int i = 0; i < accepted.length(); i++) autoAcceptFrom.add(accepted.optString(i));
        }
        save();
    }
}
