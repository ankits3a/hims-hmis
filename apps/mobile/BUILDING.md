# Building the staff Android app on this server

Owner ruling, 2026-10-05: **no Play Store and no App Store, ever.** The app is built here, signed
with our own key, and installed on staff phones from a download link. expo.dev's cloud builder is
not used (`eas.json` stays only as a record of the profiles).

## Build

```
apps/mobile/scripts/build-apk.sh staging      # → stagehmis.crkmch.com, app id com.crkmch.hmis.staging
apps/mobile/scripts/build-apk.sh production   # → hmis.crkmch.com,      app id com.crkmch.hmis
```

The APK lands in a folder per environment — staging in `/opt/hmis-context/mobile-apk/`, production
in `/opt/hmis-context/mobile-apk-prod/` — as `hmis-staff-<env>-<version>-vc<versionCode>-<sha>.apk`,
with a `.sha256` beside it, and `hmis-staff-<env>-latest.apk` is re-pointed at it once its signature
verifies. A production build also re-points `hmis-staff-latest.apk`, the short link staff are given.
The two app ids install side by side on one phone.

## Where each build is served

| build | link | who can open it |
|---|---|---|
| staging | `https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.apk` | behind the staging password |
| production | `https://hmis.crkmch.com/app/hmis-staff-latest.apk` | anyone who has the link (owner 2026-10-06) |

Production has **no password, deliberately**: an APK holds no secret (only the site's address),
nothing in it works without a staff login, and a phone's installer cannot answer a password prompt.
The link is unlisted — no screen links to it — and nothing is browsable: production's Caddyfile
serves only files named `hmis-staff-…` ending `.apk`, `.json` or `.png` from that folder, and every
other `/app/` path is a 404 (`apps/core/test/caddyfile-hardening.test.ts` pins this). What that
leaves open: somebody who learns the link can download the app and read its code. The owner shares
the link with staff himself; nothing sends it automatically.

The folder is a read-only mount in `docker-compose.prod.yml`. A new build needs no deploy: the
script writes into the folder and the next request serves it.

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

**If a keystore is lost, every phone must uninstall the app before it can take an update.** Never
commit the folder, and never paste it into chat.

### The backup (DECIDED 2026-10-06)

`/opt/hmis-context/mobile-tools/backup-signing-keys.sh --offsite` (outside the repo) does all of it:

1. packs both keystores, both env files and the counters into one archive, encrypted with AES-256
   (`gpg --symmetric`) → `/opt/hmis-context/backups/hmis-android-signing-keys-<time>.tar.gpg`;
2. **proves it restores**: decrypts into a temp folder and compares every file's checksum;
3. copies the archive **off this server**, to the bucket the database's own backups already go to
   (the pgBackRest repository on Cloudflare R2), under its own prefix `hmis-android-keys/`, and
   reads it back to compare.

The passphrase is made once and kept in `/root/.config/hmis/android/BACKUP-PASSPHRASE.txt` (mode
600). It is the one thing that must ALSO exist away from this server: the owner reads it once, writes
it on paper, and keeps the paper with the hospital's other keys. The archive without the passphrase
is noise; a passphrase that lives only on the server that died is no backup.

Run the script again after a keystore or env file changes (it does not need running after an
ordinary build — a lost counter is rebuilt from the APK file names).

To restore on a new server:
`gpg -d hmis-android-signing-keys-<time>.tar.gpg | tar -C /root/.config/hmis/android -xf -`
(gpg asks for the passphrase), then `chmod 700` the folder and `chmod 600` its files.

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

## The update check (no app store)

After a verified build the script writes `hmis-staff-<env>-latest.json` beside the APK:

```json
{ "versionCode": 5, "versionName": "0.4.0", "apk": "hmis-staff-staging-0.4.0-vc5-<sha>.apk", "sha256": "…", "builtAt": "…", "notes": "…" }
```

The installed app reads it when the home screen opens, and from "Check for update" at the foot of that screen
(`src/update.ts`). A higher `versionCode` shows "Update available" with the notes and opens the APK in the browser;
Android installs it over the old build because the signing key is the same. Give the prompt its one line with
`HMIS_RELEASE_NOTES="Doctor's OPD line; new icon" apps/mobile/scripts/build-apk.sh staging`.

On staging, Caddy serves exactly `/app/hmis-staff-*-latest.json` without the basic-auth prompt (an app cannot answer
one); the APK and the folder listing stay behind it. Production serves its feed at
`https://hmis.crkmch.com/app/hmis-staff-production-latest.json`, with `Cache-Control: no-store`.

## Notifications (plan M6b)

Notifications go through Firebase Cloud Messaging. Two files, both the owner's, both on this server only:

| File | What it is | Who reads it |
|---|---|---|
| `/root/.config/hmis/firebase/google-services.json` | Firebase's CLIENT config. Not a secret (it is inside every APK), but kept out of this public repo. | `scripts/build-apk.sh`, at build time |
| `/root/.config/hmis/firebase/service-account.json` | The SERVER's key. **Secret.** | `docker/prod/deploy.sh` step 2 copies it to `$DEPLOY_DIR/firebase/` for the api and the worker |

Folder mode 0700, files 0600. Never commit either; never paste their contents anywhere.

### How the owner makes them (once)

1. Open <https://console.firebase.google.com> signed in with the hospital's Google account → **Add project** → name it
   (e.g. `CRKMCH HMIS`) → turn **Google Analytics OFF** → **Create project**.
2. On the project page click the **Android** icon ("Add app"). Package name `com.crkmch.hmis` → **Register app** →
   skip the download and the remaining steps (**Next** → **Next** → **Continue to console**).
3. **Add app** → Android again. Package name `com.crkmch.hmis.staging` → **Register app** → this time
   **Download google-services.json** (downloaded after BOTH apps exist, the one file covers both). No SHA
   certificate fingerprint is needed for notifications.
4. Gear icon → **Project settings** → **Service accounts** → **Generate new private key** → **Generate key**. A second
   JSON file downloads. This one is the secret.
5. Gear icon → **Project settings** → **Cloud Messaging**: "Firebase Cloud Messaging API (V1)" must say **Enabled**
   (it is by default on a new project).
6. Put both files on this server without pasting them into a chat: upload them (e.g. `scp` to `/root/`), then
   ```
   install -d -m 700 /root/.config/hmis/firebase
   install -m 600 /root/<downloaded google-services file>.json /root/.config/hmis/firebase/google-services.json
   install -m 600 /root/<downloaded key file>.json            /root/.config/hmis/firebase/service-account.json
   rm /root/<both downloaded files>
   ```

### Check, then switch on

```
apps/mobile/scripts/enable-push.sh --check      # both files there, right shape, same project, both app ids
apps/mobile/scripts/enable-push.sh --validate   # the same, then a DRY RUN against Firebase (validate_only: nothing is sent)
```

The script prints the project id and the app ids, never a key. It changes nothing. Then:

1. `apps/mobile/scripts/build-apk.sh staging` and `… production` — each says `notifications: IN this build` when the
   file names its app id (a build made without the file is the same app with notifications dormant).
2. The next deploy copies the key for the api and the worker (step 2 prints `firebase key installed …`). They look for
   the file once a minute, so no restart is needed; the worker's boot line reads `phone notifications: ON`.
3. On a phone: install the new build → sign in → **Turn on notifications** → allow. In `/admin/users` → **Phones** the
   phone reads "Notifications on" → **Send test notification**.

Replacing the key (rotation, or a leaked one): generate a new key in the console, overwrite `service-account.json`,
run `--validate`, deploy; then delete the old key in the console (**Service accounts → Manage service account
permissions → Keys**). Re-run `/opt/hmis-context/mobile-tools/backup-signing-keys.sh` is NOT needed — the Firebase
key is replaceable, the signing keys are not.

### What a notification contains

`HMIS`, one fixed sentence ("Something needs you. Open HMIS to see it."), a category and the name of a screen. Never a
patient's name, number or result (`apps/core/src/kernel/push/phone-push.ts`). The production build also blocks
screenshots, screen recording and the recent-apps preview (`src/privacy.ts`); the staging build does not.

## The microphone and the spoken note (decisions 0048, 0049)

The doctor's consult screen can record a note of up to 60 seconds (`expo-audio`, 16 kHz mono AAC at
32 kbit/s, about 240 kB a minute). The clip goes to the hospital's API as base64 JSON
(`POST /api/opd/visits/:id/consult/voice`), which forwards it to OpenAI and stores nothing.

- `app.config.ts` carries the `expo-audio` plugin with the microphone permission text and no
  background recording. `scripts/build-apk.sh` refuses an APK that lacks
  `android.permission.RECORD_AUDIO`.
- The OpenAI key is NOT in the app. It is a file on the server:
  `/root/.config/hmis/openai/key.txt` on the build host is carried to the production host by
  `tools/auto-deploy.sh` and mounted read-only into the API container (`HMIS_OPENAI_KEY_FILE`).
  Without it the screen says "Voice is not set up" and offers no microphone; nothing else changes.
- Voice and suggestions are switched in the web: OPD masters → Phone consult. No app update.
- The web export has no real microphone. Walk the screens with
  `/opt/hmis-context/mobile-tools/serve-consult.mjs` + `shoot-consult.mjs` (Chromium's fake audio
  device); the recording itself must be tried on a real phone.

## Fonts and the icon

IBM Plex Sans and Mono are bundled per weight (`src/fonts.ts`); every screen imports `Text` and `TextInput` from
`src/text.tsx`, not from `react-native`, or its text is drawn in the system face. The icon, adaptive icon and splash
are the CRK crest, rendered from `docs/design/2026-08-29-opd-counter-flow-v2/crk-logo.png`.
