# Building the staff Android app on this server

Owner ruling, 2026-10-05: **no Play Store and no App Store, ever.** The app is built here, signed
with our own key, and installed on staff phones from a download link. expo.dev's cloud builder is
not used (`eas.json` stays only as a record of the profiles).

## Build

```
apps/mobile/scripts/build-apk.sh staging      # → stagehmis.crkmch.com, app id com.crkmch.hmis.staging
apps/mobile/scripts/build-apk.sh production   # → hmis.crkmch.com,      app id com.crkmch.hmis
```

The APK lands in `/opt/hmis-context/mobile-apk/` as
`hmis-staff-<env>-<version>-vc<versionCode>-<sha>.apk`, with a `.sha256` beside it. The two app ids
install side by side on one phone.

What the script does:
1. `expo prebuild --platform android --clean` generates `android/` (git-ignored, regenerated every build).
2. Signing settings are appended to the generated `android/gradle.properties` (mode 600) and removed
   after the build. Passwords never appear on a command line.
3. `./gradlew assembleRelease`: 3 GB heap, 2 workers, no daemon, `nice -n 19 ionice -c3`, inside the
   test lock. Production runs on this same box, and the build must never overlap a jest/vitest pool.

## versionCode

A phone installs an update only when its `versionCode` is **higher** than the one installed. The
script keeps a counter per app id in `/root/.config/hmis/android/versioncode-<env>` and adds 1 on
every successful build. Never lower or delete it. If it is lost, set it above the last number shown
in the APK file names.

## Signing keys: back them up

`/root/.config/hmis/android/` (mode 700) holds:
- one keystore per app id, `hmis-staging.jks` and `hmis-production.jks`;
- each keystore's passwords, in `hmis-<env>.env` (mode 600);
- the versionCode counters.

**If a keystore is lost, every phone must uninstall the app before it can take an update.** Copy the
whole folder somewhere safe and offline, such as an encrypted USB drive. Never commit it, and never
paste it into chat.

## Toolchain (installed outside the repo)

- **JDK:** `openjdk-17-jdk-headless` (apt), at `/usr/lib/jvm/java-17-openjdk-amd64`.
- **Android SDK:** `/opt/android-sdk`, holding:
  - `cmdline-tools/latest` (sdkmanager 19.0)
  - `platform-tools`
  - `platforms;android-36`
  - `build-tools;36.0.0`
  - `ndk;27.1.12297006`
  - `cmake;3.22.1`

  These are the versions in `react-native/gradle/libs.versions.toml` for RN 0.86. When an Expo SDK
  upgrade moves them, install the new ones with
  `/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager "<package>"`.

## Distribution

Staging serves the APK folder at **https://stagehmis.crkmch.com/app/**, behind the staging basic
auth (`docker/prod/Caddyfile.uat` + a read-only mount in `docker-compose.uat.yml`).

To install on a phone, open the link in Chrome and tap the APK. When Android asks, allow
"Install unknown apps" for Chrome, then tap Install.

## Later (not built yet)

The app should check for a newer APK on start-up, for example from a small `latest.json` beside the
APKs, and offer the download. Without that check, staff learn about updates by word of mouth.
