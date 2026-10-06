# HMIS staff Android app — plan

Owner, 2026-10-05: *"let's build our own mobile app. Let's start with android app using expo.dev"*.
His answers to the two questions asked:
- **Audience:** hospital staff (doctors, front desk, vitals, slip desk, billing), using the same logins as hmis.crkmch.com.
- **Build:** fully native screens with React Native via Expo. A WebView shell was rejected.

M0 is built in lane `mobile-m0`. This document is the contract for M1 onwards.

## 1. Architecture (DECIDED)

| Concern | Decision | Why |
|---|---|---|
| Project | `apps/mobile`: Expo SDK 57, React Native 0.86, React 19.2, TypeScript strict, expo-router | Latest stable SDK; file routes like the web's router |
| Workspace | **Standalone npm project, excluded from the pnpm workspace** (`!apps/mobile` in `pnpm-workspace.yaml`), with its own `package-lock.json` | See §5. React Native in the root lockfile would reach the server image and every `pnpm install` |
| Auth | **No server change.** The API already issues bearer sessions: `POST /auth/login` returns `{token}`, every call sends `Authorization: Bearer`. The app uses `GET /auth/me`, `POST /auth/change-password` (forced reset, 403 `password_change_required`) and `POST /auth/logout`. Session lifetime = `SESSION_TTL_MINUTES`, as on the web. Throttle, audit (`auditSessionOpened`, M-05 failures) and WASA rules apply unchanged, because they live in the server | Smallest change is none |
| Token at rest | `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (Android Keystore). The web export keeps it in memory only | Never in AsyncStorage |
| Biometric | `expo-local-authentication` **locks the phone-side copy** of a session. A stored token is not used until the phone confirms the person (fingerprint, face or device PIN). It never replaces the password and never extends a session | Convenience without a second credential the server does not know |
| Permissions | Home lists only the screens whose web-menu permission the user holds (`src/seats.ts` mirrors the module manifests). The server still checks every call | One source of truth: the server |
| Device binding / remote wipe | **Deferred (M6).** Today a stolen phone holds at most a session token behind the phone lock, revocable by password change (which revokes other sessions) or admin user deactivation. M6 adds a `device_id` on sessions and an admin "sign this phone out" control, additively | Needs a migration; not needed to start |
| Shared code | `packages/contracts` is pure TS + zod. M1 onward imports it through Metro `watchFolders`. M0 needs none of it. Pure logic shared with the web (vitals parsing from #491, slip edge detection + homography from #490) moves to a small `packages/clinical-input` TS package that both import. No React in it | One parser, two screens |
| Environments | `app.config.ts` + `eas.json` profiles. **development** and **preview**: staging API `https://stagehmis.crkmch.com/api`, app id `com.crkmch.hmis.staging`, name "HMIS Staging", amber STAGING strip. **production**: `https://hmis.crkmch.com/api`, `com.crkmch.hmis`, "HMIS". The base URL is baked in at build time | A staging build cannot touch production data; both install side by side |
| EAS project | Reuses projectId `4b8df892-c208-45a4-ad76-52a4551f7188`, found in a stray `/opt/hmis/app.json` (an `eas init` run from `/opt/hmis`, now at `/opt/hmis-context/stray/app.json.2026-10-05`). The slug is set to `hmis` to match. If `eas build` reports a slug or owner mismatch, run `npx eas init --force` in `apps/mobile` and commit the new id | |
| Staging basic auth | Not a problem: staging's Caddy puts basic auth on the static site only, never on `/api` (`Caddyfile.uat`) | |

## 2. Design system

- **Colours:** `src/theme.ts` is the web's `styles/paper-pine.css` token for token. `__tests__/theme.test.ts` reads the CSS file and fails on drift.
- **Type and touch:** type scale on a phone is body 15, title 26, and mono tags as on the web. Touch targets are at least 48dp.
- **Fonts:** IBM Plex Sans and Mono (the web's), bundled since M3 (`src/fonts.ts`, `src/text.tsx`). Hindi uses the phone's own Devanagari face.
- **Strings:** `src/locales/{en,hi}.json`. Keys the web also has are copied verbatim. `__tests__/i18n.test.ts` fails if their wording differs from the web's or if en/hi key sets differ.

## 3. Milestones (each: tests, a web-export walk at 360/390/412 read by eye, then a preview APK on a real phone)

| # | Screen | Acceptance |
|---|---|---|
| **M0** ✅ | Scaffold, sign-in, forced password change, fingerprint unlock, seat home, logout, en/hi | 38 jest tests; walk shots read |
| **M1** ✅ | **Vitals bay** (built 2026-10-06, see §3a) | Bench with a doctor filter; three doors (token, UHID, camera scan of a card). Capture BP with `/ - , .` or a space as separator, plausibility, the gate mirrors. Temperature sensed as °F or °C by band and charted in °C. Temperature optional; BP optional under 13 (the server's `requiredFor`). Danger protocol (other arm, class 0, cancel window), rest chairs, emergency save, fee gate in board words. Rules shared with web (#491) as ONE file |
| **M2** ✅ | **Slip desk** (built 2026-10-06, see §3b) | Find the visit (scan, visit number, token as printed, UHID, name), the server's read-back and "check the person", full-screen camera with a lamp, the crop step (page found, four draggable corners with a loupe, Reset, Retake), perspective-straightened page, kind + note, file against the visit with progress; never queued. Detector and warp arithmetic shared with web (#490) |
| **M3** ✅ | **Doctor's OPD line + patient brief** (built 2026-10-06, see §3c) | My line today (waiting / with me / seen, longest wait, each row's age, visit kind, wait, UNPAID and DANGER marks), call next, call again, skip with a coded reason and undo, tokens held for the bill opened with a reason, the patient brief (allergy, the patient's words, today's vitals with the bay's flags, lab and radiology since the last visit, the last prescription and its refill record, past visits, filed papers with zoom), start / park / resume / complete. Plex fonts, the CRK crest as the app icon, and the in-app update check land with it |
| M4 | **Desk One essentials** | Search by name/UHID/phone, register (minimal fields), token, collect with Cash or UPI. Money writes never queued offline |
| M5 | **Roster** On-now and My duties | The boards' phone layouts (D6) |
| M6 | Push and devices | `expo-notifications`. The server registers a device push token per session and sends existing alert kinds (roster flags, unpaid-token door, lab criticals). Devices are bound to sessions, with an admin "sign this phone out" |

### 3a. M1 as built (2026-10-06)

- **One rules file, two screens (DECIDED).** The plan named a new `packages/clinical-input` package. Built
  instead as ONE source file, `packages/contracts/src/vitals-entry.ts`: pure TypeScript, no imports, not in
  the contracts index. The web bay imports it by path (Vite bundles source; the server image already copies
  `packages/contracts`, so the Dockerfile is untouched). The phone imports the same path: `metro.config.js`
  watches the folder, and `nodeModulesPaths` lets Babel's helpers resolve for a file outside the app.
  `apps/web/src/screens/vitals-bay-capture.tsx` re-exports it, so no web import changed.
  `apps/mobile/__tests__/vitals-rules.test.ts` fails if either side grows its own parser.
- **Same server routes, same guards:** `/opd/bench`, `/opd/queues/summary`, `/opd/visits/:id/prestage`,
  `/vitals`, `/escalation{,/recheck,/escalate,/cancel}`, `/bench-state`, `/patients/qr/verify`,
  `/patients/:id/allergies`, `/opd/cds/complete/allergen`.
- **Keyboards:** the BP tile opens the phone pad (`phone-pad`: digits with `- , . /`), every other tile the
  decimal pad. Android's decimal pad accepts no separator but ".", which is why BP differs.
- **Deferred, with the reason:**
  - *Amending a saved chart* — a correction with a reason and a trail is a second screen's worth of work;
    a charted row says "use the vitals bay on a computer for now".
  - *The serial device lane* — the web has no real driver either (`nullDriver`); nothing to port.
  - *The ask bar / copilot* — every screen gets it together, later.
  - *Realtime push* — the bench is re-read every 5 s while the app is in front; the web treats the push
    as a hint and the poll as the truth too.
  - *The first BP held across a rest* lives in memory: closing the app in those five minutes means
    retyping the pair (the recall itself is the server's).
  - *IBM Plex fonts and the CRK app icon* — still the system font and Expo's icon.

- **FIXED 2026-10-06, the same day, on the owner's phone test:** he typed the visit number on the slip
  (`V2610060001`) for a patient on the bench and was told "not on this bench" — the bench row carried no
  visit number, and I had listed that as deferred. Bench rows now carry `visitNo` and `departmentCode`;
  `resolveDoor` in the shared rules file reads a token (`4`, `#4`, `ORT-4`), a UHID (any case, digits
  alone), a visit number (any case, spaces, wrapped in text), the prescription sheet's QR (the bare visit
  number), a printed e-prescription's QR (`rx1.…`) and a patient card (`q1.…`, server-verified); a miss
  names what was understood, and `GET /opd/bench/locate` gives a visit's reason. Web and phone both use it.

### 3b. M2 as built (2026-10-06)

- **Same routes, same guards as the web desk:** `/opd/slips/today`, `/opd/visits/by-number/:visitNo`, `/opd/slips/find`,
  `/patients/qr/verify`, `POST /patients/:id/documents` (1.5 MB refusal). A record the caller may not see answers as
  "no such visit" and is absent from the list — the server's rule; the phone adds nothing.
- **Shared, one copy:** `packages/contracts/src/doc-crop/{geometry,detect}.ts` (moved from `apps/web/src/lib/doc-crop`,
  which now re-exports them) and `packages/contracts/src/slip-desk.ts` (size budget, wire shapes, `slipDoor`).
  `slipDoor` sits on the vitals bay's `resolveDoor`, so the visit number, the token as printed (`ORT-4`), a UHID, a
  printed e-prescription's QR and a patient card all resolve — and every road ends at the SERVER's read-back.
  The web desk uses it too. Today's slip rows gained `tokenNo` and `departmentCode` (additive).
- **Pixels on a phone — DECIDED: Skia.** React Native has no canvas. Considered: a pure-JS JPEG codec (seconds per page
  in Hermes), a cloud service (no), and `@shopify/react-native-skia` — the engine Android draws with, compiled in by
  prebuild: decode, read pixels, draw through a 3×3 perspective matrix, encode JPEG, all native. Skia only EXECUTES;
  `detectDocument`, `homography`, `pageAspect` and `flatSize` (shared) decide. Every Skia call is guarded: if it fails
  on some phone, finding answers "not found" and flattening falls back to a plain cut to the corners' rectangle
  (`expo-image-manipulator`), and the screen says the page was not straightened.
- **Resolution:** the camera's full photo is kept at up to 2560 px for cropping (the web works on 1600); only the
  straightened page is brought down to 1600 px and inside 1.4 MB, stepping JPEG quality 82→40.
- **Detection speed — measured on the build server, NOT on a phone:** the detector is plain JavaScript and Hermes has
  no JIT. With the JIT on (a browser): 90 ms at 480 px, 40 ms at 320 px. With it off: 2.0 s at 480 px, 0.85 s at
  320 px, 0.55 s at 256 px. At 320 px all four test photographs are still found (corners within 0.4% of the long edge
  of the 480 px answer); at 256 px the lamp-lit one is lost. So the phone looks at a **320 px** copy. If a real phone
  is still too slow, the next step is to move the grey/blur/threshold passes into Skia, or a native detector.
- **Deferred, with the reason:**
  - *Tap-to-focus* — expo-camera exposes no focus point; the rear camera focuses continuously. Needs another camera
    library (react-native-vision-camera) if the owner's phone hunts.
  - *Choose a photo from the gallery* — the web's fallback for a desk with no camera; a phone has one.
  - *Arrow-key nudging of a corner, keyboard shortcuts* — keyboard affordances of the counter PC.
  - *The "clocks running" panel* — the waiting minutes are on each row instead.
- **Not verified without a phone:** the camera preview and capture, the lamp, Skia at runtime (decode, pixel read,
  warp, JPEG), detection speed in Hermes, the loupe under a real thumb, upload progress on mobile data.

### 3c. M3 as built (2026-10-06)

- **Same routes, same guards as the web consultation screen:** `/opd/me/doctor` (404 `not_a_doctor` is an answer),
  `/opd/queues?doctorId=&serviceDate=`, `/opd/queues/:sessionId/{call-next,status}`,
  `/opd/queues/entries/:id/{recall,skip,undo-skip}`, `/opd/visits/:id/consult/{open-unpaid,start,park,resume,complete}`,
  `/opd/visits/:id`, `/patients/:id` (+ `/allergies`, `/documents`, `documents/:id`), `/opd/patients/:id/{timeline,prescriptions}`,
  `/lab/results/patient/:id`, `/radiology/reports/patient/:id`, `/pharmacy/doctor/patients/:id/dispenses`,
  `/roster/doctor-units`, `/opd/config`. **No server change:** the queue view already carried each patient's date of
  birth and administrative gender (the summary is returned whole), so "56 M" needed nothing new.
- **Shared, one copy:** `packages/contracts/src/doctor-queue.ts` — the queue's wire shapes, how a row is worded (age and
  sex, the wait, the visit kind, UNPAID only on `unsettled`), the follow-up choices and the completion body, and — moved
  out of the web — `briefResults` / `briefRefill` (web `lib/brief-history.ts` re-exports) and `besideName`
  (web `lib/doctor-label.ts` re-exports). `apps/mobile/__tests__/doctor-rules.test.ts` fails if either side grows a copy,
  and pins the skip reasons against `opd/skip-reasons.ts` read as text.
- **The line is the server's, shown as sent:** the callable order, the tokens held for the bill, the ones that fell out
  after three skips and the parked ones are four lists off one read, re-read every 5 s while the app is in front. A
  failed re-read keeps the last list and stamps its time.
- **Completing from a phone — DECIDED:** the phone sends **no note** (`{testsOrderedReturnToday, followUpDays?}`), so
  whatever the doctor saved on the computer is untouched, and the default follow-up is left out of the body so the
  server's own applies (K49). The phone **refuses** to complete while the visit holds prescription rows typed on the
  computer and never issued (`encounter.rxDraft`) — production 2026-09-23: Complete once dropped an unissued
  prescription. The web closes that by issuing first; the phone cannot issue, so it says where to finish. This guard
  is the phone's only; the server would accept the completion (a server guard would break the web's own
  issue-then-complete, which clears the draft in the same request).
- **Starting ahead of the line:** the server lets a doctor start any waiting visit of their own
  (`startConsultation` asks only for `waiting`), so the brief of a patient who is not next offers "Start now, ahead of
  the line", worded as such. There is no "call this token" route, and none was added.
- **Deferred, with the reason:**
  - *Writing the note, a coded diagnosis and an e-prescription* — the web's checks (allergy, interaction, duplicate,
    drug–disease, stock substitution, the override dialogs) are that screen's, 4,700 lines of it; a phone version
    needs its own board. The paper road works end to end: start → complete on the phone, the slip desk photographs
    the paper (M2).
  - *Refer to another department, advised tests, specialty sections (eye, paediatrics), the scribe's draft* — parts of
    the note.
  - *Closing or reopening the session* — the phone steps out and back in; closing a day is done at the computer.
  - *Realtime push* — the 5 s poll is the truth here as on the web; push arrives with M6.
  - *Pinch-to-zoom on a filed paper* — the viewer zooms with buttons (100–400%) and scrolls both ways; a pinch
    gesture needs the gesture library wired through every screen's root and is not worth it for one viewer yet.
  - *IBM Plex Sans Devanagari* — Hindi is drawn by the phone's own Devanagari face (Plex Sans has no Devanagari;
    Android falls back glyph by glyph).
- **Polish that landed with M3:** IBM Plex Sans / Mono bundled (`src/fonts.ts`, `src/text.tsx` — every screen imports
  `Text` / `TextInput` from there); the CRK crest as the icon, adaptive icon and splash (rendered from
  `docs/design/2026-08-29-opd-counter-flow-v2/crk-logo.png`, 240 px — sharp at launcher sizes, soft if ever shown
  larger; the owner's 717 px master is not on this box).
- **The update check (no app store):** `scripts/build-apk.sh` writes `hmis-staff-<env>-latest.json` beside the APKs
  (versionCode, versionName, file name, sha256, one line of notes from `HMIS_RELEASE_NOTES`). The app reads it when
  the home screen opens and from "Check for update" (`src/update.ts`); a higher versionCode shows "Update available"
  and opens the download in the browser. On staging, Caddy serves exactly `/app/hmis-staff-*-latest.json` without
  the basic-auth prompt (an app cannot answer one); the APK and the folder listing stay behind it.
- **Not verified without a phone:** the fonts and the crest icon as Android draws them, the splash, haptics, the
  update download hand-off to Chrome and the installer, the paper viewer's two-way scroll under a real thumb.

**Offline rule (all milestones):** cached reads show their age ("as of 10:42"). A clinical or money write is never queued silently. With no network the button says so and stays disabled.

## 4. Verification without an emulator

1. **Behaviour:** jest-expo plus `@testing-library/react-native`, with mocked fetch, SecureStore and LocalAuthentication.
2. **Look:** `npx expo export --platform web`, served beside a stub API, shot with Playwright and Chromium at 360/390/412, every shot read. Scripts: `/opt/hmis-context/mobile-tools/` (serve.mjs = static + stub API on :3098, shoot.mjs = the walk).
3. **On a real phone:** the preview APK, installed by the owner from the EAS link or QR, pointing at staging.

## 5. Monorepo risks, and the evidence

- **Server image:** the Dockerfile's `deps` and `prod-deps` stages copy only core, web and contracts package.jsons and run `pnpm install --frozen-lockfile`.
  - With `!apps/mobile` in the workspace, the root lockfile is unchanged (`git diff pnpm-lock.yaml` is empty). `pnpm -r ls` lists root, core, web and contracts only.
  - `docker build --target deps` and `--target prod-deps` both succeeded on the lane (2026-10-05).
  - `apps/mobile` is also in `.dockerignore`, so it is not even in the build context.
- **Root lint and typecheck:**
  - `eslint.config.mjs` ignores `apps/mobile/**`.
  - `pnpm -r exec tsc` never sees it, because it is not a workspace package.
- **CI:** a separate `mobile` job (`npm ci`, `tsc --noEmit`, `jest --ci`).
  - It is **not** a required check and not in auto-deploy's `REQUIRED="static core web"`, so a red mobile job blocks no server deploy.
  - It runs in parallel, so the core and web wall-clock is unchanged.
- **React versions:** web is on React 19 (^19.0.0) and mobile on 19.2.3. They are separate trees, so there is no conflict.

## 6. Distribution (owner 2026-10-05: no Play Store and no App Store, ever)

The app is built on this server (`apps/mobile/BUILDING.md`), signed with the hospital's own key, and installed from a
download link. expo.dev's cloud builder is not used.

- **Staging build** (`com.crkmch.hmis.staging`, "HMIS Staging", talks to stagehmis): served at
  `https://stagehmis.crkmch.com/app/` behind the staging password. This is the owner's and a trainee's test app —
  test data only.
- **Updates:** every build raises the versionCode; the app's own check (§3c) offers the newer APK. Android installs it
  over the old one only because it is signed with the same key — **the keystore folder
  `/root/.config/hmis/android/` must be backed up offline** (lost key ⇒ every phone uninstalls to update).

## 7. Production rollout — EXECUTED 2026-10-06 (the owner's rulings, and what was built)

**Owner, 2026-10-06 (verbatim):** *"Roll out to everyone at once. Yes Staff will be using their personal phones for the
next few months. Once all department is live on the operating system the devices will be replaced by hospital's own.
No, don't draft wording for install links. I will share personally. Choose the logical and practical choice to keep the
offline backup of the signing keys."*

So: no pilot (D-1), personal phones for now and hospital phones later (D-3), **no WhatsApp sending and no template**
(D-2 — the owner hands the link out himself), and the link-lifetime question (D-4) falls away with the signed-link
design it belonged to. D-5 is DECIDED below.

### 7.1 What serves the app (DECIDED)

- `https://hmis.crkmch.com/app/hmis-staff-latest.apk` — the link staff are given. It never changes between builds.
- `https://hmis.crkmch.com/app/hmis-staff-production-latest.json` — the update feed the installed app reads.
- `https://hmis.crkmch.com/app/hmis-staff-install-qr.png` — the same link as a QR, for a poster.

Production's caddy mounts `/opt/hmis-context/mobile-apk-prod` read-only at `/downloads` and serves from it ONLY files
named `hmis-staff-…` ending `.apk`, `.json` or `.png`; every other `/app/` path is a 404, and nothing lists the folder
(`docker/prod/Caddyfile`, `@app_file`; pinned by `apps/core/test/caddyfile-hardening.test.ts`). `build-apk.sh production`
writes into that folder, so a new build needs no deploy.

**No password, and the earlier signed-link design is dropped — DECIDED.** The first draft of this section put the APK
behind a per-staff signed link minted by the API and sent on WhatsApp. The owner ruled the sending out, and without it
a signed link is a cost with nobody to mint it for: the owner shares one link, by hand, with everybody. An APK holds no
secret — only the site's address — and nothing in it works without an HMIS staff login; a phone's installer and the
app's own update check cannot answer a password prompt.

**The residual risk, plainly:** the link is unlisted, not secret. Anyone who is sent it — or guesses the file name —
can download the app and read its code and the API paths it calls. That gives them nothing the login page does not:
every route still needs a staff session and its permission. What it does NOT protect against is a staff member's own
phone: see 7.4.

### 7.2 The build

`HMIS_RELEASE_NOTES="…" apps/mobile/scripts/build-apk.sh production` → app id `com.crkmch.hmis`, name "HMIS", API
`https://hmis.crkmch.com/api`, no staging strip, signed with `hmis-production.jks`, its own versionCode counter. It
installs beside the staging app. The production signing certificate (every later build must carry it, or phones refuse
the update):

`SHA-256 32:C8:C3:E7:44:42:F3:A5:A2:7E:9C:B6:17:6F:95:E9:0A:0E:A9:3A:E9:FB:D5:38:1D:BA:66:BF:F0:EA:57:A4`

### 7.3 The signing keys' backup (D-5, DECIDED)

One encrypted archive (AES-256), restored and checksum-compared every time it is made, kept in two places: on this
server (`/opt/hmis-context/backups/`) and **off it, in the bucket the database's own backups already go to** (the
pgBackRest repository on Cloudflare R2, prefix `hmis-android-keys/`). The passphrase is the third piece and the only
one a person must hold: it is in a mode-600 file on the server, and the owner copies it once onto paper kept away from
the server. Reasoning: the hospital already trusts that bucket with every patient record and already pays for and
monitors it; a USB stick in a drawer is the backup nobody can find in three years. `apps/mobile/BUILDING.md` has the
commands.

### 7.4 What a phone needs, and what is still owed

1. Chrome → the link → "Install unknown apps" for Chrome (once) → Install → sign in with the HMIS username and password
   → fingerprint from then on.
2. Updates: the app's own check on start-up and "Check for update"; the prompt opens the new APK from the same folder.
3. **A lost or leaving phone (personal phones make this matter more):** deactivate the user or reset the password —
   both end that phone's session today. **Owed in M6:** device binding (which phones hold a session, shown in
   `/admin/users`) and "sign this phone out" without resetting the password.
4. **Hospital-owned phones later (owner):** nothing here assumes a personal phone. When the hospital's devices arrive,
   M6's device list is what lets an admin retire the personal ones.
