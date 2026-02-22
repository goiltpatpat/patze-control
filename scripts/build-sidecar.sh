#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARIES_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      case "$arch" in
        x86_64)  echo "x86_64-unknown-linux-gnu" ;;
        aarch64) echo "aarch64-unknown-linux-gnu" ;;
        *)       echo "unknown" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64)  echo "x86_64-apple-darwin" ;;
        arm64)   echo "aarch64-apple-darwin" ;;
        *)       echo "unknown" ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "x86_64-pc-windows-msvc"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

TARGET="$(detect_target)"
if [ "$TARGET" = "unknown" ]; then
  echo "Error: unsupported platform"
  exit 1
fi

echo "Building API server sidecar for $TARGET..."
mkdir -p "$BINARIES_DIR"

cd "$ROOT_DIR"
pnpm --filter @patze/telemetry-core build

OUTFILE="$BINARIES_DIR/patze-api-$TARGET"
if [[ "$TARGET" == *"windows-msvc" ]]; then
  OUTFILE="${OUTFILE}.exe"
fi
bun build apps/api-server/src/index.ts --compile --outfile "$OUTFILE" --target bun

chmod +x "$OUTFILE"
SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "Built: $OUTFILE ($SIZE)"
