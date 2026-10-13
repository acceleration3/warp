package dev.sharefront.warp;

import android.util.Log;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.StandardProtocolFamily;
import java.net.StandardSocketOptions;
import java.nio.channels.DatagramChannel;
import java.nio.channels.MembershipKey;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * UDP presence, mirroring the desktop implementation byte for byte.
 *
 * Both subnet broadcast and multicast are used: consumer access points often
 * drop one or the other, and VPN/mesh interfaces (ZeroTier, Tailscale) usually
 * carry broadcast but not multicast.
 *
 * Receiving multicast on Android additionally requires the MulticastLock held
 * by TransferService - without it the kernel silently discards the packets.
 */
public class Discovery {

    private static final String TAG = "WarpDiscovery";
    static final int PORT = 47654;
    static final String MULTICAST_GROUP = "239.47.65.4";
    private static final long ANNOUNCE_INTERVAL_MS = 3_000;
    private static final long PEER_TIMEOUT_MS = 12_000;

    public interface Listener {
        void onPeersChanged();
    }

    /** A peer as last advertised. */
    public static class Peer {
        public String id;
        public String name;
        public String platform;
        public String deviceType;
        public int port;
        public String address;
        public long lastSeen;
        public boolean manual;
        public String via;

        JSONObject toJson() throws Exception {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("name", name);
            json.put("platform", platform);
            json.put("deviceType", deviceType);
            json.put("port", port);
            json.put("protocol", 1);
            json.put("address", address);
            json.put("lastSeen", lastSeen);
            json.put("manual", manual);
            if (via != null) json.put("via", via);
            return json;
        }
    }

    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private final TransferEngine engine;
    private Listener listener;

    private DatagramChannel channel;
    private DatagramSocket socket;
    private final List<MembershipKey> memberships = new ArrayList<>();
    private Thread receiveThread;
    private Thread announceThread;
    private volatile boolean running = false;
    private volatile boolean broadcastEnabled = true;
    private volatile boolean multicastEnabled = true;
    /** Logs the first round of sends so a silent network is diagnosable. */
    private volatile boolean logTargets = true;

    public Discovery(TransferEngine engine) {
        this.engine = engine;
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void setEnabled(boolean broadcast, boolean multicast) {
        this.broadcastEnabled = broadcast;
        this.multicastEnabled = multicast;
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        try {
            /*
             * The protocol family has to be pinned to IPv4.
             *
             * MulticastSocket, and any socket bound to the unspecified address,
             * comes up dual-stack on "::" - even when handed an IPv4 bind
             * address. Such a socket still *receives* IPv4 through v4-mapped
             * addresses, so discovery looks half-working, but an IPv4 broadcast
             * sent from it never reaches the wire: send() reports success and
             * the packet is silently dropped. The symptom is one-way discovery,
             * where this device sees every peer and no peer ever sees it.
             *
             * DatagramChannel is the only API that lets the family be stated
             * outright, so the socket is created here and adapted afterwards.
             */
            channel = DatagramChannel.open(StandardProtocolFamily.INET);
            channel.setOption(StandardSocketOptions.SO_REUSEADDR, true);
            channel.setOption(StandardSocketOptions.SO_BROADCAST, true);
            channel.setOption(StandardSocketOptions.IP_MULTICAST_TTL, 2);
            // The bare wildcard resolves to "::", which an IPv4 channel rejects.
            channel.bind(new InetSocketAddress(InetAddress.getByName("0.0.0.0"), PORT));

            socket = channel.socket();
            socket.setBroadcast(true);
            joinMulticastGroups();
            Log.i(TAG, "discovery socket bound on " + socket.getLocalSocketAddress());
        } catch (Exception e) {
            Log.e(TAG, "could not open the discovery socket", e);
            running = false;
            return;
        }

        receiveThread = new Thread(this::receiveLoop, "warp-discovery-rx");
        receiveThread.setDaemon(true);
        receiveThread.start();

        announceThread = new Thread(this::announceLoop, "warp-discovery-tx");
        announceThread.setDaemon(true);
        announceThread.start();
    }

    private void joinMulticastGroups() {
        if (!multicastEnabled || channel == null) return;
        try {
            InetAddress group = InetAddress.getByName(MULTICAST_GROUP);
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                if (!iface.isUp() || iface.isLoopback() || !iface.supportsMulticast()) continue;
                try {
                    memberships.add(channel.join(group, iface));
                } catch (Exception ignored) {
                    // Many interfaces (VPN taps especially) refuse multicast.
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "multicast join failed", e);
        }
    }

    /**
     * Reads straight from the channel rather than through socket.receive().
     *
     * DatagramChannel's DatagramSocket adapter serializes send against receive
     * on one lock, so a thread parked in receive() blocks every announcement
     * for seconds at a time. The channel itself allows both concurrently.
     */
    private void receiveLoop() {
        ByteBuffer buffer = ByteBuffer.allocateDirect(16 * 1024);
        while (running) {
            try {
                buffer.clear();
                java.net.SocketAddress from = channel.receive(buffer);
                if (from == null) continue;
                buffer.flip();
                byte[] bytes = new byte[buffer.remaining()];
                buffer.get(bytes);
                String text = new String(bytes, StandardCharsets.UTF_8);
                String address = ((InetSocketAddress) from).getAddress().getHostAddress();
                handleBeacon(text, address);
            } catch (Exception e) {
                if (running) Log.w(TAG, "discovery receive failed", e);
            }
        }
    }

    private void handleBeacon(String text, String fromAddress) {
        try {
            JSONObject beacon = new JSONObject(text);
            String type = beacon.optString("t");

            if ("query".equals(type)) {
                if (!engine.getSelfId().equals(beacon.optString("from"))) announce();
                return;
            }
            if ("bye".equals(type)) {
                if (peers.remove(beacon.optString("id")) != null) notifyChanged();
                return;
            }
            if (!"announce".equals(type)) return;

            JSONObject device = beacon.optJSONObject("device");
            if (device == null) return;
            String id = device.optString("id");
            if (id.isEmpty() || id.equals(engine.getSelfId())) return;

            Peer existing = peers.get(id);
            Peer peer = existing != null ? existing : new Peer();
            boolean changed = existing == null
                    || !fromAddress.equals(peer.address)
                    || !device.optString("name").equals(peer.name)
                    || device.optInt("port") != peer.port;

            peer.id = id;
            peer.name = device.optString("name", "Unknown device");
            peer.platform = device.optString("platform", "unknown");
            peer.deviceType = device.optString("deviceType", "desktop");
            peer.port = device.optInt("port", 47655);
            peer.address = fromAddress;
            peer.lastSeen = System.currentTimeMillis();
            peer.via = interfaceFor(fromAddress);
            peers.put(id, peer);

            if (changed) notifyChanged();
        } catch (Exception e) {
            Log.w(TAG, "malformed beacon ignored", e);
        }
    }

    private void announceLoop() {
        // Ask everyone to identify themselves immediately, then settle down.
        sendQuery();
        while (running) {
            announce();
            expire();
            try {
                Thread.sleep(ANNOUNCE_INTERVAL_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    private void expire() {
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (Map.Entry<String, Peer> entry : peers.entrySet()) {
            Peer peer = entry.getValue();
            if (peer.manual) continue;
            if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
                peers.remove(entry.getKey());
                changed = true;
            }
        }
        if (changed) notifyChanged();
    }

    public void announce() {
        try {
            JSONObject beacon = new JSONObject();
            beacon.put("t", "announce");
            beacon.put("device", engine.selfDeviceJson());
            send(beacon.toString());
        } catch (Exception e) {
            Log.w(TAG, "announce failed", e);
        }
    }

    private void sendQuery() {
        try {
            JSONObject beacon = new JSONObject();
            beacon.put("t", "query");
            beacon.put("from", engine.getSelfId());
            send(beacon.toString());
        } catch (Exception ignored) {
        }
    }

    public void sayGoodbye() {
        try {
            JSONObject beacon = new JSONObject();
            beacon.put("t", "bye");
            beacon.put("id", engine.getSelfId());
            send(beacon.toString());
        } catch (Exception ignored) {
        }
    }

    private void send(String payload) {
        if (channel == null) return;
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        List<String> targets = new ArrayList<>();
        if (broadcastEnabled) {
            targets.add("255.255.255.255");
            targets.addAll(broadcastAddresses());
        }
        if (multicastEnabled) targets.add(MULTICAST_GROUP);

        for (String target : targets) {
            try {
                InetAddress address = InetAddress.getByName(target);
                channel.send(ByteBuffer.wrap(bytes), new InetSocketAddress(address, PORT));
                if (logTargets) Log.i(TAG, "sent beacon to " + target);
            } catch (Exception e) {
                // Unreachable subnets are normal; keep going.
                if (logTargets) Log.w(TAG, "could not send to " + target + ": " + e);
            }
        }
        logTargets = false;
    }

    /** Directed probe, for peers reached over a VPN that filters broadcast. */
    public void probe(String host) {
        if (channel == null) return;
        try {
            InetSocketAddress target = new InetSocketAddress(InetAddress.getByName(host), PORT);

            JSONObject beacon = new JSONObject();
            beacon.put("t", "announce");
            beacon.put("device", engine.selfDeviceJson());
            channel.send(ByteBuffer.wrap(beacon.toString().getBytes(StandardCharsets.UTF_8)), target);

            JSONObject query = new JSONObject();
            query.put("t", "query");
            query.put("from", engine.getSelfId());
            channel.send(ByteBuffer.wrap(query.toString().getBytes(StandardCharsets.UTF_8)), target);
        } catch (Exception e) {
            Log.w(TAG, "probe failed for " + host, e);
        }
    }

    /**
     * Inserts a peer the user typed in by hand.
     *
     * Any previous manual entry for the same address is dropped first: if the
     * app at that address was restarted it has a new identity, and manual peers
     * never expire, so the stale one would otherwise linger forever.
     */
    public void addManualPeer(Peer peer) {
        peer.manual = true;
        peer.lastSeen = System.currentTimeMillis();
        for (Map.Entry<String, Peer> entry : peers.entrySet()) {
            Peer existing = entry.getValue();
            if (existing.manual && existing.address.equals(peer.address) && !entry.getKey().equals(peer.id)) {
                peers.remove(entry.getKey());
            }
        }
        peers.put(peer.id, peer);
        notifyChanged();
    }

    /** Drops manual entries for an address that no longer answers. */
    public void forgetManualAddress(String address) {
        boolean changed = false;
        for (Map.Entry<String, Peer> entry : peers.entrySet()) {
            Peer existing = entry.getValue();
            if (existing.manual && existing.address.equals(address)) {
                peers.remove(entry.getKey());
                changed = true;
            }
        }
        if (changed) notifyChanged();
    }

    public void removePeer(String id) {
        if (peers.remove(id) != null) notifyChanged();
    }

    public List<Peer> list() {
        List<Peer> list = new ArrayList<>(peers.values());
        Collections.sort(list, (a, b) -> a.name.compareToIgnoreCase(b.name));
        return list;
    }

    public Peer get(String id) {
        return peers.get(id);
    }

    private void notifyChanged() {
        Listener current = listener;
        if (current != null) current.onPeersChanged();
    }

    /** Every usable IPv4 broadcast address on this device. */
    static List<String> broadcastAddresses() {
        List<String> result = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                if (!iface.isUp() || iface.isLoopback()) continue;
                for (InterfaceAddress address : iface.getInterfaceAddresses()) {
                    InetAddress broadcast = address.getBroadcast();
                    if (broadcast != null) result.add(broadcast.getHostAddress());
                }
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    /** Local IPv4 addresses, for the "this device" panel. */
    static List<String[]> localAddresses() {
        List<String[]> result = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                if (!iface.isUp() || iface.isLoopback()) continue;
                for (InterfaceAddress address : iface.getInterfaceAddresses()) {
                    InetAddress local = address.getAddress();
                    if (local.getAddress().length != 4) continue;
                    String name = iface.getName();
                    boolean overlay = name.startsWith("tun") || name.startsWith("zt")
                            || name.startsWith("wg") || name.startsWith("ppp");
                    result.add(new String[]{name, local.getHostAddress(), overlay ? "1" : "0"});
                }
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    private String interfaceFor(String address) {
        for (String[] local : localAddresses()) {
            String candidate = local[1];
            int lastDot = candidate.lastIndexOf('.');
            if (lastDot > 0 && address.startsWith(candidate.substring(0, lastDot + 1))) {
                return local[0];
            }
        }
        return null;
    }

    public synchronized void stop() {
        if (!running) return;
        running = false;
        sayGoodbye();
        if (announceThread != null) announceThread.interrupt();
        for (MembershipKey key : memberships) {
            try {
                key.drop();
            } catch (Exception ignored) {
            }
        }
        memberships.clear();
        if (socket != null) socket.close();
        try {
            if (channel != null) channel.close();
        } catch (Exception ignored) {
        }
        channel = null;
        peers.clear();
    }
}
