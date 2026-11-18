#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
ANDROID_DIR="$APP_DIR/android"

OUTPUT_APK="${1:-$REPO_ROOT/dist/NonePwd-android.apk}"
case "$OUTPUT_APK" in
  /*) ;;
  *) OUTPUT_APK="$PWD/$OUTPUT_APK" ;;
esac

# Resolve JAVA_HOME
if [ -z "${JAVA_HOME:-}" ]; then
  if [ -d "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" ]; then
    export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  elif command -v javac >/dev/null 2>&1; then
    JAVAC_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v javac)" 2>/dev/null || command -v javac)"
    export JAVA_HOME="$(cd "$(dirname "$JAVAC_REAL")/.." && pwd)"
  fi
fi

if [ -n "${JAVA_HOME:-}" ] && [ -d "$JAVA_HOME/bin" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

JAVAC_BIN="$(command -v javac || true)"
KEYTOOL_BIN="$(command -v keytool || true)"
if [ -z "$JAVAC_BIN" ] || [ -z "$KEYTOOL_BIN" ]; then
  echo "ERROR: javac and keytool are required (set JAVA_HOME to JDK 17+)." >&2
  exit 1
fi

# Resolve ANDROID_HOME
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    export ANDROID_HOME="$ANDROID_SDK_ROOT"
  elif [ -d "/opt/homebrew/share/android-commandlinetools" ]; then
    export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
  elif [ -d "$HOME/Library/Android/sdk" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [ -d "$HOME/Android/Sdk" ]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  fi
fi

if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "$ANDROID_HOME" ]; then
  echo "ERROR: ANDROID_HOME is not set or does not exist." >&2
  exit 1
fi
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

# Resolve build-tools
BUILD_TOOLS_DIR=""
if [ -d "$ANDROID_HOME/build-tools/35.0.0" ]; then
  BUILD_TOOLS_DIR="$ANDROID_HOME/build-tools/35.0.0"
elif [ -d "$ANDROID_HOME/build-tools" ]; then
  BUILD_TOOLS_DIR="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
fi

if [ -z "$BUILD_TOOLS_DIR" ] || [ ! -d "$BUILD_TOOLS_DIR" ]; then
  echo "ERROR: No Android build-tools found under $ANDROID_HOME/build-tools." >&2
  exit 1
fi

AAPT2_BIN="$BUILD_TOOLS_DIR/aapt2"
D8_BIN="$BUILD_TOOLS_DIR/d8"
ZIPALIGN_BIN="$BUILD_TOOLS_DIR/zipalign"
APKSIGNER_BIN="$BUILD_TOOLS_DIR/apksigner"

for tool in "$AAPT2_BIN" "$D8_BIN" "$ZIPALIGN_BIN" "$APKSIGNER_BIN"; do
  if [ ! -x "$tool" ]; then
    echo "ERROR: Required Android build tool missing or not executable: $tool" >&2
    exit 1
  fi
done

# Resolve android.jar
ANDROID_JAR=""
if [ -f "$ANDROID_HOME/platforms/android-35/android.jar" ]; then
  ANDROID_JAR="$ANDROID_HOME/platforms/android-35/android.jar"
elif [ -d "$ANDROID_HOME/platforms" ]; then
  ANDROID_JAR="$(find "$ANDROID_HOME/platforms" -mindepth 2 -maxdepth 2 -name "android.jar" | sort -V | tail -n 1)"
fi

if [ -z "$ANDROID_JAR" ] || [ ! -f "$ANDROID_JAR" ]; then
  echo "ERROR: android.jar not found under $ANDROID_HOME/platforms." >&2
  exit 1
fi

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

# Ensure repo-local debug keystore exists (never touches ~/.android/debug.keystore)
mkdir -p "$APP_DIR/.nsh"
KEYSTORE="${NSH_ANDROID_KEYSTORE:-$APP_DIR/.nsh/debug.keystore}"
KEY_ALIAS="${NSH_ANDROID_KEY_ALIAS:-androiddebugkey}"
KEYSTORE_PASS="${NSH_ANDROID_KEYSTORE_PASSWORD:-android}"

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  "$KEYTOOL_BIN" -genkeypair -noprompt -v \
    -keystore "$KEYSTORE" \
    -storepass "$KEYSTORE_PASS" \
    -keypass "$KEYSTORE_PASS" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

WORK_DIR="$(mktemp -d "$APP_DIR/.nsh/android-pkg.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "[package-android] Packaging base NSH Android bundle..."
mkdir -p "$WORK_DIR/base-out"
"$NSH_BIN" package --target android \
  -o "$WORK_DIR/base-out" \
  --keystore "$KEYSTORE" \
  --key-alias "$KEY_ALIAS" \
  --keystore-password "$KEYSTORE_PASS" \
  "$APP_DIR"

BASE_APK="$(find "$WORK_DIR/base-out" -maxdepth 2 -name '*.apk' | head -n 1)"
if [ -z "$BASE_APK" ] || [ ! -f "$BASE_APK" ]; then
  echo "ERROR: nsh package --target android did not produce an APK in $WORK_DIR/base-out" >&2
  exit 1
fi

echo "[package-android] Extracting base runtime DEX, assets, and native libraries..."
mkdir -p "$WORK_DIR/base-extract"
unzip -q "$BASE_APK" "classes.dex" -d "$WORK_DIR/base-extract"
unzip -q "$BASE_APK" "lib/*" -d "$WORK_DIR/base-extract"
unzip -q "$BASE_APK" "assets/*" -d "$WORK_DIR/base-extract" || true

if [ ! -f "$WORK_DIR/base-extract/classes.dex" ]; then
  echo "ERROR: Missing classes.dex in base APK" >&2
  exit 1
fi

echo "[package-android] Preparing Android resources and launcher icon..."
cp -R "$ANDROID_DIR/res" "$WORK_DIR/res"
mkdir -p "$WORK_DIR/res/mipmap-xxxhdpi"

resize_icon() {
  local src="$1"
  local dst="$2"
  local size="$3"
  if command -v sips >/dev/null 2>&1; then
    sips -z "$size" "$size" "$src" --out "$dst" >/dev/null
  elif command -v python3 >/dev/null 2>&1 && python3 -c "import PIL" >/dev/null 2>&1; then
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

resize_icon "$APP_DIR/icon.png" "$WORK_DIR/res/mipmap-xxxhdpi/ic_launcher.png" 192

# Generate API 26+ adaptive icon foreground (432x432 xxxhdpi = 108dp * 4, full-bleed 288x288 art centered on #1C1C1F)
make_adaptive_foreground() {
  local src="$1"
  local dst="$2"
  if command -v python3 >/dev/null 2>&1 && python3 -c "import PIL" >/dev/null 2>&1; then
    python3 -c '
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
resample = getattr(Image, "Resampling", Image).LANCZOS
fg = im.resize((288, 288), resample)
canvas = Image.new("RGBA", (432, 432), (28, 28, 31, 255))
canvas.alpha_composite(fg, (72, 72))
canvas.save(dst)
' "$src" "$dst"
  elif command -v sips >/dev/null 2>&1; then
    sips -z 288 288 "$src" --out "$dst" >/dev/null
    sips -p 432 432 --padColor 1C1C1F "$dst" --out "$dst" >/dev/null
  elif command -v magick >/dev/null 2>&1; then
    magick "$src" -resize 288x288 -background "#1C1C1F" -gravity center -extent 432x432 "$dst"
  elif command -v convert >/dev/null 2>&1; then
    convert "$src" -resize 288x288 -background "#1C1C1F" -gravity center -extent 432x432 "$dst"
  else
    echo "ERROR: No image tool found to build adaptive foreground (tried python3 PIL, sips, magick, convert)." >&2
    exit 1
  fi
}

make_adaptive_foreground "$APP_DIR/icon.png" "$WORK_DIR/res/mipmap-xxxhdpi/ic_launcher_foreground.png"

mkdir -p "$WORK_DIR/compiled" "$WORK_DIR/gen" "$WORK_DIR/classes-stubs" "$WORK_DIR/classes-app" "$WORK_DIR/dex"

echo "[package-android] Compiling and linking resources with aapt2..."
"$AAPT2_BIN" compile --dir "$WORK_DIR/res" -o "$WORK_DIR/compiled/resources.zip"
"$AAPT2_BIN" link \
  -I "$ANDROID_JAR" \
  --manifest "$ANDROID_DIR/AndroidManifest.xml" \
  --min-sdk-version 26 \
  --target-sdk-version 35 \
  --java "$WORK_DIR/gen" \
  --auto-add-overlay \
  -o "$WORK_DIR/unaligned.apk" \
  "$WORK_DIR/compiled/resources.zip"

echo "[package-android] Compiling NSH compile-time stubs and Autofill Java classes..."
find "$ANDROID_DIR/stubs" -name '*.java' | sort > "$WORK_DIR/stubs.list"
"$JAVAC_BIN" --release 11 -Xlint:none -cp "$ANDROID_JAR" -d "$WORK_DIR/classes-stubs" @"$WORK_DIR/stubs.list"

find "$ANDROID_DIR/java" "$WORK_DIR/gen" -name '*.java' | sort > "$WORK_DIR/app_java.list"
"$JAVAC_BIN" --release 11 -Xlint:all,-deprecation,-options -cp "$ANDROID_JAR:$WORK_DIR/classes-stubs" -d "$WORK_DIR/classes-app" @"$WORK_DIR/app_java.list"

echo "[package-android] Translating Java classes to classes2.dex via d8..."
find "$WORK_DIR/classes-app" -name '*.class' | sort > "$WORK_DIR/classes.list"
"$D8_BIN" --min-api 26 --lib "$ANDROID_JAR" --output "$WORK_DIR/dex" @"$WORK_DIR/classes.list"

if [ ! -f "$WORK_DIR/dex/classes.dex" ]; then
  echo "ERROR: d8 did not produce classes.dex" >&2
  exit 1
fi
cp "$WORK_DIR/dex/classes.dex" "$WORK_DIR/base-extract/classes2.dex"

echo "[package-android] Assembling APK..."
(
  cd "$WORK_DIR/base-extract"
  zip -q "$WORK_DIR/unaligned.apk" classes.dex classes2.dex
  if [ -d assets ]; then
    zip -q -r "$WORK_DIR/unaligned.apk" assets
  fi
  if [ -d lib ]; then
    zip -q -0 -r "$WORK_DIR/unaligned.apk" lib
  fi
)

echo "[package-android] Aligning and signing APK..."
"$ZIPALIGN_BIN" -f -p 4 "$WORK_DIR/unaligned.apk" "$WORK_DIR/aligned.apk"

mkdir -p "$(dirname "$OUTPUT_APK")"
"$APKSIGNER_BIN" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEYSTORE_PASS" \
  --key-pass "pass:$KEYSTORE_PASS" \
  --out "$OUTPUT_APK" \
  "$WORK_DIR/aligned.apk"

"$APKSIGNER_BIN" verify --verbose "$OUTPUT_APK"
echo "[package-android] Built and verified: $OUTPUT_APK"
