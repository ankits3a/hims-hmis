#!/usr/bin/env bash
# Send a JavaScript change to the phones WITHOUT a new APK (owner 2026-10-06). See BUILDING.md,
# "Over-the-air updates".
#
#   apps/mobile/scripts/publish-ota.sh staging      # phones running the staging app
#   apps/mobile/scripts/publish-ota.sh production   # phones running the hospital's app
#
# It REFUSES when the native side of this checkout is not the native side of the newest APK (a new
# native module, a permission, an Expo upgrade): that change needs scripts/build-apk.sh, and a
# bundle sent to an APK it was not built against is a crash on every phone at once.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging) APP_ENV=preview; APP_ID=com.crkmch.hmis.staging; OUT_DIR="${HMIS_OTA_OUT_DIR:-/opt/hmis-context/mobile-apk}" ;;
  production) APP_ENV=production; APP_ID=com.crkmch.hmis; OUT_DIR="${HMIS_OTA_OUT_DIR:-/opt/hmis-context/mobile-apk-prod}" ;;
  *) echo "usage: $0 <staging|production>" >&2; exit 2 ;;
esac

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${HMIS_OTA_KEY:-/root/.config/hmis/android/ota-$ENV_NAME-private-key.pem}"
CERT="$APP_DIR/ota/certificate-$ENV_NAME.pem"
FEED="$OUT_DIR/hmis-staff-$ENV_NAME-latest.json"
LOCK=/opt/hmis-lanes/.orchestrator/bin/test-lock.sh
[ -r "$KEY" ] || { echo "no over-the-air signing key for $ENV_NAME at $KEY — see BUILDING.md" >&2; exit 1; }
[ -r "$CERT" ] || { echo "no certificate at $CERT — see BUILDING.md" >&2; exit 1; }
[ -r "$FEED" ] || { echo "no build has been published for $ENV_NAME yet ($FEED)" >&2; exit 1; }
[ -z "$(git -C "$APP_DIR" status --porcelain -- . ../../packages/contracts)" ] \
  || { echo "REFUSED: uncommitted changes — what reaches the phones must be a commit" >&2; exit 1; }

# The Firebase client file is part of the native side, so it is here exactly as it is in a build.
GOOGLE_SERVICES="${HMIS_GOOGLE_SERVICES:-/root/.config/hmis/firebase/google-services.json}"
HMIS_PUSH_IN_BUILD=0
rm -f "$APP_DIR/google-services.json"
if [ -r "$GOOGLE_SERVICES" ] && grep -q "\"$APP_ID\"" "$GOOGLE_SERVICES"; then
  install -m 0600 "$GOOGLE_SERVICES" "$APP_DIR/google-services.json"
  HMIS_PUSH_IN_BUILD=1
fi
trap 'rm -f "$APP_DIR/google-services.json"' EXIT

field() { node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(v===undefined?"":v)' "$FEED" "$1"; }
APK_RUNTIME="$(field runtimeVersion)"
VC="$(field versionCode)"
[ -n "$APK_RUNTIME" ] || { echo "REFUSED: the newest $ENV_NAME APK was built before over-the-air updates — build one first (scripts/build-apk.sh $ENV_NAME)" >&2; exit 3; }

cd "$APP_DIR"
export APP_ENV HMIS_PUSH_IN_BUILD HMIS_VERSION_CODE="$VC"
RESOLVED="$(npx expo-updates runtimeversion:resolve --platform android 2>/dev/null)"
RUNTIME="$(node -e 'console.log(JSON.parse(process.argv[1]).runtimeVersion)' "$RESOLVED")"
if [ "$RUNTIME" != "$APK_RUNTIME" ]; then
  echo "REFUSED: the native side changed since the newest $ENV_NAME APK (APK $APK_RUNTIME, this checkout $RUNTIME)." >&2
  echo "         This change needs a new APK: scripts/build-apk.sh $ENV_NAME" >&2
  exit 3
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -f "$APP_DIR/google-services.json"' EXIT
# Metro is a memory pool like jest's: it waits its turn (CLAUDE.md, "Verify").
"$LOCK" run mobile-ota nice -n 19 npx expo export --platform android --output-dir "$WORK/export" >/dev/null
npx expo config --type public --json > "$WORK/config.json"
URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).updates.url.replace(/\/manifest$/,""))' "$WORK/config.json")"
node scripts/ota-manifest.js "$WORK/export" "$OUT_DIR/ota/$ENV_NAME/$RUNTIME" "$RUNTIME" "$URL/$RUNTIME/files" "$WORK/config.json" "$KEY" "$CERT"
echo "every $ENV_NAME phone whose APK has runtime $RUNTIME takes it the next time the app is opened"
