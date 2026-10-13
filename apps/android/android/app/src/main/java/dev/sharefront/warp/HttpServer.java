package dev.sharefront.warp;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The receiving half: a small HTTP/1.1 server, deliberately hand-rolled.
 *
 * It only has to speak the handful of routes in the shared protocol, and doing
 * it directly avoids a dependency while keeping full control over how upload
 * bodies are streamed to disk - which matters because several connections write
 * into the same file at once.
 */
public class HttpServer {

    private static final String TAG = "WarpHttp";
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final long MAX_JSON_BYTES = 64L * 1024 * 1024;

    public interface Callback {
        /** @return true to accept without asking the user. */
        boolean shouldAutoAccept(Transfers.Incoming transfer);

        void onOffer(Transfers.Incoming transfer);

        void onProgress(Transfers.Incoming transfer);

        void onUpdate(Transfers.Incoming transfer);

        void onText(String text, String fromName);
    }

    private final TransferEngine engine;
    private final Callback callback;
    private ServerSocket serverSocket;
    private ExecutorService workers;
    private Thread acceptThread;
    private volatile boolean running = false;
    private int port = 0;

    public HttpServer(TransferEngine engine, Callback callback) {
        this.engine = engine;
        this.callback = callback;
    }

    public int getPort() {
        return port;
    }

    public synchronized int start(int preferredPort) throws IOException {
        if (running) return port;
        IOException last = null;
        for (int candidate = preferredPort; candidate < preferredPort + 12; candidate++) {
            try {
                serverSocket = new ServerSocket(candidate);
                port = candidate;
                last = null;
                break;
            } catch (IOException e) {
                last = e;
            }
        }
        if (last != null) throw last;

        running = true;
        // One thread per connection: parallel chunk uploads each need their own.
        workers = Executors.newCachedThreadPool();
        acceptThread = new Thread(this::acceptLoop, "warp-http-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return port;
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = serverSocket.accept();
                socket.setTcpNoDelay(true);
                socket.setSoTimeout(120_000);
                workers.execute(() -> handleConnection(socket));
            } catch (IOException e) {
                if (running) Log.w(TAG, "accept failed", e);
            }
        }
    }

    private void handleConnection(Socket socket) {
        try (InputStream in = socket.getInputStream();
             OutputStream rawOut = socket.getOutputStream()) {
            BufferedOutputStream out = new BufferedOutputStream(rawOut, 16 * 1024);
            // Keep-alive: a transfer reuses the same socket for many chunks.
            while (running && !socket.isClosed()) {
                if (!handleRequest(in, out)) break;
            }
        } catch (Exception e) {
            // Peers disconnect abruptly all the time; not worth shouting about.
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    /** @return true when the connection may be reused. */
    private boolean handleRequest(InputStream in, OutputStream out) throws IOException {
        String requestLine = readLine(in);
        if (requestLine == null || requestLine.isEmpty()) return false;

        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return false;
        String method = parts[0];
        String target = parts[1];

        Map<String, String> headers = new HashMap<>();
        int headerBytes = 0;
        for (; ; ) {
            String line = readLine(in);
            if (line == null) return false;
            if (line.isEmpty()) break;
            headerBytes += line.length();
            if (headerBytes > MAX_HEADER_BYTES) return false;
            int colon = line.indexOf(':');
            if (colon > 0) {
                headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US),
                        line.substring(colon + 1).trim());
            }
        }

        String path = target;
        String query = "";
        int questionMark = target.indexOf('?');
        if (questionMark >= 0) {
            path = target.substring(0, questionMark);
            query = target.substring(questionMark + 1);
        }

        try {
            route(method, path, query, headers, in, out);
        } catch (CloseConnection e) {
            return false;
        } catch (Exception e) {
            Log.w(TAG, "request failed: " + path, e);
            // How much of the body the handler consumed is unknown, so draining
            // Content-Length bytes could swallow the next request or block on
            // bytes that never come. Answer and end the connection instead.
            sendResponse(out, 500, "application/json; charset=utf-8",
                    "{\"error\":\"internal error\"}".getBytes(StandardCharsets.UTF_8), "", false);
            return false;
        }
        return true;
    }

    private void route(String method, String path, String query, Map<String, String> headers,
                       InputStream in, OutputStream out) throws Exception {
        String[] segments = path.split("/");
        // segments[0] is empty because the path starts with "/"
        if (segments.length < 2 || !"api".equals(segments[1])) {
            drain(in, contentLength(headers));
            sendJson(out, 404, "{\"error\":\"not found\"}");
            return;
        }

        String section = segments.length > 2 ? segments[2] : "";

        if ("info".equals(section) && "GET".equals(method)) {
            JSONObject body = new JSONObject();
            body.put("device", engine.selfDeviceJson());
            sendJson(out, 200, body.toString());
            return;
        }

        if ("offer".equals(section) && "POST".equals(method)) {
            String json = readBody(in, contentLength(headers));
            handleOffer(new JSONObject(json), out);
            return;
        }

        if ("text".equals(section) && "POST".equals(method)) {
            String json = readBody(in, contentLength(headers));
            JSONObject body = new JSONObject(json);
            JSONObject from = body.optJSONObject("from");
            callback.onText(body.optString("text"), from != null ? from.optString("name") : "a device");
            sendJson(out, 200, "{\"ok\":true}");
            return;
        }

        if ("transfer".equals(section) && segments.length > 3) {
            String transferId = urlDecode(segments[3]);
            Transfers.Incoming transfer = engine.getIncoming(transferId);
            if (transfer == null) {
                drain(in, contentLength(headers));
                sendJson(out, 404, "{\"error\":\"unknown transfer\"}");
                return;
            }
            String action = segments.length > 4 ? segments[4] : "";

            if ("status".equals(action) && "GET".equals(method)) {
                sendJson(out, 200, statusJson(transfer, query.contains("ranges")).toString());
                return;
            }
            if ("file".equals(action) && segments.length > 5 && "PUT".equals(method)) {
                handleUpload(transfer, urlDecode(segments[5]), headers, in, out);
                return;
            }
            if ("finish".equals(action) && "POST".equals(method)) {
                String json = readBody(in, contentLength(headers));
                handleFinish(transfer, headers, json, out);
                return;
            }
            if ("cancel".equals(action) && "POST".equals(method)) {
                drain(in, contentLength(headers));
                engine.cancelIncoming(transferId, "cancelled by sender");
                sendJson(out, 200, "{\"ok\":true}");
                return;
            }
        }

        drain(in, contentLength(headers));
        sendJson(out, 404, "{\"error\":\"not found\"}");
    }

    private void handleOffer(JSONObject offer, OutputStream out) throws Exception {
        String transferId = offer.optString("transferId");
        JSONObject from = offer.optJSONObject("from");
        JSONArray files = offer.optJSONArray("files");
        if (transferId.isEmpty() || from == null || files == null) {
            sendJson(out, 400, "{\"error\":\"malformed offer\"}");
            return;
        }

        if (engine.wasRemoved(transferId)) {
            // The user removed this transfer while it was live; do not prompt again.
            sendJson(out, 200, "{\"transferId\":" + JSONObject.quote(transferId)
                    + ",\"state\":\"cancelled\",\"bytesReceived\":0,\"filesReceived\":0"
                    + ",\"error\":\"removed on the other device\"}");
            return;
        }
        Transfers.Incoming existing = engine.getIncoming(transferId);
        if (existing != null) {
            if (("failed".equals(existing.state) || "cancelled".equals(existing.state))
                    && engine.reopenIncoming(existing)) {
                callback.onOffer(existing);
                if (callback.shouldAutoAccept(existing)) engine.acceptIncoming(existing.id, null);
            }
            sendJson(out, 200, statusJson(existing, false).toString());
            return;
        }

        Transfers.Incoming transfer = new Transfers.Incoming();
        transfer.id = transferId;
        transfer.fromId = from.optString("id");
        transfer.fromName = from.optString("name", "Unknown device");
        transfer.fromPlatform = from.optString("platform", "unknown");
        transfer.label = offer.optString("label", "Files");
        transfer.totalBytes = offer.optLong("totalBytes");
        transfer.state = "pending";
        transfer.startedAt = System.currentTimeMillis();

        for (int i = 0; i < files.length(); i++) {
            JSONObject entry = files.getJSONObject(i);
            String safe = Paths.sanitizeRelative(entry.optString("path"));
            if (safe == null) {
                sendJson(out, 400, "{\"error\":\"unsafe path: " + entry.optString("path") + "\"}");
                return;
            }
            Transfers.IncomingFile file = new Transfers.IncomingFile();
            file.id = entry.optString("id");
            file.relativePath = safe;
            file.size = entry.optLong("size");
            file.mtime = entry.optLong("mtime");
            if (file.size < 0) {
                sendJson(out, 400, "{\"error\":\"bad size\"}");
                return;
            }
            transfer.files.put(file.id, file);
            transfer.order.add(file.id);
        }

        engine.putIncoming(transfer);
        callback.onOffer(transfer);

        if (callback.shouldAutoAccept(transfer)) {
            engine.acceptIncoming(transfer.id, null);
        }
        sendJson(out, 200, statusJson(transfer, false).toString());
    }

    private void handleUpload(Transfers.Incoming transfer, String fileId, Map<String, String> headers,
                              InputStream in, OutputStream out) throws Exception {
        long length = contentLength(headers);

        if (!"accepted".equals(transfer.state) && !"sending".equals(transfer.state)) {
            drain(in, length);
            sendJson(out, 409, "{\"error\":\"transfer is " + transfer.state + "\"}");
            return;
        }
        String token = headers.get("x-share-token");
        if (transfer.token == null || !transfer.token.equals(token)) {
            drain(in, length);
            sendJson(out, 403, "{\"error\":\"bad token\"}");
            return;
        }
        if (transfer.paused) {
            // Tell the sender to hold rather than burn its retry budget.
            drain(in, length);
            sendResponse(out, 503, "application/json",
                    "{\"error\":\"paused by receiver\",\"paused\":true}".getBytes(StandardCharsets.UTF_8),
                    "Retry-After: 2\r\n");
            return;
        }

        Transfers.IncomingFile file = transfer.files.get(fileId);
        if (file == null) {
            drain(in, length);
            sendJson(out, 404, "{\"error\":\"unknown file\"}");
            return;
        }
        if (file.done || file.removed) {
            // A duplicate of a chunk that already landed (the sender timed out
            // waiting for our reply). Writing it would reopen a finished file.
            drain(in, length);
            sendJson(out, 200, "{\"ok\":true,\"received\":0,\"complete\":" + file.done + "}");
            return;
        }

        long start = 0;
        String offset = headers.get("x-share-offset");
        if (offset != null) {
            try {
                start = Long.parseLong(offset);
            } catch (NumberFormatException ignored) {
            }
        }
        if (start < 0 || start > file.size) {
            drain(in, length);
            sendJson(out, 400, "{\"error\":\"bad offset\"}");
            return;
        }

        if ("accepted".equals(transfer.state)) {
            transfer.state = "sending";
            callback.onUpdate(transfer);
        }

        FileSink sink = engine.sinkFor(transfer, file);
        long position = start;
        byte[] buffer = new byte[256 * 1024];
        long remaining = length;

        try {
            while (remaining > 0) {
                int wanted = (int) Math.min(buffer.length, remaining);
                int read = in.read(buffer, 0, wanted);
                if (read < 0) throw new IOException("connection closed mid-upload");
                if (position + read > file.size) throw new IOException("chunk exceeds declared file size");
                sink.write(buffer, 0, read, position);
                position += read;
                remaining -= read;
                transfer.bytesReceived += read;
                callback.onProgress(transfer);
            }
        } catch (Exception e) {
            file.error = e.getMessage();
            // The rest of the body is still on the socket; the connection cannot be reused.
            sendJsonAndClose(out, 400,
                    "{\"error\":\"" + JsonText.escape(String.valueOf(e.getMessage())) + "\"}");
            return;
        }

        synchronized (transfer) {
            file.ranges.add(start, position);
            if (!file.done && file.ranges.isComplete(file.size)) {
                file.done = true;
                transfer.filesReceived++;
                engine.finalizeFile(transfer, file);
                callback.onUpdate(transfer);
            }
        }

        JSONObject body = new JSONObject();
        body.put("ok", true);
        body.put("received", position - start);
        body.put("complete", file.done);
        sendJson(out, 200, body.toString());
    }

    private void handleFinish(Transfers.Incoming transfer, Map<String, String> headers, String json,
                              OutputStream out) throws Exception {
        String token = headers.get("x-share-token");
        if (transfer.token == null || !transfer.token.equals(token)) {
            sendJson(out, 403, "{\"error\":\"bad token\"}");
            return;
        }
        // Only a live transfer can be finished. Above all, a cancelled one must
        // stay cancelled: turning it into "failed" would let a retry resume it
        // against partial files that were already deleted.
        if (!"accepted".equals(transfer.state) && !"sending".equals(transfer.state)) {
            sendJson(out, 409, statusJson(transfer, false).toString());
            return;
        }

        // The sender may have dropped files from its queue after offering them.
        try {
            JSONArray removed = new JSONObject(json).optJSONArray("removed");
            if (removed != null) {
                for (int i = 0; i < removed.length(); i++) {
                    Transfers.IncomingFile file = transfer.files.get(removed.getString(i));
                    if (file != null && !file.done) {
                        file.removed = true;
                        engine.discardFile(transfer, file);
                    }
                }
            }
        } catch (Exception ignored) {
            // finish may legitimately carry no body
        }

        List<String> incomplete = new ArrayList<>();
        for (String id : transfer.order) {
            Transfers.IncomingFile file = transfer.files.get(id);
            if (file == null || file.done || file.removed) continue;
            if (file.ranges.isComplete(file.size)) {
                file.done = true;
                transfer.filesReceived++;
                engine.finalizeFile(transfer, file);
            } else {
                incomplete.add(file.relativePath);
            }
        }

        if (incomplete.isEmpty()) {
            transfer.state = "complete";
        } else {
            transfer.state = "failed";
            transfer.error = incomplete.size() + " file(s) incomplete";
        }
        transfer.finishedAt = System.currentTimeMillis();
        engine.closeSinks(transfer, false);
        callback.onUpdate(transfer);
        sendJson(out, 200, statusJson(transfer, false).toString());
    }

    private JSONObject statusJson(Transfers.Incoming transfer, boolean includeRanges) throws Exception {
        JSONObject status = new JSONObject();
        status.put("transferId", transfer.id);
        status.put("state", transfer.state);
        status.put("bytesReceived", transfer.bytesReceived);
        status.put("filesReceived", transfer.filesReceived);
        if (transfer.token != null && ("accepted".equals(transfer.state) || "sending".equals(transfer.state))) {
            status.put("token", transfer.token);
        }
        if (transfer.destination != null) status.put("savedTo", transfer.destination);
        if (transfer.error != null) status.put("error", transfer.error);
        if (transfer.paused) status.put("paused", true);
        if (includeRanges) {
            JSONObject ranges = new JSONObject();
            for (Map.Entry<String, Transfers.IncomingFile> entry : transfer.files.entrySet()) {
                ranges.put(entry.getKey(), entry.getValue().ranges.toJson());
            }
            status.put("ranges", ranges);
        }
        return status;
    }

    // --- plumbing ---------------------------------------------------------

    private static long contentLength(Map<String, String> headers) {
        String value = headers.get("content-length");
        if (value == null) return 0;
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder builder = new StringBuilder();
        int character;
        while ((character = in.read()) != -1) {
            if (character == '\n') return builder.toString();
            if (character != '\r') builder.append((char) character);
            if (builder.length() > MAX_HEADER_BYTES) throw new IOException("header line too long");
        }
        return builder.length() == 0 ? null : builder.toString();
    }

    private static String readBody(InputStream in, long length) throws IOException {
        if (length <= 0) return "{}";
        if (length > MAX_JSON_BYTES) throw new IOException("body too large");
        byte[] buffer = new byte[(int) length];
        int read = 0;
        while (read < buffer.length) {
            int count = in.read(buffer, read, buffer.length - read);
            if (count < 0) break;
            read += count;
        }
        return new String(buffer, 0, read, StandardCharsets.UTF_8);
    }

    /** Consumes an unwanted body so the connection stays usable. */
    private static void drain(InputStream in, long length) throws IOException {
        long remaining = length;
        byte[] buffer = new byte[16 * 1024];
        while (remaining > 0) {
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read < 0) return;
            remaining -= read;
        }
    }

    private static void sendJson(OutputStream out, int status, String body) throws IOException {
        sendResponse(out, status, "application/json; charset=utf-8", body.getBytes(StandardCharsets.UTF_8), "");
    }

    /**
     * Answers and ends the connection. Used when the request body was not read
     * to its end: whatever is left of it would otherwise be parsed as the next
     * request on this keep-alive socket.
     */
    private static void sendJsonAndClose(OutputStream out, int status, String body) throws IOException {
        sendResponse(out, status, "application/json; charset=utf-8", body.getBytes(StandardCharsets.UTF_8),
                "", false);
        throw new CloseConnection();
    }

    /** Thrown after a response that ends the connection; handleRequest stops the keep-alive loop. */
    private static final class CloseConnection extends RuntimeException {
        CloseConnection() {
            super(null, null, false, false);
        }
    }

    private static void sendResponse(OutputStream out, int status, String contentType, byte[] body,
                                     String extraHeaders) throws IOException {
        sendResponse(out, status, contentType, body, extraHeaders, true);
    }

    private static void sendResponse(OutputStream out, int status, String contentType, byte[] body,
                                     String extraHeaders, boolean keepAlive) throws IOException {
        String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + (keepAlive ? "Connection: keep-alive\r\n" : "Connection: close\r\n")
                + extraHeaders
                + "\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 409: return "Conflict";
            case 503: return "Service Unavailable";
            default: return "Error";
        }
    }

    private static String urlDecode(String value) {
        try {
            return java.net.URLDecoder.decode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    public synchronized void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        if (workers != null) workers.shutdownNow();
    }
}
