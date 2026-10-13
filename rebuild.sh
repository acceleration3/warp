#!/usr/bin/env bash
#
# Wipe every build output and rebuild it from source.
#
#   ./rebuild.sh                  clean, build everything the machine can build, test
#   ./rebuild.sh --help           full option list
#
# Targets that the machine cannot build are skipped with a warning rather than
# failing the run - no Android SDK should not stop you getting a Linux build.
# Anything explicitly requested with a flag is a hard requirement instead.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# --- options ----------------------------------------------------------------

DO_LINUX=1
DO_WINDOWS=1
DO_ANDROID=1
DO_TESTS=1
DEEP_CLEAN=0
CLEAN_ONLY=0
ANDROID_RELEASE=0
EXPLICIT_TARGETS=0

usage() {
  cat <<'EOF'
Usage: ./rebuild.sh [options]

Deletes every build artifact and rebuilds from source.

Targets (default: all of them)
  --linux             Linux AppImage, .deb and .tar.gz
  --win               Windows NSIS installer and portable .zip
  --android           Android APK
  --desktop           shorthand for --linux --win
  Naming any target builds only those, and makes them required.

Options
  --android-release   build assembleRelease instead of assembleDebug (unsigned)
  --skip-tests        do not run the unit and end-to-end suites
  --deep              also delete node_modules and reinstall from the lockfile
  --clean             delete artifacts and stop
  -h, --help          this message

Examples
  ./rebuild.sh --linux --skip-tests    quick Linux-only rebuild
  ./rebuild.sh --deep                  full scrub, including dependencies
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --linux)   [[ $EXPLICIT_TARGETS == 0 ]] && { DO_LINUX=0; DO_WINDOWS=0; DO_ANDROID=0; EXPLICIT_TARGETS=1; }; DO_LINUX=1 ;;
    --win|--windows) [[ $EXPLICIT_TARGETS == 0 ]] && { DO_LINUX=0; DO_WINDOWS=0; DO_ANDROID=0; EXPLICIT_TARGETS=1; }; DO_WINDOWS=1 ;;
    --android) [[ $EXPLICIT_TARGETS == 0 ]] && { DO_LINUX=0; DO_WINDOWS=0; DO_ANDROID=0; EXPLICIT_TARGETS=1; }; DO_ANDROID=1 ;;
    --desktop) [[ $EXPLICIT_TARGETS == 0 ]] && { DO_LINUX=0; DO_WINDOWS=0; DO_ANDROID=0; EXPLICIT_TARGETS=1; }; DO_LINUX=1; DO_WINDOWS=1 ;;
    --android-release) ANDROID_RELEASE=1 ;;
    --skip-tests) DO_TESTS=0 ;;
    --deep) DEEP_CLEAN=1 ;;
    --clean) CLEAN_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; echo; usage >&2; exit 2 ;;
  esac
  shift
done

# --- output -----------------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BLUE=$'\e[34m'; OFF=$'\e[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; OFF=''
fi

STARTED=$SECONDS
SKIPPED=()

step()  { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$OFF" "$BOLD" "$*" "$OFF"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$OFF" "$*"; SKIPPED+=("$*"); }
die()   { printf '\n%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# Requested explicitly -> missing prerequisites are fatal, not a warning.
require_or_skip() {
  local what="$1" message="$2"
  if [[ $EXPLICIT_TARGETS == 1 ]]; then
    die "$what was requested but $message"
  fi
  warn "$what skipped: $message"
  return 1
}

# --- prerequisites ----------------------------------------------------------
#
# Everything is checked before a single file is deleted: finding out that a
# requested target cannot be built should cost a second, not a full rebuild.

step "Checking prerequisites"

have node || die "node is not installed"
have pnpm || die "pnpm is not installed (npm i -g pnpm)"
ok "node $(node --version), pnpm $(pnpm --version)"

if [[ $DO_WINDOWS == 1 ]] && ! have wine; then
  # electron-builder drives the real NSIS toolchain through Wine.
  require_or_skip "Windows build" "wine is not installed (needed for the NSIS installer)" || DO_WINDOWS=0
fi

if [[ $DO_ANDROID == 1 ]]; then
  # Find an SDK the way Gradle would: environment first, then the usual spots.
  if [[ -z "${ANDROID_HOME:-}" ]]; then
    for candidate in "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
      [[ -n "$candidate" && -d "$candidate" ]] && { export ANDROID_HOME="$candidate"; break; }
    done
  fi
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

  if [[ -z "${ANDROID_HOME:-}" || ! -d "${ANDROID_HOME:-}" ]]; then
    require_or_skip "Android build" "no SDK found (set ANDROID_HOME)" || DO_ANDROID=0
  elif ! have java; then
    require_or_skip "Android build" "java is not installed (JDK 17+ required)" || DO_ANDROID=0
  else
    ok "Android SDK at $ANDROID_HOME"
  fi
fi

if [[ $DO_LINUX == 0 && $DO_WINDOWS == 0 && $DO_ANDROID == 0 && $CLEAN_ONLY == 0 ]]; then
  die "nothing left to build"
fi

# --- clean ------------------------------------------------------------------

step "Deleting build artifacts"

rm -rf \
  "$ROOT/release" \
  "$ROOT/packages/core/dist" \
  "$ROOT/packages/ui/dist" \
  "$ROOT/apps/desktop/dist" \
  "$ROOT/apps/android/www" \
  "$ROOT/apps/android/android/app/build" \
  "$ROOT/apps/android/android/build" \
  "$ROOT/apps/android/android/.gradle" \
  "$ROOT/apps/android/android/app/src/main/assets/public"

# Stale incremental state makes tsc quietly skip work after a manual delete.
find "$ROOT" -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete 2>/dev/null || true
ok "artifacts removed"

if [[ $DEEP_CLEAN == 1 ]]; then
  info "removing node_modules (--deep)"
  find "$ROOT" -name node_modules -maxdepth 4 -type d -prune -exec rm -rf {} + 2>/dev/null || true
  ok "dependencies removed"
fi

if [[ $CLEAN_ONLY == 1 ]]; then
  printf '\n%sClean finished in %ss.%s\n' "$GREEN" "$((SECONDS - STARTED))" "$OFF"
  exit 0
fi

# --- dependencies -----------------------------------------------------------

step "Installing dependencies"
if [[ $DEEP_CLEAN == 1 && -f "$ROOT/pnpm-lock.yaml" ]]; then
  pnpm install --frozen-lockfile
else
  pnpm install
fi
ok "dependencies ready"

# Electron ships a large binary via a postinstall script; a deep clean or a
# fresh checkout can leave it missing while the package itself looks installed.
ELECTRON_BIN="$ROOT/apps/desktop/node_modules/electron/dist/electron"
if [[ ($DO_LINUX == 1 || $DO_WINDOWS == 1) && ! -x "$ELECTRON_BIN" ]]; then
  info "fetching the Electron binary"
  ( cd "$ROOT/apps/desktop/node_modules/electron" && node install.js ) \
    || die "could not download the Electron binary"
  ok "Electron binary in place"
fi

# --- shared code ------------------------------------------------------------

step "Building @share/core"
pnpm --filter @share/core build
ok "core built"

if [[ $DO_TESTS == 1 ]]; then
  step "Running tests"
  pnpm --filter @share/core test
  ok "core unit tests passed"
fi

step "Building the UI and the Electron shell"
pnpm --filter @share/desktop run build:main
pnpm --filter @share/desktop run build:preload
pnpm --filter @share/ui build
ok "renderer, main process and preload built"

# The headless runner is not part of the packaged app, but it is how you run
# the engine on a server and how the end-to-end tests exercise it.
( cd "$ROOT/apps/desktop" && ./node_modules/.bin/esbuild src/main/headless.ts \
    --bundle --platform=node --format=cjs --target=node22 \
    --outfile=dist/main/headless.cjs --external:electron >/dev/null )
ok "headless runner built"

if [[ $DO_TESTS == 1 ]]; then
  pnpm --filter @share/desktop test
  ok "end-to-end transfer tests passed"
fi

# --- desktop packages -------------------------------------------------------

BUILDER_ARGS=()

if [[ $DO_LINUX == 1 ]]; then
  BUILDER_ARGS+=(--linux)
fi

if [[ $DO_WINDOWS == 1 ]]; then
  BUILDER_ARGS+=(--win)
fi

if [[ ${#BUILDER_ARGS[@]} -gt 0 ]]; then
  step "Packaging the desktop app (${BUILDER_ARGS[*]})"
  ( cd "$ROOT/apps/desktop" && ./node_modules/.bin/electron-builder "${BUILDER_ARGS[@]}" --publish never )
  ok "desktop packages built"
fi

# --- android ----------------------------------------------------------------

if [[ $DO_ANDROID == 1 ]]; then
  step "Building the Android APK"

  # Gradle reads the SDK path from here when the environment is not inherited.
  echo "sdk.dir=$ANDROID_HOME" > "$ROOT/apps/android/android/local.properties"

  pnpm --filter @share/android run build:ui
  ( cd "$ROOT/apps/android" && ./node_modules/.bin/cap sync android )

  if [[ $ANDROID_RELEASE == 1 ]]; then
    ( cd "$ROOT/apps/android/android" && ./gradlew assembleRelease --no-daemon -q )
    ok "release APK built (unsigned - sign it with your own key before distributing)"
  else
    ( cd "$ROOT/apps/android/android" && ./gradlew assembleDebug --no-daemon -q )
    ok "debug APK built"
  fi
fi

# --- summary ----------------------------------------------------------------

step "Artifacts"

FOUND=0
print_artifact() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  printf '    %-38s %8s\n' "$(basename "$path")" "$(du -h "$path" | cut -f1)"
  FOUND=$((FOUND + 1))
}

shopt -s nullglob
for artifact in "$ROOT"/release/*.AppImage "$ROOT"/release/*.deb "$ROOT"/release/*.tar.gz \
                "$ROOT"/release/*.exe "$ROOT"/release/*.zip \
                "$ROOT"/apps/android/android/app/build/outputs/apk/*/*.apk; do
  print_artifact "$artifact"
done
shopt -u nullglob

if [[ $FOUND == 0 ]]; then
  die "no artifacts were produced"
fi

info ""
info "desktop packages: ${DIM}release/${OFF}"
[[ $DO_ANDROID == 1 ]] && info "android package:  ${DIM}apps/android/android/app/build/outputs/apk/${OFF}"

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  printf '\n%sSkipped:%s\n' "$YELLOW" "$OFF"
  for entry in "${SKIPPED[@]}"; do printf '    - %s\n' "$entry"; done
fi

printf '\n%sRebuilt %d artifact(s) in %sm%ss.%s\n' \
  "$GREEN" "$FOUND" "$(( (SECONDS - STARTED) / 60 ))" "$(( (SECONDS - STARTED) % 60 ))" "$OFF"
