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
| 3 | `Actor` union | **four** members — `user \| agent \| system \| patient` — **MERGED AND COMMITTED** (`bec9aa7`, carried through `b13d74c`); `git diff --stat` on the file is empty at kickoff. *(Corrected 2026-08-29 at kickoff: the write-time value said "uncommitted in the working tree; `main` still has three".)* | `grep -n 'export type Actor' packages/contracts/src/envelope.ts`; `git diff --stat packages/contracts/src/envelope.ts` |
| 4 | episode series keys | `visit appointment lab_order lab_specimen radiology_order pharmacy_dispense grn daycare` — 8; `L S R P` reserved and unused | `grep -n '^  [a-z_]*: "' apps/core/src/kernel/episodes/series.ts`; `grep -rln '"lab_order"\|"radiology_order"' apps/core/src --include=*.ts \| grep -v test` → `series.ts` only |
| 5 | encounter-resolver registry location and registrants | `modules/billing/invoices.ts:320`; registrants `opd.module.ts` (`V`), `ot.module.ts` (`D`); `billing/index.ts` re-exports | `grep -rn 'registerEncounterResolver' apps/core/src --include=*.ts \| grep -v '\.test\.'` → 4 lines |
| 6 | manifests installed | **16** `Manifest,` lines in `ALL_MANIFESTS` (`manifests.ts:56`), last appended `formularyManifest` | `grep -c 'Manifest,$' apps/core/src/kernel/modules/manifests.ts` → 16 |
| 7 | the manifest seam's optional fields | `search?`, `resourceKinds?`, `desk?` — three precedents, one shape | `grep -n '?:' apps/core/src/kernel/modules/manifest.ts` |
| 8 | immutability-trigger precedent | `0043_patient_identity_spine.sql:79-81` (`patient_identity_forbid_mutation`) | `grep -n 'CREATE TRIGGER' apps/core/drizzle/0043_patient_identity_spine.sql` |
| 9 | compare-and-set precedent | `kernel/workflow/instances.ts:136-150` — `UPDATE … WHERE status='active' AND current_state=<expected> RETURNING` | `grep -n 'currentState, instance.currentState' apps/core/src/kernel/workflow/instances.ts` |
| 10 | `advised_tests` shape | `{serviceId, code, name, pricePaise}[]` — `serviceId` references `tariff.services.id` | `sed -n '25,30p' apps/core/src/modules/opd/consultation.ts` |
| 11 | event-name lint | `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, thrown as `entity.verb_past` | `grep -n 'NAME_RE' packages/contracts/src/envelope.ts` → line 64 |
| 12 | ledger §5 line | **1323** (22c-A's seed says 1132 — stale) | `grep -n '^## 5' docs/superpowers/plans/reports/EXECUTION-LESSONS.md` |

**Row 3 is the row this document is written against.** The envelope is specified for FOUR actor types. **22c-A HAS merged**, so T3's guard is written and tested against the real four-member union rather than a literal object, and the contingency this paragraph carried is discharged. **This phase edits nothing under `kernel/auth/` or `packages/contracts/`.**

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
### 6A. WHAT THE ENVELOPE DOES NOT DO FOR YOU — added at close, from the independent review

Six of the reviewer's findings are not defects in what shipped; they are things a downstream plan will assume and must not. They are stated here rather than left to be discovered, because §6 is the section a plan reads instead of this phase's code.

1. **THE WORKER HAS NO ENCOUNTER RESOLVER, so `placeOrder` cannot resolve ANY encounter there.** `resolveEncounterByPrefix` reads a process-local map filled only by `OpdModule.onModuleInit` and `OtModule.onModuleInit`, and `worker.module.ts` has no `imports:` at all — it installs manifests, not Nest modules. **Plan 17's reflex rule and every standing order is a `system` actor running in the worker (DD6/E4), and today it would get `unknown_encounter` for a visit that exists.** Billing never hit this because its private wrapper falls back to OPD's reader; F1 deliberately did not give the kernel that fallback, and the decision stands. **The plan that first places an order from the worker owes the registration** — either the worker imports the modules that register `V` and `D`, or the resolver map is seeded some other way. It is a precondition, not a bug to file.
2. **`placeOrder` has NO idempotency check of any kind.** No key, no natural-key lookup, no participation in `idempotency_keys`. A retried request mints a second `order_no`, a second set of items and a second `order.placed`, and Plan 17 posts the lab charge at accession — so the patient is billed twice and two tubes are drawn. **Idempotency belongs to the ROUTE**, and this phase mounts none. The plan that adds the route owes it.
3. **`findRecentItems` matches `service_id` EXACTLY, so it does not catch a duplicate inside a profile.** "Fever Profile" containing CBC, then a standalone CBC, are two different `service_id` values and the window sees neither from the other. Packages and profiles are the normal Indian corporate-hospital shape and **Plan 26's whole subject is packages** — the composition model that would fix it is 17-M's, not the kernel's.
4. **It also matches `patient_id` exactly, so it does not see across a pre-merge duplicate registration** (E7's UNK row, E8's merge). It reads a patient ROW, not a person.
5. **E3 — an add-on on an OPEN order — has NO KERNEL API.** `placeOrder` creates a header; there is no `addOrderItem`. The first module to implement E3 would `INSERT INTO order_items` directly, which is the one write into these tables with no CAS, no trigger and no guard over it — and if the header closed first, the order is `closed` carrying a live item that `closeHeaderIfDone`'s `status='open'` CAS can never re-close. **§6.1's "adds ONE manifest field" does not cover E3.** The plan that needs it should ask for the kernel function rather than write the insert.
6. **THE READERS REFUSE A `patient` ACTOR, and 22c-F owes the function that changes it.** `listOrdersForPatient` and `listOrdersForEncounter` take `patientId` as a free parameter, which is right for a staff `user` (`orders.read` is hospital-wide and a ward clerk legitimately reads other people's records) and was a disclosure of the whole clinical record for a phone credential. **The kernel cannot fix it yet:** `envelope.ts` rules that a patient actor's `id` is the `patient_credentials` row — the verified phone, never a patient, so one phone can hold three household profiles — and that table does not exist until 22c-B. A reader that cannot verify its subject must not serve a subject-scoped actor, so it refuses with `actor_cannot_read`. **What 22c-F owes is one kernel function that resolves a credential to its own patient set**, with its own test; the refusal is here so the gap is loud rather than silent, and so Plan 26's package-cancellation flow is designed against a known precondition instead of a working-looking read.

7. **THE LOCK ORDER IS `order_items` → `orders`, AND NOTHING ENFORCES IT.** `advanceOrderItem` takes the item's row lock (the compare-and-set) and then, on a terminal move only, `select id from orders … for update`. Every writer must acquire them in that order. **The writer this document itself predicts breaks it:** an `INSERT INTO order_items` (E3's add-on, item 5 above) takes FOR KEY SHARE on the parent `orders` row, which conflicts with FOR UPDATE — the interaction `billing/allocations.test.ts` already documents — so a transaction that inserts an add-on and then advances an item can deadlock against a concurrent close. The kernel `addOrderItem` function item 5 asks for is also the fix for this: one writer, one order.

8. **The readers do NOT record PHI access.** This repository logs at the READER, not the controller (`opd/history.ts`, `opd/vitals.ts`, `opd/prescriptions.ts` all call `recordPhiAccess`). `listOrdersForPatient` returns a patient's investigation list and display name and logs nothing. Every plan consuming these readers would otherwise have to remember independently; **the honest fix is one `recordPhiAccess` call inside `read.ts`, and it is left to the plan that mounts the first route** because the audit row wants a `purpose` this phase has no caller to supply.

**And two properties both reviews CONFIRMED by execution, worth having in writing because a downstream plan will wonder:** the item compare-and-set is a faithful transcription of `workflow/instances.ts:136-150` and is measured, not predicted (12 rounds, one winner every time); and no write path anywhere in `apps/core` reaches these three tables outside `kernel/orders` — grep over `src` and `scripts` returns only `place.ts`, `advance.ts` and the schema suite.

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

### 9.0 Kickoff — the pre-flight, and §2 re-measured

**Parallel-session pre-flight** (`reports/2026-08-26-parallel-session-protocol.md` §2), run 2026-08-29 before the first change:

- `ps -eo pid,etimes,cmd | grep -E "jest|vitest|deploy\.sh"` — **nothing running.**
- `git status --short` — **seventeen files uncommitted, none of them this phase's**: `modules/patients/*` (6), `modules/opd/prescriptions.ts`, and ten under `apps/web/src`. That is the patient self-service lane (22c-B) mid-work. They are not this phase's to stage, revert or clean, and this phase touches none of those paths. `.ci-watch.log` is untracked scratch.
- `git log --oneline -3 && git status -sb` — `5717abd`, **`main` ahead of `origin/main` by 1** (the execute prompt commit).
- `ls apps/core/drizzle | tail -3` — `0041`, `0042`, `0043`. **`0044` is free** and is the number this phase writes.

**§2 re-measured, every row, with its own command.** Eleven of twelve hold at their written value. **Row 3 moved and is corrected in place**: the four-member `Actor` union is now COMMITTED (`bec9aa7`, carried through `b13d74c`) rather than uncommitted in the working tree, so the contingency §2's closing paragraph carried is discharged. Row 1 = 44 entries, last `0043_patient_identity_spine`. Row 12's ledger §5 line is still 1323. This document measures 47,312 bytes at kickoff against the 47,155 the context table predicted.

### 9.3 The spike answers (S1–S6), answered at kickoff, before T1

**S1 — `resolveEncounter`'s three behaviours, and the plan defect the reading found.**

Measured at `modules/billing/invoices.ts:332-362`:
- `encounterId === undefined` → returns `{ intendedPayer: "self", patientId: null }`. **It does not throw.**
- A registered prefix matches and its resolver returns `null` → throws `BillingError("unknown_encounter")`.
- **No** registered prefix matches → falls through to `getEncounter(db, encounterId)`, OPD's reader over `opd_encounters`, and throws `unknown_encounter` only if THAT misses. The fallback is deliberate and its header says so: every shipped caller passes a bare `opd_encounters` id.

**THE DEFECT, and T3's minimal correction.** `resolveEncounter` is **not exported** from billing, and it **imports `getEncounter` from `../opd`** (`invoices.ts:13`). Moving it verbatim into `kernel/episodes/encounter-resolvers.ts` would give the kernel a dependency on `modules/opd` — and would defeat the exact dependency inversion the registry exists to provide (billing imports nothing from either module; the modules register themselves). So T3 moves **the registry and the longest-prefix-first matching loop** — `EncounterResolver`, `registerEncounterResolver`, `registeredEncounterPrefixes`, and a new `resolveEncounterByPrefix` carrying the loop verbatim — and billing keeps its own private `resolveEncounter` wrapper holding the `undefined` case and the OPD fallback. **§8 item 7 is honoured exactly as written: billing's three EXPORTED names are unchanged**, and the existing billing tests are the parity proof (T3 A8).

`placeOrder` calls `resolveEncounterByPrefix` and refuses `unknown_encounter` when no prefix matched **or** the resolver returned null. It deliberately does NOT inherit billing's OPD-id fallback: DD8 says the envelope stores an episode NUMBER, and a bare `opd_encounters` id is not one.

**S2 — there is no `actor_type` CHECK anywhere in this repository, and 22c-A added none.**

`grep -rn "actor_type" apps/core/drizzle/*.sql` finds four columns (`events` 0000/0016, `workflow_transitions` 0004, `phi_access_log` 0038) and `grep -rn "actor_type_ck|actor_type IN"` over `drizzle/` and `kernel/db/schema/` returns **nothing**. So the envelope's CHECK is the FIRST SQL copy of the `Actor` union, not the second — which removes the §2.54 mismatch risk the question was asked about and replaces it with a different one: a copy with nothing to reconcile it against.

**Ruled:** write the CHECK (§4.1 requires it and §8 freezes it), and **pay for the copy with a type-level exhaustiveness pin in the same file** — a `Record<Actor["type"], true>` beside the constant, so a FIFTH union member fails `pnpm typecheck` at the schema rather than at the first insert. That is §2.54's own prescription: if it must be written twice, make something fail when the copies diverge.

**S3 — the demand signal 07d promised Plan 17 is EMPTY today.** Read-only against `hmis-prod-db-1`: `opd_encounters` holds **11 rows, 0** with a non-empty `advised_tests`, and **0** distinct `serviceId` values inside them. That is not a defect — `advised_tests` (migration `0042`) reached production on 2026-08-29 and no consult has used it yet. Consequence for this phase: there is no live data from which to prove `services.id` resolution, so T5's duplicate-window index is sized from the query shape (`(order_id, service_id, created_at)`) rather than from traffic, and Plan 17 T2's conversion of `advised_tests` will convert nothing on the day it lands.

**S4 — UNK/unconscious registration is a PLANNED construct, not rows.** Production holds **24 patients**, none matching `unknown%`/`unk%`, and `grep -rn "unconscious|unknown_patient|isUnknown" apps/core/src` finds only `qr.ts`'s QR-verification failure reason, which is a different thing entirely. So `orders.patient_id NOT NULL` with its FK stands unchanged and costs nothing today; Plan 40 (ED) supplies the UNK row that E7 hangs on.

**S5 — `istDate()` is a MODULE function, which settles T3 by construction.** It lives at `modules/opd/time.ts:11`. The kernel cannot call it without importing OPD. Every one of the six `nextEpisodeNo` call sites already passes an ALREADY-RESOLVED `serviceDate` (`materials/grn.ts:210`, `ot/specimens.ts:53`, `ot/booking.ts:257`, `opd/encounters.ts:81`, `opd/appointments.ts:63,124`), which is `series.ts`'s own warning obeyed. **`placeOrder` therefore takes `serviceDate` as an INPUT and never derives it** (E14).

**S6 — no manifest literal breaks, and the censuses that DO move are named.** Adding an OPTIONAL field breaks nothing: the four helpers that build manifests in tests all spread `Partial<ModuleManifest>` (`kernel/resources/kinds.test.ts:41`, `modules/materials/kinds.test.ts:27`, `kernel/search/registry.test.ts:36`, `kernel/modules/loader.test.ts:4`) and the two full literals (`kernel/worker/jobs.test.ts:40,56`) are unaffected by an optional addition.

The sibling-grep §9.9 rule 7 asks for — `grep -rn 'formularyManifest' apps/core/src --include=*.ts`, **directory and glob** — returns eight lines across four files, of which **two files are censuses T5 must move**: `kernel/modules/manifests.ts` (the import and the array entry) and `kernel/modules/manifests.test.ts` (the import, the ordered key list, TWO `toHaveLength(16)` assertions, and the enumerated worker-difference array whose title currently reads "five"). `MANIFEST_BY_IDENTIFIER` in that file does **not** need `ordersManifest`: it resolves `registry.install(<identifier>)` arguments, and a manifest reaching both processes only through `ALL_MANIFESTS` is never named in one — `resourcesManifest` and `deskManifest` are the precedent.

**S6b (DD12's sibling question, asked by the DD itself) — the patient merge uses NO GUC.** `grep -rn "set_config|current_setting" apps/core/src --include=*.ts` returns **zero hits**. DD12 named this branch in advance: **`orders.patient_id` is therefore left MUTABLE**, the immutability trigger freezes `order_no`, `kind`, `encounter_no`, `ordered_by_type` and `ordered_by_id` only, and this sentence is the close saying so. A merge re-links by plain UPDATE, as it must, and E8's "printed labels keep the original" holds because `order_no` is frozen.

### 9.1 The commits

| SHA | tasks | what it carries |
|---|---|---|
| **`9ba2482`** | T1–T6, one commit | 33 files, +21,256/−67. Migration `0044` and the three tables; `kernel/orders/` (12 files); `kernel/episodes/encounter-resolvers.ts`; the `orderKinds?` manifest field and both boot call sites; the billing/opd/ot import repoints; five censuses; this document. |

**ONE commit for six tasks, and that is v3 §9.9 rule 4 rather than a shortcut.** The unit of cost in a LIGHT phase is the VERIFY RUN, not the commit — Plan 07c paid eight verify launches for three commits. All six tasks were code-complete at the same moment, so they were folded into one run and one commit whose message separates them task by task. Migration `0044` taken; **next free is `0045`.**

### 9.2 Findings — eight, and every one of them was found by EXECUTING the document rather than by reading it

**F1 — `resolveEncounter` could not move, because it imports a module. T3 moved the REGISTRY and left the WRAPPER.** *(the plan's own §5 T3 said "moved verbatim")*

`modules/billing/invoices.ts:332` is not exported and its last act is `getEncounter(db, encounterId)` — OPD's reader — as a fallback for any id matching no registered prefix. That fallback exists because every shipped billing caller passes a bare `opd_encounters` row id and several tests pass ids that are not episode numbers at all. Carrying it into `kernel/episodes/` would have given the kernel a dependency on `modules/opd` and defeated the exact inversion the registry provides.

**What shipped:** the kernel owns `EncounterResolver`, `registerEncounterResolver`, `registeredEncounterPrefixes` and a new `resolveEncounterByPrefix` holding the longest-prefix-first loop verbatim. Billing keeps its private wrapper, its `undefined` case and its OPD fallback, and **re-exports the three names, so §8 item 7 is honoured exactly as written.** `resolveEncounterByPrefix` returns a three-way answer (`matched:false` / `matched:true,resolved:null` / resolved) rather than `null`, because collapsing the first two is precisely how billing would have lost its fallback. `placeOrder` does not inherit that fallback: DD8 says the envelope stores an episode NUMBER.

**F2 — `placeOrder`'s signature carried a `registry` that is a second copy of `decls`.** §5 T3 writes `placeOrder(tx, registry, decls, actor, input)`. `decls` IS `collectOrderKinds(registry)`, so the two parameters are two hand-maintained copies of one fact at argument scope — §2.54's mechanism — and a caller passing a registry with a `decls` array derived from a different one would get silently wrong answers. Nothing in the function needs a registry: permissions are asked of the database. **Shipped as `placeOrder(tx, actor, decls, input)`, the `createResource(tx, actor, kinds, input)` shape.**

**F3 — §4.2 names six events and no task's Files list named a file to put them in.** T3 needs `order.placed`, T4 needs the other five, T6's parity test pins them. Defining them inside `place.ts` and `advance.ts` would split one catalog across two files. **Shipped as `kernel/orders/events.ts`**, the `kernel/{retention,ops,resources}/events.ts` house pattern.

**F4 — `advanceOrderItem`'s signature could not answer its own rule.** §5 T4 writes `advanceOrderItem(tx, actor, itemId, to, opts)` and then rules that a `patient` may cancel from `placed` *"only on a `selfOrderable` kind"* — a fact that lives on the kind declaration and nowhere else. **Shipped as `advanceOrderItem(tx, actor, decls, itemId, to, opts)`**, `decls` in `placeOrder`'s position so the two write paths have one shape.

**F5 — the desk does NOT alias, so T5 could not do it "exactly as `DeskProviderCtx` does".** §5 T5 says the reader aliases sealed patients the way the desk does. `kernel/desk/types.ts` says the opposite in its own header: *"A provider that puts identity in a row is responsible for putting the ALIAS there… The kernel cannot do it for them: it does not know which field of which row is a name."* That is right for the desk, whose rows are arbitrary, and wrong for these readers, which are patient-SCOPED — one name per call, and the kernel knows exactly which field. **`read.ts` therefore makes the alias decision itself, once**, importing `displayName` from `modules/patients/display-name` by deep path (the `kernel/worker/jobs.ts` precedent), so the rule keeps its single owner. A5 and A5b are the proof in both directions.

**And one thing the phase did NOT change, disclosed because DD12 asked for it in advance.** DD12 wanted `orders.patient_id` frozen and released for a merge behind `current_setting('hmis.merge', true)`, and told the executor to confirm the patients merge already uses a GUC. **It does not** — `set_config`/`current_setting` appear nowhere in `apps/core/src`. Freezing the column would break the merge path the day it re-links an order, and inventing the GUC would put a second undocumented authority on who may move a patient row. `patient_id` is left MUTABLE; the trigger freezes `order_no`, `kind`, `encounter_no` and `ordered_by_*`. E8 is unharmed: a printed label keeps its number because `order_no` is frozen.

**F6 — `hasHiddenItems` was built, then removed, and the removal is the finding.** An earlier draft of `read.ts` returned a per-order boolean saying "this order carried restricted items you may not see", on the reasoning that a clinician needs to know there is something to ask about. It was cut. **For the investigations DD11 exists to protect, the EXISTENCE of the test IS the sensitive fact** — an HIV order, an exposure-protocol source test, a PCPNDT-class USG — so a boolean announcing "this patient has a restricted investigation" discloses precisely that to the one caller DD11 excludes. DD11's word is *omits*, and omission means the reader cannot tell. The safety case the flag was meant to serve is already covered, and better, by `findRecentItems`, which applies NO restricted filter: a clinician about to re-order the same test is warned about the prior one whether or not they may read it. `read.test.ts` A1 now asserts the omission is SILENT (`JSON.stringify(view)` contains the restricted service id nowhere), which is a stronger assertion than the one the flag replaced.

**F7 — a test-harness hazard found by hitting it: `expect(spy).not.toHaveBeenCalled()` OOMs this runner.** The T3 A2 mutant run died with `FATAL ERROR: Reached heap limit — JavaScript heap out of memory` after 92 seconds and a 4 GB heap. The cause is not the mutant: when that matcher FAILS, jest pretty-prints the received calls, and `hasPermission`'s first argument is the whole drizzle transaction — an object graph carrying the connection pool and the entire schema. **A test whose only job is to fail loudly could not fail at all.** Both shipped spy assertions (`place.test.ts` A2, `read.test.ts`) now assert on `spy.mock.calls.map((c) => c[1])` — the user-id argument — which prints small AND is the sharper claim: *no lookup was made WITH THE PATIENT'S CREDENTIAL ID*, rather than *no lookup was made*. Worth carrying to the ledger: any spy assertion on a function whose arguments include a `Db`/`Tx` has this failure mode.

**F8 — §9.9 RULE 7's SIBLING-GREP FOUND TWO OF FIVE CENSUSES, AND THE THREE IT MISSED WENT RED IN THE VERIFY.** *(this is §2.131 and §2.133's class again, one file further out — it belongs in the ledger)*

The phase document told the executor to run `grep -rn 'formularyManifest' apps/core/src --include=*.ts`, directory and glob, rule 7 exactly as amended. It was run exactly as written. It returned eight lines across four files and named **two** censuses — `kernel/modules/manifests.ts` and `kernel/modules/manifests.test.ts`. Both were moved. The full verify then failed **three more**, all in `test/seed-roles.test.ts`:

- the per-module permission map (`orders: 4`) and its total, `107 → 111`;
- the reachability census, `111 declared = 91 held + 20 not yet modelled`, which also required four new `NOT_YET_MODELLED` entries **with reasons** in `scripts/seed-roles.ts`;
- the disjointness list, a sorted literal of every unheld permission.

**The mechanism, and it is why the rule as written could not have found them.** §2.131 says to grep for an existing SIBLING's IDENTIFIER because a sibling's name appears wherever the new one must. **That is false for a census that derives from `ALL_MANIFESTS` instead of naming any manifest.** `seed-roles.test.ts` never writes `formularyManifest`, or `deskManifest`, or any manifest identifier at all — it reads the list and counts. A grep for any sibling NAME is structurally incapable of finding it, however wide its scope, because the name is not there to find.

**The amendment rule 7 needs, and the command that would have worked:** when the thing being added is an entry on a ONE LIST that other code derives from, grep for **the LIST's name**, not for a sibling's:

```
grep -rn "ALL_MANIFESTS" apps/core --include=*.ts | grep -v "kernel/modules/manifests"
```

That returns 34 lines across ~20 files and names every one of the five, plus the four more this phase checked and found unmoved (`roles-catalog.e2e.test.ts`, `nav-parity.test.ts`, `approval-types.test.ts`, `desk/rollup.test.ts` — all green, because `ordersManifest` carries `menu: []` and no provider). **Sibling-name and list-name are two different searches and the second is the one that finds a derived census.** Cost of learning it this way: one 20-minute verify run.

*(§8.11's "granted to NO role" survived intact — the four strings are unheld, `heldPermissions()` is UNCHANGED at 91, and the four `NOT_YET_MODELLED` reasons say why each one waits for the plan that gives it a surface.)*

**A defect in this phase's own test, found by running it and recorded because it is a real one.** `place.test.ts`'s A4b (`requiresIndication`) first came back `permission_denied` instead of `indication_required`: the fixture's doctor held `lab.orders.place` and not `radiology.orders.place`, so the actor leg refused before the indication check was reached. The FIXTURE was wrong and the code was right — the check order is deliberate, so that a caller who may not place at all is told that rather than told they forgot a field. **The order is now itself an assertion** ("answers permission_denied, not indication_required, when the caller may not place at all"), which is worth more than the fixture fix alone.

### 9.4 The Assertion Book, corrected by execution

**Mutant discipline (AGENT-RULES §3, rule 21).** Every mutant below was BUILT as a `*.mutant.ts` scratch file beside its source, run in isolation, and deleted before commit. No mutant was predicted.

#### T2 — CRITICAL. Four assertions, four mutants, **4 DIED / 0 SURVIVED**

`kinds.mutant.ts` carried three byte-copies of `collectOrderKinds`, each with exactly ONE refusal removed, and `kinds.mutant.test.ts` ran the shipped assertions against them.

| # | assertion | mutant | verdict | expected vs received |
|---|---|---|---|---|
| A1 | two manifests claiming `lab` throw `duplicate_kind` | `collectNoDup` — the `seen` check dropped | **DIED** | *Expected pattern: `/two manifests declare the order kind "lab"/` · Received function did not throw* |
| A2 | a `seriesKey` outside `EPISODE_SERIES` throws `unknown_series` | `collectNoSeries` | **DIED** | *Expected pattern: `/unknown_series\|EPISODE_SERIES does not carry/` · Received function did not throw* |
| A3 | a `placePermission` no manifest declares throws `undeclared_permission` | `collectNoPermission` | **DIED** | *Expected pattern: `/declares placePermission/` · Received function did not throw* |
| A4 | the field is OPTIONAL and every existing manifest still compiles | `manifest-required.mutant.ts` — `orderKinds` made required, `authManifest` assigned to it | **DIED at typecheck** | `TS2322: Type 'ModuleManifest' is not assignable… Type 'undefined' is not assignable to type 'readonly OrderKindDecl[]'` |

**A4's typecheck death is the evidence, not an evasion of rule 21.** The rule warns that a mutant dying at typecheck proves nothing *because the obstacle is usually the LANGUAGE rather than the ASSERTION* — an indexed array literal dying at `TS2532` says nothing about the test. Here the assertion's whole subject IS a type-level property ("the field is optional, so no existing manifest changes"), the plan names this exact mutant in as many words, and the error quoted is about the field under test. There is no runtime behaviour to mutate.

**Two legs added beyond the Book, each because the assertion above it would otherwise pass for a wrong implementation:** two manifests declaring DIFFERENT kinds must NOT be refused (`lab` and `imaging` side by side is what 17 and 18a will do), and a `placePermission` declared by a DIFFERENT installed manifest must be accepted (the check is against the whole catalog, as `collectProviders` is — a self-declaration rule would forbid a module using `orders.place`).

#### T3, T4, T5 — CRITICAL. Ten mutants, **10 DIED / 0 SURVIVED**

Built as `place.mutant.ts`, `advance.mutant.ts` and `read.mutant.ts` — byte-copies of the shipped
functions with exactly one rule removed each — and run from one scratch spec against the SHIPPED
assertions. All four files deleted before commit; `git status --porcelain` carries no `*.mutant.*`.

| task | # | assertion | mutant | verdict | expected vs received |
|---|---|---|---|---|---|
| T3 | A1 | an `agent` actor is refused | the `agent` case removed — it falls into the staff leg | **DIED** | *Expected pattern `/agent_cannot_order/` · Received message: `"permission_denied"`* |
| T3 | A2 | a `patient` is refused, and **no `hasPermission` call is made with its id** | the `patient` case removed | **DIED** | *Expected `[]` · Received `["patient-credential-1", "patient-credential-1"]`* — the mutant asks the permission table about a patient credential id, twice |
| T3 | A3 | a `system` actor with no `protocol_ref` is refused | the requirement removed | **DIED** | *Received promise resolved instead of rejected* |
| T3 | A5 | a `user` needs BOTH `orders.place` and the kind's permission | only the kernel permission checked | **DIED** | *Received promise resolved instead of rejected* — the pharmacist places imaging |
| T4 | A2 | cancelling from `in_progress` with no reason is refused **by the guard** | the guard removed | **DIED** | *Expected `{kind:"OrderError", code:"cancel_reason_required"}` · Received `{kind:"DatabaseError", code:"new row for relation \"order_items\" violates check constraint \"order_items_cancel…"}`* |
| T4 | A4 | the header closes when the last LIVE item completes | the close counts ALL non-completed items | **DIED** | *Expected `"closed"` · Received `null`* — the order with one cancelled add-on never closes |
| T5 | A1 | a restricted item is omitted for an uncleared caller | the filter dropped | **DIED** | *Expected `[CBC]` · Received `+ "01SERVICE…0002"`* — the HIV order is on the ward's list |
| T5 | A2 | the ordering clinician sees their own restricted item | the permission required of everyone | **DIED** | *Expected `[CBC, HIV]` · Received `- "01SERVICE…0002"`* — the doctor who ordered it cannot see it |
| T5 | A3 | `findRecentItems` excludes cancelled items | cancelled included | **DIED** | *Expected `[]` · Received `[{itemId:"01M16XH…", status:"cancelled"}]`* — a cancelled duplicate blocks a required repeat |
| T5 | A5 | a sealed patient renders through the alias path | `patients.name` read directly | **DIED** | *Expected `"Patient S-14"` · Received `"Meera Raghavan"`* |

**T4 A2 is the row worth reading twice.** The plan asked for both halves to die separately — remove
the guard and Postgres must refuse; remove the CHECK and the guard must. The mutant proves both in
one run: with the guard gone the write reaches the table and comes back as a `DatabaseError` naming
`order_items_cancel_reason_ck`. The second half is proved independently in T1's schema suite, where
the same row is refused on a direct INSERT that never passes through `advanceOrderItem` at all.

**A control test ran beside the ten and PASSED** ("the shipped item stamps are untouched by the
mutants above"), which is what says the ten failures are the mutants dying rather than the harness
being broken.

#### T4 A3 — the assertion the plan got wrong, corrected by MEASUREMENT

The plan's A3: *"Two concurrent `advance` calls from `placed` (start vs cancel) — exactly one wins,
the other gets `stale_state`."* **The loser gets one of THREE correct refusals**, and which one
depends on where the transactions interleave — a fact found by running it, not by reasoning:

- the loser READ before the winner committed → validated against `placed`, its CAS matched nothing →
  **`stale_state`**. This is the CAS discriminating.
- the loser READ after a committed START → sees `in_progress`, so `in_progress → cancelled` is a
  legal edge needing a reason → **`cancel_reason_required`**.
- the loser READ after a committed CANCEL → `cancelled → in_progress` is not in the table →
  **`illegal_transition`**.

All three are correct; none is the defect A3 exists to catch. **The test now asserts the invariant
that holds on every interleaving, which is the stronger claim:** over 12 rounds, exactly one call
succeeds, the loser writes NOTHING (one transitions row per item, one set of stamps), and every
refusal is one of those three. The read-then-write mutant fails that on ANY interleaving — both
succeed, the item ends `cancelled` carrying a `started_at`, and two transitions rows exist for one
item, which is 02 §5 B6's analyzer running a cancelled tube.

**The rate is reported, not asserted at a threshold (AGENT-RULES §2.3 — never engineer the window).
Observed on this host: `{ stale_state: 11, cancel_reason_required: 1 }` over 12 rounds** — the CAS
is the discriminator in 92% of races, so it is genuinely exercised rather than incidentally passed.

**And the corollary A3b now states:** `stale_state` is reachable ONLY under true concurrency. A
sequential repeat re-reads the CURRENT state, so the transition table catches it first — the first
draft of A3b asserted `stale_state` for a sequential repeat and was asserting something unreachable.

#### One assertion this phase could not discriminate, disclosed per T6

**T3 A8 (the encounter-registry parity) has no mutant and cannot have a useful one.** The plan says
so itself — *"no mutant — parity; the assertion is the existing billing test still passing from the
new path"* — and that is the right instrument: `modules/ot/bill.test.ts` is the suite that pins
`registeredEncounterPrefixes()`, it was not touched by this phase, and it passes against the moved
registry. The leg added in `place.test.ts` asserts containment rather than the exact list, because
`D` is registered only when `ot.module.ts` initialises and asserting an exact list from a suite that
registers only `V` would pin the test's own fixture instead of the registry.

### 9.5 Mechanical verification

**Preflight, before every verify launch (§9.9 rule 6 / ledger §2.132).** `pnpm typecheck && pnpm lint` was run before each of the two full-verify launches and caught one unused import (`inArray` in `advance.ts`) in sixty seconds rather than twenty minutes. It also caught, on its own, an unused `ordersManifest` import in `manifests.test.ts` — a manifest reaching both processes only through `ALL_MANIFESTS` is never a `registry.install()` argument, so `MANIFEST_BY_IDENTIFIER` does not carry it (the `resourcesManifest`/`deskManifest` precedent).

**`pnpm verify`, detached, exit value READ FROM A FILE (`.verify17.exit`), tree frozen for its duration:**

| | suites | tests |
|---|---|---|
| `apps/core` | **286 passed / 286** | **2,769 passed / 2,769** |
| `apps/web` | 56 files passed | 355 passed |
| `packages/contracts` | 4 passed | 21 passed |

**Exit 0.** The workspace total did not decrease and this phase's diff deletes no test: it ADDS seven suites (`db/schema/orders.test.ts`, and `kinds`/`place`/`advance`/`read`/`envelope.e2e`/`parity` under `kernel/orders/`).

**THE FIRST FULL VERIFY CAME BACK RED WITH 105 FAILURES AND ONLY TWO OF THEM WERE REAL — the rest were the shared host, and the distinction was measured rather than assumed.** 188 of the failure lines read `Exceeded timeout of 15000 ms`, spread across alerts, dispatcher, notify, ops, billing, formulary, materials, membership and opd — suites this phase does not touch — and `orders.test.ts` itself took **378 s** in that run against **27 s** in isolation. `uptime` at launch: **load average 18.70**, with the parallel patient-self-service lane running its own suites at `--maxWorkers=3`. Re-run at load average **2.35**: green. The two REAL failures inside that noise were `seed-roles.test.ts`'s censuses (F8), and they were found by reading the failure NAMES rather than the count.

**The parallel-session protocol, applied and worth recording because it changed how this phase was tested.** `reports/2026-08-26-parallel-session-protocol.md` §4 says the shared per-worker test databases make a concurrent run's evidence unreliable, and this phase hit that four separate times — `order_items_service_id_services_id_fk` violations in tests whose own fixture had inserted the service, which is another run's `truncateAll` landing between the insert and the check. **The fix was not to queue: `setupTestDb` derives its database name from `TEST_DATABASE_URL`, so pointing it at `hmis_ord17_scratch` gave this phase private worker databases and the contention disappeared entirely** (154/154 on the first isolated run of suites that had been failing 6-at-a-time). AGENT-RULES rule 7 sanctions exactly this — *"a scratch database you create with a name that is obviously yours, use, and drop in the same task"* — and every one was dropped (`select count(*) … like 'hmis_ord17%'` → **0**). **This is the cheapest fix available to a parallel lane in this repo and it is not written down anywhere;** it belongs in the protocol document.

**Frozen surfaces, audited against the commit's own `--stat`:** `kernel/resources/kinds.ts` UNTOUCHED · `resources_kind_ck` UNTOUCHED (no resource kind added; the set stays closed at ten, cross-module ruling 2 honoured) · `kernel/episodes/series.ts` UNTOUCHED (no new series letter; the phase adds no counter) · `kernel/auth/*` UNTOUCHED · `packages/contracts/*` UNTOUCHED (the four-member `Actor` union is consumed, never edited) · `modules/opd/` — **one line**, the import path in `opd.module.ts` · `modules/ot/` — **one line**, the same · `modules/patients/` UNTOUCHED (read from by deep path, never modified).

**Claimed-kinds parity: `[]`**, asserted three ways — in `kinds.test.ts` over `ALL_MANIFESTS`, in `parity.test.ts` as the pin a reviewer sees move, and implicitly by `placeOrder` refusing every kind with `unknown_kind`. The envelope ships with **zero consumers**, which is the state the CONTRACT (§6) describes.

**Scratch discipline (AGENT-RULES §5 step 0).** Four mutant modules and two mutant specs were written under `apps/core/src/kernel/orders/`, run, and deleted with plain `rm -f` before staging. `git status --porcelain` was read before the `git add` and showed no `*.mutant.*`, no `.log`/`.exit`, and no foreign-lane file. **Nothing was staged that this phase's Files lists do not name**, and staging was by explicit path — 33 paths, never `git add -A` and never a directory.

**CI:** watched by FULL SHA with `pipelines/ci-watch-host.sh 9ba248228f8f53f02150954fb5b4f6b1a0f85ea7`.

### 9.6 The independent close review

**ONE fresh reviewer, restricted tools, no MCP roster, briefed at the OPERANDS ahead of the dimension list (v3 §9.7).** There is no money file in this phase — DD10 keeps price off the envelope — so the "money file first" rule was replaced with *`place.ts` and `read.ts` first*, and the operand instruction was: *for every "already exists" check in `placeOrder` and `advanceOrderItem`, name what it queries and which writes it would MISS; for `listOrdersForPatient`'s restricted and sealed filters, name one row each would leak.*

**It returned 2 CRITICAL, 8 MAJOR and 8 MINOR against a tree with 14 dead mutants, a green `pnpm verify` and a green CI run behind it.** That is v3 §9.4's measurement repeating exactly: *"the tree looked finished."*

#### The two CRITICALs, both confirmed by executed mutants before being fixed

**C1 — THE HEADER CLOSE WAS A READ-THEN-WRITE ON ROWS THE COMPARE-AND-SET DOES NOT LOCK, AND IT FAILED IN 7 OF 8 ROUNDS.**

`closeHeaderIfDone` counted siblings with a plain unlocked `SELECT` under READ COMMITTED. **The item-level CAS locks that item's row and nothing else — two items of one order are two different rows and never contend.** So two results landing at the same instant each saw the other item still `in_progress`, because the other transaction had not committed:

```
T1: CAS A→completed · count: A=completed(own), B=in_progress → live=1 → return null
T2: CAS B→completed · count: B=completed(own), A=in_progress → live=1 → return null
both COMMIT → every item completed, header `open`, `order.closed` NEVER EMITTED
```

Neither transaction reached the CAS at the foot of that function, so its "zero rows is not an error" defence never engaged: **the defect was that neither party got there.** The order then sits on every pending-investigations list for ever — the exact failure the function's own header says it exists to prevent — and 22c-F's reports projection and 26's package progress both key off `order.closed`.

**This is not a narrow window.** The pre-fix code, run 8 rounds against two concurrent completions: **header left OPEN with every item completed in 7 of 8.** The fix is `select id from orders where id = ? for update` before the count — the house pattern (`billing/receipts.ts`, `materials/consumption.ts`, `ot/deposit.ts`), and the lock order is item → header for every caller so there is no cycle.

**Why the phase's own instruments missed it:** A4/A4b/A4c and the e2e close are all SEQUENTIAL, and A3 races two moves on the SAME item — the case the row lock already covers. No test raced two items of one order. The Assertion Book had a row for the header close; its mutant ("count all items instead of live ones") died on a sequential leg. **§9.7's lesson one level in: the Book asked whether the close FIRES, which is the question the author had already thought about.**

**C2 — DD11's OMISSION WAS UNDONE BY ONE LEVEL OF NESTING: THE HEADER LEAKED, `indication` INCLUDED.**

`visibleItems` filtered the ITEMS; `assemble` returned **every header regardless**. An order whose every item was restricted came back as a real header with `items: []`, carrying `orderNo`, `placedAt`, `orderingClinicianId`, `encounterNo` — and `indication`, which is free clinical text. A ward clerk holding `orders.read` and nothing else could read `L2608290007 · lab · open · Dr D · "post-exposure prophylaxis, needle-stick, source patient unknown"`.

**That is more than the `hasHiddenItems` boolean F6 removed for being too revealing** — it is that boolean plus five fields plus the reason. Two rules close it: an order with items but none visible is not returned at all (`placeOrder` refuses an empty order, so an empty visible list can only mean everything was filtered), and `indication` is withheld whenever ANY item was filtered, because one order is one act and the justification is written for the whole of it.

**And the assertion that could not see it was the one F6 substituted:** `expect(JSON.stringify(view)).not.toContain(HIV)` matches the SERVICE ID, and the fixture always carried a visible CBC beside the restricted test, so the header was legitimately present and the test passed. **No test built an order whose every item was restricted, and no test set `indication` at all.**

#### The MAJORs acted on

**M3 — the patient actor had no chain of custody, and A6b was GREEN BECAUSE OF IT.** `advanceOrderItem`'s comment said whose order a patient is cancelling is established by "the patient-scoped reader the surface used to find it (`listOrdersForPatient`)". **`listOrdersForPatient` establishes nothing** — it takes `patientId` as a free parameter and never compares it to `actor.id`. The loop had no closed end, and this phase's own A6b cancelled, with credential `p-1`, an item on an order a lab tech had placed for a different patient. Under Plan 26 that is any authenticated phone credential cancelling any other patient's booked check-up. **Fixed with the binding the kernel has the data for: the order must have been placed BY that patient actor** (`ordered_by_*`, stamped at placement and frozen by `0044`'s trigger). A6b now places as the patient; two new legs cover the stranger and the other-patient cases.

**M5 — `findRecentItems` was an unauthenticated oracle.** It takes no actor, applies no clearance, and — correctly, deliberately — no restricted filter, which is what F6 leans on. But with no actor there was nothing to gate on and nothing to log: anything holding a `Db` could ask whether a sealed patient had a specific restricted test and iterate `serviceId` over the tariff to rebuild the history `listOrdersForPatient` hides. **It now requires an actor and admits only `user` and `system`** — a duplicate check is decision support for whoever is about to order.

**M9 (partial) — the window measured `created_at`, the row's insert instant, not `placed_at`.** E13 rules that a paper order backfilled at 14:00 carries the paper time, so the check would have called a six-hour-old troponin one hour old and warned about it — *the "trains people to click through warnings" failure the function's own header names, produced by the check itself.* Now measured on `orders.placed_at`.

**MAJOR 10 and MINOR 13 — two data-integrity holes closed by migration `0045`,** a follow-up rather than an edit to `0044` (rule 15: `0044` is pushed). `authority` and `external_referrer_id` were mutable, and they move together cleanly enough to satisfy every CHECK — so `UPDATE orders SET authority='external_prescription', external_referrer_id='<a partner I control>'` turned a completed clinician order into a commission-ledger referral fee after the fact, with no audit row anywhere (`order_item_transitions` records ITEM moves, never header edits). They join the identity trigger. And `status='cancelled'` with a null `cancelled_from` passed every constraint, leaving 02 O-4's money rule a row it cannot interpret — now a biconditional CHECK. `ordering_clinician_id` is deliberately left mutable: naming the wrong doctor must remain correctable, and that is pinned by its own test.

#### Findings NOT acted on, each with its reason

- **M7 (`hasPermission` hard-codes `"hospital"` scope) — CHECKED AND NOT A DEFECT.** All **20** `hasPermission` call sites in this repository pass `"hospital"`, and `grep 'scopeType: "department"'` over `src` and `scripts` returns **nothing**: there is no department-scoped assignment anywhere. This phase follows the shipped convention exactly. If department scoping ever arrives it is a repo-wide change, and a phase that deviated from the convention first would be the defect.
- **M6 (`decls` is caller-supplied and forgeable)** — a fair critique, and it is the shipped `createResource(tx, actor, kinds, input)` precedent verbatim, whose header argues the alternatives (a boot-assigned mutable global; a default that goes stale without a typecheck error) are worse. Changing it here would put the kernel's two write paths on different shapes for the first time. **Recorded for the roadmap, not fixed in a remediation.**
- **M4 (no encounter resolver is registered in the WORKER)** — real, verified (`worker.module.ts` has no `imports:` and never references `OpdModule`/`OtModule`), and **out of this phase's scope to fix**: it needs the worker to import two Nest modules, which is an architectural change to a process this phase does not own. It is a REAL constraint on Plan 17, whose reflex consumer is a `system` actor running in the worker, so it is written into the CONTRACT (§6) as a named precondition rather than left to be discovered.
- **M8 (no idempotency on `placeOrder`)** — real, and it belongs to the ROUTE. This phase mounts none; the repo's `idempotency_keys` table is used at the controller layer. Written into the CONTRACT so Plan 17 owes it.
- **M9's other two legs (profiles containing an analyte; pre-merge duplicate patient rows)** — both real limits of an exact-match window, neither fixable without a service-composition model (17-M) and a merge-aware patient resolver. Written into the CONTRACT as what `findRecentItems` does NOT catch.
- **MINOR 11, 12, 14–18** — recorded in the CONTRACT where a downstream plan meets them. **12 is the one worth naming here: E3 (an add-on on an OPEN order) has no kernel API**, so the first module to implement it would `INSERT INTO order_items` directly — the one write with no CAS, no trigger and no guard over it. That is a real gap in §6's "adds ONE manifest field" promise and it is now stated as such.

#### The remediation's own evidence

Four mutants built from the PRE-FIX code (`remediation.mutant.ts`), run against the NEW assertions, **4 DIED / 0 SURVIVED, with a control that passed**:

| # | mutant | verdict | evidence |
|---|---|---|---|
| C1 | `closeHeaderIfDone` without `FOR UPDATE` | **DIED** | *header left OPEN with every item completed in **7/8 rounds*** |
| M3 | the patient leg without the ownership check | **DIED** | the stranger's cancel succeeded; item `cancelled`, expected `placed` |
| C2 | `assemble` returning every header | **DIED** | the all-restricted order came back, indication included |
| M5 | `findRecentItems` with no actor gate | **DIED** | resolved instead of rejecting for a `patient` actor |
| — | **control: the SHIPPED code, same race** | **PASSED** | header `closed`, exactly one `order.closed` |

**This is §9.8 applied rather than quoted: the fixes were written first, and then the mutants proved the new tests would have caught what they were written for.** A test added after a fix, never run against the defect, certifies nothing.

---

### 9.6.2 The SECOND close review — over the remediation diff only, FRESH

**Spawned FRESH, not resumed** (execute prompt §4.3; v3 §9.5 / ledger §2.115). It reviewed `6bd3016` alone and was told why it existed: *a remediation is unreviewed code on the same path, and this project's own history says that is where the worst late defects concentrate.*

**It returned: five of the six fixes mechanically correct, verified by execution — and one incomplete.** That is the outcome §6's second-pass argument predicts, and it is the second time in this phase that the reviewer found more than the phase's own instruments did.

#### The CRITICAL it raised was WRONG, and how it went wrong is worth more than the finding

It reported that migration `0045` *"has never been applied to any database on this host, so the 'full test run exit 0' evidence cannot cover the fixes it certifies"* — with real evidence: every database it could see (`hmis_test_1..8`, `hmis_dev`, `hmis_test`) had `0044` as its highest applied migration, `pg_proc.prosrc` for `orders_forbid_identity_change` carried no `authority` clause, and `order_items_cancelled_shape_ck` existed in no `pg_constraint`. Every one of those observations is TRUE.

**The inference was not.** The step it could not see is the one that made this phase testable at all: the runs used `TEST_DATABASE_URL="…/hmis_ord17_v2"`, so they created, migrated and tested `hmis_ord17_v2_*` — **and AGENT-RULES rule 7 requires a scratch database to be dropped in the same task, so they were gone before the reviewer looked.** Its reasoning — *"there is no way for a test run to avoid this: `setupTestDb` migrates unconditionally and `.env` points at that one server"* — is correct about the DEFAULT and missed the per-run override.

**Refuted by re-execution:** the three `0045` assertions run on a fresh isolated database, migrated from empty, `32 skipped, 3 passed`, exit 0.

> **AND THE LESSON, WHICH IS THE EXPENSIVE HALF: THE ISOLATION THAT SOLVED THE CONTENTION MADE THE EVIDENCE UNVERIFIABLE.**
>
> §9.5 records private worker databases as the cheapest fix available to a parallel lane in this repo, and it is. What it did not record is the cost: a later reader — a reviewer, the owner, the next session — inspects the databases that EXIST, finds the phase's migration in none of them, and correctly concludes the evidence is missing. The two obligations rule 7 imposes (obviously-yours name; dropped in the same task) are exactly what erases the audit trail.
>
> **The rule this phase pays for: when a run uses a non-default `TEST_DATABASE_URL`, SAY SO where the evidence is claimed — in the commit message and in the close — naming the database.** One clause. Without it, "exit 0" is a claim about a database nobody can look at, and the honest reviewer's only available conclusion is the one this one drew.

#### What it found that was real — four leaks, one of them created by the first remediation

**M-1 — C2 was INCOMPLETE: the header's own `status`/`closed_at` still proved a restricted item existed.** Dropping the all-restricted order was not enough. On a PARTIALLY restricted order the real header state is a deterministic inference channel: `closeHeaderIfDone` closes only when NO item is live, so an `open` header whose every VISIBLE item is terminal means exactly one thing — a live item exists that this caller cannot see. The mirror is sharper: the close picks `closed` over `cancelled` only when something COMPLETED, so a `closed` header whose every visible item is `cancelled` proves a hidden item ran to completion. **That is the `hasHiddenItems` boolean F6 removed, re-derived from two fields C2 left in place.** Fixed by projecting `status` over the VISIBLE items — the same answer the caller could compute from the rows they hold, which is the most this view can honestly say — and nulling `closedAt` when anything was withheld.

**M-2 — the first remediation TURNED `opts.limit` INTO A COUNTING-AND-DATING ORACLE.** The limit was applied to the header query and `assemble` dropped rows afterwards, so with fully-restricted orders at ranks 1 and 4, `limit = 1..5` returned **0, 1, 2, 2, 3** — *the flat spots name the exact ranks of the hidden orders*, and each is bracketed in time by its visible neighbours' `placedAt`. A ward clerk learns how many restricted orders a patient has and roughly when each was placed: strictly more than the boolean F6 removed, from a knob the caller turns. **It was also a plain paging bug** — a screen asking for 20 silently got 17 with no way to know more existed. Filter first, limit after.

**M-3/M-4 — THE READ PATH HAD M3's HOLE, WIDER, AND THE KERNEL CANNOT CLOSE IT YET.** `advanceOrderItem`'s new comment says, correctly, that `listOrdersForPatient` establishes nothing — and `read.ts` was unchanged. So `listOrdersForPatient(db, {type:'patient', id:'p-1'}, someoneElsesPatientId)` returned that patient's display name and every non-restricted order, and because the name comes back even for an empty list it doubled as a patient-id → name resolver. **The remediation hardened the narrow oracle (`findRecentItems`) and left the wide one.**

**It cannot be fixed the way M3 was.** `envelope.ts` rules that a patient actor's `id` is the `patient_credentials` row — the verified PHONE, never a patient, so one phone can hold three household profiles — and `grep -rn "patient_credentials" apps/core/src` returns **nothing**: 22c-B builds that table. The kernel has no way to compute the accessible set. **So both readers now REFUSE a `patient` (and `agent`) actor outright**, which also resolves M-4 honestly: a patient could not see their own restricted item anyway (floor clearance), so serving them a partial view of their own booking while hiding the item they need to cancel is worse than saying not yet. What 22c-F owes is one kernel function that resolves a credential to its own patient set, and it is in the CONTRACT (§6A) rather than left to be discovered.

#### The MINORs acted on, and one that is a methodology finding

- **m-1 — the remediation BORROWED an error code, which this phase's own `errors.ts` forbids in capitals.** `findRecentItems` answered `actor_cannot_advance` for a READ refusal. The union's header states the rule *and* the remedy: a later task needing a code the union does not carry has found a PLAN DEFECT and reports it. **`actor_cannot_read` added, 403 like its write-side sibling.**
- **m-2 — M3's FIX QUIETLY MADE AN EXISTING ASSERTION REDUNDANT.** A6c places as the lab tech, so after M3 both the `selfOrderable` gate and the ownership gate refuse it — delete `|| !decl?.selfOrderable` from the source and A6c stays green. A6b and A6d were both rewritten to place as the patient, so neither covers it. This is §9.8's *"a correct fix breaks the fixture that was quietly documenting the invariant"* seen from the other side, and the gate is not dead code: withdraw self-booking for a kind that already has patient-placed orders and it is the only thing stopping those patients continuing to cancel. **A discriminating leg now constructs exactly that** — placed under the old declaration, advanced under the new one, which is what a deployment does.
- **m-3 — the paragraph M3's comment said it "replaced" was still there, still saying the opposite**, 35 lines above its own retraction. §2.38's defect exactly. **Struck in place, the rule-6 pattern.**
- **m-4 — "the lock order is item → header for every caller" is an invariant nothing enforces, and the next writer the CONTRACT names breaks it.** An INSERT into `order_items` takes FOR KEY SHARE on the parent `orders` row, which conflicts with FOR UPDATE — an interaction this repo already documents in `billing/allocations.test.ts`. E3's add-on (which has no kernel API, §6A.5) would deadlock against a concurrent close. **The header lock is now taken ONLY on a terminal move** — `placed → in_progress` can never close anything, so it was pure contention — and the invariant is written into §6A.
- **m-5 — `headerStatus` was selected and never read.** Removed.

#### What it CONFIRMED, by execution, and it is worth as much as the findings

- **C1's lock is in the right place and there is no deadlock today** — it verified the only `for update` on `orders` is in `advanceOrderItem`, always after the item CAS, so every caller acquires `{item, header}` in that order; `placeOrder` only ever touches its own new header; `nextEpisodeNo` locks a table `advance.ts` never touches. The `stale_state` path throws before the lock and does not need it: the CAS **winner** runs the close.
- **`0045` applies cleanly and breaks nothing `0044` allowed** — executed against a `0044` database inside a rolled-back transaction. `CREATE OR REPLACE FUNCTION` is correct: the trigger binds by OID, so replacing the body re-arms it. The new CHECK does not steal the older constraints' cases (each of the three still matches its own regex), the snapshot chain is intact, and a flattened snapshot diff shows exactly ONE difference, so the next `drizzle-kit generate` will not re-emit it. *(Its note for later: the constraint takes ACCESS EXCLUSIVE without `NOT VALID` — free on a table empty at deploy, remember it when this table is large.)*
- **M9 did not create a sequential scan — MEASURED.** `EXPLAIN` plans a nested loop over `order_items_service_created_idx` and `orders_patient_placed_idx`, and the latter covers the new predicate AND the new `ORDER BY … DESC` exactly. It is a BETTER plan than before: the old `created_at` filter leaned on an index global across every patient.
- **M3's binding compares like with like** — `placeOrder` stamps `ordered_by_*` from the same `Actor` the advance path receives, and the household case still works because the phone is the actor.

#### The remediation's own evidence, pass 2

Three mutants from the PRE-FIX code, run against the NEW assertions, **3 DIED / 0 SURVIVED, control passed**:

| # | mutant | verdict | evidence |
|---|---|---|---|
| M-1 | the header's REAL `status`/`closed_at` returned | **DIED** | *Expected `"closed"` · Received `"open"`* — the mutant IS the leak: the caller's view says a hidden item is still running |
| M-2 | limit applied before the filter | **DIED** | counts `[1,2,3,3,3]` expected · `[0,1,2,2,3]` received — the flat spot |
| M-3 | patient actor given floor clearance | **DIED** | *Received promise resolved instead of rejected* |
| — | **control: the SHIPPED reader** | **PASSED** | projected `closed`/`null`, and the patient actor refused |

**Across both close passes: 21 mutants built, 21 died, 2 controls passed.**

---

### 9.7 Actuals, recorded only now — v3 §9.4 forbids the row before §9.6 exists

| term | budgeted | actual |
|---|---|---|
| task term (1.5 × 20,178 × 6) | 181,602 | **UNMEASURABLE from inside** — LIGHT lane, zero coding subagents, so `token-audit.js` finds no transcripts by construction. Only the owner's `/cost` can see it (runbook O3). |
| review term (two FRESH passes) | 458,491 | **348,043** — pass 1 195,491 / 40 calls = **4,887 per call**; pass 2 152,552 / 48 calls = **3,178 per call** |
| **stop-loss** | **640,000** | not breached on the measurable half; the unmeasurable half is stated as such rather than implied to be zero |

**The review term came in 24% under budget and the second pass was CHEAPER PER CALL than the first**, on a smaller workload — §2.136 confirmed on a second phase, and the exact opposite of Plan 13's resumed chain (41,073 and 112,041 per call for less work each time). **Fresh, not resumed, is now measured twice.**

**And pass 2 earned its whole cost twice over.** It found a live confidentiality leak that **the first pass's own fix had created** (M-2: rows filtered after a `LIMIT`, so a caller varying it read `0,1,2,2,3` and the flat spots named the hidden orders' ranks) and the same dimension still open through the header's own `status` field. §6's second term exists for exactly this, and **a stop-loss that halted pass 2 would have shipped both.**

#### What the spend bought, named

- **The spike REFUTED two things** rather than confirming the plan, and both changed code before T1: `resolveEncounter` imports a module so it could not move to the kernel (F1), and the patients merge uses no GUC so `patient_id` could not be frozen (S6b). A spike that only confirms buys insurance; these bought the design.
- **21 mutants, 21 dead** — and the one that matters most is C1's, which is not a mutant of a guard but of a LOCK: the pre-fix header close left the order `open` with every item completed in **7 of 8 rounds**.
- **The reviewers found what the phase's own instruments could not, twice.** Fourteen dead mutants, a green verify and a green CI run stood over a tree in which an order could never close and a ward clerk could read a needle-stick indication. **That is v3 §9.4's measurement repeating: the tree looked finished.**
- **Four verify runs, one red** — and that red was 105 failures of which two were real, the rest a load average of 18.70 from the other lane.

#### Where it could have been cheaper — in numbers

**Lever 1, context per call.** The reviewers were pointed at `AGENT-RULES.md` (26,563 B), specific sections of the phase document, and the commit — and were told **not** to read the ledger (398,347 B ≈ 99,587 tokens). Had either read it, its 40–48 calls would have carried ~100k extra each: **pass 1 alone would have cost ~4M instead of 195k.** §9.1 rule 1 is the single highest-leverage line in this method and it held.

**Lever 2, turns.** The expensive turns were not reading — they were the **four full verify runs**, ~15–20 minutes each. One was pure waste (the contended red), and rule 8 below is what removes that class.

**Lever 3, agents.** Two, both reviewers, both fresh. There is no agent to remove: the coding was in-session and the reviewers found two CRITICALs the session did not.

#### What changed so it does not recur

- **Ledger §2.137** — the private test database ends parallel-lane contention AND erases the audit trail; name the database where the evidence is claimed.
- **Ledger §2.138** — the sibling-grep cannot find a census that DERIVES from the list; grep the list's name. (Third amendment to §2.131 in three days, and the first with a NEW mechanism.)
- **Ledger §2.139** — `expect(spy).not.toHaveBeenCalled()` on a function taking a `Db` OOMs the runner at 4 GB when it fails; assert on the argument.
- **Ledger §2.140** — a fix that removes a disclosure must enumerate every other field that is a function of it, and every caller-supplied parameter that interacts with the filter.
- **Method §9.9 gains rule 8** (own databases, and name them), **§9.9 rule 7 gains its second half** (grep the list, not just a sibling), and **§9.8 gains rule 4** (the disclosure-removal enumeration).

---

### 9.8 The question this phase existed to answer

**YES — Plans 17 and 18a may now be authored as two independent lanes.** The envelope is kernel, the kind seam is a manifest field, the four item states are frozen in code, `order_no` comes from the existing counters, and §6/§6A state what each plan inherits and what it still owes. Neither plan needs to touch the other's tables, and neither can decide the seam for the other by touching it first — which is the failure `opd_rooms` cost Plan 13 and the reason this phase was written.

