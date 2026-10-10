---
type: decision
id: "0063"
title: "The iPhone staff app goes through Apple as an Unlisted app, built on Expo's EAS cloud; Android stays sideloaded and built on our server"
description: "For about 100 iPhone users the owner chose Apple's Unlisted App distribution from the organisation's Apple account, with TestFlight for testing, and Expo's EAS cloud to build and submit. This sets aside, for the iPhone only, the earlier spoken rulings 'no Play Store / App Store' and 'no expo.dev cloud'."
generated: { by: agent:claude, at: 2026-10-10 }
verified: []
status: stable
ruling: ruled
tags: [mobile, ios, distribution, build, privacy]
supersedes: []
superseded_by: []
sources: []
---
# 0063 — The iPhone app: Unlisted through Apple, built on EAS

- **Date:** 2026-10-10 (rulings given 2026-10-08)   **Status:** Ruled
- **Area:** staff app (apps/mobile), iPhone

## What is ruled (owner, 2026-10-08)

1. **An iPhone build of the staff app**, for about 100 iPhone users. An iPhone cannot install an app the
   way an Android phone installs an APK, so the iPhone app goes through Apple.
2. **Apple account: Organisation** — the team is Ramarya Software Services LLP (J9YMW2253U), which is the
   seller name Apple shows.
3. **Distribution: Unlisted** ("Keep it unlisted"): an App Store listing reachable only by its link. Each
   version passes Apple's review. TestFlight is used for testing before that.
4. **Build: Expo's EAS cloud** ("I would like to use EAS"), on the expo.dev account that holds the project.
   `eas build --platform ios --profile production`, then `eas submit`.
5. **For the iPhone only**, this sets aside two earlier spoken rulings that were never written as records:
   "no Play Store / App Store, ever" (2026-10-05) and "no expo.dev cloud" (2026-10-05). **Android is
   unchanged**: sideloaded APKs built and signed on our own server (`apps/mobile/scripts/build-apk.sh`);
   never build Android on EAS — an EAS-signed APK cannot update the phones that hold ours.

## How it is enforced

- `apps/mobile/app.config.ts`: the iPhone block (bundle `com.crkmch.hmis`, staging `com.crkmch.hmis.staging`,
  iPhone only, no encryption export), the plain-words permission sentences (camera, microphone, Face ID,
  location while in use), and `withoutApplePush` (iPhone notifications are dormant in this version).
- `apps/mobile/eas.json`: the iPhone profiles and `submit.production.ios` naming the App Store Connect app
  (6820855786), the Apple ID and the team. `APP_ENV=production` must be set on the `eas` command.
- Pinned by `apps/mobile/__tests__/ios-config.test.ts`, `ios.test.tsx`, `ios-production.test.tsx`.
- No `eas` command is ever run from `/opt/hmis` (a stray `app.json` there blocks deploys) — only from a lane.
- Apple's secrets (an App Store Connect API key) live under `/root/.config/hmis/apple/`, never in git or chat.

## Decided while building (DECIDED — the owner may change any of these)

- The iPhone has no in-app update prompt; updates come through TestFlight or the App Store.
- The iPhone blanks the app in the app switcher; it does not block screenshots.
- Face ID unlock wording in English and Hindi.

## Still owed before Apple's review

- A privacy-policy section for the app on crkmch.com (drafted 2026-10-10; the owner publishes it), with the
  location line of decision 0062.
- A reviewer demo sign-in with fake patients, entered in App Store Connect — never written in the repository.
