# Phase 18b — The DICOM seams without the hardware (Radiology series, 2 of n)

**Lane: LIGHT** (5 tasks, no new module, two additive migrations — EXECUTE-METHOD-V3 §2).
**Stop-loss: 1,720,000** = main-session `5 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145; 18a's close cost more than its tasks, §9.7).
**Balance at kickoff: ~14.86M** (§2.141; deltas per task in CLOSE).
**Lane:** `/opt/hmis-lanes/radiology/hmis`, `lane/radiology`, DB `hmis_lane_radiology_test`; `origin/main` at `5feef43`. **One task = one PR** (pathspec commit, push, `gh pr create`, `gh pr merge --squash --auto`); CI is the gate; touched suites only; `tools/lane.sh status` before any full run; rebase each morning and take migration numbers THEN.

## 1. Why this phase

18a is closed and green (3516/3516 on `main`; this lane re-ran radiology + pcpndt at `5feef43`: **23 suites / 320 tests, exit 0**). It left five DICOM-shaped rails with **18b named as their only consumer** (§2). Brainstorm §14's 18b is Orthanc + OHIF + MWL + Drafter — and the storage tier, the modalities' worklist licences and the Drafter's provider are money, procurement and law (§7). So the cut is the hardware line: **everything a modality, a PACS and a drafter need from HMIS ships now, deterministic, with no device, no PACS container and no model call.** 18b-ii (Orthanc, reconciliation, dose SR, RBAC bridge, tiering) follows the rulings.

**Finish line (T5):** one study end to end over HTTP — ordered, scheduled, on the worklist export, acquired with a Study Instance UID, images opened and the view recorded, drafted offline with provenance, signed, published — every row read back. No deploy (prod at 46 migrations; §7's human items).

**18a's open items are not reopened:** F50 (OT lane), F60's residue and `order_items.laterality` (integration lane), the two go-live seeds (a human).

## 2. Ground truth — measured 2026-09-02 at `5feef43`; re-measure at kickoff

| # | rail 18a shipped | where | who reads it today | 18b |
|---|---|---|---|---|
| 1 | `imaging.study_scheduled` ("18b builds its MWL file from this") | `schedule.ts:251,331` | **NONE** — `events.ts`/tests only | T1 reads the TABLE (D1); the event stays for 22c-F, unconsumed |
| 2 | `imaging.study_acquired{accessionNo, imageSource}` ("18b reconciliation") | `acquisition.ts` | **NONE** outside the module | needs Orthanc → 18b-ii; T5 pins the payload |
| 3 | `imaging_studies.study_instance_uid` ("18b writes this") | `schema/radiology.ts:204` | **written by nobody, read by nobody** | T2 |
| 4 | `image_source` ∈ `pacs\|no_pacs_images\|outside` | CHECK `:247`; console hard-codes `"no_pacs_images"` (`radiology-study.tsx:88`) | acquisition only | T2: the console chooses |
| 5 | `image.viewed` (§6.2 "NEW event on 18b's tables") | — | **nothing in the tree** | T3 |
| 6 | `imaging_reports.provenance` ("the Drafter writes `draft` versions with provenance") | `:411` | **nobody** | T4 |
| 7 | `device` resources: `attributes` jsonb, `DEVICE_MODALITY_ATTRIBUTE="modality"`; **no `aeTitle` anywhere** | `kinds.ts`, `resources.ts:133` | scheduling | T1 |
| 8 | `imaging_definitions.kind` is a DB CHECK (`IMAGING_DEFINITION_KIND_VALUES`) | `:349` | definitions | a new kind = migration (T3) |
| 9 | `kernel/inference` = `SpeechClient` + `offlineSpeechClient` only | `inference/types.ts` | speech | the seam SHAPE T4 mirrors, module-local |
| 10 | `draftReport` = `assertReportable(acquired\|reported\|published)` + version insert; lockout runs at prelim/sign/amend, not draft; templates = `technique/findings/impression` | `reports.ts:172,222`, `templates.ts` | report screen | T4 |
| 11 | `PhiSurface` has `imaging.worklist\|study\|report`, `pcpndt.form_f` | `phi/audit.ts:77` | readers | **no new surface** (D6) |
| 12 | 4 roles / 20 permissions; 5 routes; 59 locale keys en+hi; e2e = 4 `it`s | seed-roles, router, e2e | — | +1 permission, +1 role, +0 NAV, STUDY ONE extended (no new `it`) |
| 13 | migrations: `0052` last on `main` and `lane/lims`; pharmacy unpushed | `drizzle/` | — | two numbers, at rebase |

## 3. Spike — answered by reading at kickoff, 0 subagents

- **S1 — a machine identity.** Does the kernel offer a service-account/API-token door (`kernel/tokens.ts`, `kernel/auth`)? If yes the `modality_bridge` role sits on a token; if no, the bridge logs in as a user holding it and the runbook says so. **No auth change either way.**
- **S2 — `updateResource` and `attributes`.** Confirm the kernel export can set `attributes.aeTitle` on a `device` from the registry screen. If not, T1 adds `POST /radiology/devices/:id/ae-title` inside the module; no kernel file.
- **S3 — ANSWERED.** No DICOM library in `package.json`; the export is dcmtk `dump2dcm` text (D1), zero dependencies.
- **S4 — the UID index.** None today; T2's migration adds a partial unique one, numbered at rebase.

## 4. Design decisions — DECIDED; none is money, procurement or law

- **D1 — The MWL is a PULL export, not a worker consumer.** `GET /radiology/mwl?date=YYYY-MM-DD&deviceResourceId=` returns the day's studies in `scheduled|checked_in|ready` for devices carrying an `aeTitle`, as JSON, and with `?format=dump` as one dcmtk dump per study (`(0008,0050)` accession, `(0010,0010)` PN, `(0010,0020)` UHID, `(0010,0030)` DOB, `(0010,0040)` sex, `(0020,000D)` UID, `(0032,1060)` procedure, SPS sequence `(0040,0100)` with AE title, date, time, modality). The bridge on the Orthanc host runs `curl … | dump2dcm` into the worklist directory (runbook). No shared volume, no `worker.module.ts` edit, and a re-pull is idempotent.
- **D2 — AE title lives on the device resource** (`attributes.aeTitle`, S2). A device without one is absent from the export. **A `form_f_required` study is exported only to a registered PCPNDT machine** (acquisition's `assertMachineRegistered`); otherwise the row is withheld and counted. 18a's posture, unchanged.
- **D3 — The UID is minted from the study id.** `2.25.` + the decimal of the study ULID's 128 bits: deterministic, stateless, ≤ 44 chars, needs no registered OID root. It rides the MWL, and `recordAcquired` writes it by default when `imageSource='pacs'`. A no-MWL modality's own UID is accepted if DICOM-valid (`^[0-9]+(\.[0-9]+)*$`, ≤ 64, no leading zeros); a UID on `no_pacs_images` is refused; duplicates refuse at a partial unique index.
- **D4 — `(0010,0040)` is `administrative_gender` mapped M/F/O, never `sex`.** The tag is administrative; `patients.sex` is the clinical marker 18a reads for applicability (22c-A DD4) and does not leave on a worklist. The PN comes from `displayName` (a confidential patient's alias travels, as `worklist()` does). One `recordPhiAccess` per patient on `imaging.worklist` (F42).
- **D5 — PACS settings are a governed definition, not env.** New kind `pacs_settings` (CHECK widened, T3's migration): `{viewer_url_template, enabled}`; only `{accessionNo}` and `{studyInstanceUid}` placeholders, `https://` only. Published through the existing routes and approval; no kernel file.
- **D6 — `image.viewed` is a row, an event and a PHI log line.** `POST /radiology/studies/:id/images/open` (permission: `radiology.reports.read` — F2) refuses `no_images` unless `image_source='pacs'` and a UID exists, refuses `pacs_not_configured` without an active `pacs_settings`, then writes `imaging_image_views{studyId, viewerId, via:'external_pacs', urlHost, viewedAt}`, emits `imaging.image_viewed{studyId, viewerId, via}` (no PHI), logs `imaging.study`, returns the URL; the client opens a new tab. **Consumer in the same PR:** `studyView` lists the views and the study screen shows them. "A shift with zero views" (brainstorm §14) is one query on this table.
- **D7 — The Drafter seam is module-local and its first implementation is a template, not a model.** `ReportDrafter { key; version; draft(facts): DraftProposal }`; `offlineTemplateDrafter` fills `technique` from study type, modality, contrast and dose and leaves `findings` and `impression` EMPTY — a machine never invents a finding. `proposeDraft(tx, actor, studyId)` inserts a `draft` version with `provenance {drafter:'offline_template', version, inputs, at}`, the column's first writer. `findLockoutHits` runs over the proposal; a hit is REFUSED. `signReport` leaves `provenance` on the draft only: the signed document is a human's (§6.8). A model-backed drafter binds here after R4.
- **D8 — `imageSource` is chosen at the console** (`pacs` / `no_pacs_images`; `outside` waits for 18a-iii's register), UID pre-filled from D3, editable for a no-MWL machine.
- **D9 — No hub edit.** Everything is in `modules/radiology`, `kernel/db/schema/radiology.ts` (18a's own file), `screens/radiology-*`, the `radiology` locale sections, `seed-roles.ts` + census, `test/radiology.e2e.test.ts`. No new `PhiSurface`, `AppConfig` key, worker consumer or kernel export. If S1/S2 flip that, the export is a tiny PR routed to the integration lane and the task waits.
- **D10 — Greyscale stays.** The screens gain controls, not a seat language; the seats' design pass is 18a-iii's.

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T1 — CRITICAL · The worklist export
**Files:** `radiology/mwl.ts` (+test), `radiology-mwl.controller.ts`, `manifest.ts` (+`radiology.mwl.read`), `index.ts`, `scripts/seed-roles.ts` (`modality_bridge` = that one permission; `radiographer` holds it too), `test/seed-roles.test.ts` + `test/seed-staff.test.ts`, e2e.
**Assertion book:** the export for device D on IST day X holds exactly D's studies that day in the three statuses, each dump carrying accession, UID and an SPS item with D's AE title; mutant — drop the status filter; input — a cancelled study; kill — 2 rows vs 1. Second: a `form_f_required` study on an unregistered device is withheld; mutant — skip `assertMachineRegistered`; kill — row present. Third: one `phi_access_log` row per PATIENT per pull.
**Commit:** `feat(radiology): modality worklist export — pull route, dcmtk dump, AE title on the device (18b T1)`

### T2 — CRITICAL · The Study Instance UID, written on acquisition
**Files:** `radiology/uid.ts` (+test), `acquisition.ts` (+test), `radiology-acquisition.controller.ts`, `schema/radiology.ts` (partial unique index) + **migration, numbered at rebase**, `web/lib/radiology-api.ts`, `screens/radiology-study.tsx` (+test: source radio, UID field), locales.
**Assertion book:** `recordAcquired({imageSource:'pacs'})` with no UID writes the minted one and the row reads back equal to `mintStudyInstanceUid(studyId)`; with `"1.2.3.abc"` refuses `invalid_study_instance_uid`; a second study given the first's UID refuses at the index; `no_pacs_images` with a UID refuses. Mutant — accept any non-empty string; kill — the malformed one lands.
**Commit:** `feat(radiology): study_instance_uid minted from the study, written on acquisition, unique (18b T2)`

### T3 — CRITICAL · The viewer door and `image.viewed`
**Files:** `schema/radiology.ts` (`imagingImageViews`; kind CHECK) + **migration, numbered at rebase**, `definitions.ts` (body schema), `views.ts` (+test), `radiology-images.controller.ts`, `read.ts` (`studyView.views`), `events.ts` (+`imaging.image_viewed`, census), `index.ts`, `screens/radiology-study.tsx` (+test), api, locales.
**Assertion book:** open on a `pacs` study with active `pacs_settings` returns the templated URL and writes ONE view row, ONE event, ONE PHI row; mutant — record before the refusal; input — a `no_pacs_images` study; kill — a view row for images that do not exist. Second: no active `pacs_settings` → `pacs_not_configured`, zero rows. Third: `http://` or an unknown placeholder cannot be published.
**Commit:** `feat(radiology): images open by accession at the PACS URL; image.viewed recorded, listed on the study (18b T3)`

### T4 — CRITICAL · The Drafter seam, offline
**Files:** `drafter.ts` (+test — the `proposeDraft` tests live there), `reports.ts` (`proposeDraft`), `radiology-reports.controller.ts` (`POST studies/:id/reports/propose`, `radiology.reports.write`), `read.ts` (`ReportView.provenance`), `index.ts`, `screens/radiology-report.tsx` (+test: "Start from template", provenance badge), api, locales.
**Assertion book:** `proposeDraft` on an obstetric USG yields the template's sections, `findings` and `impression` empty, `provenance.drafter='offline_template'`, `findLockoutHits` empty; mutant — the drafter writes "No acute abnormality" into `impression`; kill — a machine finding. Second: after `signReport` the signed version's `provenance` is `null`, the draft's intact.
**Commit:** `feat(radiology): report drafter seam — offline template implementation, provenance's first writer (18b T4)`

### T5 — ROUTINE · The walk, the runbook, the CLOSE
**Files:** `test/radiology.e2e.test.ts` (STUDY ONE, extended: order → schedule → MWL dump names accession + UID → check-in, gates → start → acquired with that UID → open images (URL, view row) → propose (provenance) → sign → publish; every row read back; `imaging.study_acquired` payload pinned), `docs/runbooks/radiology-pacs-go-live.md` (bridge script, AE titles, `pacs_settings` publish, R1–R4 checklist), this doc §8.
**Commit:** `test(radiology): one study end to end through the DICOM seams over HTTP; runbook; 18b CLOSE`

**Verify economy:** per task `pnpm typecheck && pnpm lint`, the named `radiology/*.test.ts`, the e2e, the censuses (T1), `vitest run screens/radiology-*`. CI runs everything.

## 6. Out of scope — named so nobody infers them

Orthanc container, index, DICOMweb, worklist directory; reconciliation / `study.unmatched` and any consumer of `imaging.study_acquired`; dose SR hook; Orthanc authorization bridge; embedded OHIF; tiering, offsite, restore drill; teleradiology; Structured Extractor; model-backed drafter, shadow mode; MPPS; DICOM print / CD; portable no-DICOM flow; 18a's F50, F60 residue, `order_items.laterality`; a file-writing MWL consumer (D1). `imaging.study_scheduled` leaves still unconsumed, for 22c-F.

## 7. Owner rulings — money, procurement, law; none blocks T1–T5

- **R1 PACS storage (procurement + money).** Recommend Orthanc + PostgreSQL index in its own container on the production box (11b on-prem), 2×3.84 TB NVMe + 8-bay nearline (brainstorm §12, ₹2–3L), offsite incremental from day one (O-9, ₹8–15k/month). Gates 18b-ii.
- **R2 Modality worklist option (procurement + money).** Vendors licence MWL/MPPS per modality. Recommend CT and DR now (AMC or PO), USG where supported. Without it a modality still works: the console types the UID (D3).
- **R3 Viewer and monitor (procurement).** OHIF is free (DECIDED); one 3 MP diagnostic monitor ≈ ₹4L.
- **R4 Drafter provider + DPIA addendum (law + money).** Offline only here; a model call is its own phase after the DPIA is signed and a provider chosen (the ruling the Hermes brainstorm also awaits).
**Owner ACTIONS, from 18a:** publish a `pregnancy_policy`; enter the real §19 registration; assign the four role keys.

## 8. CLOSE — filled at execution (in progress, 2026-09-02)

### 8.0 Kickoff — approved 2026-09-02; §2 held at `ceede79` (main gained only the 17c doc)
- **S1 — no service-account door** (`kernel/tokens.ts` is DI symbols; `kernel/auth` has none). The bridge is a USER holding `modality_bridge`, a role of exactly one string; runbook carries it. **S2 — `updateResource` replaces `attributes` whole**; the AE title is set from the registry, no radiology write route. **S3 — as stated.** **S4 — the partial unique index is migration `0053`**; T3's table and CHECK are `0054`. Both taken at rebase; `lane/lims` sits at 0052, pharmacy unpushed.

### 8.1 PRs
#3 the doc · T1 `fb17051` · T2 `65a10d8` · T3 `85f2a56` · T4 — PR numbers when opened; one PR per task, squash, auto-merge.

### 8.2 Findings
- **F1 (T1, D3 amended)** — the UID is `2.25.` + the first 128 bits of SHA-256 over the study id, not the ULID's own bits: fixture ids in this repo are not Crockford-valid and a minter that threw on a test id could not be tested. Still deterministic, stateless, ≤ 44 chars.
- **F2 (T3, D6 amended)** — `RequirePermission` takes ONE string; the images door is `radiology.reports.read` (radiologist, radiographer, referring doctor), not "worklist OR reports". The receptionist holds no images.
- **F3 (T3)** — the "record before the refusal" mutant dies on the happy path's ONE-row count, not on the no-images case: the early write is inside the transaction and the refusal rolls it back. 18a F30's shape — to observe ordering a write must escape the transaction. Recorded, not chased.
- **F4 (T4)** — a batch and a targeted run on the same lane database at once produced a mass fixture failure in the targeted run (every `it` red, zero assertion diffs). §2.165 one lane down: one runner per database, even inside one session.
- **F5 (CI)** — PR-event `core (1)` hung 35+ min on the same SHA whose push-event run passed in 6 min; an earlier PR run failed on `kernel/worker/jobs.test.ts` V12's 60 s timeout on a slow runner. The PAT cannot cancel runs (403); the workflow's `cancel-in-progress` on a new push is the only lever. Not this lane's code.
- **F6 (T1)** — `cancelStudy`'s transition names `radiology_receptionist, radiologist, doctor`; a radiographer cannot cancel. Test used the radiologist. Consistent with 18a's separation, noted so nobody "fixes" it.
- **F7 (files)** — `radiology.module.ts`, `errors.ts` and `README.md` were touched and named in no Files list; disclosed here (the module header authorises the first two, the census test the third).
- **F8 (CI, not this lane)** — the push-event run of the doc commit failed on `kernel/db/schema/lab.test.ts` ("refuses a second ACTIVE tube"): its fixture mints `specimenNo` from `Math.random()` in `[10, 99]`, so two specimens in one test collide about once in ninety runs. The LIMS lane owns it; reported, not taken.

### 8.5 Close review — pass 1 (three FRESH reviewers, read-only, disjoint areas; every finding verified against the code)
**2 CRITICAL · 11 MAJOR (after de-duplication) · 12 MINOR. All fixed in one remediation commit, each fix named by its finding in the code.**
- **CRITICAL A1/C1** — the worklist's `(0040,0002)` date was the UTC day while `(0040,0003)` was IST: a 01:30 IST slot went out as yesterday's date, invisible to a modality filtering by today's date — 18a F52's window, on the export built for the night CT; the test had that exact slot and never asserted the date. Fixed: both IST; the 01:30 slot is pinned by date.
- **CRITICAL C2** — "Start from template" wiped the radiologist's typed findings and impression. Fixed: a proposal fills only the sections a human does not write; a test types first and proposes second.
- **MAJOR** — A2/C8 AE titles unvalidated (17 chars, a backslash → a worklist nobody matches): enforced, named in `malformedAeTitle`; dump values sanitised, PN/LO capped. A3/C11 PHI rows logged for patients whose rows were withheld: only disclosed patients now. A4/C10 `(0008,0090)` carried a user ULID: empty. B1 the drafter used the `full` lockout tier for every study ("USG female pelvis" on a man refused): the human's tier via `lockoutTierFor`. B2 a machine proposal with every clinical section empty was signable as-is: `machine_draft_not_signable`; the human's own draft signs. B3 DAP rendered with a unit the tree never states: not rendered; the unit is 18c's. B4 the doctor's report screen has no images button and the receptionist's console showed one that 403s: `canOpenImages` on the study view drives the button; the doctor's UI path is 22c-F's (recorded). C3 the drafted technique lived only in page state and was dropped on the next save after a reload: the latest unsigned draft seeds the editor. C4 propose was two round trips (a second read, a PHI row, a retry that appended a version): the answer carries the body. C5 the console keyed "acquired" on the UID, so a no-DICOM study still showed the radio: keyed on acquisition. C7 the runbook's bridge emptied every console's worklist on any HMIS outage: directory swap only after a successful pull, login on 401.
- **MINOR** — A5 date rollover (`invalid_date`), A6 D4 now discriminating (fixture sex ≠ gender), A7 Station-AE note in the runbook, A8 idempotency compares the same query, B5 template must parse as a URL, B6 technique names the study TYPE, B7 `proposeDraft` checks actor and permission and records `requestedBy`, B8 route moved, B9 title, B10 titles say what the transaction proves, B11 `setActiveDrafter` off the index, C12 a cleared UID field sends nothing, C13 events ordered by `seq`, C14 stored provenance asserted, C15 exactly two pulls, C16/C17 D5/D6 corrected in place, C18 F7, C19 the migration count, C20 the awk split key.
**Pass 2 (briefed at the fixes, §2.140): below.**

### 8.3 Assertion book as executed
T1 — status filter dropped: 1 failed / 5 passed; registration reader skipped: 1 failed / 5 passed. T2 — accept any non-empty string: 1 failed / 25 passed. T3 — write before refusal: 1 failed / 5 passed (F3). T4 — drafter writes "No acute abnormality." into the impression: 2 failed / 2 passed. Every mutant restored, `diff -q` proved.

### 8.4 Evidence — DB `hmis_lane_radiology_test`, one runner at a time
| task | batch | counts |
|---|---|---|
| kickoff | radiology + pcpndt at `5feef43` | 23 suites / 320 tests, exit 0 |
| T1 | radiology dir + seed-roles + seed-staff + caddyfile-parity + worker-runtime + radiology.e2e | 25 / 319, exit 0; tsc 0, lint 0 |
| T2 | radiology dir + schema/radiology + radiology.e2e | 22 / 309, exit 0; web radiology-*/pcpndt-* 5 files / 24 |
| T3 | same batch | 23 / 315, exit 0; web radiology-study 8/8 |
| T4 | radiology + pcpndt + schema + e2e | see commit; web radiology-*/pcpndt-* 5 / 27 |

§8.5 two fresh review passes, pass 2 briefed at the fixes (§2.140) · §8.6 actuals vs stop-loss — after T5.
