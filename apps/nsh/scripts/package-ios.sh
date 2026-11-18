#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

OUTPUT_IPA="${1:-$REPO_ROOT/dist/NonePwd-ios-unsigned.ipa}"
case "$OUTPUT_IPA" in
  /*) ;;
  *) OUTPUT_IPA="$PWD/$OUTPUT_IPA" ;;
esac

# Resolve nsh CLI
NSH_BIN="${NSH_BIN:-}"
if [ -z "$NSH_BIN" ]; then
  if command -v nsh >/dev/null 2>&1; then
    NSH_BIN="$(command -v nsh)"
  elif [ -x "/opt/homebrew/bin/nsh" ]; then
    NSH_BIN="/opt/homebrew/bin/nsh"
  elif [ -x "$HOME/.nsh/bin/nsh" ]; then
    NSH_BIN="$HOME/.nsh/bin/nsh"
  elif [ -x "$HOME/.local/bin/nsh" ]; then
    NSH_BIN="$HOME/.local/bin/nsh"
  fi
fi

if [ -z "$NSH_BIN" ] || [ ! -x "$NSH_BIN" ]; then
  echo "ERROR: nsh CLI binary not found." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to update Info.plist." >&2
  exit 1
fi

if [ ! -f "$APP_DIR/icon.png" ]; then
  echo "ERROR: Missing app icon at $APP_DIR/icon.png" >&2
  exit 1
fi

mkdir -p "$APP_DIR/.nsh"
WORK_DIR="$(mktemp -d "$APP_DIR/.nsh/ios-pkg.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

resize_icon() {
  local src="$1"
  local dst="$2"
  local size="$3"
  if command -v sips >/dev/null 2>&1; then
    sips -z "$size" "$size" "$src" --out "$dst" >/dev/null
  elif python3 -c "import PIL" >/dev/null 2>&1; then
    python3 -c '
import sys
from PIL import Image
src, dst, sz = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert("RGBA")
resample = getattr(Image, "Resampling", Image).LANCZOS
im.resize((sz, sz), resample).save(dst)
' "$src" "$dst" "$size"
  elif command -v magick >/dev/null 2>&1; then
    magick "$src" -resize "${size}x${size}" "$dst"
  elif command -v convert >/dev/null 2>&1; then
    convert "$src" -resize "${size}x${size}" "$dst"
  else
    echo "ERROR: No image resize tool found (tried sips, python3 PIL, magick, convert)." >&2
    exit 1
  fi
}

echo "[package-ios] Packaging base NSH iOS bundle..."
mkdir -p "$WORK_DIR/out-ios"
"$NSH_BIN" package --target ios -o "$WORK_DIR/out-ios" "$APP_DIR"

APP_BUNDLE="$WORK_DIR/out-ios/NonePwd.app"
if [ ! -d "$APP_BUNDLE" ]; then
  APP_BUNDLE="$(find "$WORK_DIR/out-ios" -maxdepth 2 -name '*.app' -type d | head -n 1)"
fi
if [ -z "$APP_BUNDLE" ] || [ ! -d "$APP_BUNDLE" ]; then
  echo "ERROR: nsh package --target ios did not produce NonePwd.app in $WORK_DIR/out-ios" >&2
  exit 1
fi

INFO_PLIST="$APP_BUNDLE/Info.plist"
if [ ! -f "$INFO_PLIST" ]; then
  echo "ERROR: Missing Info.plist in $APP_BUNDLE" >&2
  exit 1
fi

echo "[package-ios] Generating iOS app icons and updating Info.plist..."
resize_icon "$APP_DIR/icon.png" "$APP_BUNDLE/AppIcon60x60@2x.png" 120
resize_icon "$APP_DIR/icon.png" "$APP_BUNDLE/AppIcon60x60@3x.png" 180
rm -f "$APP_BUNDLE/AppIcon76x76@2x~ipad.png"

python3 -c '
import plistlib, sys

plist_path = sys.argv[1]
with open(plist_path, "rb") as f:
    plist = plistlib.load(f)

plist["CFBundleIcons"] = {
    "CFBundlePrimaryIcon": {
        "CFBundleIconFiles": ["AppIcon60x60"],
        "CFBundleIconName": "AppIcon",
    }
}
plist["UIDeviceFamily"] = [1]
plist["UIRequiresFullScreen"] = True
plist["UISupportedInterfaceOrientations"] = ["UIInterfaceOrientationPortrait"]
plist.pop("UISupportedInterfaceOrientations~ipad", None)
plist.pop("CFBundleIcons~ipad", None)

with open(plist_path, "wb") as f:
    plistlib.dump(plist, f)
' "$INFO_PLIST"

if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$APP_BUNDLE" || true
fi

if command -v codesign >/dev/null 2>&1; then
  echo "[package-ios] Ad-hoc signing $APP_BUNDLE..."
  codesign --force --deep --sign - "$APP_BUNDLE"
fi

OUT_IOS_DIR="$APP_DIR/.nsh/out-ios"
mkdir -p "$OUT_IOS_DIR"
rm -rf "$OUT_IOS_DIR/NonePwd.app"
cp -a "$APP_BUNDLE" "$OUT_IOS_DIR/NonePwd.app"

echo "[package-ios] Staging Payload/NonePwd.app and creating IPA..."
STAGE_DIR="$WORK_DIR/ipa-stage"
mkdir -p "$STAGE_DIR/Payload"
cp -a "$APP_BUNDLE" "$STAGE_DIR/Payload/NonePwd.app"

mkdir -p "$(dirname "$OUTPUT_IPA")"
rm -f "$OUTPUT_IPA"
if command -v ditto >/dev/null 2>&1; then
  (
    cd "$STAGE_DIR"
    ditto -c -k --norsrc --keepParent Payload "$OUTPUT_IPA"
  )
else
  (
    cd "$STAGE_DIR"
    zip -qry "$OUTPUT_IPA" Payload
  )
fi

echo "[package-ios] Built IPA: $OUTPUT_IPA"
echo "[package-ios] Updated app bundle: $OUT_IOS_DIR/NonePwd.app"
