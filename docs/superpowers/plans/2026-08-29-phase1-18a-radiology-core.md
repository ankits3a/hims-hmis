# Plan 18a — Radiology & Imaging, the CORE (no PACS)

**Written 2026-08-29 on the build host, in Lane B of a two-lane authoring fork (Lane A is authoring Plan 17 / LIMS in the same checkout at the same time). NOT APPROVED FOR EXECUTION — execution is a separate session with its own approval, exactly as Plan 17 phase 0 was.** The seed that produced this document is [`2026-08-29-LANE-B-plan-18a-radiology-AUTHOR-PROMPT.md`](2026-08-29-LANE-B-plan-18a-radiology-AUTHOR-PROMPT.md); its §4 (the four shared files) is restated once, in the EXECUTE-PROMPT §4, and nowhere else.

**The question this document rules.** The radiology brainstorm ([`../brainstorms/2026-08-27-department-series/01-radiology-imaging.md`](../brainstorms/2026-08-27-department-series/01-radiology-imaging.md) §14) made 18a conditional on three gates: *"17's order envelope shipped; Plan 15's Form F table shape frozen; PCPNDT registration documents on file."* The first is discharged — the envelope is live in production (prod 46 migrations, deployed 2026-08-29) with zero consumers waiting for a first claimant. The second is discharged **by absence**: Plan 15 shipped no Form F table (`apps/core/src/kernel/db/schema/ot.ts:87` lists `form_f` among the gate kinds *"deliberately absent: 15b/15c/15d own them"*, and 15b is unauthored), so there is nothing to adopt and the brainstorm's "adopt, do not fork" instruction has no object. The third is the owner's (§4A). So the question is no longer *whether* 18a may be authored but *what shape its first slice takes* on an envelope that already exists and a statutory table that does not.

**THE RULING, in one paragraph.** 18a is **the spine — one imaging study walks end to end through the real seams**: a doctor (or a walk-in slip) places an `imaging` order on the kernel envelope by adding ONE manifest field; the reception schedules it against a modality `device` resource with a slot the database refuses to double-book; the patient checks in and passes a declared set of safety gates, each a child workflow instance transcribed from Plan 15's DD5; the technologist starts acquisition, which occupies the device and moves the envelope item to `in_progress`; the acquired study carries its accession number, dose and contrast facts, and emits `imaging.study_acquired`; the radiologist drafts, signs under a fresh second factor, and publishes an immutable versioned report, which completes the envelope item and closes the order. **PCPNDT is structural in this slice, not optional**: the module `pcpndt` — a kernel-adjacent manifest of its own, built HERE and adopted unchanged by 15b and 62 — holds registrations, registered machines and persons, and a gap-free Form F register; an applicable ultrasound is `restricted` at placement, its Form F gate can be neither waived nor overridden by anybody, and the scan cannot reach `acquired` without a recorded Form F. **No PACS** (18b), **no AERB/dose registers** (18c), and the rest of the brainstorm's §14 list — monthly returns and inspections, contrast reaction/ADR chain, portable ward rounds, teleradiology, the release desk, outside-study register, KPIs and automations — is named in §1.3 and §6.9 as the follow-on slices this spine makes buildable, so 18b does not find a half-PACS and nobody finds a half-register.

**Roadmap:** [`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md) — Track A, `17 → 18a`. **Numbering:** [`00-INDEX-AND-SYNTHESIS.md`](../brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md) §3 (18a core · 18b PACS · 18c dose/RT; 63 cath lab; 64 RT; 62 maternity consumes Form F via `pcpndt`). **Envelope contract inherited, not restated:** [`2026-08-29-phase1-17-order-envelope.md`](2026-08-29-phase1-17-order-envelope.md) §6 (the seven sentences), §6A (the eight things it does not do), §8 (what it froze), and its §4.1 for a column name. **Brainstorm argued from and not restated:** 01 §1 (scope table row 2 — *"radiology owns the imaging-specific tables hanging off the order"*), §3 WF-IMG-01/02/03/05 (the spine's four workflows), §4 (the table sketch), §5 (the 120-row catalogue — §7 below draws from it), §13 (owner rulings O-1..O-13), §14, §15.1/§15.2.

**Slot:** the repo journal carries **46** entries (`0000`–`0045`), measured 2026-08-29 17:50 UTC — `0045_order_envelope_integrity` is phase 0's close-pass migration. **This phase writes `0046`.** That number is a MEASUREMENT, not a reservation: **Lane A wants the same number**, and whichever lane generates second re-measures, takes the next free one, and renumbers NOTHING already pushed (protocol §7; EXECUTE-PROMPT §4).

**Executor seed (v3 §1):** read this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — **which sits at line 1485 as of today; the phase-0 seed's 1323 is stale, and a phase has already paid for exactly this pointer. Measure it: `grep -n '^## 5' docs/superpowers/plans/reports/EXECUTION-LESSONS.md`.** Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: **407,657 bytes ≈ 102k tokens**, re-billed on every tool call (v3 §9.1). Entries cited by number where they bite: §2.54 (one list, one owner), §2.115 (fresh, not resumed), §2.131/§2.138 (grep the sibling for the places that NAME it, grep the LIST for the places that COUNT it), §2.137 (name the test database), §2.140 (the second reviewer is not optional).

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Nine tasks, one migration, two manifests, five screens, two workflow definitions, one statutory register. That is the shape of Plan 15 (nine tasks, LIGHT, 463,509 on two fresh reviewers, not breached) and of Plan 14 (nine, LIGHT), both full-module spines coded in-session — v3 §2's "≤8 tasks" is a guide and this phase is the same shape as the two that set the guide's working ceiling. HEAVY is reserved for phases whose breadth exceeds one context; this one is a single module plus a small adjunct, and the two reviewers are where its verification depth lives. **Seven of the nine tasks are CRITICAL** (permissions, concurrency on a slot, a statutory gate with no override, money-adjacent facts, an immutability seam under a second factor, a confidentiality-bearing worklist), and CRITICAL means executed mutants in either lane.

**The main session codes task by task** under AGENT-RULES, runs `pnpm typecheck && pnpm lint` before every verify (§9.9 rule 6), folds code-complete tasks into one verify per batch (rule 4), takes its own test databases and NAMES them (§9.9 rule 8), watches CI by full SHA, and closes with reviewers **spawned FRESH** (§9.5, ledger §2.115). The close reviewer is briefed at the operands (§9.7): *for every gate, name the row `evaluateReadiness` reads and the write that would satisfy it without a human; for the Form F gate, name every code path from `checked_in` to `acquired` and show the one that does not call `assertFormFRecorded`; for the worklist, name one row an alias would leak and one row a restricted flag would not hide.*

### Stop-loss (v3 §6): **736,000 tokens**, arithmetic shown

`stop-loss = 1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`

- **Per-task rate — 20,178**, Plan 16a's LIGHT baseline ([`../pipelines/token-baselines.json`](../pipelines/token-baselines.json), phase `16a`: 181,605 / 9), carried by 14, 22c-A and 17 phase 0. Restated bias: for a LIGHT phase `subagentTokens` IS the reviewer, so this is a review cost in execution clothing; main-session cost is unmeasurable from inside (runbook O3).
- **Task term:** `1.5 × (20,178 × 9) = 272,403`.
- **Review term — TWO FRESH passes: `271,994 + 191,515 = 463,509`**, Plan 15's measured pair — the closest comparable (a nine-task module spine with gates, a state machine and money-adjacent facts), and larger than 17 phase 0's 348,043 because a module has more surface than a seam. Two, not one: on phase 0 the second pass found a live confidentiality leak the first pass's own fix had created (§2.140); on 15 both reviews found a CRITICAL after verify and CI were green.
- **Total: 735,912 → 736,000.**

A clean single-pass close lands near 545,000 — expected, not a saving.

### Context budget (v3 §9.2), measured before compiling

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | 84,969 at write time (re-`wc -c` at kickoff) | ≈ 21,200 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only (from line 1485, ~15 lines) | ≈ 3,800 | 950 |
| `modules/ot/gates.ts` (the gate precedent T5 transcribes) | 23,026 | 5,757 |
| `modules/ot/workflow-def.ts` (the definition precedent T2 transcribes) | 10,075 | 2,519 |
| `kernel/orders/place.ts` (the seam T3 mounts) | 14,288 | 3,572 |
| **NOT pointed at:** the ledger in full | 407,657 | **101,914** |
| **NOT pointed at:** phase 0's document in full (read §4.1/§6/§6A/§8 by line) | 112,649 | **28,162** |
| **NOT pointed at:** the radiology brainstorm in full (§7 already drew from §5) | 93,014 | **23,254** |

**Per-agent context carried: ≈ 41,000 tokens.** A reviewer is pointed at a task's OWN section (v3 §9.1 rule 2), not at the document whole.

---

## 1. Why this phase

### 1.1 The seam exists and nobody has claimed it

`apps/core/src/kernel/orders/parity.test.ts` pins the claimed kind set as **`[]`**. `kinds.ts`'s own header says the sentence this phase satisfies: *"`imaging` is a legal string and is not a kind THIS HOSPITAL HAS until Plan 18a installs the manifest that claims it."* The `R` counter (`radiology_order`) has sat unused in `kernel/episodes/series.ts` since 2026-08-25; `orders.indication` exists on the envelope *"required per kind decl (radiation justification, 18a)"*; `order_items.restricted` was put there for HIV, the exposure-protocol source test **and the PCPNDT-class ultrasound**. Four things in the kernel were built for this module and it does not exist: `ls apps/core/src/modules | grep -c 'radiology\|pcpndt\|imaging'` → **0**.

The doctor cockpit today writes `advised_tests` (07d DD4/DD7) and nothing converts it; a chest X-ray advised on Friday is a line in a jsonb column. The hospital's modalities are not resources (`grep -rn 'kind: "device"' apps/core/src --include=*.ts | grep -v test` → **0** claimants of a kind the CHECK already admits), so there is no place to say a CT is down. There is no Form F anywhere in the tree (`grep -rn form_f apps/core/src` → two lines, both saying it is absent).

### 1.2 Why THIS slice — DECIDED

Brainstorm §14's 18a paragraph is ~15 tables, eight workflow definitions, four statutory surfaces, four automations and a downtime kit under one letter — Plan 15's R-3.4 measured that shape at *three phases* and split it (15/15b/15c/15d), and the owner accepted the split. The same arithmetic applies here, and the cut is the one that leaves every follow-on slice a **whole thing to build on rather than a half thing to finish**: the spine is what one real study walks; everything in §1.3 is a register, a queue or a channel that HANGS OFF a study that already exists. PCPNDT stays in the spine because the brainstorm's frame says so in as many words (*"PCPNDT machinery in scope, not optional"*) and because the decisive edge case — N2, the 02:00 ectopic scan — is a property of the acquisition path, not of a register: it must be true from the first study or it is never true.

### 1.3 What this phase does not do — named, so a successor finds a whole thing

- **No PACS, no DICOM, no MWL, no viewer, no `image.viewed`, no Drafter** — 18b. The study carries `accession_no`, `study_instance_uid` (nullable, written by 18b), `image_source` ∈ `pacs | no_pacs_images | outside` so 18b's reconciliation queue (A2/H1) has columns to write and M1's no-DICOM portable has a state.
- **No dose register, no TLD, no AERB licences, no QA lockout workflow** — 18c. The study stores the per-study dose fields M4 needs (`dose_ctdivol`, `dose_dlp`, `dose_dap`, `fluoro_seconds`, `dose_manual: true`); 18c's register reads them. The `qa_blocked` device status EXISTS in this phase's vocabulary and refuses scheduling and acquisition (G2); the workflow that puts a device INTO it is 18c's.
- **No contrast administration record, no reaction → ADR/incident chain, no premedication tasks** — follow-on slice (§6.9 "18a-iii"). The acquisition carries `contrast_given` and `contrast_agent`/`contrast_volume_ml` (D2's swap fact), and the `prior_contrast_reaction` gate reads the patients module's allergy list (P2) — the reaction that WRITES that allergy is the follow-on's.
- **No PCPNDT monthly return compiler, inspection persona, certified prints, registration-expiry block (O-7), solicitation report (E6 one-tap)** — follow-on slice ("18a-ii"). The register rows, serials and registration validity dates it compiles from are all here.
- **No portable/bedside flow (WF-IMG-06), no teleradiology (WF-IMG-10), no release desk (WF-IMG-09), no outside-study register, no emergency clocks (WF-IMG-07), no KPI registrations, no automations (Prep/Recall, Critical Chaser, Unread Watchman, Nudger), no downtime kit, no prep WhatsApp** — 18a-iii and the plans they depend on (31 transport, 21 KPI registry, 30 downtime). One notification template ships (`imaging_report_ready`); prep messaging waits for the template language set (K1) and is one enqueue when it comes.
- **No scheduler job** — the thirteen-job census (`scheduler.test.ts` `THE_THIRTEEN`) is untouched. Unread-study and critical-ack escalations are RECORD-ONLY SLAs on the workflow definitions (v3 §10.3 pattern, Plan 15's `recordOnly`); the alerting ladder is 18a-iii's.
- **No IPD, ED or TPA branch** — 41/40/46 do not exist. §4 DD12 states the payer branches this phase can honestly serve today and the columns the others will use.
- **No new resource kind, no encounter enum value, no edit under `kernel/auth/`, `packages/contracts/` or `modules/patients/`** — one disclosed kernel edit each to `kernel/episodes/series.ts` (DD5), `kernel/orders/read.ts` (DD11 — the §6A.8 PHI call, if Lane A has not landed it first) and `kernel/phi/audit.ts` (DD11).

---

## 2. Ground truth — measured 2026-08-29 17:50 UTC on the build host (AGENT-RULES §6)

Every row is a command. **Re-run every row at kickoff and record the result in §9.0**; Lane A is writing into this tree today and at least four rows will move if it executes first.

| # | fact | value today | how |
|---|---|---|---|
| 1 | migrations in the journal | **46** (`0000`–`0045`); this phase writes **`0046`** | `python3 -c "import json;j=json.load(open('apps/core/drizzle/meta/_journal.json'));print(len(j['entries']), j['entries'][-1]['tag'])"` → `46 0045_order_envelope_integrity` |
| 2 | claimed order kinds | **`[]`** | `grep -n 'claimed' apps/core/src/kernel/orders/parity.test.ts` |
| 3 | manifests installed | **17**, key list pinned at `manifests.test.ts:113`, count at `:144`/`:149`; worker omits SIX (`ops membership formulary resources desk orders`, `:256`); worker keys **12** (`:289`) | `grep -c 'Manifest,$' apps/core/src/kernel/modules/manifests.ts`; `grep -n 'toHaveLength\|toEqual(\[' apps/core/src/kernel/modules/manifests.test.ts` |
| 4 | permission censuses (re-measured after `b657a66`) | `allPermissions` **111**; role-model pairs **170**; distinct modelled **87**; reachability **111 = 93 held + 18 NOT_YET_MODELLED** (the `it` title at `:768` still reads 91/20 — a stale label, not a pin) | `grep -n 'toHaveLength([0-9]' apps/core/test/seed-roles.test.ts` → lines 633, 755, 760, 769, 822–823 |
| 5 | `apps/core/scripts/seed-roles.ts` was modified in the tree while this document was written and has since LANDED as `b657a66` (the MRD officer holds the two privacy-write permissions) — row 4's held/not-modelled split (91/20) may therefore have moved; **Lane A's plan (`a7d1673`) also adds permissions to the same censuses** | `git log --oneline -3 -- apps/core/scripts/seed-roles.ts`; `git status --porcelain apps/core/scripts/seed-roles.ts` |
| 6 | resource kinds: kernel declares `floor ward hall room bed`; OT declares `theatre`; **`device` is admitted by the CHECK and claimed by NOBODY** | `grep -rn 'kind: "device"' apps/core/src --include=*.ts \| grep -v test \| wc -l` → 0; `grep -n resources_kind_ck apps/core/src/kernel/db/schema/resources.ts` |
| 7 | Form F / PCPNDT in code | **none** — two lines, both in OT saying it is absent | `grep -rn 'form_f\|pcpndt' apps/core/src --include=*.ts \| wc -l` → 2 |
| 8 | `recordPhiAccess` calls inside the kernel order readers | **0** (§6A.8 open) | `grep -c recordPhiAccess apps/core/src/kernel/orders/read.ts` |
| 9 | `addOrderItem` in the tree | **0** — and it STAYS 0: §6A.5 is closed by DD10c without a kernel function, the same way Lane A's DD9 closes it | `grep -rn addOrderItem apps/core/src --include=*.ts \| wc -l` |
| 10 | controllers mounting the order seam | **0** (§6A.2: idempotency belongs to the route and there is none) | `grep -rln 'kernel/orders' apps/core/src --include=*.controller.ts \| wc -l` |
| 11 | `PhiSurface` members | `patient.detail patient.allergies opd.timeline opd.vitals opd.prescriptions opd.visit opd.rx_history opd.vitals_history` — a closed union in code | `sed -n '15,40p' apps/core/src/kernel/phi/audit.ts` |
| 12 | episode series keys | `visit appointment lab_order lab_specimen radiology_order pharmacy_dispense grn daycare` — 8; `R` reserved and unused | `grep -n '^  [a-z_]*: "' apps/core/src/kernel/episodes/series.ts` |
| 13 | second-factor primitives | `verifyTotpCode`, `recordSecondFactor`, `secondFactorFresh(session, windowMinutes)` at `kernel/auth/totp.ts:37-58` | `grep -n '^export' apps/core/src/kernel/auth/totp.ts` |
| 14 | the walk-in opener | `walkIn(db, actor, input)` at `modules/opd/walk-in.ts:80` — registers or matches the patient and opens a `V` visit | `grep -n '^export async function walkIn' apps/core/src/modules/opd/walk-in.ts` |
| 15 | patient allergy reader | `listAllergies(db, patientId)` at `modules/patients/allergies.ts:56` | `grep -n '^export' apps/core/src/modules/patients/allergies.ts` |
| 16 | idempotency wrapper | `withIdempotency(db, {actorId, route, key}, body, work)` exported from `modules/billing/index.ts:17` | `grep -n withIdempotency apps/core/src/modules/billing/index.ts` |
| 17 | workflow-definition governance precedent | `OT_WORKFLOW_DEFINITIONS` pinned at `workflow-def.test.ts:18` (key + `changeClass:"A"`); installed in tests by `test/helpers/ot.ts:233` (owner + MS approvals, activator ≠ drafter) | `grep -rn OT_WORKFLOW_DEFINITIONS apps/core --include=*.ts \| grep -v workflow-def.ts` |
| 18 | scheduler job census | **13** (`jobs.test.ts:336`, `scheduler.test.ts` `THE_THIRTEEN`) — this phase adds NONE | `grep -n 'THE_THIRTEEN\|toHaveLength(13)' apps/core/src/kernel/worker/*.test.ts` |
| 19 | ledger §5 line | **1485** | `grep -n '^## 5' docs/superpowers/plans/reports/EXECUTION-LESSONS.md` |
| 20 | host state | load average 1.66; no jest running | `uptime; pgrep -af jest` (READ the matched lines — rule 20) |

**Rows 1, 3, 4, 8 and 11 are the rows Lane A moves** (its plan `2026-08-29-phase1-17-lims-core.md` T2 adds `PhiSurface` members `lab.results`, `lab.report`, `orders.patient` and the kernel readers' PHI log; its T1 wants `0046`). If any has moved at kickoff, the task that owns it in §5 says what to do (T1 renumbers; T2 re-measures; T3 REUSES a landed PHI call and appends its own surface names rather than writing a second call).

---

## 3. Spike — questions written now, answered at kickoff, recorded in §9.3

Answer by reading code and read-only SQL. None changes the ruling; each sizes a task.

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | Does `phi_access_log.surface` carry a CHECK, or is `PhiSurface` enforced in TypeScript only? (`grep -n surface apps/core/src/kernel/db/schema/phi-access.ts`) | If a CHECK: `0046` widens it and T3's PHI edit is a migration line, not just a type; if not: the union edit alone |
| **S2** | What does `resolveEncounterByPrefix` return for a `V` visit — does the resolved object carry `status`, or must T3 read `opd_encounters` through an OPD export to apply DD9's encounter-status guard? | Decides whether T3 asks OPD for one exported reader (`encounterStatusByVisitNo`) or gets it from the resolver for free |
| **S3** | `assignResource`'s occupant contract: what does `occupantType` admit (free text or a CHECK), and what does `releaseResource` do to a `device` whose kind declares `onRelease:'available'`? (`sed -n '440,560p' apps/core/src/kernel/resources/registry.ts`) | T7's device occupancy is a transcription of `ot/cockpit.ts:171`; if `occupantType` is constrained, `imaging_study` must be admitted |
| **S4** | Which role keys exist in `ROLE_MODEL` today, and does any of `radiologist`, `radiographer`, `radiology_receptionist`, `pcpndt_incharge` already exist (from `seed:ops` or S10 cards)? (`grep -n 'roleKey: "' apps/core/scripts/seed-roles.ts`) | T2's grants and the README parity table; a role that exists takes grants, one that does not is declared |
| **S5** | Does `secondFactorFresh` get the SESSION from the controller today anywhere (`grep -rn secondFactorFresh apps/core/src --include=*.ts \| grep -v test`), and what window do the existing callers use? | T8's sign step reuses the caller pattern and its window; inventing a second one is §2.54's class |
| **S6** | How many production `opd_encounters.advised_tests` entries name a service whose `category` is imaging-shaped, and what categories does `services.category` carry today? (read-only SQL on `hmis-prod`, the Question-B precedent) | Sizes T4's study-type seed (which tariff services become study types) and tells the counter conversion (07d's promise) what it will find |
| **S7** | Does `enqueueNotification` require a `patient_id` recipient with a verified channel, and what does it do for a patient with no phone (`sed -n '68,144p' apps/core/src/kernel/notify/enqueue.ts`)? | T8's publish must never fail on delivery (C7): the enqueue's refusal shape decides whether publish wraps it in try/catch or checks first |
| **S8** | Has Lane A landed `addOrderItem`, a `recordPhiAccess` call in `read.ts`, a widened `PhiSurface`, or a manifest — re-run rows 3, 4, 8, 9, 11 | T2/T3 REUSE what landed and edit nothing twice (§2.54) |

---

## 4. Design decisions — DECIDED, each with its reasoning (owner standing rule 2026-08-28: the most logical Indian-corporate-hospital choice, marked DECIDED; stop only for money, procurement or law)

**DD1 — Two manifests: `radiology` and `pcpndt`.** `modules/radiology/` claims the order kind and owns studies, scheduling, gates, acquisition and reports. `modules/pcpndt/` is the kernel-adjacent statutory module INDEX §5 row 14 asked for (*"built in 15, adopted unchanged by 18a and 62"*) — Plan 15 did not build it, so this phase does, **as its own manifest key so that 15b (MTP-era gynae day-care USG) and 62 (maternity) install it without installing radiology**. Reasoning: one register for one inspector; a Form F written from the mini-OT's portable and one from the radiology suite must land in one gap-free serial series per machine, and a table inside the radiology module would make 15b import radiology to write a statutory row. Cost: manifest census 17 → **19**.

**DD2 — The claim.** `orderKinds: [{ kind:'imaging', seriesKey:'radiology_order', placePermission:'radiology.orders.place', requiresClinician:true, requiresIndication:true, selfOrderable:false }]` — phase 0 §6.8 verbatim. `requiresIndication` is the radiation-justification gate expressed as a declaration: `placeOrder` refuses an imaging order with no reason and this module writes no guard for it. `requiresClinician:true` because a walk-in with an outside slip carries `authority:'external_prescription'` + `external_referrer_id` in place of the clinician (phase 0 DD6), which is exactly the receptionist's case.

**DD3 — One item, one study; the study numbers itself.** `imaging_studies` is keyed `order_item_id` UNIQUE — an order for "CT chest + CT abdomen" is two items and two studies with one `order_no`. The study's **`accession_no`** is minted from a NEW episode series **`imaging_study: "X"`** (`X2608290001`, 11 characters, inside DICOM's 16-character accession limit for 18b) — a one-line disclosed edit to `kernel/episodes/series.ts` and its comment in `schema/episodes.ts:30`, the `grn` precedent. Reasoning: §6.7 says studies number themselves and `order_no` is never overloaded; an accession must be unique per STUDY, and one order carries several. `X` rather than `I` because `I` and `1` are one glyph on a dry-printed label (A9).

**DD4 — The item's envelope states map to exactly two module moments.** `advanceOrderItem(… 'in_progress')` at **acquisition start** (the patient is on the table), `'completed'` at **publish** (a signed report exists and is visible in-app), `'cancelled'` from the module's cancel paths. Scheduling, check-in and gates are all inside `placed`; drafting and signing are inside `in_progress`. Reasoning: DD5 of phase 0 makes a cancel after `in_progress` carry a reason and stand the charge (O-4's money rule) — and "on the table" is the moment that is true for a scan (B6). Check-in is not, because a gate can still fail.

**DD5 — Scheduling is the module's table, and the slot is a UNIQUE index.** `imaging_studies (device_resource_id, scheduled_at)` UNIQUE where `status NOT IN ('cancelled','rescheduled')` (partial). The study type declares `duration_min`; the reception picks a device of the study type's `modality` and a start time; the INSERT/UPDATE either lands or fails `slot_taken` — B1's "concurrent-insert test proves the lock is load-bearing" is the unique index, not a `FOR UPDATE`. Walk-in X-ray auto-slots `now` on the first `available` device of the modality. **A device in `down`, `qa_blocked`, `maintenance` or `retired` refuses scheduling and acquisition** (G1/G2). Reasoning: Plan 13's `assignResource` is ONE occupant at a time — right for "on the table", wrong for "booked at 14:30 Thursday" — and a time-slot registry is 22's (appointments v2). The device becomes an occupied resource only during acquisition (DD8).

**DD6 — Modalities are `device` resources, and this manifest declares the kind's vocabulary for everybody.** `resourceKinds: [{ kind:'device', statuses:['available','in_use','down','qa_blocked','maintenance','retired'], initial:'available', occupied:'in_use', onRelease:'available', retired:'retired' }]`. Reasoning: the CHECK admits `device`, nobody has claimed it (§2 row 6), and `collectResourceKinds` refuses a second claimant at boot — so the FIRST module to declare `device` fixes the status vocabulary for cath lab (63), BME (29), and every portable and injector that comes later. That is stated in §6.4 so 29 does not arrive wanting `commissioning` (O3 in the catalogue) and find the vocabulary closed: **it is not closed** — a later phase widens THIS declaration by a disclosed edit to `modules/radiology/kinds.ts`, the way `0036` widened the OT incident kinds.

**DD7 — A gate is a child workflow instance, transcribed from Plan 15 DD5, and the gate SET is declared data on the study type.** Workflow definition `imaging_gate` (`open → satisfied | waived | overridden`, all three terminal, Class A) and a table `imaging_safety_screenings (study_id, kind, workflow_instance_id, waivable, evidence jsonb, satisfied_by/at, override jsonb)` — `ot_case_gates` column for column. The ten kinds this slice ships: `identity_two_factor`, `pregnancy_screen`, `contrast_consent`, `renal_function`, `prior_contrast_reaction`, `mri_safety`, `form_f`, `chaperone_present`, `laterality_confirm`, `mlc_check`. Which kinds a study type opens is a row in the governed `study_types` definition (DD13), evaluated at check-in from the patient's sex, age and the type's flags (`ionising`, `contrast_option`, `modality='mri'`, `pcpndt_applicable`, `laterality_applicable`). Override needs `radiology.gates.override` (the radiologist) and a reason, and is evented — P1's *"radiologist override with reason (benefit>risk)"*; the OT's two-actor form is not transcribed because the radiologist IS the second clinical opinion on a gate the technologist raised. **`form_f` is neither waivable nor overridable BY CODE — `waiveGate` and `overrideGate` refuse the kind before consulting any definition** (N2: *"no emergency bypass exists"*). Reasoning: 15's gates are the house pattern and their history is the engine's; a boolean column has no history and E2's "waiver carries both doctors" has nowhere to live.

**DD8 — Acquisition occupies the device through the registry, and the study is the occupant.** `startAcquisition` = `assignResource(tx, actor, ['device'], deviceId, { occupantType:'imaging_study', occupantRef: studyId })` + `advanceOrderItem(in_progress)` in one transaction (`ot/cockpit.ts:171` order: assign FIRST, it takes the row lock and refuses a busy device). `recordAcquired` writes accession, `acquired_at`, `image_source`, dose fields (M4: for an `ionising` type at least one dose field is NOT NULL or `dose_manual` is set with a value — a CHECK), `contrast_given`, `repeat_of_study_id` + `repeat_reason` (C5/D6/P10), then `releaseResource` and emits `imaging.study_acquired`. Reasoning: DD6 of Plan 13 (polymorphic occupant) exists for exactly this; "which study is on the CT now" is a registry read, not a radiology join.

**DD9 — The encounter-status guard is this module's, and the walk-in is OPD's `walkIn`.** An imaging order is accepted on an OPD visit in `registered | waiting | in_consultation | awaiting_results`, and on a `completed` visit **within 7 days** (the consultant who adds a scan after the patient has left the room — the normal corporate case); refused on `abandoned` and on `completed` older than 7 days (`encounter_closed`) — a new visit is the answer. Day-care `D` encounters are accepted while not terminal. **A walk-in with an outside prescription goes through `modules/opd/walk-in.ts`'s `walkIn`** (07d), which registers-or-matches the patient and opens a `V` visit with `referralSource:'external_rmp'`; the order then carries `authority:'external_prescription'` + `external_referrer_id`. Reasoning: 17's `lab_walkin` encounter type (02 §15.1) is Lane A's ask to OPD and this phase must not depend on an unlanded construct; `walkIn` already exists, already de-duplicates, and a visit that has a referrer and no doctor is a truthful record of a slip-in-hand.

**DD10 — Idempotency and the add-on: the two §6A items this module CLOSES, and the kernel function it ASKS for.** (a) The placement route wraps `placeOrder` in billing's exported `withIdempotency` keyed on the `Idempotency-Key` header — the house mechanism, `(actorId, route, key)` unique — so a retried click replays the first response and mints nothing (§6A.2 closed). (b) A second natural-key guard: `findRecentItems(patientId, serviceId, 24h)` non-empty → the route refuses unless the caller passes `duplicateOfItemId + duplicateReason` (E6 semantics; I9's duplicate-charge rule falls out). (c) **An add-on view is a NEW ORDER in the same `order_group_id`** with `origin:'addon'` and `parent_item_id` pointing across orders — phase 0's E2 shape applied to E3 as well, and the SAME ruling Lane A made for the lab (its DD9: *"the kernel `addOrderItem` is owed by nobody until a plan needs the same header; 18a inherits the same rule for an added view"*). It costs one more `R` number per added view and buys the absence of the one write §6A.5/§6A.7 warned about: no insert without a CAS, no header lock, no deadlock against the close, **no kernel edit**. The added study gets its own accession and its own slot exactly as a first study does. §6A.5 is thereby closed for BOTH consumers without the function phase 0 predicted.

**DD11 — PHI is logged at the reader, and the readers this phase touches get a surface each.** `recordPhiAccess` is added INSIDE `kernel/orders/read.ts` for `listOrdersForPatient` and `listOrdersForEncounter` (§6A.8 closed, surface `orders.patient`, `reason` from the caller), and the module's own readers log `imaging.worklist`, `imaging.study`, `imaging.report` and `pcpndt.form_f`. `PhiSurface` (a closed union, §2 row 11) is widened by those names — a disclosed kernel edit, S1 decides whether it is also a CHECK. **`orders.patient` is the AGREED name for the kernel readers' surface** (Lane A's T2 writes the same string), so whichever lane lands first writes the call and the other appends only its own `imaging.*`/`pcpndt.*` names. Reasoning: the repository's rule is reader-side (`opd/history.ts:74`), and a worklist is the largest PHI surface this module has — every patient with a pending scan, by name, on one screen, for every technologist.

**DD12 — Money: this module writes FACTS and a DECISION QUEUE; the invoice is the counter's.** There is no `charge.posted` in this codebase (`grep -rn 'charge\.' apps/core/src --include=*.ts` → one string, billing's own `charge.orphan_flagged`); the house money object is the invoice (`issueInvoice`, lines by `service_id`) raised at the counter. So: (a) **OPD self-pay is prepaid at the reception** — the reception raises the invoice through the existing counter machinery and the study stores `invoice_line_id`; a study is `authorised` when that link exists OR its payer branch is one this phase cannot bill (`intendedPayer ∈ tpa | pmjay | corporate`, recorded as `authorised_by:'payer_branch'` for 46 to reconcile) OR the encounter is day-care (15's discharge bill composes it) OR `priority='stat'` (D3: emergency never waits on money). (b) **At `study.acquired` the module writes `imaging_bill_decisions`** when a fact diverges from what was billed: `contrast_not_given` (D2), `repeat_no_charge` (D6/C5), `performed_then_cancelled` (B6/D12), `acquired_unbilled` (I1 — no invoice link and not a payer branch). The counter works the queue with the existing credit-note/refund paths; the queue is the leakage triangle's row source. Reasoning: 14 and 15 each had their CRITICAL in money summed from the wrong place; a module that composes a second invoice is a second place. **O-2** (report delivery blocked until paid — OPD self-pay only, never in-app, never criticals) is applied at publish through billing's `settlementState` on the linked invoice (DD15).

**DD13 — Study types and gate rules are governed definitions, not a table an admin edits.** `imaging_definitions (kind, version, body jsonb, status, drafted_by, published_by, approval_id)` — `ot_definitions` column for column — with kinds `study_types`, `pregnancy_policy`, `critical_categories`. A study type body row: `{ code, name, modality, body_part, service_id, duration_min, ionising, contrast_option, pcpndt_applicable, chaperone_required, laterality_applicable, gates[] }`. Publishing needs the `imaging_definition_publish` approval type (OT's `registerOtApprovalTypes` transcribed). Seeds: **twenty study types** across X-ray, USG (obstetric, pelvic, abdomen), CT (± contrast), MRI (± gadolinium), mammography — the S6 measurement names which tariff services they bind to. `pregnancy_policy` seeds O-5's recommendation. Reasoning: the gate SET is a clinical rule and clinical rules in this house are Class-A governed data (§10.2), which is also how a radiologist adds a gate without a deploy.

**DD14 — PCPNDT, expressed in tables (the structure is the owner's to confirm — §4A; the expression is this document's).** `pcpndt_registrations (id, site, registration_no, valid_from, valid_to, incharge_user_id, status)`; `pcpndt_registered_machines (registration_id, device_resource_id, make, model, serial, form_b_ref, active)`; `pcpndt_registered_persons (registration_id, user_id, qualification, council_reg_no, active)`; `pcpndt_form_f_serials (machine_id, year, next_no)` — `episode_series`'s shape, gap-free per machine per year (I6), the `nextEpisodeNo` pattern on the caller's `tx`; `pcpndt_form_f (id, serial_no, machine_id, person_id, study_id, patient_id, indication_code, gestation_weeks, sections jsonb A–G, declaration jsonb {signature_kind: 'signature'|'thumb', witness_name?}, referral jsonb {slip_doc_id?, self_referral: bool}, applicability: 'pregnant'|'not_pregnant'|'indication_only', result_summary, signed_by, signed_at, verified_at)`. **Applicability rule, evaluated at placement**: study type `pcpndt_applicable` AND patient `sex='female'` AND age 10–55 (DOB-derived; `dob_estimated` counts) → the ITEM is `restricted:true` (phase 0 DD11's *"set by the module's own rule"*), the study carries `form_f_required:true`, and at check-in the `form_f` gate opens. **Cannot-close**: `recordAcquired` calls `assertFormFRecorded(studyId)` before anything else and refuses `form_f_missing` — no flag, no role, no hour of the night reaches around it (N2, H8). **Machine and person**: the study's `device_resource_id` must be an active registered machine and the acquiring actor must be an active registered person, both checked at `startAcquisition` (F4, N3). **Real name on the form, alias everywhere else** (J1): Form F readers use `patients.name`, worklist readers use the alias path. **Lexical lockout** (E6/N9): a word list (`male female boy girl ladka ladki beta beti` + Devanagari) is checked at SIGN over the whole report text when `form_f_required` OR the patient carries a pregnancy declaration on any gate in the last 280 days; a hit REFUSES the sign. **Form F rows are append-only** (the `0043`/`0044` trigger pattern) and `verified_at` is the one column the PCPNDT in-charge may set. Reasoning: every row above is a Rule 9 obligation with a place; O-7 (expiry behaviour) and the return compiler are 18a-ii's and the `valid_to` column is already here for them.

**DD15 — The report is an immutable version chain, signed under a fresh second factor.** `imaging_reports (id, study_id, version, status: prelim|draft|signed|amended|superseded, template_key, body jsonb, impression, laterality, critical_category: red|orange|yellow|null, signer_id, signed_at, second_factor_at, amendment_reason, supersedes_id, external_reporter_id, published_at)`. A partial UNIQUE on `(study_id) WHERE status='signed'` makes B10's "second sign refused" a database fact; `amend` inserts version n+1 as `signed` and flips n to `superseded` in one CAS transaction; the immutability trigger forbids UPDATE of every column but `status`/`published_at` and forbids DELETE. **Sign requires `secondFactorFresh(session, W)`** with W the existing callers' window (S5) — else `second_factor_required`; requires `radiology.reports.sign`; requires `laterality` to equal the order item's when the type is `laterality_applicable` (A3 without DICOM: the human-entered side); runs the DD14 lockout. **Prelim** (O-11) is a version with `status:'prelim'`, visible in-app with the UNVERIFIED banner, never delivered, superseded by the first `signed`. **Publish** = `advanceOrderItem(completed)` + `imaging.report_published` + `enqueueNotification('imaging_report_ready')` for OPD patients — **gated by O-2 for OPD self-pay on an unsettled invoice, and the gate is on the ENQUEUE only** (D5/C7: in-app visibility never depends on payment or on the gateway). A `critical_category` of `red` writes `imaging_critical_findings (report_id, category, communicated_to, channel, read_back_text, communicated_at, acknowledged_by, acknowledged_at)` and emits `imaging.critical_flagged`; ack is a route; the SLA is record-only on the `imaging_study` definition in this slice. Reasoning: §11.6's *"amended reports versioned, never overwritten"* and §11.19-D-27's second factor are locked; the version chain is the same immutability seam 22c-A built for identity and the reviewer will look at it first.

**DD16 — Five screens, and the worklist is one screen with a role filter.** `/radiology/reception` (book, walk-in, reschedule, no-show, link invoice), `/radiology/worklist` (technologist view: today's schedule by device; radiologist view: unread by priority — `stat > urgent > routine`, F2's order without the ED classes), `/radiology/study/$studyId` (the console: check-in, gates, start, acquired), `/radiology/report/$studyId` (editor, sign, amend, criticals), `/pcpndt/form-f/$studyId` (the sealed form, real name, serial minted on open). Confidential patients render through the alias path on all but the Form F screen. Reasoning: Plan 15 shipped four screens in one ROUTINE task and 07c's counter lesson is that a screen per role is how context gets lost three times per patient — the worklist is one screen because the tech and the radiologist are looking at the same study.

### 4.1 The tables — all keyed off the envelope, never a column on it (phase 0 §8.1)

**`imaging_studies`** — `id`, `order_item_id UNIQUE FK`, `order_id FK`, `patient_id FK`, `encounter_no`, `study_type_code`, `service_id FK`, `accession_no UNIQUE` (DD3), `laterality` (`left|right|bilateral|na`), `priority` (copied from the order at creation for the worklist index), `status` (`scheduled|checked_in|ready|in_acquisition|acquired|reported|published|cancelled|no_show|rescheduled` — CHECK; mirrors the `imaging_study` workflow instance, `workflow_instance_id`), `device_resource_id FK resources`, `scheduled_at`, `checked_in_at`, `acquisition_started_at`, `acquired_at`, `acquired_by`, `image_source` (`pacs|no_pacs_images|outside` — CHECK), `study_instance_uid` (18b), `dose_ctdivol`, `dose_dlp`, `dose_dap`, `fluoro_seconds`, `dose_manual boolean`, `contrast_given boolean`, `contrast_agent`, `contrast_volume_ml`, `repeat_of_study_id`, `repeat_reason`, `form_f_required boolean NOT NULL DEFAULT false`, `invoice_line_id`, `authorised_by` (`invoice|payer_branch|daycare|stat|null`), `cancel_reason`, `created_at`. Partial UNIQUE `(device_resource_id, scheduled_at) WHERE status NOT IN ('cancelled','rescheduled','no_show')`. Indexes `(status, priority, scheduled_at)`, `(patient_id)`, `(order_id)`.

**`imaging_safety_screenings`** — the DD7 gate rows. UNIQUE `(study_id, kind)`; CHECK on the ten kinds.

**`imaging_definitions`** — DD13. UNIQUE `(kind, version)`; CHECK on the three kinds.

**`imaging_reports`** — DD15. UNIQUE `(study_id, version)`; partial UNIQUE `(study_id) WHERE status='signed'`; CHECK on the five statuses; `critical_category` CHECK; trigger `imaging_reports_forbid_mutation`.

**`imaging_critical_findings`** — DD15. FK `report_id`.

**`imaging_bill_decisions`** — DD12: `id, study_id, kind (CHECK four), detail jsonb, raised_at, resolved_by, resolved_at, resolution`.

**`pcpndt_registrations`, `pcpndt_registered_machines`, `pcpndt_registered_persons`, `pcpndt_form_f_serials`, `pcpndt_form_f`** — DD14. `pcpndt_form_f`: UNIQUE `(machine_id, serial_no)`; trigger `pcpndt_form_f_forbid_mutation` (all columns but `verified_at`, `verified_by`); UNIQUE `(study_id)` — one form per scan (N1: the third growth scan is a third study and a third form).

**`truncateAll`**: `imaging_reports`, `imaging_critical_findings`, `imaging_bill_decisions`, `imaging_safety_screenings`, `pcpndt_form_f` join the statement that truncates `order_items` (they point at `imaging_studies`, which points at `order_items` and `services`); `imaging_studies` joins the same statement; `pcpndt_registered_machines` joins the `resources` statement; `pcpndt_registered_persons` joins the `users` statement; `imaging_definitions`, `pcpndt_registrations`, `pcpndt_form_f_serials` take their own. **A table absent from it is NEVER EMPTIED** (author prompt §4) — T1's test truncates and counts.

### 4.2 Events — `entity.verb_past`, subscriber named per 00 §5

| event | payload | subscriber |
|---|---|---|
| `order.placed` (kernel, consumed) | phase 0 §4.2 | **`radiology.order_placed`** worker consumer (T3): filters `kind='imaging'`, creates one `imaging_studies` row per item in `scheduled`-pending state (no device yet: `status='scheduled'` with `scheduled_at NULL` is "awaiting slot"; the reception fills it); an add-on order (DD10c) arrives through the same event and needs no second consumer |
| `imaging.study_scheduled` | `{studyId, orderItemId, patientId, deviceResourceId, scheduledAt, studyTypeCode}` | 18b (MWL file), 22c-F (appointment card) |
| `imaging.gate_evaluated` | `{studyId, kind, outcome: satisfied\|waived\|overridden, evidenceRef, actorId}` | 28a (quality), audit |
| `imaging.study_acquired` | `{studyId, accessionNo, orderItemId, serviceId, contrastGiven, repeatOfStudyId, imageSource, deviceResourceId}` | billing/counter (the D2 fact), 18b (reconciliation), 18c (dose register) |
| `imaging.report_published` | `{studyId, reportId, version, patientId, encounterNo, criticalCategory}` | 22c-F (reports-ready), 26 (package progress via `order_item.completed`), 10 gateway |
| `imaging.critical_flagged` / `imaging.critical_acknowledged` | `{reportId, category, communicatedTo?, acknowledgedBy?}` | 18a-iii's Critical Chaser; 28a |
| `imaging.bill_decision_raised` | `{studyId, kind, detail}` | the counter's queue |
| `pcpndt.form_f_recorded` | `{formFId, serialNo, machineId, studyId}` — **no patient fields** (sealed class) | 18a-ii's return compiler |

### 4A. ROUTED TO THE OWNER — none blocks a task

- **PCPNDT registration facts (LAW):** the facility registration number and validity, the registered machines (make/model/serial/Form B) and the registered persons — the §19 pre-mini-OT gate. T6 seeds NOTHING and ships a runbook route; the module refuses every applicable scan until a registration exists, which is the correct state of a hospital that has not filed. **O-13** (who is in-charge) names the holder of `pcpndt_incharge`.
- **O-5 pregnancy policy:** DD13 seeds the brainstorm's recommendation as the published definition; the owner may re-publish it through the definition path without a deploy.
- **O-2:** applied as recommended (delivery gate only). **O-11:** prelims allowed, always UNVERIFIED. **O-4** (film/CD prices): no film/CD in this slice; the tariff rows are the release desk's (18a-iii).
- **Money/procurement, routed and NOT designed around:** modality hardware, PACS storage (18b), teleradiology standby contract (O-1), outsourced MRI mode (O-3). Nothing in this slice presumes any of them.
- **Grants that are runbook acts, not migrations** (22c-A DD7's discipline): `orders.read.restricted` to `radiologist` and `pcpndt_incharge`; `patients.confidential.read` stays unheld.

---

## 5. Tasks

Nine. Seven CRITICAL. Each CRITICAL task carries an inline Assertion Book whose mutants are **built and executed** (AGENT-RULES §3). Every task's Files list is the ONLY list (§2.54); the EXECUTE-PROMPT names no file this section does not.

### T1 — Migration `0046`: eleven tables, the two triggers, the `X` series, `truncateAll` — **ROUTINE**

**Files:** `apps/core/src/kernel/db/schema/radiology.ts` (new), `apps/core/src/kernel/db/schema/pcpndt.ts` (new), `apps/core/src/kernel/db/schema/index.ts` (exports), `apps/core/src/kernel/db/schema/episodes.ts` (comment line 30 only), `apps/core/src/kernel/episodes/series.ts` (`imaging_study: "X"` — one line + the comment that names this decision), `apps/core/drizzle/0046_radiology_core.sql` (generated, then hand-carried for the CHECKs, partial uniques and triggers as `0044` was), `apps/core/drizzle/meta/*` (generated only — never hand-edited, §6), `apps/core/src/kernel/db/schema/radiology.test.ts` (new), `apps/core/src/kernel/db/schema/pcpndt.test.ts` (new), `apps/core/test/helpers/db.ts` (`truncateAll` per §4.1), plus the series parity test the sibling-grep finds (`grep -rn '"radiology_order"' apps/core/src --include=*.ts`) and, if S1 says CHECK, `phi_access_log`'s surface CHECK widened in the same migration.

**Migration number:** re-measure row 1 immediately before AND after `db:generate`; if Lane A took `0046`, this task writes `0047` and the commit message says so. Purely additive. Tests: every CHECK refused and the refusal READ (07c pattern); both triggers refused on UPDATE and DELETE; the partial slot unique refused for a second live study and ACCEPTED after the first is `cancelled`; `truncateAll` empties every one of the eleven (insert one row each, truncate, count zero — the author prompt's rule made executable).

### T2 — The two manifests, permissions, roles, the `device` kind, two workflow definitions, the event catalogue, the approval type, one template — **CRITICAL**

**Files:** `apps/core/src/modules/radiology/manifest.ts`, `kinds.ts` (DD6), `events.ts` (§4.2), `workflow-def.ts` (`imaging_study`, `imaging_gate`), `approval-types.ts` (`imaging_definition_publish`), `errors.ts` (`RadiologyError` on the `ResourceError` shape), `index.ts` (all new); `apps/core/src/modules/pcpndt/manifest.ts`, `errors.ts`, `index.ts` (new); `apps/core/src/kernel/modules/manifests.ts` (append BOTH, the ORDER paragraph applies — `pcpndt` before `radiology`, since radiology's consumer will import pcpndt); `apps/core/src/kernel/modules/manifests.test.ts`; `apps/core/scripts/seed-roles.ts` + `apps/core/test/seed-roles.test.ts` + the README parity table the test compares (**five censuses, and only `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts` finds them all** — §2.138); `apps/core/src/kernel/notify/templates.ts` (`imaging_report_ready`, transactional) and its test; `apps/core/src/modules/radiology/workflow-def.test.ts`, `kinds.test.ts`, `events.test.ts` (new); `apps/core/src/kernel/worker/worker.module.ts` (install both manifests — they carry a subscription, so the worker has something to consume: the `materials`/`ot` case; `manifests.test.ts:256`'s six-omitted list is UNCHANGED).

Permissions — radiology (15): `radiology.orders.place`, `radiology.worklist.read`, `radiology.schedule`, `radiology.checkin`, `radiology.gates.satisfy`, `radiology.gates.override`, `radiology.acquire`, `radiology.reports.write`, `radiology.reports.sign`, `radiology.reports.amend`, `radiology.reports.read`, `radiology.definitions.read`, `radiology.definitions.manage`, `radiology.bill_decisions.manage`, `radiology.criticals.ack`. pcpndt (5): `pcpndt.registrations.manage`, `pcpndt.registrations.read`, `pcpndt.form_f.write`, `pcpndt.form_f.read`, `pcpndt.form_f.verify`. **Twenty**; `allPermissions` 111 → 131 if this lane lands first, 131 + Lane A's count if second (re-measure, row 4).

Roles (S4 decides declare-vs-grant): `radiologist` (worklist.read, gates.override, acquire? NO, reports.*, criticals.ack, definitions.read, form_f.read/write — the sonologist IS a radiologist who is a registered person), `radiographer` (worklist.read, checkin, gates.satisfy, acquire, form_f.read), `radiology_receptionist` (orders.place, schedule, worklist.read, bill_decisions.manage, definitions.read), `pcpndt_incharge` (registrations.manage/read, form_f.read/verify), `consultant` (+ `orders.place`, `orders.read`, `radiology.orders.place`, `radiology.reports.read`), `billing_manager` (+ `radiology.bill_decisions.manage`). `orders.cancel` stays NOT_YET_MODELLED with its reason amended to name this phase's own cancel permission (`radiology.schedule` covers reschedule/no-show; cancellation of a placed order is the consultant's or the receptionist's under `radiology.schedule` — recorded). **Three separations the reviewer checks:** the receptionist cannot satisfy a gate; the radiographer cannot sign; the in-charge cannot write a Form F (SoD: verifies what others wrote).

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | `collectOrderKinds(ALL_MANIFESTS registry)` returns exactly `[imaging]` with `requiresIndication:true`, and the parity test's claimed list moves from `[]` to `['imaging']` | Declare `requiresIndication:false` → `placeOrder` accepts a CT with no reason; the parity pin is where the reviewer sees it |
| A2 | `collectResourceKinds` returns `device` with `initial:'available'`, `occupied:'in_use'`; a second manifest declaring `device` throws at boot | Declare `initial:'in_use'` → refused by the collector's own m4 check (this mutant proves the kernel guard, not ours — record it as such) |
| A3 | Reachability census closes at `131 = held + NOT_YET_MODELLED`; `radiology_receptionist` does not hold `radiology.gates.satisfy`; `radiographer` does not hold `radiology.reports.sign`; `pcpndt_incharge` does not hold `pcpndt.form_f.write` | Grant `radiology.reports.sign` to `radiographer` → the census passes and the SEPARATION assertion dies — the count cannot see it, which is why the three separations are pinned by name |
| A4 | Both definitions round-trip `defineWorkflow` with `changeClass:'A'`; `imaging_gate`'s three exits are terminal | Make `overridden` non-terminal → "is this gate still open?" has two answers |

### T3 — The placement route, idempotency, the encounter guard, the PCPNDT applicability rule, the add-on order, PHI-at-the-reader in the kernel, the `order.placed` consumer — **CRITICAL**

**Files:** `apps/core/src/modules/radiology/place.ts` (new — `placeImagingOrder`), `radiology-orders.controller.ts` (new — `POST /radiology/orders`, `POST /radiology/orders/:orderId/items`), `consumers.ts` (new — `RADIOLOGY_ORDER_PLACED_CONSUMER`, handler creates studies), `applicability.ts` (new — DD14's rule, pure), `radiology.module.ts` (new, Nest wiring; registers no encounter prefix); `apps/core/src/kernel/orders/read.ts` (the two `recordPhiAccess` calls with surface `orders.patient` — **only if row 8 is still 0**), `apps/core/src/kernel/phi/audit.ts` (`PhiSurface` + `imaging.worklist`, `imaging.study`, `imaging.report`, `pcpndt.form_f`, and `orders.patient` if absent), `apps/core/src/kernel/worker/consumers.ts` (`workerConsumers` entry — landed in THIS commit with the handler, the `partnersManifest` rule), and the consumer census the list-grep finds; `apps/core/src/modules/opd/index.ts` (**one exported reader if S2 says the resolver lacks status — `encounterStatusByVisitNo`; otherwise untouched**); tests: `place.test.ts`, `applicability.test.ts`, `consumers.test.ts`, `apps/core/src/kernel/orders/read.test.ts` (PHI rows, only if T3 writes the call).

`placeImagingOrder(db, actor, input, idemKey)`: `withIdempotency` → encounter status guard (DD9) → applicability per item (DD14 → `restricted:true`) → `findRecentItems` duplicate guard (DD10b) → `placeOrder` on one `tx` → returns `{orderId, orderNo, itemIds}`. `POST /radiology/orders/:orderId/items` is the add-on: it reads the parent's `order_group_id` and calls the same function with `origin:'addon'` + `parentItemId` (DD10c) — a new `R` number, never an INSERT into the parent. The consumer creates `imaging_studies` rows (`accession_no` minted from `X` HERE, at study creation, so a study has its number before it has a slot) and starts an `imaging_study` workflow instance per study.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A1 | The same `Idempotency-Key` twice returns the SAME `orderNo` and one `order.placed`; a different key mints a second | Drop `withIdempotency` → two `R` numbers, two studies, two slots (§6A.2's exact failure) |
| A2 | An order on an `abandoned` visit and on a `completed` visit 8 days old is refused `encounter_closed`; on a `completed` visit 2 days old it lands | Drop the age check → a scan hangs off last month's visit and 08's dues follow it |
| A3 | A pelvic USG on a female aged 24 lands `restricted:true` and `form_f_required:true`; the same on a male, and on a female aged 62, lands `restricted:false`; the kernel worklist reader omits the restricted item for a clerk | Compare `administrative_gender` instead of `sex` → a trans man recorded male with a female clinical sex is unregistered under a criminal statute; compare age > 55 with `>=` → a 55-year-old escapes the form |
| A4 | Same service, same patient, within 24h → refused `duplicate_recent` unless `duplicateOfItemId + duplicateReason` are passed, and then `origin:'duplicate_confirmed'` | Skip the window → two doctors' CTs (I9) are two charges and two doses |
| A5 | The add-on route creates a NEW order sharing the parent's `order_group_id`, item `origin:'addon'`, `parent_item_id` = the parent item, and a distinct `order_no`; the parent's header and items are byte-identical before and after; `grep -rn 'insert(orderItems)' apps/core/src/modules` returns nothing | Insert into the parent's `order_items` instead → the write §6A.5/§6A.7 name, with the close deadlock one concurrent completion away |
| A6 | `listOrdersForPatient` writes one `phi_access_log` row with `surface='orders.patient'` and the caller's actor; the test asserts on the ARGUMENT, never `not.toHaveBeenCalled()` on a function taking `Db` (§2.139) | Drop the call → a ward clerk reads every investigation list in the building and nothing records it |
| A7 | The consumer creates exactly one study per `itemIds[]` entry in listed order, and redelivery of the same event creates none | Key studies on `orderId` alone → a two-item order gets one study |

### T4 — Study types as governed definitions, the seed, scheduling, walk-in auto-slot, reschedule/no-show/cancel — **CRITICAL**

**Files:** `apps/core/src/modules/radiology/definitions.ts` (DD13 — `ot/definitions.ts` transcribed: draft/request/publish/active, zod bodies), `study-types.ts` (the twenty seeds + `studyTypeFor(code)`), `schedule.ts` (`scheduleStudy`, `rescheduleStudy`, `markNoShow`, `cancelStudy`, `autoSlotWalkIn`), `radiology-schedule.controller.ts`, `radiology-definitions.controller.ts`; `apps/core/scripts/seed-radiology.ts` (definitions + a runbook that creates the modality `device` resources it is told about — NO hardware assumed beyond "standard machinery exists": one X-ray, one USG, one CT, one MRI, one mammography, each a `device` inside a `room`); `apps/core/package.json` (`seed:radiology`); tests: `definitions.test.ts`, `schedule.test.ts`, `schedule.concurrency.test.ts`.

`cancelStudy`: from `scheduled|checked_in|ready` → `advanceOrderItem(cancelled)` with no reason required; from `in_acquisition` → `advanceOrderItem(cancelled, reason)` AND a `performed_then_cancelled` bill decision if `acquired_at` is set (B6); from `acquired|reported|published` → refused `already_acquired` (the order is a bill decision, not a cancel).

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A1 | Two concurrent `scheduleStudy` for the same device and time — exactly one lands, the other gets `slot_taken`; after the winner is `cancelled`, the loser's retry lands | Drop the partial-unique's `WHERE` clause → a cancelled booking blocks the slot for ever; drop the index → both land (B1) |
| A2 | A device in `qa_blocked`, `down`, `maintenance` or `retired` refuses scheduling; `available` and `in_use` (a slot later today) accept | Check only `retired` → the Monday-09:00 CT with a failed tube keeps taking bookings (G1/G2) |
| A3 | A study type may only be scheduled on a device whose `modality` matches; walk-in auto-slot picks the first `available` device of that modality and `now` | Ignore modality → an MRI booked on the USG room |
| A4 | Cancel after `acquired_at` is refused; cancel from `in_acquisition` requires a reason and raises `performed_then_cancelled` only when `acquired_at` is set | Allow cancel after acquisition → images exist, order `cancelled`, no bill decision, I1's leak |
| A5 | Publishing a `study_types` body needs the approval; `activeDefinition` returns the PUBLISHED version, not the newest draft | Return the newest row → a drafted gate set is live before anyone approved it |

### T5 — Check-in, the gates, screenings, override, readiness — **CRITICAL**

**Files:** `apps/core/src/modules/radiology/checkin.ts` (`checkIn` — opens the gate set from the active `study_types` body and the patient), `gates.ts` (`gateState`, `studyGates`, `satisfyGate`, `waiveGate`, `overrideGate`, `evaluateReadiness` — `ot/gates.ts` transcribed, with per-kind evidence schemas: pregnancy `{declared: bool, lmpDate?, hcgResultRef?}` per the `pregnancy_policy` body; renal `{creatinineUmolL, sampledAt, source: 'internal'|'external'}` with validity days per context; contrast consent (`ot/consents.ts`'s `consentSchema` reused by import); MRI `{implants, pacemaker, clips, cochlear, metalFb, claustrophobia}`; identity `{secondIdentifier: 'dob'|'uhid'|'wristband'}`; laterality `{patientStated}` compared to the item's; chaperone `{chaperoneUserId}`; MLC `{mlcNo?}`), `radiology-study.controller.ts` (check-in, gates, readiness); tests: `checkin.test.ts`, `gates.test.ts`, `gates.concurrency.test.ts`.

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A1 | A CT abdomen on a female aged 30 opens `pregnancy_screen`; the same on a male opens none; a CT with `contrast_option='required'` opens `contrast_consent` + `renal_function` + `prior_contrast_reaction`; an MRI opens `mri_safety`; an obstetric USG opens `form_f` + `chaperone_present` | Drop the sex check → every male gets a pregnancy declaration and the gate becomes noise the floor routes around |
| A2 | `waiveGate('form_f')` and `overrideGate('form_f')` are refused `not_overridable` BEFORE any definition or role is consulted (the refusal happens with an empty definition table) | Consult the definition first → a body that lists `form_f` as waivable makes it waivable (N2's bypass, one row away) |
| A3 | `overrideGate` needs `radiology.gates.override` AND a non-empty reason, writes `override jsonb {actorId, reason}` and emits `imaging.gate_evaluated{outcome:'overridden'}` | Drop the reason → P1's "benefit>risk" is a click |
| A4 | `renal_function` with creatinine sampled 31 days ago in an OPD context is `stale` and cannot be satisfied; 6 days ago in a CKD-flagged context is fresh; an `external` source satisfies with the flag visible in the evidence (H5) | Compare days with the wrong context → an ICU creatinine from last month passes gadolinium |
| A5 | `prior_contrast_reaction` reads `listAllergies` and is `open` with a hard warning when a contrast-class allergy exists; satisfiable only with a radiologist's reason (P2) | Read the prescription's `allergy_overrides` instead → a patient master allergy is invisible |
| A6 | `evaluateReadiness` is true iff EVERY opened gate is terminal-and-not-open, and `identity_two_factor` cannot be `waived` | Count `satisfied` only → an `overridden` renal gate keeps the study un-ready; treat waived identity as ready → A1's wrong Ram Kumar |
| A7 | Two concurrent `satisfyGate` on one gate — one wins, the other `stale_state` (the engine's CAS) | (no mutant of ours — the assertion pins that the gate rides `transition`'s CAS rather than a read-then-write) |

### T6 — The `pcpndt` module: registrations, machines, persons, gap-free Form F serials, the form, cannot-close, the lockout — **CRITICAL**

**Files:** `apps/core/src/modules/pcpndt/registrations.ts` (`createRegistration`, `addMachine`, `addPerson`, `deactivate*`, `activeRegistrationFor(deviceId)`), `form-f.ts` (`openFormF` — mints the serial on the caller's `tx` from `pcpndt_form_f_serials` the `nextEpisodeNo` way; `recordFormF`; `verifyFormF`; `assertFormFRecorded(studyId)`; `assertMachineRegistered(deviceId)`; `assertPersonRegistered(userId, registrationId)`), `lockout.ts` (`LOCKOUT_LEXICON`, `findLockoutHits(text)` — pure), `read.ts` (`formFForStudy` — REAL NAME, logs `pcpndt.form_f`, requires `pcpndt.form_f.read`), `pcpndt.controller.ts`, `pcpndt.module.ts`; tests: `registrations.test.ts`, `form-f.test.ts`, `form-f.concurrency.test.ts`, `lockout.test.ts`, `read.test.ts`.

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A1 | Twelve concurrent `openFormF` on one machine in one year mint 1..12 with no gap and no duplicate; the UNIQUE `(machine_id, serial_no)` refuses a hand-inserted 14 | Read-then-write the counter → two forms share a serial (I6's gap, inverted) |
| A2 | `recordFormF` refuses a machine not on an active registration (`machine_not_registered`) and a person not on that registration (`person_not_registered`); a person registered on registration A is refused on machine of registration B | Check registration existence, not membership → F4's non-registered doctor scans |
| A3 | `assertFormFRecorded` is refused `form_f_missing` for a `form_f_required` study with an `open` form and passes with a `recorded` one; a study with `form_f_required:false` passes with no form | Pass on `open` → H8's after-the-fact form |
| A4 | A recorded form's `sections`, `serial_no`, `person_id`, `patient_id` cannot be UPDATEd and the row cannot be DELETEd (trigger); `verified_at` CAN be set once by a holder of `pcpndt.form_f.verify` who is not `signed_by` | Trigger omits `sections` → the Part F indication is editable after the inspector left |
| A5 | `findLockoutHits` finds `boy`, `ladki`, `बेटा`, `Beti` (case-insensitive, Devanagari) and NOT `boycott`, `Mumbai`, `beta-blocker` (word-boundary) | Substring match → every "beta-blocker" report is unsignable, and the clinic disables the lockout |
| A6 | `formFForStudy` returns `patients.name` even for a confidential patient, and logs `pcpndt.form_f`; the radiology worklist for the same patient shows the alias (T9 A3 pins the other half) | Route the Form F through the alias path → a statutory form with a false name (J1's exact split) |
| A7 | A registration whose `valid_to` has passed makes `activeRegistrationFor` return null — machines on it are unregistered (the O-7 default: hard block; the filed-renewal lift is 18a-ii's) | Ignore `valid_to` → N7 |

### T7 — Acquisition: start (device occupancy), acquired (accession, dose, contrast, repeat), invoice linkage, authorisation, the bill-decision queue — **CRITICAL**

**Files:** `apps/core/src/modules/radiology/acquisition.ts` (`startAcquisition`, `recordAcquired`, `abortAcquisition`), `money.ts` (`linkInvoiceLine`, `authorisationOf(study, encounter)`, `raiseBillDecision`, `resolveBillDecision`), `radiology-acquisition.controller.ts`, `radiology-bill-decisions.controller.ts`; tests: `acquisition.test.ts`, `acquisition.concurrency.test.ts`, `money.test.ts`.

`startAcquisition` order of operations, and it is the whole task: `evaluateReadiness` true → `authorisationOf` not null (DD12) → `assertMachineRegistered` + `assertPersonRegistered` when `form_f_required` → `assignResource(device)` (takes the row lock, refuses busy/down) → `advanceOrderItem(in_progress)` → `status='in_acquisition'`. `recordAcquired`: `assertFormFRecorded` FIRST → dose CHECK per `ionising` → `contrast_given` vs `contrast_option` → `accession_no` already minted (T3) → `releaseResource` → emit `imaging.study_acquired` → raise bill decisions per DD12b.

#### Assertion Book — T7

| # | Assertion | Mutant |
|---|---|---|
| A1 | `startAcquisition` on a device already occupied by another study is refused by `assignResource` (`already_occupied`), and the envelope item is still `placed` afterwards (one transaction, rolled back) | Advance the item BEFORE assigning → a refused start leaves an `in_progress` item nobody is scanning, and its cancel now needs a reason |
| A2 | `recordAcquired` on a `form_f_required` study with no recorded form is refused `form_f_missing` and NOTHING is written — not the accession, not the dose, not the event; the same call after `recordFormF` lands | Move the assert after the dose write → H8 with a partial row |
| A3 | An `ionising` study with every dose field null and `dose_manual=false` is refused by the CHECK (M4); a USG with no dose lands | Drop the CHECK → 18c's register has holes it cannot see |
| A4 | An OPD self-pay study with no `invoice_line_id`, payer `self`, priority `routine` is not authorised (`payment_required`); the same with `priority='stat'` starts; a `tpa` payer starts with `authorised_by='payer_branch'`; a `D…` encounter starts with `authorised_by='daycare'` | Treat `null` payer as authorised → I1's study-done-never-billed |
| A5 | `contrast_given=false` on a study whose invoice line is the with-contrast service raises exactly one `contrast_not_given` decision; `repeat_of_study_id` set raises `repeat_no_charge`; no invoice link and payer `self` on an acquired `stat` study raises `acquired_unbilled` | Raise on every acquisition → the counter's queue is the whole worklist and stops being read |
| A6 | `imaging.study_acquired` is emitted ONCE per study; a second `recordAcquired` on an `acquired` study is refused `already_acquired` (B4 without PACS) | Drop the status CAS → a double-click double-emits and 18c counts the dose twice |
| A7 | After `recordAcquired` the device is `available` again with no occupant | Skip `releaseResource` → the CT is "in use" all day (the `0036`-class trap m4 exists for) |

### T8 — Reports: versions, prelim, sign under a fresh second factor, laterality and the lockout, amend/supersede, criticals, publish and delivery — **CRITICAL**

**Files:** `apps/core/src/modules/radiology/reports.ts` (`draftReport`, `savePrelim`, `signReport`, `amendReport`, `publishReport`, `flagCritical`, `acknowledgeCritical`), `read.ts` (`worklist` — tech/radiologist views, alias path, `imaging.worklist`; `studyView`; `reportView` — `imaging.report`), `radiology-reports.controller.ts` (carries the session to `signReport`), `templates.ts` (per-study-type section skeletons as data — DOCTOR-WISE editing of templates is a `study_types` definition concern and not a table of its own in this slice); tests: `reports.test.ts`, `reports.concurrency.test.ts`, `read.test.ts`.

#### Assertion Book — T8

| # | Assertion | Mutant |
|---|---|---|
| A1 | `signReport` with `secondFactorAt` older than W minutes is refused `second_factor_required`; within W it signs and stamps `second_factor_at` | Drop the freshness check → §11.19-D-27 is a checkbox |
| A2 | A second `signReport` on a study with a `signed` version is refused by the partial unique (B10); `amendReport` inserts v2 `signed` and flips v1 to `superseded` in one transaction, and two concurrent amends produce exactly one v2 | Amend by UPDATE of v1 → the courtroom has one version |
| A3 | Signing an obstetric-USG report containing "it's a boy" is refused `lexical_lockout` naming the hit; the same text on a male patient's knee X-ray signs | Apply the lockout only when `form_f_required` → N9's pregnant trauma CT slips |
| A4 | On a `laterality_applicable` type, `laterality` ≠ the item's is refused `laterality_mismatch` | Drop the compare → A3 (the catalogue's) |
| A5 | UPDATE of a signed report's `body`/`impression`/`signer_id` is refused by the trigger; DELETE refused; `status` and `published_at` may change | Trigger omits `body` → E11 |
| A6 | `publishReport` advances the envelope item to `completed` and closes the order when it was the last live item; a `prelim` cannot be published (`prelim_not_publishable`); publish on an unsettled OPD self-pay invoice SKIPS the enqueue and still publishes in-app (O-2/D5); a `red` critical publishes AND enqueues regardless of settlement | Gate publish itself on payment → the critical waits for the cashier (D5's exact inversion) |
| A7 | `enqueueNotification` throwing (a patient with no channel, S7) does not fail `publishReport`, and the report is `published` (C7) | Let it throw → a report signed at 02:00 is unpublished because a phone number is missing |
| A8 | `worklist` for a technologist without `orders.read.restricted` OMITS restricted studies whose ordering clinician they are not; the radiologist who is a registered person sees the obstetric USG on the same list; a confidential patient's row shows the alias to both | Show restricted rows with the alias → the flag is decoration (T5 A1 of phase 0, one door over) |

### T9 — Five screens, nav parity, the end-to-end proof through the REAL manifest, the CONTRACT — **ROUTINE**

**Files:** `apps/web/src/screens/radiology-reception.tsx`, `radiology-worklist.tsx`, `radiology-study.tsx`, `radiology-report.tsx`, `pcpndt-form-f.tsx` (+ one test each), `apps/web/src/router.tsx` (five routes, nav entries for the three listed in the manifests' `menu`), `apps/web/src/locales/*` (`nav.radiology*`, `nav.pcpndt*`), `apps/core/test/nav-parity.test.ts` (if it pins), `apps/core/test/radiology.e2e.test.ts` (new — a consultant places a CT abdomen with contrast on a female patient aged 30: study created → scheduled → checked in → pregnancy declared, consent, creatinine fresh, prior-reaction none, identity → started (device `in_use`) → acquired (dose, contrast given) → device `available` → drafted → signed under a fresh factor → published → item `completed`, order `closed`, `phi_access_log` rows for each reader; and a SECOND study: obstetric USG on the same patient → `restricted`, `form_f` gate, `recordAcquired` refused until `recordFormF`, then lands; events read back in order), `docs/superpowers/plans/2026-08-29-phase1-18a-radiology-core.md` (§6 confirmed, §9 filled at close).

No fail-first is owed and the report says so. The finding worth more than a mutant here: any assertion in T2–T8 that could not discriminate — record it.

---

## 6. THE CONTRACT — what 18b, 18c, 18a-ii/iii, 62, 63, 64, 26 and 22c-F inherit for free

A downstream plan may write its phase doc against these sentences without reading this phase's code.

1. **An imaging order is an envelope order of kind `imaging`** placed through `POST /radiology/orders` (idempotent by header) or by `placeOrder` from a module with `radiology.orders.place`; every item is one `imaging_studies` row with an `accession_no` from series `X`, created by the `radiology.order_placed` consumer; an added view is a new order in the same group (DD10c). **26 (packages)** composes imaging orders as `system`/`protocol` per phase 0 E11 and gets studies for free; **22c-F** reads `listOrdersForPatient` and `imaging.report_published`.
2. **The study's lifecycle is the `imaging_study` workflow definition** (`scheduled → checked_in → ready → in_acquisition → acquired → reported → published`, with `cancelled`/`no_show`/`rescheduled`); the envelope item is `in_progress` from acquisition start and `completed` at publish. 18b's `study.unmatched` and `image.viewed` are NEW states/events on 18b's tables, keyed `study_id`; 18b writes `study_instance_uid` and flips `image_source`.
3. **Gates are `imaging_gate` child instances declared per study type in the `study_types` definition.** A later slice adds a gate KIND by widening `IMAGING_GATE_KIND_VALUES` + the CHECK (a migration) and its evidence schema; it adds a gate to a TYPE by publishing a definition. **`form_f` is not waivable and not overridable by anybody, in code, and no successor may make it so.**
4. **`device` is a resource kind THIS manifest declared for the whole house** (`available in_use down qa_blocked maintenance retired`). **29 (BME)** and **63 (cath lab)** widen the vocabulary by a disclosed edit to `modules/radiology/kinds.ts`; they do not declare `device` again (boot refuses). **18c** puts devices into `qa_blocked` and out of it; this phase only honours the status.
5. **`pcpndt` is a manifest of its own.** **15b** and **62** install it and call `openFormF`/`recordFormF`/`assertFormFRecorded` against their own study-shaped rows (`study_id` is `text`, not an FK into radiology — deliberately). Serials are gap-free per registered machine per year. Form F readers show the real name and log `pcpndt.form_f`. **18a-ii** compiles returns from `pcpndt_form_f` + `pcpndt_registered_machines` and adds the O-7 filed-renewal lift to `activeRegistrationFor`.
6. **Dose facts live on the study** (`dose_ctdivol dose_dlp dose_dap fluoro_seconds dose_manual`) and `imaging.study_acquired` carries the device; **18c**'s register is a projection of them plus cath lab's (63) and RT's (64) emitted rows, and this phase writes no register.
7. **Money is the counter's.** The study carries `invoice_line_id` and `authorised_by`; `imaging_bill_decisions` is the queue billing works; `imaging.study_acquired{serviceId, contrastGiven, repeatOfStudyId}` is the fact. **46 (TPA)** replaces `authorised_by:'payer_branch'` with its pre-auth object; **41 (IPD)** adds post-to-bed; neither edits this module's tables.
8. **Reports are an immutable version chain**; `signed` is unique per study; amendment supersedes; the second factor is the kernel's `secondFactorFresh`. **18b's Drafter** writes `draft` versions with `provenance` (a nullable jsonb column reserved here, written by nobody yet); the signed document is always a human's.
9. **What this phase did NOT build, in as many words** (so a successor finds a whole thing): no PACS/DICOM/MWL/viewer (18b); no dose register/TLD/AERB/QA workflow (18c); no contrast-administration record or reaction chain, no portable flow, no teleradiology, no release desk, no outside-study register, no emergency clocks, no KPIs, no automations, no prep messaging, no scheduler job (18a-iii, and 31/21/30 where they depend on them); no return compiler, inspection persona, certified prints, registration-expiry lift, solicitation report (18a-ii); no IPD/ED/TPA branch (41/40/46). Each has its columns here and its tables elsewhere.

---

## 7. Edge-case pass — done before finalising (owner standing rule), from brainstorm §5

| # | case (01 §5) | ruled |
|---|---|---|
| E1 | **N2 — 02:00 suspected ectopic, sonologist at home, ED doctor scans** — the decisive one | The ED doctor is a **registered person** on the facility's registration (corporate practice: register every doctor who may scan — O-13's list) and the portable is a **registered machine**; `startAcquisition` checks both; Form F opens at check-in and `recordAcquired` refuses without it; `openFormF` pre-fills nothing on a first scan but the form is A–G on one screen (§15.10's 60-second path is T9's job). **No override, no waiver, no emergency profile reaches around it — by code (T5 A2, T7 A2).** If the ED doctor is NOT registered, the scan is refused and that is the correct behaviour under the Act; the owner registers doctors, not the module |
| E2 | A1 — two Ram Kumars at the CT | `identity_two_factor` gate, never waivable (T5 A6); the console shows DOB read-back |
| E3 | A3 — left knee ordered, right imaged | order laterality on the item; `laterality_confirm` gate at check-in; sign refuses a mismatch (T8 A4). The DICOM tag half is 18b's |
| E4 | A4 — Unknown Male gets CT | `patient_id` is the UNK row (phase 0 S4); merge re-links through the merge path; the study follows the item |
| E5 | A10 — newborn USG on the mother's UHID | study type carries an age band; T4 refuses a neonatal type on an adult and vice versa (a `study_types` body field, `age_band`) |
| E6 | B1 — last MRI slot, two receptionists | the partial unique (T4 A1) |
| E7 | B3 — signed 23:59:58, amended 00:00:05 | versions by `signed_at`; TAT on v1; the digest is 21's |
| E8 | B6 — cancelled while on the table | `in_acquisition` cancel needs a reason; after `acquired_at` it is refused and becomes a bill decision (T4 A4) |
| E9 | B7 — creatinine arrives 2 min after the gate refused | the gate is re-evaluable: `satisfyGate` with fresh evidence; event-driven re-eval on `result.verified` is 17's event and 18a-iii's consumer |
| E10 | B10 — reported twice by two radiologists | partial unique on `signed` (T8 A2) |
| E11 | C1/C2 — core down, modality runs | this slice has no PACS; the paper requisition + backfill with `placed_at` = paper time is phase 0 E13 on the envelope, and `recordAcquired` accepts `acquired_at` in the past with `late_entry` flagged from the delta |
| E12 | C7 — signed, publish delivery fails | in-app never depends on the gateway (T8 A7) |
| E13 | C8 — downtime Form F on paper | a reserved paper-serial block is 18a-ii's; until then a downtime scan is backfilled with a form recorded AFTER the fact **only through the same `recordFormF` with `paper_serial` in `referral` jsonb and `late_entry`** — the cannot-close still holds because the study's `recordAcquired` is also the backfill |
| E14 | D1 — paid, then unfit | reschedule keeps `invoice_line_id`; no refund event (T4) |
| E15 | D2 — contrast not given | `contrast_not_given` bill decision (T7 A5); the vial's wastage is 18a-iii's P3 hook |
| E16 | D3 — TPA denies at 22:00 | `stat` proceeds regardless (T7 A4); routine waits — the pre-auth object is 46's |
| E17 | D5/O-2 — report blocked until paid | delivery only, never in-app, never criticals (T8 A6) |
| E18 | D6/C5/P10 — repeat film | `repeat_of_study_id` + reason; `repeat_no_charge`; dose recorded on both rows (18c reads both) |
| E19 | D12 — refund after images exist | refused as a cancel; bill decision → credit note with approval, billing's path |
| E20 | E1 — 16-year-old pelvic USG, mother present | Form F applies (age ≥10); guardian-consent scope is 22c's/`patients` and the chaperone gate is here; the sensitive-context routing is 62's |
| E21 | E2 — unconscious trauma, contrast CT, no kin | `renal_function` overridable by the radiologist with reason (T5 A3); `contrast_consent` evidence admits `emergency_two_doctor {doctorA, doctorB}` (two DISTINCT ids) per §11.19-C-7 |
| E22 | E3 — MLC skull X-ray | `mlc_check` gate records the MLC number on evidence; legal hold and the police-requisition release path are 40a/18a-iii's |
| E23 | E4 — declared not pregnant, later found 8 weeks | the declaration evidence is stored with the gate (T5); the post-hoc dose task is 18c's |
| E24 | E6/N9 — "it's a boy"; sex in a non-obstetric report of a pregnant woman | lockout at sign, on obstetric types AND on any patient with a pregnancy declaration in 280 days (T8 A3) |
| E25 | F4 — non-registered doctor, sonologist on leave | `person_not_registered` at start (T6 A2); rebooking is the reception's |
| E26 | G1/G2 — CT tube fails; mammo QA fails | `down`/`qa_blocked` refuse scheduling and start (T4 A2); the rebooking cascade and notifications are 18a-iii's over `imaging.study_scheduled` |
| E27 | H5 — outside-lab creatinine on paper | `source:'external'` on the renal evidence, visible (T5 A4) |
| E28 | H8 — Form F after the scan closed | impossible: `recordAcquired` is the close (T7 A2) |
| E29 | I6 — serial gap | gap-free by construction (T6 A1); gap DETECTION over paper-backfilled serials is 18a-ii's |
| E30 | I9 — repeat exposures billed twice | the 24h duplicate window at placement (T3 A4) + `repeat_of_study_id` at acquisition |
| E31 | J1 — staff nurse's own pelvic USG | alias on the worklist and console; real name on Form F (T6 A6, T8 A8) |
| E32 | J7 — public display "Sunita — USG pregnancy" | this slice has no display; the desk's token board is 07c's and announces tokens |
| E33 | M1 — USG with no DICOM | `image_source:'no_pacs_images'`; the study completes; Form F still gated |
| E34 | M4 — no dose SR | manual dose mandatory for ionising (T7 A3) |
| E35 | N1 — third growth scan | a third study, a third form, pre-filled A–D from the previous form for the same patient (T6 `openFormF` copies; a new serial) |
| E36 | N7 — registration expired | hard block via `activeRegistrationFor` (T6 A7); the filed-renewal lift is 18a-ii's (O-7) |
| E37 | P1 — eGFR 28, urgent CT angiogram | radiologist override with reason (T5 A3) |
| E38 | P2 — prior contrast reaction | reads the patients module's allergy list (T5 A5) |
| E39 | P5 — MRI, unknown implant | `mri_safety` evidence with `unknown` refuses satisfy; the X-ray screen is another order |
| E40 | Phase 0 E3 — add a view to an open study request | a new order in the same group (T3 A5, DD10c) → a second study, its own `R` number, its own accession, its own slot; the parent is untouched |

---

## 8. What this phase FREEZES for downstream lanes

1. The eleven table names and every column in §4.1; the rule that 18b/18c/18a-ii/iii add TABLES keyed `study_id` and never a column to `imaging_studies` except the two reserved for 18b (`study_instance_uid`, `image_source`).
2. The `imaging` claim's six fields (DD2) and the series `X` for accession numbers (DD3).
3. The two envelope moments (DD4): `in_progress` at acquisition start, `completed` at publish.
4. The `device` kind's vocabulary and its owner (DD6, §6.4).
5. The ten gate kinds, their evidence shapes, and the two non-negotiables: `form_f` is neither waivable nor overridable; `identity_two_factor` is not waivable (DD7).
6. `pcpndt` as its own manifest; gap-free serials per machine-year; real name on the form; append-only rows (DD14).
7. The applicability rule: `pcpndt_applicable` type + clinical `sex='female'` + age 10–55 → `restricted` + `form_f_required` (DD14).
8. The report version chain and the sign preconditions (DD15).
9. Money: no invoice composed here; `invoice_line_id`, `authorised_by`, and the four bill-decision kinds (DD12).
10. The event names in §4.2 and their payload keys; `pcpndt.form_f_recorded` carries no patient field.
11. The twenty permissions and the three separations (T2).
12. The kernel edits disclosed here and nowhere else: `series.ts` (`X`), `recordPhiAccess` in `orders/read.ts` with surface `orders.patient` (whichever lane lands first), `PhiSurface` + four `imaging.*`/`pcpndt.*` names. **No `addOrderItem`, no `order_item.added`** — an add-on is a new order (DD10c), and any successor that wants the kernel function must show a consumer neither 17 nor 18a had.

---

## 9. CLOSE — filled at execution

### 9.0 Kickoff — the pre-flight, §2 re-measured, the migration number taken, the test databases NAMED

### 9.3 The spike answers (S1–S8), answered at kickoff, before T1

### 9.1 The commits

### 9.2 Findings

### 9.4 The Assertion Book, corrected by execution

### 9.5 Mechanical verification — with the `TEST_DATABASE_URL` database named beside every count (§2.137)

### 9.6 The independent close review — FRESH

### 9.6.2 The SECOND close review — over the remediation diff only, FRESH

### 9.7 Actuals, recorded only after §9.6 exists (v3 §9.4)

### 9.8 The question this phase existed to answer
