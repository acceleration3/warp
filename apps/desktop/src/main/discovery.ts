import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

import {
  ANNOUNCE_INTERVAL_MS,
  DISCOVERY_PORT,
  MULTICAST_GROUP,
  PEER_TIMEOUT_MS,
  decodeBeacon,
  encodeBeacon,
  type Beacon,
  type DeviceInfo,
  type Peer,
} from '@share/core';

export interface InterfaceInfo {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
  /** ZeroTier/Tailscale style overlays, flagged for the UI. */
  overlay: boolean;
}

/** Derives the subnet broadcast address, e.g. 192.168.1.190/24 -> 192.168.1.255 */
function broadcastAddress(address: string, netmask: string): string {
  const addressParts = address.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);
  if (addressParts.length !== 4 || maskParts.length !== 4) return '255.255.255.255';
  return addressParts
    .map((octet, index) => (octet & maskParts[index]!) | (~maskParts[index]! & 0xff))
    .join('.');
}

const OVERLAY_PREFIXES = ['zt', 'tailscale', 'tun', 'wg', 'ham'];

export function listInterfaces(): InterfaceInfo[] {
  const result: InterfaceInfo[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      result.push({
        name,
        address: address.address,
        netmask: address.netmask,
        broadcast: broadcastAddress(address.address, address.netmask),
        overlay: OVERLAY_PREFIXES.some((prefix) => name.startsWith(prefix)),
      });
    }
  }
  return result;
}

export interface DiscoveryOptions {
  self: () => DeviceInfo;
  broadcast?: boolean;
  multicast?: boolean;
  /** Restrict announcements to these interface names. Empty = all. */
  interfaces?: string[];
}

/**
 * UDP presence. Announces this device on every IPv4 interface and keeps a table
 * of everyone else's beacons.
 *
 * Both subnet broadcast and multicast are used: some access points drop
 * broadcast frames, while some overlay networks (ZeroTier) handle broadcast
 * fine but not multicast. Sending both costs a few hundred bytes every 3s.
 */
export class DiscoveryService extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly peers = new Map<string, Peer>();
  private options: DiscoveryOptions;
  private running = false;

  constructor(options: DiscoveryOptions) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (error) => {
      this.emit('error', error);
    });

    socket.on('message', (message, remote) => {
      this.handleMessage(message, remote.address);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(DISCOVERY_PORT, () => {
        socket.off('error', reject);
        resolve();
      });
    });

    try {
      socket.setBroadcast(true);
    } catch {
      /* some platforms refuse; broadcast sends will simply fail */
    }

    if (this.options.multicast !== false) {
      for (const iface of this.targetInterfaces()) {
        try {
          socket.addMembership(MULTICAST_GROUP, iface.address);
        } catch {
          /* interface may not support multicast (common on VPN taps) */
        }
      }
    }

    // Ask everyone to identify themselves right now, then settle into a rhythm.
    this.send({ t: 'query', from: this.options.self().id });
    this.announce();
    this.timer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweep(), 2_000);
  }

  private targetInterfaces(): InterfaceInfo[] {
    const all = listInterfaces();
    const allowed = this.options.interfaces ?? [];
    if (allowed.length === 0) return all;
    return all.filter((iface) => allowed.includes(iface.name));
  }

  private handleMessage(message: Buffer, address: string): void {
    const beacon: Beacon | null = decodeBeacon(message);
    if (!beacon) return;
    const self = this.options.self();

    if (beacon.t === 'query') {
      if (beacon.from !== self.id) this.announce();
      return;
    }
    if (beacon.t === 'bye') {
      if (this.peers.delete(beacon.id)) this.emit('peers', this.list());
      return;
    }
    if (beacon.device.id === self.id) return; // our own echo

    const existing = this.peers.get(beacon.device.id);
    const peer: Peer = {
      ...beacon.device,
      address,
      lastSeen: Date.now(),
      manual: existing?.manual ?? false,
      via: this.interfaceFor(address),
    };
    const changed =
      !existing ||
      existing.address !== peer.address ||
      existing.name !== peer.name ||
      existing.port !== peer.port;
    this.peers.set(peer.id, peer);
    if (changed) this.emit('peers', this.list());
  }

  /** Best-effort guess of which local interface a peer address belongs to. */
  private interfaceFor(address: string): string | undefined {
    for (const iface of listInterfaces()) {
      const maskParts = iface.netmask.split('.').map(Number);
      const a = address.split('.').map(Number);
      const b = iface.address.split('.').map(Number);
      if (a.length !== 4 || b.length !== 4) continue;
      const sameSubnet = a.every((octet, i) => (octet & maskParts[i]!) === (b[i]! & maskParts[i]!));
      if (sameSubnet) return iface.name;
    }
    return undefined;
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (peer.manual) continue;
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('peers', this.list());
  }

  private send(beacon: Beacon): void {
    const socket = this.socket;
    if (!socket) return;
    const payload = Buffer.from(encodeBeacon(beacon));
    const targets = new Set<string>();

    if (this.options.broadcast !== false) {
      targets.add('255.255.255.255');
      for (const iface of this.targetInterfaces()) targets.add(iface.broadcast);
    }
    if (this.options.multicast !== false) targets.add(MULTICAST_GROUP);

    for (const target of targets) {
      socket.send(payload, DISCOVERY_PORT, target, () => {
        /* unreachable subnets are normal; ignore per-target failures */
      });
    }
  }

  announce(): void {
    this.send({ t: 'announce', device: this.options.self() });
  }

  /** Directed announce, used for manually added hosts and VPN peers. */
  probe(address: string): void {
    const socket = this.socket;
    if (!socket) return;
    const payload = Buffer.from(encodeBeacon({ t: 'announce', device: this.options.self() }));
    socket.send(payload, DISCOVERY_PORT, address, () => {});
    const query = Buffer.from(encodeBeacon({ t: 'query', from: this.options.self().id }));
    socket.send(query, DISCOVERY_PORT, address, () => {});
  }

  /**
   * Inserts a peer the user typed in by hand; survives beacon timeouts.
   *
   * Any previous manual entry for the same address is dropped first: if the
   * app at that address was restarted it has a new identity, and without this
   * the old one would linger forever (manual peers never time out).
   */
  addManualPeer(peer: Peer): void {
    for (const [id, existing] of this.peers) {
      if (existing.manual && existing.address === peer.address && id !== peer.id) {
        this.peers.delete(id);
      }
    }
    this.peers.set(peer.id, { ...peer, manual: true });
    this.emit('peers', this.list());
  }

  /** Drops manual entries for an address that no longer answers. */
  forgetManualAddress(address: string): void {
    let changed = false;
    for (const [id, existing] of this.peers) {
      if (existing.manual && existing.address === address) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('peers', this.list());
  }

  removePeer(id: string): void {
    if (this.peers.delete(id)) this.emit('peers', this.list());
  }

  list(): Peer[] {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  updateOptions(options: Partial<DiscoveryOptions>): void {
    this.options = { ...this.options, ...options };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.send({ t: 'bye', id: this.options.self().id });
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.timer = null;
    this.sweepTimer = null;
    await new Promise<void>((resolve) => {
      if (!this.socket) return resolve();
      this.socket.close(() => resolve());
    });
    this.socket = null;
    this.peers.clear();
  }
}
