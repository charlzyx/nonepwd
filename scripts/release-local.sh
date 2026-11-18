#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS_DIR="$REPO_ROOT/release-assets"

TAG="v0.2.0"
MODE="build-and-publish"
PRERELEASE=false
TITLE=""
NOTES=""

usage() {
  cat <<'USAGE'
Usage: scripts/release-local.sh [TAG] [options]

Options:
  --build-only      Build and verify all Mac/iOS/Android/CLI/Extension assets in release-assets/
  --publish-only    Publish existing release-assets/* to GitHub Release TAG (0 Actions minutes)
  --publish         Build all assets and publish GitHub Release TAG (default)
  --prerelease      Mark the GitHub Release as pre-release
  --title TITLE     Custom release title (default: NonePwd TAG)
  --notes NOTES     Custom release notes
  -h, --help        Show this help message
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only)
      MODE="build-only"
      shift
      ;;
    --publish-only)
      MODE="publish-only"
      shift
      ;;
    --publish)
      MODE="build-and-publish"
      shift
      ;;
    --prerelease)
      PRERELEASE=true
      shift
      ;;
    --title)
      TITLE="${2:?Missing value for --title}"
      shift 2
      ;;
    --notes)
      NOTES="${2:?Missing value for --notes}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      TAG="$1"
      shift
      ;;
  esac
done

REQUIRED_ASSETS=(
  "NonePwd-macos-arm64.zip"
  "NonePwd-ios-unsigned.ipa"
  "NonePwd-ios-sim-arm64.app.zip"
  "NonePwd-android.apk"
  "nonepwd-extension.zip"
  "np-darwin-arm64"
  "install-cli.sh"
)

configure_rust_lld_path() {
  if command -v rustc >/dev/null 2>&1; then
    local sysroot host lld_dir
    sysroot="$(rustc --print sysroot 2>/dev/null || true)"
    host="$(rustc -vV 2>/dev/null | awk '/^host:/ {print $2}' || true)"
    lld_dir="$sysroot/lib/rustlib/$host/bin"
    if [ -n "$sysroot" ] && [ -n "$host" ] && [ -d "$lld_dir" ]; then
      export PATH="$lld_dir:$PATH"
    fi
  fi
}

build_all_assets() {
  cd "$REPO_ROOT"
  configure_rust_lld_path

  rm -rf "$ASSETS_DIR"
  mkdir -p "$ASSETS_DIR"

  echo "[release-local] 1/6 Building Rust WASM, native dylib, CLI, server, web, and MV3 extension..."
  pnpm build

  echo "[release-local] 2/6 Checking and testing NSH app (macOS/iOS/Android)..."
  (
    cd "$REPO_ROOT/apps/nsh"
    nsh check
    nsh test
  )

  echo "[release-local] 3/6 Testing, building, and archiving macOS NonePwd.app..."
  "$REPO_ROOT/apps/desktop/scripts/test.sh"
  "$REPO_ROOT/apps/desktop/scripts/build-app.sh"
  ditto -c -k --sequesterRsrc --keepParent \
    "$REPO_ROOT/apps/desktop/dist/NonePwd.app" \
    "$ASSETS_DIR/NonePwd-macos-arm64.zip"

  echo "[release-local] 4/6 Packaging iOS IPA and iOS Simulator app..."
  bash "$REPO_ROOT/apps/nsh/scripts/package-ios.sh" "$ASSETS_DIR/NonePwd-ios-unsigned.ipa"
  cp -f "$ASSETS_DIR/NonePwd-ios-unsigned.ipa" "$REPO_ROOT/dist/NonePwd-ios-unsigned.ipa"

  local sim_tmp
  sim_tmp="$(mktemp -d "${TMPDIR:-/tmp}/nonepwd-ios-sim.XXXXXX")"
  nsh package --target ios-simulator -o "$sim_tmp" "$REPO_ROOT/apps/nsh"
  ditto -c -k --sequesterRsrc --keepParent \
    "$sim_tmp/NonePwd.app" \
    "$ASSETS_DIR/NonePwd-ios-sim-arm64.app.zip"
  rm -rf "$sim_tmp"

  echo "[release-local] 5/6 Packaging signed Android APK..."
  bash "$REPO_ROOT/apps/nsh/scripts/package-android.sh" "$ASSETS_DIR/NonePwd-android.apk"
  rm -f "$ASSETS_DIR"/*.idsig
  cp -f "$ASSETS_DIR/NonePwd-android.apk" "$REPO_ROOT/dist/NonePwd-android.apk"

  echo "[release-local] 6/6 Staging CLI binaries, extension archive, and SHA256SUMS.txt..."
  cp -f "$REPO_ROOT/dist/bin/np-darwin-arm64" "$ASSETS_DIR/"
  if [ -f "$REPO_ROOT/dist/bin/np-linux-x86_64" ]; then
    cp -f "$REPO_ROOT/dist/bin/np-linux-x86_64" "$ASSETS_DIR/"
  fi
  if [ -f "$REPO_ROOT/dist/bin/np-linux-arm64" ]; then
    cp -f "$REPO_ROOT/dist/bin/np-linux-arm64" "$ASSETS_DIR/"
  fi
  cp -f "$REPO_ROOT/dist/bin/nonepwd-extension.zip" "$ASSETS_DIR/"
  cp -f "$REPO_ROOT/scripts/install-cli.sh" "$ASSETS_DIR/"
  chmod 755 "$ASSETS_DIR"/np-* "$ASSETS_DIR/install-cli.sh"

  verify_and_hash_assets
}

verify_and_hash_assets() {
  if [ ! -d "$ASSETS_DIR" ]; then
    echo "ERROR: $ASSETS_DIR does not exist. Run with --build-only first." >&2
    exit 1
  fi

  cd "$ASSETS_DIR"
  rm -f ./*.idsig SHA256SUMS.txt

  for req in "${REQUIRED_ASSETS[@]}"; do
    if [ ! -f "$req" ]; then
      echo "ERROR: Missing required release asset: $ASSETS_DIR/$req" >&2
      exit 1
    fi
  done

  local files=()
  while IFS= read -r f; do
    files+=("$f")
  done < <(find . -maxdepth 1 -type f ! -name 'SHA256SUMS.txt' ! -name '*.idsig' -exec basename {} \; | sort)

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${files[@]}" > SHA256SUMS.txt
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${files[@]}" > SHA256SUMS.txt
  else
    echo "ERROR: Neither sha256sum nor shasum found." >&2
    exit 1
  fi

  echo "[release-local] Verified assets and checksums ($ASSETS_DIR/SHA256SUMS.txt):"
  cat SHA256SUMS.txt
}

publish_release() {
  cd "$REPO_ROOT"
  verify_and_hash_assets

  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: gh CLI is required to publish GitHub Releases." >&2
    exit 1
  fi

  local release_title="${TITLE:-NonePwd $TAG}"
  local target_sha
  target_sha="$(git rev-parse HEAD)"

  local upload_files=()
  while IFS= read -r path; do
    upload_files+=("$path")
  done < <(find "$ASSETS_DIR" -maxdepth 1 -type f ! -name '*.idsig' | sort)

  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "[release-local] Release $TAG already exists; uploading assets with --clobber..."
    gh release upload "$TAG" "${upload_files[@]}" --clobber
  else
    echo "[release-local] Creating GitHub Release $TAG at commit $target_sha..."
    local create_args=(
      "$TAG"
      "${upload_files[@]}"
      --target "$target_sha"
      --title "$release_title"
      --generate-notes
    )
    if [ "$PRERELEASE" = "true" ]; then
      create_args+=(--prerelease)
    fi
    if [ -n "$NOTES" ]; then
      create_args+=(--notes "$NOTES")
    fi
    gh release create "${create_args[@]}"
  fi

  gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,url,assets
}

case "$MODE" in
  build-only)
    build_all_assets
    ;;
  publish-only)
    publish_release
    ;;
  build-and-publish)
    build_all_assets
    publish_release
    ;;
esac
