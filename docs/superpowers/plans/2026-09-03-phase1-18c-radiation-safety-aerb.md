# Phase 18c — Radiation safety and the AERB registers (Radiology series, 3 of n)

**Lane: LIGHT** (5 tasks, one new kernel-adjacent module, four additive migrations — EXECUTE-METHOD-V3 §2).
**Stop-loss: 1,720,000** = main-session `5 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145; 18b's review term was again the term that paid, §8.6).
**Lane:** `/opt/hmis-lanes/radiology/hmis`, `lane/radiology`, DB `hmis_lane_radiology_test`; rebased onto `origin/main` at `81aadf7`. **One task = one PR** (pathspec commit, push, `gh pr create`, `gh pr merge --squash --auto`); CI is the gate; touched suites only; `tools/lane.sh status` before any full run; rebase before each PR and take migration numbers THEN.

## 1. Why this phase

18a shipped the spine and 18b the DICOM seams; both are closed, green and merged. **18b-ii (Orthanc, reconciliation, dose SR, the RBAC bridge, tiering) is blocked on R1 and R4 — storage procurement and a signed DPIA — which are the owner's, not this lane's.** 18c is the next numbered phase the roadmap ruled (00-INDEX §3: *18a core · 18b PACS · 18c dose/RT*) and it is blocked by nothing: 18a deliberately left the hooks and named them.

**What 18a left, in its own words (§6 THE CONTRACT):** *"Dose facts live on the study … 18c's register is a projection of them plus cath lab's (63) and RT's (64) emitted rows, and this phase writes no register."* · *"18c puts devices into `qa_blocked` and out of it; this phase only honours the status."* 18b added one more: **B3 — DAP was rendered with a unit the tree never states; the unit is 18c's.**

**Finish line (T5):** one ionising study walks with the register watching — the CT carries a live AERB licence or it cannot be acquired; a failed QA record blocks the machine and a pass releases it; the acquired study writes a dose row compared against a published DRL and the patient's twelve-month cumulative is on the screen; a quarterly badge read over the investigation level raises the RSO's row; and one date range prints as the inspector's file. No deploy (prod at 46 migrations; 18a and 18b have not left the lane either).

**18a's and 18b's open items are not reopened:** F50 (OT lane), F60's residue, `order_items.laterality`, the four 18b rulings, the go-live seeds (a human).

## 2. Ground truth — measured 2026-09-03 at `81aadf7`; re-measure at kickoff

| # | what exists | where | who reads it today | 18c |
|---|---|---|---|---|
| 1 | `imaging_studies.dose_ctdivol / dose_dlp / dose_dap / fluoro_seconds / dose_manual` + the CHECK that an acquired ionising study carries one | `schema/radiology.ts:213–270` | the CHECK only — **no register, no reader** | T3 writes a register row from them |
| 2 | `imaging_studies.ionising` (copied from the study type at placement) | `:189` | the dose CHECK | T1's licence gate and T3's register key on it |
| 3 | `device` statuses `available in_use down qa_blocked maintenance retired`; `SCHEDULABLE_DEVICE_STATUSES = [available, in_use]` | `modules/radiology/kinds.ts:54,75` | `schedule.ts:84`, acquisition | **nothing can put a device INTO `qa_blocked`** — T2 |
| 4 | `changeResourceStatus(tx, actor, kinds, id, toStatus, {reason})` | `kernel/resources/registry.ts:358` | OPD rooms | T2's lockout; no kernel edit |
| 5 | `assertMachineRegistered` / `assertPersonRegistered` — a statutory register refusing an acquisition, from a module of its own | `modules/pcpndt/form-f.ts:72` | `radiology/acquisition.ts:157` | **the exact shape T1 copies** for the licence |
| 6 | `pcpndt` — a kernel-adjacent statutory manifest built by 18a for 15b and 62 to adopt without installing radiology (DD1) | `modules/pcpndt/*` | radiology | the precedent D1 follows |
| 7 | `imaging_definitions.kind ∈ study_types, pregnancy_policy, critical_categories, pacs_settings` (DB CHECK), versioned + approval-published | `schema/radiology.ts:102,353` | definitions controller | a new kind `dose_reference_levels` = a migration (T3) |
| 8 | `PhiSurface` has `imaging.worklist\|study\|report`, `pcpndt.form_f` | `kernel/phi/audit.ts:77` | readers | **one new surface** — `aerb.dose_register` (D7) |
| 9 | permission census: `allPermissions` 154, `modelPairs` 297, `modelPermissions` 134, `heldPermissions` 140, `NOT_YET_MODELLED` 14 | `test/seed-roles.test.ts:826,1016,1032,1103,1106` | the census | +3 permissions, +1 role, +1 NAV entry, +1 route |
| 10 | roles today incl. `radiologist`, `radiographer`, `radiology_receptionist`, `modality_bridge` | `scripts/seed-roles.ts` | seed | +`radiation_safety_officer` |
| 11 | no compliance calendar, no staff table (staff are `users`), no scheduler job owned by radiology (the thirteen-job census is untouched) | tree-wide grep | — | T5's calendar is a READ; **no fourteenth job** |
| 12 | migrations: `0058` last on `main` (front-desk lane); lims and front-desk both live | `apps/core/drizzle/` | — | four numbers, each taken at its own rebase |
| 13 | web: 5 radiology/pcpndt screens, 2 NAV entries, routes `/radiology/*` + `/pcpndt/form-f/$studyId`; locales `radiology` (5 sub-keys) + `pcpndt` | `router.tsx:57–61,122–125,594–620` | — | **one** new route, one new locale section |

## 3. Spike — answered by reading at kickoff, 0 subagents

- **S1 — the module boundary.** Confirm `manifests.ts` / `app.module.ts` / `schema/index.ts` admit a new manifest by an append only (as `pcpndt` did in 18a T1) and that no boot-order rule binds it. If a hub edit is larger than an append, D1 falls back to radiology-owned tables and the doc says so before T1 is written.
- **S2 — `changeResourceStatus` from another module.** Confirm it takes the kind declarations as an argument (it does, `:358`) so `aerb` can drive a `device` without importing `modules/radiology`; confirm the occupancy biconditional refuses a release while a study occupies the machine, and pin that refusal rather than working around it.
- **S3 — the study type's `ionising` is on the STUDY row**, not fetched from the type at acquisition (`:189`). The gate needs no join. Verify at kickoff.
- **S4 — the definitions publish path.** Confirm `radiology-definitions.controller.ts` needs only the CHECK widened and the enum extended for `dose_reference_levels` to publish through the existing approval.

## 4. Design decisions — DECIDED; none is money, procurement or law

- **D1 — The registers are a module of their own, `aerb`, not radiology's tables.** 18a's DD1 argued this once already and the argument is the same one: *the inspector reads one register, and the department that held the tube must not have to install radiology to write to it.* The C-arm in the cath lab (63), the LINAC (64) and a mobile X-ray on a ward all owe the same rows. `aerb` is kernel-adjacent, has its own manifest and permissions, and radiology becomes its FIRST CONSUMER — exactly the shape `pcpndt` already runs in production shape. **This is a deviation from brainstorm §4's `radiology.aerb.*` sketch**, taken for the reason §4 itself gives in row 14 of INDEX §5.
- **D2 — Three permissions, one role.** `aerb.registers.read` · `aerb.registers.manage` · `aerb.doses.read`. New role **`radiation_safety_officer`** holds all three (O-13's RSO). `radiologist` and `radiographer` gain `aerb.doses.read` only — the cumulative nudge is clinical, the licence file is not theirs. The receptionist gains nothing.
- **D3 — An ionising study cannot be ACQUIRED on an unlicensed machine, and the worklist withholds it.** `assertDeviceLicensed(tx, deviceResourceId, onDate)` refuses when the device has no `aerb_licences` row `active` and covering the date; `recordAcquired` calls it exactly where it already calls `assertMachineRegistered`, and the MWL withholds and counts the row exactly as D2 of 18b withholds an unregistered PCPNDT machine. **Non-ionising (USG, MRI) is untouched** — AERB licences equipment that emits ionising radiation. O3's *"cannot leave commissioning"* becomes this, because `commissioning` is not a status the `device` kind admits and widening the vocabulary is 29's (BME), not ours.
- **D4 — A QA FAIL blocks the machine; an OVERDUE QA warns and never blocks.** `recordQa(...)` with `result='fail'` calls `changeResourceStatus(→ qa_blocked, reason)` in the same transaction; a later `pass` returns it to `available` and refuses while a study occupies it (S2). An overdue `next_due_on` is a calendar row and a compliance breach on the print — **not** an automatic midnight block, because a machine that blocks itself at 00:00 strands the night trauma CT and no Indian corporate hospital runs it that way. The RSO blocks; the calendar tells them to.
- **D5 — The dose register is a TABLE that radiology writes, not a projection it reads.** `radiation_dose_register` rows are inserted by `recordDose(tx, actor, {...})` from `aerb`'s index, called inside `recordAcquired`'s transaction for every ionising study. Cath lab and RT call the same function later. **`aerb` never reads `imaging_studies`** — that is what D1 exists to prevent — so the caller passes the facts, including the DRL comparison it computed.
- **D6 — DRLs are a governed radiology definition; the comparison is a stored fact.** New `imaging_definitions.kind = 'dose_reference_levels'` (CHECK widened, T3's migration): body maps `{studyTypeCode | modality} → {quantity, value}` where `quantity ∈ ctdivol|dlp|dap|fluoro_seconds`. **The units, stated here once because 18b's B3 left them unstated: CTDIvol mGy · DLP mGy·cm · DAP Gy·cm² · fluoroscopy seconds.** They are constants in `aerb`, rendered beside every number, never inferred. `over_drl` and the DRL value are written onto the dose row at insert; a study whose type has no published DRL stores `null` and is not "under".
- **D7 — The dose register is PHI and says so.** New `PhiSurface` `aerb.dose_register`; one `recordPhiAccess` per patient disclosed, the F42 shape (per-patient, never one row for an N-patient page). The cumulative-per-patient read on the study screen logs against the existing `imaging.study` surface, not a second one.
- **D8 — Cumulative dose NUDGES, never blocks (O4).** `patientCumulativeDose(patientId, months=12)` returns study count and summed DLP/DAP by modality; the study screen shows one line when the count is ≥ 3 or any total is non-zero. No refusal, no approval, no event.
- **D9 — The badge ladder is RECORD-ONLY, like 18a's SLAs.** `tld_badge_reads` carries `hp10_msv`/`hp007_msv` per period; a read at or over the **investigation level** (a governed number, D10) sets `investigation_flag` and emits `radiation.dose_limit_warning{badgeId, userId, period, hp10}` — **no PHI, no scheduler job, no roster change**. The thirteen-job census stays thirteen. The alerting ladder and O2's pregnancy roster gate are Plan 20's, named in §6.
- **D10 — The statutory limits are code constants; the investigation level is data.** AERB / Atomic Energy (Radiation Protection) Rules 2004: **20 mSv per year averaged over five consecutive years, not more than 30 mSv in any single year, 100 mSv in five years.** Those three are named constants in `aerb/limits.ts` with the rule cited beside them and are not editable from a screen. The **investigation level** is institutional policy, so it rides `aerb_settings` (a single governed row the RSO edits, defaulting to 1 mSv per month pro-rated to the read's period) — a hospital that sets it lower must not need a deploy.
- **D11 — One screen, five tabs, one route.** `/radiology/radiation-safety` (`aerb.registers.read`): Licences · QA · Dose · Badges · Calendar. One NAV entry, one route, one locale section `aerb`. The greyscale stays; the seats' design pass is still 18a-iii's.
- **D12 — The inspector's file is a print of the calendar screen's date range**, not a new document rail: licences with validity, the RSO and physicist, QA records, the dose summary, the badge summary. `window.print()` over a print stylesheet, the house pattern; no PDF service, no `kernel/report` CSV (that rail is money reports).

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T1 — CRITICAL · The module, the licence register, and the unlicensed machine
`modules/aerb` (manifest, index, errors, events, http, controller) appended to `manifests.ts`, `app.module.ts`, `schema/index.ts`; `aerb_licences` (device resource, eLORA ref, licence no., type + layout approval refs, validity, RSO user, status `active|suspended|surrendered`, decommission ref) and `aerb_persons` (user, `rso|physicist`, approval ref, qualification, validity, status); `assertDeviceLicensed`; the three permissions, the role, the census bumps. **Consumers in the same PR:** `recordAcquired` refuses an ionising study on an unlicensed device; `mwl()` withholds and counts it; the Licences tab lists and files. **Assertion:** an ionising study on a device whose licence expired yesterday refuses `device_not_licensed`; the same study on a USG device is untouched. **Mutant:** compare validity against `licence.valid_from` only.

### T2 — CRITICAL · The QA register and the lockout that actually blocks
`modality_qa_logs` (device, qa type, performed by/at, `result ∈ pass|fail|conditional`, values jsonb, `next_due_on`, block applied, released by/at, remarks); `recordQa` blocks on `fail` through `changeResourceStatus` and releases on `pass`. **Consumers in the same PR:** scheduling and acquisition already refuse `qa_blocked` — the test proves the whole loop, fail → the diary refuses the slot → pass → the diary accepts. The QA tab. **Assertion:** a release attempted while a study occupies the machine refuses (S2) rather than stranding the occupancy triad. **Mutant:** record the fail without the status change.

### T3 — CRITICAL · The dose register, the DRL and the cumulative nudge
`radiation_dose_register` (source `imaging|cath_lab|rt`, source ref, patient, device, modality, study type code, the four dose quantities + units, `dose_manual`, `drl_value`, `over_drl`, occurred/recorded at); `recordDose` from `aerb`'s index; the `dose_reference_levels` definition kind (CHECK widened); `patientCumulativeDose`; the `aerb.dose_register` PHI surface. **Consumers in the same PR:** `recordAcquired` writes the row in its own transaction with the comparison; the study screen shows the twelve-month line; the Dose tab lists with over-DRL flagged. **Assertion:** an acquired ionising study lands exactly one register row, with the unit rendered and `over_drl` true against a published DRL; a study type with no DRL stores null and is not counted as under. **Mutant:** write the dose row outside the acquisition transaction.

### T4 — ROUTINE · The badges, the periods and the investigation ladder
`tld_badges` (user, badge no., issued/returned, status) and `tld_badge_reads` (badge, period start/end, Hp(10), Hp(0.07), reported on, vendor ref, `investigation_flag`); the three statutory constants; `aerb_settings` for the investigation level; the YTD and five-year rolling reads; `radiation.dose_limit_warning`. **Consumers in the same PR:** the Badges tab, with **the badge period that has no read at all** as its own row — the brainstorm's negative-space question, one query. **Assertion:** a 1.4 mSv quarterly read against a 1 mSv/month level does not flag; the same read against a level set to 0.4 does; a badge with no read for a closed period appears in the gap list. **Mutant:** compare the period read against the ANNUAL limit.

### T5 — ROUTINE · The calendar, the inspector's file, the walk, the CLOSE
The Calendar tab (licence expiry, QA `next_due_on`, badge periods with no read, person approval expiry — each `ok|due|overdue`), the print stylesheet, one e2e walk through the whole of §1's finish line, the runbook paragraph, §8 filled, and **two fresh close-review passes, pass 2 briefed at pass 1's fixes** (§2.140 — 18a measured 15 of 16 fixes incomplete, 18b 4 INCOMPLETE + 1 WRONG of 25; the term pays every time).

## 6. Out of scope — named so nobody infers them

O2's pregnant-radiographer roster gate and any duty reassignment (Plan 20 roster) · the alerting/escalation ladder and any scheduler job (18a-iii) · room shielding survey workflow and its sign-off (O5 — a calendar row here, the workflow later) · brachy source custody and `source.moved` (O6 → 64) · LINAC/RT fractions and cath-lab dose emission (63/64 call `recordDose`; neither exists) · decommissioning workflow beyond the licence's own fields · eLORA submission/filing integration (a portal, not an API) · TLD vendor file import (T4 takes typed reads; a CSV import is a later slice) · dose SR from the modality (18b-ii) · staff radiation training records and signage evidence (28 quality) · patient dose from outside studies · 18a's F50/F60 residue and `order_items.laterality`.

## 7. Owner rulings — money, procurement, law; none blocks T1–T5

- **R1 The RSO and the medical physicist, by name (law + appointment; O-13).** Recommend the 24×7 radiologist as PCPNDT sonologist-in-charge (already owed from 18a) and a **senior radiographer as RSO with AERB approval**, a visiting medical physicist on contract for QA. The register needs a user to point at; the code ships without one and the tab is empty until it exists.
- **R2 TLD badge service (procurement + money).** A BARC/AERB-accredited TLD lab, quarterly, per monitored worker — roughly ₹300–600 per badge per quarter. The register accepts typed reads either way; without a contract the Badges tab is a gap list of everybody.
- **R3 The investigation level (policy, and it is the owner's to set).** Recommend 1 mSv per month pro-rated per period (D10's default). Lower is legal and more conservative; the number is data, not a deploy.
- **R4 QA contract and its calendar (procurement + money).** Quality-assurance testing of each X-ray unit by an approved agency, and the periodicity the licence conditions state. The calendar renders whatever periodicity is entered.
**Owner ACTIONS still open from 18a/18b:** publish a `pregnancy_policy`; enter the real §19 PCPNDT registration; assign the four role keys (now five, with `radiation_safety_officer`); the four 18b rulings (PACS storage, MWL licences, viewer + monitor, Drafter/DPIA).

## 8. CLOSE — filled at execution

### 8.0 Kickoff — 2026-09-03; §2 measured at `81aadf7`, the lane rebased onto it

- **S1 — ANSWERED, a new manifest is three appends.** `kernel/modules/manifests.ts` (import + one entry in `ALL_MANIFESTS`), `app.module.ts` (import + one entry in `imports`), `kernel/db/schema/index.ts` (one `export *`). `pcpndt` took exactly these in 18a T2/T6 and `manifests.ts:157` records that **order matters — a module that others reach into is listed before them**, so `aerbManifest` goes BEFORE `radiologyManifest` and reaches into nothing. D1 stands; no fallback needed.
- **S2 — ANSWERED, and it is better than hoped.** `changeResourceStatus(tx, actor, kinds, id, toStatus, {reason})` takes the kind declarations as an argument, so `aerb` drives a `device` without importing `modules/radiology` — it imports `RADIOLOGY_RESOURCE_KINDS` from radiology's index only for the declaration, which is a value, not a table. And `registry.ts:406` already refuses moving a resource OFF its `occupied` status while the triad is set (`already_occupied`): **a QA block attempted mid-acquisition refuses by construction**, which is T2's assertion rather than T2's bug.
- **S3 — ANSWERED.** `imaging_studies.ionising` is SNAPSHOTTED at creation (`schema/radiology.ts:189`, and the comment says why: a republished definition must not retroactively make an acquired study illegal). D3's gate reads the study row; no join, and no exposure to a definition edit.
- **S4 — ANSWERED.** `radiology-definitions.controller.ts` derives its zod enum from `IMAGING_DEFINITION_KIND_VALUES` in two places (`:31`, `:85`), so `dose_reference_levels` needs the const extended and the DB CHECK widened, and the approval/publish path is inherited unchanged.
- **The precedent T1 copies, named:** `assertMachineRegistered` (`modules/pcpndt/form-f.ts:72`) — an active registration whose validity window contains the date, returning the row so the caller does not read it twice — and `pcpndt_registered_machines`' `uniqueIndex … where active = true`, which is the index that makes "one active licence per device" a database fact rather than a query convention.

### 8.1 PRs
#52 the doc · T1 — PR number when opened; one PR per task, squash, auto-merge.

### 8.2 Findings

- **F1 (T1, the migration) — `drizzle-kit generate` swept up TWO OTHER LANES' MIGRATIONS.** The
  generated `0059` carried `ALTER SEQUENCE uhid_seq` (already applied by 0057) and
  `entitlement_counters.unit` (already applied by 0058), because both of those were hand-written by
  the front-desk lane without regenerating the drizzle snapshot — so the generator's baseline was
  `0056` and it re-derived their deltas as if they were mine. Both statements were removed by hand
  and the reason is written into the migration's header; `0059_snapshot.json` is kept as generated,
  because the schema files it was read from do carry those two changes. **For every lane: a
  generated migration on this repo must be READ before it is committed, not trusted.**
- **F2 (T1, D3 amended) — `imaging_studies.ionising` IS NOT WRITTEN UNTIL ACQUISITION, so the
  worklist gate keyed on it never fired.** The schema's own comment says the flag is "snapshotted
  from the study type at creation" and §3's S3 repeated it; 18a's F18 actually writes it inside
  `recordAcquired`. Every row a worklist carries is `scheduled`, where the column still holds its
  `false` default — so the first version of the MWL withholding **offered the unlicensed CT anyway**
  and the test that caught it was the one that surrendered a licence and re-pulled. The export now
  reads the active study-type book (once per pull, not per row), which is the source
  `startAcquisition` reads for the same decision. `startAcquisition`'s own gate was never affected:
  it already loads the study type. **The lesson is 18a's F18 in a new place — a column whose writer
  runs later than its reader is a gate that is not there.**
- **F3 (T1, ordering, recorded not changed)** — DD12a's money gate runs BEFORE both statutory gates,
  so a routine self-pay ionising study on an unlicensed machine is refused `payment_required` and
  the licence is never reached. 18a chose that order for PCPNDT and it is left alone: the machine is
  blocked either way, and a counter told "unlicensed" before "unpaid" is told about a problem it
  cannot fix. Named here so nobody "fixes" it.
- **F4 (T1, the fixture) — `setupRadiologyFixture` now files AERB licences**, and that is a
  disclosed edit to a helper in no task's Files list (18a's F23 pattern). It models a working
  hospital: the X-ray and CT units carry a licence, the USG and MRI carry none because AERB licences
  neither. `opts.unlicensedModalities` is the negative, so a suite proving the refusal has the
  licence MISSING rather than revoked — the state a hospital that never filed is actually in.
- **F5 (T1, the worker)** — `aerb` is installed in `app.module.ts` and NOT in `worker.module.ts`:
  the `desk` shape, not the `pcpndt` one. Nothing in the worker asks `hasPermission` about an
  `aerb.*` string (the licence gate is on an HTTP path; radiology's `order.placed` consumer touches
  the PCPNDT register and not this one). `manifests.test.ts` (1i) pins the difference.
- **F6 (T1, the README)** — the three `aerb.*` rows joined the EXISTING radiology grant table with a
  sixth column rather than taking a table of their own, so `NON_TABLE_PAIRS` did not move. The
  register is its own module; the README table is a grant grid, and splitting it would have made the
  RSO's three grants harder to read, not easier.

### 8.3 Assertion book as executed — T1
**Mutant:** `activeLicenceFor` compares against `valid_from` only (the lapsed-licence mutant, D3's
named one). **Result: 2 failed / 21 passed** — `2027-01-01 → licensed = false` and
`assertDeviceLicensed refuses a lapsed licence by name`. Restored; `diff -q` proved identical.

### 8.4 Evidence — DB `hmis_lane_radiology_test`, one runner at a time
| task | batch | counts |
|---|---|---|
| T1 | `src/modules/aerb` + `src/modules/radiology` + `src/modules/pcpndt` + seed-roles + caddyfile-parity + nav-parity + radiology.e2e + `src/kernel/modules` | **34 suites / 407 tests, exit 0**; tsc 0, lint 0 errors (2 pre-existing warnings) |
| T1 (web) | full `@hmis/web` suite | **81 files / 650 tests, exit 0** (7 of them new: `radiation-safety.test.tsx`) |

### 8.2 Findings — T2

- **F7 (T2, the seam D1 nearly broke) — `aerb` CANNOT import `RADIOLOGY_RESOURCE_KINDS`, and the
  kernel already had the answer.** The QA lockout drives a `device` through `changeResourceStatus`,
  which needs the kind's vocabulary — owned by radiology's manifest. Importing it would have made a
  cycle out of a statute (radiology → aerb for the licence gate, aerb → radiology for the kinds) and
  §3's S2 blithely proposed exactly that. It is not needed: `changeResourceStatus` takes the
  declarations as a PARAMETER, deliberately (`registry.ts`'s header says why that is *"a parameter
  and not a global"*), so `recordQa` takes them too and the CONTROLLER resolves them from the
  installed `ModuleRegistry` through the kernel's own `collectResourceKinds`. One source of truth,
  no second copy of the `device` vocabulary, no cycle. **The test file may import them and does** —
  that is the same direction the running system uses; `index.ts` is the wall, not the test.
- **F8 (T2, D4 confirmed by the kernel rather than by this module)** — a FAIL on a machine that is
  mid-examination REFUSES (`already_occupied`, from `registry.ts:406`) and the QA record rolls back
  with it. The refusal is deliberately not caught: a register that recorded a failure while the
  kernel refused the status change would say a machine was stopped when it was not. §3's S2 called
  this "T2's assertion rather than T2's bug" and it held.
- **F9 (T2) — a PASS releases ONLY a machine THIS register stopped.** A device in `down` (broken
  tube) or `maintenance` (engineer's visit) carries somebody else's status, and a passing phantom
  test does not mean the tube was replaced. Pinned both ways.

### 8.3 Assertion book as executed — T2
**Mutant:** record the failure, skip the status change (D4's named one — the row looks right, the
inspector is satisfied, and the CT keeps taking bookings). **Result: 6 failed / 6 passed.**
Restored; `diff -q` proved identical.

### 8.4 Evidence — T2
| task | batch | counts |
|---|---|---|
| T2 | `src/modules/aerb` + radiology + pcpndt + seed-roles + caddyfile-parity + radiology.e2e + `kernel/modules` + `kernel/resources` | **38 suites / 468 tests, exit 0**; tsc 0, lint 0 errors |
| T2 (web) | `radiation-safety` + i18n parity | **11 tests, exit 0** (10 in the screen suite, 3 of them new) |

### 8.2 Findings — T3

- **F10 (T3, D5 held and it mattered)** — the obvious build is a VIEW over `imaging_studies.dose_*`,
  and 18a's own §6 promised 18c "a projection of them". D5 refused the projection and the refusal
  paid immediately: `radiation_dose_register` is written by `recordDose` from inside the SOURCE's
  transaction, so the cath lab (63) and radiation oncology (64) call the same function against a
  procedure and a fraction, and `aerb` still reads nothing of radiology's. The unique index on
  `(source, source_ref)` also closes, at the database, the double-count 18a's own A6 comment names.
- **F11 (T3) — `null` is not `false`, in three places at once.** An examination with no published
  reference level, and one whose level is set on a QUANTITY the study did not carry (a DLP measured
  against a CTDIvol level), both store `over_drl = null`. A verdict of "under" would be a claim of
  compliance nobody measured. It is enforced at the CHECK (quantity, level and verdict travel
  together or not at all), in the writer, and on the screen, which renders three states rather than
  two. The mutant that survives everything else is `(measured ?? 0) > level.value`.
- **F12 (T3, D6) — the DRL book does NOT throw when it is unpublished.** `activeStudyTypes` throws
  `definition_not_active` because a hospital with no study-type book cannot scan at all; copying
  that here would have made "the RSO has not published the reference levels yet" into "no CT may be
  acquired", which is a rule nobody wrote. `activeDoseReferenceLevels` returns an empty list.
- **F13 (T3, the units 18b left unstated)** — `aerb/units.ts` names them once: **CTDIvol mGy · DLP
  mGy·cm · DAP Gy·cm² · fluoroscopy seconds**, and the client transcribes the same table. 18b's
  close review MAJOR B3 found DAP rendered with a unit the tree never declared and ruled the units
  18c's; this discharges that.
- **F14 (T3, D8/O4)** — the cumulative nudge NEVER refuses. Pinned by a test that records a seventh
  CT for a patient with six over-DRL examinations behind them, and by a screen test that asserts the
  line is not even an `alert`. A reader without `aerb.doses.read` sees NO line rather than an error:
  a permission they do not hold is not a problem they can fix, and an alert about it on a study
  console is noise at the moment a radiologist is reading a scan.

### 8.3 Assertion book as executed — T3
**Mutant:** a published level with no matching measurement stores `over_drl = false` instead of
`null` (`(measured ?? 0) > level.value`). **Result: 1 failed / 32 passed** — *"a level on a quantity
the study did not carry stores NULL, not `under`"*. Restored; `diff -q` proved identical.

### 8.4 Evidence — T3
| task | batch | counts |
|---|---|---|
| T3 | `aerb` + radiology + pcpndt + seed-roles + caddyfile-parity + radiology.e2e + `kernel/modules` + `kernel/phi` | **36 suites / 442 tests, exit 0**; tsc 0, lint 0 errors |
| T3 (web) | full `@hmis/web` suite | **81 files / 660 tests, exit 0** (10 more than T1's run) |
