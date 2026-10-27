#!/usr/bin/env bash
# Builds hmis-lab-capture-<version>-win-x64.zip: node.exe + the capture program + a double-click
# starter. Runs on Linux; nothing here executes a Windows binary.
#
#   tools/lab-bridge/build-windows.sh <out-dir>
#
# Node is PINNED by version and SHA-256 — the same pin as tools/print-relay, the hash nodejs.org
# publishes in SHASUMS256.txt. A changed download fails this build rather than shipping to the lab.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build-windows.sh <out-dir>}"
VERSION="$(tr -d ' \n\r' < "$HERE/VERSION")"
CACHE="${HMIS_PRINT_CACHE:-$HOME/.cache/hmis-print-build}"

NODE_VERSION="v22.20.0"
NODE_SHA256="fdddbf4581e046b8102815d56208d6a248950bb554570b81519a8a5dacfee95d"   # win-x64/node.exe

mkdir -p "$CACHE" "$OUT"
NODE="$CACHE/node-$NODE_VERSION.exe"
if [ ! -f "$NODE" ] || [ "$(sha256sum "$NODE" | cut -d' ' -f1)" != "$NODE_SHA256" ]; then
  curl -fsSL -o "$NODE.part" "https://nodejs.org/dist/$NODE_VERSION/win-x64/node.exe" && mv "$NODE.part" "$NODE"
fi
got="$(sha256sum "$NODE" | cut -d' ' -f1)"
if [ "$got" != "$NODE_SHA256" ]; then echo "SHA-256 mismatch for node.exe: got $got, pinned $NODE_SHA256" >&2; exit 1; fi

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/HMIS-Lab-Capture"
mkdir -p "$ROOT"
cp "$NODE" "$ROOT/node.exe"
cp "$HERE/capture.mjs" "$HERE/VERSION" "$ROOT/"
cp "$HERE/windows/start-capture.cmd" "$HERE/windows/README.txt" "$ROOT/"
sed -i 's/\r$//; s/$/\r/' "$ROOT/start-capture.cmd" "$ROOT/README.txt"

ZIP="hmis-lab-capture-$VERSION-win-x64.zip"
# python3's zipfile: fixed entry order and timestamps, so the same inputs make the same zip.
python3 - "$STAGE" "$OUT/$ZIP" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(os.path.join(stage, "HMIS-Lab-Capture")):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            info = zipfile.ZipInfo(os.path.relpath(full, stage).replace(os.sep, "/"), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(info, f.read(), compresslevel=9)
PY
echo "built $OUT/$ZIP ($(du -h "$OUT/$ZIP" | cut -f1)) sha256 $(sha256sum "$OUT/$ZIP" | cut -d' ' -f1)"
