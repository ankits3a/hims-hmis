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
- **Fonts:** IBM Plex (the web's) lands in M1 via `@expo-google-fonts/ibm-plex-sans`, `ibm-plex-mono` and `ibm-plex-sans-devanagari`. M0 uses the system font plus Android `monospace`.
- **Strings:** `src/locales/{en,hi}.json`. Keys the web also has are copied verbatim. `__tests__/i18n.test.ts` fails if their wording differs from the web's or if en/hi key sets differ.

## 3. Milestones (each: tests, a web-export walk at 360/390/412 read by eye, then a preview APK on a real phone)

| # | Screen | Acceptance |
|---|---|---|
| **M0** ✅ | Scaffold, sign-in, forced password change, fingerprint unlock, seat home, logout, en/hi | 38 jest tests; walk shots read |
| **M1** ✅ | **Vitals bay** (built 2026-10-06, see §3a) | Bench with a doctor filter; three doors (token, UHID, camera scan of a card). Capture BP with `/ - , .` or a space as separator, plausibility, the gate mirrors. Temperature sensed as °F or °C by band and charted in °C. Temperature optional; BP optional under 13 (the server's `requiredFor`). Danger protocol (other arm, class 0, cancel window), rest chairs, emergency save, fee gate in board words. Rules shared with web (#491) as ONE file |
| **M2** ✅ | **Slip desk** (built 2026-10-06, see §3b) | Find the visit (scan, visit number, token as printed, UHID, name), the server's read-back and "check the person", full-screen camera with a lamp, the crop step (page found, four draggable corners with a loupe, Reset, Retake), perspective-straightened page, kind + note, file against the visit with progress; never queued. Detector and warp arithmetic shared with web (#490) |
| M3 | **Doctor OPD queue + patient summary** | My queue now, call next, the patient's vitals/allergies/history card. Read-only consult notes; prescribing stays on the web until a doctor-desk board exists for phone |
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

## 6. Distribution

1. **Internal APK (now):** `eas build -p android --profile preview` gives a link and a QR the owner opens on any Android phone. Allow "install unknown apps" once.
2. **Play Store (after M4):** `eas build --profile production` builds an AAB, and `eas submit` uploads it to a Play Console internal track. Signing keys are generated and held by EAS. Play Console is the owner's account (US$25 one-time fee); package `com.crkmch.hmis`.

### Owner actions, exactly

```
! cd /opt/hmis-lanes/mobile-m0/hmis/apps/mobile && npx eas-cli@latest login
! cd /opt/hmis-lanes/mobile-m0/hmis/apps/mobile && npx eas-cli@latest build -p android --profile preview
```

The first command logs this box into the owner's expo.dev account; it is interactive. The second asks once whether to generate a new Android keystore: answer **Yes**. It prints a link and a QR to install the staging app. Nothing else is needed from the owner for M0.
