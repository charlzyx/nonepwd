#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_KEY="darwin" ;;
  Linux)  OS_KEY="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH_KEY="arm64" ;;
  x86_64|amd64)  ARCH_KEY="x86_64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

PREFIX="${PREFIX:-$HOME/.local/bin}"
mkdir -p "$PREFIX"

PREBUILT="$ROOT_DIR/dist/bin/np-${OS_KEY}-${ARCH_KEY}"
if [[ -x "$PREBUILT" ]]; then
  cp "$PREBUILT" "$PREFIX/np"
else
  echo "Prebuilt binary not found at $PREBUILT; building from source with cargo..."
  (cd "$ROOT_DIR" && cargo build -p nonepwd-cli --release)
  cp "$ROOT_DIR/target/release/np" "$PREFIX/np"
fi

chmod 755 "$PREFIX/np"
echo "Installed nonepwd native CLI -> $PREFIX/np"
"$PREFIX/np" version
