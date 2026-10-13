/**
 * The engine without a window.
 *
 * Useful for a always-on box (a NAS, a home server) that should be reachable
 * from your phone without anyone logging in, and for checking discovery and
 * transfers without a display attached.
 *
 *   node dist/main/headless.cjs --name "Server" --dir ~/Incoming --accept
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  PROTOCOL_VERSION,
  defaultTransferSettings,
  formatBytes,
  type DeviceInfo,
} from '@share/core';

import { DiscoveryService, listInterfaces } from './discovery.js';
import { TransferServer, type IncomingTransfer } from './server.js';

interface Options {
  name: string;
  directory: string;
  autoAccept: boolean;
  port: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    name: os.hostname() || 'Headless',
    directory: path.join(os.homedir(), 'Downloads', 'Shared'),
    autoAccept: false,
    port: 47655,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--name' && next) options.name = next;
    else if (arg === '--dir' && next) options.directory = next;
    else if (arg === '--port' && next) options.port = Number(next);
    else if (arg === '--accept') options.autoAccept = true;
    else if (arg === '--help') {
      console.log(
        'usage: headless [--name NAME] [--dir PATH] [--port N] [--accept]\n' +
          '  --accept  take every offer without asking (only on a network you trust)',
      );
      process.exit(0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fsp.mkdir(options.directory, { recursive: true });

  // The identity is persisted so peers recognise this device across restarts.
  // It is keyed by name, so two instances on one host are two distinct devices
  // rather than one device that ignores its own twin's beacons.
  const slug = options.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
  const identityFile = path.join(os.homedir(), '.config', 'warp', `headless-${slug}-id`);
  let id: string;
  try {
    id = (await fsp.readFile(identityFile, 'utf8')).trim();
  } catch {
    id = crypto.randomUUID();
    await fsp.mkdir(path.dirname(identityFile), { recursive: true });
    await fsp.writeFile(identityFile, id);
  }

  const self = (): DeviceInfo => ({
    id,
    name: options.name,
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    deviceType: 'server',
    port: server.port || options.port,
    protocol: PROTOCOL_VERSION,
  });

  const server = new TransferServer({
    self,
    downloadDirectory: () => options.directory,
    groupBySender: () => true,
    autoAccept: () => options.autoAccept,
    port: options.port,
  });

  server.on('offer', (transfer: IncomingTransfer) => {
    console.log(
      `offer from ${transfer.from.name}: ${transfer.offer.files.length} file(s), ` +
        `${formatBytes(transfer.offer.totalBytes)}`,
    );
    if (!options.autoAccept) {
      console.log(`  accepting (pass --accept to silence this); id ${transfer.id}`);
      void server.accept(transfer.id);
    }
  });
  server.on('update', (transfer: IncomingTransfer) => {
    if (transfer.state === 'complete') console.log(`complete: saved to ${transfer.destination}`);
    if (transfer.state === 'failed') console.log(`failed: ${transfer.error}`);
  });
  server.on('text', (payload: { text: string; from?: DeviceInfo }) => {
    console.log(`text from ${payload.from?.name ?? 'a device'}: ${payload.text}`);
  });

  const port = await server.start();
  console.log(`"${options.name}" listening on ${port}, saving to ${options.directory}`);
  for (const iface of listInterfaces()) {
    console.log(`  ${iface.name.padEnd(12)} ${iface.address}${iface.overlay ? '  (overlay network)' : ''}`);
  }

  const discovery = new DiscoveryService({ self });
  discovery.on('peers', () => {
    const peers = discovery.list();
    console.log(`peers: ${peers.length === 0 ? 'none' : peers.map((p) => `${p.name} (${p.address})`).join(', ')}`);
  });
  discovery.on('error', (error: Error) => console.error('discovery:', error.message));
  await discovery.start();

  console.log(`announcing every ${defaultTransferSettings().retryBackoffMs > 0 ? 3 : 3}s - Ctrl+C to stop`);

  const shutdown = async (): Promise<void> => {
    console.log('\nshutting down');
    await discovery.stop();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
