#!/usr/bin/env bash
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
APP_DIR="$DESKTOP_DIR/dist/NonePwd.app"
DYLIB_SRC="$REPO_ROOT/dist/lib/libnonepwd_core.dylib"
EXT_DIST="$REPO_ROOT/packages/extension/dist"

resolve_sdk_path() {
  if [ -n "${SDK_PATH:-}" ] && [ -d "$SDK_PATH" ]; then
    echo "$SDK_PATH"
    return
  fi
  local default_sdk
  default_sdk="$(xcrun --show-sdk-path)"
  local clt_sdk26="/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
  if ! xcode-select -p 2>/dev/null | grep -q 'Xcode\.app' &&
     grep -q 'module: "SwiftUIMacros"' "$default_sdk/System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/"*.swiftinterface 2>/dev/null &&
     [ -d "$clt_sdk26" ]; then
    echo "$clt_sdk26"
    return
  fi
  echo "$default_sdk"
}

SDK_PATH="$(resolve_sdk_path)"
MC_DIR="${SWIFT_MODULE_CACHE_DIR:-/tmp/nonepwd-swift-mc-$(basename "$SDK_PATH")}"
if [[ "$(basename "$SDK_PATH")" == MacOSX26* || "$(basename "$SDK_PATH")" == MacOSX27* ]]; then
  MIN_MACOS="26.0"
else
  MIN_MACOS="14.0"
fi

if [ ! -f "$DYLIB_SRC" ]; then
  echo "ERROR: $DYLIB_SRC not found. Run pnpm build:rust first." >&2
  exit 1
fi

stop_running_app() {
  local target_bin="$APP_DIR/Contents/MacOS/NonePwd"
  if pgrep -f "$target_bin" >/dev/null 2>&1; then
    pkill -f "$target_bin" || true
    for _ in $(seq 1 20); do
      pgrep -f "$target_bin" >/dev/null 2>&1 || break
      sleep 0.1
    done
  fi
}

echo "[1/4] Building SwiftUI binary via swiftc..."
mkdir -p "$DESKTOP_DIR/.build" "$MC_DIR"
BIN_PATH="$DESKTOP_DIR/.build/NonePwd.new"
SWIFT_OPT="${SWIFT_OPT:--O}"

swiftc "$SWIFT_OPT" -swift-version 5 \
  -sdk "$SDK_PATH" \
  -target "arm64-apple-macosx${MIN_MACOS}" \
  -module-cache-path "$MC_DIR" \
  -parse-as-library \
  -import-objc-header "$DESKTOP_DIR/Sources/CNpCore/include/npcore.h" \
  -L "$REPO_ROOT/dist/lib" -lnonepwd_core \
  -Xlinker -rpath -Xlinker "@executable_path/../Frameworks" \
  -framework SwiftUI -framework AppKit -framework LocalAuthentication -framework Security -framework UniformTypeIdentifiers -framework Vision -framework CoreImage \
  "$DESKTOP_DIR"/Sources/NonePwd/Core/*.swift \
  "$DESKTOP_DIR"/Sources/NonePwd/Views/*.swift \
  "$DESKTOP_DIR"/Sources/NonePwd/App.swift \
  "$DESKTOP_DIR"/Sources/NonePwd/ShowcaseSnapshotter.swift \
  -o "$BIN_PATH"

chmod 755 "$BIN_PATH"
OLD_DEP="$(otool -L "$BIN_PATH" | awk '/libnonepwd_core\.dylib/ {print $1; exit}')"
if [ -n "${OLD_DEP:-}" ] && [ "$OLD_DEP" != "@rpath/libnonepwd_core.dylib" ]; then
  install_name_tool -change "$OLD_DEP" "@rpath/libnonepwd_core.dylib" "$BIN_PATH"
fi

if [ "${ONLY_BINARY:-0}" = "1" ] && [ -f "$APP_DIR/Contents/Resources/AppIcon.icns" ] && [ -f "$APP_DIR/Contents/Info.plist" ] && [ -f "$APP_DIR/Contents/Frameworks/libnonepwd_core.dylib" ]; then
  echo "[2-3/4] Updating NonePwd binary in existing bundle..."
  stop_running_app
  mv -f "$BIN_PATH" "$APP_DIR/Contents/MacOS/NonePwd"
  if [ -d "$EXT_DIST" ]; then
    rm -rf "$APP_DIR/Contents/Resources/browser-extension"
    cp -R "$EXT_DIST" "$APP_DIR/Contents/Resources/browser-extension"
  fi
else
  echo "[2/4] Generating AppIcon.icns..."
  ICON_PATH="$DESKTOP_DIR/.build/AppIcon.icns"
  rm -f "$ICON_PATH"
  ICNS_OUT="$ICON_PATH" swift -sdk "$SDK_PATH" -module-cache-path "$MC_DIR" - <<'SWIFT'
import AppKit
import Foundation
import ImageIO

let outURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["ICNS_OUT"]!)
let sizes = [16, 32, 64, 128, 256, 512, 1024]
guard let dest = CGImageDestinationCreateWithURL(outURL as CFURL, "com.apple.icns" as CFString, sizes.count, nil) else {
    fputs("Failed to create CGImageDestination\n", stderr)
    exit(1)
}

for px in sizes {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: px,
        pixelsHigh: px,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let s = CGFloat(px)
    let margin = s * 0.08
    let rect = CGRect(x: margin, y: margin, width: s - margin * 2, height: s - margin * 2)
    let path = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.225, yRadius: rect.height * 0.225)

    NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1.0).setFill()
    path.fill()

    if let sym = NSImage(systemSymbolName: "key.fill", accessibilityDescription: nil)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: s * 0.39, weight: .bold))
    {
        let imgSize = sym.size
        let drawKey: (NSColor, CGFloat, CGFloat) -> Void = { color, centerX, centerY in
            let tinted = NSImage(size: imgSize, flipped: false) { drawRect in
                color.set()
                sym.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
                drawRect.fill(using: .sourceAtop)
                return true
            }
            let destRect = NSRect(
                x: centerX - imgSize.width / 2,
                y: centerY - imgSize.height / 2,
                width: imgSize.width,
                height: imgSize.height
            )
            tinted.draw(in: destRect)
        }

        drawKey(NSColor(srgbRed: 0.96, green: 0.80, blue: 0.18, alpha: 1.0), s * 0.32, s * 0.52)
        drawKey(NSColor(srgbRed: 0.24, green: 0.80, blue: 0.38, alpha: 1.0), s * 0.50, s * 0.465)
        drawKey(NSColor(srgbRed: 0.24, green: 0.54, blue: 0.98, alpha: 1.0), s * 0.68, s * 0.52)
    }

    NSGraphicsContext.restoreGraphicsState()
    CGImageDestinationAddImage(dest, rep.cgImage!, nil)
}

guard CGImageDestinationFinalize(dest) else {
    fputs("Failed to finalize AppIcon.icns\n", stderr)
    exit(1)
}
SWIFT

  echo "[3/4] Assembling NonePwd.app bundle..."
  stop_running_app
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Frameworks" "$APP_DIR/Contents/Resources"

  mv -f "$BIN_PATH" "$APP_DIR/Contents/MacOS/NonePwd"

  cp "$DYLIB_SRC" "$APP_DIR/Contents/Frameworks/libnonepwd_core.dylib"
  chmod 755 "$APP_DIR/Contents/Frameworks/libnonepwd_core.dylib"
  install_name_tool -id "@rpath/libnonepwd_core.dylib" "$APP_DIR/Contents/Frameworks/libnonepwd_core.dylib"

  cp "$ICON_PATH" "$APP_DIR/Contents/Resources/AppIcon.icns"

  if [ -d "$EXT_DIST" ]; then
    rm -rf "$APP_DIR/Contents/Resources/browser-extension"
    cp -R "$EXT_DIST" "$APP_DIR/Contents/Resources/browser-extension"
  fi

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleExecutable</key>
  <string>NonePwd</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>dev.nonepwd.macos</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>NonePwd</string>
  <key>CFBundleDisplayName</key>
  <string>NonePwd</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${APP_VERSION:-0.2.1}</string>
  <key>CFBundleVersion</key>
  <string>${APP_BUILD:-13}</string>
  <key>LSMinimumSystemVersion</key>
  <string>${MIN_MACOS}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <false/>
  <!-- Retained for self-hosted plain http://<IP>:8787 / Tailscale servers (bare hostnames default to https:// in VaultStore) -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST
fi

echo "[4/4] Signing and verifying NonePwd.app..."
codesign --force --options runtime --sign - "$APP_DIR/Contents/Frameworks/libnonepwd_core.dylib"
codesign --force --options runtime --sign - "$APP_DIR"
codesign --verify --deep --strict "$APP_DIR"
echo "Built clean macOS bundle -> $APP_DIR"
