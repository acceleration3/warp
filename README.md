# Warp

Find your other devices on the network and send them files or whole folders.
Desktop (Linux, Windows, macOS) and Android, one TypeScript UI, no accounts, no
cloud, nothing leaves your network.

---

## How it works

There is no server to run and no service to sign up for. Every device
announces itself over UDP and runs a small HTTP server of its own; transfers go
straight from one device to the other.

```
   Desktop (Electron)                         Android (Capacitor)
   ┌─────────────────────┐                    ┌─────────────────────┐
   │  React UI (shared)  │                    │  React UI (shared)  │
   ├─────────────────────┤                    ├─────────────────────┤
   │  preload  → IPC     │                    │  Warp plugin → JNI  │
   ├─────────────────────┤                    ├─────────────────────┤
   │  Node engine        │                    │  Java engine        │
   │   dgram · http · fs │                    │   Datagram · Socket │
   └──────────┬──────────┘                    └──────────┬──────────┘
              │                                          │
              │   UDP :47654  announce / query / bye     │
              ├──────────────────────────────────────────┤
              │   TCP :47655  HTTP/1.1 offer → chunks    │
              └──────────────────────────────────────────┘
```

Discovery uses **both** subnet broadcast and multicast, because consumer access
points tend to drop one or the other, and overlay networks (ZeroTier,
Tailscale, WireGuard) usually carry broadcast but not multicast.

**This also works off-site.** A mesh VPN presents a virtual LAN, so a device
joined to your ZeroTier or Tailscale network is discovered exactly like one on
your Wi-Fi — no port forwarding, no tunnel, no public server. Where broadcast is
filtered entirely, *Devices → By address* pins a peer by IP and remembers it;
remembered peers are re-attached over HTTP on every start, since the reason
they were added by hand is that broadcast does not reach them.

One caveat worth knowing: two instances on the *same* machine will not discover
each other. Linux hands each datagram to only one socket in a `SO_REUSEPORT`
group, so an instance receives its own beacon rather than its twin's. Across
machines — the actual use case — this does not apply; connect by address if you
really do need two on one host.

### If no devices appear

Discovery is **inbound UDP 47654** and transfers are **inbound TCP 47655**. A
default-deny host firewall blocks both, and the failure is invisible from the
inside: the machine still announces itself and can still reach everyone else,
so it looks like an empty network while no peer can see or reach it. The app
names the firewall on the Devices page when it finds no peers.

```bash
sudo ufw allow 47654/udp && sudo ufw allow 47655/tcp          # ufw
sudo firewall-cmd --permanent --add-port=47654/udp \
  --add-port=47655/tcp && sudo firewall-cmd --reload           # firewalld
```

On Android, the Photos, Videos and Music shortcuts read through MediaStore,
which needs the media permission; until it is granted they are simply empty, so
the picker offers the prompt in place of the empty listing.

The wire protocol is plain HTTP/1.1 on purpose: it keeps the Java and Node
implementations small, and you can poke at it with `curl`.

---

## Getting started

```bash
pnpm install
pnpm build          # core → UI → Electron main/preload
pnpm --filter @share/desktop start
```

Run it on a second machine (or build the APK below) and the two find each other
within about three seconds.

### Without a window

The engine runs headless too, which suits an always-on machine that should be
reachable from your phone without anyone logging in:

```bash
node apps/desktop/dist/main/headless.cjs --name "Server" --dir ~/Incoming --accept
```

It prints the addresses it is reachable on, the peers it finds, and every
transfer as it lands.

### Development

```bash
pnpm --filter @share/ui dev     # UI alone in a browser, against a mock bridge
pnpm --filter @share/desktop dev
pnpm test                       # core unit tests + end-to-end transfer tests
```

The UI detects its host at runtime — Electron preload, the Android plugin, or a
mock when neither is present — so the whole interface is explorable in a plain
browser without a native shell.

---

## Packaging

`./rebuild.sh` deletes every artifact and rebuilds from source — dependencies,
shared core, UI, Electron shell, desktop packages and the APK — running both
test suites on the way. Targets the machine cannot build (no Android SDK, no
Wine) are skipped with a warning; name a target explicitly and a missing
prerequisite becomes an error instead.

```bash
./rebuild.sh                       # everything, with tests
./rebuild.sh --linux --skip-tests  # quick Linux-only rebuild
./rebuild.sh --deep                # also wipe node_modules and reinstall
./rebuild.sh --clean               # just delete the artifacts
```

Or drive the individual targets yourself:

| Target | Command | Output |
| --- | --- | --- |
| Linux | `pnpm --filter @share/desktop dist:linux` | `release/` — AppImage, `.deb`, `.tar.gz` |
| Windows | `pnpm --filter @share/desktop dist:win` | `release/` — NSIS installer, portable `.zip` |
| Android | `pnpm --filter @share/android apk` | `apps/android/android/app/build/outputs/apk/debug/` |

Building the Windows NSIS installer **from Linux** needs Wine
(`sudo pacman -S wine`, or `apt install wine`). Without it, use `--win zip`,
which repackages without running any Windows tooling.

Android needs a JDK (17+) and the Android SDK; point `ANDROID_HOME` at it, or
put `sdk.dir=/path/to/Sdk` in `apps/android/android/local.properties`. For a
release APK, `apk:release`, then sign it with your own key.

---

## The picker

The file picker is the part you will spend the most time in, so it is built out
properly rather than deferring to the OS dialog:

- **Three views** — list, thumbnail grid, and a lazy-loading tree, switched
  from a labelled toggle in the toolbar
- **Real thumbnails** — image previews in both the list and the grid, with a
  size slider (48–256 px) that reflows the grid live, and a toggle to fall back
  to type icons. On Android, video frames are decoded natively through
  MediaStore; images stream straight into the view with no copying. On the
  desktop, images are served over the app's own protocol handler rather than
  exposing the filesystem to the renderer.
- **Tri-state selection** — check a folder without listing it; uncheck one file
  inside and the parent goes indeterminate. The selection is stored as *included
  subtree roots plus exclusions*, so ticking `Pictures/` costs nothing and is
  only expanded into a file list when you press Send.
- **Filters** — categories, extensions, size and date ranges, include/exclude
  globs (`**/*.raw`, `!**/cache/**`), folder depth, hidden files, symlink policy
- **Junk skipping** — `node_modules`, `.git`, `__pycache__`, `.DS_Store` and
  friends are excluded by default, toggleable
- **Live measurement** — folder sizes and counts are walked in the background,
  so the tray shows real totals before anything is sent
- **Keyboard** — arrows to move, `Space` to toggle, `Enter` to open,
  `Backspace` to go up, `Ctrl+A` to select all, shift-click for ranges
- **Playback in place** — video and audio get a centred play button on their
  thumbnail and open in a player without leaving the picker. Both platforms
  stream with range support, so seeking is instant instead of re-buffering
- **Collapsible places column** — the shortcuts sidebar folds away (toolbar
  button or `F9`) and the file list takes the width. The choice is remembered
  separately for wide and narrow windows, so a phone keeps it out of the way
  while a desktop keeps it open
- Bookmarks, breadcrumbs, back/forward history, per-item removal from the tray,
  and the native OS picker when you would rather use it

On Android the sidebar lists the storage devices themselves - internal storage
plus any SD card or USB drive - and you browse into them. That needs "all files
access", which the picker offers when it is missing. Without it the app falls
back to the MediaStore collections (Photos, Videos, Music) and folder trees
granted through the Storage Access Framework, which is all Android allows.

---

## Speed and the queue

Two independent dials, both in Settings:

- **Files at once** (`parallelFiles`) — how many files move simultaneously
- **Connections per file** (`connectionsPerFile`) — splits one large file into
  byte ranges sent in parallel

Chunk size is separate from either: it sets *granularity*, so a paused or
dropped transfer re-sends kilobytes rather than gigabytes. A single-connection
transfer of a 20 GB file is still chunked.

More connections is not automatically faster. On wired gigabit, 2–4 usually
saturates the link; Wi-Fi and high-latency VPN links benefit from more. Leave
**Adapt automatically** on and the scheduler opens and closes connections based
on the throughput it actually observes.

Everything queues, and the queue is fully under your control: pause and resume
individual transfers or all of them, cancel, retry, reorder the waiting line,
remove a transfer entirely, or **remove individual files** from a transfer that
has not sent them yet. Interrupted transfers resume by asking the receiver which
byte ranges it already holds, so little is re-sent.

---

## Android in the background

Android freezes background network jobs aggressively — Doze, App Standby and
OEM task killers all target exactly this kind of long-running transfer. Four
things keep a transfer alive, and the app holds all of them for as long as, and
only as long as, work is in flight:

1. **A foreground service** of type `dataSync` — the only supported way to run
   indefinitely in the background. This is why a notification appears during a
   transfer; it is the deal Android offers.
2. **A partial wake lock** — keeps the CPU running with the screen off.
3. **A high-performance Wi-Fi lock** — stops the radio being parked, which
   otherwise collapses throughput or drops the connection.
4. **A multicast lock** — without it the kernel silently discards discovery
   beacons.

Swiping the app away does not abort a transfer, and the service is restarted
after a reboot so the device stays discoverable.

The locks are released the moment the queue drains: holding them permanently
would drain the battery, and from Android 15 a `dataSync` foreground service is
capped at roughly six hours per day.

**One honest caveat:** Android offers no absolute guarantee. On stock Android
the above is sufficient. Some OEM skins (Xiaomi, Oppo, Huawei, Samsung) will
still freeze the app unless it is exempt from battery optimisation — *Settings →
Running in the background → Ignore battery optimisation* asks for that, and on
those devices you may also need to enable "Autostart" in the system settings,
which no app can request programmatically.

---

## Layout

```
packages/core        protocol, settings, queue, scheduler, picker model — pure TS
packages/ui          React UI, Adwaita-flavoured, shared by both platforms
apps/desktop         Electron: main process engine, preload bridge, packaging
apps/android         Capacitor shell + the Java engine
```

`packages/core` holds everything that is neither platform nor UI: the wire
protocol, the tri-state selection model, filtering and globbing, chunk planning,
the parallel scheduler and the transfer queue. It has no dependencies and is
unit tested on its own.

---

## Testing

```bash
pnpm --filter @share/core test      # 35 unit tests
pnpm --filter @share/desktop test   # 7 end-to-end transfer tests
```

The end-to-end suite stands up two real engines on real sockets and checks that
a folder tree arrives byte-identical, that a 20 MB file split across eight
connections reassembles correctly, that pause/resume and per-file removal behave,
that cancelling leaves no partial files, and that a peer cannot escape the
destination directory with `../` or upload without an accept token.

---

## Security

Transfers are LAN-local and every one requires explicit acceptance on the
receiving device (auto-accept is opt-in, per device). Upload tokens are issued
only on accept, incoming paths are sanitised against traversal, reserved names
and control characters, and bytes are written to `.part` files that are only
renamed once the byte ranges are provably complete.

Traffic is **not encrypted** — this is a tool for networks you control. Over an
untrusted network, run it across a mesh VPN, which is encrypted end to end and
which this app is designed to work over.

---

## Licence

MIT
