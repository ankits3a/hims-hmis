# Plan 17 — Phase 0: the P2 ORDER ENVELOPE

**Written 2026-08-29 on the build host, in a planning session running beside 22c-A's coding session. NOT APPROVED FOR EXECUTION — execution is a separate session with its own approval.** This document rules ONE question the radiology brainstorm asked and nobody answered ([`../brainstorms/2026-08-27-department-series/01-radiology-imaging.md`](../brainstorms/2026-08-27-department-series/01-radiology-imaging.md) §15.1): *does Plan 17 lay a kernel-level `orders` table or lab-private tables?* Until it is ruled, Plan 17 (LIMS) and Plan 18 (radiology) are ONE lane — whichever touches the seam first decides for the other silently, which is how `opd_rooms` came to need dropping in Plan 13.

**THE RULING, in one paragraph.** The envelope is **KERNEL** — three tables (`orders`, `order_items`, `order_item_transitions`) under `kernel/db/schema/orders.ts` and one code seam under `kernel/orders/`, exactly as `resources` and `episode_series` are kernel. An order KIND is **claimed on the manifest seam** (`orderKinds?: OrderKindDecl[]`, the `resourceKinds` precedent) and refused at boot on a duplicate, on a series key `EPISODE_SERIES` does not name, or on a placement permission no manifest declares. **One order is one kind**; a consult that asks for a CBC and a chest X-ray places two orders that share an `order_group_id`. The envelope's item state machine is **four states, closed, in code, not a workflow definition** — `placed → in_progress → completed | cancelled` — and every module's real pipeline (sample, study, dispense) runs as that module's OWN workflow definitions and PROJECTS onto the envelope through `advanceOrderItem`. `ordered_by` is a four-type actor stamp owned by the kernel; the clinical authority is a separate `ordering_clinician_id`, and whether it is required is the kind's declaration. `order_no` is minted by the EXISTING `nextEpisodeNo` from the series key the kind declares — this phase adds **no** counter. Money is **absent from the envelope by design**: the item carries `service_id`, and the module that claimed the kind posts the charge at the stage its own plan rules. **After this phase, 17 and 18 fork as two lanes.**

**Roadmap:** [`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md) — Track A, `17 → 18a`. **Numbering:** [`00-INDEX-AND-SYNTHESIS.md`](../brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md) §3 (17 / 17-E / 17-M / 17-H; 18a/b/c; 24a/b; 26). **Brainstorms argued from and not restated:** `02-central-lab-lims.md` §1 (scope table — *"order entry inside consult posts `order.placed(order_type=lab)`; lab owns everything after"*), §5 A7/A8/B4/B6/D1/D5/D6/D11/E1/M3/M9, §14 T2/T3; `01-radiology-imaging.md` §1 (scope table row 2), the dependency line at 543, §14 (18a's gate: *"17's order envelope shipped"*), §15.1. **Cross-module ruling 2 is honoured:** the registry kind set stays CLOSED at ten; this phase adds no resource kind and touches neither `kinds.ts` nor `resources_kind_ck`.

**Slot:** the repo journal carries **44** entries (`0000`–`0043`), measured 2026-08-29 12:30 UTC — `0043` is 22c-A's T1, committed `04b7b21`. **This phase writes `0044`.** That number is a MEASUREMENT, not a reservation the journal knows about: 22c-B or any lane that generates first takes it, and the executor re-measures at kickoff (§2 row 1, AGENT-RULES §6) and renames nothing by hand.

**Executor seed (v3 §1):** read this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — **which sits at line 1323 as of today, not the 1132 that 22c-A's seed cites; that pointer is stale and the file has grown 16,416 bytes since**. Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: **393,528 bytes ≈ 98,382 tokens**, re-billed on every tool call (v3 §9.1). Entries cited by number where they bite: §2.54 (one list, one owner), §2.115 (fresh, not resumed), §2.131/§2.132 (sibling-grep, preflight).

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Six tasks, one migration, no screen, no workflow definition, no approval band, no register. It is a kernel seam with zero consumers on the day it lands — the same shape as Plan 13 T1/T2 and 22c-A, which v3 §2 names as LIGHT's natural home. **Four of the six tasks are CRITICAL** (a permission seam, an immutability seam, a compare-and-set state machine, and a confidentiality-bearing reader), and CRITICAL means executed mutants in either lane.

**The main session codes task by task** under AGENT-RULES, runs `pnpm typecheck && pnpm lint` before every verify (§9.9 rule 6), folds code-complete tasks into one verify per batch (rule 4), watches CI by full SHA, and closes with reviewers **spawned FRESH** (§9.5, ledger §2.115). The close reviewer is briefed at the operands (§9.7): *for every "already exists" check in `placeOrder` and `advanceOrderItem`, name what it queries and which writes it would miss.*

### Stop-loss (v3 §6): **640,000 tokens**, arithmetic shown

`stop-loss = 1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`

- **Per-task rate — 20,178**, Plan 16a's LIGHT baseline ([`../pipelines/token-baselines.json`](../pipelines/token-baselines.json), phase `16a`: 181,605 / 9), carried by 14 and 22c-A. Restated bias: for a LIGHT phase `subagentTokens` IS the reviewer, so this is a review cost in execution clothing; main-session cost is unmeasurable from inside (runbook O3).
- **Task term:** `1.5 × (20,178 × 6) = 181,602`.
- **Review term — TWO FRESH passes: `244,568 + 213,923 = 458,491`**, Plan 14's measured pair. Two, not one, because this seam will be built against by five plans (17, 18a, 24a, 26, 22c-F) and a defect in it is paid five times; and because 09a, 13, 14 and 15 each found their worst late defect inside the remediation of the first pass.
- **Total: 640,093 → 640,000.**

Six tasks price within 5% of 22c-A's seven because the review term dominates. A clean single-pass close lands near 425,000 — expected, not a saving.

### Context budget (v3 §9.2), measured before compiling

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | 47,155 (re-`wc -c` at kickoff) | ≈ 11,800 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only (from line 1323, ~15 lines) | ≈ 3,800 | 950 |
| `kernel/resources/kinds.ts` (the precedent every task transcribes) | 10,034 | 2,509 |
| **NOT pointed at:** the ledger in full | 393,528 | **98,382** |

**Per-agent context carried: ≈ 22,000 tokens.**

---

## 1. Why this phase

### 1.1 The seam

`grep -rniE 'pgTable\(\s*"[a-z_]*order' apps/core/src/kernel/db/schema/` returns **nothing** (2026-08-29). The closest thing to an order in the house is `opd_encounters.advised_tests jsonb` — 07d's DD4/DD7 demand signal, deliberately *a column, not a table*, because 07d forbade itself from building the pipeline that belongs to Plan 17. The letters `L`, `S`, `R`, `P` have been reserved in `kernel/episodes/series.ts` since the 2026-08-25 ruling, so that *"those modules inherit this grammar instead of inventing one each."* The grammar was reserved; the table it numbers was not.

Two brainstorms then designed against a table that does not exist. The LIMS document's scope table says order entry *"posts `order.placed(order_type=lab)`; lab owns everything after"*, and the radiology document's says *"kernel orders (shared P2 envelope, proposed Plan 17 lays it for lab; 18 reuses)"*. Home collection (24a) needs *"17 accession"*; check-up packages (26) need *"17 orders/results"*; the patient app's reports segment (22c-F) needs to list what was ordered. **Five plans are waiting on one shape, and the plan that owns it (17) has not been authored.**

### 1.2 Why kernel, and not lab-private — DECIDED

An Indian corporate hospital orders from ONE investigations screen: the consultant ticks CBC, LFT and a chest X-ray on one sheet, the counter bills one slip, the IPD nurse sees one "pending investigations" list per bed, the TPA desk pre-authorises one bundle, the patient's app shows one "my tests" page. Every one of those is a cross-kind READ over a common envelope — and with module-private tables each of them becomes a UNION across N modules, rewritten every time a kind is added (blood bank 47b, diet 52, nursing 42a, transport 31). That is the `patients` argument (spec §6: one table, every module references it, copies nothing) applied to the order. Lab-private tables would give Plan 17 a faster T2 and give every plan after it a slower one.

### 1.3 What this phase does not do

No lab tables, no results, no specimens, no LOINC. No screen — the doctor cockpit keeps writing `advised_tests` and nothing converts it (that conversion is Plan 17 T2's first act, on this envelope). No charge posting. No prescription migration (§4 DD9). No new episode series, no new resource kind, no encounter enum value (`lab_walkin` is Plan 17's own T2 ask to OPD, 02 §15.1, and the envelope stores an encounter NUMBER so it does not care).

---

## 2. Ground truth — measured 2026-08-29 12:30 UTC on the build host (AGENT-RULES §6)

Every row is a command. **Re-run every row at kickoff**; four of 22c-A's seven rows had moved by the time it executed.

| # | fact | value today | how |
|---|---|---|---|
| 1 | migrations in the journal | **44** (`0000`–`0043`); this phase writes **`0044`** | `python3 -c "import json;j=json.load(open('apps/core/drizzle/meta/_journal.json'));print(len(j['entries']), j['entries'][-1]['tag'])"` → `44 0043_patient_identity_spine` |
| 2 | order-shaped tables in the kernel schema | **0** | `grep -rniE 'pgTable\(\s*"[a-z_]*order' apps/core/src/kernel/db/schema/ \| wc -l` |
| 3 | `Actor` union | **four** members — `user \| agent \| system \| patient` — **in the WORKING TREE (22c-A T2, uncommitted at measurement)**; `main` still has three | `grep -n 'export type Actor' packages/contracts/src/envelope.ts`; `git diff --stat packages/contracts/src/envelope.ts` |
| 4 | episode series keys | `visit appointment lab_order lab_specimen radiology_order pharmacy_dispense grn daycare` — 8; `L S R P` reserved and unused | `grep -n '^  [a-z_]*: "' apps/core/src/kernel/episodes/series.ts`; `grep -rln '"lab_order"\|"radiology_order"' apps/core/src --include=*.ts \| grep -v test` → `series.ts` only |
| 5 | encounter-resolver registry location and registrants | `modules/billing/invoices.ts:320`; registrants `opd.module.ts` (`V`), `ot.module.ts` (`D`); `billing/index.ts` re-exports | `grep -rn 'registerEncounterResolver' apps/core/src --include=*.ts \| grep -v '\.test\.'` → 4 lines |
| 6 | manifests installed | **16** `Manifest,` lines in `ALL_MANIFESTS` (`manifests.ts:56`), last appended `formularyManifest` | `grep -c 'Manifest,$' apps/core/src/kernel/modules/manifests.ts` → 16 |
| 7 | the manifest seam's optional fields | `search?`, `resourceKinds?`, `desk?` — three precedents, one shape | `grep -n '?:' apps/core/src/kernel/modules/manifest.ts` |
| 8 | immutability-trigger precedent | `0043_patient_identity_spine.sql:79-81` (`patient_identity_forbid_mutation`) | `grep -n 'CREATE TRIGGER' apps/core/drizzle/0043_patient_identity_spine.sql` |
| 9 | compare-and-set precedent | `kernel/workflow/instances.ts:136-150` — `UPDATE … WHERE status='active' AND current_state=<expected> RETURNING` | `grep -n 'currentState, instance.currentState' apps/core/src/kernel/workflow/instances.ts` |
| 10 | `advised_tests` shape | `{serviceId, code, name, pricePaise}[]` — `serviceId` references `tariff.services.id` | `sed -n '25,30p' apps/core/src/modules/opd/consultation.ts` |
| 11 | event-name lint | `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, thrown as `entity.verb_past` | `grep -n 'NAME_RE' packages/contracts/src/envelope.ts` → line 64 |
| 12 | ledger §5 line | **1323** (22c-A's seed says 1132 — stale) | `grep -n '^## 5' docs/superpowers/plans/reports/EXECUTION-LESSONS.md` |

**Row 3 is the row this document is written against.** The envelope is specified for FOUR actor types. If 22c-A has not merged when this phase kicks off, T3's guard is written for four and its `patient` leg is tested against a literal object — the type widens underneath it without a change here. **This phase edits nothing under `kernel/auth/` or `packages/contracts/`.**

---

## 3. Spike — questions written now, answered at kickoff, recorded in §6.3

Answer by reading code and by read-only SQL. None changes the ruling; each sizes a task.

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | Does `resolveEncounter` in `billing/invoices.ts` return `null` or throw for a prefix nobody registered? What does it do for an `encounterId` of `undefined`? | T3 refuses `unknown_encounter` and must match, not duplicate, that behaviour |
| **S2** | Does `workflow_transitions.actor_type` carry any CHECK today, and did 22c-A add one? | T1's `order_item_transitions_actor_type_ck` must list the same four names or it becomes the second copy §2.54 warns about |
| **S3** | How many production `opd_encounters` rows have a non-null `advised_tests`, and what is the distinct `serviceId` count? (read-only SQL) | The demand signal 07d promised Plan 17; also proves whether `services.id` values in it resolve — T5's duplicate window indexes `service_id` |
| **S4** | Are UNK/unconscious registrations (`§11.4` map 8) rows in `patients` today, or a planned ED construct? | If rows, `orders.patient_id NOT NULL` costs nothing (02 §5 A7); if not, the FK is still right and 40 supplies the row |
| **S5** | Does `istDate()` live in the kernel, and what do `opd` and `ot` call to get the service date they hand `nextEpisodeNo`? | T3 must hand the SAME IST day the caller's encounter uses, not re-derive it (series.ts's own warning) |
| **S6** | How many test files construct a `ModuleManifest` literal without spreading a real one? | Rule 7: adding `orderKinds?` is optional and breaks none — but `manifests.test.ts` may pin the field list; grep for the sibling `resourceKinds` across `apps/core/src --include=*.ts` |

---

## 4. Design decisions — DECIDED, each with its reasoning (owner standing rule 2026-08-28)

**DD1 — Kernel envelope; module extension.** §1.2 is the reasoning. What is ENVELOPE and what is EXTENSION is the table in §4.1 and is frozen (§8). Anything not in §4.1 that a module wants is a column on ITS table keyed `order_item_id` — never a column added to the envelope by a module migration.

**DD2 — One order, one kind; a group id joins the act.** `orders.kind` is NOT NULL and every item on an order is that kind. Reasoning: the series letter (`L` vs `R`), the department worklist, the billing branch and the SLA clock are all per-kind; an order mixing them would have no number, no queue and no clock. The consult that orders CBC + chest X-ray writes two orders with one `order_group_id` (a ULID the placing surface mints), so the doctor's sheet and the counter's slip still see one act. This is what a corporate HIS does behind its single screen.

**DD3 — Kinds are OPEN on the manifest seam, refused at boot, refused at placement.** Unlike resource kinds (closed at ten with a CHECK, cross-module ruling 2) the set of order kinds is genuinely open — lab, imaging, medication, blood, diet, nursing, transport, referral will all arrive. So there is **no CHECK on `orders.kind`**; instead `collectOrderKinds(registry)` refuses at boot on a duplicate claim (`duplicate_kind`), on a `seriesKey` outside `EPISODE_SERIES` (`unknown_series`), and on a `placePermission` no manifest declares (`undeclared_permission`, the search precedent); and `placeOrder` refuses a kind no installed manifest claims (`unknown_kind`, the `createResource` A4 precedent). A parity test pins the claimed set — **empty today**. Reasoning: the resources CHECK exists because a status vocabulary is written into history forever; an order kind's vocabulary is the envelope's own four states, identical for every kind, so there is nothing an eleventh kind could corrupt.

**DD4 — The envelope's state machine is four states, closed, in CODE.** `placed → in_progress → completed`, with `cancelled` reachable from `placed` and from `in_progress`. Not a workflow definition, because definitions are DATA, owner-activated per deployment (§10.4) — and an envelope whose terminal states could differ between two hospitals is not an envelope five plans can build against. Reasoning for four and not more: every candidate fifth state is one kind's business. *accessioned*, *scheduled*, *checked_in*, *resulted-unverified*, *dispensed* are stages inside `in_progress` and live in the module's own workflow definitions (`lab_order_item`, `lab_sample`, 02 §14 T3), which project onto the envelope by calling `advanceOrderItem` at their milestones. The `held`/`on_hold` case (consent missing, E1; QC lockout) is likewise inside `in_progress` or before it — an item that cannot start is `placed`.

**DD5 — Cancellation carries its stage and, after start, its reason.** `cancelled_from text` records the state the item left (`placed` or `in_progress`) and `cancel_reason text` is **required when `cancelled_from = 'in_progress'`** — a CHECK, not a guard. This is 02 §5 B6 (*"refuses `cancelled` from `in_analysis` without the reason code"*) lifted to the envelope, and O-4's money consequence (charge stands if analysed) becomes a one-column read for billing.

**DD6 — `ordered_by` is the kernel's actor stamp, four types, and the clinical authority is a separate column.** `ordered_by_type/ordered_by_id` transcribe `workflow_transitions.actor_type/actor_id` and admit all four members structurally. Who may PLACE is a guard in `placeOrder`, and it is decided per type:
- `user` — must hold `orders.place` AND the kind's `placePermission`. `ordering_clinician_id` (a `users.id`) is required when the kind declares `requiresClinician: true`; it may differ from `ordered_by_id` (a nurse keying a consultant's verbal order), and `authority = 'clinician'`.
- `user` with `authority = 'external_prescription'` — walk-in with an outside slip: `external_referrer_id` (a `partners.id`) replaces the clinician; this is 02 §1's *"outside referrer attribution → commission ledger"* hook, stored here and consumed by Plan 09's partners module.
- `patient` — **refused unless the kind declares `selfOrderable: true`** (26's check-up package will; 17 and 18 will not), and **no `hasPermission` lookup is ever performed on a patient id** (22c-A review D11 — it returns false and false aliases). `authority = 'self'`.
- `system` — allowed only with `authority = 'protocol'` and a non-null `protocol_ref` (a reflex rule id, D6; a standing order). The reflex item also carries `parent_item_id`.
- `agent` — **refused, always.** Copilot design law: the LLM narrates and never originates. A T2 drafter proposing an investigation produces an `advised_tests`-class suggestion for a human to place.
Reasoning: an Indian hospital's medico-legal chain needs *the doctor who is responsible* on the order, distinct from *the login that typed it*; conflating them is how a nurse's account ends up as the ordering physician on a CT.

**DD7 — `order_no` comes from the EXISTING counters.** A kind declares `seriesKey: EpisodeSeriesKey`; `placeOrder` calls `nextEpisodeNo(tx, decl.seriesKey, serviceDate)` on the caller's transaction. Lab declares `lab_order` (`L`), radiology `radiology_order` (`R`). **`lab_specimen` (`S`) is not an order number** — it is the lab's extension table's number, and series.ts's own comment is the reason (one order, several tubes, a tube serves several tests). The envelope neither adds a series nor lets a kind mint two.

**DD8 — Encounter by NUMBER, resolved through the registry, and the registry moves to the kernel.** `orders.encounter_no` is the episode number (`V…`, `D…`) — the shape `billing.invoices.encounter_id` already uses, dispatching on the letter through `registerEncounterResolver`. That registry lives in `modules/billing/invoices.ts` today and a kernel seam cannot import a module, so **T3 lifts it to `kernel/episodes/encounter-resolvers.ts`** and billing re-exports the three names unchanged; `opd.module.ts`, `ot.module.ts` and `billing/index.ts` import from the new path (row 5: four lines). The parity test `registeredEncounterPrefixes()` is unchanged. **The envelope does not check encounter STATUS** — whether an order may follow a completed OPD visit or a discharged day-care is the claiming module's guard; the envelope refuses only `unknown_encounter`.

**DD9 — Pharmacy shares the envelope; the prescription is NOT migrated here.** The kind `medication` is **reserved by name in the contract and claimed by nobody**. Plan 16c–f decides whether the OPD prescription becomes an order of that kind; if it does, `P` stays the DISPENSE document's letter (series.ts: `pharmacy_dispense`), and the order takes a new letter by a disclosed kernel edit to `series.ts`. Reasoning: `prescriptions.ts` is live and printing e-Rx today; moving it is 16's decision on 16's evidence, and reserving the name is what stops 16 from inventing a second envelope.

**DD10 — No money on the envelope.** The item carries `service_id` (tariff `services.id`, the same key `advised_tests` carries) and nothing else money-shaped — no price, no payer, no interlock flag. The lab posts its charge at accession, radiology at acquisition (01 §1: `charge.posted` from `study.acquired`), each in its own plan; the payer comes from the encounter resolver (`intendedPayer`), as it does for invoices today. The report-blocked-until-paid interlock (02 O-1) is a PUBLISH gate inside the module. Reasoning: 14 and 15 both had their CRITICAL in money summed from the wrong place; a price copied onto an order is a second place.

**DD11 — `restricted` is envelope; WHO may read a restricted item is not.** `order_items.restricted boolean NOT NULL DEFAULT false` — HIV/NACO (E1), PCPNDT-class USG, exposure-protocol source testing (E5). The kernel reader `listOrdersForPatient` **omits restricted items unless the caller is `ordering_clinician_id` or holds `orders.read.restricted`**; the module decides what else its own extension exposes. Sealed/VIP patients need nothing here — that is patient-level (E-4) and the reader calls the patients library's existing alias path exactly as the desk does.

**DD12 — Immutability is a trigger, not a convention.** `order_item_transitions` is append-only under the `0043` trigger pattern. `orders.order_no`, `.kind`, `.patient_id`, `.encounter_no`, `.ordered_by_*` never change after insert — enforced by the same trigger shape on UPDATE of those columns. A patient merge (02 A4) re-links by writing the survivor to `patient_id` **through the merge path only** — T1's trigger permits that one column when `current_setting('hmis.merge', true) = 'on'`, which is the mechanism the executor must confirm the patients merge already uses (S4 sibling: `grep -rn "set_config\|current_setting" apps/core/src --include=*.ts`); if merge uses no GUC today, `patient_id` is left mutable and the close says so.

### 4.1 The envelope — ENVELOPE columns vs module EXTENSION, frozen

**`orders`** (one per kind per act)

| column | type | note |
|---|---|---|
| `id` | text PK | ULID |
| `order_no` | text UNIQUE | from `nextEpisodeNo(seriesKey, service_date)` |
| `order_group_id` | text NOT NULL | ULID minted by the placing surface; joins the kinds of one act |
| `kind` | text NOT NULL | claimed on a manifest; no CHECK (DD3) |
| `patient_id` | text NOT NULL FK `patients.id` | |
| `encounter_no` | text NOT NULL | resolved through the prefix registry (DD8) |
| `service_date` | date NOT NULL | IST day of the series (S5) |
| `priority` | text NOT NULL | `routine \| urgent \| stat` — CHECK |
| `authority` | text NOT NULL | `clinician \| external_prescription \| self \| protocol` — CHECK |
| `ordered_by_type`, `ordered_by_id` | text NOT NULL | CHECK on the four actor names (S2) |
| `ordering_clinician_id` | text | `users.id`; required per kind decl |
| `external_referrer_id` | text | `partners.id`; iff `authority='external_prescription'` — CHECK |
| `protocol_ref` | text | iff `authority='protocol'` — CHECK |
| `indication` | text | clinical justification; required per kind decl (radiation justification, 18a) |
| `status` | text NOT NULL | `open \| closed \| cancelled` — derived from items, stored, CAS |
| `placed_at` | timestamptz NOT NULL | the clinical instant (may precede `created_at` on paper backfill; the delta is the module's `late_entry.flagged`) |
| `created_at`, `closed_at` | timestamptz | |

**`order_items`** (one per test / study / drug line)

| column | type | note |
|---|---|---|
| `id` | text PK | |
| `order_id` | text NOT NULL FK | |
| `service_id` | text NOT NULL FK `services.id` | the only tariff link (DD10) |
| `status` | text NOT NULL | `placed \| in_progress \| completed \| cancelled` — CHECK (DD4) |
| `origin` | text NOT NULL | `direct \| addon \| reflex \| duplicate_confirmed` — CHECK |
| `parent_item_id` | text | reflex/add-on parent |
| `duplicate_of_item_id`, `duplicate_reason` | text | D11: set together — CHECK |
| `restricted` | boolean NOT NULL DEFAULT false | DD11 |
| `cancelled_from`, `cancel_reason` | text | DD5 CHECK: `cancelled_from='in_progress' ⇒ cancel_reason IS NOT NULL` |
| `started_at`, `completed_at`, `cancelled_at` | timestamptz | stamped by `advanceOrderItem` |
| `created_at` | timestamptz NOT NULL | |

**`order_item_transitions`** — `id, item_id, from_status, to_status, actor_type, actor_id, note, at` — immutable (DD12).

**Indexes:** `(patient_id, placed_at)`, `(encounter_no)`, `(kind, status)`, `(order_group_id)`, and on items `(service_id, created_at)` with `order_id` for the duplicate window (T5), `(order_id)`.

**EXTENSION — the module's, keyed `order_item_id`, never on these tables:** specimens and their `S` numbers, accession scans, sample rejection/re-collection, analyzer worklists, results, verification, reference ranges, reports and amendments, publish interlock, collection site (`home`, 24a), study scheduling and device resources, safety gates and screenings, Form F links, contrast, dispense lines and batches, payer branch flags, TAT clocks and SLAs.

### 4.2 Events — `entity.verb_past` (row 11), subscriber named per 00 §5

| event | payload | subscriber named |
|---|---|---|
| `order.placed` | `{orderId, orderNo, kind, patientId, encounterNo, groupId, itemIds[]}` | the manifest that claims `kind` — 17 T2 (collection queue), 18a (worklist); 24a filters `kind='lab'` for home collection |
| `order_item.started` / `.completed` / `.cancelled` | `{itemId, orderId, kind, serviceId, from, to, cancelledFrom?, reason?}` | 26 (package progress), 22c-F (reports-ready projection), 24a (M9: a cancelled item quarantines a tube at the door) |
| `order.closed` / `order.cancelled` | `{orderId, kind}` | 22c-F |

Until a manifest claims a kind no order can be placed and none of these fires; the parity test in T6 proves the catalogue names exist.

---

## 4A. ROUTED TO THE OWNER — provisional, and named

**None blocks a task.** Two items are recorded because a later plan will meet them:
- **02 O-4** (charge after cancellation post-analysis) — the envelope makes it a one-column read (DD5); the money rule itself is 17's.
- **DD9's letter for a medication order** if 16 migrates the prescription — a kernel edit 16 must disclose; not this phase's.

---

## 5. Tasks

Six. Four CRITICAL. Each CRITICAL task carries an inline Assertion Book whose mutants are **built and executed** (AGENT-RULES §3).

### T1 — Migration `0044`: the three tables, their CHECKs, the transitions trigger — **ROUTINE**

**Files:** `apps/core/src/kernel/db/schema/orders.ts` (new), `apps/core/src/kernel/db/schema/index.ts` (export), `apps/core/drizzle/0044_order_envelope.sql` (generated, then hand-carried for the CHECKs and trigger as `0043` was), `apps/core/drizzle/meta/*` (generated only — never hand-edited, §6), `apps/core/src/kernel/db/schema/orders.test.ts` (new), plus the test helper's `truncateAll` list (**grep the sibling**: `grep -rn 'patientIdentityVersions' apps/core/src --include=*.ts` names every census the new tables must join — 07c found `user_day_facts` missing from exactly this list).

Every CHECK in §4.1; the actor-type CHECK spelled from S2's answer; the immutability trigger on `order_item_transitions` (UPDATE/DELETE) and on the frozen `orders` columns (DD12). Purely additive. Tests: each CHECK refused by Postgres and the refusal read (the 07c pattern — ask for the second row, read the error), the trigger refused on UPDATE and on DELETE.

### T2 — `kernel/orders/kinds.ts`: `OrderKindDecl`, the manifest field, the boot collector — **CRITICAL**

**Files:** `apps/core/src/kernel/orders/kinds.ts` (new), `apps/core/src/kernel/orders/errors.ts` (new, `OrderError` on the `ResourceError` shape), `apps/core/src/kernel/modules/manifest.ts` (adds `orderKinds?: readonly OrderKindDecl[]` — the fourth optional field, same comment discipline), `apps/core/src/kernel/orders/kinds.test.ts` (new).

```ts
export type OrderKindDecl = {
  kind: string;                       // 'lab' | 'imaging' | 'medication' | … — open (DD3)
  seriesKey: EpisodeSeriesKey;        // 'lab_order' | 'radiology_order' — must exist in EPISODE_SERIES
  placePermission: string;            // e.g. 'lab.orders.place' — must be declared by some manifest
  requiresClinician: boolean;         // DD6
  requiresIndication: boolean;        // DD6 / 18a
  selfOrderable: boolean;             // DD6 — patient actors
};
```

`collectOrderKinds(registry)` transcribes `collectResourceKinds` and `collectProviders`: `readonly` field for the identity reason `resourceKinds` gives; three boot refusals (DD3). It is called from wherever `collectResourceKinds` is called at boot (grep the sibling), so a bad declaration stops the API before the first order.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | Two manifests claiming `lab` throw `duplicate_kind` at collection | Drop the `seen` check → both collected, `placeOrder` mints from whichever it finds |
| A2 | A `seriesKey` not in `EPISODE_SERIES` throws `unknown_series` | Skip the check → `nextEpisodeNo` throws at the first placement, in a transaction, at 09:00 |
| A3 | A `placePermission` no manifest declares throws `undeclared_permission` | Skip → a kind nobody can ever place, silently |
| A4 | A registry with no `orderKinds` collects `[]` and boots | Make the field required → every existing manifest fails typecheck (this is the mutant that proves the field is optional) |

### T3 — `placeOrder`, the actor rules, the encounter registry lifted to the kernel — **CRITICAL**

**Files:** `apps/core/src/kernel/orders/place.ts` (new), `apps/core/src/kernel/episodes/encounter-resolvers.ts` (new — `EncounterResolver`, `registerEncounterResolver`, `registeredEncounterPrefixes`, `resolveEncounter` moved verbatim from `billing/invoices.ts:312-340` (`EncounterResolver` 312, `registerEncounterResolver` 320, `registeredEncounterPrefixes` 328, `resolveEncounter` 332)), `apps/core/src/modules/billing/invoices.ts` (import from the kernel; behaviour unchanged), `apps/core/src/modules/billing/index.ts` (re-export the same names so no third importer breaks), `apps/core/src/modules/opd/opd.module.ts` and `apps/core/src/modules/ot/ot.module.ts` (import path only), `apps/core/src/kernel/orders/place.test.ts` (new).

`placeOrder(tx, registry, decls, actor, input)`: kind claimed (`unknown_kind`) → actor leg per DD6 → encounter resolved (`unknown_encounter`; the resolver's `patientId` must equal `input.patientId`, else `patient_encounter_mismatch`) → `order_no` from `nextEpisodeNo(decl.seriesKey, input.serviceDate)` → header + items in one transaction → `order.placed` appended through the existing outbox on the same `tx`. `serviceDate` is an INPUT the caller resolved with `istDate` (S5), never derived here.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A1 | An `agent` actor is refused (`agent_cannot_order`) | Allow it → a drafter originates a CT |
| A2 | A `patient` actor is refused for a kind with `selfOrderable:false`, and **no `hasPermission` call is made with its id** (spy) | Fall through to the `user` leg → `hasPermission(patientCredentialId)` returns false and the refusal reason is wrong; or worse, the leg is skipped and the order lands |
| A3 | A `system` actor without `protocol_ref` is refused | Drop the check → reflex rules become anonymous |
| A4 | `requiresClinician:true` with a null `ordering_clinician_id` is refused | Drop → a nurse's login is the responsible physician on an X-ray |
| A5 | A `user` holding `orders.place` but NOT the kind's `placePermission` is refused | Check only the kernel permission → a pharmacist places imaging |
| A6 | The header's `order_no` carries the kind's letter and the caller's service date (`L260829…`) | Mint from `visit` → an order numbered `V…` is resolved as an OPD encounter by billing |
| A7 | Two concurrent placements of the same kind on one day get distinct numbers | Read-then-write instead of `nextEpisodeNo` → duplicate `order_no`, UNIQUE violation at the second commit |
| A8 | `registeredEncounterPrefixes()` returns `["D","V"]` before and after the move | (no mutant — parity; the assertion is the existing billing test still passing from the new path) |
| A9 | Encounter resolves to a different patient than `input.patientId` → refused | Drop → a tube labelled for the wrong person, which is 02 A1 with the envelope's help |

### T4 — `advanceOrderItem`: the four-state CAS machine, cancellation, header close — **CRITICAL**

**Files:** `apps/core/src/kernel/orders/advance.ts` (new), `apps/core/src/kernel/orders/transitions.ts` (new — the closed transition table as data-in-code, exported for the parity test), `apps/core/src/kernel/orders/advance.test.ts` (new).

`advanceOrderItem(tx, actor, itemId, to, opts)`: the transition table admits exactly `placed→in_progress`, `in_progress→completed`, `placed→cancelled`, `in_progress→cancelled` (with `reason`). The UPDATE is compare-and-set on `(id, status=from)` returning the row; zero rows → `stale_state`, and the caller retries or reports — never re-reads and overwrites. One transitions row per success. The header closes (`open→closed`) when the last non-cancelled item completes, `open→cancelled` when every item is cancelled, both by CAS on the header. `system` and `user` actors may advance; `patient` may `cancelled` from `placed` only on a `selfOrderable` kind (26's package cancellation) and nothing else; `agent` never.

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A1 | `completed → in_progress` is refused (`illegal_transition`) | Add it to the table → a published result's item reopens |
| A2 | `in_progress → cancelled` without `reason` is refused BY THE CHECK even if the guard is bypassed | Remove the guard only → Postgres refuses; remove the CHECK only → the guard refuses. Both halves must die separately |
| A3 | Two concurrent `advance` calls from `placed` (start vs cancel) — exactly one wins, the other gets `stale_state` | Replace CAS with read-then-UPDATE → both succeed, item `cancelled` with a `started_at`, analyzer runs a cancelled tube (02 B6) |
| A4 | The header closes only when the LAST live item completes; a cancelled sibling does not block close | Count all items instead of live ones → an order with one cancelled add-on never closes |
| A5 | Every success writes exactly one transitions row with the caller's `actor_type` | Skip the row → no audit; write two → the immutability story lies |
| A6 | A `patient` actor cannot advance to `in_progress` or `completed` | Allow → a patient marks their own test done |

### T5 — The kernel `ordersManifest`, the readers, the duplicate window — **CRITICAL**

**Files:** `apps/core/src/kernel/orders/manifest.ts` (new — `key:'orders'`, `permissions: ['orders.place','orders.read','orders.cancel','orders.read.restricted']`, no menu, no subscriptions), `apps/core/src/kernel/modules/manifests.ts` (append; the ORDER paragraph applies), `apps/core/src/kernel/orders/read.ts` (new — `listOrdersForPatient`, `listOrdersForEncounter`, `findRecentItems(patientId, serviceId, windowHours)`), `apps/core/src/kernel/orders/read.test.ts` (new), and every census rule 7 finds: `grep -rn 'formularyManifest' apps/core/src --include=*.ts` — **directory and glob, not a file list** (§9.9 rule 7 as amended).

`findRecentItems` is the cross-kind half of 02 D11 (a CT ordered by two doctors is the same defect as a troponin ordered twice); the per-test window is the module's config, the query is the kernel's. `listOrdersForPatient` implements DD11 and calls the patients library's alias path for sealed patients exactly as `DeskProviderCtx` does (07c: the SUPERVISOR's clearance, not the row's).

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A1 | A restricted item is omitted for a caller who is neither the ordering clinician nor a holder of `orders.read.restricted` | Drop the filter → an HIV order is in every "pending investigations" list on the ward |
| A2 | The ordering clinician sees their own restricted item without the permission | Require the permission for everyone → the doctor who ordered it cannot see it, and the clinic routes around the flag |
| A3 | `findRecentItems` returns items across kinds and excludes `cancelled` ones | Include cancelled → a cancelled duplicate blocks a clinically-required repeat |
| A4 | `ALL_MANIFESTS` census tests move by exactly one, and `registry.allPermissions()` contains the four | (no mutant — a count assertion; name the census file the sibling-grep found) |
| A5 | A sealed patient's orders list renders through the alias path for a caller without `confidential.read` | Read `patients.name` directly → the mutant prints a sealed patient's real name (07c's exact finding) |

### T6 — The end-to-end proof with a FAKE manifest, the parity pins, the CONTRACT — **ROUTINE**

**Files:** `apps/core/src/kernel/orders/envelope.e2e.test.ts` (new — a test-only manifest claiming `kind:'lab', seriesKey:'lab_order', placePermission:'lab.orders.place'`, installed into a test registry: place → start → complete → header closed, with the three events read back from the outbox), `apps/core/src/kernel/orders/parity.test.ts` (new — pins: claimed kinds in `ALL_MANIFESTS` = `[]`; transition table = the four edges; the event names pass `NAME_RE`), `docs/superpowers/plans/2026-08-29-phase1-17-order-envelope.md` (§6 filled at close).

No fail-first is owed and the report says so. The finding worth more than a mutant here: any assertion in T1–T5 that could not discriminate — record it.

---

## 6. THE CONTRACT — what 17, 18a, 24a, 26 and 22c-F inherit for free

A downstream plan may write its phase doc against these sentences without reading this phase's code.

1. **To become an ordering department, a module adds ONE field to its manifest** — `orderKinds: [{ kind, seriesKey, placePermission, requiresClinician, requiresIndication, selfOrderable }]` — and declares `placePermission` in its own `permissions`. It edits no kernel file. Boot refuses a bad declaration with a sentence.
2. **To place an order it calls `placeOrder`** with a four-type actor and receives an `orders` row numbered from its declared series, with `order_item` rows carrying `service_id`. It subscribes to `order.placed` to start its own pipeline.
3. **Its pipeline is its own workflow definitions** over its own extension tables keyed `order_item_id`. At its milestones it calls `advanceOrderItem(… 'in_progress' | 'completed' | 'cancelled')`; the envelope emits `order_item.*` and closes the header itself. It never writes `order_items.status` directly — the immutability of the transitions log and the CAS both depend on that.
4. **It posts money itself**, at the stage its plan rules, using `service_id` and the encounter resolver's `intendedPayer`. The envelope holds no price.
5. **Cross-kind reads are the kernel's:** `listOrdersForPatient`, `listOrdersForEncounter`, `findRecentItems`. A module never UNIONs another module's tables to answer "what is pending for this patient".
6. **`restricted` is set at placement by the placing surface or by the module's own rule** (HIV test code → restricted); the kernel reader honours it; the module's extension may be stricter.
7. **Specimens, studies, dispenses number themselves** from their own series (`S`, and whatever 18a/16 rule) on their own tables; `order_no` is never overloaded to name a tube.
8. Specifically: **Plan 17 T2** claims `lab` / `lab_order` / `lab.orders.place`, `requiresClinician:true` (external_prescription for walk-ins), `selfOrderable:false`; converts `advised_tests` into orders at the counter; hangs `lab_specimens` and `lab_results` off `order_item_id`. **Plan 18a** claims `imaging` / `radiology_order` / `radiology.orders.place`, `requiresIndication:true`; hangs studies, schedule, gates, Form F links off `order_item_id`; consumes `order.placed{kind:'imaging'}`. **Plan 24a** subscribes to `order.placed{kind:'lab'}` and `order_item.cancelled` (M9 quarantine) and adds `collection_site` on the lab's extension, not on the envelope. **Plan 26** claims `package` with `selfOrderable:true` and composes an `order_group_id` of lab + imaging orders per package. **Plan 22c-F** reads `listOrdersForPatient` as a patient actor and shows `completed` items whose module has published.

---

## 7. Edge-case pass — done before finalising (owner standing rule)

| # | case | ruled |
|---|---|---|
| E1 | Doctor orders CBC + LFT + chest X-ray in one click | two orders (`L`, `R`), one `order_group_id` (DD2) |
| E2 | Add-on three days later on a closed order (02 B4) | a CLOSED order is closed; the add-on is a NEW order in the same group with `origin:'addon'` and `parent_item_id` pointing across orders. Reopening would break "closed means every item terminal" for every subscriber |
| E3 | Add-on while the order is open (02 D1) | new item on the same order, `origin:'addon'`; the header stays open; interlock per item is the module's |
| E4 | Reflex (02 D6) | `system` actor, `authority:'protocol'`, `protocol_ref`, `parent_item_id`, `origin:'reflex'` |
| E5 | Cancellation races the analyzer start (02 B6) | CAS decides; the loser gets `stale_state`; a cancel that wins from `in_progress` needs a reason (DD5) |
| E6 | Same test, two doctors, same day (02 D11) | `findRecentItems` warns; proceeding stores `duplicate_of_item_id` + reason, `origin:'duplicate_confirmed'`; billing's "post once" rule reads it |
| E7 | Unknown/unconscious patient (02 A7) | `patient_id` is the UNK row (S4); merge later re-links (DD12) |
| E8 | Patient merge after orders exist (02 A4) | `patient_id` moves through the merge path only; `order_no` never changes; printed labels keep the original |
| E9 | Walk-in with an outside slip | `authority:'external_prescription'`, `external_referrer_id`; encounter is 17's `lab_walkin` visit (`V…`) — the envelope needs no new prefix |
| E10 | Day-care specimen from the theatre (15 F17) | order on the `D…` encounter; the tube's `S` number is the lab's extension — unchanged |
| E11 | Patient books a check-up package from the app (26 / 22c) | `patient` actor, `authority:'self'`, `selfOrderable:true` on `package`; no permission lookup on the patient id; the package composes lab/imaging orders as `system`/`protocol` with `protocol_ref = package id` |
| E12 | An agent drafter "suggests" a test | refused at `placeOrder`; the suggestion is `advised_tests`-class data |
| E13 | Paper orders during downtime, backfilled at 14:00 | `placed_at` = the paper time, `created_at` = now; the module flags `late_entry` from the delta; `service_date` = the paper day, so the number sits in that day's series |
| E14 | 23:58 IST placement | caller passes `istDate(now)`; the envelope never re-derives (S5) |
| E15 | 10,000th lab order in a day | `formatEpisodeNo` throws by design; 02 L1 sizes 900/day at 2,000 OPD; not this phase's problem and not silently padded |
| E16 | HIV test on a ward patient (02 E1) | `restricted:true`; the ward's pending list omits it; the ordering clinician sees it; consent gating is the lab's extension |
| E17 | Sealed/VIP patient | patient-level alias path in the reader (T5 A5); nothing on the envelope |
| E18 | Module declares `medication` before 16 rules it | boot accepts (open set) — the CONTRACT reserves the name and 16's doc must be the one to claim it; the parity test's claimed list is where a reviewer sees it |
| E19 | Encounter resolves to another patient | `patient_encounter_mismatch` (T3 A9) |
| E20 | Cancel an order whose items are all `completed` | header is already `closed`; `cancelled` from `closed` is not an edge — refused |
| E21 | Two manifests both want `lab` (17 and 17-M) | `duplicate_kind` at boot; 17-M is a sub-plan of 17's module and extends 17's tables, it does not claim a kind |
| E22 | Result arrives for a test never ordered (02 M3) | the lab's `unsolicited` construct; nothing on the envelope, by design — the envelope says nothing about results |

---

## 8. What this phase FREEZES for downstream lanes

1. The three table names and every ENVELOPE column in §4.1, their CHECKs, and the rule that a module extension is keyed `order_item_id` and never adds a column to them.
2. The four item states and four transitions, in code; `cancelled_from` + `cancel_reason` semantics.
3. `OrderKindDecl`'s six fields and the three boot refusals; kinds open, claimed once, refused unclaimed at placement.
4. The actor rules of DD6 — `agent` never; `patient` only on `selfOrderable`, never permission-looked-up; `system` only with `protocol_ref`; `user` needs both permissions; `ordering_clinician_id` is the responsible clinician.
5. `order_no` from `nextEpisodeNo` on the declared `EpisodeSeriesKey`; `L` for `lab`, `R` for `imaging`; `S` and `P` are NOT order numbers; no new series in this phase.
6. One order, one kind; `order_group_id` joins an act.
7. `encounter_no` by episode number through the prefix registry, which now lives in `kernel/episodes/encounter-resolvers.ts`; billing's three exported names are unchanged.
8. No money on the envelope; `service_id` is the only tariff link.
9. `restricted` on the item; the kernel reader's rule (ordering clinician or `orders.read.restricted`).
10. The event names in §4.2 and their payload keys.
11. The four kernel permissions: `orders.place`, `orders.read`, `orders.cancel`, `orders.read.restricted` — granted to NO role by the migration (22c-A DD7's discipline; the grants are runbook acts).
12. The kind name `medication` is reserved for Plan 16 and claimed by nobody; `package` is reserved for Plan 26.

---

## 9. CLOSE — filled at execution

### 9.1 The commits
### 9.2 Findings
### 9.3 The spike answers (S1–S6)
### 9.4 The Assertion Book, corrected by execution
### 9.5 Mechanical verification
### 9.6 The independent close review
