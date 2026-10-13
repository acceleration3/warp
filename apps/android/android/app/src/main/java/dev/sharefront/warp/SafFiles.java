package dev.sharefront.warp;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

/**
 * The picker's filesystem, Android style.
 *
 * Android has three quite different kinds of storage, and the UI should not
 * have to care which is which, so all three are flattened into the same FsEntry
 * shape the desktop uses:
 *
 *   - real paths the app may read directly (its own external directory);
 *   - SAF document trees the user has granted, which persist across restarts;
 *   - MediaStore collections, which is the only way to reach the camera roll
 *     and the music library without asking for broad storage access.
 *
 * `id` carries the backend: an absolute path, a content:// URI, or "media:".
 */
public class SafFiles {

    private static final String TAG = "WarpFiles";
    private static final String MEDIA_PREFIX = "media:";

    private final Context context;
    private final ContentResolver resolver;

    public SafFiles(Context context) {
        this.context = context;
        this.resolver = context.getContentResolver();
    }

    // --- entries ----------------------------------------------------------

    private static JSONObject entry(String id, String key, String name, boolean directory,
                                    long size, long mtime, String mime) throws Exception {
        JSONObject json = new JSONObject();
        json.put("id", id);
        json.put("key", key);
        json.put("name", name);
        json.put("kind", directory ? "directory" : "file");
        json.put("size", directory ? 0 : size);
        json.put("mtime", mtime);
        if (mime != null && !directory) json.put("mime", mime);
        json.put("isHidden", name.startsWith("."));
        json.put("readable", true);
        return json;
    }

    private JSONObject fromCursor(Uri parentTree, Cursor cursor) throws Exception {
        String documentId = cursor.getString(0);
        String name = cursor.getString(1);
        String mime = cursor.getString(2);
        long size = cursor.getLong(3);
        long modified = cursor.getLong(4);
        boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);

        Uri uri = DocumentsContract.buildDocumentUriUsingTree(parentTree, documentId);
        // The document id doubles as a stable, sortable ancestry key.
        return entry(uri.toString(), MEDIA_PREFIX.length() > 0 ? documentId : documentId,
                name, directory, size, modified, mime);
    }

    // --- roots ------------------------------------------------------------

    public JSONArray roots() throws Exception {
        JSONArray roots = new JSONArray();

        // 1. Where received files land: a real path, always readable.
        File received = new File(context.getExternalFilesDir(null), "Received");
        if (!received.exists()) received.mkdirs();
        roots.put(root(received.getAbsolutePath(), "Received files", "downloads",
                entry(received.getAbsolutePath(), received.getAbsolutePath(), "Received files",
                        true, 0, received.lastModified(), null)));

        /*
         * 2. MediaStore collections, but only as a fallback.
         *
         * Once internal storage is browsable these are the same files a second
         * time under different names - DCIM and "Photos" are one library. They
         * are still the only way in when the user has not granted full access,
         * so they appear exactly then.
         */
        if (!hasAllFilesAccess()) {
            roots.put(root(MEDIA_PREFIX + "images", "Photos", "pictures", "library",
                    entry(MEDIA_PREFIX + "images", "media/images", "Photos", true, 0, 0, null)));
            roots.put(root(MEDIA_PREFIX + "video", "Videos", "videos", "library",
                    entry(MEDIA_PREFIX + "video", "media/video", "Videos", true, 0, 0, null)));
            roots.put(root(MEDIA_PREFIX + "audio", "Music", "music", "library",
                    entry(MEDIA_PREFIX + "audio", "media/audio", "Music", true, 0, 0, null)));
        }

        // 3. Folders the user has granted, which survive restarts.
        for (android.content.UriPermission permission : resolver.getPersistedUriPermissions()) {
            if (!permission.isReadPermission()) continue;
            Uri uri = permission.getUri();
            try {
                String documentId = DocumentsContract.getTreeDocumentId(uri);
                Uri document = DocumentsContract.buildDocumentUriUsingTree(uri, documentId);
                String name = displayName(document);
                roots.put(root(document.toString(), name != null ? name : "Folder", "tree", "storage",
                        entry(document.toString(), documentId, name != null ? name : "Folder",
                                true, 0, 0, null)));
            } catch (Exception e) {
                Log.w(TAG, "stale tree permission ignored", e);
            }
        }

        // 4. The storage devices themselves, once full access is granted.
        //    One entry per volume; the folders inside are reached by opening it.
        if (hasAllFilesAccess()) {
            File external = Environment.getExternalStorageDirectory();
            if (external != null && external.canRead()) {
                addPath(roots, external, "Internal storage", "internal", "app");
            }
            for (File volume : removableVolumes()) {
                addPath(roots, volume, volumeLabel(volume), "sdcard", "app");
            }
        }
        return roots;
    }

    /** True when this app may read the shared storage tree directly. */
    public static boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        // Before Android 11 the legacy read permission was enough.
        return Environment.getExternalStorageDirectory() != null
                && Environment.getExternalStorageDirectory().canRead();
    }

    /** Adds a filesystem path as a sidebar shortcut, if it exists and is readable. */
    private void addPath(JSONArray roots, File dir, String name, String kind, String group) {
        try {
            if (dir == null || !dir.isDirectory() || !dir.canRead()) return;
            String path = dir.getAbsolutePath();
            roots.put(root(path, name, kind, group,
                    entry(path, path, name, true, 0, dir.lastModified(), null)));
        } catch (Exception ignored) {
            // A volume that disappeared between listing and reading.
        }
    }

    /** Mounted volumes other than the primary one: SD cards, USB sticks. */
    private List<File> removableVolumes() {
        List<File> volumes = new ArrayList<>();
        try {
            StorageManager storage = (StorageManager) context.getSystemService(Context.STORAGE_SERVICE);
            if (storage == null) return volumes;
            for (StorageVolume volume : storage.getStorageVolumes()) {
                if (volume.isPrimary()) continue;
                File directory = null;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    directory = volume.getDirectory();
                }
                if (directory != null && directory.canRead()) volumes.add(directory);
            }
        } catch (Exception ignored) {
        }
        return volumes;
    }

    private String volumeLabel(File volume) {
        try {
            StorageManager storage = (StorageManager) context.getSystemService(Context.STORAGE_SERVICE);
            if (storage != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                StorageVolume found = storage.getStorageVolume(volume);
                if (found != null) {
                    String label = found.getDescription(context);
                    if (label != null && !label.isEmpty()) return label;
                }
            }
        } catch (Exception ignored) {
        }
        return volume.getName();
    }

    private static JSONObject root(String id, String name, String kind, JSONObject entry) throws Exception {
        return root(id, name, kind, "app", entry);
    }

    private static JSONObject root(String id, String name, String kind, String group,
                                   JSONObject entry) throws Exception {
        JSONObject json = new JSONObject();
        json.put("id", id);
        json.put("name", name);
        json.put("kind", kind);
        json.put("group", group);
        json.put("entry", entry);
        return json;
    }

    // --- listing ----------------------------------------------------------

    public JSONArray list(String id, boolean includeHidden) throws Exception {
        if (id.startsWith(MEDIA_PREFIX)) return listMedia(id.substring(MEDIA_PREFIX.length()));
        if (id.startsWith("content://")) return listTree(Uri.parse(id), includeHidden);
        return listPath(new File(id), includeHidden);
    }

    private JSONArray listPath(File directory, boolean includeHidden) throws Exception {
        JSONArray entries = new JSONArray();
        File[] children = directory.listFiles();
        if (children == null) return entries;
        for (File child : children) {
            if (!includeHidden && child.getName().startsWith(".")) continue;
            entries.put(entry(child.getAbsolutePath(), child.getAbsolutePath(), child.getName(),
                    child.isDirectory(), child.length(), child.lastModified(), guessMime(child.getName())));
        }
        return entries;
    }

    private JSONArray listTree(Uri documentUri, boolean includeHidden) throws Exception {
        JSONArray entries = new JSONArray();
        String documentId = DocumentsContract.getDocumentId(documentUri);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(documentUri, documentId);

        String[] projection = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };

        try (Cursor cursor = resolver.query(children, projection, null, null, null)) {
            if (cursor == null) return entries;
            while (cursor.moveToNext()) {
                String name = cursor.getString(1);
                if (name == null) continue;
                if (!includeHidden && name.startsWith(".")) continue;
                entries.put(fromCursor(documentUri, cursor));
            }
        }
        return entries;
    }

    /** MediaStore collections appear as one flat folder each. */
    private JSONArray listMedia(String collection) throws Exception {
        JSONArray entries = new JSONArray();
        Uri table;
        switch (collection) {
            case "images":
                table = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                break;
            case "video":
                table = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                break;
            case "audio":
                table = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
                break;
            default:
                return entries;
        }

        String[] projection = {
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.MediaColumns.MIME_TYPE,
        };

        try (Cursor cursor = resolver.query(table, projection, null, null,
                MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
            if (cursor == null) return entries;
            while (cursor.moveToNext()) {
                long mediaId = cursor.getLong(0);
                String name = cursor.getString(1);
                if (name == null) name = "item-" + mediaId;
                Uri uri = Uri.withAppendedPath(table, String.valueOf(mediaId));
                entries.put(entry(uri.toString(), "media/" + collection + "/" + mediaId, name,
                        false, cursor.getLong(2), cursor.getLong(3) * 1000L, cursor.getString(4)));
            }
        }
        return entries;
    }

    public JSONObject stat(String id) throws Exception {
        if (id.startsWith(MEDIA_PREFIX)) {
            String collection = id.substring(MEDIA_PREFIX.length());
            return entry(id, "media/" + collection, capitalize(collection), true, 0, 0, null);
        }
        if (id.startsWith("content://")) {
            Uri uri = Uri.parse(id);
            String[] projection = {
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            };
            try (Cursor cursor = resolver.query(uri, projection, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    String mime = cursor.getString(1);
                    boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
                    String key = isTreeUri(uri) ? DocumentsContract.getDocumentId(uri) : uri.toString();
                    return entry(id, key, cursor.getString(0), directory,
                            cursor.getLong(2), cursor.getLong(3), mime);
                }
            }
            // Not a tree document: fall back to the openable columns.
            try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                    String name = nameIndex >= 0 ? cursor.getString(nameIndex) : uri.getLastPathSegment();
                    long size = sizeIndex >= 0 ? cursor.getLong(sizeIndex) : 0;
                    return entry(id, uri.toString(), name != null ? name : "file", false, size, 0,
                            resolver.getType(uri));
                }
            }
            return null;
        }

        File file = new File(id);
        if (!file.exists()) return null;
        return entry(file.getAbsolutePath(), file.getAbsolutePath(), file.getName(), file.isDirectory(),
                file.length(), file.lastModified(), guessMime(file.getName()));
    }

    public JSONObject parentOf(String id) throws Exception {
        if (id.startsWith(MEDIA_PREFIX) || id.startsWith("content://")) return null;
        File parent = new File(id).getParentFile();
        if (parent == null || !parent.canRead()) return null;
        return entry(parent.getAbsolutePath(), parent.getAbsolutePath(), parent.getName(),
                true, 0, parent.lastModified(), null);
    }

    /** Recursive size and count, used by the picker's "how big is this?" readout. */
    public long[] measure(String id, boolean includeHidden) {
        long files = 0;
        long bytes = 0;
        Deque<String> stack = new ArrayDeque<>();
        stack.push(id);

        while (!stack.isEmpty()) {
            String current = stack.pop();
            try {
                JSONArray entries = list(current, includeHidden);
                for (int i = 0; i < entries.length(); i++) {
                    JSONObject item = entries.getJSONObject(i);
                    if ("directory".equals(item.getString("kind"))) {
                        stack.push(item.getString("id"));
                    } else {
                        files++;
                        bytes += item.optLong("size");
                    }
                }
            } catch (Exception ignored) {
                // Unreadable folder: skip rather than abort the whole scan.
            }
        }
        return new long[]{files, bytes};
    }

    /**
     * Flattens a selection into the concrete files to send, applying the same
     * relative-path rules as the desktop so a folder arrives as a folder.
     */
    public JSONArray resolve(JSONArray included, JSONArray excluded, boolean includeHidden,
                             int maxFiles) throws Exception {
        JSONArray resolved = new JSONArray();
        List<String> exclusions = new ArrayList<>();
        for (int i = 0; i < excluded.length(); i++) {
            exclusions.add(excluded.getJSONObject(i).getString("key"));
        }

        for (int i = 0; i < included.length(); i++) {
            JSONObject node = included.getJSONObject(i);
            String id = node.getString("id");
            String name = node.getString("name");

            if (!"directory".equals(node.optString("kind"))) {
                JSONObject file = new JSONObject();
                file.put("id", id);
                file.put("path", name);
                file.put("size", node.optLong("size"));
                file.put("mtime", node.optLong("mtime"));
                file.put("source", id);
                resolved.put(file);
                continue;
            }

            String rootKey = node.getString("key");
            Deque<String[]> stack = new ArrayDeque<>();
            stack.push(new String[]{id, name});

            while (!stack.isEmpty() && resolved.length() < maxFiles) {
                String[] current = stack.pop();
                JSONArray entries = list(current[0], includeHidden);
                for (int j = 0; j < entries.length(); j++) {
                    JSONObject item = entries.getJSONObject(j);
                    String key = item.getString("key");
                    if (isExcluded(key, exclusions)) continue;

                    String relative = current[1] + "/" + item.getString("name");
                    if ("directory".equals(item.getString("kind"))) {
                        stack.push(new String[]{item.getString("id"), relative});
                        continue;
                    }
                    JSONObject file = new JSONObject();
                    file.put("id", item.getString("id"));
                    file.put("path", relative);
                    file.put("size", item.optLong("size"));
                    file.put("mtime", item.optLong("mtime"));
                    file.put("source", item.getString("id"));
                    resolved.put(file);
                    if (resolved.length() >= maxFiles) break;
                }
            }
            if (rootKey.isEmpty()) continue;
        }
        return resolved;
    }

    private static boolean isExcluded(String key, List<String> exclusions) {
        for (String excluded : exclusions) {
            if (key.equals(excluded) || key.startsWith(excluded + "/")) return true;
        }
        return false;
    }

    // --- native pickers ---------------------------------------------------

    public static Intent pickFilesIntent() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    public static Intent pickFolderIntent() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        return intent;
    }

    /** Keeps a granted tree usable after a restart. */
    public void persist(Uri uri, boolean writable) {
        try {
            int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
            if (writable) flags |= Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            resolver.takePersistableUriPermission(uri, flags);
        } catch (Exception e) {
            Log.w(TAG, "could not persist access to " + uri, e);
        }
    }

    public void release(String uri) {
        try {
            resolver.releasePersistableUriPermission(Uri.parse(uri),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = resolver.query(uri,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {
        }
        return null;
    }

    private static boolean isTreeUri(Uri uri) {
        List<String> segments = uri.getPathSegments();
        return segments.size() >= 2 && "tree".equals(segments.get(0));
    }

    private static String capitalize(String value) {
        if (value.isEmpty()) return value;
        return value.substring(0, 1).toUpperCase(Locale.US) + value.substring(1);
    }

    private static String guessMime(String name) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0) return null;
        String extension = name.substring(dot + 1).toLowerCase(Locale.US);
        return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
    }
}
