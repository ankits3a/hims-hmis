#!/usr/bin/env bash
# Build a signed, sideloadable Android APK of the staff app ON THIS SERVER — no expo.dev cloud
# (owner 2026-10-05: no Play Store / App Store, ever). See BUILDING.md.
#
#   apps/mobile/scripts/build-apk.sh staging      # talks to stagehmis.crkmch.com, id com.crkmch.hmis.staging
#   apps/mobile/scripts/build-apk.sh production   # talks to hmis.crkmch.com,      id com.crkmch.hmis
#
# Production runs on this same box, so the build is capped (3 GB heap, 2 workers, no daemon), runs
# at the lowest CPU/IO priority, and holds the test lock so it never overlaps a jest/vitest pool.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging) APP_ENV=preview ;;
  production) APP_ENV=production ;;
  *) echo "usage: $0 <staging|production>" >&2; exit 2 ;;
esac

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEY_DIR=/root/.config/hmis/android
# One folder per environment, because each is mounted into a different caddy: staging's at
# stagehmis.crkmch.com/app/ (behind its password), production's at hmis.crkmch.com/app/ (unlisted,
# no password — docker/prod/Caddyfile). A staging build must never be served to the hospital.
case "$ENV_NAME" in
  production) OUT_DIR=/opt/hmis-context/mobile-apk-prod ;;
  *) OUT_DIR=/opt/hmis-context/mobile-apk ;;
esac
LOCK=/opt/hmis-lanes/.orchestrator/bin/test-lock.sh
export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

ENV_FILE="$KEY_DIR/hmis-$ENV_NAME.env"
[ -r "$ENV_FILE" ] || { echo "no signing key for $ENV_NAME at $ENV_FILE — see BUILDING.md" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"   # HMIS_KEYSTORE, HMIS_KEY_ALIAS, HMIS_STORE_PASSWORD, HMIS_KEY_PASSWORD — never echoed

# versionCode only ever goes up, per app id, or a phone refuses the update.
COUNTER="$KEY_DIR/versioncode-$ENV_NAME"
VC=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
VERSION=$(cd "$APP_DIR" && APP_ENV=$APP_ENV npx expo config --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))')
SHA=$(git -C "$APP_DIR" rev-parse --short=8 HEAD)
DIRTY=$(git -C "$APP_DIR" status --porcelain -- . | grep -q . && echo "-dirty" || true)
NAME="hmis-staff-$ENV_NAME-$VERSION-vc$VC-$SHA$DIRTY.apk"

# NOTIFICATIONS (plan M6b). A build carries Firebase only when the owner's `google-services.json` is
# on this host AND names the app id being built — Gradle's google-services plugin fails the whole
# build on a file that does not ("No matching client found"), so that is checked here, by name,
# before anything is built. Without it the same app is built with notifications dormant. The file
# is copied beside app.config.ts (git-ignored) because Expo wants a path inside the project; it is
# Firebase's CLIENT config and holds no secret — the server's key is a different file (BUILDING.md).
GOOGLE_SERVICES="${HMIS_GOOGLE_SERVICES:-/root/.config/hmis/firebase/google-services.json}"
case "$ENV_NAME" in production) APP_ID=com.crkmch.hmis ;; *) APP_ID=com.crkmch.hmis.staging ;; esac
HMIS_PUSH_IN_BUILD=0
rm -f "$APP_DIR/google-services.json"
if [ -r "$GOOGLE_SERVICES" ]; then
  if node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const ids = (j.client || []).map((c) => c && c.client_info && c.client_info.android_client_info && c.client_info.android_client_info.package_name);
      process.exit(ids.includes(process.argv[2]) ? 0 : 1);
    ' "$GOOGLE_SERVICES" "$APP_ID" 2>/dev/null; then
    install -m 0600 "$GOOGLE_SERVICES" "$APP_DIR/google-services.json"
    HMIS_PUSH_IN_BUILD=1
    echo "notifications: IN this build ($APP_ID is in google-services.json)"
  else
    echo "notifications: NOT in this build — $GOOGLE_SERVICES does not name $APP_ID (BUILDING.md, Notifications)" >&2
  fi
else
  echo "notifications: NOT in this build — no $GOOGLE_SERVICES yet (BUILDING.md, Notifications)"
fi

build() {
  cd "$APP_DIR"
  APP_ENV=$APP_ENV HMIS_VERSION_CODE=$VC HMIS_PUSH_IN_BUILD=$HMIS_PUSH_IN_BUILD CI=1 npx expo prebuild --platform android --clean --no-install
  # Signing reaches Gradle through the generated (git-ignored) android/gradle.properties, mode 600,
  # removed after the build — never on a command line, where `ps` would show it.
  local props=android/gradle.properties
  chmod 600 "$props"
  {
    echo   # the generated file ends without a newline; without this the next line glues onto its last property
    echo "org.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m"
    echo "org.gradle.daemon=false"
    echo "org.gradle.workers.max=2"
    echo "reactNativeArchitectures=armeabi-v7a,arm64-v8a"   # real phones only; drops the emulator ABIs (~half the APK)
    echo "android.injected.signing.store.file=$HMIS_KEYSTORE"
    echo "android.injected.signing.store.password=$HMIS_STORE_PASSWORD"
    echo "android.injected.signing.key.alias=$HMIS_KEY_ALIAS"
    echo "android.injected.signing.key.password=$HMIS_KEY_PASSWORD"
  } >> "$props"
  trap 'sed -i "/^android.injected.signing/d" "$APP_DIR/android/gradle.properties" 2>/dev/null || true' EXIT
  (cd android && APP_ENV=$APP_ENV HMIS_VERSION_CODE=$VC HMIS_PUSH_IN_BUILD=$HMIS_PUSH_IN_BUILD nice -n 19 ionice -c3 ./gradlew assembleRelease --no-daemon --max-workers=2)
}

export -f build
export APP_DIR APP_ENV VC HMIS_PUSH_IN_BUILD HMIS_KEYSTORE HMIS_KEY_ALIAS HMIS_STORE_PASSWORD HMIS_KEY_PASSWORD
"$LOCK" run mobile-apk bash -c build

BUILT="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
# A BUILD THAT SAYS IT CARRIES NOTIFICATIONS MUST BE ABLE TO SHOW ONE (owner's phone, 2026-10-06).
# Checked on the finished APK, before it is copied anywhere a phone can fetch it: the Android 13+
# permission (without it the system prompt can never appear), Firebase's messaging service (without
# it nothing is delivered), and Firebase's app id (without it no address is ever issued).
if [ "$HMIS_PUSH_IN_BUILD" = 1 ]; then
  AAPT="$ANDROID_HOME/build-tools/36.0.0/aapt"
  # Each dump is read into a variable FIRST: under `pipefail`, `aapt … | grep -q` fails on a MATCH
  # (grep leaves at the first hit, aapt dies of SIGPIPE) — which refused a perfectly good build.
  PERMS="$("$AAPT" dump permissions "$BUILT")"
  MANIFEST="$("$AAPT" dump xmltree "$BUILT" AndroidManifest.xml)"
  RESOURCES="$("$AAPT" dump resources "$BUILT")"
  grep -q "android.permission.POST_NOTIFICATIONS" <<<"$PERMS" \
    || { echo "REFUSED: the APK does not declare android.permission.POST_NOTIFICATIONS" >&2; exit 1; }
  grep -q "com.google.firebase.MESSAGING_EVENT" <<<"$MANIFEST" \
    || { echo "REFUSED: the APK has no Firebase messaging service" >&2; exit 1; }
  grep -q "google_app_id" <<<"$RESOURCES" \
    || { echo "REFUSED: the APK carries no Firebase app id (google-services.json was not applied)" >&2; exit 1; }
  echo "notifications: permission, messaging service and Firebase app id are in the APK"
fi
# THE DOCTOR'S SPOKEN NOTE NEEDS THE MICROPHONE (phone consult, decision 0048). Checked on every
# build, with or without notifications: an APK without RECORD_AUDIO can never ask for the microphone,
# and the consult screen's "Speak instead" would refuse for ever with nothing on screen saying why.
VOICE_PERMS="$("$ANDROID_HOME/build-tools/36.0.0/aapt" dump permissions "$BUILT")"
grep -q "android.permission.RECORD_AUDIO" <<<"$VOICE_PERMS" \
  || { echo "REFUSED: the APK does not declare android.permission.RECORD_AUDIO (the expo-audio plugin was not applied)" >&2; exit 1; }
echo "voice: the microphone permission is in the APK"
mkdir -p "$OUT_DIR"
cp "$BUILT" "$OUT_DIR/$NAME"
echo "$VC" > "$COUNTER"
(cd "$OUT_DIR" && sha256sum "$NAME" > "$NAME.sha256")
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$OUT_DIR/$NAME"
# The download link staff phones use always names the newest VERIFIED build of this app id.
ln -sfn "$NAME" "$OUT_DIR/hmis-staff-$ENV_NAME-latest.apk"
# The link the owner hands to staff: short, and it never changes between builds.
[ "$ENV_NAME" != production ] || ln -sfn "$NAME" "$OUT_DIR/hmis-staff-latest.apk"
# What the app reads on start-up to offer an update (src/update.ts): written LAST, and through a
# rename, so a phone never reads of a build whose APK is not yet in place. `HMIS_RELEASE_NOTES` is
# the one line the update prompt shows ("Doctor's OPD line; new icon").
SUM=$(cut -d' ' -f1 "$OUT_DIR/$NAME.sha256")
HMIS_PUSH_IN_BUILD=$HMIS_PUSH_IN_BUILD HMIS_RELEASE_NOTES="${HMIS_RELEASE_NOTES:-}" node -e '
  const [vc, version, apk, sha256, out] = process.argv.slice(1);
  const body = { versionCode: Number(vc), versionName: version, apk, sha256, builtAt: new Date().toISOString(), notes: process.env.HMIS_RELEASE_NOTES || "", notifications: process.env.HMIS_PUSH_IN_BUILD === "1" };
  require("fs").writeFileSync(out + ".tmp", JSON.stringify(body, null, 2) + "\n");
  require("fs").renameSync(out + ".tmp", out);
' "$VC" "$VERSION" "$NAME" "$SUM" "$OUT_DIR/hmis-staff-$ENV_NAME-latest.json"
echo "built $OUT_DIR/$NAME (versionCode $VC)"
