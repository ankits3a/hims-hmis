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
  prescription. The web closes that by issuing first; the phone cannot issue, so it says where to finish.
  **Since M4 (2026-10-06) this is also the server's guard:** `completeConsultation` refuses
  `rx_unissued_state_conflict` (409) when the request does not say what becomes of the draft and the visit holds
  drafted lines that are on no issued prescription. The web's issue-then-complete still passes because it carries
  `note.rxDraft: null` in the same request; a draft whose every drug is already on the issued prescription (a clear
  that was lost) blocks nothing.
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

### 3d. M4 as built (2026-10-06)

- **Same routes, same guards as the web's Desk One:** `/patients/search`, `/patients/qr/verify`, `POST /patients`,
  `/patients/:id` (+ `/linked`), `/opd/patients/:id/timeline`, `/opd/config`, `/opd/departments`, `/opd/queues/summary`,
  `/roster/doctor-units`, `/opd/continuity`, `/billing/consult-terms`, `POST /opd/walk-in`, `/opd/visits/:id/{join-queue,move-preview,move-department}`,
  `/billing/visits/:id/fee-quote`, `POST /billing/invoices`, `/billing/sessions{,/current}`, `/billing/invoices?encounterId=`,
  `/print/jobs`, `/print/reprint`. **No new route.** The seat is offered to `opd.visits.open`; every block inside it asks
  only what the login's own permissions allow (a front-office login never requests the fee quote or the cash session).
- **Shared, one copy:** `packages/contracts/src/desk-counter.ts` — moved out of the web's `desk-one/model.ts` (which
  re-exports every name): the lanes and the token's states, today's open visit, the bill read, the board's wait
  arithmetic, the token label, an age; out of `session.ts`: the one age-or-date-of-birth box; and new, used by BOTH:
  what a department-move preview means (`moveFee`, `moveMoneyLine`, `moveMoneyBlocks`, `moveCollectPaise` — the web's
  move panel now calls them) and a visit's paper (`paperState` — the web's `printSummary` now calls it). The phone's
  short registration form (`shortFormGaps`, `shortRegisterBody`) keeps the web's rules: a blank box is an omitted key,
  one of dob/age, a guardian's four authorities always explicit. `counter-rules.test.ts` fails if either side grows a copy.
- **One thing per screen:** find → (register) → the patient → seat → bill → done, with one primary button in the same
  place on every stage and the person in hand pinned above.
- **Money and a visit are never queued, and never made twice — DECIDED:** the two writes carry the web's
  `Idempotency-Key`. The phone keeps ONE key and ONE body per intent. When an answer is lost it says what is not
  known, locks the choice (doctor / tender), and the retry (a) for a bill, re-reads the fee quote first — the server's
  own duplicate guard (`alreadyBilled`) then ends it with nothing re-sent — and (b) re-sends the SAME key and body, so
  the server replays its first answer. The web mints a fresh key per press and relies on the quote re-read alone;
  the phone is stricter because mobile data loses answers more often. Three mutants (no re-read, a new key, an
  unlocked choice) each turn a named test red.
- **Collecting:** only with `billing.invoice.issue` and an open cash session. With none open the screen says why and
  offers "Open my cash session" (the web's `POST /billing/sessions`, a float in rupees) — or leaving the fee for the
  billing counter. A login that does not take money sees the price list's fee and "collected at the billing counter".
  The cashier's running total is never shown (blind count).
- **Free:** the server's quote decides; a switched-off fee reads "₹0 (समाज सेवा छूट)" in both languages and the
  token's stamp says FREE, not PAID — nothing was paid.
- **Lanes:** all three, off the shared rules — F1 prints at seating stamped UNPAID; F2 holds the slip until the bill;
  F3 defers the queue join and the phone calls `join-queue` once the money is in.
- **Paper:** queued by the server in the visit's own transaction for the counter's printer; the phone shows whether it
  came out and offers "print again" (a new server job). The phone prints nothing itself.
- **Continuity:** the doctor who saw the patient last is listed first and picked — unless their line is past the
  web's 20-minute mark, in which case the shortest line stays picked and the note says so.
- **The visit card and "Wrong department? Move patient":** from the bill stage and from any row of the patient's
  history; the four money rules are the server's, worded by the shared helpers.
- **Deferred, with the reason:**
  - *Appointments* — built 2026-10-07, see §3i.
  - *The full registration record* — ABHA (create / verify / scan-and-share), coverage, a sealed record's alias,
    referrer, photo, allergies told at the desk: entered at the counter PC or the patient's profile. The phone's
    short form is the fast path only, and says so.
  - *Coupons, a partner slip, manual discounts, credit, split tenders* — one tender for the server's own total.
  - *Correcting the visit type, changing the doctor within a department, amending the record* — counter PC.
  - *The complaint's triage suggestion and red-flag stage* — the complaint is typed and sent to the doctor; the
    department is chosen by the clerk.
  - *Closing / counting the cash session* — the drawer is counted at the billing computer.
  - *The desk agent (ask bar) and the day's own figures* — every screen gets the ask bar together, later.
- **Not verified without a phone:** the keyboard over the bottom button, the camera scan of a patient card, the
  haptics, a real lost answer on mobile data.

**Offline rule (all milestones):** cached reads show their age ("as of 10:42"). A clinical or money write is never queued silently. With no network the button says so and stays disabled.

### 3e. M5 as built (2026-10-06)

`apps/mobile/src/screens/roster-on-now.tsx`, `roster-my-duties.tsx` + `src/roster/{api,rules,words}.ts`; seats `onNow` and
`myDuties` (`roster.read`). No server change and no new route.

- **Shared:** `packages/contracts/src/roster-board.ts` — the wire shapes of `GET /roster/on-now` and `/roster/my-duties`
  (moved out of the web's `lib/roster-api.ts`, which re-exports them) and the reading rules both screens use: `clockNoteOf`,
  `takeTillOf`, `backupOf`, `hasNoTakeCycle`, `opdFallbackOf`, `flaggablePeople`, `dutyWhatKey`, `weekOf`, `coverBuckets`,
  `greetingKey` / `greetingName`, `requestTone`, `shortUnit`. Rules return i18n KEYS; each side says them with its own
  translator. The web screens were refactored onto the file (their 56 roster tests unchanged and green).
- **Who is on now:** the clock line and what it means for the take; per department a card — unit on take and till when,
  who is in the building with **Call** only where the server sent a number (D6), faculty on call, the overflow; the OPD
  sitting list where no duty roster is published; a quiet card for a department with no unit; services; holes; "This is
  wrong" (a flag for the duty manager) and "Dealt with" for whoever may. Now / In 8 hours. Re-read every 60 s; a failed
  re-read keeps the last board and stamps its time.
- **My duties:** greeting, today on a LIGHT card (owner: no dark slabs), tonight and the unit on take; asked-of-you with
  the server's check and Yes / No; my requests and where each stands, with Withdraw; the week, rest after a night;
  "I can't do this" → who can take it, who cannot and why → Ask or Swap; "Call my SR" only when a number was sent.
- **Words:** days and months come from the app's locale files by IST arithmetic, not `Intl` (a phone engine's `hi-IN` names
  vary by build). Refusals are `roster.refusal.<code>` — the web's sentences, copied and pinned by `i18n.test.ts`.
- **Never queued:** a flag, an ask, an answer or a withdrawal that did not reach the server stays on screen and says
  nothing was changed.
- **Deferred:** the unit's month grid (a 31-column sheet — read on the computer); the board as it stood, declaring a
  holiday or skeleton cover, printing (desk and inspection tools); approving a cover (`decide` — the unit head's act, on
  the month screen); asking for leave (the web has no screen for it either).
- **Unverified on a phone:** `tel:` hand-off to the dialler, the sheet above the keyboard.

### 3f. M6a as built (2026-10-06) — the phones a person is signed in on

Owner, 2026-10-06: the app goes to everyone at once, on PERSONAL phones, for some months. So the half of M6 that matters
now — device control — was built first; push is its own decision (below).

- **Server (migration 0178, additive):** `auth_devices` (one row per person + app install: what the phone says it is,
  first / last seen, last IP) and `auth_sessions.device_row_id`. The app's sign-in carries
  `device: { deviceId, model, os, appVersion }` (`kernel/auth/devices.ts`); a browser sends none and nothing changes for
  it. The id is a LABEL the app makes up at install — never a credential; the server grants nothing for it.
  - **One session per phone:** a phone that signs in again ends its own earlier sessions (`auth.session_revoked`,
    `phone_signed_in_again`).
  - **The cap — DECIDED: 2 phones per person** (`PHONES_PER_USER`). The third is refused AFTER the password verifies
    (409 `phone_limit_reached`, naming the phones that hold the places); it is not a failed attempt and is evented
    (`auth.phone_limit_refused`). An expired session frees its place by itself. A per-person override is not built.
  - **Admin:** `GET /admin/users/:id/phones` and `POST /admin/users/:id/phones/:phoneId/sign-out`
    (`auth.users.manage`). Sign-out ends that phone's sessions in one transaction — the app's next call is a 401 —
    and touches nothing else: password, PIN, the person's browser and other phone stand. Evented
    (`auth.phone_signed_out`, actor = the administrator). Deactivating a person or resetting their password already
    ended every session, phones included; that is unchanged.
  - **Last seen** is stamped when the app asks `GET /auth/me` (every open and unlock).
- **Web:** `/admin/users` → **Phones** on each row (`admin-user-phones.tsx`): model, OS, build, signed in since, last
  opened, IP, and "Sign out this phone".
- **App:** `src/device.ts` (the id lives in the secure store under its own key, so logging out does not make the phone
  look new; model and OS come from the platform — no IMEI, no advertising id, no extra native module); the sign-in sends
  the claim; a signed-out phone returns to sign-in on its next call with a sentence that says an administrator may have
  done it; the third phone is told which phones hold the places; **This phone and my account** (`app/account.tsx`):
  who is signed in and since when, the build, the server, the update check, log out.
- **Unverified on a phone:** what `Platform.constants` reports as the model on real handsets.

**Open owner decisions (M6b and after):**

1. **Push notifications.** `expo-notifications` on Android delivers through Firebase Cloud Messaging: it needs a
   Firebase project and a `google-services.json` in the build (a Google account decision — no Play Store is involved),
   and every alert's wake-up passes through Google. Options:
   - **(a) FCM** — the standard; reliable when the app is closed; the payload can be a bare "open HMIS" with no patient
     text, the app then reads the alert from our server. *Recommended* if the hospital accepts a Google project.
   - **(b) In-app only** — no third party: alerts show while the app is open (a poll, as the queue screens do today);
     nothing reaches a phone in a pocket. Zero setup; weakest.
   - **(c) Self-hosted push (ntfy / UnifiedPush)** — no Google, but a second app or a persistent connection on every
     phone, battery cost, and one more server to run. Not recommended for personal phones.
2. **Screenshots.** Blocking screenshots and the recent-apps preview (`FLAG_SECURE`) is one line per build, but it also
   stops staff sending a screenshot to IT when something breaks. Not built; say which way.
3. **The cap.** Two phones per person is the default; say if it should be one, or lifted for named people.
4. **Hospital-owned phones (later, owner):** when they arrive, the Phones list is how personal phones are retired.

### 3g. M6b as built (2026-10-06) — notifications on the phone, and no screenshots in production

**DECIDED by the owner's delegation, 2026-10-06** — to the three open decisions above: *"go with your recommendations
and keep building the rest. tell me what you want from google firebase and how to get it."* So: **(1) push through
FCM, the payload carrying no patient text; (2) screenshots blocked in the PRODUCTION build, allowed in staging;
(3) the cap stays 2.** The owner supplied the two Firebase files the same day (project `crkmch-hmis-37cc9`), so push
shipped ON, not dormant.

- **What a phone is told** (`kernel/push/phone-push.ts` `phoneMessage`): title `HMIS`, one fixed sentence per category
  and language ("Something needs you. Open HMIS to see it."), and two closed words — `category` (`alert` | `roster` |
  `queue`) and `link` (`home` | `onNow` | `myDuties` | `consult`). The function takes no alert, so there is no argument
  a patient's name, a UHID or a finding could arrive through. Pinned by `push.test.ts`.
- **The feed is the bell.** `alertsManifest` gained `alert.raised → kernel.phone_push`: every row the web bell shows is
  relayed at once to the person's phones. It is NOT a rung of the reach ladder (`notify/reach.ts`), which is untouched.
  Kinds reaching phones today: `escalation`, `respond_overdue`, `manual_notify`, `approval_requested`, `operating_mode`,
  `imaging_chase` (category `alert`, opens home) and `roster_flag` (category `roster`, opens Who is on now).
- **Who is told:** a phone with a LIVE session for that person, an address, and the category not switched off. The
  session join is the guard, so an administrator's sign-out, a deactivation, a password reset and an expired session all
  silence a phone with nobody deleting anything; the address is also cleared on logout, on "Sign out this phone", and
  for every phone on deactivation/reset. One phone, one row: an address arriving on another row leaves the old one.
- **Sender** (`kernel/push/fcm.ts`, no SDK): a signed RS256 assertion → Google access token (cached) → FCM HTTP v1, one
  message per phone, Android channel = category. `UNREGISTERED`/`SENDER_ID_MISMATCH`/404 ⇒ `gone` (address forgotten);
  anything else throws and the dispatcher's own backoff retries (5 attempts), a retry sending only what is missing
  (`phone_push_sends`, unique per alert + phone). 12 per person per hour. Nothing logs, returns or events an address.
- **Key delivery:** env `HMIS_FCM_SERVICE_ACCOUNT_FILE=/run/hmis/firebase/service-account.json` on api + worker
  (compose), a read-only DIRECTORY mount of `$DEPLOY_DIR/firebase`, and `deploy.sh` step 2 copies the owner's key from
  `/root/.config/hmis/firebase/service-account.json` (group `1000`, mode 0440) when it exists. Absent is normal: the
  worker logs ONE WARN ("FCM not configured") and boots; the sender re-checks the file every minute, so a key that
  arrives needs no restart (`push/sender.ts`).
- **Migration 0179 (additive):** `auth_devices.push_token | push_token_at | push_language | push_muted`, and
  `phone_push_sends` (category + phone + outcome; no text, no address).
- **Routes:** the phone's own `GET | PUT | DELETE /auth/phone/notifications` (identity, like the bell; a browser session
  is `not_a_phone`); admin `POST /admin/users/:id/phones/:phoneId/test-notification` (`auth.users.manage`, the fixed
  test sentence, evented `auth.phone_push_tested`); the admin phones list now carries `notifications` per phone and
  `notificationsConfigured`.
- **App:** `src/push-phone.ts` (the edge onto expo-notifications, lazily loaded, every call guarded),
  `src/notifications.tsx` (five states — notInBuild / serverOff / off / denied / on; the offer on the home screen once;
  the foreground banner; a tap opens only a screen the person may open), `app/notifications.tsx` (status, the promise,
  a switch per category the server says is live, turn off). The phone's own prompt opens only after "Turn on".
  Quiet hours — DECIDED: none inside HMIS; the phone's Do Not Disturb is respected. `google-services.json` is copied
  into the build by `build-apk.sh` only when it names the app id; a build without it is the same app, dormant.
- **Screenshots:** `src/privacy.ts` — `preventScreenCaptureAsync` (FLAG_SECURE) in production only; the Account screen
  says which this build is.
- **Admin web:** Phones panel shows "Notifications on / off / not set up on this server" and **Send test notification**.
- **Later (no alert kind exists yet, so nothing was wired):** a cover / swap request addressed to me, "my duty
  changed", the doctor's "patients waiting and you are stepped out". Each needs an `alerts` row first; the phone then
  gets it with no app change (an unknown kind is a plain `alert`).
- **Only a real phone can show:** the system prompt on Android 13+, a notification arriving with the app closed, the
  tray icon, the tap opening the right screen, the banner over a screen, and that a production screenshot is black.

### 3h. M6b fix (2026-10-06, the owner's own phone) — "Checking…" for ever, and deaf to the phone's settings

The owner installed 0.8.0 over an older build and reported two things, both real:

1. **"The notification screen says Checking…", and no test button in the admin panel.** An app updated in place keeps
   its session; a session opened by a build older than 0.7.0 names no phone, so the notification routes answered
   `not_a_phone`, the screen treated every non-200 as "still checking", and the Phones list was empty for a person
   visibly using the app. **DECIDED:** the app LINKS the phone to the session it already holds
   (`POST /auth/phone/link`, `linkSessionToPhone`) instead of signing the person out — same user, same two-phone cap,
   evented `auth.phone_linked`; a session that already names a phone is never moved.
2. **"I allowed it in the app settings; the app still says the same."** Three faults in a row: Android 13+ reports
   `denied` (with `canAskAgain: true`) before it has ever asked, and the app read that as a refusal; the permission was
   requested before any notification channel existed, so the system prompt could not appear; and the permission was
   read once, at sign-in, never again. Now: `permissionOf` (only `canAskAgain: false` is a refusal), channels first,
   and the whole chain is re-read whenever the app returns to the front and on "I have allowed it — check again" —
   if the person asked for notifications and the phone now allows them, the address is fetched and handed over with no
   further tap.

Also: "Checking…" lasts at most 12 s, then names what failed (`unreachable` / `serverError` / `notLinked`, each with
Check again); Google's address fetch times out at 15 s; the Notifications screen carries a **What is working** block
(ten lines, top to bottom — the first that is not Yes is the fault); the admin Phones panel always draws **Send test
notification** for a signed-in phone, disabled with the reason when a test cannot arrive; `build-apk.sh` refuses to
publish a notifications build whose APK lacks `POST_NOTIFICATIONS`, the Firebase messaging service or the Firebase
app id. (All three WERE in 0.8.0 — the manifest was not the cause.) Staging's api and worker do get the Firebase key
(`deploy.sh` step 2 is shared by both targets).

### 3i. Appointments on the phone's Desk One, as built (2026-10-07)

- **Same routes, same guards as the web's appointment stage:** `GET /opd/doctors`, `/opd/rooms`, `/opd/doctors/:id/schedules`,
  `/opd/leaves` (all `opd.masters.read`), `GET /opd/slots` and `GET /opd/appointments` (`opd.appointments.read`),
  `POST /opd/appointments{,/:id/reschedule,/:id/cancel}` (`opd.appointments.manage`), `POST /opd/appointments/:id/check-in`
  (`opd.visits.open`). **No new route, no server change.** The blocks appear only for a login that holds the read; book /
  move / cancel only with the manage permission.
- **Shared, one copy:** `packages/contracts/src/appointment-book.ts` — the web's `lib/appointment-view.ts` moved here
  (it re-exports every name) plus `dayPartOf` out of `desk-one/stages.tsx`; new and pure: `partCounts`, `dayOffer` /
  `sittingWeekdays` (the server's `slotsForDate` order: a scheduled leave closes the day whatever the timetable says),
  `bookedAlready` / `movedAlready`. `appointment-rules.test.ts` fails if either side grows a copy.
- **Book:** department → doctor (unit beside the name, "Sits Mon, Wed, Fri") → day → morning / noon / evening with the
  free count → slot → confirm. The 14-day strip (8 weeks behind "More dates") only EXPLAINS a closed day — leave with its
  reason, or a weekday the doctor does not sit; the server's slot list stays the judge. The first open day is picked; a day
  the screen picked that has nothing free is stepped past, a day the clerk tapped never is.
- **No fee at booking — the web takes none.** The visit and its bill begin at check-in; the screen says so, and reads
  "₹0 (समाज सेवा छूट)" when consultation is switched off. **Nothing is printed or sent for a booking** (the web sends
  nothing either) — the done screen tells the clerk to say the day and time.
- **Check-in:** today's booking becomes the visit (`OpenVisitResult`) and the desk goes to its normal bill stage.
- **Move / cancel:** the same grid with the booking marked; a doctor of another department asks why first (owner
  2026-10-05) and sends the reason; cancel is two acts and a reason.
- **The desk's lists:** today's book (counts, state words — "missed" is the clock's answer — doctor filter, search; a row
  takes the patient in hand) and the bookings a leave has stranded, today forward. The telephone numbers
  (`contact=true`, one audited disclosure each) are read only when that list is opened; Call dials, Re-book opens the move.
- **Never twice, never queued — DECIDED:** these routes take no idempotency key, so a lost answer is settled by READING:
  the patient's appointments are re-read first; if the write landed it is shown and nothing is sent; only otherwise is the
  same request sent again. Until then the choice is locked. Four mutants (no read before re-send, an unlocked choice, a
  check-in re-sent unread, no cross-department reason) each turn a named test red.
- **Deferred, with the reason:** hospital holidays on the day strip (the server's slot rule does not consult the roster's
  holiday list, so neither does the phone — a holiday with a timetable still offers slots, as on the web); "one-tap
  re-book suggestions" (the web has none); the appointment slip / SMS / WhatsApp (the web sends none); the doctor's whole
  day-book for a future date and the leave banner of the web's appointment seat; the week view of `/opd/appointments`.
- **Not verified without a phone:** the keyboard over the reason box, the Call hand-off to the dialler, a real lost answer.

### 3j. Notices built (2026-10-07) — the kinds §3g could not wire, and a chart corrected on the phone

Owner, 2026-10-07, after the test notification arrived on his own phone: *"notification is working. Now move ahead."*
§3g ended on three things nothing raised. They are raised now — as BELL ROWS first (the web bell shows staff names and
duty windows), and the phone relay carries each with no edit of its own. The phone is still told a fixed sentence and
two closed words; `phoneMessage` still takes no alert.

**From roster events** (`kernel/alerts/consumer.ts`, four new subscriptions on `kernel.alerts`; the readers are
`modules/roster/staff-notices.ts`). Each is told to the people it is ABOUT, never to whoever did it:

| Kind | Raised by | Who is told | Opens |
|---|---|---|---|
| `roster_cover_asked` | `roster.cover_requested` | the colleague asked | My duties |
| `roster_cover_answered` | `roster.cover_answered` | the duty's owner, and whoever asked on their behalf | My duties |
| `roster_cover_decided` | `roster.cover_decided` | both parties and the asker; a withdrawal is not told to whoever withdrew | My duties |
| `roster_duty_changed` | `roster.duty_changed` with an amendment | the person whose published duties moved — NOT when the amendment is an approved cover's (decided already said it) | My duties |
| `roster_month_published` | `roster.duty_changed` on a publish | each person with a duty on the published month | My duties |

The requester's note is never read (V9). **Not built:** telling the APPROVER that an accepted cover waits for them —
resolving "who may approve this" is `requireRosterAct`'s question asked backwards; it is the next thing to add.

**From the clock** (`kernel/alerts/notices.ts` `raiseNotice`; ONE scheduler job, `sweepStaffNotices`, every minute).
Nothing happened at these instants, so no event exists to echo; the sweep raises the row under a key that stands
where the event id stands, and the same unique pair absorbs a second tick.

- `roster_duty_reminder` (`sweepDutyReminders`) — **DECIDED:** one reminder an hour before ANY duty, and one twelve
  hours before a NIGHT or a 12-hour-plus duty (a start at or after 18:00, before 06:00, or a take). The twelve-hour one is
  never due between 22:00 and 06:00 IST: it moves EARLIER, to 21:00 that evening. A tick up to 30 minutes late still
  sends; later than that it is dropped. A person already on a duty that runs into the next is not reminded of it.
  Published (`effective`) rows only.
- `opd_not_in` (`modules/opd/queue-nudges.ts`) — a patient has been READY (vitals done) for **10 minutes** and the
  doctor's day is `not_started` or `out`. Repeats at most every **20 minutes**, at most **6** a doctor-day, and stops
  the moment the doctor steps in (the predicate is re-read every tick). Counts and minutes only.
- `opd_long_wait` — a ready patient has waited over **40 minutes**: once per doctor-day, to a doctor who is in too.
- **Vitals bay / slip desk: nothing wired, on purpose.** Candidates looked at and left: "a rested patient's recall is
  due" (the bench already turns the row gold in front of the person at the bay) and "N slips waiting to be
  photographed" (a count that is never zero in clinic hours). Both would be noise to the one person already looking.

**Categories** (`kernel/push/phone-push.ts`): `alert`, `roster`, `queue`, and a new `reminder` — its own switch, so the
first notification a person will want gone can be silenced without silencing "a colleague asks you to cover tonight".
All four are live; a build older than 0.10.0 is not offered the `reminder` switch it has no words for (it still receives
reminders). **A flag is never starved:** `queue` and `reminder` repeat on a clock, so they may use only the first 8 of
the hour's 12 (`PUSH_RESERVED_FOR_ASKS = 4`); the rest is kept for `alert` and `roster`.

**None of these climbs the reach ladder** (`notify/reach.ts` `NOTICE_KINDS`): a notice has no acknowledgement that means
anything, and four hours later the ladder would have relayed a reminder for a duty half done onto WhatsApp and SMS.

**Web bell:** `roster_cover` / `roster_duty` rows open `/roster/my-duties`, `opd_queue_session` rows open `/opd/consult`.

**Amend a saved chart on the phone** (owed since M1 — "use the computer for now"): `src/vitals/amend.tsx`, on the web
bay's own two routes (`GET /opd/vitals/:id`, `POST …/amend`, `opd.vitals.record`) and its own rules — which now live
in the shared `packages/contracts/src/vitals-entry.ts` (`AMEND_KEYS`, `AMEND_REASONS`, `diffOf`, `amendedReadings`; the
web file re-exports them). A copy of the chart, the six preset reasons or a typed one (required), a carried-forward
value needs its re-measure reason, a gate the server raises again is confirmed there, temperature may be typed in °F.
Never queued: a correction that did not reach the server stays on screen and says the saved chart stands.

**App 0.10.0** (0.9.0 was the appointments build, §3i). No migration; no new permission.

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

## 3j. App home — "My day" (owner 2026-10-07, decision 0042) — BUILT

The first screen is no longer the list of screens. Top to bottom: **Needs you now** (cards with a clock in words;
five at most, red first, the oldest clock leading; "See all (n)"), **My day** (three numbers; a cashier's money is
locked until the drawer is counted; the owner's are the hospital's), **Last 30 days** (a line, this week against the
usual week, the best day, the total), the owner's lists (OPD today by department, on duty now), a supervisor's **My
team** card, then **My work** — every screen as before, with a live badge.

- Rules shared with the server: `packages/contracts/src/app-home.ts` (deadlines by kind, tones, ordering, the money
  test, the team roles). App: `src/home/{model,load,sheets,spark,rules}.ts(x)`, `src/screens/seat-home.tsx`.
- Server: `dueAt` on `/approvals` rows; `POST /auth/step-up` and the phone-only step-up gate on approve / reject
  (migration 0181, `auth_sessions.step_up_at`); `GET /me/team`; `series` on `/me/brief` for a month or shorter.
- Approve or decline from the card: required note, fingerprint (or password) first for money, never offline, never
  queued. A cover request is answered Yes / No on the card.
- JavaScript only — no new native module (the line is drawn with Views), so it can travel as an over-the-air bundle.
- Not built: see decision 0042 "Still open". The last home is kept in memory only (lost when the app is closed).
- Walk: `/opt/hmis-context/mobile-tools/{serve-home,shoot-home}.mjs`.

## 3k. App home, round two (2026-10-07, decision 0043) — the board, finished

Round one left parts of the approved board unbuilt. Closed here:

- **Header:** the person's full name and what they are here as (`/auth/me` → `profile`; `src/home/profile.ts`). A bell
  with the unread count opens the alerts list (`app/alerts.tsx`).
- **Front desk cards:** patients I opened still waiting (count, oldest clock), appointments to re-book (due by their
  day), my own request's status (`GET /approvals/mine`; "OK" is remembered on the phone).
- **Scribe cards:** papers a doctor sent back (`GET /opd/paper/sent-back`, with `toType`), papers to type. Typing stays
  on the computer; the card says where.
- **Paper consultations on the phone** (`app/paper.tsx`, `src/screens/paper-consults.tsx`): held lines first; give with
  a reason / do not give (the web's `/correct`), "Looks right", "Ask the desk to re-check" (`/recheck`), the slip viewer.
- **Server, additive (migration 0182):** `paper_recheck_*` on `opd_encounters`, `answer_note` on
  `roster_cover_requests`; `sweepOverdueApprovals` inside `sweepStaffNotices`; push category `approvals` and link
  `approvals`; `?knows=` on the phone-notifications routes.
- **Cover request:** Yes / No open a sheet; "no" needs a reason.
- **A tap lands on its card** (`src/home/focus.ts`); **the last home is kept across a closed app, counts only**
  (`src/home/cache.ts`, SecureStore — no new native module).
- **Still deferred:** long-press app-icon shortcuts (native module → next APK); a phone scribe seat.
- JavaScript only on the phone. Walk: `/opt/hmis-context/mobile-tools/{serve-home2,shoot-home2}.mjs`.

## 3l. Slip desk — several pages in one go (owner 2026-10-07) — BUILT

Owner, 2026-10-07: *"when I am capturing opd prescription photo, after capturing the first image, allow to
capture second image from the same screen, may '+' button would be enough. This will help speed up the work."*

- **The strip.** After the first page is cut ("Use this"), the review shows the pages of this slip in the
  order they will be filed, and a "+" tile. A page is tapped to see it large; Adjust the crop, Retake, ◀ ▶
  and Remove (a second tap confirms) act on the page shown.
- **Back-to-back.** "+" opens the camera and KEEPS it open: shoot, turn the page, shoot, Done. Those pages
  never stop at the crop — each is cut to the corners that were found. A page whose edges were not found is
  the photo as taken, marked "check the corners", and nothing is filed until it has been opened once.
- **DECIDED.** Six pages at most for one slip. One kind for the whole slip; the note rides on the first
  page. Pages can be moved or removed only until the first of them is filed.
- **Filing.** One after another, in the strip's order — the order the server numbers pages in (it counts
  a visit's documents, oldest first; the route takes no page number and no idempotency key, and none was
  added). A failure stops there: the pages before it stay filed and the line says how many; Try again sends
  only what is left. After a LOST answer the retry first re-reads the visit (`GET /opd/visits/by-number`)
  and does not resend a page the server already holds (`src/slips/pages.ts`, `landedUnheard`).
- **Marked consulted once.** The first prescription page closes the visit; later pages answer
  "already marked". The filed card says the first (`paperOf`).
- **Web desk: unchanged.** It keeps "Add a page" after filing; the strip there is a rebuild of its
  capture step, not a small change.
- **No server change, no new native module** — JavaScript only, so it can ride an over-the-air bundle.
- Needs a real phone: the camera staying open between shots, the speed of cutting three pages in a row,
  the thumbnails' memory on a small phone (each is the page's own JPEG).

## 3m. App 0.11.0 — one ordinary update for what had piled up (owner 2026-10-07)

Owner: *"build the app update with the home screen and the Slip desk '+' pages."* Over-the-air updates
(PR #512) were still a draft, so 0.11.0 is an ordinary APK behind the "Update available" prompt.

- **Carries:** app home (#521), app home round two (#526), slip desk several pages (#529), and the phone's
  half of #531 — no RR tile (the shared `tileOrder`), and **"Patient not present — guardian with reports"**
  on a revisit in hand at the bay (`src/vitals/guardian.tsx`, the web's route, list and sentences), the
  guardian tag on the doctor's line and the notice in the brief.
- **Tidied:** the cashier's locked Collected tile reads "After your count" with the receipt count small
  under it.
- **Ordering for the over-the-air lane:** staging is versionCode 13 and production 6 at 0.11.0. The first
  over-the-air-capable APK must be built AFTER this one, from a main that contains it, with a higher
  versionCode in each environment — otherwise phones are offered an older app.
