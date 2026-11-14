# Building the staff app

The app is named **CRKMCH** ("CRKMCH Staging" for staging) on the phone and on both stores (owner
2026-11-14, decision 0095). HMIS stays the name of the hospital system it signs in to; the app ids
(`com.crkmch.hmis`, `com.crkmch.hmis.staging`) never change.

**Android** is built on this server, signed with our own key, and reaches phones two ways: the
download link (since 2026-10-05) and **Google Play** (owner 2026-11-14, decision 0095 — see "Google
Play"). Both are ONE app: same id, same key, same versionCode counter. expo.dev's cloud builder is not
used for Android. Everything below, up to "iPhone (EAS)", is about Android.

**iPhone** (owner, 2026-10-08: about 100 iPhone users; Organisation Apple account; keep it unlisted;
use EAS): an iPhone cannot install an app from a download link, so the iPhone app is built by EAS
(expo.dev's Mac in the cloud) and given out through the App Store as an **Unlisted** app. See
"iPhone (EAS)" at the foot of this file. `eas.json` holds the profiles EAS reads; its Android lines
are a record only.

## Build

```
apps/mobile/scripts/build-apk.sh staging            # → stagehmis.crkmch.com, app id com.crkmch.hmis.staging
apps/mobile/scripts/build-apk.sh production         # → hmis.crkmch.com,      app id com.crkmch.hmis
apps/mobile/scripts/build-apk.sh production --play  # the same app as a Google Play bundle (.aab) — see "Google Play"
```

The APK lands in a folder per environment — staging in `/opt/hmis-context/mobile-apk/`, production
in `/opt/hmis-context/mobile-apk-prod/` — as `hmis-staff-<env>-<version>-vc<versionCode>-<sha>.apk`,
with a `.sha256` beside it, and `hmis-staff-<env>-latest.apk` is re-pointed at it once its signature
verifies. A production build also re-points `hmis-staff-latest.apk`, the short link staff are given.
The two app ids install side by side on one phone.

## Where each build is served

| build | link | who can open it |
|---|---|---|
| staging | `https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.apk` | anyone who has the link (owner 2026-11-02) |
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

## The update check (phones that have the app from the download link)

A phone that **Google Play** installed never reads this feed and draws no "Check for update" row: Play
bans an app from updating itself any other way, and Play updates it (spec #1058). The app asks Android
which app installed it (`src/install-source.ts`, native module `modules/install-source`); an older build
without the module, or an answer it cannot read, counts as "not Play", so those phones keep the prompt.

After a verified build the script writes `hmis-staff-<env>-latest.json` beside the APK:

```json
{ "versionCode": 5, "versionName": "0.4.0", "apk": "hmis-staff-staging-0.4.0-vc5-<sha>.apk", "sha256": "…", "builtAt": "…", "notes": "…" }
```

The installed app reads it when the home screen opens, and from "Check for update" at the foot of that screen
(`src/update.ts`). A higher `versionCode` shows "Update available" with the notes and opens the APK in the browser;
Android installs it over the old build because the signing key is the same. Give the prompt its one line with
`HMIS_RELEASE_NOTES="Doctor's OPD line; new icon" apps/mobile/scripts/build-apk.sh staging`.

Production serves its feed at
`https://hmis.crkmch.com/app/hmis-staff-production-latest.json`, with `Cache-Control: no-store`.

## Over-the-air updates (owner 2026-10-06: "it should happen automatically")

Two kinds of change, two roads:

| The change | How it reaches a phone | What the person does |
|---|---|---|
| JavaScript — screens, words, rules, fixes | `scripts/publish-ota.sh <env>` → the app fetches it by itself | nothing |
| Native — a new native module, a permission, an Expo upgrade, the Firebase file | `scripts/build-apk.sh <env>` → "Update available" in the app | downloads and installs the APK |

```
apps/mobile/scripts/publish-ota.sh staging
apps/mobile/scripts/publish-ota.sh production
```

**Which road a change needs is not a judgement.** Every APK carries its native fingerprint
(`runtimeVersion: { policy: "fingerprint" }`, `fingerprint.config.js`), and `build-apk.sh` writes it
into the feed as `runtimeVersion`. `publish-ota.sh` computes the fingerprint of the checkout and
refuses, by name, when it is not the newest APK's: that change needs an APK. The version name and
the versionCode are not in the fingerprint, so an ordinary rebuild does not strand a bundle.

Both scripts run `npm ci` first: the fingerprint reads `node_modules`, and only the lockfile's own
tree gives the same value twice. Staging versionCode 11 was built on a tree that had grown by hand
and carries `277de723…`, which no clean checkout computes; `ota/runtime-aliases.json` records it as
the clean `da9b26a5…` so that one APK can still be updated. The record stops matching by itself when
the native side changes; delete the entry once a newer staging APK is out.

Production versionCode 26 has one too: Apple's motion sentence (`app.config.ts`) is an iPhone-only line, but
its plugin setting moves Android's fingerprint from `3e5f6f90…` to `a3e9dd59…` with no Android native change.

**What is served** (no expo.dev cloud; the same folder and the same caddy as the APKs):

```
<folder>/ota/<env>/<fingerprint>/manifest          one multipart body: the manifest and its signature
<folder>/ota/<env>/<fingerprint>/files/<sha256>.*  the bundle and every asset, named by checksum
```

The app asks `…/app/ota/<env>/manifest` with its fingerprint in the `expo-runtime-version` header;
caddy picks the folder (`@ota_manifest` in `docker/prod/Caddyfile` and `Caddyfile.uat`, pinned by
`apps/core/test/caddyfile-hardening.test.ts`). A phone whose fingerprint has no folder gets a 404 and
keeps running what it has.

**When the phone takes it** (`src/ota.ts`): fetched at every cold start and, while the app stays
open, at most every fifteen minutes from the home screen. It is applied on the home screen only —
never on a seat, where a restart would lose a half-typed entry. "Check for update" at the foot of
the home screen fetches and applies at once. The foot then reads "Updated automatically · <time>".
A bundle that crashes on start is abandoned by expo-updates, which goes back to the last one that ran.

**Signing.** A phone runs a bundle only when it is signed by the key whose public certificate is in
its APK (`ota/certificate-<env>.pem`, committed). The private halves live beside the APK keystores,
never in the repo:

```
/root/.config/hmis/android/ota-staging-private-key.pem
/root/.config/hmis/android/ota-production-private-key.pem
```

Made once per environment:

```
npx expo-updates codesigning:generate --key-output-directory <tmp>/k --certificate-output-directory <tmp>/c \
  --certificate-validity-duration-years 20 --certificate-common-name "CRKMCH HMIS staff app OTA (<env>)"
```

then `private-key.pem` → the path above (mode 600) and `certificate.pem` → `ota/certificate-<env>.pem`.
An APK built while the certificate is absent carries no over-the-air updates at all (the build says
so). Losing a private key costs one APK round — a new pair, a new build — not an uninstall. Add the
two files to the signing-key backup (`backup-signing-keys.sh`).

**Two hosts (production on its own server since 2026-10-07).** `publish-ota.sh production` writes
`/opt/hmis-context/mobile-apk-prod/ota/production/<fingerprint>/` on the BUILD host, beside the APKs.
`tools/auto-deploy.sh` (cron, every ten minutes) rsyncs that whole folder to the production host's
same path, which production's caddy mounts read-only at `/downloads`; the phones read
`https://hmis.crkmch.com/app/ota/production/manifest`. So a published bundle reaches phones within
about ten minutes, with no deploy. Staging (`/opt/hmis-context/mobile-apk/ota/staging/…`) is served
from this host directly.

**The first time.** A phone takes bundles only once it runs an APK that carries the update client
and the certificate. Every phone needs that one APK, through the ordinary update prompt; after it,
a JavaScript change needs only `publish-ota.sh`.

### Over-the-air updates on iPhone

An iPhone takes bundles the same way, from a build made after #830. Android and iPhone are separate
bundles, because each has its own native fingerprint.

1. Build and submit as under "iPhone (EAS)". Open the build on expo.dev and copy its **Runtime version**.
2. Record it on this server, once per iPhone build:
   `echo '{"runtimeVersion":"<40 hex>","versionCode":0}' > /opt/hmis-context/mobile-apk-prod/hmis-staff-production-ios-runtime.json`
3. Publish: `apps/mobile/scripts/publish-ota.sh production ios`. It refuses when this checkout's iPhone
   fingerprint is not the recorded one, as it does for an APK.

An update may change screens, words and rules. It may not change what the app is for: that goes through
Apple's review.

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

## Google Play (owner 2026-11-14, decision 0095)

The Android app is also on Google Play, as a **public listing that needs a hospital sign-in** (Play has no
Unlisted option). It is the same app as the APK: a phone that has the APK updates from Play in place.

### Once: the account, the app, the keys

1. **Play Console account** (owner): <https://play.google.com/console/signup>, type **Organisation**, the same
   organisation as the Apple team (it reuses that D-U-N-S number), US$25 once. Google verifies the
   organisation; that can take days.
2. **Create the app**: name **CRKMCH**, default language English (India), App, Free.
3. **App signing — choose our existing key BEFORE the first upload.** Play Console → the app → Test and release →
   App integrity → App signing → "Use a different key" → "Export and upload a key from Java keystore". Play
   shows a `pepk` command and its encryption key; run it on this server against `hmis-production.jks` (alias
   and passwords in `/root/.config/hmis/android/hmis-production.env`) and upload the zip it writes. If Play
   makes its own key instead, Play phones and APK phones become two different apps and every APK phone has
   to uninstall to move to Play.
4. **The upload key** (signs the bundle we send; Play re-signs with ours):
   ```
   cd /root/.config/hmis/android
   keytool -genkeypair -v -keystore hmis-production-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   keytool -export -rfc -keystore hmis-production-upload.jks -alias upload -file upload-certificate.pem
   ```
   Write `hmis-production-upload.env` (mode 600) the way `hmis-production.env` is written: `HMIS_KEYSTORE`,
   `HMIS_KEY_ALIAS=upload`, `HMIS_STORE_PASSWORD`, `HMIS_KEY_PASSWORD`. Give Play `upload-certificate.pem` when
   it asks. Back the upload key up with the others ("Signing keys: back them up"); a lost upload key can be
   reset through Play support, a lost production key cannot.

### Every release

1. Build from a lane detached at the merge commit: `apps/mobile/scripts/build-apk.sh production --play`.
   It writes `/opt/hmis-context/mobile-aab-prod/hmis-staff-production-<version>-vc<N>-<sha>.aab` (mode 700
   folder, served by nothing). Before it keeps the bundle it refuses: no microphone permission, a wrong
   fingerprint, and everything `scripts/play-checks.js` refuses — installing other apps, background location,
   photo-library or shared-storage reads, all-files or all-apps access, a target SDK below 35, and a 64-bit
   native library not aligned to 16 KB.
2. Play Console → Test and release → **Internal testing** → Create release → upload the `.aab`. Install it on one
   phone from the testers' link and sign in. Then **Promote release → Production**.
3. The APK for the download link is built separately (`build-apk.sh production`); both take the next number
   from the same counter, so the counter only goes up.

### The forms Play asks for (App content)

| Form | Answer |
|---|---|
| Privacy policy | `https://hmis.crkmch.com/privacy.html` (also Settings → Privacy policy in the app) |
| App access | All functionality needs a sign-in → add the reviewer account ("Store review" below) |
| Ads | No ads |
| Content rating | Category: utility / productivity; every question "No" |
| Target audience | 18 and over only; not designed for children |
| Health apps | It is a health app: hospital staff use it to record and read patients' care in the hospital's records |
| Data safety — collected | Name and user ID (sign-in); device ID (made up at install, to sign a lost phone out); precise location (once, at Mark attendance; coordinates not stored — "processed ephemerally"); photos (slips, taken in the app); audio (a doctor's spoken note, up to 60 s, not stored); health info (patients' clinical details staff enter); app interactions (the audit trail) |
| Data safety — every item | Collected, not shared (the speech and AI services work on the hospital's behalf), for app functionality, required to use that feature, encrypted in transit |
| Data deletion | Accounts belong to the hospital; a person asks the hospital's IT office (as the privacy page says) |
| Government app, financial features, news | No |

**Store listing**: name CRKMCH; short description "Staff app of CRK Medical College & Hospital. Hospital
sign-in required."; the 512 px icon and a 1024 × 500 feature graphic; at least two phone screenshots.
Production blocks screenshots on Android, so take them on the **staging** app or an iPhone, with the DEMO
patients only.

## Store review (Apple and Google)

### The reviewer account (owner 2026-11-14)

One account on **production**, limited to a **DEMO** department with five made-up patients, switched off
between reviews. Its rows show in registers and the audit trail; the owner accepted that. An administrator
makes it in the web app, never in the repository:

1. Masters → departments: add **DEMO** ("Demo — store review"). No real doctor works in it.
2. Users: add one user for the reviewers, a doctor in DEMO only, with a password that is not "change at first
   sign-in" and works at any hour (reviewers are not in India).
3. On the day you send a version for review: at Desk One register **Demo Patient One … Five** into DEMO with
   no money taken. A visit belongs to its day, so a review that runs past that day may see an empty list:
   register the visits again and reply to the reviewer.
4. Type the user name and password only into App Store Connect (App Review Information → Sign-in required) and
   Play Console (App access). Never into the repository or a chat.
5. After the decision: switch the user off, and sign its phones out (Admin → Phones) — every reviewer's
   device counts towards the user's phone limit.

### What to write to the reviewer (both stores)

> CRKMCH is the internal staff app of CRK Medical College & Hospital, India. It is not for patients or the
> public: every screen needs an account the hospital issues. The demo account is a doctor in a demonstration
> department with five made-up patients. Location is read once, in the foreground, only when a staff member
> taps "Mark attendance". The microphone records a doctor's spoken note only when the doctor taps to record.
> The app cannot create accounts, so it has no account deletion. JavaScript updates change screens and wording
> only, never what the app is for. The publisher builds and runs this system for the hospital; the hospital's
> signed authorisation is attached.

### The authorisation letter

The app carries the hospital's name; the seller on both stores is the software organisation. Apple (rules 5.2.1
and 5.1.1(ix)) and Google (impersonation policy) ask for proof that the seller may publish under that name. The
owner signs a letter on the hospital's letterhead (the draft is outside this repository) and attaches the PDF:
App Store Connect → the version → App Review Information → Attachment; Google: the advance-notice form for
authorised use of another organisation's name, linked from Play's Impersonation policy help page.

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
| Updates | the app offers a new APK itself | the App Store updates native changes; JavaScript arrives over the air, as on Android |
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
   - The first time, it offers to create the app in App Store Connect. Name: **CRKMCH**. (The entry made
     before 2026-11-14 is called "HMIS Staff": App Store Connect → the app → App Information → Name →
     **CRKMCH**, while the version is still "Prepare for Submission".)
   - The build appears in App Store Connect → the app → TestFlight after Apple has processed it
     (10–30 minutes). Install it from TestFlight on one iPhone and sign in before going further.
5. Fill in App Store Connect (<https://appstoreconnect.apple.com> → Apps → CRKMCH):
   - **Name** CRKMCH. **Subtitle** CRK Medical College & Hospital staff. **Primary category** Medical. **Price** Free.
   - **Privacy Policy URL** — <https://hmis.crkmch.com/privacy.html>, the page Settings → Privacy policy opens
     (`apps/web/public/privacy.html`, #629). When the app starts collecting something new, that page is changed
     in the same pull request.
   - **App Review Information** — the reviewer account, the note and the authorisation letter: "Store review" above.
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

### The sign-in for Apple's reviewer — RULED 2026-11-14: see "Store review" above

The owner chose the first way below: a DEMO department on production, switched off between reviews.

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
   <https://developer.apple.com/contact/request/unlisted-app/> — choose CRKMCH and say it is for
   the hospital's own staff.
3. Apple answers by e-mail (usually a few days). App Store Connect → Pricing and Availability then
   shows the distribution method **Unlisted App** and a link.
4. Release the version. The app cannot be found by searching the App Store; staff install it from
   the link, which the owner shares himself, as with the Android link.

Every later version: steps 3, 4 and 6 again. It stays unlisted.

### Where the iPhone app stands

App Store Connect → Apps → CRKMCH:
- **TestFlight** tab: each uploaded build and whether Apple has processed it. A build Apple's automatic checks
  refuse never appears; Apple e-mails the reason to the account holder (build 4, `ITMS-90683`, 2026-11-02).
- **The version** (left column, under iOS App): "Prepare for Submission" (not sent), "Waiting for Review", "In
  Review", "Rejected" (the reason is in App Review → the message from Apple), "Pending Developer Release"
  (approved; ask for Unlisted, above).

### The staging app — TestFlight only (owner 2026-11-14)

**CRKMCH Staging** (`com.crkmch.hmis.staging`, talks to stagehmis) never goes to the App Store. It is a store
build that stays in TestFlight:

```
APP_ENV=preview npx eas-cli@latest build --platform ios --profile preview
APP_ENV=preview npx eas-cli@latest submit --platform ios --profile preview --latest
```

`submit.preview` in `eas.json` names the staging id only, so it can never land on the production app. The
first submit uses the App Store Connect entry made on 2026-10-08 for that id (called "HMIS Staging"; rename it
**CRKMCH Staging**). In TestFlight → Internal Testing, add the testers (App Store Connect users, up to 100); they
install it from Apple's TestFlight app. Internal testing needs no review — never press "Add for Review" on this
app. A TestFlight build stops working after 90 days: build again before then. For over-the-air updates, record
its runtime in `/opt/hmis-context/mobile-apk/hmis-staff-staging-ios-runtime.json` and run
`apps/mobile/scripts/publish-ota.sh staging ios`.

### What is in the configuration

- `app.config.ts`, `ios`: the two bundle identifiers (the same strings as Android's app ids),
  iPhone only (no iPad layout), and the three sentences iOS shows when the app first asks for the
  camera, the microphone and Face ID, plus `NSLocationWhenInUseUsageDescription` for "Mark
  attendance" (decision 0062) — "while using the app" only: no Always location, no background mode,
  no photo library (`__tests__/ios-config.test.ts` and `__tests__/location-config.test.ts` pin it).
- `withoutApplePush` in the same file removes the push entitlement, so the first build needs no
  Apple push key. Turning iPhone notifications on later is separate work: the server sends through
  Firebase only.
- `eas.json`: `production.ios` (App Store), `preview.ios` (TestFlight only, its own submit profile), Node 22.
- This server cannot build an iPhone app (that needs a Mac). `npx expo prebuild --platform ios`
  does run here and is how the configuration was checked — in a scratch copy; never commit `ios/`.
