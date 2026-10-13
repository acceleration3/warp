import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FsEntry, FsRoot, ListOptions, RootKind, WalkOptions } from '@share/core';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', ico: 'image/x-icon',
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/opus',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', html: 'text/html', csv: 'text/csv',
};

export function mimeFor(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()];
}

/** Absolute paths are already canonical keys; just normalize separators. */
function toKey(absolutePath: string): string {
  return absolutePath.split(path.sep).join('/');
}

function entryFrom(absolutePath: string, stats: fs.Stats, isSymlink: boolean, name?: string): FsEntry {
  const base = name ?? (path.basename(absolutePath) || absolutePath);
  const isDirectory = stats.isDirectory();
  return {
    id: absolutePath,
    key: toKey(absolutePath),
    name: base,
    kind: isDirectory ? 'directory' : 'file',
    size: isDirectory ? 0 : stats.size,
    mtime: stats.mtimeMs,
    mime: isDirectory ? undefined : mimeFor(base),
    isHidden: base.startsWith('.'),
    isSymlink,
    readable: true,
  };
}

async function statEntry(absolutePath: string, name: string): Promise<FsEntry | null> {
  try {
    const link = await fsp.lstat(absolutePath);
    if (link.isSymbolicLink()) {
      // Resolve so the UI shows the real size/kind, but keep the symlink flag.
      try {
        const target = await fsp.stat(absolutePath);
        return entryFrom(absolutePath, target, true, name);
      } catch {
        return entryFrom(absolutePath, link, true, name);
      }
    }
    return entryFrom(absolutePath, link, false, name);
  } catch {
    return null;
  }
}

/** Reads the XDG user-dirs config so Downloads/Pictures are right on localized systems. */
async function xdgUserDirs(): Promise<Partial<Record<RootKind, string>>> {
  const home = os.homedir();
  const result: Partial<Record<RootKind, string>> = {};
  const mapping: Record<string, RootKind> = {
    XDG_DESKTOP_DIR: 'desktop',
    XDG_DOWNLOAD_DIR: 'downloads',
    XDG_DOCUMENTS_DIR: 'documents',
    XDG_PICTURES_DIR: 'pictures',
    XDG_VIDEOS_DIR: 'videos',
    XDG_MUSIC_DIR: 'music',
  };
  try {
    const raw = await fsp.readFile(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^([A-Z_]+)="(.*)"$/.exec(line.trim());
      if (!match) continue;
      const kind = mapping[match[1]!];
      if (!kind) continue;
      result[kind] = match[2]!.replace('$HOME', home);
    }
  } catch {
    /* fall through to defaults */
  }
  for (const [key, kind] of Object.entries(mapping)) {
    void key;
    if (!result[kind]) {
      const guess = path.join(home, kind.charAt(0).toUpperCase() + kind.slice(1));
      result[kind] = guess;
    }
  }
  return result;
}

/** Removable media and extra volumes, so USB sticks show up in the sidebar. */
async function mountedVolumes(): Promise<FsRoot[]> {
  if (process.platform === 'win32') {
    const roots: FsRoot[] = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      try {
        const stats = await fsp.stat(drive);
        roots.push({
          id: drive,
          name: drive,
          kind: 'volume',
          entry: entryFrom(drive, stats, false, drive),
        });
      } catch {
        /* no such drive */
      }
    }
    return roots;
  }

  const candidates = [
    path.join('/run/media', os.userInfo().username),
    path.join('/media', os.userInfo().username),
    '/media',
    '/mnt',
    '/Volumes',
  ];
  const roots: FsRoot[] = [];
  const seen = new Set<string>();
  for (const base of candidates) {
    let names: string[];
    try {
      names = await fsp.readdir(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(base, name);
      if (seen.has(full)) continue;
      const entry = await statEntry(full, name);
      if (!entry || entry.kind !== 'directory') continue;
      seen.add(full);
      roots.push({ id: full, name, kind: 'usb', entry, removable: true });
    }
  }
  return roots;
}

/** Node-backed implementation of the picker's filesystem contract. */
export class NodeFsProvider {
  readonly platform = 'desktop' as const;

  async roots(extra: string[] = []): Promise<FsRoot[]> {
    const home = os.homedir();
    const dirs = await xdgUserDirs();
    const roots: FsRoot[] = [];

    const add = async (target: string, name: string, kind: RootKind): Promise<void> => {
      const entry = await statEntry(target, name);
      if (entry && entry.kind === 'directory') roots.push({ id: target, name, kind, entry });
    };

    await add(home, 'Home', 'home');
    if (dirs.desktop) await add(dirs.desktop, 'Desktop', 'desktop');
    if (dirs.downloads) await add(dirs.downloads, 'Downloads', 'downloads');
    if (dirs.documents) await add(dirs.documents, 'Documents', 'documents');
    if (dirs.pictures) await add(dirs.pictures, 'Pictures', 'pictures');
    if (dirs.videos) await add(dirs.videos, 'Videos', 'videos');
    if (dirs.music) await add(dirs.music, 'Music', 'music');

    roots.push(...(await mountedVolumes()));

    if (process.platform !== 'win32') {
      await add('/', 'Computer', 'volume');
    }

    for (const bookmark of extra) {
      if (roots.some((root) => root.id === bookmark)) continue;
      await add(bookmark, path.basename(bookmark) || bookmark, 'custom');
    }
    return roots;
  }

  async list(dirId: string, options: ListOptions = {}): Promise<FsEntry[]> {
    const dirents = await fsp.readdir(dirId, { withFileTypes: true });
    const results: FsEntry[] = [];

    // Bounded parallelism: stat-ing 10k files serially is visibly slow.
    const queue = dirents.filter((d) => options.includeHidden || !d.name.startsWith('.'));
    const concurrency = 64;
    let index = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const current = index++;
        if (current >= queue.length) return;
        if (options.signal?.aborted) return;
        const dirent = queue[current]!;
        const full = path.join(dirId, dirent.name);
        // Fast path: dirent already knows the kind for non-symlinks.
        if (dirent.isDirectory()) {
          const entry = await statEntry(full, dirent.name);
          if (entry) results.push(entry);
          continue;
        }
        const entry = await statEntry(full, dirent.name);
        if (entry) results.push(entry);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return results;
  }

  async stat(id: string): Promise<FsEntry | null> {
    return statEntry(id, path.basename(id) || id);
  }

  async parentOf(id: string): Promise<FsEntry | null> {
    const parent = path.dirname(id);
    if (parent === id) return null;
    return this.stat(parent);
  }

  /** Depth-first walk, yielding batches so the caller can stream progress. */
  async *walk(dirId: string, options: WalkOptions = {}): AsyncIterable<FsEntry[]> {
    const batchSize = 256;
    let batch: FsEntry[] = [];
    const stack: Array<{ dir: string; depth: number }> = [{ dir: dirId, depth: 0 }];
    const visited = new Set<string>();

    while (stack.length > 0) {
      if (options.signal?.aborted) break;
      const { dir, depth } = stack.pop()!;

      // Symlink loops are real; track resolved paths.
      let realPath = dir;
      try {
        realPath = await fsp.realpath(dir);
      } catch {
        /* keep the literal path */
      }
      if (visited.has(realPath)) continue;
      visited.add(realPath);

      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: skip rather than abort the whole scan
      }

      for (const dirent of dirents) {
        if (options.signal?.aborted) break;
        if (!options.includeHidden && dirent.name.startsWith('.')) continue;
        const full = path.join(dir, dirent.name);
        const entry = await statEntry(full, dirent.name);
        if (!entry) continue;
        if (entry.isSymlink && !options.followSymlinks) continue;

        if (entry.kind === 'directory') {
          const deeper = depth + 1;
          if (options.maxDepth !== undefined && deeper > options.maxDepth) continue;
          if (options.shouldEnter && !options.shouldEnter(entry, deeper)) continue;
          options.onDirectory?.(entry, deeper);
          stack.push({ dir: full, depth: deeper });
          continue;
        }

        batch.push(entry);
        if (batch.length >= batchSize) {
          yield batch;
          batch = [];
        }
      }
    }
    if (batch.length > 0) yield batch;
  }

  /** Directory size + file count, streamed so the UI can show it ticking up. */
  async measure(
    dirId: string,
    onProgress?: (files: number, bytes: number) => void,
    signal?: AbortSignal,
  ): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for await (const batch of this.walk(dirId, { signal, includeHidden: true })) {
      for (const entry of batch) {
        files++;
        bytes += entry.size;
      }
      onProgress?.(files, bytes);
    }
    return { files, bytes };
  }
}
