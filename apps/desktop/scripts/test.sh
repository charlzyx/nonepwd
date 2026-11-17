#!/usr/bin/env bash
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
SDK_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
MIN_MACOS="26.0"
if [ ! -d "$SDK_PATH" ]; then
  SDK_PATH="$(xcrun --show-sdk-path)"
  MIN_MACOS="14.0"
fi
OUT_BIN="/tmp/nonepwd-swift-tests"
MC_DIR="/tmp/nonepwd-swift-mc-$(basename "$SDK_PATH")"

mkdir -p "$MC_DIR"
swiftc -swift-version 5 \
  -sdk "$SDK_PATH" \
  -target "arm64-apple-macosx${MIN_MACOS}" \
  -module-cache-path "$MC_DIR" \
  -parse-as-library \
  -import-objc-header "$DESKTOP_DIR/Sources/CNpCore/include/npcore.h" \
  -L "$REPO_ROOT/dist/lib" -lnonepwd_core \
  -Xlinker -rpath -Xlinker "$REPO_ROOT/dist/lib" \
  "$DESKTOP_DIR/Sources/NonePwd/Core/Models.swift" \
  "$DESKTOP_DIR/Sources/NonePwd/Core/NpCoreBridge.swift" \
  "$DESKTOP_DIR/Tests/NonePwdTests/NpCoreTests.swift" \
  -o "$OUT_BIN"

"$OUT_BIN"
