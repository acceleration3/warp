package dev.sharefront.warp;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.core.content.ContextCompat;

import android.Manifest;
import android.content.pm.PackageManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The Android half of ShareBridge.
 *
 * Everything the web UI can do goes through here; the UI never touches an
 * Android API directly, exactly as it never touches Node on the desktop.
 */
@CapacitorPlugin(
        name = "Warp",
        permissions = {
                // Android 13+ splits storage into per-type media permissions.
                @Permission(
                        alias = WarpPlugin.MEDIA,
                        strings = {
                                Manifest.permission.READ_MEDIA_IMAGES,
                                Manifest.permission.READ_MEDIA_VIDEO,
                                Manifest.permission.READ_MEDIA_AUDIO,
                        }),
                @Permission(
                        alias = WarpPlugin.MEDIA_LEGACY,
                        strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
                @Permission(
                        alias = WarpPlugin.NOTIFICATIONS,
                        strings = { Manifest.permission.POST_NOTIFICATIONS }),
        })
public class WarpPlugin extends Plugin {

    static final String MEDIA = "media";
    static final String MEDIA_LEGACY = "mediaLegacy";
    static final String NOTIFICATIONS = "notifications";

    private TransferEngine engine;
    private SafFiles files;

    @Override
    public void load() {
        Context context = getContext().getApplicationContext();
        engine = TransferEngine.getInstance(context);
        files = new SafFiles(context);

        engine.setStateListener(new TransferEngine.StateListener() {
            @Override
            public void onStateChanged() {
                try {
                    notifyListeners("state", JSObject.fromJSONObject(engine.snapshot()));
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onTextReceived(String text, String fromName) {
                JSObject payload = new JSObject();
                payload.put("text", text);
                JSObject from = new JSObject();
                from.put("name", fromName);
                payload.put("from", from);
                notifyListeners("text", payload);
            }
        });

        TransferService.start(context);
        engine.start();
        reconnectManualPeers();

        // The foreground service notification is the user's only sign that a
        // transfer is still running, and on Android 13+ it needs consent.
        // Asked through the Activity directly: Capacitor's alias flow wants a
        // PluginCall to resolve, and there is none during load().
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && !granted(Manifest.permission.POST_NOTIFICATIONS)
                && getActivity() != null) {
            try {
                androidx.core.app.ActivityCompat.requestPermissions(
                        getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 9001);
            } catch (Exception ignored) {
                // A denied notification never stops a transfer.
            }
        }
    }

    // --- media access -------------------------------------------------------

    /** The permission set that actually governs MediaStore on this release. */
    private String mediaAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? MEDIA : MEDIA_LEGACY;
    }

    private boolean hasMediaAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return granted(Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        // Android 14 can grant access to a chosen subset of photos and videos.
        // MediaStore then returns only those, which is still worth listing.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                && granted("android.permission.READ_MEDIA_VISUAL_USER_SELECTED")) {
            return true;
        }
        return granted(Manifest.permission.READ_MEDIA_IMAGES)
                || granted(Manifest.permission.READ_MEDIA_VIDEO)
                || granted(Manifest.permission.READ_MEDIA_AUDIO);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Without these, every MediaStore query returns an empty cursor and the
     * Photos, Videos and Music shortcuts simply look empty.
     */
    @PluginMethod
    public void checkMediaAccess(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasMediaAccess());
        call.resolve(result);
    }

    @PluginMethod
    public void requestMediaAccess(PluginCall call) {
        if (hasMediaAccess()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(mediaAlias(), call, "mediaAccessResult");
    }

    @PermissionCallback
    private void mediaAccessResult(PluginCall call) {
        if (call == null) return;
        JSObject result = new JSObject();
        result.put("granted", hasMediaAccess());
        call.resolve(result);
    }

    // --- state ------------------------------------------------------------

    @PluginMethod
    public void getState(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(engine.snapshot()));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // --- discovery --------------------------------------------------------

    @PluginMethod
    public void refreshPeers(PluginCall call) {
        engine.getDiscovery().announce();
        reconnectManualPeers();
        call.resolve();
    }

    /**
     * Re-attaches manually added peers over HTTP.
     *
     * A UDP probe is no good here: the reason a peer was added by hand is that
     * broadcast does not reach it. Entries are stored as "host" or "host:port".
     */
    private void reconnectManualPeers() {
        List<String> entries = new ArrayList<>(engine.getSettings().manualPeers);
        if (entries.isEmpty()) return;

        new Thread(() -> {
            for (String entry : entries) {
                String host = entry;
                int port = engine.getSettings().httpPort;
                int colon = entry.lastIndexOf(':');
                if (colon > 0) {
                    host = entry.substring(0, colon);
                    try {
                        port = Integer.parseInt(entry.substring(colon + 1));
                    } catch (NumberFormatException ignored) {
                    }
                }
                engine.getDiscovery().probe(host);
                try {
                    JSONObject device = new JSONObject(engine.getSender().fetchInfo(host, port))
                            .getJSONObject("device");
                    Discovery.Peer peer = new Discovery.Peer();
                    peer.id = device.getString("id");
                    peer.name = device.optString("name", host);
                    peer.platform = device.optString("platform", "unknown");
                    peer.deviceType = device.optString("deviceType", "desktop");
                    peer.port = device.optInt("port", port);
                    peer.address = host;
                    engine.getDiscovery().addManualPeer(peer);
                } catch (Exception ignored) {
                    // Not reachable: drop the stale entry rather than keep it.
                    engine.getDiscovery().forgetManualAddress(host);
                }
            }
        }, "warp-reconnect").start();
    }

    @PluginMethod
    public void addManualPeer(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port");
        if (host == null || host.isEmpty()) {
            call.reject("no address given");
            return;
        }
        int target = port != null ? port : engine.getSettings().httpPort;

        new Thread(() -> {
            try {
                // /api/info is GET-only; probing it with POST returns 404.
                String response = engine.getSender().fetchInfo(host, target);
                JSONObject device = new JSONObject(response).getJSONObject("device");

                Discovery.Peer peer = new Discovery.Peer();
                peer.id = device.getString("id");
                peer.name = device.optString("name", host);
                peer.platform = device.optString("platform", "unknown");
                peer.deviceType = device.optString("deviceType", "desktop");
                peer.port = device.optInt("port", target);
                peer.address = host;
                engine.getDiscovery().addManualPeer(peer);

                // Remember the port too, or the next reconnect guesses the default.
                String remembered = host + ":" + target;
                List<String> known = engine.getSettings().manualPeers;
                if (!known.contains(remembered)) {
                    final String bare = host;
                    known.removeIf(item -> item.equals(bare) || item.startsWith(bare + ":"));
                    known.add(remembered);
                    engine.getSettings().save();
                }
                call.resolve(JSObject.fromJSONObject(peer.toJson()));
            } catch (Exception e) {
                call.resolve(null);
            }
        }, "warp-probe").start();
    }

    @PluginMethod
    public void removePeer(PluginCall call) {
        String peerId = call.getString("peerId", "");
        Discovery.Peer peer = engine.getDiscovery().get(peerId);
        engine.getDiscovery().removePeer(peerId);
        if (peer != null && peer.manual) {
            final String address = peer.address;
            engine.getSettings().manualPeers.removeIf(
                    entry -> entry.equals(address) || entry.startsWith(address + ":"));
            engine.getSettings().save();
        }
        call.resolve();
    }

    // --- filesystem -------------------------------------------------------

    @PluginMethod
    public void roots(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("roots", files.roots());
            call.resolve(result);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        String id = call.getString("directoryId");
        boolean includeHidden = Boolean.TRUE.equals(call.getBoolean("includeHidden", false));
        new Thread(() -> {
            try {
                JSObject result = new JSObject();
                result.put("entries", files.list(id, includeHidden));
                call.resolve(result);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }, "warp-list").start();
    }

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            JSONObject entry = files.stat(call.getString("id", ""));
            JSObject result = new JSObject();
            if (entry != null) result.put("entry", entry);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void parentOf(PluginCall call) {
        try {
            JSONObject entry = files.parentOf(call.getString("id", ""));
            JSObject result = new JSObject();
            if (entry != null) result.put("entry", entry);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void measure(PluginCall call) {
        String id = call.getString("directoryId", "");
        new Thread(() -> {
            long[] measured = files.measure(id, false);
            JSObject result = new JSObject();
            result.put("files", measured[0]);
            result.put("bytes", measured[1]);
            call.resolve(result);
        }, "warp-measure").start();
    }

    // --- transfers --------------------------------------------------------

    @PluginMethod
    public void send(PluginCall call) {
        String peerId = call.getString("peerId", "");
        String label = call.getString("label", "Files");
        JSObject payload = call.getObject("payload");
        if (payload == null) {
            call.reject("nothing to send");
            return;
        }

        Discovery.Peer peer = engine.getDiscovery().get(peerId);
        if (peer == null) {
            call.reject("that device is no longer on the network");
            return;
        }

        new Thread(() -> {
            try {
                JSONArray included = payload.optJSONArray("included");
                JSONArray excluded = payload.optJSONArray("excluded");
                JSONObject filter = payload.optJSONObject("filter");
                boolean includeHidden = filter != null && filter.optBoolean("includeHidden", false);

                JSONArray resolved = files.resolve(
                        included != null ? included : new JSONArray(),
                        excluded != null ? excluded : new JSONArray(),
                        includeHidden,
                        200_000);

                if (resolved.length() == 0) {
                    call.reject("nothing to send after filtering");
                    return;
                }

                List<Transfers.OutgoingFile> outgoing = new ArrayList<>();
                for (int i = 0; i < resolved.length(); i++) {
                    JSONObject item = resolved.getJSONObject(i);
                    Transfers.OutgoingFile file = new Transfers.OutgoingFile();
                    file.path = item.getString("path");
                    file.sourceUri = item.getString("source");
                    file.size = item.optLong("size");
                    file.mtime = item.optLong("mtime");
                    outgoing.add(file);
                }

                Transfers.Outgoing transfer = engine.getSender().enqueue(
                        peer, outgoing, label, engine.getSettings().transfer);

                JSObject result = new JSObject();
                result.put("transferId", transfer.id);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }, "warp-send").start();
    }

    @PluginMethod
    public void sendText(PluginCall call) {
        String peerId = call.getString("peerId", "");
        String text = call.getString("text", "");
        Discovery.Peer peer = engine.getDiscovery().get(peerId);
        if (peer == null) {
            call.reject("that device is no longer on the network");
            return;
        }
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("text", text);
                body.put("from", engine.selfDeviceJson());
                engine.getSender().post(peer, "/api/text", body.toString(), null);
                call.resolve();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }, "warp-text").start();
    }

    @PluginMethod
    public void acceptTransfer(PluginCall call) {
        engine.acceptIncoming(call.getString("transferId", ""), call.getString("destination"));
        call.resolve();
    }

    @PluginMethod
    public void declineTransfer(PluginCall call) {
        engine.declineIncoming(call.getString("transferId", ""));
        call.resolve();
    }

    // --- queue ------------------------------------------------------------

    @PluginMethod
    public void pauseTransfer(PluginCall call) {
        String id = call.getString("transferId", "");
        if (engine.getSender().get(id) != null) engine.getSender().pause(id);
        else engine.pauseIncoming(id);
        call.resolve();
    }

    @PluginMethod
    public void resumeTransfer(PluginCall call) {
        String id = call.getString("transferId", "");
        if (engine.getSender().get(id) != null) engine.getSender().resume(id);
        else engine.resumeIncoming(id);
        call.resolve();
    }

    @PluginMethod
    public void cancelTransfer(PluginCall call) {
        String id = call.getString("transferId", "");
        if (engine.getSender().get(id) != null) engine.getSender().cancel(id);
        else engine.cancelIncoming(id, "cancelled here");
        call.resolve();
    }

    @PluginMethod
    public void retryTransfer(PluginCall call) {
        engine.getSender().retry(call.getString("transferId", ""));
        call.resolve();
    }

    @PluginMethod
    public void removeTransfer(PluginCall call) {
        String id = call.getString("transferId", "");
        if (engine.getSender().get(id) != null) engine.getSender().remove(id);
        else engine.forgetIncoming(id);
        call.resolve();
    }

    @PluginMethod
    public void removeQueuedFile(PluginCall call) {
        boolean removed = engine.getSender()
                .removeFile(call.getString("transferId", ""), call.getString("fileId", ""));
        JSObject result = new JSObject();
        result.put("removed", removed);
        call.resolve(result);
    }

    @PluginMethod
    public void moveTransfer(PluginCall call) {
        engine.getSender().move(call.getString("transferId", ""), call.getString("direction", "up"));
        call.resolve();
    }

    @PluginMethod
    public void pauseAll(PluginCall call) {
        engine.pauseAll();
        call.resolve();
    }

    @PluginMethod
    public void resumeAll(PluginCall call) {
        engine.resumeAll();
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        engine.getSender().cancelAll();
        call.resolve();
    }

    @PluginMethod
    public void clearFinished(PluginCall call) {
        engine.getSender().clearFinished();
        for (Transfers.Incoming transfer : engine.listIncoming()) {
            if ("complete".equals(transfer.state) || "failed".equals(transfer.state)
                    || "declined".equals(transfer.state) || "cancelled".equals(transfer.state)) {
                engine.forgetIncoming(transfer.id);
            }
        }
        engine.notifyStateNow();
        call.resolve();
    }

    // --- settings ---------------------------------------------------------

    @PluginMethod
    public void updateSettings(PluginCall call) {
        try {
            JSObject patch = call.getObject("patch");
            engine.getSettings().merge(patch);
            engine.getSender().setMaxConcurrent(engine.getSettings().transfer.maxConcurrentTransfers);
            engine.getDiscovery().setEnabled(engine.getSettings().broadcast, engine.getSettings().multicast);
            engine.getDiscovery().announce();
            engine.notifyStateNow();
            call.resolve(JSObject.fromJSONObject(engine.getSettings().toJson()));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /**
     * Asks the system to exempt this app from battery optimisation.
     *
     * The foreground service already covers the documented cases, but several
     * OEM skins (Xiaomi, Oppo, Huawei, Samsung) still freeze background sockets
     * unless the app is on the exemption list, so it is worth offering.
     */
    @SuppressLint("BatteryLife")
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        String packageName = context.getPackageName();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && power.isIgnoringBatteryOptimizations(packageName)) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + packageName));
        startActivityForResult(call, intent, "batteryExemptionResult");
    }

    @ActivityCallback
    private void batteryExemptionResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        JSObject payload = new JSObject();
        payload.put("granted", Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || power.isIgnoringBatteryOptimizations(context.getPackageName()));
        call.resolve(payload);
    }

    @PluginMethod
    public void isBatteryExempt(PluginCall call) {
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        JSObject result = new JSObject();
        result.put("exempt", Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || power.isIgnoringBatteryOptimizations(context.getPackageName()));
        call.resolve(result);
    }

    // --- full storage access ------------------------------------------------

    /**
     * From Android 11 an app cannot read the shared storage tree without
     * "All files access", which is granted in system settings rather than by a
     * dialog. Without it the only ways in are MediaStore and per-folder SAF
     * grants, neither of which can show DCIM, Download and friends as places.
     */
    @PluginMethod
    public void checkAllFilesAccess(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", SafFiles.hasAllFilesAccess());
        call.resolve(result);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (SafFiles.hasAllFilesAccess()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            JSObject result = new JSObject();
            result.put("granted", false);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        startActivityForResult(call, intent, "allFilesAccessResult");
    }

    @ActivityCallback
    private void allFilesAccessResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        JSObject payload = new JSObject();
        payload.put("granted", SafFiles.hasAllFilesAccess());
        call.resolve(payload);
    }

    // --- native pickers ---------------------------------------------------

    @PluginMethod
    public void pickFiles(PluginCall call) {
        startActivityForResult(call, SafFiles.pickFilesIntent(), "pickFilesResult");
    }

    @ActivityCallback
    private void pickFilesResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        JSONArray entries = new JSONArray();
        Intent data = result.getData();

        try {
            if (data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        addPickedFile(entries, clip.getItemAt(i).getUri());
                    }
                } else if (data.getData() != null) {
                    addPickedFile(entries, data.getData());
                }
            }
        } catch (Exception ignored) {
        }

        JSObject payload = new JSObject();
        payload.put("entries", entries);
        call.resolve(payload);
    }

    private void addPickedFile(JSONArray entries, Uri uri) throws Exception {
        // Keep read access alive for the length of the transfer.
        try {
            getContext().getContentResolver()
                    .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
        }
        JSONObject entry = files.stat(uri.toString());
        if (entry != null) entries.put(entry);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        startActivityForResult(call, SafFiles.pickFolderIntent(), "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject payload = new JSObject();

        if (data != null && data.getData() != null) {
            Uri tree = data.getData();
            files.persist(tree, true);
            try {
                String documentId = android.provider.DocumentsContract.getTreeDocumentId(tree);
                Uri document = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
                JSONObject entry = files.stat(document.toString());
                if (entry != null) {
                    JSONObject root = new JSONObject();
                    root.put("id", document.toString());
                    root.put("name", entry.optString("name", "Folder"));
                    root.put("kind", "tree");
                    root.put("entry", entry);
                    payload.put("root", root);
                }
            } catch (Exception ignored) {
            }
        }
        call.resolve(payload);
    }

    /** Lets the user choose where received files are written. */
    @PluginMethod
    public void chooseDownloadDirectory(PluginCall call) {
        startActivityForResult(call, SafFiles.pickFolderIntent(), "downloadDirectoryResult");
    }

    @ActivityCallback
    private void downloadDirectoryResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject payload = new JSObject();

        if (data != null && data.getData() != null) {
            Uri tree = data.getData();
            files.persist(tree, true);
            try {
                String documentId = android.provider.DocumentsContract.getTreeDocumentId(tree);
                Uri document = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
                engine.getSettings().downloadDirectory = document.toString();
                engine.getSettings().save();
                engine.notifyStateNow();
                payload.put("directory", document.toString());
            } catch (Exception ignored) {
            }
        }
        call.resolve(payload);
    }

    /**
     * Produces a small preview for a file, as a data URI.
     *
     * Images are served straight to the WebView by Capacitor instead, so this
     * is really about video: an <img> cannot render a video file, but the
     * platform can decode a frame from it.
     */
    @PluginMethod
    public void thumbnail(PluginCall call) {
        String id = call.getString("id", "");
        // The caller passes device pixels, already scaled by the screen's
        // density. Asking for CSS pixels here is what makes a thumbnail look
        // soft: it gets decoded at a third of the size it is drawn at.
        int size = Math.max(64, Math.min(1024, call.getInt("size", 256)));

        new Thread(() -> {
            android.graphics.Bitmap bitmap = null;
            try {
                if (id.startsWith("content://")) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        bitmap = getContext().getContentResolver()
                                .loadThumbnail(Uri.parse(id), new android.util.Size(size, size), null);
                    }
                } else {
                    java.io.File file = new java.io.File(id);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        bitmap = android.media.ThumbnailUtils.createVideoThumbnail(
                                file, new android.util.Size(size, size), null);
                    }
                }
            } catch (Exception ignored) {
                // Not previewable; the UI falls back to the type icon.
            }

            JSObject result = new JSObject();
            if (bitmap != null) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                // 92 rather than 80: these are small images, and compression
                // artefacts are obvious on a dense screen.
                bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, out);
                result.put("dataUrl", "data:image/jpeg;base64,"
                        + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP));
                result.put("width", bitmap.getWidth());
                result.put("height", bitmap.getHeight());
                bitmap.recycle();
            }
            call.resolve(result);
        }, "warp-thumb").start();
    }

    @PluginMethod
    public void openPath(PluginCall call) {
        String id = call.getString("id", "");
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            Uri uri = id.startsWith("content://")
                    ? Uri.parse(id)
                    : androidx.core.content.FileProvider.getUriForFile(getContext(),
                            getContext().getPackageName() + ".fileprovider", new java.io.File(id));
            intent.setDataAndType(uri, getContext().getContentResolver().getType(uri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception e) {
            call.reject("nothing can open that file");
            return;
        }
        call.resolve();
    }
}
