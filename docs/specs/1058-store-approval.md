---
issue: 1058
status: built
approved: 2026-11-14
---
# SPEC — The staff app on the App Store and Google Play, named CRKMCH (#1058) — APPROVED by owner 2026-11-14

Owner, 2026-11-14: the iPhone app goes through Apple as an Unlisted app (decision 0063). The Android app goes on
Google Play too ("we will have android app too"), as a public listing that needs a hospital sign-in. Both
reviewers get one account limited to a DEMO department with five made-up patients, switched off between reviews.
Both privacy promises in #948 stay. The app is named CRKMCH. The staging app stays in TestFlight and never goes
to the App Store.

1. **Privacy link first.** #948 (#629) is carried in this lane: Settings → Privacy policy →
   `https://hmis.crkmch.com/privacy.html`. App Store Connect and Play Console both name that page.
2. **A phone installed from Google Play never offers an APK** (Play bans self-update). The app asks Android which
   app installed it. If Google Play installed it, the app reads no feed, draws no "Check for update" row, and Play
   updates it, the way the iPhone works today. If the hospital link installed it, nothing changes. A small
   Android-only native module reads the installer, so the APK and the AAB are the same app with the same native
   fingerprint, and one OTA bundle serves both.
3. **One app, one key, one counter.** `build-apk.sh production --play` builds an AAB from the same tree as the
   APK, with the same app id and the same versionCode counter. DECIDED: Play App Signing holds our existing
   production key (uploaded encrypted), and a separate upload key signs the AAB. Phones with the sideloaded app
   then update from Play in place. The AAB goes to a private folder, never the public download folder.
4. **Checks before upload.** The build refuses an AAB that asks to install other apps, asks for background
   location or photo-library access, targets an SDK below 35, or has native libraries not aligned to 16 KB.
5. **Decision 0095** records Android on Google Play. The sideload link stays as a fallback.
6. **BUILDING.md** adds the Play Console steps, the Data safety and Health declaration answers, review notes for
   both stores, the reviewer-account recipe (DEMO department, five patients, role, switch off and sign out its
   phones after each review), the authorisation letter, and how to check App Store Connect.
7. **The owner then** makes a new iPhone build and sends it for review, and creates the Play Console account.
   DECIDED: same organisation seller as Apple (reuses its D-U-N-S number), US$25 once.
8. **The app is named CRKMCH.** The phone's home screen, both store listings, the iPhone permission prompts and
   the Android scan widget say "CRKMCH" ("CRKMCH Staging" on staging). App strings that send a person to the
   phone's own settings, notifications or unlock screen say CRKMCH, because that is the name the phone lists.
   DECIDED: "HMIS" stays as the name of the hospital system and its account ("Your HMIS password"). The app id
   stays `com.crkmch.hmis`, so installed phones update in place. The privacy page is titled "CRKMCH staff app".
   The owner renames the App Store Connect entry to CRKMCH. DECIDED: the server's notification sentences ("Open
   HMIS to see it") change only after the renamed builds are on the phones, so a phone still named HMIS never
   reads "Open CRKMCH"; until then the Settings line that quotes them keeps "open HMIS" (#1059).
9. **Staging stays in TestFlight** (owner 2026-11-14). The `preview` iPhone build is an App Store Connect build of
   `com.crkmch.hmis.staging`, sent to TestFlight by its own submit profile and never sent for App Review. It can
   never fall on the production app.

Not in scope: the Hindi privacy page, iPhone notifications, keeping DEMO rows out of reports.

## Done means
- **D1** On an Android phone that Google Play installed, the update check answers `store`, reads no feed and
  draws no "Check for update" row.
- **D2** On an Android phone that any other installer installed, or whose installer is unknown, the update check
  reads the feed and offers a newer APK, as it does today.
- **D3** On iPhone nothing changes: the answer is `store` and no feed is read.
- **D4** The Play bundle check refuses a manifest with `REQUEST_INSTALL_PACKAGES`, `ACCESS_BACKGROUND_LOCATION`,
  `READ_MEDIA_IMAGES` or `READ_EXTERNAL_STORAGE`, a `targetSdkVersion` below 35, or a native library not aligned
  to 16 KB. It passes a clean bundle.
- **D5** The production build is named "CRKMCH" and staging "CRKMCH Staging" on both phones. Every iPhone
  permission sentence and the scan widget label say CRKMCH and not HMIS. The app ids are unchanged.
- **D6** No phone string (English or Hindi) that names the phone's settings, notifications or unlock still says
  HMIS, except the one line that quotes the server's notification sentence (item 8). "Your HMIS password" still
  says HMIS.
- **D7** The `preview` iPhone build is a store build of `com.crkmch.hmis.staging`, and its submit profile names
  that id and never the production one. The production submit profile still names `com.crkmch.hmis`.

## Built (2026-11-14)
- D1–D7: `apps/mobile/__tests__/acceptance/store-approval-1058.test.tsx`. D2 and D3 pass on main by design: they
  guard the phones that must not change.
- Checked on a real release bundle built in the lane (debug-signed, not for upload): target SDK 36, no banned
  permission, all 27 64-bit native libraries aligned to 16 KB, the installer module compiled into the bundle.
- Changed against the spec: the server's notification sentences and the Settings line that quotes them move to
  #1059; the privacy page also gives the date of this change. The header on every phone screen reads a
  phone-only key, `mobile.brand` (CRKMCH): `app.title` is shared with the web app, which stays HMIS.
