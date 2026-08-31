# Plan 18a — Radiology & Imaging, the CORE (no PACS)

**Written 2026-08-29 on the build host, in Lane B of a two-lane authoring fork (Lane A is authoring Plan 17 / LIMS in the same checkout at the same time). NOT APPROVED FOR EXECUTION — execution is a separate session with its own approval, exactly as Plan 17 phase 0 was.** The seed that produced this document is [`2026-08-29-LANE-B-plan-18a-radiology-AUTHOR-PROMPT.md`](2026-08-29-LANE-B-plan-18a-radiology-AUTHOR-PROMPT.md); its §4 (the four shared files) is restated once, in the EXECUTE-PROMPT §4, and nowhere else.

**The question this document rules.** The radiology brainstorm ([`../brainstorms/2026-08-27-department-series/01-radiology-imaging.md`](../brainstorms/2026-08-27-department-series/01-radiology-imaging.md) §14) made 18a conditional on three gates: *"17's order envelope shipped; Plan 15's Form F table shape frozen; PCPNDT registration documents on file."* The first is discharged — the envelope is live in production (prod 46 migrations, deployed 2026-08-29) with zero consumers waiting for a first claimant. The second is discharged **by absence**: Plan 15 shipped no Form F table (`apps/core/src/kernel/db/schema/ot.ts:87` lists `form_f` among the gate kinds *"deliberately absent: 15b/15c/15d own them"*, and 15b is unauthored), so there is nothing to adopt and the brainstorm's "adopt, do not fork" instruction has no object. The third is the owner's (§4A). So the question is no longer *whether* 18a may be authored but *what shape its first slice takes* on an envelope that already exists and a statutory table that does not.

**THE RULING, in one paragraph.** 18a is **the spine — one imaging study walks end to end through the real seams**: a doctor (or a walk-in slip) places an `imaging` order on the kernel envelope by adding ONE manifest field; the reception schedules it against a modality `device` resource with a slot the database refuses to double-book; the patient checks in and passes a declared set of safety gates, each a child workflow instance transcribed from Plan 15's DD5; the technologist starts acquisition, which occupies the device and moves the envelope item to `in_progress`; the acquired study carries its accession number, dose and contrast facts, and emits `imaging.study_acquired`; the radiologist drafts, signs under a fresh second factor, and publishes an immutable versioned report, which completes the envelope item and closes the order. **PCPNDT is structural in this slice, not optional**: the module `pcpndt` — a kernel-adjacent manifest of its own, built HERE and adopted unchanged by 15b and 62 — holds registrations, registered machines and persons, and a gap-free Form F register; an applicable ultrasound is `restricted` at placement, its Form F gate can be neither waived nor overridden by anybody, and the scan cannot reach `acquired` without a recorded Form F. **No PACS** (18b), **no AERB/dose registers** (18c), and the rest of the brainstorm's §14 list — monthly returns and inspections, contrast reaction/ADR chain, portable ward rounds, teleradiology, the release desk, outside-study register, KPIs and automations — is named in §1.3 and §6.9 as the follow-on slices this spine makes buildable, so 18b does not find a half-PACS and nobody finds a half-register.

**STATUS 2026-08-30: PAUSED AT T1 OF NINE — AND T1 IS NOW COMMITTED AND PUSHED.** Lane A executed Plan 17/17a in the same checkout; the migration journal is not hunk-separable, so for a day T1 could not land without carrying another lane's work. **That blocker cleared when Lane A committed `0046`**, and the owner then authorised landing rather than holding. **T1 is committed at `d5abf6a` (green, exit 0, 61/61 on `hmis_lane_b_scratch_1`) and T2's declared surface at `997ab18` (typechecked, NO tests yet — WRITTEN, not proved).** Both are inert: no manifest claims `imaging`, so nothing in production behaves differently. T2's censuses, T3–T9 and both close reviews are all still owed. **CI is GREEN by full SHA** (`33308463171` on `a57e7e4`). **THE HANDOFF IS [`reports/2026-08-30-plan-18a-HANDOFF.md`](reports/2026-08-30-plan-18a-HANDOFF.md)** — self-contained, and the one document a resuming session should read first. §9.9 below is its longer in-document form.

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

**Executed 2026-08-29 18:25 UTC on the build host, in `/opt/hmis`, by the Lane B execution session.**

**Pre-flight (protocol §2), READ rather than run:**

| probe | result | reading |
|---|---|---|
| `ps -eo pid,etimes,cmd \| grep -E "jest\|vitest\|deploy\.sh"` | no matches beyond the probe's own shell (rule 20) | **Lane A is not running.** No suite, no deploy |
| `git status --short` | `?? .ci-watch.log`, `?? docs/design/` | **Neither is mine.** Untracked, present before this session opened, left exactly as found — never staged, never tidied |
| `git log --oneline -5` / `git status -sb` | `dd6f869` at `## main...origin/main`, no ahead/behind | current, nothing to rebase |
| `ls apps/core/drizzle \| tail -3` | `0043`, `0044`, `0045` | **`0046` is free** |
| `uptime` | load average 0.85 | idle; the 18.70 that produced §2.137's 105 failures is not today's box |

**§2 re-measured, every row, with the row's own command. LANE A HAS EXECUTED NOTHING** — the only
commits since the fork are the two plan documents (`a7d1673`, `dd6f869`) and the owner ruling
(`b657a66`). **Lane B is therefore FIRST on all four shared files and on both kernel seams.**

| # | value at write time | value at kickoff | moved? |
|---|---|---|---|
| 1 | 46 (`0000`–`0045`) | **46, `0045_order_envelope_integrity`** | no — **this phase takes `0046`** |
| 2 | `[]` | `[]` (parity.test.ts:28) | no |
| 3 | 17 manifests; worker omits six; worker keys 12 | **17** (`:113` list, `:144`/`:149` counts, `:256` six-omitted, `:289` twelve) | no |
| 4 | `allPermissions` 111; pairs 170; modelled 87; 111 = 93 held + 18 not-modelled | **111 / 170 / 87 / 93 + 18** (lines 633, 755, 760, 769, 822, 823) | no |
| 5 | `seed-roles.ts` dirty in tree | **clean** — `b657a66` landed it | resolved |
| 6 | `device` claimed by nobody | **0 claimants**; `resources_kind_ck` admits it (`schema/resources.ts:159`) | no |
| 7 | Form F / PCPNDT in code | **2 lines**, both OT saying it is absent | no |
| 8 | `recordPhiAccess` in `kernel/orders/read.ts` | **0** | no — **T3 writes the call** |
| 9 | `addOrderItem` | **0**, and it stays 0 (DD10c) | no |
| 10 | controllers mounting the order seam | **0** | no |
| 11 | `PhiSurface` members | **8**, closed union, no CHECK (S1) | no |
| 12 | episode series keys | **8**; `R` reserved and unused | no |
| 13 | `secondFactorFresh(session, windowMinutes, now?)` at `totp.ts:48` | confirmed | no |
| 14 | `walkIn` at `walk-in.ts:80` | confirmed | no |
| 15 | `listAllergies(db, patientId)` at `allergies.ts:56` | confirmed | no |
| 16 | `withIdempotency` from `billing/index.ts:17` | confirmed | no |
| 17 | `OT_WORKFLOW_DEFINITIONS` pinned at `workflow-def.test.ts:18`, installed by `test/helpers/ot.ts:233` | confirmed | no |
| 18 | 13 scheduler jobs | **13** (`jobs.test.ts:336`, `scheduler.test.ts:292`) — this phase adds none | no |
| 19 | ledger §5 at line 1485 | **1485** | no |
| 20 | host idle | load 0.85, no jest | no |

**THE MIGRATION NUMBER TAKEN: `0046`.** Re-measured immediately before and immediately after
`db:generate` (T1), per protocol §7.

**THE TEST DATABASES, NAMED (v3 §9.9 rule 8, ledger §2.137).** Every count this phase claims was
taken with:

```
TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch"
```

`setupTestDb` appends `_<JEST_WORKER_ID>`, so the databases actually created and used are
**`hmis_lane_b_scratch_1` … `hmis_lane_b_scratch_<N>`** (N = the worker count of the run). They are
dropped in the same task that creates them (AGENT-RULES rule 7); the names are recorded here and in
every commit message so that `exit 0` is a claim about a database a reviewer can name even after it
is gone.

### 9.3 The spike answers (S1–S8), answered at kickoff, before T1

**S1 — `phi_access_log.surface` carries NO CHECK.** `schema/phi-access.ts:57` is a bare
`text("surface").notNull()`; the file contains no `check(`, and `0038_phi_access_log.sql` creates the
table without one. `PhiSurface` is a TypeScript union only. **Effect on T1:** none — `0046` widens no
CHECK. **Effect on T3:** the PHI edit is the type union alone.

**S2 — `resolveEncounterByPrefix` returns `{patientId, intendedPayer}` and NO status. AND THE SPIKE
FOUND A DEFECT IN THE SHIPPED RESOLVER — see §9.2 F1.** `EncounterResolver`'s return type
(`encounter-resolvers.ts:49-52`) carries two fields. **Effect on T3:** the DD9 encounter-status guard
needs a reader OPD does not export — `getEncounter(db, id)` (`encounters.ts:132`) queries
`opd_encounters.id`, a `newId()` ULID, **not** `visit_no`. So T3 takes the ONE authorised OPD export.

**S3 — `occupantType` is FREE TEXT; `assignResource` already refuses a down device.**
`resources.occupant_type` (`schema/resources.ts:136`) has no CHECK, so `imaging_study` needs no
admission. More usefully, `assignResource` (`registry.ts:475`) refuses any resource whose status is
neither `decl.initial` nor `decl.onRelease` — with DD6's `initial='available'`/`onRelease='available'`
that means **`down`, `qa_blocked`, `maintenance`, `retired` and `in_use` are all refused
`already_occupied` by the kernel**, and G2 at acquisition start costs T7 no code of its own.
`releaseResource` (`:504`) sets `onRelease` and nulls the triad, which is T7 A7 exactly.
**Effect on T4:** unchanged — scheduling does not assign, so T4 still writes its own status check.

**S4 — NONE of the four roles exists, and the phase document names a role key that does not exist
either.** `seed-roles.ts` declares 27 `roleKey`s; `grep -n 'radiolog\|radiograph\|sonolog\|pcpndt'`
returns **nothing**. So `radiologist`, `radiographer`, `radiology_receptionist` and `pcpndt_incharge`
are all DECLARED, not granted. **CORRECTION to T2:** the doctor role in this repository is
**`doctor`** (`seed-roles.ts:150`), not `consultant`; the grants T2 assigns to "consultant" are
assigned to `doctor`. `billing_manager` (`:302`) exists and takes `radiology.bill_decisions.manage`.

**S5 — one caller, and the window is config.** `secondFactorFresh` is called in exactly one
non-test place: `PermissionGuard` at `auth/guards.ts:117`, with
`this.cfg.secondFactorWindowMinutes` — `SECOND_FACTOR_WINDOW_MINUTES`, **default 5** (`config.ts:41`).
**Effect on T8:** W is that config value, read from `AppConfig`; no second window is invented
(§2.54). The declarative half exists too — `@RequirePermission(perm, { secondFactor: true })`
(`decorators.ts:22`) — so the sign route carries both: the guard challenges, and `signReport` itself
re-checks the session it is handed.

**S6 — production has SIX services in THREE categories and NOT ONE of them is imaging; and
`advised_tests` is empty everywhere.** Read-only SQL on `hmis-prod-db-1`:
`services` = `consultation` ×4, `investigation` ×1 (`SYN-LAB-CBC`), `procedure` ×1; `opd_encounters`
= 13 rows, **0** with a non-empty `advised_tests`. **Effect on T4, and it is a real change:** the
twenty study types have no tariff services to bind to, so `seed-radiology.ts` must **find-or-create**
the service rows itself, on `services_code_ux`, the `seed-ot.ts` idempotency pattern. **DECIDED**
(owner standing rule 2026-08-28): they take `category: 'investigation'` — the category the existing
investigation service already uses — because a new category would key a new `gst_config` row, and GST
rates are a CA sign-off, i.e. money, i.e. routed and not invented. **And the 07d counter-conversion
promise has nothing to convert today**, which is a fact about the pilot's data, not a defect.

**S7 — `enqueueNotification` never looks at a channel; it throws on FOUR shapes, all before SQL.**
`enqueue.ts:68-131`: unregistered template key (`templateByKey` throws), `promotional` class,
patient-audience with no `patientId` (or with a `userId`), non-patient audience with no `userId`. **A
patient with no phone enqueues perfectly well** — the pump discovers that later. The only SQL is one
insert with `onConflictDoNothing`, returning `null` on a dedupe hit. **Effect on T8:** every refusal
shape is a JS throw raised *before* any statement, so the enclosing transaction is unpoisoned and
`publishReport` can catch it and still publish (A7). A genuine SQL failure inside the enqueue would
still abort the transaction — correctly, and the test says so.

**S8 — Lane A has landed NOTHING.** Rows 3, 4, 8, 9 and 11 all stand at their write-time values and
`git log --oneline -5` carries no Lane A code commit. **Lane B is first**, and therefore:
`0046` is ours; **T3 WRITES** the two `recordPhiAccess` calls in `kernel/orders/read.ts` with the
agreed surface `orders.patient`; **T3 WRITES** the `PhiSurface` widening, adding `orders.patient`
plus this lane's four names (`imaging.worklist`, `imaging.study`, `imaging.report`, `pcpndt.form_f`)
and leaving Lane A to append `lab.results` / `lab.report` to the union rather than re-write the call.
Manifest census moves 17 → **19**; `allPermissions` 111 → **131**.

### 9.1 The commits

Four. Two carry code and both are additive and inert — **no manifest claims `imaging`**, so
`collectOrderKinds` still returns `['lab']` and no shipped behaviour changes.

| # | commit | what |
|---|---|---|
| 1 | `2466b46` | the pause: kickoff, spike answers, T1's evidence, findings F1–F6, the handoff |
| 2 | `9b899ae` | F7, and the correction to this document's own CI claim |
| 3 | **`d5abf6a`** | **T1 — eleven tables, `0047_radiology_core`, the `X` accession series, the two whole-row immutability triggers, `truncateAll` across three statements, both `EPISODE_SERIES` censuses. GREEN: exit 0, 4 suites, 61/61, on `hmis_lane_b_scratch_1`** |
| 4 | **`997ab18`** | **T2 PARTIAL — the two module skeletons (manifests, kinds, events, workflow definitions, approval type, error unions). Typechecked and linted; NO tests of their own yet. Installed by nobody: neither manifest is in `ALL_MANIFESTS`** |
| 5 | `e9c425c` `74e3079` `a407719` `620b7c1` | **T2, T3, T4 and the owner's seed ruling.** Per-commit breakdown in the T4/T5 handoff (`b1319f1`) |
| 6 | *(this task)* | **T5 — check-in and the gate set DERIVED from the type's flags and the patient; the ten kinds' evidence rules; the waiver and override lanes with `form_f` and `identity_two_factor` refused BY KIND before any read; readiness; one mounted controller. GREEN on `hmis_lane_b_scratch`: 3 new suites / 76 tests, every radiology suite 12 / 176, the censuses 12 / 126. ALL SIX NAMED MUTANTS DIED. The full workspace verify is RED IN THE OTHER LANE'S FILES and unattributable — CI by SHA is the instrument (§9.5-T5)** |

Also on `main` from this lane, addressed to Lane A rather than to this phase:
`26d1a1b` (the coordination contract) and `57b93fa` (the reply — F26's attribution, the
`advance.test.ts` cascade, and the frozen-file escalation).

**Why T1 landed after all.** The blocker was never a shared census — it was
`drizzle/meta/_journal.json`, which cannot be split by hunk: committing `0047` while Lane A's
`0046` row sat uncommitted meant either orphaning theirs (red `main`, broken deploy) or committing
their migration for them. **Lane A committed `0046` in `39beff0`, and the blocker evaporated** — the
journal diff became one entry, its own. The owner then ruled that the work should land rather than
sit uncommitted in a tree another lane was actively working in, which is the more fragile of the two
parking spots by a wide margin.

### 9.2 Findings

**F1 — A LIVE DEFECT IN SHIPPED CODE: `registerOpdEncounterResolver` CANNOT RESOLVE ANY `V…` NUMBER.**
*(found by spike S2, before T1; not fixed by this phase — it belongs to whoever mounts the first
route that places an order on an OPD visit)*

`opd.module.ts:59` registers the resolver under prefix `EPISODE_SERIES.visit` (`"V"`), so
`resolveEncounterByPrefix` hands it a visit NUMBER — `V2608290001`. It calls
`getEncounter(db, encounterId)`, and `encounters.ts:132` is
`where(eq(opdEncounters.id, id))` — `opd_encounters.id` is a `newId()` ULID (`encounters.ts:77`),
never `visit_no`. **Nothing in `apps/core/src` reads that table by visit number at all**
(`grep -rn 'eq(opdEncounters.visitNo' apps/core/src` → 0). The OT's resolver, one file over, reads
`daycareEncounters.encounterNo` correctly — so this is a divergence between two implementations of
one seam, not a design.

It has never been caught because **every phase-0 order suite registers its own fake `V` resolver**
(`place.test.ts:79`, `advance.test.ts:64`, `read.test.ts:74`, `envelope.e2e.test.ts:78`), and
billing never reaches it: billing passes bare row ids, which match no prefix and fall through to its
own OPD fallback. Row 10 measured **0 controllers mounting the order seam**, so the defect is latent
rather than live in production today.

**Consequence for whoever resumes:** `placeOrder` on a real `V…` encounter returns
`{matched: true, resolved: null}` → `unknown_encounter`. T3 and T9's end-to-end proof are the first
callers that would hit it. The fix is one line (read by `visitNo`), but it is in `modules/opd/*`,
which this phase's EXECUTE-PROMPT §3 freezes beyond the ONE export S2 may require — so it is
reported rather than taken. **It should be proved by execution, not by reading**, and the test that
proves it is the regression test.

**F2 — THE T1 SUITE CAUGHT TWO DEFECTS IN ITSELF, AND BOTH ARE WORTH THE RECORD.** Neither was a
defect in the migration; both were assertions that could not mean what they said.

- **A bogus `status` tripped the WRONG constraint.** `form({status: 'draft'})` was written to prove
  `pcpndt_form_f_status_ck`, and Postgres answered with `pcpndt_form_f_recorded_shape_ck` — because
  any status that is not `open` also requires a signer, and **Postgres does not promise which of two
  violated CHECKs it reports.** The row must otherwise be VALID for a vocabulary assertion to be
  about the vocabulary. Fixed by signing the form.
- **THE IMMUTABILITY TRIGGER CORRECTLY PERMITS A NO-OP UPDATE, and the first draft asserted it did
  not.** The trigger compares WHOLE ROWS (§9.4), so `set person_id = <the id it already has>`
  mutates nothing and is not refused. Proved at the database rather than reasoned about: a
  hand-issued `UPDATE … SET person_id = 'PE1'` on a row whose `person_id` is already `PE1` succeeds,
  and the same statement with a different value raises `pcpndt_form_f_immutable`. **A BEFORE ROW
  trigger also runs ahead of foreign-key checking** — confirmed the same way — so the freeze answers
  before the FK, which is what lets the assertion use ids that exist nowhere. Both halves are now
  assertions in their own right.

**F3 — PRODUCTION HAS NO IMAGING SERVICE AND `advised_tests` IS EMPTY (spike S6). CHANGES T4.**
Read-only SQL on `hmis-prod-db-1`: six `services` rows in three categories — `consultation` ×4,
`investigation` ×1 (`SYN-LAB-CBC`), `procedure` ×1 — and 13 `opd_encounters`, **zero** with a
non-empty `advised_tests`. So the twenty study types have nothing to bind to and
`seed-radiology.ts` must **find-or-create** its own tariff rows on `services_code_ux`
(`seed-ot.ts`'s idempotency pattern). **DECIDED:** `category: 'investigation'`, matching the
existing investigation service, because a new category keys a new `gst_config` row and a GST rate is
a CA sign-off — money, therefore routed and not invented (owner standing rule 2026-08-28). And 07d's
counter-conversion promise has nothing to convert today: a fact about the pilot's data, not a defect.

**F4 — THE PHASE DOCUMENT NAMES A ROLE THAT DOES NOT EXIST (spike S4). CHANGES T2.** `seed-roles.ts`
declares 27 `roleKey`s and none of `radiologist`, `radiographer`, `radiology_receptionist`,
`pcpndt_incharge` is among them — all four are DECLARED by T2, not granted. **And the doctor role in
this repository is `doctor` (`seed-roles.ts:150`), not `consultant`**, which is the key T2's own text
uses. `billing_manager` (`:302`) exists and takes `radiology.bill_decisions.manage`.

**F5 — §4.1 AND DD5 DISAGREE BY ONE WORD ABOUT THE SLOT PREDICATE, AND §4.1 WINS.** DD5 writes the
partial unique as `WHERE status NOT IN ('cancelled','rescheduled')`; §4.1's table spec adds
`'no_show'`. **`no_show` is included**, and the reason decides it rather than the ordering of the
two paragraphs: the machine is idle whether the patient cancelled or simply did not come, so a
no-show that held its slot would take a working machine out of the day's list for no clinical
reason. Both freeing statuses are proved by execution (T1, `it.each`).

**F6 — LANE COLLISION: FIVE SHARED FILES AND A NON-SEPARABLE JOURNAL.** Recorded in full in §9.9.

**F8 — `advance.test.ts` IS A BUILD-HOST-UNDER-LOAD FLAKE, NOT A STANDING CI RED, AND THIS LANE
PREDICTED THE WRONG THING.** *(recorded because the prediction was stated to the owner and to Lane A
before the evidence arrived)*

Lane A's full `pnpm verify` on this host failed four rows of `kernel/orders/advance.test.ts`; Lane B
diagnosed the shape (two `Exceeded timeout of 15000 ms`, two CASCADE — a duplicate key at
`seedFixture:55` and a deep-equality — because the aborted timeouts leave rows behind), and then
**asserted that it "will block Lane B's T1 the moment it lands"**.

**It did not.** CI run `33308463171` on `a57e7e4` — the tree carrying T1, T2's surface and this
document — came back `completed | success`. Full green, `advance.test.ts` included.

**The mechanism, restated correctly:** the failure is a function of the HOST and the LOAD, not of the
file. Twelve-round concurrency measurements against a 15-second default timeout fail on this build
box during a full parallel verify with a second lane active; they pass 26/26 in isolation on the same
box, and they pass on GitHub's runner. **So the escalation's premise needs narrowing: it is a LOCAL
VERIFY instrument that is broken, not CI.** That is still worth fixing — a `pnpm verify` nobody can
get green is an instrument two lanes lose — but it blocks no phase from closing on CI grounds, and
Lane B was wrong to say it would.

**The general rule this is a specimen of, and it is the one worth keeping:** *"a red on the build
host and a red in CI are two different claims, and neither implies the other."* §2.55's lesson is
that a green local verify can hide a red CI; this is the same coin's other face, and the honest move
in both directions is to name the box.

---

**F9 — A SEPARATION THE PLAN STATES TWICE WAS DEFEATED BY THE WORKFLOW DEFINITION IN THE SAME
COMMIT THAT STATED IT.** *(found by writing T2's tests before building on T2's code; fixed here)*

`997ab18` shipped `imagingGateDefinition` with `open → satisfied` naming
**`radiology_receptionist`**, in the same commit whose `manifest.ts` says the opposite in as many
words — *"The person who books the scan and takes the money does not get to record that the patient
is not pregnant"* — and which §5 T2 lists as the FIRST of three separations the reviewer checks.

**The census could not have caught it, and neither could T2 A3 as written.** A3 asserts the
separation on the PERMISSION registry. `advanceInstance` (`kernel/workflow/instances.ts:115`) gates a
transition on `actorHoldsAnyRole` against `role_assignments` / `temp_role_grants` and **consults no
permission at any point**. That is Plan 17b's F39 seen from the other side: two enforcement planes,
and a separation stated only on the plane that is not consulted is not a separation. A receptionist
holding the role key would have driven `pregnancy_screen`, `mri_safety` and `form_f` alike to
`satisfied` with every census green — one definition covers every gate KIND, so there is no per-kind
role list to retreat to.

**Fixed**: the role is off the edge, and the assertion now lives on BOTH planes —
`seed-roles.test.ts` for the permission, `modules/radiology/workflow-def.test.ts` for the
definition. `doctor` and `radiologist` stay (T5 A5 needs the radiologist; the referring clinician
takes contrast consent). **The general lesson is worth more than the fix: wherever this repository
states a separation, it must be asserted on the plane the engine actually reads.**

**F10 — `consultant` IS NOT A ROLE IN THIS REPOSITORY. DECIDED: the grants go to `doctor`.**

**This was not a discovery — the KICKOFF SPIKE had already found it and said so**, and it is
recorded here as the DECISION it needed rather than as a new finding: the spike's T2 note reads
*"none of `radiologist`/`radiographer`/`radiology_receptionist`/`pcpndt_incharge` exists, and the
doctor role here is `doctor`, not `consultant` as the phase doc's T2 text says."* The spike named
the discrepancy; nobody had yet ruled on which way to resolve it.

§5 T2's role sketch names `consultant (+ orders.place, orders.read, radiology.orders.place,
radiology.reports.read)`. There is no such role: the treating clinician has been `doctor` since
Plan 02, `lab.orders.place` was granted there for the same reason, and `doctor` is the key the
imaging workflow's own transitions name. Declaring a second clinician role would split every future
grant across two keys and make *"can the treating doctor do this?"* a question with two answers.
Taken under the owner's standing rule; recorded rather than silently reinterpreted.

`doctor` gains `radiology.orders.place` and `radiology.reports.read` — **the report, not the
worklist**, because the worklist is a departmental queue and DD11 makes it confidentiality-bearing.

**F11 — THREE CENSUS FILES THAT T2 MOVES ARE IN NO TASK'S FILES LIST.** *(the §2.138 pattern, third
specimen)*

`kernel/resources/kinds.test.ts`, `kernel/orders/kinds.test.ts`, `kernel/orders/parity.test.ts` and
**`test/seed-staff.test.ts`** all pin counts this task moves, and none is named in T2's Files list.
The fourth was found by the FULL VERIFY rather than by either grep, and it is the one with a
consequence a reader can feel: `seed:staff` REFUSES a roster naming a role key outside
`KNOWN_ROLE_KEYS`, so until it carried these four, the roster hiring the hospital's first
radiographer would have been rejected as a typo and the whole roster refused rather than
half-provisioned.

The first three were found by the list-grep (`grep -rln "ALL_MANIFESTS"`) rather than by grepping
for a sibling's name — which is exactly what that rule exists for, since each derives from the list
instead of naming a member of it. **The fourth was found by neither grep**, because `seed-staff.ts`
derives `KNOWN_ROLE_KEYS` from `ROLE_MODEL` and never mentions `ALL_MANIFESTS` at all: a census one
hop further out than the rule's own search reaches. That is the finding worth carrying — §2.138's
two greps are necessary and are not sufficient, and the instrument that caught the fourth was the
FULL WORKSPACE VERIFY. All four are recorded rather than fixed silently, the way Plan 17 recorded F6
and Plan 15 recorded T2-f.

**One of them lost its subject rather than its number.** `resources/kinds.test.ts` asserted
*"`device` is legal in the table and not yet a kind this hospital has"* — and `device` was the LAST
of the ten names `resources_kind_ck` admits to find a declarer. There is no legal-but-undeclared kind
left to point at. The test is REWRITTEN to assert the property it existed for (the collector reads
manifests, never `RESOURCE_KIND_VALUES` — proved by removing a manifest and watching the set shrink
while the CHECK does not move), rather than deleted or pinned to a falsehood.

**F17 — THIS PHASE WROTE ITS OWN §2.144: A RACE TEST AT THE EDGE OF ITS BUDGET, AND THE CASCADE IT
CAUSED LOOKED LIKE SOMETHING ELSE ENTIRELY.** *(T4, found by the full verify and by nothing else)*

`schedule.concurrency.test.ts`'s A1 ran five rounds, and each round called `truncateAll` and rebuilt
the WHOLE radiology fixture — patient, four services, the published book, the encounter, the
permission registry, the Class-A governance sequence, five devices. **Isolated it passed. Under a
full workspace verify it hit `Exceeded timeout of 15000 ms`** — and then its abandoned async work
raced the NEXT test's `beforeEach`, which failed with `duplicate key value violates unique constraint
"patients_pkey"`. Two failures, one cause, and the second one names a table the test is not about.

**The fix is not a longer timeout.** The rounds never needed a fresh fixture: they contend for one
slot, and a slot is a `(device, instant)` pair, so five rounds can share one fixture and take five
different INSTANTS. Restructured, the test runs in **4 742 ms — 32% of the default budget** against a
first version that exceeded it.

Ledger §2.144 is this exact class, found in another lane: *"one test at 72% of its default budget on
an idle box, and a cascade hid it."* This phase produced its own specimen three days later, which
says the lesson had not yet become a habit. **The mechanical form worth carrying: a test that builds
a fixture inside a loop is a test whose cost is multiplied by the loop, and the budget it must fit
is 15 s on a CONTENDED box, not on an idle one.**

It is also the strongest argument yet for §9.9 rule 6, which this phase's own audit had just added:
the targeted batch ran this suite green four times, and only the full verify ever saw it fail.

**F13 IS CLOSED — `study-types.ts` OWNS THE BOOK AND `place.ts` DELEGATES.** *(T4)*

T3 recorded the debt in as many words. T4 discharges it: `activeStudyTypes` and `studyTypeByService`
live in `study-types.ts`, `place.ts` re-exports them, and `consumers.ts` imports from the owner. One
piece of code decides whether a scan falls under the PCPNDT Act, which is the whole point — a second
reader of a statutory flag is the exact shape of defect the design is built to avoid.

**F15 — T4's SCHEMA CAUGHT T3's TEST FIXTURES WRITING BODIES THAT COULD NEVER HAVE BEEN PUBLISHED.**
*(T4, and it is §2.49's vacuous-fixture shape one layer down)*

T3's suites inserted `study_types` bodies carrying four fields — `code`, `service_id`, `modality`,
`pcpndt_applicable` — which was everything T3's reader needed. T4 gave the body a zod schema and
those bodies stopped parsing: no `name`, no `body_part`, no `duration_min`, no `ionising`, no
`contrast_option`, no `chaperone_required`, no `laterality_applicable`.

**The fixtures were asserting against a state the system cannot reach.** A body of that shape is
refused by `draftDefinition`, so it could never have been PUBLISHED — every T3 assertion about
PCPNDT applicability was therefore true of a definition no hospital could ever have. The assertions
themselves were right and still pass; what was wrong was the ground they stood on.

The repair is `test/helpers/radiology.ts`'s `studyTypeRow()`, which builds a row that satisfies the
published schema and lets each suite override only the flags its assertion is about. **The
generalisable form: when a task adds a SCHEMA to data an earlier task wrote by hand, re-run the
earlier task's suites before anything else — they are the ones most likely to have been writing
shapes the schema now forbids.**

**F16 — THE SEED LIST CAME TO TWENTY-ONE AGAINST DD13's STATED TWENTY, AND THE SEEDS WERE WRONG.**
*(T4)*

`definitions.test.ts` asserts `STUDY_TYPE_SEEDS` has twenty entries because DD13 says twenty. The
first draft had twenty-one — a second lateralised X-ray that duplicated the branch `XR-KNEE` already
exercises. **The seed list was corrected, not the assertion**, which is the direction that matters:
the count is a plan commitment and the test is what holds this task to it.

**OWNER RULING 2026-08-31 — `seed:radiology` SELF-PUBLISHES. The recommendation below was put to the
owner and REVERSED.**

T4 shipped the seed drafting and stopping, on the reasoning in the paragraphs that follow. The owner
ruled that the pilot needs a department that can be stood up without a second human standing by —
the same second-administrator shortfall that holds Plan 17b would otherwise have held this too, and
that is too high a price for a seed step.

**The ruling is implemented in its honest form, not as a rubber stamp.** `activateSeededDefinition`
re-parses the body (a bad book is still refused), supersedes any previous active version in one
transaction, and **leaves `approval_id` NULL**. That NULL is the whole safeguard: a seeded activation
stays distinguishable from a governed one for ever, so an inspector asking *"who approved the gate
set in force on this date"* gets a truthful answer either way. It deliberately does NOT mint a second
system actor to approve its own request — the form that looks more correct and destroys the audit
answer. `definitions.test.ts` pins the contrast between a seeded row and a governed one, so a later
"tidy-up" into a rubber stamp fails a test.

**The governed path is untouched**: the publish route still requires a granted MS approval and is
still the only way a HUMAN changes the book. Every version after the seed's first goes through it.

**The original reasoning, kept because the trade is real and may be revisited:**

**A DECISION T4 MADE THAT THE PLAN LEAVES OPEN: `seed:radiology` DRAFTS AND DOES NOT PUBLISH.**

The seed creates the twenty services, the five `device` resources and a `study_types` DRAFT with its
publish approval already filed — and stops. Publishing needs a granted `imaging_definition_publish`
approval from the medical superintendent, and **a seed script that granted its own approval would
make the governed-definition design decorative**. So the runbook's last step is a human, and until
they take it the department is inert: `activeDefinition` refuses, so no imaging order can be placed
at all. That is the correct posture for a hospital that has not yet said what its imaging department
may do, and it is the same shape as the go-live runbook 17b wrote for the lab.

It also means **the seed cannot be verified end-to-end by a script** — the last step needs a second
human, which is the same organisational blocker Plan 17b is held on.

**F12 — SPIKE S2's ANSWER HAS FLIPPED AGAIN, AND T3's ONE AUTHORISED OPD EXPORT IS NOT NEEDED.**

S2 concluded that the DD9 encounter-status guard *"needs a reader OPD does not export"*, and T3's
Files list authorised exactly one: `encounterStatusByVisitNo` on `modules/opd/index.ts`.

**Re-measured at T3: no export is required.** Lane A's F1 repair made `getEncounter(db, id)` accept
a visit NUMBER as well as a row id (`encounters.ts:295` — `if (VISIT_NO_RE.test(id)) return await
getEncounterByVisitNo(db, id)`), and `getEncounter` was ALREADY exported from `modules/opd/index.ts`.
The row it returns carries `status` and `service_date`, which is the whole of what DD9 needs.

**`modules/opd/*` is therefore untouched by this task**, which is the better outcome: 17a §8 freezes
that tree, and the export S2 asked for would have been a permanent widening of another module's
interface to serve one guard. A defect repair in one lane removed the need for an interface change
in the other, and that is worth recording because it will not be obvious to anyone reading S2 later.

**The day-care leg took a different route, and it is the weaker half.** OT exports no encounter
status reader, and T3 is authorised to ask OPD for one export, not OT. So `assertEncounterOpen`
reads `daycare_encounters.status` from the KERNEL SCHEMA directly — the table is
`kernel/db/schema/ot.ts`, not a module internal, so no lint rule is bent — while the TERMINAL
VOCABULARY comes from OT's own exported `daycareCaseDefinition`, so the list of states that end a
case has one owner and cannot go stale here. **Measured**: no production module reads another's
encounter table today (only tests do), so this is the first, and a later phase that adds
`daycareStatusByEncounterNo` to `modules/ot/index.ts` should collapse it.

**F13 — THE STUDY-TYPE READER LIVES IN `place.ts` UNTIL T4 OWNS IT.**

Applicability is read from the ACTIVE `study_types` definition and never from the caller — an input
carrying `pcpndtApplicable: false` would be a statutory bypass anybody with the route could type. But
T4's `study-types.ts` is the file that will own the book, and T4 has not run, so `activeStudyTypes`
and `studyTypeByService` are in `place.ts` for now. **T4 must make `study-types.ts` the single owner
and have these delegate**, or the hospital will have two readers of one book. Recorded so the next
task inherits the obligation rather than discovering the duplicate.

Two consequences of reading the book that are correct and worth stating: a hospital with **no active
study-type definition cannot place an imaging order at all** (`definition_not_active`), and a service
**named by no study type is refused** (`unknown_study_type`) rather than defaulted to "not
applicable" — a typo must not be able to produce an unregistered obstetric scan.

**F14 — TWO MORE CONSUMER CENSUSES, IN NO TASK'S FILES LIST, AND THIS IS THE THIRD PHASE RUNNING.**

`test/worker-runtime.e2e.test.ts` (the whole-equality bus census) and
`src/kernel/worker/seed-cursors.test.ts` (the cursor census) both pin the consumer set that T3's
`order.placed` subscription moves, and neither is in T3's Files list. Plan 14 recorded the identical
omission as its F11, Plan 15 as its T2-f, and T2 of this phase found four more as F11 — **five
census files in this task, and the standing observation now has enough specimens to stop being an
observation.** The §2.138 list-grep does not find either of these: both derive from
`workerConsumers`, not from `ALL_MANIFESTS`.

`radiology.order_placed` is the SEVENTH wire and the first to subscribe to a KERNEL event. The six
before it each subscribe to a module's own event; `order.placed` is raised for every claiming kind,
so this handler sees the lab's orders and returns on `kind !== "imaging"` before touching a row —
which is what lets a third ordering module be added later without the wire changing.

**A DECISION THIS TASK MADE THAT DD14 DOES NOT COVER: an UNKNOWN date of birth is APPLICABLE.**
DD14 says an ESTIMATED DOB counts and is silent on an ABSENT one. `patients.dob` is nullable. The
rule treats a female patient of unknown age on a covered study type as applicable, because the Act's
default is the form and the exemption is what must be established — and the two errors are not
symmetrical: over-applying costs a Form F filled in for a woman who turns out to be 68, and
under-applying is an unregistered obstetric scan. Argued in `applicability.ts`'s header and asserted
in `applicability.test.ts`.

**F7 — THE BUILD HOST HAS SIXTY UNAUTHENTICATED GITHUB API CALLS AN HOUR, AND BOTH LANES SPEND FROM
THE SAME BUCKET.** *(self-inflicted, and recorded because the mechanism is not)*

This session polled the Actions API for a CI verdict, then left a watcher running and started a
second one. The result: `{"message": "API rate limit exceeded for 62.238.106.231"}`,
`{'limit': 60, 'remaining': 0, 'used': 60}`, **and no CI verdict obtained at all** — the last
observed state was `in_progress`.

The self-inflicted half is §2.130 exactly (*"arm exactly ONE blocking waiter and then stop
asking"*), and it is the ordinary lesson. **The half worth keeping is that the quota is per IP, not
per session.** `ci-watch-host.sh` works because the repository is public and the unauthenticated
endpoint answers over plain `curl` (§2.33's archive note) — but sixty calls an hour is the whole
budget for the HOST, so two lanes watching two SHAs share it, and a lane that polls hard can starve
the other lane's watcher of the one instrument §2.55 says is not optional. A twenty-second poll loop
alone is 180 calls an hour, three times the ceiling.

**MECHANICAL FORM:** poll CI no faster than once a minute, run ONE watcher, and when the API answers
`none|none` treat it as *"ask again later"* rather than as a verdict — an empty `workflow_runs` array
and a rate-limit refusal are indistinguishable at the shape level, and only one of them means
anything about the build.


---

## ═══ T5's FINDINGS (2026-08-31) ═══

**F18 — `imaging_studies.ionising` IS NEVER WRITTEN, AND TWO COMMENTS DISAGREE ABOUT WHO SHOULD
WRITE IT. IT MAKES M4's DOSE CHECK VACUOUS TODAY.** *(found by T5 while reading the study row;
OWNED BY T7, not fixed here)*

`radiology.ts`'s table header says the column is *"SNAPSHOTTED from the study type at creation,
exactly as `ot_case_gates.waivable` snapshots from the criteria definition at booking"*.
`definitions.ts`'s study-type comment, one file over, says *"`ionising` — snapshotted onto the study
at acquisition for 18c's dose register"*. **`handleOrderPlaced` is the creator and does not set it**
(`grep -n ionising consumers.ts` → 0 hits), so **every study in this database is `ionising = false`
whatever its type says**.

The consequence is not cosmetic. `imaging_studies_dose_ck` — M4, *"an ionising study that was
acquired carries a dose number"* — reads THIS COLUMN, so today the CHECK can never fire and T7 A3's
mutant (*"drop the CHECK → 18c's register has holes it cannot see"*) would be indistinguishable from
the shipped code. **A CHECK on a column nothing writes is a control that reads as green.**

**Reported rather than taken**, the way F11 and F14 were: `consumers.ts` is T3's file and
`acquisition.ts` is T7's, and T5's Files list names neither. **T7 owns the fix and the CHECK's own
timing decides where it goes** — the constraint fires on `acquired_at`, so writing `ionising` at
acquisition satisfies both comments and needs no change to T3. T7 A3's fixture must then assert the
column is TRUE for an ionising type rather than assuming it, or the assertion is vacuous in the
other direction.

**F19 — THE `open → satisfied` EDGE NAMES FOUR ROLES AND EXACTLY ONE OF THEM CAN REACH IT OVER HTTP.
THIS IS F9's LESSON POINTING THE OTHER WAY.** *(measured at T5; the close review owns the ruling)*

`imagingGateDefinition`'s `open → satisfied` allows `radiographer, radiologist, doctor, system`, and
F9's own note explains why the last two stay: *"`doctor` and `radiologist` stay (T5 A5 needs the
radiologist; the referring clinician takes contrast consent)."*

**Measured at T5: they cannot.** `seed-roles.ts` grants `radiology.gates.satisfy` to `radiographer`
ALONE — `radiologist` holds `radiology.gates.override` **and not** `.satisfy`, by an explicit and
well-argued comment (*"DD7 makes the radiologist the second clinical opinion on a gate the
technologist raised"*), and `doctor` holds neither. Every satisfy route carries
`@RequirePermission("radiology.gates.satisfy")`, so a radiologist or a doctor calling it is refused
**403 by the guard before the engine's role check ever runs**.

**F9 was a role on the engine's plane that should not have been there. This is two roles on the
engine's plane that the guard's plane never lets through** — the same defect class, and the second
specimen in one phase, which is what makes it worth recording rather than fixing quietly. It fails
SAFE (the narrower plane wins), so nothing is exposed; what it costs is that two of the four names
on that edge are dead, and a reader of `workflow-def.ts` would conclude otherwise.

**T5's design absorbs it instead of widening a file it may not touch.** A5's
`prior_contrast_reaction` takes the radiologist's decision as EVIDENCE — `{radiologistId, reason}`,
with `actorHoldsAnyRole(tx, radiologistId, ["radiologist"])` verifying the named person — so the
radiographer at the console records a decision that is attributable to the radiologist who made it.
That is a better record than "the radiologist logged in and clicked", and it works with the grants
exactly as shipped.

**The close review owns the ruling**: either `seed-roles.ts` grants `radiology.gates.satisfy` to
`doctor` and `radiologist` as `workflow-def.ts` assumes, or the two names come off that edge. What
must not stand is the two planes disagreeing while a comment in each says the other one is right.

**F20 — THE PLAN'S EVIDENCE SKETCH CARRIED FOUR CHECKBOXES, AND T5 STRENGTHENED ALL FOUR.**
*(disclosed deviations; every one is in the "computed rather than typed" direction `ot/gates.ts`
argues for, and every one is asserted)*

| kind | §5 T5's sketch | shipped | why |
|---|---|---|---|
| `identity_two_factor` | `{secondIdentifier: 'dob'\|'uhid'\|'wristband'}` | **`+ value`**, COMPARED against `patients.uhid` / `patients.dob` | the sketch records which question was asked and not what the answer was. A wristband has no registry to compare against in this slice, so it is recorded as stated — which is why the two comparable kinds are compared |
| `pregnancy_screen` | `{declared, lmpDate?, hcgResultRef?}` | **`+ hcgResultAt?`** | `pregnancy_policy.hcg_validity_days` is a validity IN DAYS and the sketch carries no instant to measure it from. A pointer cannot be aged |
| `renal_function` | `{creatinineUmolL, sampledAt, source}` "with validity days per context" | context **DERIVED** from the study's encounter-number prefix; only `ckdFlagged` is typed | A4's own mutant is *"compare days with the wrong context"*, and a context the recorder TYPES is that mutant with extra steps — the person in a hurry types the band with the longest window |
| `mlc_check` | `{mlcNo?}` | `ot/gates.ts`'s **`{status: 'registered'\|'ruled_out', mlcNo?}`** | E5: "ruled out" is a DECISION and is recorded as one. A bare optional number cannot express it |

`renal_function` also refuses to SATISFY above a named creatinine ceiling (2.0 mg/dL as µmol/L),
which is not in the sketch either: a gate that records a creatinine of 900 without reading it is a
checkbox with a number on it. The lane above the ceiling is the radiologist's override, which is
what makes somebody write a reason down.

**F21 — A7's FIRST DRAFT MEASURED THE NODE SCHEDULER AND NOT THE DATABASE, AND IT WAS GREEN-ADJACENT
ENOUGH TO HAVE BEEN KEPT.** *(found by running the test; the generalisation is the point)*

Two plain `withTx(satisfyGate)` calls raced through `Promise.allSettled` produced one winner and one
loser — the right SHAPE — but the loser's code was **`gate_already_terminal`, not `stale_state`**.
Under READ COMMITTED the two transactions had simply SERIALISED: the winner committed before the
loser's pre-read ran, so the loser refused at the kindness check and **never reached the CAS at
all.** A read-then-write implementation would have produced the identical result.

The fix is to CONSTRUCT the overlap rather than hope for it: each transaction is held open for
200 ms after its write, so **both callers read `open` before either commits**. The loser's
conditional UPDATE then blocks on the winner's row lock, re-evaluates after the commit, matches
nothing, and the engine raises `stale_transition` → `stale_state`.

**The mechanical form worth carrying, and it is this phase's second concurrency lesson after F17:**
*a concurrency assertion whose subject is a COMPARE-AND-SET is only measuring the CAS if the two
callers' pre-reads are proved to overlap. `Promise.all` does not prove that; a held transaction
does.* T4's slot race needed none of this because its contention is at an INDEX with no pre-read in
front of it — which is exactly why the two tests look similar and are not.

**F22 — THE SHARED FIXTURE ACTIVATED ONE WORKFLOW DEFINITION AND THE GATES NEED TWO.**

`setupRadiologyFixture` performed the Class-A governance sequence for `imaging_study` only.
`openStudyGate` starts an `imaging_gate` instance per opened gate and `startInstance` refuses
`no_active_definition`, so every check-in failed for a reason that had nothing to do with what was
being asserted. Fixed by looping `RADIOLOGY_WORKFLOW_DEFINITIONS`, which is the constant T2 shipped
for exactly this — *"both definitions, for the seed and the runbook to install from one list"*.

The cost is one extra governance dance per fixture build, paid by four suites this task does not
own. Measured after the change, over the whole radiology tree: **14 suites / 217 tests / 158 s.**

**F23 — THREE FILES T5 MUST TOUCH ARE IN NO TASK'S FILES LIST, AND ONE OF THEM IS A SHARED FIXTURE.**
*(the §2.138 pattern, and this phase's fourth specimen after F11 and F14)*

`index.ts`, `radiology.module.ts` and `test/helpers/radiology.ts`. The first two are authorised **by
the files themselves rather than by the plan** — `index.ts`'s header says *"T3 adds the placement
function…, **T5 the gates**"*, and `radiology.module.ts`'s says *"WHAT IS NOT MOUNTED YET: T5's
study console…"* — which is a better place for that authorisation to live than a Files list, because
it is in front of whoever opens the file.

**The third is named nowhere, and it is the one a reviewer should look at**: a change to a shared
fixture reaches four suites this task does not own, and F22 is that change. It is disclosed here
rather than left for the reviewer to find in the diff.

**F24 — NOTHING EVER WRITES `rescheduled`. THE STATE, BOTH ITS TRANSITIONS AND ITS LEG OF THE SLOT
INDEX ARE ALL DEAD, AND THREE FILES STATE A DESIGN THE FOURTH DOES NOT IMPLEMENT.** *(found by T5
while reading the study machine for check-in; OWNED BY T4's file, not fixed here)*

Three places say what a reschedule is, in as many words:

  · `radiology.ts` (T1): *"`rescheduled` is TERMINAL for the row it sits on: a reschedule writes a
    NEW study row and closes this one, so the audit answer to 'when was this moved, and off what
    slot' is two rows rather than one row with a rewritten `scheduled_at`."*
  · `workflow-def.ts` (T2): *"A reschedule CLOSES this row and opens a new one (DD5): two rows
    answer 'when was this moved, and off what slot', where one rewritten `scheduled_at` answers
    neither."* Two transitions are declared for it.
  · DD5 itself.

**`rescheduleStudy` (T4) does the rewritten `scheduled_at`.** It UPDATEs `device_resource_id` and
`scheduled_at` in place, transitions nothing, and its own header argues the opposite case — *"The
study KEEPS its identity and its accession — a reschedule is the same scan on a different machine or
at a different time, not a new one."*

**Measured, not inferred:** `grep -rn '"rescheduled"' src/modules/radiology/*.ts` outside tests
returns the enum member, the two transitions and nothing else. **No code path writes the status and
no code path takes either transition.** So a terminal state, two declared transitions and one of the
three names in `imaging_studies_slot_ux`'s predicate are all unreachable — and
`schedule.concurrency.test.ts`'s A1 proves the index frees on `cancelled` and `no_show` by writing
those statuses, which is why the dead third leg has never been visible.

**What it costs is the audit answer DD5 asked for.** The old slot is silently overwritten, so
*"this scan was booked for the 09:00 CT on Monday and moved"* is not answerable from the data — only
the current booking survives. That is a real loss for a machine's diary and for a patient asking why
their appointment changed, and it is the difference the T1 and T2 comments were both written to buy.

**Reported rather than taken**: `schedule.ts` is T4's file and T5's Files list does not name it.
**The close review owns the ruling** — either `rescheduleStudy` closes the row and opens a new one as
three documents say, or `rescheduled` comes out of the state machine, out of the status list and out
of the slot predicate, and both comments are corrected. What must not stand is a terminal state that
the design depends on and nothing can reach.

### DECISIONS T5 TOOK THAT THE PLAN LEAVES OPEN

**1. `pregnancy_policy` HAS A CODE DEFAULT, AND IT IS THE STRICT END OF EVERY FIELD.**

The kind has a published zod schema (T4) and **no seed** — `seed-radiology.ts` seeds `study_types`
alone, and it is T4's file. A `checkIn` that threw `definition_not_active` until somebody published
a policy would make the department un-check-in-able at go-live, and unlike the study-type book there
is nothing for a runbook step to publish.

So the policy is a governed **override of a default** rather than a precondition, and the default
(`DEFAULT_PREGNANCY_POLICY`) is the strict end of every field it has: the widest age band (10–60),
so no woman of childbearing age falls outside the screen, and
`declaration_sufficient_for_ionising: false`, so a verbal "no" alone does not carry a CT. **A
hospital that publishes nothing gets the safest behaviour and not the laxest** — the same asymmetry
`applicability.ts` argues for a null date of birth. `checkIn`'s result carries
`policySource: 'default' | 'published'` so a screen and an audit row can say which decided.

**Owed to the runbook or to T9: a `pregnancy_policy` seed.** Until one is published every hospital
runs the default, which is correct but is not a decision anybody has taken.

**2. `contrast_option: 'optional'` OPENS NONE OF THE THREE CONTRAST GATES AT CHECK-IN.**

Whether contrast is given is decided at the CONSOLE, and a consent gate opened at check-in for a
scan that turns out to need no contrast is a gate the floor learns to click past — which is A1's own
stated failure mode arriving by a different door. **`openStudyGate` is exported for T7** so the
three can be opened at the moment the decision is actually taken, and **T7's `recordAcquired` is
where `contrast_given: true` on a study with no terminal `contrast_consent` must be refused.**
Recorded here because T7 inherits the obligation, the way F13 handed one to T4.

**3. `waivable` IS A CODE CONSTANT, BECAUSE THE STUDY-TYPE BODY CARRIES NO WAIVABLE LIST.**

`ot_case_gates.waivable` snapshots from the criteria definition's `waivableGates`. `studyTypeSchema`
has no such field — measured, not assumed — so `gates.ts` owns `WAIVABLE_KINDS`. That is the better
place for it anyway: a statutory kind whose waivability lived in a governed body would be one UPDATE
from being false, which is the shape `radiology.ts`'s own table header rejects in as many words.

**The refusal is therefore two layers.** `NEVER_WAIVABLE_KINDS` (`form_f`, `identity_two_factor`) is
checked BY KIND before the row's own column is read, so a row hand-edited to `waivable = true`
widens the clinical kinds and cannot touch the two statutory ones. `gates.test.ts` proves exactly
that by flipping the column and watching the refusal stand.

**4. `form_f` IS SATISFIED BY THE REGISTER AND TAKES NO EVIDENCE FROM THE CALLER AT ALL.**

`pcpndt_form_f_study_ux` makes one form per study a database fact, so the gate asks whether one
exists. There is nothing for a caller to type and therefore nothing to type wrongly. **This gate is
not the statutory control** — that is T6's `assertFormFRecorded`, on T7's acquisition path, which
demands a **recorded** form and not merely an open one. Two controls at two strengths: the gate
keeps the study out of `ready` until the form is started; the register refuses the exposure without
a completed one.

**5. `identity_two_factor` IS OVERRIDABLE AND NOT WAIVABLE, AND THE TWO ARE DIFFERENT ACTS.**

A6 says identity *"cannot be `waived`"* and is silent on the override. A waiver says *"this gate does
not apply to this patient"*, which is never true of identity. An override says *"it applies, I am
accepting the risk, and here is why"* — which is exactly the unconscious trauma patient with no
papers, and it leaves a reason and an event where a waiver would leave a shrug.

### 9.4 The Assertion Book, corrected by execution

**T1 is ROUTINE, so no mutants are owed** (AGENT-RULES §3) and none were built; the report says so
rather than manufacturing one. What T1 owed instead was that **every CHECK is refused by Postgres
and the refusal READ** (the 07c pattern), that **both triggers refuse UPDATE and DELETE**, that the
**partial slot unique refuses a second live study and ACCEPTS after a cancel**, and that
**`truncateAll` empties all eleven tables.** All four were executed. Three corrections the execution
forced:

| # | as authored | as executed, and why |
|---|---|---|
| 1 | *"the two triggers"* freeze a named column list | **They freeze WHOLE ROWS minus a named pair** — `(to_jsonb(NEW) - 'status' - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - …)`. `0045` exists *because* `0044`'s enumerated freeze list was incomplete (`authority` and `external_referrer_id` were left mutable and turned a clinician order into a referral fee). Inverting it means the plan's own mutants — *"the trigger omits `body`"* (T8 A5), *"omits `sections`"* (T6 A4) — **cannot be written by omission**, and a column a LATER migration adds is frozen by default rather than silently mutable. |
| 2 | M4's dose CHECK: *"one dose field NOT NULL **or** `dose_manual` is set"* | **`dose_manual` is a PROVENANCE flag and does not excuse the number.** A machine with no dose SR is precisely the case M4 exists for — the technologist reads the console and types it — so `dose_manual = true` with every number null is the defect the CHECK is named after, not the exemption from it. The strict reading is shipped and both halves are asserted. |
| 3 | §4.1: `imaging_definitions`, `pcpndt_registrations`, `pcpndt_form_f_serials` *"take their own"* truncate statement | **Constraint EXISTENCE decides, not the authoring sketch** (§3.35/§3.12). `pcpndt_form_f_serials.machine_id` is an FK into the machine list, so it rides the register's statement; `imaging_studies` is named in **three** statements (patients/orders/resources/invoice_lines, services, and its own children follow it everywhere). Only `imaging_definitions` genuinely takes its own. Proved by inserting one row in each of the eleven, truncating, and counting zero — the author prompt's rule made executable, which is the only form of it that cannot go stale. |

Two assertions were added that the book did not ask for, both bought by F2: **a no-op UPDATE is
permitted** (the trigger freezes change, not statements) and **an acquired ionising study is refused
even with `dose_manual` set**.

### 9.5 Mechanical verification — with the `TEST_DATABASE_URL` database named beside every count (§2.137)

**T2 — RESUMED AND COMPLETED 2026-08-30. Every count below was taken with
`TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch"`**, the same lane
database T1 used (`setupTestDb` appends `_<JEST_WORKER_ID>`).

**The resume checklist was executed in its own order, and step 1 changed the task.** All twenty §2
rows were re-measured before any code was written; **eleven had moved** since the pause, all by Lane
A's lab work: migrations 46 → **48** (`0047_radiology_core` is this lane's own, so the next free
number is `0048`), claimed order kinds `[]` → **`["lab"]`**, manifests 17 → **18**, `allPermissions`
111 → **126**, worker manifest keys 12 → **13**, `PhiSurface` 8 → **11**, controllers on the order
seam 0 → **3**, scheduler jobs 13 → **15**, ledger §5 line 1485 → **1708**, and
`recordPhiAccess` in `kernel/orders/read.ts` **0 → 5**. That last one settles spike S8 for the third
time and in the direction the handoff predicted: **the call EXISTS, landed by Lane A in `39beff0` —
REUSE it, write no second call.**

**T1 was re-proved before anything was built on it** (checklist step 5 — a green is a claim about a
tree that has since changed): `radiology.test.ts`, `pcpndt.test.ts`, `series.test.ts`,
`parity.test.ts` → **4 suites, 61 tests, exit 0**.

**T2's tests were written BEFORE the install work** (checklist step 4), and that ordering is what
found **F9**. The fail-first run of the three new files came back **exit 1, 2 failed / 31 passed**:
one was the F9 defect (`open → satisfied` naming `radiology_receptionist`) and one was this
session's own test reaching for the kernel's resource kinds through the manifest collector, which
does not carry them. After the fix: **3 suites, 33 tests, exit 0.**

| run | result |
|---|---|
| the three new T2 suites, fail-first | **exit 1 — 2 failed / 31 passed** (F9, plus one defect in the test itself) |
| the three new T2 suites, after the F9 fix | **3 suites / 33 tests, exit 0** |
| the census suites the install moves (manifests, notify, orders, resources, radiology) | **8 suites / 84 tests, exit 0** |
| `test/seed-roles.test.ts` | **16 suites-worth of assertions, 16 tests, exit 0** |
| the broad affected set (worker, modules, orders, resources, notify, nav-parity, roles-catalog, me, resources e2e) | **28 suites / 309 tests, exit 0** |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **0 errors** (2 pre-existing warnings). It caught a REAL rule: `events.test.ts` imported `../pcpndt/events` by file, and spec §4 admits only a module's `index.ts` — the very rule that keeps `pcpndt` installable by 15b without radiology |

**THE FULL WORKSPACE VERIFY — RUN, RED, AND DIAGNOSED RATHER THAN RE-RUN UNTIL GREEN.**
`exit 1`, read from `/opt/hmis/.verify.exit`: **`Test Suites: 26 failed, 290 passed, 316 total ·
Tests: 30 failed, 3028 passed, 3058 total`**, with `apps/web` **61 files / 374 tests passed** and
typecheck and lint both clean.

**One of the twenty-six was real, and it is F11's fourth file.** `test/seed-staff.test.ts` pins
`KNOWN_ROLE_KEYS` at thirty-one; the four new roles make it thirty-five. Neither §2.138 grep could
have found it — that file derives its census from `ROLE_MODEL` and never names `ALL_MANIFESTS`.
**The full verify was the only instrument that found it**, which is the argument for running one at
a task boundary rather than trusting a targeted batch.

**The other twenty-five were host contention, and the evidence is not an impression.** The run
executed at **load average 17 → 31 with eighteen `claude` processes alive on this box**; the
contention census reads **46 × `Exceeded timeout of 15000 ms`, 10 × `SIGKILL`ed jest workers, 4 ×
duplicate key** — and suite times of 87–98 s against a normal 5–70 s. It is ledger §2.137's
signature and 17b's run-2 shape exactly.

**All twenty-six re-ran ISOLATED at `-w 2`, on the fixed tree, once the box was idle: `26 suites,
201 tests passed, exit 0`, at load average 2.47.** The re-run was queued behind an
`until load < 6` guard rather than launched immediately, because re-running under the same
contention would have measured the contention again (rule 20, pointed at my own instrument).

**T3 — PLACEMENT, THE CONSUMER AND THE FIRST MOUNTED CONTROLLER. Same lane database.**

**Fail-first is recorded rather than manufactured.** T3's assertions were written against code that
did not exist, so every one of them failed by construction; what IS worth recording is the two
places the first draft was wrong in a way the tests caught:

- `place.test.ts` pointed all three A3 patients at one visit and `placeOrder` refused
  `patient_encounter_mismatch` — the KERNEL doing exactly its job, and a fixture fault rather than
  a code fault.
- A5's census grep matched its OWN prose (`place.ts`'s docstring and the assertion's own line). A
  census that cannot survive being written about is not a census; it is now word-bounded and
  excludes test files and comments.

| run | result |
|---|---|
| `applicability.test.ts` (A3, every boundary walked) | **11 tests, exit 0** |
| `place.test.ts` (A1, A2, A3, A4, A5) | **16 tests, exit 0** |
| `consumers.test.ts` (A7) | **6 tests, exit 0** |
| the broad affected set — radiology, kernel modules/worker/orders/phi, worker-runtime, nav-parity, seed-roles, seed-staff | **23 suites / 240 tests, exit 0** |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **0 errors** (the 2 pre-existing warnings) |

**A6 IS NOT RE-PROVED HERE, AND THAT IS THE CORRECT ANSWER.** A6 asserts that
`listOrdersForPatient` writes one `phi_access_log` row with `surface='orders.patient'`. **Lane A
already wrote that call and already asserts it** — `kernel/orders/read.test.ts` pins the surface, the
sealed-patient leg and the encounter leg at lines 119, 130 and 142. §2 row 8 measured the call count
at **5**, not 0, so T3's Files list condition *"only if row 8 is still 0"* is not met. This task
appends the four `imaging.*`/`pcpndt.form_f` names to `PhiSurface` and writes **no second call** —
which is spike S8's answer taken at face value instead of duplicating a kernel edit.

**A SECOND FULL VERIFY, RUN AFTER THE `seed-staff` FIX ON A QUIETER BOX: `exit 1`, and it is ONE
TEST.** `Test Suites: 1 failed, 315 passed, 316 total · Tests: 1 failed, 3085 passed, 3086 total`,
with `apps/web` green and typecheck and lint clean. Twenty-six failures became one, which is the
measurement that separates the census miss from the contention: the real defect was fixed and did
not come back, and the twenty-five load artifacts did not recur at load ~9 where they had at 17–31.

**The one is `test/perf-search.test.ts` — a PERFORMANCE test, and it failed on the leg that exists
to stop the budget being met vacuously**: `expect(res.groups.every((g) => !g.timedOut && !g.errored))`.
A federated provider timed out under parallel load. Re-run ISOLATED at `-w 1`: **exit 0, 3 tests,
federated timings 38.0 / 39.0 / 33.8 / 29.8 / 30.4 ms against a 300 ms budget** — an order of
magnitude inside it. It is unrelated to this task by construction: it fans out over patient search
and touches no manifest, permission or role.

**T4 — THE GOVERNED BOOK, THE TWENTY SEEDS, AND THE DIARY. Same lane database.**

| run | result |
|---|---|
| `definitions.test.ts` (A5 + the body invariants + the seeds) | **16 tests, exit 0** |
| `schedule.test.ts` (A2, A3, A4) | **14 tests, exit 0** |
| `schedule.concurrency.test.ts` (A1, five rounds) | **4 tests, exit 0** |
| radiology + kernel resources/orders/modules | **21 suites / 252 tests, exit 0** |
| `pnpm typecheck` / `pnpm lint` | **exit 0 / 0 errors** |

**FULL WORKSPACE VERIFY — GREEN IN ONE RUN, at 19:04 UTC over the T4 tree.** `.verify.exit` = `0`:
typecheck 0, lint 0 errors, `apps/web` **61 files / 374 tests**, `apps/core` **322 suites / 3 153
tests** in 1 056 s against a 1 272 s estimate, **zero `FAIL` lines**, and a contention census of
**zero** across `Exceeded timeout`, `deadlock`, `SIGKILL` and duplicate key.

**It took two attempts, and the first one earned its cost.** Attempt 1 came back exit 1 with 13
failed of 322 — and **one of the thirteen was this task's own** (`schedule.concurrency.test.ts`,
finding F17: a race test that rebuilt its whole fixture five times, blew the 15 s budget under load,
and whose abandoned work then produced a `patients_pkey` collision in the NEXT test). The other
twelve re-ran isolated green. That is §9.9 rule 6 — added by this phase's own token audit two commits
earlier — paying for itself immediately: the targeted batch had run that suite green four times and
only the full verify ever saw it fail.

**THE GAP IS CLOSED — 2026-08-31, `74e3079`, ONE RUN, GREEN, COVERING T2 AND T3 TOGETHER.**

**`cat /opt/hmis/.verify.exit` → `0`**, read as a VALUE from a file (rules 16–18). Launched detached
at 09:27:33 UTC with `TEST_DATABASE_URL` set EXPLICITLY on the launch line, so the database is known
by construction rather than proved after the fact:
`postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch`.

| stage | result |
|---|---|
| `pnpm typecheck` | **exit 0** — proved by the `&&` chain reaching lint |
| `pnpm lint` | **0 errors**, the 2 pre-existing warnings (`advance.test.ts:256`, `scheduler.test.ts:656`) |
| `apps/web` (vitest) | **Test Files 61 passed (61) · Tests 374 passed (374)**, 36.48 s |
| `apps/core` (jest) | **Test Suites: 319 passed, 319 total · Tests: 3119 passed, 3119 total**, 1 043.3 s against a 1 412 s estimate |
| the whole log | **zero `FAIL` lines**; contention census `Exceeded timeout` 0, `deadlock` 0, `SIGKILL` 0, `duplicate key` 0 |

**319 suites and 3 119 tests** — 316/3 058 at T2 plus this task's three new files and their 61
tests. **One run covers both tasks**, because both are in the tree this ran against.

**IT TOOK THREE ATTEMPTS AND THE TWO RED ONES ARE RECORDED AS RED.**

- **Attempt 1 (T2 boundary)**: exit 1, 26 failed / 290 passed. ONE was real — `seed-staff.test.ts`,
  F11's fourth census file — and it was fixed. The other 25 were contention.
- **Attempt 2 (T3 boundary, 08:35 UTC)**: exit 1, **23 failed / 296 passed of 319; 101 tests of
  3 112**. The box was quiet at launch (load 1.17) and **spiked to 105.88 within thirteen minutes**;
  the census read **204 × `Exceeded timeout`, 4 × `SIGKILL`, 4 × duplicate key**. The load was
  measured to be mostly this run's own eight jest workers plus postgres `TRUNCATE` queuing, with one
  external `claude` process at 98% CPU — checked with `ps --sort=-pcpu` rather than assumed, and
  checked for a competing `pnpm verify` (there was none).
  **All 23 re-ran ISOLATED at `-w 2` once the box was idle: 23 suites / 215 tests, exit 0, at load
  2.81.** No radiology suite was among the 23; two files this task TOUCHED were
  (`seed-cursors.test.ts`, `orders/read.test.ts`), which is why the isolated re-run was necessary
  rather than a formality.
- **Attempt 3 (09:27 UTC, relaunched into the quiet window the isolated re-run had just proved)**:
  the green above.

**What that sequence establishes, and it is worth more than the green line itself.** The failures in
attempts 1 and 2 were 26 and 23 suites; the intersection with anything this phase wrote is EMPTY,
and every one of the 49 passed isolated. The variable that moved between red and green was the box,
not the tree — and the tree that went green is byte-identical to the tree that went red in attempt 2
(`74e3079`, no working-tree changes between the two runs). That is as close to a controlled
comparison as this host allows.


**THE DATABASE: `hmis_lane_b_scratch_1`**, created by `setupTestDb` from
`TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch"` with
`JEST_WORKER_ID=1` (`--runInBand`). Migration `0047_radiology_core` **is applied there and nowhere
else**; it has been applied to no other database on this host and to nothing in production
(AGENT-RULES §6's reporting obligation, discharged here).

**It is deliberately NOT dropped**, which is rule 7's *"say so rather than leaving it silently"*
branch rather than a lapse — the 17a precedent (`hmis_17a_scratch`, held for the same reason). A
paused phase whose evidence database has been destroyed is exactly §2.137's specimen: the successor
would have `exit 0` and nothing to inspect.

| check | result |
|---|---|
| `pnpm typecheck` (whole workspace, over Lane A's landed tree) | **exit 0**, re-run 2026-08-30 after `8ea802a` |
| T1's four suites, detached, exit value READ FROM A FILE (`.lane-b-t1.exit`) | **exit 0 — 4 suites, 61 tests, 61 passed**, on `hmis_lane_b_scratch_1` |
| `radiology.test.ts` | PASS — every CHECK refused and read; the report trigger refuses UPDATE of `body`/`impression`/`signer_id`/`laterality`/`version` and refuses DELETE; the slot unique refuses a second live study and RELEASES on each of `cancelled`/`rescheduled`/`no_show` |
| `pcpndt.test.ts` | PASS — the Form F trigger refuses nine columns and DELETE; the gap-free serial refuses a duplicate per machine-year; **`truncateAll` empties all eleven tables** (one row inserted in each first, so "empty afterwards" means something) |
| `series.test.ts`, `parity.test.ts` | PASS — both `EPISODE_SERIES` censuses moved to nine keys |
| migration number, re-measured immediately BEFORE and AFTER `db:generate` (protocol §7) | before: 47 entries, last `0046_lab_core` (Lane A's). after: 48, last `0047_bent_mandrill` → renamed `0047_radiology_core`, journal retagged, snapshot renamed. **`0047` was free and still is.** |
| generated SQL read rather than predicted (rule 21's discipline) | 11 `CREATE TABLE`, 12 indexes, 10 unique indexes, **no `lab_*` object** — the three `lab_`/`ot_` grep hits are false positives inside `not_given`, `not_pregnant` and `not in` |
| preflight `pnpm typecheck && pnpm lint` before the T1 commit (v3 §9.9 rule 6) | **exit 0**, 2 warnings, both in files this phase does not touch |
| T1's four suites re-run against Lane A's tree at `57b93fa`, immediately before committing (rule 12) | **exit 0 — 61/61 on `hmis_lane_b_scratch_1`** |
| `pnpm verify` (full workspace) | **NOT RUN, and deliberately.** Lane A held ~20 files dirty and a full verify of its own in flight for the whole of this session's window; a run over that tree is unattributable to either lane (§2.137, and the 2026-08-29 lane-collision note). CI by full SHA is the honest instrument and there is no SHA to watch, because nothing was committed. |
| CI | **GREEN, by full SHA.** Run `33308463171` on `a57e7e4` — `completed | success`, the tree carrying T1, T2's surface and this document. The earlier `2466b46` verdict was never obtained (F7); this one was, with one watcher at a 70-second interval. **And it refutes F8 below.** |

### 9.5-T5 — T5's mechanical verification (2026-08-31)

**Every count below was taken with
`TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch"`** (§2.137;
`setupTestDb` appends `_<JEST_WORKER_ID>`). The RC-1 lane was live in this checkout throughout and
held `modules/opd/*` and `modules/billing/*` dirty — see the note on the instrument below.

**Fail-first was NOT taken in the ordinary form, and this is the disclosure.** T5's tests were
written after its code, not before, so there is no red-then-green pair for the suites themselves.
**The discriminating evidence is the mutant table**, which is the stronger instrument and is the one
AGENT-RULES §3 actually asks a CRITICAL task for. Recorded against this session's interest, the way
T2–T4's missing mutant files were.

#### The mutants — every one the Assertion Book names, and all six DIED

Each is a byte-copy of the shipped module beside it with ONE defect, run against a self-contained
scratch spec carrying the shipped test's own assertion. All scratch was deleted before the commit.

| # | mutant | the defect | verdict | expected vs received |
|---|---|---|---|---|
| A1 | `mut-a1.ts` (`checkin.ts`) | the sex check is dropped from `deriveGateSet` | **DIED** | expected `["identity_two_factor"]`, received `["identity_two_factor", "pregnancy_screen"]` — every male gets a pregnancy declaration |
| A2 | `mut-a2.ts` (`gates.ts`) | `waiveGate`/`overrideGate` consult the active definition BEFORE refusing `form_f` by kind | **DIED** (both legs) | expected `code: "gate_not_overridable"`, received `code: "definition_not_active"` — the refusal now depends on a table the assertion has emptied |
| A3 | `mut-a3.ts` | the reason check is gone from `overrideGate` | **DIED** | expected a rejection with `code: "reason_required"`, received a RESOLVED `{kind: "identity_two_factor", state: "overridden"}` — P1's "benefit>risk" is a click |
| A4 | `mut-a4.ts` | the OPD window is used whatever the context and whatever the CKD flag | **DIED** | expected `"evidence_stale"`, received `undefined` — the call SUCCEEDED, so a 20-day-old creatinine passes gadolinium on a CKD patient |
| A5 | `mut-a5.ts` | `prior_contrast_reaction` reads a prescription-shaped source instead of the patient master | **DIED** | expected `"gate_open"`, received `undefined` — the gate satisfied, so a registration-recorded contrast allergy is invisible |
| A6 | `mut-a6.ts` | `evaluateReadiness` counts `satisfied` only | **DIED** | expected `{state: "ready", open: []}`, received `{state: "checked_in", open: ["contrast_consent"]}` — an overridden gate holds the study for ever |

**A7 has no mutant and the plan says so**: *"no mutant of ours — the assertion pins that the gate
rides `transition`'s CAS rather than a read-then-write."* **F21 is what happened when that assertion
was first written**, and it is the finding this row produced instead of a mutant: the first draft
raced two plain transactions, got one winner and one loser, and the loser's code was
`gate_already_terminal` — the two had serialised and the CAS was never reached. The test now HOLDS
each transaction open past the other's pre-read, which is the only construction that measures what
A7 is about.

#### The suites

| run | result |
|---|---|
| the three new T5 suites | **3 suites / 76 tests, exit 0** (checkin 39.3 s, gates 90.6 s, concurrency 13.2 s) |
| every radiology suite, so the shared-fixture change (F22) is proved against the four suites it reaches | **12 suites / 176 tests, exit 0** |
| the census and parity suites a new controller could move — manifests, nav-parity, seed-roles, seed-staff, roles-catalog, me, radiology + pcpndt schema, worker-runtime, seed-cursors, orders parity, resources kinds | **12 suites / 126 tests, exit 0. Nothing moved** — all three permissions this task guards on were declared at T2, so no census had a number to change |
| `pnpm typecheck` (whole `apps/core`) | **exit 0**, taken at 20:22 UTC over the tree as it then stood |
| `pnpm lint` over `modules/radiology` and the shared fixture | **exit 0, no errors** |
| **the full workspace verify** | **RUN AND RED, AND THE RED IS NOT THIS LANE'S.** `pnpm verify` failed at `tsc --noEmit` with three errors, all in `src/modules/patients/search.ts` — a file the RC-1 lane was editing in this shared checkout at that minute, and one this task does not touch. **No count from it is attributable to either lane** (§2.137, and the 2026-08-29 lane-collision note). This is the same call T1 made for the same reason, and the honest instrument is CI BY FULL SHA — see below |

**No single test in the three new suites exceeds 3.3 s** (`--verbose`, on a box at load ~5). F17's
class is checked for rather than hoped about: the slowest is A7's five-round race at 3 247 ms, 22% of
the 15 s default budget, and the next is 2 621 ms. The suites are slow in TOTAL (`gates.test.ts` is
90 s over 45 database-backed cases) because each rebuilds the fixture in `beforeEach`, which is the
cost F22 doubled; that is a suite-duration cost and not a per-test budget risk.

**One consequence of measuring rather than assuming**: seven `isContrastAllergen` cases were sitting
inside the database `describe` and paying a full fixture rebuild each — eleven seconds to assert
seven string comparisons. They were moved to a pure top-level `describe` (and widened to ten cases)
once `--verbose` showed what they cost. §2.144's shape in miniature.

#### CI on `835ca2a` — RED, AND THE INSTRUMENT IS WHAT BROKE (ledger §2.151)

**Run `33436302396`: `completed | failure`, 117 minutes against its parent's 57.** Typecheck and
lint PASSED in CI. The test phase failed as follows, read rather than re-run (§9.9 rule 7):

| measurement | value |
|---|---|
| FAIL suites | **126** — essentially the whole workspace |
| `●` failure blocks | **1016** |
| `Exceeded timeout of 15000 ms for a HOOK` | **846** |
| `Exceeded timeout … for a test` | 2 |
| blocks naming `setupTestDb()` in the frame | 358 |
| **assertion diffs (an expectation disagreeing with the code)** | **ZERO** |

The 166 non-timeout blocks are all CASCADES of the timeouts, and each names a table the test is not
about: `teardown is not a function` (the `beforeAll` threw, so `teardown` was never assigned),
`pg_type_typname_nsp_index` (two workers running `CREATE TYPE` against ONE database),
`users_username_ux` and `opd_config_pkey` (abandoned async work from a timed-out hook racing the
next suite's setup). **That is F17's cascade shape at workspace scale.**

**THE ROOT CAUSE IS THE TEST HARNESS'S OWN CONFIGURATION, and it was diagnosed independently by the
VD-1 and RC-1 lanes the same night** — ledger **§2.151** (`91a77f4`). Two mechanisms, both verified
from this lane before being believed:

1. **`apps/core/jest.config.cjs` sets NO `maxWorkers`.** Jest therefore defaults to cores−1 — seven
   workers on the 8-core build host, each ~1.2 GB. `dmesg -T` carries node OOM kills at 23:01,
   23:04 and 23:10 with `anon-rss` 1.1–1.4 GB apiece.
2. **`pnpm test` is `pnpm -r test` with no `workspace-concurrency`,** so core's jest pool and web's
   vitest pool run AT THE SAME TIME.

**Both mechanisms exist in CI as well as on the build host**, which is the part §2.151 had not yet
said: on a marginal runner the two pools starve each other instead of being OOM-killed, and a
starved pool shows up as *every* `setupTestDb` exceeding a 15-second hook budget. **The signature is
the same defect wearing a slowdown costume rather than a kill.**

**What this does and does not license.** It does NOT license "the red is not mine": the parent was
green at 57 minutes and this task added three suites and made the shared radiology fixture perform
TWO Class-A governance sequences instead of one (F22), so T5 plausibly pushed a marginal
configuration over a threshold. **T5 is a candidate proximate trigger; the unbounded worker
configuration is the root cause.** What it does license is refusing to read 846 hook timeouts as
846 defects: no assertion in this workspace disagreed with any code in this run.

**Not fixed here, and deliberately.** `jest.config.cjs` is in no task's Files list, and §2.151's own
amendment rules that **the worker cap is an OWNER RULING** rather than a thing one lane caps on the
shared instrument. Routed, not taken.

**The attributable local run is still OWED.** A `pnpm verify` on this box would take it down and
hand back the same false red (measured: the box sat at load 34 with six ~1 GB workers and 0 GB
available while this was written). The safe form §2.151 gives is sequential and capped —
`pnpm --filter @hmis/core exec jest -w 2`, then `pnpm --filter @hmis/web exec vitest run` — and it
needs a coordinated slot with the RC-1 and VD-1 lanes. **Every number in the table above this one
was already taken in that safe form** (`npx jest <paths> -w 2`), which is why T5's own evidence
stands while the workspace-wide claim does not.

### 9.6 The independent close review — FRESH

**NOT RUN. The phase is paused at T1 of nine and there is nothing to close.** Both reviewer passes
(§9.6 and §9.6.2) remain owed in full, and the stop-loss's review term — 463,509 of the 736,000 — is
entirely unspent.

---

### 9.6.2 The SECOND close review — over the remediation diff only, FRESH

**NOT RUN** — it reviews a remediation that does not exist yet.

### 9.7 Actuals, recorded only after §9.6 exists (v3 §9.4)

**NOT RECORDED, and that is the rule rather than an omission** (v3 §9.4: a LIGHT phase's saving is
not a saving until its reviewer has run). What can be said: the phase is paused at **T1 of nine**,
no reviewer has run, and the review term — **463,509 of the 736,000 stop-loss** — is entirely
unspent. A resumed session should price itself from a fresh baseline, not from this one, because
**a paused lane's largest cost was not its code**: it was reading a shared tree that changed under it
and re-measuring facts that had already moved.

### 9.8 The question this phase existed to answer

**Still open.** The question was *what shape the first radiology slice takes on an envelope that
already exists and a statutory table that does not.* T1 answers the second half in the only way that
counts — **the statutory table now exists, with a gap-free serial series per machine per year, a
whole-row immutability trigger, and a Form F that no role, flag or hour of the night can reach
around** — and the first half is untouched: no manifest claims `imaging`, so the envelope still has
zero consumers and `parity.test.ts` still reads `['lab']` rather than `['imaging','lab']`.

---

## 9.9 HANDOFF — Lane B paused by owner ruling, 2026-08-30 (v3 §9.6)

**THE RULING, AND ITS AMENDMENT.** Lane A (Plan 17 → 17a/17b) executed in `/opt/hmis` at the same
time as this session and, for the whole of the first window, held the checkout's shared files
uncommitted. The owner was given four options and chose **"pause Lane B entirely"** — stop, write the
handoff, resume once Plan 17 is closed. **On 2026-08-30 the owner amended it: land the work rather
than lose it.** This section is the note as amended.

### What is true about the code

**T1 IS COMMITTED, PUSHED AND GREEN** (`d5abf6a`), and the evidence is a run with its exit value read
from a file rather than a description: preflight `pnpm typecheck && pnpm lint` **exit 0**, then four
suites detached — **exit 0, 4 suites, 61/61, on `hmis_lane_b_scratch_1`**, against Lane A's tree at
`57b93fa`.

**T2's DECLARED SURFACE IS COMMITTED AND IS NOT PROVED** (`997ab18`). Eleven files that typecheck and
lint and have **no test of their own**. §9.6's corollary applies to them exactly: *uncompiled, unrun
code is unknown code, however well described* — these compile, but nothing asserts their behaviour.
**Treat them as WRITTEN.**

**BOTH ARE INERT, which is what made landing them safe rather than premature.** Neither manifest is
in `ALL_MANIFESTS`; nothing imports either module's `index.ts`; `collectOrderKinds` and
`collectResourceKinds` read the REGISTRY, not the directory. So `imaging` is still an unclaimed order
kind, `device` is still an unclaimed resource kind, the permission/manifest/role censuses have not
moved, and eleven tables exist with no writer — which is `0044`/`0045`'s own posture (claimed kinds
`[]`) one phase on. **The next production deploy will create eleven empty radiology tables.** That is
expected and stated here so nobody discovers it in a deploy log.

### What is NOT done — the honest boundary

- **T2's censuses.** Installing the two manifests (17 → 19), the twenty permissions (111 → 131), the
  four new roles, the README parity table, the worker install, the notification template. **None of
  it is started.**
- **T3–T9 entirely**: placement + idempotency + the consumer, scheduling, the gates, the PCPNDT
  functions, acquisition, reports, the five screens and the e2e.
- **Both close-review passes** (§9.6, §9.6.2) — the whole 463,509 review term is unspent.
- **No full `pnpm verify` was run by this lane**, deliberately: `kernel/orders/advance.test.ts` is a
  standing red on this host (two timeout rows plus two cascade failures through a non-idempotent
  fixture), it is frozen for both lanes, and a full run over a tree Lane A was also using would be
  unattributable to either. The narrow suites plus preflight are what this lane can honestly claim.

### The database, and the one irreversible thing this session did

`0047_radiology_core` is applied to **`hmis_lane_b_scratch_1` and to nothing else on this host** —
not `hmis_dev`, not `hmis_test_*`, not production (prod is at 46; this session made no production
write, and S6 was a read-only `SELECT`). AGENT-RULES §6 requires that be reported rather than left
implicit. The database is **held, not dropped** (rule 7's "say so" branch, the `hmis_17a_scratch`
precedent): it is the only place the migration can be inspected, and §2.137's specimen is a reviewer
finding the proof already destroyed. **Lane A has been asked in writing to leave it alone.**

### What the next session must do, in this order

1. **Re-run the kickoff pre-flight and re-measure §2 in full.** Every row. Lane A has landed many
   commits since §9.0 was written, `lab` claims an order kind, and **rows 2, 3, 4, 8, 9 and 11 have
   moved.**
2. **The migration number is SETTLED — `0047` is pushed.** Nothing to renumber and nothing to hold.
   T1's tables exist on `main`. The next migration this phase needs (a gate-kind widening, say) takes
   whatever is free THEN, measured before and after `db:generate`.
3. **Re-answer S8, because its answer has already flipped once.** At kickoff Lane B was first on both
   kernel seams. By 18:50 the same day Lane A had `kernel/orders/read.ts` and `kernel/phi/audit.ts`
   open. **If Lane A has landed the `recordPhiAccess` call with surface `orders.patient`, T3 REUSES
   it and appends ONLY `imaging.worklist`, `imaging.study`, `imaging.report`, `pcpndt.form_f` to
   `PhiSurface`** — it does not write a second call (§2.54).
4. **Re-run T1's four suites before building on them** — a green is a claim about a tree that has
   since changed. **And write T2's tests first:** `997ab18`'s eleven files are the only unproved code
   this lane shipped, and the phase document's T2 Files list already names `workflow-def.test.ts`,
   `kinds.test.ts` and `events.test.ts`. Name the database in every commit message.
5. Then T2's censuses — the part that was blocked. **Grep the SIBLING and grep the LIST** (§2.131 /
   §2.138): `grep -rn "otManifest" apps/core --include=*.ts` for the places that NAME one, and
   `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts` for the places that COUNT them. Lane A's own
   close reports that three derived censuses caught what its Files lists missed, and that one of them
   left `main` red for forty minutes.
6. Apply **F3 and F4** before writing T4's seed and T2's roles — they change both.

### What this session learned that the METHOD does not yet carry

**Two lanes in one checkout do not fail on the files the protocol names; they fail on the
ARTEFACTS THAT CANNOT BE SPLIT.** §4 anticipated four shared files and gave a good rule for each —
*"stage only your hunks by path"*. That rule works for a census and a truncate list. **It cannot work
for `drizzle/meta/_journal.json`**, and that single file is what stopped this lane: committing my
`0047` row means either orphaning Lane A's uncommitted `0046` row — which turns `origin/main` red and
breaks the next production deploy — or committing their migration for them. There is no third
option, and no amount of care at the diff level produces one.

The protocol's *"whoever lands second pulls and re-reads"* also assumes **the first lane LANDS**.
Lane A ran T1→T2→T3 behind a single batched verify — which is exactly what v3 §9.9 rule 4 tells it to
do — so for ninety minutes there was nothing to pull and a growing set of files nobody could touch.
**§9.9 rule 4 (batch the verify) and protocol §4 (land second) are in direct tension, and nothing
says so.** That is the finding worth carrying into the ledger, and it is cheap: a lane that shares a
checkout should commit its MIGRATION as soon as it is green, ahead of the batch it belongs to,
because the journal is the one artefact the other lane cannot work around.
