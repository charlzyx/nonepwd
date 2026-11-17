#!/usr/bin/env bash
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$DESKTOP_DIR/dist/NonePwd.app"
APP_BIN="$APP_DIR/Contents/MacOS/NonePwd"

source_fingerprint() {
  find "$DESKTOP_DIR/Sources" -type f \( -name '*.swift' -o -name '*.h' -o -name 'module.modulemap' \) \
    -exec stat -f "%m %N" {} + 2>/dev/null | sort
}

needs_build() {
  if [ ! -f "$APP_BIN" ] || [ ! -f "$APP_DIR/Contents/Resources/AppIcon.icns" ] || [ ! -f "$APP_DIR/Contents/Info.plist" ]; then
    return 0
  fi
  if [ -n "$(find "$DESKTOP_DIR/Sources" -type f \( -name '*.swift' -o -name '*.h' -o -name 'module.modulemap' \) -newer "$APP_BIN" 2>/dev/null | head -n 1)" ]; then
    return 0
  fi
  return 1
}

stop_running_app() {
  if pgrep -x NonePwd >/dev/null 2>&1; then
    pkill -x NonePwd || true
    for _ in $(seq 1 20); do
      pgrep -x NonePwd >/dev/null 2>&1 || break
      sleep 0.1
    done
  fi
}

launch_app() {
  stop_running_app
  open "$APP_DIR"
  sleep 0.8
  if ! pgrep -x NonePwd >/dev/null 2>&1; then
    echo "[dev] ERROR: NonePwd.app did not stay running after launch." >&2
    return 1
  fi
}

build_and_launch() {
  SWIFT_OPT="-Onone" ONLY_BINARY=1 bash "$DESKTOP_DIR/scripts/build-app.sh"
  launch_app
}

trap 'echo "[dev] Watcher exiting."; exit 0' INT TERM

LAST_FP="$(source_fingerprint)"
if needs_build; then
  echo "[dev] Initial debug build & launch..."
  build_and_launch
else
  echo "[dev] Existing bundle is up-to-date; launching NonePwd.app..."
  launch_app
fi
echo "[dev] NonePwd.app is running in dev watch mode (watching Sources/ every 1.5s)..."

while true; do
  sleep 1.5
  CUR_FP="$(source_fingerprint)"
  if [ "$CUR_FP" != "$LAST_FP" ]; then
    LAST_FP="$CUR_FP"
    echo "[dev] $(date '+%H:%M:%S') Source change detected, rebuilding..."
    if build_and_launch; then
      echo "[dev] $(date '+%H:%M:%S') Relaunched NonePwd.app cleanly."
    else
      echo "[dev] $(date '+%H:%M:%S') Build/launch failed; waiting for next save..." >&2
    fi
  fi
done
