# Building the staff app

**Android** (owner ruling, 2026-10-05: no Play Store): the app is built on this server, signed with
our own key, and installed on staff phones from a download link. expo.dev's cloud builder is not
used for Android. Everything below, up to "iPhone (EAS)", is about Android.

**iPhone** (owner, 2026-10-08: about 100 iPhone users; Organisation Apple account; keep it unlisted;
use EAS): an iPhone cannot install an app from a download link, so the iPhone app is built by EAS
(expo.dev's Mac in the cloud) and given out through the App Store as an **Unlisted** app. See
"iPhone (EAS)" at the foot of this file. `eas.json` holds the profiles EAS reads; its Android lines
are a record only.

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

## iPhone (EAS)

What the iPhone app is: the same screens and the same sign-in as the Android app, talking to the
same server. What differs in this first version:

| | Android | iPhone |
|---|---|---|
| Notifications | on, when the build carries Firebase | **off** — the Notifications screen says "Not set up in this app yet" and nothing is asked |
| Updates | the app offers a new APK itself | the App Store updates the app; the app has no "Check for update" |
| Screenshots (production) | blocked | not blocked; the app is hidden in the app switcher |
| The lock | fingerprint | Face ID or Touch ID |

### The steps, in order

1. **Open a terminal in this app's folder — never the repository's top folder.** Until the iPhone
   work is merged that is `/opt/hmis-lanes/ios-setup/hmis/apps/mobile`. Why: run from the top
   folder, `eas` does not find this app, writes a new `app.json` there with somebody else's app id,
   and that stray file stops the next production deploy (it happened on 2026-10-08).
2. Sign in to Expo: `npx eas-cli@latest login` — the Expo account's e-mail and password.
3. Build: `npx eas-cli@latest build --platform ios --profile production`
   - **"Do you want to log in to your Apple account?"** — Yes. EAS needs it once, to make the signing
     certificate. Type the Apple ID (the e-mail of the hospital's Organisation developer account)
     and its password.
   - **The 6-digit code** — Apple sends it to the iPhone or Mac already signed in with that Apple ID
     (or by SMS). It is Apple's second step of sign-in; type it in the terminal. EAS does not keep
     the password.
   - **Team** — choose the Organisation, not a personal team.
   - **"Generate a new Apple Distribution Certificate?"** and **"Generate a new Apple Provisioning
     Profile?"** — Yes to both. EAS keeps them and reuses them for every later build.
   - **If it asks to set up Push Notifications** — No. This version sends none to iPhones.
   - The bundle identifier it shows must be `com.crkmch.hmis`. If it shows anything else, stop: the
     command is running in the wrong folder.
   - The build runs on Expo's Mac (about 15–25 minutes). The terminal prints a link to watch it.
     EAS counts the build number itself; nothing in this folder needs editing between builds.
4. Send it to Apple: `APP_ENV=production npx eas-cli@latest submit --platform ios --latest`
   (without `APP_ENV=production` the command reads the staging app id — it did, on 2026-10-08)
   - It asks for the Apple ID again, and offers to make an App Store Connect API key — Yes.
   - The first time, it offers to create the app in App Store Connect. Name: **HMIS Staff**.
   - The build appears in App Store Connect → the app → TestFlight after Apple has processed it
     (10–30 minutes). Install it from TestFlight on one iPhone and sign in before going further.
5. Fill in App Store Connect (<https://appstoreconnect.apple.com> → Apps → HMIS Staff):
   - **Name** HMIS Staff. **Primary category** Medical. **Price** Free.
   - **Privacy Policy URL** — <https://crkmch.com/privacy-policy.html>. It has an HMIS Staff app
     section, its "Apple iOS App Store Disclosures" and the attendance-location paragraph
     (checked 2026-10-10). The page is not in this repository: when the app starts collecting
     something new, the page is changed first.
   - **App Privacy** — what the app really collects (read from the code), all "linked to the
     person", all for "App functionality", none used for tracking:
     - *User ID* — the staff member's sign-in name.
     - *Device ID* — an id the app makes up when installed, sent at sign-in with the phone's model
       and iOS version, so an administrator can see and sign out a lost phone. Not the phone's
       serial or advertising id.
     - *Photos* — photographs of prescription slips, taken in the app and sent to the hospital's
       server. The app never reads the phone's photo library.
     - *Audio data* — a doctor's spoken note, up to 60 seconds, sent to the hospital's server to be
       typed. The server passes the clip to a speech service (OpenAI) and keeps no copy; nothing
       stays on the phone.
     - *Health* — staff type and read patients' clinical details in the app. If Apple's form asks,
       this is health data handled by the app, for app functionality.
     - *Precise location* — read ONCE, while the app is open, when a staff member taps "Mark
       attendance" (decision 0062). The server keeps only "inside / outside premises" and the
       distance in metres from the campus centre — never the coordinates. Linked to the person,
       app functionality, not used for tracking. Never in the background.
     - **No tracking, no advertising, no analytics, no contacts.**
   - **Export compliance** is already answered inside the build (standard HTTPS only).
   - **App Review Information → Sign-in required** — see the next section.
   - **Version Release** — choose **"Manually release this version"**, so an approved app does not
     appear in the public App Store before Apple has made it unlisted.
6. Press **Add for Review**.

### The sign-in for Apple's reviewer — the owner's choice, not made here

Apple's reviewer must be able to sign in. The production build talks to production
(`hmis.crkmch.com`); a demo user on the staging server cannot sign in to it. Two honest ways:

- **A reviewer account on production, limited to a demo department.** Apple reviews exactly the
  build staff will use. Cost: a shared password and made-up patients live in the real hospital
  database (they show in registers, reports and the audit trail until cleaned up), and the account
  must be switched off after each review.
- **Submit a build that points at staging.** The reviewer sees test data only and production is
  untouched. Cost: the reviewed build is not the build staff use — a second build pointing at
  production has to be submitted and reviewed afterwards, and a reviewer may ask why — and it
  needs a small change here first (today only the staging app id talks to staging).

Either way: the account must work at any hour (reviewers are not in India), and the review notes
should say that this is a hospital's internal staff app, that every screen is behind sign-in, and
which role the demo account holds.

### Making it Unlisted (after the first approval)

1. Wait for the status **"Pending Developer Release"** (approved, not released — step 5 above).
2. Signed in as the Account Holder, fill in Apple's form:
   <https://developer.apple.com/contact/request/unlisted-app/> — choose HMIS Staff and say it is for
   the hospital's own staff.
3. Apple answers by e-mail (usually a few days). App Store Connect → Pricing and Availability then
   shows the distribution method **Unlisted App** and a link.
4. Release the version. The app cannot be found by searching the App Store; staff install it from
   the link, which the owner shares himself, as with the Android link.

Every later version: steps 3, 4 and 6 again. It stays unlisted.

### A test build for a few iPhones, without the App Store

`npx eas-cli@latest build --platform ios --profile preview` makes the **staging** app
(`com.crkmch.hmis.staging`, talks to stagehmis). Apple lets it run only on iPhones registered
beforehand with `npx eas-cli@latest device:create`, at most 100 a year — for trying a change, not
for giving the app to staff.

### What is in the configuration

- `app.config.ts`, `ios`: the two bundle identifiers (the same strings as Android's app ids),
  iPhone only (no iPad layout), and the three sentences iOS shows when the app first asks for the
  camera, the microphone and Face ID, plus `NSLocationWhenInUseUsageDescription` for "Mark
  attendance" (decision 0062) — "while using the app" only: no Always location, no background mode,
  no photo library (`__tests__/ios-config.test.ts` and `__tests__/location-config.test.ts` pin it).
- `withoutApplePush` in the same file removes the push entitlement, so the first build needs no
  Apple push key. Turning iPhone notifications on later is separate work: the server sends through
  Firebase only.
- `eas.json`: `production.ios` (App Store), `preview.ios` (registered iPhones), Node 22.
- This server cannot build an iPhone app (that needs a Mac). `npx expo prebuild --platform ios`
  does run here and is how the configuration was checked — in a scratch copy; never commit `ios/`.
