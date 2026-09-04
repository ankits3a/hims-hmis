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
**#52 the doc (MERGED) · T1 #56 (MERGED) · T2 #57 (MERGED) · T3 #59 · T4 #60 · T5 #61.** One PR per
task, stacked (each based on the one below), squash, auto-merge; each retargeted to `main` as the
one below it merged. Migrations `0060`–`0063` after the renumbering (F20).

### 8.7 KNOWN LIMITS, stated rather than discovered later

- **`badgeRegister` is N+1** — one readings query per badge, because the cumulative windows (calendar
  year, rolling five years) are computed in TypeScript rather than in SQL. At the scale this
  register runs (a monitored-worker roster is tens of people, not thousands) that is tens of small
  indexed queries on a screen an RSO opens a few times a month, and the arithmetic is legible in a
  way a windowed SQL aggregate would not be. `complianceCalendar` inherits it through `badgeGaps`.
  **If a later phase puts this on a dashboard that polls, that is the phase that must move the
  arithmetic into SQL** — it is not a bug today and it would be one there.
- **`doseRegisterRows` caps at 200 rows** (overridable by the caller). A date range wider than the
  cap silently returns the newest 200; the screen has no paging. Named because a register that
  quietly truncates is worse than one that refuses, and the fix — a cursor — is a slice of its own.
- **`recordDose` takes no permission of its own**, by design: the authority to record a dose IS the
  authority to perform the examination, which the caller has already checked at its own door
  (`radiology.acquire`). A second permission here would let a radiographer acquire a study the
  register then refused to account for, which is the worst of both.

### 8.8 WHAT IS OWED — named rather than implied

- **The two close-review passes (§8.5), and they are the term that pays.** 18a measured 15 of 16
  fixes incomplete; 18b's pass 2 found 4 INCOMPLETE + 1 WRONG of 25, and paid for itself on C7
  alone. Neither found its CRITICALs by running tests: **3,516 → 3,516 passing tests and every named
  mutant dead found none of 18b's two.** Reading did. This phase is code-complete and has NOT had
  that pass, and nothing below the line should be read as if it had.
- **The four owner rulings of §7** (the RSO and physicist by name, the TLD badge service, the
  investigation level, the QA contract) — none blocks the code, all block the register having
  anything true in it.
- **No deploy.** Production is still at 46 migrations and has never left `commissioning`; 18a and
  18b have not left the lane either.

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

### 8.2 Findings — T4

- **F15 (T1, found by CI not by the lane) — `test/seed-staff.test.ts` pins the role-key vocabulary
  and was in no task's Files list.** `seed:staff` REFUSES a roster naming a key outside
  `KNOWN_ROLE_KEYS`, so until the fix the roster hiring the hospital's RSO — the person AERB
  requires by name before a licence is issued at all — would have been rejected as a typo and the
  WHOLE roster refused. The same shape as 18a's F11, and the fifth census file found this way.
  **The lesson is the batch, not the file:** T1 ran the suites it had touched and the census suites
  it knew about; from T4 on, this lane's batch is `test/` ENTIRE (51 suites, 395 tests) plus the
  modules, which is 20 seconds longer and would have caught it.
- **F16 (T4, D10) — the level is PRO-RATED onto the wearing period, and that is the whole ladder.**
  A quarterly badge reading 1.4 mSv is an ordinary quarter against a 1 mSv/month programme; compared
  against the un-pro-rated monthly figure it is an incident. A register that cried wolf every
  quarter is a register an RSO stops opening, which is a worse failure than a late flag. The mutant
  (`const level = perMonth`) kills six tests.
- **F17 (T4) — Hp(10) and Hp(0.07) are different DEPTHS, and only one is compared.** The shallow
  (skin) dose has its own, far higher limit; measuring it against the whole-body trigger would flag
  a radiographer for a dose the Rules do not consider one. Recorded, rendered, compared against
  nothing here — and a phase that starts comparing it must say so.
- **F18 (T4, D10 sharpened at execution)** — `setInvestigationLevel` REFUSES a level whose annual
  equivalent reaches the statutory single-year limit. A trigger at or above the ceiling it exists to
  warn about never fires; that is a typo, not a policy. Not in the plan; taken here and recorded.
- **F19 (T4, the gap's threshold)** — `badgeGaps` defaults to 120 days, and the test walks BOTH
  sides: at 104 days a badge issued and never read is NOT a gap (a Q1 report typically arrives in
  mid-May), at 134 days it is. A gap list that cried on day 105 would be one an RSO stopped opening.

### 8.3 Assertion book as executed — T4
**Mutant:** compare the period's reading against the MONTHLY level rather than the pro-rated one
(D10's named one). **Result: 6 failed / 13 passed.** Restored; `diff -q` proved identical.

### 8.4 Evidence — T4
| task | batch | counts |
|---|---|---|
| T4 | `src/modules/aerb` + **`test/` ENTIRE** + `src/modules/radiology` | **77 suites / 755 tests, exit 0**; tsc 0, lint 0 errors |
| T4 (web) | full `@hmis/web` suite | **81 files / 663 tests, exit 0** |

### 8.2 Findings — the rebase, and two things it cost

- **F20 — THE MIGRATION NUMBERS MOVED, ALL FOUR OF THEM.** The LIMS lane merged `0059` while this
  lane held it, so `0059→0060 · 0060→0061 · 0061→0062 · 0062→0063`, renumbered branch by branch as
  each merge came up the stack. CLAUDE.md says migration numbers are taken AT REBASE and this is
  what that sentence is for. The journal is one file four branches append to; the conflict is
  mechanical every time and resolving it by keeping BOTH entries and re-indexing is the whole job.
- **F21 — A LANE'S TEST DATABASE CAN SKIP A MIGRATION FOR EVER, AND IT LOOKS LIKE A CODE FAILURE.**
  After merging `main`, ten `lab.e2e` tests failed on `column "applies_to_sex" does not exist` — a
  column the LIMS lane's `0059` adds. **Nothing was wrong with the code.** Drizzle's migrator applies
  entries NEWER than the last one applied; this lane's database had already run the migration that
  was numbered 0059 before the merge, whose timestamp is later than the lab's, so the lab's was
  skipped and would have been skipped for ever. **The fix is to DROP the lane's worker databases**
  (`hmis_lane_<name>_test_1/_2`) and let `setupTestDb` re-migrate: 52 suites / 418 tests, exit 0,
  same commit. **For every lane: after merging main, if a suite you did not touch fails on a missing
  column, drop the lane databases before reading one line of the diff.**
- **F22 — THE SNAPSHOT BASELINE WAS STALE AND WOULD HAVE HANDED THE NEXT LANE F1.** With the four
  migrations renumbered, `drizzle-kit generate` on this branch emitted a migration containing
  **only the LIMS lane's already-applied delta** — F1's mechanism, aimed at whoever generates next.
  Repaired at the top of the stack: `0063_snapshot.json` now carries the TRUE picture of the schema
  (regenerated, with its id and prevId re-stitched into the chain), and `drizzle-kit generate` on
  this branch now says *"No schema changes, nothing to migrate"*. That is the state the next lane
  inherits, and it is the first time in this repo's history that it is true.

### 8.2 Findings — T5

- **F23 (T5) — the calendar's hard part is "which QA record is the LIVE one".** A machine tested
  annually carries last year's record with a date long past AND this year's with a date a year out.
  A `select … where next_due_on < today` shows an inspector a machine overdue for a test it has
  already had — **worse than no calendar**. The latest record per (device, test type) is the one
  with a live date; the mutant that drops the grouping kills exactly the test that says so.
- **F24 (T5) — the badge gap has NO due date, which is why it needed its own leg.** Nothing was
  ever scheduled for it, so it is invisible to every date-driven query in the function, and it is
  the row that means a person is wearing a dosimeter nobody has read. It is always `overdue` and
  its `daysOverdue` is how long that has been true.
- **F25 (T5, D4 restated and pinned)** — an OVERDUE QA leaves the machine `available`. The only
  automatic block in this phase is a FAILED test, because a physicist measured something and said
  so. Asserted directly, so a later phase cannot quietly make the calendar a second lockout.
- **F26 (T5, the walk) — the e2e's `radiographer` holds NO `aerb.*` string, and that is right.**
  The walk's first draft asserted 200 on `/aerb/doses` for them; the e2e mints per-test roles from
  explicit permission lists rather than from `seed-roles`, so the assertion was about the fixture.
  Rewritten as D2's actual claim: a reader holding **exactly** `aerb.doses.read` opens the dose
  register and is 403 on every other AERB route.
- **F27 (T5, the walk again) — the first draft's badge assertion depended on the day it ran.** A
  reading entered for Q1 is stale by September; the walk now passes `onDate=${DAY}` and enters the
  reading for the quarter that closed a month before it. 18a's F28 — *"a test whose correctness
  depends on what day it is run is a test that will fail for somebody who did not write it, on a
  morning when nothing is wrong"* — caught here before CI could find it.

### 8.3 Assertion book as executed — T5
**Mutant:** list EVERY QA record carrying a `next_due_on`, rather than the latest per device and
test type. **Result: 1 failed / 11 passed** — *"shows only the LATEST QA record per device and test
type"*. Restored; `diff -q` proved identical.

### 8.4 Evidence — T5
| task | batch | counts |
|---|---|---|
| T5 | `src/modules/aerb` + `test/` ENTIRE + `src/modules/radiology` | **78 suites / 768 tests, exit 0**; tsc 0, lint 0 errors |
| T5 (web) | full `@hmis/web` suite | **81 files / 669 tests, exit 0** |
| the walk | `test/radiology.e2e.test.ts` | 5 tests, exit 0 — **THE AERB WALK** is the fifth |

### 8.5 Close review — pass 1 (three FRESH reviewers, read-only, disjoint areas)
**4 CRITICAL · 16 MAJOR · 20 MINOR. Every finding verified against the code before it was fixed.**
Areas: A the licence + QA registers and their consumers · B the dose register, the DRL and PHI ·
C the badges, the calendar, the routes and the screen. **Not one of the four CRITICALs was visible
to the suite** — 31/31, 13/13 and 44/44 were green through all of them, and two were pinned BY
tests as the expected behaviour.

**CRITICAL 1 — a QA `pass` released a blocked machine regardless of when it was performed.**
The release condition was `result === 'pass' && status === 'qa_blocked'` and nothing else.
`performedOn` was never compared to the failure it was closing out, so **back-entering the historical
QA book for an inspector — the ordinary act this register exists to support — released a CT that had
failed last week, on a certificate from last year**, and stamped the failure row as cleared by it. A
QA pass is the only exit from `qa_blocked` in the tree, so the release condition IS the control, and
it had no date in it. Fixed: a pass older than the open failure is refused `stale_qa_pass` and
writes nothing; `performedOn` is bounded by the server's IST day (F52's rule, which this file was
not following). The suite could not see it — every release fixture passed a LATER date.

**CRITICAL 2 — the badge cumulative was summed PER BADGE, not per WORKER.**
`aerb_tld_badges_user_active_ux` is a PARTIAL index, so one person legitimately owns many badge rows
over time. A radiographer who read 16 and 12 mSv, lost the badge, was re-issued and read 6 more has
**34 mSv against a 30 mSv statutory ceiling** — and the register showed two green rows, 28 and 6,
neither over the limit, with no flag anywhere. The five-year leg was worse: nobody keeps one physical
badge for five years, so 100 mSv was structurally unreachable. The suite performed the exact
close-then-reissue one test over, and its own title said *"per badge"*. Fixed: every cumulative is
the worker's, across every badge they have ever worn, and the N+1 §8.7 declared is gone with it.

**CRITICAL 3 — a late report could never put its own year over the limit.**
The annual window was `periodEnd` inside the year of *today*. `recordBadgeRead`'s own docstring says
a TLD report arrives weeks after the period it describes — so a Q4 reading entered in February has
`periodEnd` in LAST year, was excluded from this year, and last year was never recomputed. **A year
that went over the ceiling was over it at no instant the system could report.** Fixed: every
calendar year present in a worker's readings is summed and the worst one is carried, whenever its
reports arrived; the screen names that year.

**CRITICAL 4 — the dose register disclosed a confidential patient's legal name.**
It selected `patients.name` raw. Every other patient-bearing surface in this department renders
through `displayName`, so a VIP, a staff member or a police case showed their ALIAS on the worklist
and their legal name and UHID on this register — to every holder of `aerb.doses.read`, which is
every radiographer, none of whom holds `patients.confidential.read`. The disclosure was total, not
partial, and `dose.test.ts` pinned it as intended. Fixed: `displayName` with the reader's clearance,
both directions pinned.

**MAJOR, fixed** — `AerbError` was in no HTTP mapper, so `device_not_licensed` reached the console
as a bare **500** (the mapper's own header says NOT ONE OF THESE IS A 500; eighth family added) ·
**the register could not record a renewal at all**: `licence_no` was globally unique so a
same-numbered renewal was a 500, and a differently-numbered one could not be filed until the old row
was dead — which stops the machine for the rest of December, the exact failure D4 argues against
(fixed: partial unique + `supersedesLicenceId`, both rows in one transaction) · `drlFor` picked a
level by ARRAY ORDER, so the commonest book (CTDIvol *and* DLP for one examination) gave a false
`null` one way round and a false `under` the other (fixed: chosen from what was measured, strictest
wins) · the dose register was **merge-blind** — a merged patient's entire prior history vanished
from the nudge whose purpose is O4's six-CTs patient, and the PHI row was filed under a
non-canonical id · its date range was evaluated in **UTC** against IST examinations, so a 02:15 CT
fell out of its own month (18b's CRITICAL, in a new place) · the calendar's `next_due_on is not
null` filter ran BEFORE the latest-per-group selection, resurrecting a superseded record so a machine
showed **overdue for a test it had a fortnight ago** · every tab printed its all-clear sentence when
the fetch FAILED (`isPending` is false on error) — a compliance screen telling an RSO the hospital is
clean on the strength of a 403 · the inspector's print fired before the widened query resolved, so
the preview captured "Loading…" and an empty table · three raw constraint violations reached the RSO
as 500s, two of them pinned as expected · `/aerb/persons` was the one route trusting its date ·
the badge READINGS were shipped over the wire and rendered nowhere, so a flagged reading vanished the
moment a later normal one arrived · `istToday()` on the screen returned the **UTC** day on an IST
browser (`+330 + getTimezoneOffset()` cancels), so the night radiographer's gap list was a day stale.

**MAJOR, NOT fixed and now declared (§8.8)** — **there is no write surface in the web app at all.**
Every `aerb.registers.manage` route is reachable only by hand-rolled HTTP; §5 T1 said "the Licences
tab lists AND FILES" and it does not. The runbook carries the calls, so a go-live is performable —
but the plan over-claimed and this is the phase's largest open item.

**MINOR, fixed** — the block CHECK said "not a pass" where it meant "a fail" · the MWL licence gate
failed OPEN on a study type absent from the active book · neither `fileLicence` nor `recordQa`
checked the resource's KIND, so a bed could be licensed and render in the inspector's file as a
machine · the gap list dropped a device whose modality was missing or mis-cased — **the machine
nobody finished configuring is the one most likely to be missing its paper** · `2026-02-31` passed
the shape check and died at the INSERT · the concurrent-file race was a 500 where `errors.ts`
promises a 409 · a PHI row was written for a patient with no register rows · `setUTCMonth` rolled
a short month forward and shortened the window · the cumulative nudge computed DAP and fluoroscopy
totals and printed a dash · same-day QA ties broke on physical row order · two docstrings described
behaviour the code did not have.

**MINOR, recorded and not taken** — `appointedPerson` is dead code and its unique index admits two
users in one role · a device leaving `qa_blocked` by a route Plan 29 has not built yet would orphan
its failure row · `recordDose` validates its enums and not its numbers (a 500 for a future source) ·
`FIVE_YEAR_AVERAGE_LIMIT_MSV` is shipped and rendered nowhere · a reading may overlap another's
period if the endpoints differ · the tab list has no `tabpanel` roles.

### 8.6 Evidence — after pass 1's remediation
| batch | counts |
|---|---|
| `src/modules/aerb` + `test/` ENTIRE + `src/modules/radiology`, on freshly created databases | **78 suites / 790 tests, exit 0** |
| full `@hmis/web` | **81 files / 673 tests, exit 0** |
| static | tsc 0, lint 0 errors |

**A lane-wide note:** the full web run failed once on `vitals-bay-stories.test.tsx` (5,017 ms) and
passed alone at 2,665 ms and on the very next full run. That suite is the front-desk lane's and this
lane touched nothing it reads — a wall-clock flake on a loaded box, the shape this repo has recorded
three times. Re-run before searching your own diff.

### 8.5.2 Close review — pass 2 (two FRESH reviewers, briefed at the FIXES, §2.140)
**Verdicts over pass 1's 20 fixes: 11 CORRECT · 6 INCOMPLETE · 1 WRONG · 7 NEW.** One reviewer built
a probe — the pre-fix screen with the new tests, `node_modules` symlinked back — so its headline
findings are MEASURED rather than argued. **This pass paid for itself twice over, and the method's
own number held: one fix in six was incomplete and one was wrong.**

- **WRONG — pass 1's renewal STOPPED THE MACHINE IT WAS WRITTEN TO KEEP RUNNING.** The fix
  surrendered the outgoing certificate the instant the incoming one was filed, so entering the 2027
  licence in November left `activeLicenceFor` returning **null for 20 November** — every ionising
  study on that CT refused from the day the paperwork arrived until 1 January, with no way back
  because `surrendered` is terminal. **Worse than the defect it replaced**, which merely refused to
  record the renewal. Pass 1's own test said *"and the machine never goes dark"* and asserted that
  only BEFORE the renewal. I reproduced it in a throwaway suite before touching anything: `LICENCE
  IN FORCE ON 20 NOV 2026 AFTER FILING THE RENEWAL: NONE`.
  **The invariant was wrong, not the code.** "One active licence per device" is not what a hospital
  has; it has a SEQUENCE of certificates with non-overlapping validity, and *which is in force* is a
  function of the DATE — the question `activeLicenceFor` always asked and only the index disagreed
  with. Migration `0065` replaces the index with "a device cannot hold two certificates that START
  on the same day"; overlap is refused in `fileLicence` under a `FOR UPDATE` lock on the device row,
  which is race-free in a way no partial index could be. `supersedesLicenceId` is gone: a renewal is
  just the next window, filed the day it arrives.
- **WRONG (web) — the print fix could disable the button for ever.** The effect returned early
  whenever the widened file was not here, with no path out on failure; the client is `retry: false`,
  so one 403 left it *disabled and reading "Preparing the file…" for the life of the mount* — a
  print that could never happen, where the defect it replaced at least always printed something.
  Unticking the box mid-flight stranded it the same way. Both proven by the reviewer's probe, both
  now pinned.
- **INCOMPLETE — CRITICAL 4 was half-closed.** `displayName` aliased the name and **the UHID went
  out raw beside it** — the hospital-wide lookup key, which any radiographer can paste into patient
  search to recover the legal name. The finding said "legal name AND UHID"; the fix read half of it,
  and the new test asserted only that the name was absent. The UHID is now withheld with a
  `restricted` flag, the `registration.ts` convention.
- **INCOMPLETE — the dose register dated every row by the UTC day** while the same commit made its
  SELECTION window IST: a CT at 02:15 IST on 1 April was fetched as April and printed as 31 March.
  The register was internally inconsistent about the one fact an inspector cross-checks.
- **INCOMPLETE — the merge chain was walked downward only.** `listMergedLoserIds` walks *down* from
  a winner; asked about a loser it returns `[]`. The caller is the study screen, which passes the
  study's own `patientId` — and a study placed BEFORE the merge carries the LOSER's id, because
  merge never rewrites another module's rows. So the exact case the finding described was still
  split. `resolvePatientId` first now, both here and on the PHI row.
- **INCOMPLETE — `recordQa`'s docstring contradicted its code.** It promised a stale pass "records
  normally and releases nothing"; pass 1 made it throw, which meant that **while a machine was
  blocked its historical QA book could not be entered at all** — the act the CRITICAL's own
  narrative calls the ordinary use of this register. It records and releases nothing now, which is
  what the paragraph always said and is fail-safe in the direction that matters. `stale_qa_pass`
  left the error union with it.
- **INCOMPLETE — the calendar fix deleted a machine from the calendar.** Dropping every null
  `next_due_on` was written for a FAILED test; it did not look at `result`, and the field is
  optional on every result. A PASS entered without one — a typo on the one field nothing validates —
  took the machine off the compliance calendar ENTIRELY. Pass 1's defect with the sign flipped, and
  the more dangerous sign. A pass that scheduled nothing is now a row with no date.
- **INCOMPLETE — the gap list's exclusion was case-SENSITIVE**, and mis-casing is the very bug the
  filter was rewritten to catch: a device configured `"MRI"` was listed as needing an AERB licence.
- **INCOMPLETE — the real-date check landed in one of four files**; `recordQa`'s kind check was
  never added at all (pass 1's finding named both and only one was fixed); and two of the three new
  409s had a pre-read and no `23505` catch, so under the concurrency `errors.ts` invokes by name
  they still escaped as the 500 the codes were added to eliminate.
- **NEW — the walk read the wall-clock year.** `workerYtdMsv` against a fixture reading ending
  2026-07-31: green all through 2026 and **red on 1 January 2027**. Eight lines below it the file
  cites F28 for exactly that. Now `worstYear`, which is a fact about the reading.
- **NEW — four vacuous tests, measured not guessed.** The print test passed against the ORIGINAL
  `setTimeout(print, 0)` (in jsdom the mocked fetch drains through microtasks before a macrotask);
  two QA tests and one licence test passed both before and after. Three are kept as boundary or
  complement guards with honest titles; the print one was replaced by two that fail against the
  regression.
- **NEW — two fixes shipped with no coverage at all**: the DAP/fluoroscopy nudge (the only fixture
  in the tree sets both to null, so both new branches were dead), and four of the six tabs' error
  guard. Both now covered.

### 8.6.2 Evidence — after pass 2's remediation
| batch | counts |
|---|---|
| `src/modules/aerb` + `test/` ENTIRE + `src/modules/radiology`, freshly created databases | **78 suites / 797 tests, exit 0** |
| full `@hmis/web` | **81 files / 683 tests, exit 0** |
| static | tsc 0, lint 0 errors |

**What the two passes cost and bought:** pass 1 found four CRITICALs that 88 passing tests and five
dead mutants did not. Pass 2 found that one of pass 1's fixes was worse than the defect, that a
CRITICAL was half-closed, and that four of the tests written to prove the fixes proved nothing.
**Neither pass found anything by running tests. Both found everything by reading.**
