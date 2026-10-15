#!/usr/bin/env bash
# Builds HMIS-Print-<version>-win-x64.zip, the app bundle an installed program updates from, and
# the feed that names both. Runs on Linux; nothing here executes a Windows binary.
#
#   tools/print-relay/build-windows.sh <out-dir> [--auto-update]
#
# Node and SumatraPDF are PINNED by version and SHA-256. Node's hash is the one nodejs.org publishes
# in SHASUMS256.txt for that release. SumatraPDF publishes no hash file: the value below is the hash
# of the official 3.5.2 download on 2026-10-07 — trust on first use, then pinned. A changed download
# fails this build rather than shipping to a counter.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build-windows.sh <out-dir> [--auto-update]}"
AUTO=false; [ "${2:-}" = "--auto-update" ] && AUTO=true
VERSION="$(tr -d ' \n\r' < "$HERE/VERSION")"
CACHE="${HMIS_PRINT_CACHE:-$HOME/.cache/hmis-print-build}"

NODE_VERSION="v22.20.0"
NODE_SHA256="fdddbf4581e046b8102815d56208d6a248950bb554570b81519a8a5dacfee95d"   # win-x64/node.exe
SUMATRA_VERSION="3.5.2"
SUMATRA_ZIP_SHA256="66ccb395c9184dce6822dfbb9970c877383b3ead6d9417b5106a844aac512989"

fetch() { # url file sha256
  if [ ! -f "$2" ] || [ "$(sha256sum "$2" | cut -d' ' -f1)" != "$3" ]; then
    curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2"
  fi
  local got; got="$(sha256sum "$2" | cut -d' ' -f1)"
  if [ "$got" != "$3" ]; then echo "SHA-256 mismatch for $1: got $got, pinned $3" >&2; exit 1; fi
}

mkdir -p "$CACHE" "$OUT"
fetch "https://nodejs.org/dist/$NODE_VERSION/win-x64/node.exe" "$CACHE/node-$NODE_VERSION.exe" "$NODE_SHA256"
fetch "https://www.sumatrapdfreader.org/dl/rel/$SUMATRA_VERSION/SumatraPDF-$SUMATRA_VERSION-64.zip" "$CACHE/sumatra-$SUMATRA_VERSION.zip" "$SUMATRA_ZIP_SHA256"

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/HMIS-Print"
mkdir -p "$ROOT/app" "$ROOT/LICENSES"
cp "$CACHE/node-$NODE_VERSION.exe" "$ROOT/node.exe"
unzip -q -o "$CACHE/sumatra-$SUMATRA_VERSION.zip" -d "$STAGE/sumatra"
cp "$STAGE/sumatra/SumatraPDF-$SUMATRA_VERSION-64.exe" "$ROOT/SumatraPDF.exe"
cp "$HERE/launcher.mjs" "$ROOT/"
cp "$HERE/relay.mjs" "$HERE/platform.mjs" "$HERE/program.mjs" "$HERE/VERSION" "$ROOT/app/"
cp "$HERE/windows/install.cmd" "$HERE/windows/install.ps1" "$HERE/windows/uninstall.cmd" "$HERE/windows/uninstall.ps1" "$HERE/windows/README.txt" "$ROOT/"
# Windows tools want CRLF in .cmd files; PowerShell and Notepad read either, but be kind to Notepad.
sed -i 's/\r$//; s/$/\r/' "$ROOT"/*.cmd "$ROOT"/*.ps1 "$ROOT/README.txt"
cat > "$ROOT/LICENSES/README.txt" <<TXT
SumatraPDF $SUMATRA_VERSION is distributed unmodified under the GNU GPL v3:
  https://github.com/sumatrapdfreader/sumatrapdf/blob/master/COPYING
  source: https://github.com/sumatrapdfreader/sumatrapdf (tag ${SUMATRA_VERSION}rel)
Node.js $NODE_VERSION is distributed under the MIT licence and the licences of its bundled parts:
  https://github.com/nodejs/node/blob/$NODE_VERSION/LICENSE
The HMIS print program (launcher.mjs, app/) is the hospital's own and talks to SumatraPDF only by
running it as a separate program.
TXT

ZIP="hmis-print-$VERSION-win-x64.zip"
APP="hmis-print-app-$VERSION.json"
# python3's zipfile rather than `zip`: one fewer thing to install, and the entry order and
# timestamps are fixed, so the same inputs make the same zip (and the same SHA-256).
python3 - "$STAGE" "$OUT/$ZIP" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(os.path.join(stage, "HMIS-Print")):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            info = zipfile.ZipInfo(os.path.relpath(full, stage).replace(os.sep, "/"), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(info, f.read(), compresslevel=9)
PY
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const [here, out, app, version] = process.argv.slice(1);
  const files = {};
  for (const n of ["relay.mjs", "platform.mjs", "program.mjs", "VERSION"]) files[n] = readFileSync(`${here}/${n}`, "utf8");
  writeFileSync(`${out}/${app}`, JSON.stringify({ version, files }));
' "$HERE" "$OUT" "$APP" "$VERSION"
ZIP_SHA="$(sha256sum "$OUT/$ZIP" | cut -d' ' -f1)"
APP_SHA="$(sha256sum "$OUT/$APP" | cut -d' ' -f1)"
cat > "$OUT/hmis-print-windows-latest.json" <<JSON
{
  "version": "$VERSION",
  "autoUpdate": $AUTO,
  "zip": "$ZIP",
  "zipSha256": "$ZIP_SHA",
  "app": "$APP",
  "appSha256": "$APP_SHA",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
ln -sf "$ZIP" "$OUT/hmis-print-latest-win-x64.zip"
echo "built $OUT/$ZIP ($(du -h "$OUT/$ZIP" | cut -f1)) sha256 $ZIP_SHA"
echo "app bundle $APP sha256 $APP_SHA · feed autoUpdate=$AUTO"
