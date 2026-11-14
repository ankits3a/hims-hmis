---
type: decision
id: "0095"
title: "The Android staff app goes on Google Play too, the app is named CRKMCH, and the staging iPhone app stays in TestFlight"
description: "Owner 2026-11-14: the Android app is published on Google Play as a public listing that needs a hospital sign-in, beside the existing download link; it is one app with the APK (same id, key and counter). The app's visible name becomes CRKMCH. Store reviewers get one DEMO-department account. The staging iPhone app is distributed through TestFlight only."
generated: { by: agent:claude, at: 2026-11-14 }
verified: []
status: stable
ruling: ruled
tags: [mobile, android, ios, distribution, play-store, privacy]
supersedes: []
superseded_by: []
sources: []
---
# 0095 — Android on Google Play, the app named CRKMCH, staging in TestFlight

- **Date:** 2026-11-14   **Status:** Ruled
- **Area:** staff app (apps/mobile), distribution
- **Amends:** decision 0063 point 5 ("Android stays sideloaded"). Everything else in 0063 stands.

## What is ruled (owner, 2026-11-14)

1. **Android on Google Play too** ("we will have android app too"), as a **public listing that needs a hospital
   sign-in** (Play has no Unlisted option). The download link `https://hmis.crkmch.com/app/hmis-staff-latest.apk`
   stays as a fallback.
2. **Store reviewers** (Apple and Google) get one account on production, limited to a **DEMO department with
   five made-up patients**, switched off between reviews. Its rows appear in registers and the audit trail; that
   cost is accepted.
3. **Both privacy promises stay** on the privacy page: information is not sold; no advertising, tracking or
   outside analytics.
4. **The app is named CRKMCH** ("CRKMCH Staging" for staging) on the phone, in its prompts and on both stores.
5. **The staging iPhone app stays in TestFlight**; it is never sent to the App Store.

## Decided while building (DECIDED — the owner may change any of these)

- **One Android app.** The Play bundle is built on our server from the same tree as the APK, with the same app id
  (`com.crkmch.hmis`), the same versionCode counter, and Play App Signing holding our existing production key
  (uploaded encrypted). A separate upload key signs the bundle. A phone with the APK updates from Play in place.
  Android is still never built on EAS.
- **No self-update on Play phones.** Play bans an app it distributes from updating itself any other way. The app
  asks Android which app installed it (`modules/install-source`); when it is Google Play the APK feed is never
  read and no "Check for update" row is drawn. Over-the-air JavaScript bundles continue on both.
- **Checks before upload.** `scripts/play-checks.js` refuses banned permissions, a target SDK below 35 and 64-bit
  native libraries not aligned to 16 KB.
- **"HMIS" stays** the name of the hospital system and its account ("Your HMIS password"). The app ids never change.
- **The server's notification sentences** ("Open HMIS to see it") change only after the renamed builds are on the
  phones, so a phone still named HMIS never reads "Open CRKMCH" (#1059).
- **Seller:** the Play developer account is the same organisation as the Apple team (it reuses that D-U-N-S
  number). Both stores get the hospital's signed authorisation letter for that seller to publish under the
  hospital's name.

## How it is enforced

- `apps/mobile/__tests__/acceptance/store-approval-1058.test.tsx` (spec #1058 D1–D7).
- `apps/mobile/src/update.ts` (`updatesFromFeed`), `src/install-source.ts`, `modules/install-source/`.
- `apps/mobile/scripts/build-apk.sh production --play` and `scripts/play-checks.js`.
- `apps/mobile/eas.json`: `preview.ios` is a store build of `com.crkmch.hmis.staging` with its own submit profile.
- `apps/mobile/BUILDING.md`, "Google Play" and "Store review".
