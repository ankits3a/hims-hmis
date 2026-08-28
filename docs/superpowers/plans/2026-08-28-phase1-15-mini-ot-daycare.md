# Plan 15 — Mini-OT day-care spine: the case, its gates, the theatre, the bays, and the bill

**Written 2026-08-28 on the build host, the day Plan 14 closed (code-complete, NOT deployed). NOT APPROVED FOR EXECUTION — this document is the whole of what the authoring session produced; execution is a separate session with its own approval.** Every fork this phase stands on was decided in the brainstorm record under the owner's 2026-08-28 mandate (*"when in confusion choose the most logical choice, the way Indian hospitals work; assume every standard certificate and machine exists"*) and is cited by number below; the two the owner ruled in as many words — **FP empanelment YES** and **deposit default 100 % but flexible** — are marked RULED where they bite.

**Roadmap:** [`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md) § *Stage-2 acceleration* (Track A **14 → 15 → 16 → 17 → 18**; re-sliced 2026-08-27 so that 15 needs only 14). **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §11.16-A (the mini-OT, v4.8 — this phase instantiates it), §11.9 (hard pre-op gates, WHO states, count mismatch = hard stop, the five timestamps), §11.4 map 11 (the day-care cascade), §11.11 (deposit, min(tariff, MRP, ceiling)), §11.19-C-3, §11.19-D-31 (guardianship), §4 (module framework). **Brainstorm:** [`../brainstorms/2026-08-28-plan-15-mini-ot/00-RECORD-AND-PLAN.md`](../brainstorms/2026-08-28-plan-15-mini-ot/00-RECORD-AND-PLAN.md) — **the record's §3 (24 decisions), §3A (deposit policy), §6 (task sketch) and §7 (66-row edge register) are this document's raw material and are NOT restated**; a decision is cited as *R-3.n* and an edge row by its id. The department brainstorm `../brainstorms/2026-08-27-department-series/15-ot-anaesthesia-cssd.md` §3–§5 is the layer beneath that.

**Slot:** Plan 14 closed 2026-08-28 (`1fc8674`), migration head `0034`, **production still at 34 migrations and `commissioning`.** This phase's migration is `0035` and chains on `0034`; **building and reviewing it needs nothing deployed; the first production case needs `0034` + `0035` together** (R-3.7). Nothing else blocks it.

**Executor seed (v3 §1):** read this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 (lines 1132–1184) — then execute, on the build host, task by task. **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94k tokens, re-billed on every tool call (v3 §9.1).** Entries cited where they bite: §2.54, §2.93, §2.99, §2.102 (and Plan 14's seventh coinciding field), §2.115, §2.119–§2.124.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT, nine tasks, and the sentence about the edge is the same one Plan 14 wrote.** It is a module build with a workflow definition, four screens and a money composer — the HEAVY shape by v3 §2's letter — kept LIGHT by the brainstorm's slice (R-3.4): no statutory register, no CSSD, no theatre-time bands, no cancellation charge matrix, no telemetry, no chargeables spine. What makes it not small: **two CRITICAL seams the hospital has never had — a hard gate that must be impossible to walk past, and a bill composed from another module's ledger under a regulated-price clamp.**

**The main session codes task by task** under AGENT-RULES in full, builds every mutant the Assertion Books name, watches CI by full SHA with [`../pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh), and closes with **two independent review passes, both spawned FRESH** (v3 §9.5, §2.115; Plan 14 measured fresh-twice at 458,491 against Plan 13's resumed-twice 604,655 doing less). The owner's 2026-08-28 "no third pass" ruling on Plan 14 was explicitly **not** a precedent for skipping the second; the second pass has paid in 09a, 13 and 14.

### Stop-loss (v3 §6): **730,000 tokens**

`stop-loss = 1.5 × (per-task rate × task count) + review passes at measured rates`
- **Per-task rate 20,178** (Plan 16a, LIGHT, 9 tasks — the same input Plan 14 used; the known bias stands: for a LIGHT phase this number is a review cost in an execution cost's clothes; main-session cost is unmeasurable, runbook **O3**). Task term `1.5 × 20,178 × 9 = 272,403`.
- **Review term — two FRESH passes at Plan 14's measured rates: `244,568 + 213,923 = 458,491`.** Not the 1.3× resume premium: the second pass here is scope ("confirm these properties of the remediation diff"), which §9.5 says to spawn fresh.
- **Total 730,894 → 730,000.** If a resume becomes necessary for memory, it is priced at 1.3× and the executor says so before spawning it.

### Context budget (v3 §9.2), measured at write time — re-measure at kickoff

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | **see the last line of this file** (`wc -c` at write time; re-measure) | — |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only (lines 1132–1184) | ~3,600 | ~900 |
| brainstorm record (read once at kickoff, not carried) | ~34,000 | 8,500 — read, then cite by R-number |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

**Parallel-work fence.** At write time: `main` at `8103543`, working tree clean except the untracked `docs/superpowers/brainstorms/2026-08-27-patient-self-service/` (another session's brainstorm; leave it alone — never `git add -A`, AGENT-RULES §5 step 0). If a jest/vitest process appears during execution it is a second lane: read [`reports/2026-08-26-parallel-session-protocol.md`](reports/2026-08-26-parallel-session-protocol.md) before trusting any test evidence.

---

## 1. Why this phase

**The hospital can register a patient, consult, prescribe, bill, and — since Plan 14 — hold a consignment implant in a store. It cannot operate on anyone.** The owner's 2026-08-25 ruling pulled a one-theatre day-care unit ahead of the whole IPD cluster because it is physically beside the OPD floor, staffed today, and its two departments (gynaecology, orthopaedics) are where the hospital's paid procedures already happen on paper. Spec §11.16-A wrote the unit as *"existing law at one-theatre scale"*; this phase builds the law's spine: a booking that cannot skip its gates, a theatre that cannot be double-entered, counts that cannot be typed as "correct", an implant scan that is a ledger fact in the same transaction, a recovery bay that cannot be double-assigned, and a discharge bill that composes from the ledger under the regulated clamp.

**Why this slice (R-3.4):** doc 15 §14 is ~25 tables, eight workflow definitions and four statutory surfaces under one number — three phases by Plan 14's own precedent. The spine is what one real case walks end-to-end. **15b** (MTP register, `pcpndt` Form-F gate, FP-scheme register, MLC) lands next because gynae day-care in India is MTP-heavy and the unit is half-open without it; **15c** CSSD-lite; **15d** theatre-time bands, the cancellation charge matrix, equipment checks and telemetry. Until 15b, `mtp` and in-unit USG procedure classes are **structurally outside the case-selection whitelist** (DD6) — not stubbed, absent.

**What it consumes that exists:** the registry (`theatre`, `bed` kinds unclaimed until now), the workflow engine (definitions as data, child instances by subject), approvals (SoD requester ≠ approver), billing (advances, invoices, credit notes, refunds, the `regulated` clamp), tariff (`loadPricingContext`), patients (`getPatient` with alias/confidential, guardians, `verifyQrScan`), notifications (`enqueueNotification`), and Plan 14's DD13 pair: `consignmentDeployed` in, `consumptionsFor(encounterId)` out.

---

## 2. Ground truth — measured in this checkout 2026-08-28; **re-measure at kickoff** (AGENT-RULES §6)

- **Migration head `0034_massive_iron_patriot.sql`, 35 `.sql` files.** HEAD `8103543`. This phase generates ONE: **`0035`, additive, no data migration** (DD17). Read the head yourself before writing a number into a commit.
- **No `ot` anything exists.** `grep -rli "daycare\|ot_cases\|theatre" apps/core/src --include=*.ts` returns only `resources.test.ts` (which says *"`theatre` is IN the CHECK and no manifest declares it until Plan 15"*), `opd/masters.ts:51` (OPD refuses to author a theatre) and one comment in `materials/consumption.ts`.
- **There is no kernel encounter table and no encounter enum.** `opd_encounters.type` is `text NOT NULL DEFAULT 'opd'` (`schema/opd.ts:199`); `billing.invoices.encounter_id` is plain text with no FK (`schema/billing.ts:80`, house precedent). The index's R-035 "one enum migration" is moot; **DD2 is the ruling.**
- **Registry:** ten kinds in the CHECK; `theatre`, `bed`, `device` declared by no manifest. `ResourceKindDecl = { kind, statuses, initial, occupied, onRelease, retired }` (`kernel/resources/kinds.ts:59`). `resources` carries `parent_id`, `attributes` jsonb, `status`, `occupant_type`, `occupant_ref`, `since`. **The worker collects kinds** (`worker.module.ts:125`, Plan 14 T2) — a manifest with subscriptions installed in both boots without the duplicate-kind refusal.
- **Workflow engine:** `defineWorkflow(json)`, `startInstance(tx, defKey, subject{type,id,patientId?,encounterId?})`, `transition(tx, instanceId, to, actor, {note})`; `CHANGE_CLASS_POLICY` A = owner + medical_superintendent (emergency: duty_manager + MS), B = department_head + duty_manager, C = none (`kernel/workflow/definitions.ts:90`). OPD's definition (`opd/workflow-def.ts`) is the JSON house shape: `states[{name, sla{minutes, alerting, escalation[]}, terminal?}]`, `transitions[{from,to,roles[]}]`.
- **Approvals:** `registerApprovalType`, `requestApproval`, `approveRequest`/`rejectRequest`, SoD pair `requester_approver` (`kernel/approvals/decisions.ts:14`); seeded per module by `seed-*.js` scripts.
- **Billing:** `recordReceipt` / `allocateReceipt` / `patientBalance` (advance is per PATIENT, `receipts.ts:837`); `issueInvoice(IssueInvoiceInput{draftId, patientId, encounterId?, lines, tags?, receipt?, …})`; `issueCreditNote`; `requestRefund` → voucher; `previewInvoice`. **Whether an invoice line can carry a price CAP from outside the tariff is Spike Q4** — DD11 has both branches.
- **Tariff:** `loadPricingContext(db, {at, tags})`, `priceInvoiceLines(ctx, lines)`, `resolveRegulatedPrices` keyed by SERVICE.
- **Patients:** `getPatient`, `verifyQrScan` (`patients/qr.ts:30`), `effectiveGuardianAuthority` (scope `consents`), `isConfidential` + `alias`. **Episode letters** `V A L S R P` + `GRN` (`kernel/episodes/series.ts:20`); **`D` is free** (DD2).
- **OPD consult:** `advice` is free text; `admissionAdvised`, `referralTo` exist; **there is no structured "procedure advice"** — the booking captures the procedure itself (DD5).
- **Censuses (pins):** manifests **14** (`manifests.test.ts:131,136`); worker keys **11** (`:232`); permissions **89** (`test/seed-roles.test.ts:476,563,586`), held 75 + not-yet-modelled 14; SPA routes **28** (`test/caddyfile-parity.test.ts:307`); deploy seeds: `SEED_STEP_SCRIPTS` in `test/deploy-parity.test.ts:345` lists seven names and **does not list `seed-materials.js` although `deploy.sh` runs it** (observation 2026-08-27, Plan 14 close) — **T2 adds `seed-ot.js` to BOTH and closes that gap in the same edit** (DD15).
- **Notifications:** `enqueueNotification(EnqueueNotificationInput)` + templates (`kernel/notify/enqueue.ts:68`).
- **Web:** `apps/web` router with 28 routes, NAV table hard-coded (Plan 14 F1: a manifest permission change must be mirrored in the SPA NAV table and the nav-parity test — §2.124), locales `en.json` + `hi.json`.

---

### 2A. KICKOFF RE-MEASURE — 2026-08-28, execution session, HEAD `11cccc9`

Everything in §2 above re-measured before T1. **Drift is recorded here rather than edited away, so the
difference between what the authoring session saw and what the executor found stays legible.**

- **Migration head `0034_massive_iron_patriot.sql`, 35 `.sql` files** — unchanged. `0035` is this phase's.
- **`git status --porcelain` is EMPTY.** The LANE's parallel-work fence expected the untracked
  `docs/superpowers/brainstorms/2026-08-27-patient-self-service/`; that directory was COMMITTED at
  `ed8706a` between write time and kickoff. There is nothing untracked to leave alone.
- **No jest/vitest process running** (`ps -eo pid,cmd | grep -iE 'jest|vitest'`, matched lines read, not
  counted — AGENT-RULES rule 20). Single lane.
- **Census pins, measured:**
  | pin | value | file:line — CORRECTED |
  |---|---|---|
  | manifests | **14** | `apps/core/src/kernel/modules/manifests.test.ts:131,136` — §2 said `manifests.test.ts:131,136` without the path; the file is under `src/kernel/modules/`, **not** `apps/core/test/` |
  | worker keys | **11** | `apps/core/src/kernel/modules/manifests.test.ts:232` (same file) |
  | permissions | **89** | `apps/core/test/seed-roles.test.ts:476` |
  | SPA routes | **28** | `apps/core/test/caddyfile-parity.test.ts:307` |
  | `SEED_STEP_SCRIPTS` | **7 names** | `apps/core/test/deploy-parity.test.ts:345` |
- **CORRECTION to §2's last bullet and DD15 — the deploy-seed gap is TWO scripts, not one.**
  `deploy.sh` runs `seed-ops, seed-opd, seed-patients, seed-billing, seed-tariff, seed-membership,
  seed-formulary-interactions, seed-materials, seed-roles`; `SEED_STEP_SCRIPTS` lists only seven and omits
  **`seed-membership.js` as well as `seed-materials.js`**. T2 closes both in the same edit (the file is
  already in its Files list) — a census that names seven of nine is the same defect twice.
- **CORRECTION to T2's Files list — the scripts directory is `apps/core/scripts/`, NOT `apps/core/src/scripts/`.**
  `deploy-parity.test.ts:371` resolves `REPO_ROOT/apps/core/scripts` and asserts every seed named there
  exists as a `.ts`. `seed-ot.ts` therefore goes to **`apps/core/scripts/seed-ot.ts`**; the path in T2 as
  written resolves nowhere and would have failed that assertion (§2.54's own specimen).
- **CORRECTION to DD11's last sentence — the Assertion Book row that discriminates the clamp branch is
  `A24`, not `A19`.** `A19` is T6's concurrent-`admitToBay` row. Cited by number, so the correction is here.

---

## 3. Spike — questions written now, answered at kickoff by read-only SQL against production and by reading the tree

| Q | Question | Why it matters | Answer shape |
|---|---|---|---|
| Q1 | Migration head and `git status` on the host | DD17's number | `0034`, clean → `0035` |
| Q2 | `select kind, count(*) from resources group by 1` on prod | DD3 seeds the theatre and two bays by script; if someone hand-created a theatre, the seed must find, not duplicate | expected: `room 2` only |
| Q3 | Which users hold `medical_superintendent`, `department_head`, `duty_manager`, `owner` on prod (`user_roles` join) | DD6's publish approval and the Class-A activation runbook need TWO HUMANS; prod has one *admin* but 35 users | names + count per role; if `medical_superintendent` = 0, the go-live runbook creates one before T9's gate report |
| Q4 | Does `InvoiceLineInput` / `priceLine` accept a per-line price cap or override? Read `modules/tariff/pricing.ts` and `billing/invoices.ts` | DD11 branch (a) vs (b) | a field name, or "none" |
| Q5 | `select count(*) from workflow_definitions where status='active'` and their keys | DD4 activates two new definitions by the same runbook OPD used | keys list |
| Q6 | `advance_refund` / `requestRefund` path: can a refund reverse to the ORIGINAL tender (UPI/card) or only cash voucher? | §3A cancellation refund "reverse to source" | read `refunds.ts` |
| Q7 | Does `enqueueNotification` have a WhatsApp adapter live on prod or record-only? | DD20's family status pings are honest only if the adapter is on | `adapters.ts` + prod config |

### 3B. SPIKE ANSWERS — run 2026-08-28 at kickoff, read-only

| Q | ANSWER | consequence, written into the DD in place |
|---|---|---|
| **Q1** | Head `0034_massive_iron_patriot.sql`, 35 files; tree clean; prod `drizzle.__drizzle_migrations` count **34**. | This phase generates `0035`. §2A. |
| **Q2** | `select kind, status, count(*) from resources group by 1,2` on prod → **`room / available / 2`, one row, nothing else.** No `theatre`, no `bed`, no `store`. | DD3's `seed-ot.js` creates `OT-1`, `RB-1`, `RB-2` and `OT-CONSIGN` from nothing; the idempotent find-or-create has no pre-existing row to find, and the seed must not assume one. |
| **Q3** | **TWO DISTINCT HUMANS ALREADY EXIST — the go-live runbook creates NOBODY.** `role_assignments` on prod (the table is `role_assignments`, not `user_roles`): `owner` = **1 active** (`admin`, "Administrator"); `medical_superintendent` = **1 active** (`anand.rao`, "Dr. Anand Rao"); `duty_manager` = 2 active (`admin`, `manoj.bhat`); `department_head` **not seeded, 0 holders**; `anaesthetist`, `surgeon`, `billing_counter` **not seeded**. 35 users, 22 active. | **§4A-4 and F6 are discharged, not deferred.** `approveDefinition` refuses a second approval from the same `approverId` (`duplicate_approval`, `definitions.ts:154`), and Class A requires `owner` + `medical_superintendent` — satisfiable today by `admin` + `anand.rao`. `activateDefinition` then needs an activator ≠ drafter (`assertNotSodPair("workflow_drafter_activator")`): drafter `admin` → approvals `admin`(owner) + `anand.rao`(MS) → activator `anand.rao`. **T9's runbook names those two users and creates none.** The approvals engine's `requester_approver` SoD on `ot_definition_publish` is satisfied by the same pair. **`billing_counter` does not exist on prod** — DD14's "`billing_counter` (existing) gains `ot.bill.compose`" is measured against the tree's `ROLE_MODEL`, and T2 reports what it finds rather than assuming the role is deployed. |
| **Q4** | **NONE.** `InvoiceLineInput` is `{ lineId, serviceId, qty, supplyContext?, manualDiscount? }` (`tariff/types.ts:20-24`). `priceLine` takes the unit price from `ctx.tariff.items[serviceId]` and the ONLY other bound is the `svc.regulated` MRP/ceiling pair keyed by SERVICE (`pricing.ts:22-42`). There is no per-line cap or override. | **DD11 branch (b) — and branch (b) as written is UNSAFE. See the DD11 amendment below; the ruling is a per-line cap added to the tariff engine's own `min` chain, not a manual discount.** |
| **Q5** | `select def_key, version, status from workflow_definitions` on prod → **10 active, all v1**: nine `approval_*` flows (`billing_clearance_discount`, `billing_credit_extension`, `billing_discount`, `billing_refund`, `billing_variance`, `membership_grace_honor`, `patient_merge`, `patient_unmerge`, `tariff_revision`) and **`opd_visit`**. | DD4's two definitions (`daycare_case`, `ot_gate`) are the eleventh and twelfth, activated by the same runbook `opd_visit` used. No key collision. |
| **Q6** | **A refund CANNOT reverse to the original tender.** `RefundMethod` is `'cash' \| 'bank_transfer'` (`schema/billing.ts` `refund_vouchers.method`); the path is `requestRefund` → approval → `issueRefundVoucher` → `payRefundVoucher`, and the voucher captures `payeeName / payeeIdType / payeeIdRef` at PAY time (`refunds.ts:120-127`). A voucher above `refundBankAbovePaise` must be `bank_transfer`. | **§3A's "cancellation refund reverses to source" is NOT implementable and this phase does not pretend it is.** What it ships instead: the voucher's payee fields carry §3A's third-party rule (a deposit paid by an employer or relative refunds to the named payee, not to the patient, because the payee is typed at payment and `ot_deposit_holds.paid_by` is what the release copies into the request note). The gate report says the refund is a voucher, not a tender reversal. |
| **Q7** | **No live adapter, AND no way to address one.** `NOTIFY_PROVIDER` is `z.enum(["console"])` (`kernel/config.ts:31`) — the enum has exactly one member, defaulted; `adaptersFor` returns console sinks that log a line (`notify/adapters.ts:34-46`). Worse for DD20: the pump resolves the recipient as **`patients.phone` for a patient-audience template and `users.phone` for a staff one** (`notify/pump.ts:360`), and `EnqueueNotificationInput` has **no recipient field** (`enqueue.ts:25-42`). | **DD20 is DROPPED from this phase — amended below.** Sending a family ping through `enqueueNotification` today would send it to `patients.phone`, which is the one thing DD20 forbids in as many words (F19/J2). The escort's phone is still captured and verified; the notification is not built. |

---

---

## 4. Design decisions — what this plan rules beyond the spec and the record

**DD1 — One module, `ot`, at `apps/core/src/modules/ot/`; tables in `kernel/db/schema/ot.ts`.** The `materials` house shape: `manifest.ts`, `events.ts`, `errors.ts`, `index.ts`, `ot.module.ts`, controllers, logic files with tests beside them. Other modules reach its tables only through `index.ts` (spec §4). It is named `ot`, not `daycare`, because 15b–15d and the major suite (Plan 20-series) extend the same module; the day-care unit is `theatre` ×1 under it, not a module of its own.

**DD2 — `daycare_encounters` is OT-owned, numbered `D`, and is the `encounterId` every downstream fact carries (R-3.1).** Columns: `id`, `encounter_no` (`D2608280001` via `EPISODE_SERIES.daycare = "D"`), `patient_id`, `opd_encounter_id` (nullable, the advising consult), `payer_class` (§3A's eight values, CHECK), `scheme_ref` (pre-auth / TMS / FP claim id, nullable), `status` (`booked | checked_in | in_theatre | in_recovery | discharged | converted | absconded | cancelled | deceased`), `bay_resource_id` (nullable), `escort` jsonb `{name, relation, phone, idType, idLast4, verifiedAt, verifiedBy}`, `checked_in_at`, `discharged_at`, `outcome`, `handoff_document_id` (nullable — conversion), timestamps, `created_by/updated_by`. **`billing.invoices.encounter_id` and `stock_ledger.encounter_id` receive THIS id** — plain text, no FK, the house precedent. One encounter may own several `ot_cases` (N8 bilateral, N13 return to theatre); `consumptionsFor(encounterId)` therefore already spans them. R-035 is discharged by this DD, not by an enum.

**DD3 — ONE kind CLAIMED by the `ot` manifest (`theatre`); the bays are KERNEL `bed` rows; the consignment bin is a materials `store`; all three seeded by script, never by screen. (Adversarial pass F1 — the record said "nobody has claimed `bed`"; `KERNEL_RESOURCE_KINDS` claims `floor, ward, hall, room, bed` at `kernel/resources/kinds.ts:24-30` and a second declaration is `duplicate_kind` at boot.)**
`theatre`: `statuses: ["available","reserved","in_use","turnover","blocked","retired"]`, `initial: "available"`, `occupied: "in_use"`, `onRelease: "turnover"`, `retired: "retired"` — `blocked` is one status with the reason in `attributes.blockReason` (`env | equipment | incident`; death-on-table sets `incident`; 15d splits the status if telemetry needs it). The two bays use the kernel `bed` vocabulary as declared (`available | occupied | cleaning | blocked | retired`, `occupied = "occupied"`, `onRelease = "cleaning"`) with `attributes.class = "daycare_recovery"` (R-3.9 — a code, no tariff link) and `parent_id` = the theatre (containment is legal per Plan 13). `seed-ot.js` creates `OT-1` (theatre), `RB-1`, `RB-2` (beds) **and the consignment bin `OT-CONSIGN` through `materials.createStore` with `parentId` = the theatre (F14 — `0034` created tables, not a single store row; `consignmentDeployed.storeResourceId` is required)** — all idempotent by code. **No `active` boolean anywhere in this module** (Plan 13 DD2; the registry's status IS the state). `device` stays unclaimed until 15c (the autoclave).

**DD4 — Two workflow definitions, both Class A, as JSON constants in `ot/workflow-def.ts`, activated by the OPD runbook (`POST /workflow/definitions`, two approvals, activation by a third user).**
`daycare_case` (subject `{type:"ot_case", id}`): `booked → listed → ready → in_holding → signed_in → timed_out → incision → closing → signed_out → in_recovery → discharge_ready → discharged`; side exits `cancelled` (from any pre-`signed_in` state and from `in_holding`), **`postponed` → back to `booked` with a new list date and `reason` (`no_sterile_set` is a legal reason today even though the set gate is 15c's — F12; `surgeon_no_show`, `payer_denied`, `patient_unfit`)**, `converted` (from `in_recovery`/`discharge_ready`), `absconded` (from `in_recovery`/`discharge_ready`), `deceased` (from `signed_in`…`in_recovery`). **`publishList` refuses a list item whose case has no `anaesthetist_user_id` (F18/F24g); `signIn`'s actor must be that user, or hold `anaesthetist` and emit `anaesthetist.substituted`.** **`ready` is not a transition a human makes — `evaluateReadiness` performs it when every required gate is terminal-satisfied (DD5); `listed → ready` carries `roles: ["system"]`** the way approvals' own flow definitions do. SLAs record-only except `in_holding` (45 min, active, escalation to `ot_incharge`) and `discharge_ready` (120 min, active — a scored-ready patient still in a bay is the KPI that matters). `ot_gate` (subject `{type:"ot_gate", id}`): `open → satisfied | waived | overridden`, all three terminal; `waived` only for gate kinds the criteria definition marks `waivable` (e.g. `site_marking` for a non-lateral procedure); `overridden` requires DD5's two-actor lane. **A gate is a child instance, not a boolean** (doc 15 §3.2), so its history is the engine's, not ours.

**DD5 — Gates: nine kinds in this phase. (F7: the OPD consult has NO structured procedure advice — `advice` is free text; **booking captures the procedure itself in the OT module and the book screen deep-links from the consult; OPD's schema is not touched**.), required-set per procedure class from the criteria definition, two-actor override for clinical gates only, no override lane at all for the kinds this phase does not ship.**
Kinds: `anaesthesia_review` (ASA grade, valid N days — 30 for ASA I–II), `consent_procedure`, `consent_anaesthesia`, `site_marking` (laterality must equal the case's — A3, the triple-equality is computed at `satisfy`, not trusted), `npo` (TWO typed times — last solids, last clear fluids — `satisfied` computed against the planned start: solids ≥ 6 h AND clear fluids ≥ 2 h; classes with `npoRequired: false` in the criteria — local-anaesthesia-only procedures such as ganglion or trigger finger — get no `npo` gate at all — H9, N1, F25), `deposit` (DD12), `escort` (DD2's jsonb complete + adult — R-3.24), `privilege` (surgeon's privilege list contains the procedure class — R-3.15, evaluated at BOOKING as a refusal, and again as a gate so a later privilege revocation bites), `mlc` (trauma procedure classes only: `registered | ruled_out`, E5). **Consent gates carry `{procedureCode, templateVersion, language, signer: patient|guardian, interpreter?, witness?, thumbImpression?, conversionCovered: boolean, documentId}`** (H6, E7, K2, K4, G2); a minor's consent requires `effectiveGuardianAuthority(...).consents` (E15). **Override:** `overrideGate(tx, gateId, {surgeonId, anaesthetistId, reason})` — two distinct actor ids, both holding the named roles, → `gate.overridden` (incident-class, digest line); refused for `deposit` unless the approvals exception (DD12) is granted, refused for `escort` always at discharge (E-4 of §11.16-A: a day-care patient discharges to an adult, structurally). `mtp`, `form_f`, `sterile_set`, `implant_availability`, `blood`, `theatre_fit` are **not kinds in this phase** — they arrive with 15b/15c/15d and the criteria definition cannot name them (zod enum), so nothing can be "pending" on a gate that does not exist.

**DD6 — Governed definition data lives in ONE versioned table, `ot_definitions`, published through the approvals engine — and the honesty about single approvers is in the SoD, not in a new event.**
`ot_definitions(id, kind, version, body jsonb, status: draft|active|superseded, published_by, published_at, approval_id)`; kinds this phase: **`criteria`** (procedure whitelist per department with `procedureClass`, `lateral: boolean`, `traumaClass: boolean`, `requiredGates[]`, `waivableGates[]`, `implantExpected: boolean`, `cArm: boolean`; plus `asaMax`, `ageMin/Max`, `bmiMax`, `escortRequired`), **`privileges`** (surgeonId → procedureClass[]), **`deposit_policy`** (§3A's table as data), **`pacu_thresholds`** keyed by **anaesthesia technique** (F24b — `general | spinal | regional | local_sedation`: PADSS for GA; spinal adds ambulation + voiding items), each with `items`, `threshold`, `minScores: 2`, `minGapMinutes: 30`. **The `criteria` entry for every procedure class also names `packageServiceCode` — a tariff `service` with `category = 'daycare_package'`, ONE per class, created by `createService` in the go-live runbook (F8: the tariff has no package/bundle table and this phase does not add one; implants are ALWAYS outside the package, §4A-2).** `publishDefinition` = `requestApproval(type: "ot_definition_publish", approver: "medical_superintendent")` → on `approval.granted` the draft becomes `active` and the previous `superseded`; the engine's `requester_approver` SoD already forces two humans, and Class-A activation runs `assertNotSodPair("workflow_drafter_activator")` (`kernel/workflow/definitions.ts:208`) — so with ONE user nothing here can be published or activated, and the tree offers no bypass. **F6: R-247 has no code and this phase builds none.** The honest posture is: two distinct humans (MS + a department head or the owner) exist in production's 35 users or are created in the go-live runbook (Spike Q3); the gate report names them; *the approver is one MS, not a committee*. **Seed:** `seed-ot.js` installs R-3.18's whitelist seed, the `pacu_thresholds` default and §3A's policy as **drafts** — a human publishes them (T9's runbook), because a seed that activates a Class-B definition is the theatre the owner named.

**DD7 — WHO checklist phases are the case's own transitions; counts are rows; "correct" is derived (H8); two distinct actors or nothing (F4).**
`ot_checklist_runs(case_id, phase: signin|timeout|signout, items jsonb, participants[], halted, halt_reason, completed_at)` — the transition `signed_in → timed_out` requires a completed `timeout` run with ≥ 2 distinct participant ids (A8, `timeout.halted` writes a `near_miss` row and the case stays `signed_in`). `ot_counts(case_id, round: initial|closing|final, item_type, expected, counted, scrub_by, circulating_by, version)` with `CHECK (scrub_by <> circulating_by)` **and the SoD pair `scrub_circulating` added to the kernel's `SOD_PAIR_SEED` (`kernel/auth/sod.ts`) in T1 — a named kernel edit (F11); the two-person rule is enforced by the OT service, since the engine has no two-actor transition;** `closing → signed_out` requires every `final` round row to have `expected = counted` — a mismatch is a hard stop that opens `count_mismatch` on the case (`incident.reported` event, the OT-local near-miss/incident table until 28a) and the only exits are a corrected recount (new round, both actors again) or the two-actor override with an X-ray reference. Optimistic `version` on the count row (B4) — a stale write is a 409, never a merge.

**DD8 — The five timestamps are write-once, and they are set BY the transition, not typed.** `wheel_in` (`in_holding → signed_in`), `induction` (`signed_in → timed_out`, anaesthesia start recorded on the run), `incision` (`timed_out → incision`), `closure` (`incision → closing`), `wheel_out` (`signed_out → in_recovery`). No route accepts them as input; `updateCase` has no path to them, **and a `BEFORE UPDATE` trigger refuses changing any of the five once non-null (billing's precedent, `schema/billing.ts:14`; F25) — so I4 is a trigger test, not a grep.** Backfill after downtime (C1) goes through `backfillCase(tx, actor, caseId, {phase timestamps with occurred_at, reason})` which performs the same transitions in order with `occurred_at` from paper and `recorded_at = now()`, refusing any order the matrix refuses (B8) and emitting `late_entry.flagged`.

**DD9 — The implant scan is ONE transaction: the case row, the registry-side fact, and the event — state-guarded, idempotent, with an explant path that the bill respects.**
`deployImplant(tx, actor, caseId, {lotId, batchId, itemId, storeResourceId, qtyBase, serial?, stickerRef?, serviceCode})` — refused unless the case is in `timed_out | incision | closing` (N6); inserts `ot_case_implants(case_id, item_id, batch_id, lot_id, serial, sticker_ref, service_code, qty_base, deployed_at, deployed_by, explanted_at, explant_reason, event_id)` under `UNIQUE (case_id, serial) WHERE serial IS NOT NULL` and `UNIQUE (case_id, lot_id, sticker_ref)` (H10), and **appends `consignmentDeployed` with DD13's payload verbatim** (`caseRef: {type:"ot_case", id}`, `encounterId` = DD2's id) through the outbox in the same transaction. The materials consumer then does its half asynchronously (Plan 14 T7). **`lot_exhausted` is the consumer's refusal, which is asynchronous** — so the cockpit shows the implant as `deploying` until `material.consumed` arrives (the `ot` manifest subscribes `{event:"material.consumed", consumer:"ot.implant_confirmed"}` and stamps `ledger_entry_id`), and a dead-lettered deployment is a red row the nurse sees before sign-out: **`closing → signed_out` is refused while any implant row is `deploying`** (DD7's hard-stop family). `explantImplant(tx, actor, caseId, implantId, reason)` sets `explanted_at` + emits `implant.explanted` (NEW). **F5: Plan 14 has NO return writer — `consignment_lots.qty_returned` is written by nothing and `stock_ledger` reason `return` has no author — so in this phase an explant reverses NOTHING in materials: `qty_deployed` stays incremented and the vendor liability stands until 14c's reconciliation nets it against the explant event; DD11's composer excludes the row from the patient's bill (D8: one patient charge) and the gate report says the vendor-side credit is 14c's.** **`ot_case_implants.source ∈ {consignment, patient_supplied}`** (F24c — a plate bought outside on prescription is common; `patient_supplied` rows capture sticker/serial, emit NO `consignmentDeployed`, and bill zero). Manual UDI entry (H3) requires a `verifiedBy` second actor.

**DD10 — Recovery: assignment through the registry, scoring to threshold from definition data, discharge behind the escort, three ways out and a late-hour rule.**
`admitToBay(tx, actor, encounterId, bedResourceId)` = registry `assign` with `occupantType: "daycare_encounter"` — an occupied bay refuses (B11, `already_occupied` from the kernel, mapped to 409 in `toHttp` — Plan 13's specimen) **and the error names the current `occupant_type` (F23 — an ED overflow occupant is representable and must be visible, N10).** `pacu_scores(encounter_id, case_id, scale, values jsonb, total, scored_by, scored_at, bay_resource_id)`; `discharge_ready` is computed: ≥ `minScores` scores ≥ threshold, the last two ≥ `minGapMinutes` apart **by `occurred_at` (typed, default now; backfill sets it — F25)** (B7), post-op orders signed. `dischargeDaycare` requires the escort re-verified at discharge (E-4 of §11.16-A; `escort.verified` twice, at check-in and here) and an ISBAR handover acknowledgement (F7); releases the bay (`onRelease: cleaning`); emits `daycare.discharged`; enqueues the follow-up recall task (missed follow-up = recall, never a no-show). **`convertToAdmission`** (from `in_recovery`/`discharge_ready`, and offered automatically when `discharge_ready` is reached after the definition's `lateCutoff` — default 20:00 IST, R-3.23) writes `outcome = converted`, prints the handoff document (summary, implant stickers, drug chart), emits `daycare.converted_to_admission {encounterId, at, destination: "incumbent_ipd"}` — **the timestamp is the billing boundary** (R-3.6). **`markAbsconded`** (N9) is a terminal with the bill issued as-is and a recall call task.

**DD11 — The discharge bill is COMPOSED, not typed; the clamp is computed IN THE OT MODULE against the batch's own price (F4); billing learns to resolve a day-care encounter through a seam (F2) — F5 RULED (R-3.2): re-derived ceiling at invoice time, frozen value as provenance.**
**F2 — `issueInvoice` calls `resolveEncounter` → OPD's `getEncounter` and throws `unknown_encounter` for anything not in `opd_encounters` (`billing/invoices.ts:256-265`).** This phase adds **`registerEncounterResolver(prefix, resolver)`** in billing (the `registerConsultStartGuard` shape OPD already exports): OPD registers `V`, OT registers `D`; `resolveEncounter` dispatches on the encounter number's letter and returns `{ patientId, intendedPayer }`. **This is the phase's named cross-module edit** (T7's Files list). The daily-close orphan scan still reads only `opd_encounters` — a discharged day-care encounter with no invoice is reported by OT's own `unbilledDaycare(db, day)` in T7, and the scan's widening is routed to 16c with the chargeables spine.
**F4 — billing's `regulated` clamp is keyed by SERVICE (`regulated_prices.service_id`) and no implant service will ever have a row there; materials' ceiling is keyed by ITEM.** So the composer clamps; billing's clamp is a no-op for implant services and T7 asserts that no `regulated_prices` row exists for any `daycare_implant` service (a fixture that adds one must make the two clamps agree, and the test says so).
**F9 — the conversion boundary is enforced by the composer:** only ledger rows with `occurred_at ≤ daycare_encounters.converted_at` are billed; later rows on the same encounter go to a `handoff_unbilled` report line for the incumbent system (the admission is the incumbent's, booked to the PATIENT, not to an encounter this system owns).
**Composition is permitted from these encounter outcomes only:** `discharged`, `converted` (bounded as above), `absconded` (bill as-is, N9), `deceased` (no package line if `incision` was never reached — the anaesthesia and theatre facts are 15d's bands; this phase bills package + implants only when incision happened); `cancelled` composes nothing — the deposit hold is released and refunded (§3A); the opened-kit charge is 15d's (F25).
**F24e — §269ST across the encounter:** the composer sums cash receipts HELD on the encounter (DD12) plus the discharge tender and refuses a cash tender that takes the encounter's cash total to ≥ ₹2,00,000 — billing's own C-2 check is per `service_day`, which a deposit-then-discharge pair defeats.
`composeDischargeBill(db, actor, encounterId)` → `IssueInvoiceInput`: one line per `ot_cases.package_service_code` (the day-care package from the tariff), one line per non-explanted `ot_case_implants` row priced as **`min(tariff(serviceCode), mrpPaisePerBase × qtyBase, ceilingPaisePerBase × qtyBase)`** from `consumptionsFor(encounterId)` joined to the implant rows by `caseRef`/`batchId`, with the line's `note` recording which of the three won (D9); refused unless every case on the encounter is `signed_out` or later (I7 — no ghost cases) and no implant row is `deploying`; **unreturned issued stock** (any `consume`-less issue to the case's theatre store — a 14 transfer with `refType: ot_case`) is a warning row, not a block (D12). The deposit: `allocateReceipt` of the receipts HELD on the encounter (DD12) to the invoice in the same call; over-deposit → `requestRefund(kind: advance_refund)` line (§3A). **Payer mapping at issue (F10):** `self_pay | staff_dependant | charity | membership_prepaid → 'self'`, `insured_tpa → 'tpa'`, `corporate_credit → 'corporate'`, `govt_scheme → 'pmjay'`, **`fp_scheme → 'pmjay'` PROVISIONALLY with tag `fp_scheme` — 15b, which builds the FP claim, widens billing's `intended_payer` if the CA says the two must not share a bucket.** `corporate_credit` captures a credit-letter reference; **no credit limit is enforced anywhere in the tree (`partners` is commission/payout, not credit) and this phase does not pretend otherwise.** **THE BRANCH, RULED AT KICKOFF BY SPIKE Q4 — and neither branch as written survives contact with the tree.**

*Q4's measurement:* there is no per-line cap field, so branch (a) is unavailable as written. *And branch (b) is unsafe, which the spike found by reading the mechanism the branch names.* The manual-discount lane is **a contest candidate, not a bound**: `manualDiscountSource.propose` (`tariff/contest.ts:27-56`) looks up `ctx.manualCaps[discountCategory]` — config loaded from `rules.ts:149` — and if that category has **no ACTIVE cap row it returns the candidate REJECTED as `unknown_category`**; if the ask exceeds `maxBps` of gross it returns it REJECTED as `over_cap`; `runContest` then filters `rejected === null` and the line prices at **full tariff**. A regulated ceiling enforced through a discount that a missing config row silently deletes is not a ceiling. The `discountCategory` enum is `charity | scheme | negotiated_corporate | employee`, none of which means "the gazette", and widening any of their caps to 10,000 bps to let the clamp through would uncap that category hospital-wide — a governance regression bought to pay for a pricing bug.

**RULED: the clamp is a BOUND in the tariff engine's own `min` chain, passed per line by the OT composer.** `InvoiceLineInput` gains `capUnitPaise?: number` and `priceLine` treats it as one more bound beside MRP and ceiling, in the block whose own comment already says *"the hard block IS the min — no path may exceed the ceiling"* (`pricing.ts:22-42`); `RegulatedClamp.boundApplied` gains `"caller_cap"`. It is ~8 lines, it is impossible to silently drop (no config, no contest, no approval, no winner to lose to), and it keeps F4's ruling intact: **the OT module still computes the clamp against the BATCH's own MRP and ceiling** — the engine only applies the minimum it is handed. Billing's own `regulated` clamp stays as a second floor and is a no-op for implant services, exactly as F4 says.

**This widens T7's Files list by `modules/tariff/{types.ts, pricing.ts, pricing.test.ts}` and is a DISCLOSED PLAN DEFECT, not a scope creep** — DD11 wrote the branch structure precisely so the spike could rule it, T7's Files list already anticipated "the per-line cap field per Spike Q4", and the alternative is a bill that can exceed an NPPA ceiling whenever a config row is missing. **T7's Assertion Book row A24 discriminates it** (§2A corrects the plan's stale "A19"). **`material.ceiling_diverged`** (NEW) is emitted when `consumptionsFor`'s `ceilingPaisePerBase` differs from the frozen value on the `material.consumed` event for the same ledger entry — the composer reads the event row for that check; the invoice uses the derived value.

**DD12 — Deposit policy is data (§3A), the gate computes, the exception is an approval, and discharge is never blocked on money.** `requiredDeposit(policy, {payerClass, quotePaise, implantEstimatePaise, sanctionedPaise?, creditAvailablePaise?, entitlementPaise?})` is a pure function in `deposit.ts` with §3A's table as its truth and the property `0 ≤ required ≤ quote + implantEstimate`. **F3 — advances are per PATIENT (`receipts` has no encounter, `advanceOf` sums the patient) — an old OPD overpayment would satisfy a surgery's deposit and two same-day encounters could not be told apart.** So this module owns **`ot_deposit_holds(id, encounter_id, receipt_id, amount_paise, paid_by jsonb {name, relation, phone} | null, held_at, released_at, released_reason)`** — `holdDeposit(tx, actor, encounterId, receiptId, amountPaise, paidBy?)` earmarks part of a receipt's UNALLOCATED balance (refuses beyond `advanceOf − Σ open holds`), and the `deposit` gate is satisfied when `Σ open holds on the encounter ≥ required` OR a granted `ot_deposit_exception` approval (approver `owner`, routine, with `allowedShortfallPaise` in the payload — the ONLY path to `satisfied` with `paid < required`, N12). Cancel/postpone releases holds (`released_reason`); refunds go to `paid_by` when present (§3A third-party rule) — **and Spike Q6 rules what "go to" can mean: a refund is a VOUCHER (`cash | bank_transfer`), never a reversal to the original tender, so `paid_by` reaches the money as the voucher's typed payee at pay time, not as a card credit.** No billing schema change. `payer_class` change after booking → `payer.class_changed` + recompute (§3A last row). Quote = `priceInvoiceLines(loadPricingContext(db,{at}), [package line])` at booking, stored on the case as `quote_paise` with the tariff version id (B10: pinned at case start).

**DD13 — Events: seven from §11.16-A, four NEW, two consumed.** Emitted, module `ot`: `daycare.booked`, `daycare.checked_in`, `escort.verified`, `daycare.discharge_ready`, `daycare.discharged`, `daycare.converted_to_admission`, `daycare.absconded` (NEW), `case.cancelled` `{reason, attribution: patient|hospital|surgeon|payer|clinical}` (R-3.12), `timeout.halted`, `count.mismatch`, `gate.overridden`, `implant.explanted` (NEW), `procedure.converted` (NEW), `death.on_table_recorded` (R-3.22 — minimal: case `deceased`, theatre `blocked`, legal-hold flag on the encounter, MS notified), `late_entry.flagged`, `material.ceiling_diverged` (NEW, DD11), `surgeon.late_flagged` (F1 — a scheduler job at slot+15/+30). Consumed: `material.consumed` (DD9) and `patient.merged` (A5 — rewrite `patient_id` on `daycare_encounters`, `ot_cases`, `ot_case_implants`, `ot_specimens`, flag `re_verify_identity`; **materials' `stock_ledger.patient_id` is NOT rewritten by anyone — F16 — and OT reads the ledger by ENCOUNTER only; the materials-side consumer is routed to 14c**). **Specimens draw their label number from the existing `lab_specimen` series `S`** (F17 — one specimen, one number when Plan 17's accession lands; `D` is the encounter's letter only). `consignmentDeployed` is IMPORTED from `modules/materials`, never redefined. Every name passes the `entity.verb_past` lint.

**DD14 — Roles and permissions.** Roles (seeded, keys fixed, titles editable): `ot_incharge`, `surgeon`, `anaesthetist`, `ot_nurse`, `recovery_nurse`, `daycare_coordinator`. Permissions (14, declared on the manifest in T2 ahead of the routes): `ot.definitions.read`, `ot.definitions.manage`, `ot.cases.read`, `ot.cases.book`, `ot.cases.cancel`, `ot.list.manage`, `ot.gates.satisfy`, `ot.gates.override`, `ot.cockpit.operate`, `ot.implants.scan`, `ot.counts.record`, `ot.recovery.operate`, `ot.discharge`, `ot.bill.compose`. `ot_incharge` holds all but `ot.gates.override`, `ot.definitions.manage` and `ot.bill.compose`; `surgeon` + `anaesthetist` hold `ot.gates.override` (DD5 needs both), `ot.cockpit.operate`, `ot.cases.read`; `ot_nurse` holds `cockpit.operate`, `implants.scan`, `counts.record`; `recovery_nurse` holds `recovery.operate`, `discharge`; `daycare_coordinator` holds `cases.book`, `cases.cancel`, `gates.satisfy`, `list.manage`; `billing_counter` (existing) gains `ot.bill.compose`; `medical_superintendent` gains `ot.definitions.manage`. **Every permission change is mirrored in the SPA NAV table and the nav-parity test in the same commit** (§2.124).

**DD15 — Censuses this phase moves.** Manifests **14 → 15** (T2: `manifests.ts`, `manifests.test.ts:131,136`, `app.module.ts`, `worker.module.ts` — installed in both, it has subscriptions). Worker keys **11 → 12** (`:232`) and consumers **+2** (`ot.implant_confirmed`, `ot.patient_merged`). Permissions **89 → 103** and held/not-yet-modelled pins (`seed-roles.test.ts:476,553,554,563,584–586`) — MEASURE, do not assume the split. SPA routes **28 → 32** (T8; `caddyfile-parity.test.ts:307`). Deploy seeds: `seed-ot.js` into `deploy.sh` AND `SEED_STEP_SCRIPTS` (`deploy-parity.test.ts:345`) — **and `seed-materials.js` into `SEED_STEP_SCRIPTS`, where it is missing today** (§2 ground truth). `EPISODE_SERIES` gains `daycare: "D"` (`series.ts`, `series.test.ts`). `truncateAll` (`test/helpers/db.ts`) gains every `ot` table.

**DD16 — Four screens, Lane 1, hand-built (no Lane-2 generator exists — Plan 14 DD16's reason).** `/ot/list` (the day's list: sequence, publish, per-case gate chips, print the per-case downtime pack — C1/C2), `/ot/cockpit/:caseId` (holding verify by QR → gates → sign-in → time-out → counts → implants → sign-out; every hard stop is a modal that names the rule), `/ot/recovery` (two bays, scores, escort re-verify, discharge / convert / absconded), `/ot/book` (from the OPD consult's patient: procedure from the whitelist, side, surgeon, anaesthetist, slot, payer class → quote → required deposit). Keyboard-first; `en.json` + `hi.json`; **one `displayName(patient, viewerRole)` helper and a test that a confidential patient's legal name never reaches the list/board/recovery DTOs (F20)**; no family display in this phase (K3 → 22); **no FHIR Encounter resource (F21 — `opd/fhir.ts` emits references only; M3 is dropped from this phase).**

**DD17 — ONE additive migration, `0035`.** Ten tables, no backfill, nothing dropped; `pnpm db:generate` output committed as generated and **read** (the CHECKs in DD7 and DD9 are pinned by `ot.test.ts` reading `pg_constraint`, Plan 14 T1's shape).

**DD18 — What this phase deliberately does NOT build.** No MTP/PCPNDT/FP register or gate (15b); no CSSD set/load/BI (15c — the sterile-set gate does not exist here, and the gate report says so); no theatre-time bands, cancellation charge matrix, kit reconciliation, 3-way match, telemetry, equipment checks, dose-log-blocks-sign-out beyond a recorded dose field (15d — G4's *block* waits for the C-arm device row); no narcotic register (16); no histopath order (17 — `ot_specimens` is the manual chain: label from the open case only, dispatch destination, A10/M1); no transport tasks (31); no family display; no chargeables spine (16c); no `active` toggle; no override lane for kinds that do not exist; **no 3-way match (challan/usage/vendor invoice — the invoice leg is 14c's) and no §31(7) deemed-supply WATCH (the deadline is computed at GRN and nothing surfaces it until 14c) — F12.** **The value it ships:** a case that cannot be operated on without its gates, a theatre that cannot be double-entered, counts and implants that are facts, a recovery that cannot double-assign or discharge without an adult, and a bill composed from the ledger under the clamp.

**DD19 — Downtime is hospital-scoped until Plan 30; the per-case pack is printed with the list.** The list screen prints, per case, the WHO sheet, count sheet, implant sticker sheet and a specimen label with the case QR (doc 15 6.2). `backfillCase` (DD8) is the only way paper re-enters, and it flags.

**DD20 — Family status pings are DROPPED from this phase. RULED at kickoff by Spike Q7.** As written, DD20 required a message to *the escort's phone typed at escort verification and NEVER to `patients.phone`*. The notify kernel cannot address that recipient: `EnqueueNotificationInput` has no recipient field (`kernel/notify/enqueue.ts:25-42`) and the pump resolves the destination as `patients.phone` for a patient-audience template and `users.phone` for a staff one (`kernel/notify/pump.ts:360`). Building DD20 on that seam would send the family's ping **to the patient**, which is the single outcome DD20 exists to prevent (F19, J2) — and it would do it silently, because `NOTIFY_PROVIDER` is `z.enum(["console"])` (`kernel/config.ts:31`) and every send today is a log line, so no operator would ever see where it went.

**What this phase ships instead:** the escort's phone is captured, verified twice (check-in and discharge, DD10) and stored on `daycare_encounters.escort`; `notifyOk` is captured with it so the consent exists the day the channel does. **No `daycare_status` template, no `enqueueNotification` call, no adapter claim in the gate report.** The ping lands when the notify kernel gains a recipient override AND a real adapter — routed to the plan that widens `NOTIFY_PROVIDER` beyond `console`. The follow-up recall task in DD10 is a TASK, not a message, and is unaffected.

---

## 4A. RULED, PROVISIONAL, AND ROUTED

> **RULED by the owner 2026-08-28:** FP empanelment YES (15b's scope; `payer_class = fp_scheme` exists here); deposit default 100 % of package for self-pay, policy as data with §3A's edge cases (DD12). **DECIDED by the planner under the same-day mandate, owner may overturn:** every R-3.n cited above.

1. **Procedure whitelist seed — PROVISIONAL.** R-3.18's list ships as a DRAFT `criteria` definition; the gynae and ortho heads strike/add before the MS publishes. Nothing here hard-codes a procedure.
2. **Item → service bridge — RULED HERE, narrowly.** Plan 14 §4A-4 said the bridge belongs to the first phase that bills an item. That is this one: **`ot_case_implants.service_code`** chosen at scan from the tariff's implant services (the nurse picks "implant — plate/screw set" as the tariff names it; the item is the ledger's grain, the service is the bill's). 16c may generalise it into `items.service_id`; this phase does not touch `items`.
3. **Conversion destination = the incumbent IPD; the incumbent bills from the conversion instant** (R-3.6). The E-11 boundary-map paragraph is written into the gate report; if the owner names a different destination the event's `destination` field changes, nothing else.
4. **The MS as sole publisher (DD6)** is honest single-approver posture; when O1 closes, `ot_definition_publish` gains a second required approver by config, and the active definitions are re-ratified within 30 days. **AMENDED at kickoff by Spike Q3 — the two humans this needed ALREADY EXIST on production and the go-live runbook creates nobody:** `owner` = `admin` (Administrator), `medical_superintendent` = `anand.rao` (Dr. Anand Rao), distinct active users. Class A's `owner` + `medical_superintendent` pair is satisfiable (`approveDefinition` refuses a repeat approver id), and activation by the non-drafter satisfies `workflow_drafter_activator`. **F6 is discharged by measurement, not by posture.** What remains genuinely single-keyed is that `department_head` is unseeded with zero holders, so a Class-B definition has no lawful approver pair on production today — this phase publishes nothing Class B (DD6 routes `ot_definition_publish` through the approvals engine with `medical_superintendent` as approver, not through `CHANGE_CLASS_POLICY.B`), and T9's gate report says so.
5. **Anaesthetist on call resolves statically** (`usersHoldingRole("anaesthetist")`) until Plan 20; sign-in requires an assigned anaesthetist *user*, not a roster (F3).

---

## 4B. THE ADVERSARIAL PASS OVER §11.16-A — run 2026-08-28 (fresh reviewer, 102,006 tokens, 15 tool calls), and where each finding landed

The roadmap booked this pass "before Plan 15 is authored"; it ran against spec §11.16-A, the brainstorm record and the tree at `1fc8674`. **4 CRITICAL, 13 MAJOR, 8 MINOR.** Every one is folded above and cited by `F<n>` where it bites; this table is the index so none is re-litigated.

| F | finding (one line) | landed in |
|---|---|---|
| 1 | `bed` is a KERNEL kind; a second declaration is `duplicate_kind` at boot | DD3, T1 |
| 2 | `issueInvoice` resolves encounters through OPD only → `unknown_encounter` for a D-encounter | DD11 (resolver seam), T7, A32 |
| 3 | advances are per patient, not per encounter; an old OPD overpayment satisfies a surgery deposit | DD12 (`ot_deposit_holds`), A5c, A29 |
| 4 | billing's regulated clamp is SERVICE-keyed and blind to implants | DD11 (clamp in OT), A24 |
| 5 | Plan 14 has no consignment return writer | DD9 (explant reverses nothing in materials; 14c) |
| 6 | R-247 has no code; SoD blocks a one-user publish/activate | DD6, Spike Q3, T9 |
| 7 | the OPD consult has no procedure-advice branch | DD5 (booking captures the procedure; OPD untouched) |
| 8 | no package/bundle substrate in the tariff | DD6 (`daycare_package` service per class) |
| 9 | conversion boundary unenforceable by billing | DD11 (composer filters by `converted_at`), A30 |
| 10 | §3A payer classes ≠ billing's `intended_payer` enum; no credit limit exists | DD11 (mapping table, provisional `fp_scheme`) |
| 11 | no parent link for child instances; no two-actor transitions; SoD pair unseeded | DD4 (subject convention), DD7 (`SOD_PAIR_SEED`), T1 |
| 12 | whitelist exclusion must be structural; 3-way match and §31(7) watch undeclared; `no_sterile_set` postponement | A5b, DD18, DD4 |
| 13 | the record's §2 and §3.4 disagreed on 15b/15c | record §2 renumbered (this commit) |
| 14 | no OT consignment `store` row exists | DD3 (`OT-CONSIGN`), T9 |
| 15 | consumer idempotency is by event id, not serial | DD9, A17 |
| 16 | nobody rewrites `stock_ledger.patient_id` on merge | DD13 (OT reads by encounter; 14c) |
| 17 | `S` is the lab specimen series | DD13 (OT specimens draw from `S`) |
| 18 | `usersHoldingRole` is a list, not an assignment | DD4 (`anaesthetist_user_id` typed at publish) |
| 19 | no verified-number flag on patients | DD20 (escort phone only) |
| 20 | nothing forces alias display | DD16 (`displayName` + test), T8 |
| 21 | no FHIR Encounter resource exists | DD16 (M3 dropped) |
| 22 | theatre vocabulary unlisted | DD3 (one `blocked` + reason attribute, not a split) |
| 23 | bay error must name the occupant | DD10 |
| 24 | seven first-month edge cases (escort agency, spinal PADSS, patient-supplied implant, C-arm operator, §269ST across days, guardian-as-escort, Sunday list without anaesthetist) | DD6, DD9, DD11, DD4, A21, A31, T5 |
| 25 | under-specified: NPO clocks, timestamp immutability mechanism, score clock, composable terminal states | DD5, DD8, DD10, DD11 |

**What the reviewer verified CORRECT — not re-litigated:** DD13's `consignmentDeployed`/`consumptionsFor` shapes and `lot_exhausted` behaviour; `opd_encounters.type` open text and R-035 moot; the worker kind collection; `active` as one read predicate; receipts = advances with `advance_refund` and per-line `regulated_clamp`; patients' alias/guardian/merge surface; approvals SoD and Class A/B/C policy; `0034` as the chain head; the notify ladder; spec §11.16-A internally consistent with §11.9/§11.16.

---

## 5. Tasks

Tiers per AGENT-RULES §3. **CRITICAL tasks carry their Assertion Book rows inline** — assertion · mutant · discriminating input. Every task ends with the finish block (AGENT-RULES §5); commit messages are exact. Migration number re-based at kickoff (Spike Q1).

> **Fixture rule §2.102, with this phase's coinciding fields named:** implant fixtures must NOT have `tariff = MRP = ceiling` (the clamp is untested otherwise — Plan 14's seventh field); `mrpUom` must NOT be the base unit on at least one leg; the F5 leg needs frozen ≠ derived; `expected = counted` on every count row hides the mismatch path; a slot at 09:00 with NPO typed 03:00 makes solids and clear fluids agree — use 06:30 so they differ; a single scorer for PACU hides the two-scores-30-min rule; two racing sign-ins on DIFFERENT theatres do not discriminate B1; the escort's phone equal to the patient's is the A7 trap. **A "discriminating input" is a prediction until run — the executor corrects rows and records the correction as a finding.**

---

### T1 — Ten tables, the `D` series, two kinds, migration `0035` — **ROUTINE**

**Files:** Create `apps/core/src/kernel/db/schema/ot.ts`, `ot.test.ts`; Modify `schema/index.ts`, `apps/core/test/helpers/db.ts` (truncate list), `kernel/episodes/series.ts` (+ `daycare: "D"`), `series.test.ts`; Create `apps/core/src/modules/ot/kinds.ts` (DD3 — the `theatre` declaration ONLY, `OT_RESOURCE_KINDS`), `kinds.test.ts`; Modify `kernel/auth/sod.ts` (`SOD_PAIR_SEED` + `scrub_circulating`, DD7) and its test; Generate `apps/core/drizzle/0035_*.sql` + meta.

**Produces:** `daycare_encounters` (DD2), `ot_cases` (`id, encounter_id, patient_id, theatre_resource_id, list_date, seq, procedure_code, procedure_class, laterality, surgeon_id, anaesthetist_id, anaesthesia_type, asa_grade, package_service_code, quote_paise, tariff_version_id, payer_class snapshot, workflow_instance_id, wheel_in, induction, incision, closure, wheel_out, wound_class, cancellation {reason, attribution}, return_of_case_id, created/updated`), `ot_lists` (`list_date, theatre_resource_id, version, published_at, published_by, status`), `ot_case_gates` (`case_id, kind, workflow_instance_id, state, evidence jsonb, satisfied_by, override {surgeonId, anaesthetistId, reason}, UNIQUE(case_id, kind)`), `ot_checklist_runs`, `ot_counts` (DD7 CHECK), `ot_case_implants` (DD9 uniques), `ot_specimens`, `pacu_scores`, `ot_definitions` (DD6), `ot_deposit_holds` (DD12), `ot_incidents` (near-miss / count-mismatch / death-on-table, OT-local until 28a); the DD8 timestamp trigger in the generated SQL. `ot.test.ts` reads `pg_constraint` for the DD7/DD9 CHECK + UNIQUE names and proves the trigger refuses a second `incision`.
**Acceptance:** `pnpm verify` green; the generated SQL read and quoted (no DROP, no data migration); `kinds.test.ts` proves the `theatre` declaration validates against `ResourceKindDecl`, `theatre.occupied = "in_use"`, and that the manifest declares NO `bed` (the kernel's claim — a second one is `duplicate_kind` at boot, F1).
**Commit:** `feat(core): OT schema — day-care encounters, cases, gates, counts, implants, deposit holds, definitions; the D series; the theatre kind; the scrub/circulating SoD pair (15 T1)`

---

### T2 — Module skeleton: manifest, permissions, roles, events, errors, approval types, seed, both censuses — **ROUTINE**

**Files:** Create `modules/ot/{manifest.ts, events.ts, events.test.ts, errors.ts, errors.test.ts, index.ts, ot.module.ts, approval-types.ts}`, `apps/core/scripts/seed-ot.ts` (**path corrected at kickoff — §2A**); Modify `kernel/modules/manifests.ts`, `manifests.test.ts`, `app.module.ts`, `kernel/worker/worker.module.ts` (manifest + two consumer keys — stubs that throw `not_implemented` until T5/T3 replace them is NOT acceptable: register the real `patientMergedConsumer` here (A5) and add `implantConfirmedConsumer` in T5's commit with its subscription — the `partnersManifest` one-commit rule), `test/seed-roles.test.ts` (measured pins), `scripts/seed-roles.ts`, `package.json`, `docker/prod/deploy.sh`, `test/deploy-parity.test.ts` (`seed-ot.js` **and** `seed-materials.js`), `README.md` (permission census).

**Produces:** DD13's event objects (importing `consignmentDeployed` from `../materials` for the re-export test that proves it is the same object, never a copy); `OtError` codes: `criteria_refused`, `privilege_refused`, `duplicate_booking`, `gate_open`, `gate_not_overridable`, `same_actor`, `count_mismatch`, `bad_transition`, `implant_state`, `implant_deploying`, `bay_occupied`, `escort_required`, `not_ready`, `bill_not_composable`, `definition_not_active`, `stale_version`; `registerOtApprovalTypes` (`ot_definition_publish`, `ot_deposit_exception`); `seed-ot.js` (DD3 resources, DD6 drafts, roles, approval types — idempotent).
**Acceptance:** worker and API both boot with the manifest (quote both boot lines); every census pin measured and quoted; `pnpm verify` green.
**Commit:** `feat(core): OT module skeleton — manifest, events, errors, roles, approval types, seed; censuses moved (15 T2)`

---

### T3 — Definitions, booking, criteria, privileges, deposit computation — **CRITICAL**

**Files:** Create `modules/ot/{definitions.ts, definitions.test.ts, deposit.ts, deposit.test.ts, booking.ts, booking.test.ts, workflow-def.ts, workflow-def.test.ts}`; Modify `index.ts`.

**Produces:** `publishDefinition` / `activeDefinition(kind)` (DD6); `requiredDeposit` (DD12, pure); `holdDeposit` / `releaseHolds` (DD12); `bookCase(tx, actor, {patientId, opdEncounterId?, procedureCode, laterality?, surgeonId, anaesthetistId?, listDate, payerClass, schemeRef?})` → criteria check (class in whitelist, ASA/age/BMI from the PAC if present else deferred to the gate, `mtp`/USG classes absent from the enum), privilege check (refusal), duplicate soft-block (A9: same patient + date + procedure → `duplicate_booking` unless `force` by `ot_incharge`), quote via `priceInvoiceLines`, `daycare_encounters` + `ot_cases` rows, `startInstance("daycare_case")`, one `ot_gate` instance per required gate kind, `daycare.booked`; `cancelCase` with attribution; `changePayerClass`; the two definition JSONs (DD4).

#### Assertion Book — T3
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | `requiredDeposit` satisfies `0 ≤ required ≤ quote + implantEstimate` for every payer class, and `govt_scheme`/`fp_scheme`/`charity` are exactly 0. | A policy evaluator that subtracts the sanctioned amount without the co-pay floor. | **`insured_tpa`, quote 60,000, sanctioned 60,000, co-pay floor 20 %.** Shipped: 12,000. Mutant: 0. A sanction below the quote does not discriminate. Property test over random inputs for the bounds. |
| **A2** | A procedure class outside the ACTIVE criteria definition is refused at booking; a class in a DRAFT definition does not count. | A check that reads the latest definition regardless of status. | **Active v1 without `hysteroscopy`, draft v2 with it.** Shipped: refused. Mutant: booked. One version does not discriminate. |
| **A3** | A surgeon without the procedure class in the ACTIVE privileges definition is refused. | Privilege check skipped when the surgeon has ANY privilege. | **Surgeon privileged for `ortho_minor` booking `gynae_minor`.** |
| **A4** | Booking creates exactly the gate instances the class's `requiredGates` names — `mlc` only for `traumaClass`, `site_marking` only for `lateral`. | Creating every gate kind for every case. | **A non-lateral, non-trauma D&C.** Shipped: no `site_marking`, no `mlc` instance. Mutant: both present and blocking readiness forever. |
| **A5** | The quote is pinned: the case stores `tariff_version_id`, and a tariff revision after booking does not change `quote_paise`. | Re-pricing at read. | **Book, then publish a revision that raises the package.** |
| **A5b** | The `procedureClass` enum of the `criteria` definition schema (zod) does NOT admit `mtp` or any `usg_*` value — a draft naming one fails validation, so the whitelist cannot be widened into 15b's territory by data (F12). | Enum widened. | **Draft with `mtp`.** Shipped: `definition_invalid`. |
| **A5c** | `holdDeposit` refuses an amount beyond the receipt's unallocated balance net of open holds; two encounters cannot hold the same rupee twice (F3). | Checking `advanceOf` without subtracting open holds. | **Advance 30,000; hold 20,000 on encounter 1; hold 20,000 on encounter 2.** Shipped: second refused. Mutant: both held. |

**Acceptance:** rows per rule 21; `workflow-def.test.ts` proves both JSONs validate under `defineWorkflow` and the transition matrix has no path `signed_in → incision`.
**Commit:** `feat(core): OT definitions, deposit policy, booking with criteria and privilege gates (15 T3)`

---

### T4 — Readiness: gate satisfy/waive/override, consents, NPO, escort, list publish — **CRITICAL**

**Files:** Create `modules/ot/{gates.ts, gates.test.ts, lists.ts, lists.test.ts, consents.ts, consents.test.ts}`; Modify `index.ts`.

**Produces:** `satisfyGate(tx, actor, gateId, evidence)` per kind with the computed kinds (`site_marking` laterality triple-equality; `npo` from typed time vs slot; `deposit` from `patientBalance` + exception; `escort` from DD2's jsonb; `privilege` re-evaluated); `waiveGate` (only `waivableGates`); `overrideGate` (DD5); `evaluateReadiness(tx, caseId)` → `listed → ready` when all terminal-satisfied; `recordConsent` (DD5's shape; guardian authority for minors; `consent.revoked` → `cancelCase(attribution: patient)` — E8); `publishList` (`ot_lists` version + `list.published`), `resequence`, `printPack` (DD19 data, rendering in T8); the `surgeon.late_flagged` scheduler job.

#### Assertion Book — T4
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A6** | A case cannot reach `ready` while any required gate is `open`; satisfying the last gate flips it in the same transaction. | `evaluateReadiness` counting `satisfied + open` as done. | **Eight of nine gates satisfied.** Shipped: `listed`. Mutant: `ready`. |
| **A7** | `site_marking` cannot be satisfied when the marking's laterality ≠ the case's ≠ the consent's. | Comparing marking to case only. | **Case L, consent R, marking L.** Shipped: refused. Mutant: satisfied. Case ≠ marking does not discriminate. |
| **A8** | `overrideGate` with the same user as surgeon and anaesthetist is refused `same_actor`; with two users lacking the roles it is refused; on success `gate.overridden` is emitted. | Distinct-id check dropped. | **Same user id twice, both roles held.** |
| **A9** | `escort` is not overridable, and `deposit` is overridable ONLY through a granted `ot_deposit_exception`. | Override lane applied uniformly. | **Override `escort` with two valid actors → refused; override `deposit` without exception → refused; with granted exception → satisfied.** |
| **A10** | `npo` is computed: a typed last-intake 4 h before the slot is NOT satisfied for solids and IS for clear fluids. | Trusting a typed `satisfied: true`. | **Slot 09:00, solids 05:30, clear fluids 07:30.** |
| **A11** | A minor's consent without guardian authority for `consents` is refused; with it, the signer is the guardian and the gate satisfies. | Skipping the authority scope. | **Guardian with `messages` authority only.** |

**Acceptance:** rows per rule 21; the late-flag job is a scheduler job with a test through the scheduler's harness, not a `setTimeout`.
**Commit:** `feat(core): OT readiness — gates, consents, escort, NPO, list publish, override lane (15 T4)`

---

### T5 — The cockpit: holding verify, WHO states, counts, timestamps, implants, specimens, the consumer — **CRITICAL**

**Files:** Create `modules/ot/{cockpit.ts, cockpit.test.ts, cockpit.concurrency.test.ts, counts.ts, counts.test.ts, implants.ts, implants.test.ts, specimens.ts, specimens.test.ts, consumers.ts, consumers.test.ts}`; Modify `manifest.ts` (subscription `material.consumed → ot.implant_confirmed`), `index.ts`, `kernel/worker/worker.module.ts` (same commit).

**Produces:** `verifyHolding(tx, actor, caseId, qrPayload)` via `verifyQrScan` (A1/A2 — mismatch → `ot_incidents` near-miss, case stays); `signIn` (registry `assign` on the theatre in the same transaction — B1; requires anaesthetist user present), `completeChecklist(phase)`, `timeOut` (DD7 participants), `recordCount` (DD7), `markIncision`, `markClosure`, `signOut` (counts + implants gate), `wheelOut` (registry `release` → `turnover`); `deployImplant` / `explantImplant` (DD9); `recordDoseLog` (fields: DAP/fluoro time + **operator user id, named — F24d**; no block in this phase); `createSpecimen` / `dispatchSpecimen` (A10: label from the open case; foreign label refused); `recordProcedureConverted`; `recordDeathOnTable` (R-3.22); `backfillCase` (DD8); `implantConfirmedConsumer` (stamps `ledger_entry_id`, idempotent by event id).

#### Assertion Book — T5
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A12** | Two concurrent `signIn` calls on ONE theatre serialise: exactly one succeeds, the other fails `already_occupied`; the theatre ends `in_use` with one occupant. | Sign-in that sets case state before/without the registry assign. | **Two transactions, two connections, barrier-synchronised, same theatre** (`cockpit.concurrency.test.ts`, the `ledger.concurrency.test.ts` shape; state assertion, not timing — §2.99). Two theatres do not discriminate. |
| **A13** | `signed_in → timed_out` is refused without a completed `timeout` run with ≥ 2 distinct participants; `timeout.halted` leaves the case `signed_in` and writes a near-miss row. | Participant count ≥ 1. | **One participant id listed twice.** |
| **A14** | `closing → signed_out` is refused while any `final` count row has `expected ≠ counted`; the CHECK refuses `scrub_by = circulating_by` at the DB. | Sign-out reading `initial` rounds. | **Initial 10/10, final 10/9.** Shipped: refused. Mutant: signed out. Equal counts everywhere are the coinciding fixture. |
| **A15** | The five timestamps are set only by their transitions, each once: a second `markIncision` is refused and no route body can set `incision`. | (mechanical + behavioural) an update path that accepts a timestamp map. | **Call `markIncision` twice; grep the controller DTOs for the five names.** Weak-row disclosure as A11-of-14. |
| **A16** | `deployImplant` in `signed_in` (before time-out) is refused `implant_state`; in `incision` it inserts the row AND the outbox carries `consignment.deployed` with `caseRef.type = "ot_case"` and `encounterId` = the D-encounter, in ONE transaction (a thrown insert leaves no event). | Emitting after the insert commits. | **Force the insert to fail on the second of two calls (duplicate serial); assert zero new outbox rows for the failed call.** |
| **A17** | A duplicate scan (same case + serial) is refused and writes nothing — the `ot_case_implants` row is inserted BEFORE the event is appended, in one transaction, so the unique index is the guard; the consumer's idempotency is by EVENT ID (`consumption.ts:117`) and would NOT catch a second event for the same serial (F15). | Unique index dropped. | **Same serial twice.** Shipped: 409 before any event. Mutant: two events → two ledger rows, lot decremented twice. |
| **A18** | `signOut` is refused while an implant row is `deploying` (no `material.consumed` yet). | Gate on `explanted_at IS NULL` only. | **Deploy, do NOT run the consumer, sign out.** Shipped: `implant_deploying`. Mutant: signed out with an unconfirmed ledger fact. |

**Acceptance:** rows per rule 21; worker boots with the subscription bound (quote the line); `backfillCase` test with `occurred_at < recorded_at` and a refused out-of-order backfill.
**Commit:** `feat(core): OT cockpit — holding verify, WHO states, counts hard stop, immutable timestamps, implant scan in-transaction, specimens, material.consumed consumer (15 T5)`

---

### T6 — Recovery: bays, scoring, escort, discharge, conversion, absconded — **CRITICAL**

**Files:** Create `modules/ot/{recovery.ts, recovery.test.ts, recovery.concurrency.test.ts}`; Modify `index.ts`.

**Produces:** `admitToBay`, `recordScore`, `evaluateDischargeReady`, `verifyEscort(at: checkin|discharge)`, `dischargeDaycare` (DD10 + follow-up recall task via the notifications/scheduler seam + `daycare.discharged`), `convertToAdmission` (handoff document data + event), `markAbsconded`, the late-cutoff offer.

#### Assertion Book — T6
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A19** | Two concurrent `admitToBay` on one bay: exactly one succeeds. | Assign without the registry's occupancy check. | **Barrier test, one bay.** |
| **A20** | `discharge_ready` requires ≥ 2 threshold scores ≥ 30 min apart (from the ACTIVE `pacu_thresholds`). | Any one threshold score. | **Two threshold scores 10 min apart** → not ready; **third at +30** → ready. |
| **A21** | `dischargeDaycare` is refused without a discharge-time escort verification even when check-in verification exists; refused when `escort.phone == patient.phone` or age < 18; **a minor's escort must be a guardian with `consents` authority (F24f)**. | Reading the check-in verification. | **Verified at check-in only.** Shipped: `escort_required`. Second leg: minor, escort = a guardian holding `messages` only → refused. |
| **A22** | `convertToAdmission` records the boundary instant and the encounter's `outcome`; the bay is released; a later `dischargeDaycare` on the same encounter is refused. | Conversion that leaves status `in_recovery`. | **Convert, then discharge.** |
| **A23** | Reaching `discharge_ready` after the `lateCutoff` emits the conversion OFFER (an event + task), never an automatic conversion. | Auto-convert. | **Threshold met at 20:30 IST** (fixture clock in IST, NOT UTC noon — Plan 14 m2). |

**Commit:** `feat(core): OT recovery — bays under the registry, PACU scoring to threshold, escort-gated discharge, conversion boundary, absconded (15 T6)`

---

### T7 — The discharge bill — **CRITICAL**

**Files:** Create `modules/ot/{bill.ts, bill.test.ts}`; Modify `index.ts`; **Modify `modules/billing/invoices.ts` (+ `billing/index.ts`, test) — `registerEncounterResolver` (DD11/F2), and `modules/opd/opd.module.ts` registering the `V` resolver — the phase's named cross-module edits; plus (branch a only) the per-line cap field per Spike Q4.**

**Produces:** `composeDischargeBill` (DD11), `ceilingDivergence(db, ledgerEntryId)` (reads the `material.consumed` event row's frozen `ceilingPaisePerBase` and compares to `consumptionsFor`'s), `settleDeposit` (allocate + over-deposit refund request).

#### Assertion Book — T7
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A24** | The implant line price is `min(tariff, MRP×qty, ceiling×qty)` and the note names the winner. | Tariff only. | **tariff 50,000 · MRP/base 42,000 · ceiling/base 45,000, qty 1** → 42,000 "mrp"; a second leg **tariff 40,000** → 40,000 "tariff". `tariff = MRP = ceiling` is the coinciding fixture and MUST NOT be the only leg. |
| **A25** | MRP is applied per BASE unit × `qtyBase`, never the printed pack MRP once. | Using `mrpPaise` (pack) directly. | **`mrpUom = "box"` of 2, `mrpPaise` 80,000, qty 1 base** → 40,000; mutant 80,000. |
| **A26** | Explanted implants are excluded from the bill; the patient is charged once for D8's two-deployment case. | Filtering on `deployed_at` only. | **Two rows, first explanted.** Shipped: one line. |
| **A27** | Composition is refused unless every case on the encounter is ≥ `signed_out` and no implant is `deploying`. | Checking the first case only. | **Two cases (N8), second in `incision`.** |
| **A28** | When the re-derived ceiling ≠ the frozen event value, the invoice uses the derived value and `material.ceiling_diverged` is emitted; equal values emit nothing. | Using the frozen value. | **Insert a correcting regulation row with the same `effective_from` and a lower ceiling AFTER the deployment; compose.** Frozen 45,000, derived 43,000 → line 43,000 + event. This is F5's ruling as a test. |
| **A29** | The deposit HELD on the encounter is allocated to the invoice in the same call; an over-deposit produces a refund request for exactly the excess and never a silent credit; a hold on ANOTHER encounter of the same patient is untouched. | Allocating from `advanceOf` rather than the holds. | **Patient with hold 60,000 on E1 and 20,000 on E2; invoice E1 52,000** → refund 8,000, E2's hold intact. |
| **A30** | After conversion, only ledger rows with `occurred_at ≤ converted_at` are billed; a later consumption on the same encounter lands in `handoff_unbilled`, never on the invoice (F9). | No boundary filter. | **Deploy at 14:00, convert at 16:00, deploy again at 17:00.** Shipped: one line + one report row. |
| **A31** | A cash discharge tender that takes the encounter's cash total (held + tendered) to ≥ ₹2,00,000 is refused, even across days (F24e). | Per-day check only. | **Cash hold 1,50,000 on day 1; cash tender 60,000 on day 3.** |
| **A32** | `issueInvoice` with a `D` encounter resolves through the OT resolver and carries the mapped `intendedPayer`; a `V` encounter still resolves through OPD; an unknown letter still throws `unknown_encounter` (F2). | Resolver that falls through to OPD. | **Three invoices: D, V, X.** |

**Commit:** `feat(core): OT discharge bill — composed from the ledger under min(tariff, MRP, ceiling), F5 ruling asserted, deposit settled (15 T7)`

---

### T8 — Routes, controllers, four screens, i18n, nav parity, the printed pack — **ROUTINE**

**Files:** Create `modules/ot/{ot-definitions.controller.ts, ot-cases.controller.ts, ot-cockpit.controller.ts, ot-recovery.controller.ts, ot.e2e.test.ts}`; Create `apps/web/src/screens/ot/{list.tsx, cockpit.tsx, recovery.tsx, book.tsx}` (+ tests); Modify `apps/web/src/router.tsx`, the NAV table, `nav-parity` test, `locales/en.json`, `locales/hi.json`, `test/caddyfile-parity.test.ts:307` (28 → 32), `ot.module.ts`.

**Produces:** every route guarded by DD14's permissions; `toHttp` maps `OtError`, `ResourceError`, `WorkflowError` (Plan 13's 500 specimen — assert one of each in the e2e); the e2e walks book → gates → list → holding → sign-in → time-out → counts → implant → sign-out → bay → scores → escort → discharge → bill, with the materials consumer run in-process.
**Acceptance:** e2e green; `displayName` test (DD16/F20) green; nav-parity green with the four entries; both locale files carry every key (the shell's contract); `pnpm verify` green.
**Commit:** `feat(core,web): OT routes and the four day-care screens — list, cockpit, recovery, booking; nav parity; i18n (15 T8)`

---

### T9 — Gate report, runbook, drills — **ROUTINE**

**Files:** Modify this document (§6 CLOSE), `README.md` (runbook: publish the drafts through the MS; activate the two Class-A definitions; seed order), the roadmap (15b/15c/15d named after 15 in Track A; one line).

**Produces:** the §19 mini-OT gate lines as this phase can honestly write them — criteria and privileges PUBLISHED by a named MS with a distinct drafter (Spike Q3 — F6); the `daycare_package` services created per whitelist class (DD6/F8); `OT-CONSIGN` store present (DD3/F14); `mtp`/USG classes ABSENT from the enum (with the grep); consignment agreement on file is Plan 14 O-8's precondition and is checked by the materials GRN, not here; the E-11 conversion boundary paragraph; downtime hospital-scoped; drills run and quoted: count mismatch (A14), escort absent (A21), two racing sign-ins (A12), downtime backfill (DD8). Then the two FRESH review passes, remediation, actuals into `token-baselines.json`, ledger lessons, ARCHIVE pass.
**Commit:** `docs(plans,readme): Plan 15 CLOSE — gate report, runbook, actuals`

---

## 6. CLOSE

**Closed 2026-08-28. CODE-COMPLETE and NOT DEPLOYED** — production is at 34 migrations and has never
left `commissioning`; Plan 14's `0034` is itself held. Plan 15 deploys only when the owner names a
SHA, and the go-live runbook (README, *Go-live runbook — the mini-OT*) needs a second human before
the four governed definitions can be published.

### 6.1 The commits

| # | SHA | Task | CI |
|---|---|---|---|
| — | `b5197e1` | spike answers Q1–Q7 written into §2A/§3B | — (docs) |
| T1 | `0f7f9f1` | schema: twelve tables, the `D` series, the `theatre` kind, the scrub/circulating SoD pair | GREEN 33146080758 |
| T2 | `ba11f9c` | module skeleton: manifest, events, errors, roles, approval types, seed; censuses moved | GREEN 33149451364 |
| T3 | `858727b` | definitions, deposit policy, booking with criteria and privilege gates | **RED 33152555678** |
| T4 | `bb8e3ac` | readiness: gates, consents, escort, NPO, list publish, override lane | GREEN 33157098556 |
| T5 | `93ada28` | cockpit: holding verify, WHO states, counts hard stop, immutable timestamps, implant scan, consumer | GREEN 33162083472 |
| T6 | `a484172` | recovery: bays under the registry, PACU scoring, escort-gated discharge, conversion, absconded | GREEN 33163705494 |
| T7 | `1d5ba69` | discharge bill composed from the ledger under min(tariff, MRP, ceiling); deposit settled | GREEN 33166676053 |
| T8 | `69dde01` | four controllers, four screens, the e2e, nav parity, i18n, F20 | GREEN 33171887445 |

**T3 shipped CI-RED and it is recorded as red rather than smoothed over.** `jobs.test.ts` V12
exceeded jest's 15,000 ms default on the runner; it runs in 1,117 ms on an idle host. T3 touched no
scheduler code — it added ~60 tests and starved the runner, which is §2.99 arriving from the
opposite direction (not a duration assertion that goes red on a busy host, but a *budget* that does).
T4 repaired it with an explicit `}, 60_000)` and the measurement in the docstring. Diagnosed by
running `gh run view 33152555678 --log-failed`, not by reasoning about it (v3 §9.3(a)).

### 6.2 Mechanical verification

- **`pnpm verify` exit 0**, read from a file (rule 18): `apps/core` **2,376 tests**, `apps/web`
  **284**, `packages/contracts` **21**. Entering the phase: 2,138 / 274 / 21 (Plan 14's close). The
  total never decreased at any task.
- **CI green by FULL SHA** for every commit except T3, above.
- **`git status --porcelain` clean** but for another session's untracked `docs/` work, which was
  never staged. Six of that session's files were unstaged from the shared index at T5 and left
  byte-untouched.
- **Migration `0035_mute_vision.sql` read and quoted.** Twelve `CREATE TABLE`s, their indexes and
  FKs, and the DD8 trigger. **Zero `DROP`, zero `DELETE`, zero `UPDATE … SET`** — additive only,
  confirmed by grep, not by assertion.
- **Both boot lines quoted, from the COMPILED build** (`node dist/src/main.js`, the production path):
  API `Nest application successfully started` with **52 OT routes mapped**; worker
  `worker started: jobs=…,flagLateSurgeons,…`. `tsx src/main.ts` cannot boot this app at all —
  esbuild does not emit `design:paramtypes`, so every constructor injection resolves `undefined`.
  That is a property of `tsx`, not of Plan 15; the probe that established it is in §6.5.
- **The four T9 drills, run and quoted:** A14 count mismatch (2 legs), A21 escort absent (3 legs),
  A12 two racing sign-ins (3 legs), C1/DD8 downtime backfill (3 legs). 11/11 pass.

### 6.3 The gate report (§19 lines this phase can honestly write)

- **`mtp` and the in-unit USG classes are ABSENT, not stubbed.** `PROCEDURE_CLASS_VALUES` is a zod
  enum of twenty classes and contains neither; a criteria draft naming `mtp` is refused
  `definition_invalid` (test A5b), and `definitions.test.ts` asserts the enum does not contain it.
  Nothing can be "pending" on a class that cannot be named.
- **`OT-CONSIGN` is a materials `store`**, not a theatre or a bay (`OT_CONSIGNMENT_STORE_CODE`),
  created idempotently by `seed:ot`.
- **One `daycare_package` tariff service per procedure class** (`packageServiceCode`), created by the
  go-live runbook. A class without one is refused `bill_not_composable` at discharge.
- **The consignment agreement is Plan 14 O-8's precondition and is checked at the materials GRN**,
  not here. The OT neither re-checks it nor can satisfy it.
- **Criteria and privileges are PUBLISHED by a named MS with a distinct drafter.** The approvals
  engine's requester-vs-approver segregation forces it. **Spike Q3 measured that this deployment has
  ONE full admin** — a second human must exist before step 5 of the runbook, and no code change
  substitutes for that.
- **Downtime is hospital-scoped**, and the conversion boundary (E-11) is inclusive at `converted_at`
  — both written up in the README runbook.


### 6.4 The Assertion Book, corrected by execution

**Twenty-two mutants built across T3–T8. Twenty-one DIED; one SURVIVED and is disclosed.**

- **A15 SURVIVED, legitimately.** The mutation — an update path that accepts a timestamp map — is
  refused by `0035`'s `ot_forbid_timestamp_rewrite` trigger, which is the mechanism DD8 ships. The
  test cannot kill it because the database kills it first. Plan 14's A8 is the precedent; the row is
  marked measured-not-predicted rather than engineered into a kill.
- **A8's first mutant died for the WRONG reason** (a weak kill, §3.14's family). The acting user was
  `f.incharge`, so the mutant died on the workflow engine's ROLE check and never reached the
  distinct-id check the row is about. Rebuilt with an actor holding BOTH `surgeon` and
  `anaesthetist`, so the distinct-id check is the only line that can refuse, plus a control leg
  proving the same actor under two different ids succeeds.
- **A12 and A16's first mutants were too weak** — both rolled back harmlessly inside one
  transaction. A12 was rebuilt with the state move in its OWN committed transaction ("without", not
  "before"); A16 with the event committed FIRST and the insert second.
- **Three error codes left the union at T5** (`identity_mismatch`, `theatre_occupied`,
  `timestamp_immutable`), found by this module's own `errors.test.ts` direction-1 scan. Each names a
  real refusal that a DIFFERENT layer already refuses in its own vocabulary. This is Plan 14's M8
  lesson caught at T5 instead of at CLOSE, by the test that phase's close had to invent.
- **T8's `F-settle` rows are new**, not in the original Book: the executing session found the defect
  in §6.5 and added three rows to pin it, including the ordering leg whose mutant DIED at
  `Expected: 5000000, Received: 0`.

### 6.5 Defects the executing session found and fixed, each proved before it was fixed

1. **`pnpm db:generate` emitted every CHECK constraint as a BIND PLACEHOLDER.** `sql\`${v}\`` makes
   a parameter, so `CHECK ("payer_class" in ($1, $2, …))` would have shipped a column enforcing
   nothing. Caught by READING the generated SQL before applying it. The `.sql`, the meta snapshot and
   the journal entry were rolled back (the journal restored byte-exactly with `printf '%s'`) and
   `inList` was rewritten to use `sql.raw` behind a snake_case guard that throws on anything else.
2. **The kernel resource registry had a read-check-write occupancy race** (finding T5-a). Proved
   fail-first: two overlapping assigns both returned `fulfilled` on ONE bed. `assignResource` and
   `releaseResource` now take a row lock via `lockResource`; `moveResource` deliberately does not,
   because two-row locking there is a deadlock shape. **This affects every bed, room and theatre in
   the system, not only the OT.** The first fix attempt used `tx.execute(sql\`… for update\`)`, whose
   snake_case columns broke a zod parse three layers down — replaced with drizzle's `.for("update")`.
3. **The whole deposit-then-discharge design was unreachable** (finding T7-a). `issueInvoice` refuses
   an unsettled remainder without a credit extension, and `allocateReceipt` needs the invoice to
   exist first — so there was no order in which the two could be called. Fixed by extracting
   `allocateOnTx` and adding `settleFromReceipts`, which allocates inside the issuing transaction so
   the invoice is never momentarily unsettled.
4. **`openCountMismatch` was rolled back by its own refusal.** The incident was written inside the
   transaction that then threw, so a refused sign-out left `ot_incidents` empty — the audit trail
   erased by the event it exists to record. Restructured: checks on `db`, the incident in its OWN
   transaction, only the transition transactional.
5. **`flagLateSurgeons` at 300 s collided with a production alert.** `alerts.yml` leg 1a thresholds
   every interval job at 300 s staleness, so the job would have paged on its first missed tick.
   Changed the job to 60 s rather than weaken the alert.
6. **`BillingError` and `TariffError` escaped the OT controllers as 500** (T8). A discharge bill
   larger than the deposit answered `Internal server error`. The status tables moved from
   `billing.controller.ts`'s privates to `billingHttpStatus` / `tariffHttpStatus` on their modules'
   index, imported by both controllers — Plan 09's `membershipHttpStatus` finding, one plan later.
7. **`settleDischargeBill` spent the deposit holds and never closed them** (T8). `releaseHolds`
   existed and was not called, so `heldPaise()` kept reporting money billing had already allocated —
   the number DD12's booking gate reads, the number the refund arithmetic is computed from, and the
   number the deposit-release ROUTE would have "released" out of an invoice.
8. **F20/DD16 was unbuilt.** §14's confidentiality rule was open-coded in `qr.ts` and nowhere else,
   and the OT list and recovery board carried no patient identity at all — satisfying the letter of
   "no legal name in the DTO" by carrying no name, which would have made both screens unusable and
   left the invariant unguarded. `displayName(patient, canSeeConfidential)` is now the one place the
   rule lives, `qr.ts` is one of its callers, and both DTOs carry `patientDisplay`.
9. **`F23`'s refusal message read "occupied by null null"** under contention, because the bay row was
   pre-read before the winner committed. Fixed by re-reading inside the catch.

Two self-inflicted process failures are recorded rather than hidden: **rule 20 was violated twice**
by starting a `pnpm verify` while an earlier one was still running, which produced per-worker DB
collisions and one spurious `unknown SoD pair key`. Both times the fix was to kill the strays,
confirm zero processes, and re-run once cleanly.

### 6.6 The two review passes, and their dispositions

Both FRESH, neither resumed (§2.115). **Pass 1: 271,994 tokens / 77 calls / 874 s — 1 CRITICAL, 11
MAJOR, 19 MINOR. Pass 2, over the remediation: 191,515 / 53 / 660 s — 0 CRITICAL, 6 MAJOR, 7 MINOR.**

**The ROI line.** Pass 1 ran against a tree that was eight-for-eight green on `pnpm verify` and CI,
with 22 mutants built and 21 killed, and it found a CRITICAL in the money path anyway: the §269ST
cash ceiling could not see cash taken at discharge. **The Assertion Book had a row for that guard and
its mutant died** — the row asked whether the refusal fires, which is the question the plan's author
had already thought about. Nobody had asked what the compared quantity was summed from. That is
ledger §2.128, and it is now a standing instruction in the reviewer's brief (v3 §9.7).

**Pass 2 earned its cost twice over, and both times inside pass 1's own fixes** — the fourth
consecutive phase (09a, 13, 14, 15) whose worst late defect is in the remediation:

- **MAJOR-3.** Pass 1 added an `additionalBill` flag so a return to theatre (N13) could raise a
  second bill. `composeDischargeBill` knows nothing of what is already invoiced, so the flag emitted
  a **full duplicate charge** — and the refusal message instructed the operator to use it.
  `invoice_lines` records no caller line id, so this phase cannot compose the increment honestly.
  **The flag is gone and the refusal is absolute; N13 is carried to 15d.** The shipped test had
  asserted the wrong thing (invoice numbers differ) and would have locked the double-charge in.
- **MAJOR-1/2.** Pass 1's per-receipt deposit bound ignored entered-in-error receipts (a dead receipt
  reports its full value as unallocated, so the hold passed both bounds and made the bill unissuable
  — M2's own defect, through a door M2's fix left open), and read the receipt **before** the lock,
  which is a read-then-act. Both fixed; the receipt read is now inside `lockPatientEncounters` and
  takes `FOR UPDATE`.
- **MAJOR-2's second half is a correction to this document.** Pass 1 claimed the per-receipt bound
  strictly dominates the patient-level one, and rewrote A5c on that basis. It is false: `advanceOf`
  subtracts advance refunds per patient and a receipt's balance does not. **Both bounds are kept and
  the dominance claim is withdrawn** — ledger §2.126 is the lesson, and the suite now says in as many
  words which divergence it does not test.
- **MAJOR-6 is the sharpest.** Pass 1's MINOR 12 made `assignResource` refuse any status that is not
  `initial`/`onRelease` — correct, and it closed a real hole (a theatre `blocked` after a death on
  table was reassigned by the next sign-in). But on a one-theatre unit it left the module
  **permanently unusable**, with the refusal naming an action no route provided. A guard shipped
  without its way out is a worse trade than the defect. `returnTheatreToService` ships with it,
  in-charge only, reason required.
- **MAJOR-4/5.** The double-bill guard was a non-transactional read-then-act on a route with no
  idempotency key, so a genuine double-tap still double-billed (billing's `withIdempotency` now
  guards it, exported rather than copied); and the §269ST ceiling had exactly one caller, so two cash
  deposits on two days were never tested against the encounter total at all.

**Every pass-2 MINOR was fixed** (the tender/shorthand double-count, the bay-move message, the
escort anchor on a bilateral encounter, the count-lock gap, the stale runbook, an unbounded CTE, and
a validated-but-unstored clock). **Pass 2 found no CRITICAL, so the close is not blocked; a third
pass is the owner's call and was not taken.**

**One pass-1 finding is recorded and NOT fixed** — MINOR 17: `invoices.encounter_id` carries the
D-number while `stock_ledger.encounter_id` carries the ULID. Each side is self-consistent with its
own module's frozen convention and the composer reads each correctly; unifying them is a two-module
data migration. Documented in `schema/ot.ts`, carried to 15b.

### 6.7 Actuals

| | |
|---|---|
| Lane | LIGHT — nine tasks coded in-session, **zero coding subagents** |
| Subagent tokens | **463,509** (pass 1 271,994 + pass 2 191,515) |
| Stop-loss | 730,000 — **not breached; 36% of headroom unused** |
| Agents | 2, both fresh, neither resumed |
| Main-session cost | **UNMEASURED** (runbook O3, open since Plan 11e) |
| Tests | `apps/core` 2,138 → **2,398** · `apps/web` 274 → **284** · contracts 21 → 21 |
| Migrations | `0035` (12 tables + the DD8 trigger), `0036` (the trigger gains DELETE), `0037` (two incident kinds) |
| Mutants | 22 built across T3–T8, 21 died; A15 survives legitimately (the trigger kills it first). Plus 4 at close: 3 for C1, 1 for the hold-release ordering — all died |

**The LIGHT-lane honesty rule (v3 §9.4).** 463,509 is not comparable to a HEAVY phase's number:
LIGHT moves the cost into the main session, which no session can measure from inside. Plan 14's
comparable figure was 458,491 for the same shape — two fresh reviewers over nine tasks — so the
review cost is flat phase-on-phase while the findings rose (14: 1 CRITICAL + 10 MAJOR across both
passes; 15: 1 CRITICAL + 17 MAJOR). **And a cheap phase that shipped a defect is not a saving:** the
number to weigh this against is that pass 2 found six MAJORs in the first remediation, which is what
the second pass is for.

**What the close cost, and it should be budgeted next time.** The remediation was larger than any
task: pass 1's touched 31 files and added two migrations; pass 2's added a third file, a route and an
idempotency guard. v3 §9.8 now says so — a phase whose review returns a CRITICAL should expect its
close to cost about as much as its tasks did.


---
*Byte count at write time: 71050 (≈ 17762 tokens) — the "this document" row of the context budget.*
