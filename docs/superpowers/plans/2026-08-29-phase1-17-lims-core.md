# Plan 17 — Central lab / LIMS core: catalogue, order at the counter, specimen, accession, result, verify, report, interlock

**Written 2026-08-29 on the build host, in LANE A of a two-lane authoring fork (Lane B is authoring Plan 18a in this checkout). NOT APPROVED FOR EXECUTION — execution is a separate session with its own approval.** Seeded by [`2026-08-29-LANE-A-plan-17-lims-AUTHOR-PROMPT.md`](2026-08-29-LANE-A-plan-17-lims-AUTHOR-PROMPT.md). The envelope this plan builds on is phase 0, [`2026-08-29-phase1-17-order-envelope.md`](2026-08-29-phase1-17-order-envelope.md) — **§6 (the CONTRACT), §6A (what it does NOT do), §8 (what is frozen), lines 297–374**; §4.1 for a column name. Its code is LIVE in production (prod 46 migrations, 2026-08-29) and is **inherited, not edited**.

**THE RULING, in one paragraph.** Plan 17 is the **manual-first LIMS core**: it claims the order kind **`lab`** with ONE manifest field (`lab` / `lab_order` / `lab.orders.place`, `requiresClinician: true`, `requiresIndication: false`, `selfOrderable: false` — phase 0 §6.8, proven end to end by `envelope.e2e.test.ts`), and owns **everything after the order**, on tables keyed `order_item_id` that never add a column to the envelope. The catalogue is two-level — an **orderable** (one `services` row, one order item, one tariff line) expands into **analytes** (the resultable things), which is how a profile and a standalone test can share a CBC and be told apart (§6A.3 closed, for lab). **Money is posted at ORDER time at the lab desk**, in ONE transaction with the placement, under the route's `Idempotency-Key` (§6A.2 closed); items the counter never sees — reflex, add-on, walk-in accession — are invoiced by the lab at creation and the **delivery interlock** (print/WhatsApp held until the self-pay line settles; the doctor's screen never held; TPA/PMJAY/corporate/day-care exempt; override = `billing_manager` approval leaving the dues where they already are) is the collection mechanism — that is **02 O-1, ruled here**. **Reflex testing runs SYNCHRONOUSLY inside the verifying transaction** as a `system` actor with `protocol_ref`, in the API process where the encounter resolvers are registered — so this plan places **no order from the worker** and §6A.1 is closed by not needing it, with the alternative recorded. **An add-on is a NEW order in the same `order_group_id`** on the same tube (`origin:'addon'`, `parent_item_id` across orders), so no `INSERT INTO order_items` and no kernel `addOrderItem` (§6A.5/§6A.7 avoided, not solved). **Cancellation money (02 O-4, ruled here): `cancelled_from='placed'` refunds automatically by credit note; `cancelled_from='in_progress'` with a result row keeps the charge — the legacy "no pathology refund once the result is saved", as a one-column read; a rejected sample recollects free and a 7-day non-return cancels with refund.** The envelope's `completed` fires at VERIFICATION; publication is the report's own state. QC/calibration/reagent lots/Levey-Jennings go to **17-E** with the analyzers they lock; cultures and send-outs to **17-M**; histology to **17-H**; the notifiable-disease and incident REGISTERS to **28a** (the lab emits the flag). **Nine tasks, LIGHT lane, migration `0046` as a measurement.** — **SUPERSEDED 2026-08-29 BY THE OWNER'S RE-CUT: T1 and T2 shipped here (`39beff0`); T3–T5 are now [`17a`](2026-08-29-phase1-17a-lims-order-to-accession.md) and T6–T9 are [`17b`](2026-08-29-phase1-17b-lims-result-to-report.md). See §5 and the HANDOFF.**

**Numbering:** [`00-INDEX-AND-SYNTHESIS.md`](../brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md) §3 — `17` LIMS core · `17-E` analyzer edge · `17-M` microbiology · `17-H` histopath; 24a/24b home collection; 26 packages. **Brainstorm argued from, not restated:** [`02-central-lab-lims.md`](../brainstorms/2026-08-27-department-series/02-central-lab-lims.md) §1 (scope table, locked spec decisions), §2 (roles), §3.1/§3.2 (the two definitions), §4 (data sketch), §5 (the 129-row catalogue, cited by id below), §13 (O-1…O-12), §14 (the T1–T10 sketch this plan re-cuts), §15. **Owner rulings register** (`/opt/hmis-context/brainstorm-2026-08-27/00-OWNER-RULINGS-REGISTER.md`): *"nothing here is RULED; an owner ruling is 'adopt default' unless written otherwise"* — defaults are adopted and marked DECIDED under the owner's standing rule of 2026-08-28; money/procurement/law items are named in §4A.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — **at line 1485 as of 2026-08-29 17:52 UTC (measure: `grep -n '^## 5' docs/superpowers/plans/reports/EXECUTION-LESSONS.md`; it moved 1323 → 1485 in one day)**. Never the ledger whole: **407,657 bytes ≈ 102k tokens**, re-billed on every tool call (v3 §9.1). Entries cited by number: §2.54 (one list, one owner), §2.115 (fresh, not resumed), §2.131/§2.133/§2.138 (sibling-grep, directory+glob, grep the LIST), §2.137 (name the test database), §2.139 (assert on the argument, never `not.toHaveBeenCalled()` with a `Db`), §2.140 (the second reviewer is not optional).

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Nine tasks, one migration, four screens and one print component, two workflow definitions, one approval type, four roles. It is a full-module build, which v3 §2 names as LIGHT's *edge* rather than its home — but Plans 14 and 15 (nine tasks each, ten-table modules with four screens) both ran LIGHT to code-complete, and the review terms that made them correct are budgeted below. **Five of nine tasks are CRITICAL** (a formula/range engine that can print a wrong number, a money-plus-idempotency seam, a concurrency-and-money seam at accession, a verification seam with SoD and a synchronous reflex placement, and a confidentiality-bearing interlock), and CRITICAL means executed mutants in either lane.

**The refutation condition, written now:** if the executing session's context passes ~60% before T6 is committed, it hands off AT A TASK BOUNDARY per v3 §9.6 (typecheck → narrowest suite → note) rather than re-tiering mid-phase. A second session picking up from T6 is cheaper than a HEAVY compile.

> **IT FIRED, AT T2 RATHER THAN T6, AND THE CONDITION WAS THE WRONG ONE.** The clause watches CONTEXT; what ran out was the STOP-LOSS, at 66% after two ROUTINE tasks — because its per-task term measured a reviewer and not the coder (§9.7, ledger §2.141). The session handed off at the T2 boundary as the rule intended, and the owner re-cut the remainder into 17a and 17b. **The lesson for the next phase document: a refutation condition on context is not a refutation condition on budget, and a LIGHT phase needs both.**

**The main session codes task by task** under AGENT-RULES, runs `pnpm typecheck && pnpm lint` before every verify (§9.9 rule 6), folds code-complete tasks into one verify per batch (rule 4), takes its OWN test databases and NAMES them (rule 8, §2.137), watches CI by full SHA, and closes with reviewers **spawned FRESH** (§9.5, §2.115). The close reviewer is briefed at the operands (§9.7): *for every "already paid", "already collected", "already verified" and "already exists" check — `deliveryAllowed`, the accession CAS, the verify SoD, the duplicate detector, the idempotent counter route — name what it queries and which writes it would miss.* **Money file first:** `modules/lab/money.ts`, then `interlock.ts`, then `desk.ts`.

### Stop-loss (v3 §6): **730,000 tokens**, arithmetic shown

`stop-loss = 1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`

- **Per-task rate — 20,178**, Plan 16a's LIGHT baseline ([`../pipelines/token-baselines.json`](../pipelines/token-baselines.json), phase `16a`: 181,605 / 9), carried by 14, 22c-A and 17 phase 0. Bias restated: in a LIGHT phase `subagentTokens` IS the reviewer, so this is review cost in execution clothing; main-session cost is unmeasurable from inside (runbook O3).
- **Task term:** `1.5 × (20,178 × 9) = 272,403`.
- **Review term — TWO FRESH passes: `244,568 + 213,923 = 458,491`**, Plan 14's measured pair (phase 0's two fresh passes came in at 348,043 — 24% under the same term — and pass 2 found a live confidentiality leak pass 1's fix had created, §2.140). Two, not one: 09a, 13, 14, 15 and 17-phase-0 each found their worst late defect inside the first pass's remediation.
- **Total: 730,894 → 730,000.** Identical to Plan 15's, which had the same shape and came in at 463,509 with 36% headroom unused.

### Context budget (v3 §9.2), measured before compiling — re-measure at kickoff

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | re-`wc -c` at kickoff | — |
| `AGENT-RULES.md` | `wc -c docs/superpowers/AGENT-RULES.md` at kickoff (phase 0 measured 26,563) | ≈ 6,600 |
| phase 0 §6/§6A/§8 only (lines 297–374) | ≈ 12,000 | ≈ 3,000 |
| ledger §5 only (from line 1485, ~15 lines) | ≈ 3,800 | ≈ 950 |
| `kernel/orders/{kinds,place,advance,read}.ts` — the seam every task calls | measure | — |
| **NOT pointed at:** phase 0 whole (112,649) · the ledger whole (407,657) · brainstorm 02 whole (98 KB) | — | **≈ 155k avoided** |

---

## 1. Why this phase

### 1.1 What exists, and what does not

The envelope exists and is empty: `kinds.test.ts:140` pins the claimed kind set as `[]`, and production has 0 orders because no manifest claims a kind. `opd_encounters.advised_tests` (07d) carries the doctor's demand signal as `{serviceId, code, name, pricePaise}[]` and **nothing converts it** — `advisedTests` appears in `apps/web/src/screens/opd-consult.tsx` and `rx-print.tsx` and in no counter screen. `EPISODE_SERIES.lab_specimen` (`S`) has been reserved since 2026-08-25 and minted by nobody. `RESOURCE_KIND_VALUES` carries `bench` and `analyzer` (Plan 13 DD4: *"Plan 17 claims `bench` and `analyzer`"*) and no manifest declares either. There is no `services` row of category `investigation` in any seed script (five categories seeded: consultation, device, pharmacy, procedure, room_rent). **Nothing lab-shaped exists in code beyond the letters and the envelope.**

### 1.2 Why this cut — DECIDED

Brainstorm §14 sketched ten tasks including QC/lots, send-outs and registers. This plan cuts at the **manual-first pipeline the roadmap line names** — *order/accession/result/verify/report; sex- and age-based reference ranges; formula results; report-blocked-until-paid interlock; manual result entry first* — because (a) every one of QC lockout, Levey-Jennings, reagent-lot-to-result and calibration-due is a property of an ANALYZER and is meaningless until 17-E's first driver gives the system one to lock; the paper QC log the lab keeps today is NABL-adequate until then (R-021: apply after six months of live data); (b) send-outs exist today only because cultures are outsourced (R-023), and 17-M's entire subject is the culture; (c) registers are the quality pack's shape (INDEX §3 folds 02's NABL pack into 28). The lab that this plan ships can run a day: the doctor advises, the desk orders and bills, the phlebotomist draws against a scanned token, the bench accessions and keys results, the pathologist verifies, the report prints or reaches WhatsApp when paid, and a critical potassium is phoned and read back. That is the pilot-as-secondary window the roadmap asks for.

### 1.3 What this phase does not do

No analyzer interface, no QC, no reagent lots (17-E). No cultures, no send-outs, no antibiogram (17-M). No histology (17-H). No home-collection site logic beyond `collection_site` being a column (24a). No packages (26). No patient-app reads (22c-F). No auto-verification ACTIVATION — the engine ships with zero active rules and its activation is Class-A config after a parallel run (R-022). No LOINC LOAD — `loinc_code` is a nullable column awaiting licensed content (spec §9). No PDF renderer — the report is a signed JSON snapshot rendered by the print component; a stored PDF is 17-E's or 22c-F's decision when a consumer needs bytes. No new episode series letter, no new resource kind, no new encounter letter (the walk-in is a `V` visit, phase 0 E9). No kernel edit beyond the three named in §5 T2.

---

## 2. Ground truth — measured 2026-08-29 17:52 UTC on the build host, HEAD `9ecca61` (AGENT-RULES §6)

Every row is a command. **Re-run every row at kickoff**; Lane B may have moved rows 1, 2, 3, 4, 5 and 12 by then, and that is expected rather than a defect.

| # | fact | value today | how |
|---|---|---|---|
| 1 | migrations in the journal | **46** (`0000`–`0045`); this phase writes **`0046`** | `python3 -c "import json;j=json.load(open('apps/core/drizzle/meta/_journal.json'));print(len(j['entries']), j['entries'][-1]['tag'])"` → `46 0045_order_envelope_integrity` |
| 2 | manifests installed | **17** `Manifest,` lines; `manifests.test.ts:144` pins `toHaveLength(17)` and `:113` the ordered key list | `grep -c 'Manifest,$' apps/core/src/kernel/modules/manifests.ts` |
| 3 | claimed order kinds | **`[]`** — `kinds.test.ts:140` | `grep -n 'claims no order kind' apps/core/src/kernel/orders/kinds.test.ts` |
| 4 | permission census | **111** declared (`seed-roles.test.ts:633` — was `:611`), reachability `111 = 91 held + 20 not yet modelled` (`:768`, was `:739`); **values unmoved by Lane B's `b657a66`, line numbers moved** | `grep -n 'toHaveLength(111)\|91 held' apps/core/test/seed-roles.test.ts` |
| 5 | role census | **27** keys in `ROLE_MODEL`; `KNOWN_ROLE_KEYS` in `test/seed-staff.test.ts:136` says "twenty-seven" | `grep -c 'roleKey: "' apps/core/scripts/seed-roles.ts` |
| 6 | places that COUNT the manifest list (§2.138) | **88 lines across 31 files** (kickoff re-measure; the authoring figure of 34 was wrong, not moved) | `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts \| grep -v /dist/ \| grep -v 'manifests.ts:' \| wc -l` |
| 7 | `bench` / `analyzer` in the closed kind set, declared by nobody | present at `schema/resources.ts:87`; `grep -rn '"bench"' apps/core/src/modules --include=manifest.ts` → 0 | as stated |
| 8 | `withIdempotency` | `modules/billing/idempotency.ts`, exported at `billing/index.ts:17`; `idempotency_keys` unique on `(actor_id, route, key)` | `grep -n 'withIdempotency' apps/core/src/modules/billing/index.ts` |
| 9 | encounter-resolver registrants, and the worker | `opd.module.ts:59` exports `registerOpdEncounterResolver()`, `ot.module.ts:45` exports `registerOtEncounterResolver()`; `worker.module.ts` calls neither and has no `imports:` | `grep -rn 'export function register.*EncounterResolver' apps/core/src --include=*.ts` |
| 10 | `PhiSurface` union | `kernel/phi/audit.ts:15`; `recordPhiAccess` at `:108`, never throws | `grep -n 'export type PhiSurface' apps/core/src/kernel/phi/audit.ts` |
| 11 | `advised_tests` consumers in the SPA | `opd-consult.tsx:169`, `rx-print.tsx`; **no counter screen** | `grep -rln 'advisedTests' apps/web/src --include=*.tsx` |
| 12 | web screens / router paths | **35** screen modules (70 files incl. tests) / **35** `path:` lines in `router.tsx` (kickoff re-measure; the authoring figure of 33 was wrong, not moved) | `ls apps/web/src/screens \| grep -vc test; grep -c 'path:' apps/web/src/router.tsx` |
| 13 | test files | core **286**, web **56** | `find apps/core/src apps/core/test -name '*.test.ts' \| wc -l; find apps/web/src -name '*.test.ts*' \| wc -l` |
| 14 | `intendedPayer` vocabulary | `self \| tpa \| pmjay \| corporate` — `schema/opd.ts:237` | `grep -n 'intended_payer' apps/core/src/kernel/db/schema/opd.ts` |
| 15 | OPD visit kinds | `walk_in \| appointment` (`opd/events.ts:59`); `openVisitInTx` takes `patientId, departmentId, doctorId` (`encounters.ts:34`) | `sed -n '34,40p' apps/core/src/modules/opd/encounters.ts` |
| 16 | the envelope's per-item extension hooks | `order_items(id, order_id, service_id, status, origin, parent_item_id, restricted, cancelled_from, cancel_reason …)`; indexes `(service_id, created_at)`, `(order_id)` | phase 0 §4.1; `grep -n 'index(' apps/core/src/kernel/db/schema/orders.ts` |
| 17 | `truncateAll` statement carrying the envelope | `test/helpers/db.ts:269` and `:301` — `order_item_transitions, order_items, orders` ride the patients/billing statement | `grep -n 'order_item_transitions' apps/core/test/helpers/db.ts` |
| 18 | private test databases | `db.ts:32-37` derives `<base>_<workerId>` from `TEST_DATABASE_URL` | `sed -n '31,38p' apps/core/test/helpers/db.ts` |
| 19 | ledger §5 line / size | **1485** / **407,657 bytes** | `grep -n '^## 5' docs/superpowers/plans/reports/EXECUTION-LESSONS.md; wc -c …` |
| 20 | `services` categories any seed creates | consultation, device, pharmacy, procedure, room_rent — **no `investigation`** | `grep -rhoE 'category: "[a-z_]+"' apps/core/scripts/*.ts \| sort -u` |
| 21 | foreign files in the tree | `?? docs/design/` **and `?? .ci-watch.log`** (another session's; not this lane's to stage) | `git status --porcelain` |
| 22 | approval-type shape | `ApprovalTypeSpec { typeKey, title, approverRole, urgencyClass?, actFirstAllowed? }` at `kernel/approvals/types.ts:39`; registration needs the `approval_<typeKey>` definition ACTIVE first | `sed -n '39,45p' apps/core/src/kernel/approvals/types.ts` |

**Row 1 is the row Lane B will move.** Protocol §7: re-check `_journal.json` immediately before AND after `db:generate`, state the number taken in the commit message, and on a collision renumber YOURS — never the one already pushed.

---

## 3. Spike — questions written now, answered at kickoff, recorded in §9.3

Answer by reading code and read-only SQL. None changes the ruling; each sizes a task, and two (S1, S2) change T4's code.

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | `issueInvoice` (`billing/invoices.ts:712`): which actor types does it accept, which permission does it check, and is an invoice with NO `receipt` legal without `credit: {reason}`? What does `settlementState` (`billing/settlement.ts`) key on — invoice or line? | T4 issues the counter invoice in the placement transaction; T7's interlock reads settlement. If unpaid-without-credit is refused, the lab-issued lines (reflex/add-on/walk-in) carry `credit: {reason: 'lab_deferred'}` and the dues instrument is the receivable — which is exactly what R-252 asked Plan 08 for and what `/billing/dues` already shows |
| **S2** | Are `opd_encounters.doctor_id` and `department_id` NOT NULL? Is there a departments master to seed a `LAB` department into? What does `openVisitInTx` do with `referralSource: 'external_rmp'` + `referrerName`? | T4's walk-in visit: if `doctor_id` is NOT NULL the pathologist is the visit's responsible doctor (DD6); if the department master is data, the seed creates `LAB` |
| **S3** | In Plan 09's partner book, can a counterparty of referrer class (c) — "no payout structurally" (02 D9) — be created and referenced by `orders.external_referrer_id`? What does `attribution.ts` export for "unverified attribution"? | T4's outside-slip walk-in needs a `partners.id` to satisfy phase 0's `authority='external_prescription' ⇒ external_referrer_id NOT NULL` CHECK; the seeded sentinel `EXTERNAL_UNATTRIBUTED` is the fallback and must be class (c) |
| **S4** | `startInstance` / `transition` signatures (`workflow/instances.ts:38,72`) and what `defineWorkflow`'s per-transition `roles` mean at runtime — is the role check inside `transition` or the caller's? The OT's `daycare_case` is the precedent | T4's two definitions and T6's SoD: if the engine checks roles, the definitions carry `pathologist` on `verify`; if the caller does, T6's guard does |
| **S5** | Read-only, production: `select count(*), count(distinct e) from opd_encounters, jsonb_array_elements(advised_tests) e where advised_tests is not null` and whether every `serviceId` in it resolves to a `services` row | The demand signal; also whether T4's converter meets an orphan `serviceId` on day one |
| **S6** | `nextEpisodeNo(tx, 'lab_specimen', '2026-08-29')` on a scratch database → `S2608290001`? and `episode_series`'s unique key | T5 mints `S` numbers; the format is inherited, not designed |
| **S7** | How is a notification template registered (`templateByKey`), and can a `patient`-audience transactional template carry a token-only body with no result values? Is there a QR/link target for a report before 22c-F ships? | T7 publishes "report ready — collect at counter / your doctor has it" with NO values in the message (02 J3, R-020); the deep link is 22c-F's and is `null` until then |
| **S8** | `docs/design/` — is the "Laboratory report A4" design (session S1442) committed by kickoff, and under what path? | T8's print component copies its layout if present; otherwise `rx-print.tsx` is the precedent |
| **S9** | Does a `system` actor pass `placeOrder`'s guard with `authority:'protocol'` when the kind declares `requiresClinician: true` — i.e. does a reflex order need an `ordering_clinician_id`, and is the verifying pathologist the right value? | T6's synchronous reflex placement; phase 0 DD6 says `system` needs `protocol_ref`; whether the clinician column is ALSO required is read from `place.ts`, not remembered |

---

## 4. Design decisions — DECIDED, each with its reasoning (owner standing rule 2026-08-28)

**DD1 — Two-level catalogue: ORDERABLE → ANALYTES.** `lab_orderables` is keyed by `service_id` (one orderable = one `services` row of category `investigation` = one order item = one tariff line); `lab_analytes` are the resultable quantities (Hb, SGOT, LDL); `lab_orderable_analytes` maps each orderable to its analytes in report order. A standalone CBC and a "Fever Profile" containing CBC are two orderables sharing twenty analytes. Reasoning: this is the LIS-standard shape (orderable vs. resultable) and it is what closes §6A.3 for the lab — the duplicate detector compares ANALYTE SETS, not `service_id`s, so `findRecentItems`'s exact-match blindness inside a profile is answered by the module whose subject it is. Packages (26) compose orderables; they do not need to know analytes.

**DD2 — Reference ranges are resolved at RESULT ENTRY and SNAPSHOTTED on the result row.** `lab_reference_ranges(analyte_id, sex, age_min_days, age_max_days, low, high, text, source, effective_from)`; resolution takes the patient's age **at collection time in IST** (02 B8) and `administrative_gender`, with `sex='any'` as the fallback and a report footnote when DOB is estimated (`dob_estimated`, 02 H4) or sex is `other`/`unknown` (02 H5). The result stores `ref_low/ref_high/ref_text` and the range row id. Reasoning: a range table edit must never rewrite a published flag; NABL wants the range the report was signed against, not the current one.

**DD3 — Formula results are computed by a guarded evaluator over sibling analytes of the SAME specimen, never across specimens.** `lab_analytes.formula` is a small expression (`+ - * /`, numbers, sibling codes) with `formula_guard` (e.g. `TG < 400` for Friedewald LDL); a failed guard yields `value_text = 'not calculable'` with the guard named (02 H3), never a number. Reasoning: the wrong number this engine can produce is silent and clinical; a guard that yields text is the only honest failure.

**DD4 — The lab's pipeline is TWO workflow definitions, projected onto the envelope at three milestones.** `lab_item` (brainstorm §3.1, minus the payment states — see DD6) and `lab_specimen` (§3.2) run on the kernel engine as `daycare_case` does; `advanceOrderItem` is called at **accession → `in_progress`**, **verification of the last analyte → `completed`**, and **cancellation → `cancelled`**. Reasoning: phase 0 §6.3 — the envelope's four states are the projection, the module's stages live in its own definitions; `completed` at verify (not publish) because publication is a delivery act that the interlock can hold indefinitely, and 22c-F reads `completed` items "whose module has published" — two facts, two fields.

**DD5 — `S` numbers are minted on `lab_specimens` from `nextEpisodeNo('lab_specimen', serviceDate)`; a specimen serves N items and an item is served by its CURRENT specimen.** `lab_specimen_items(specimen_id, order_item_id, active)`; a rejection creates a new specimen (new `S`) for the same items and flips `active`. Reasoning: `series.ts`'s own header — one order, several tubes; one tube, several tests; a haemolysed tube redrawn without cancelling the order.

**DD6 — MONEY IS POSTED AT ORDER TIME AT THE LAB DESK, in the placement transaction; items the desk never sees are invoiced by the lab at creation; the DELIVERY INTERLOCK is the collection mechanism (02 O-1 — RULED HERE, adopting R-002's default).**
- The desk route (T4) does `placeOrder` + `issueInvoice` (+ `receipt` when the patient pays there) in ONE transaction under `withIdempotency`; `lab_items.invoice_id/invoice_line_id` are written in the same statement. A retried click returns the same `order_no` and the same invoice (§6A.2).
- Reflex (T6), add-on (T4) and walk-in accession without a prior invoice (T5) call `issueInvoice` with `credit: {reason: 'lab_reflex' | 'lab_addon' | 'lab_walkin'}` — S1 decides whether the `credit` clause is needed for an unpaid invoice; either way the receivable is billing's dues instrument, which `/billing/dues` already lists (R-252 is inherited, not re-ruled).
- **Collection is NEVER blocked by payment.** Reasoning: throughput and safety — a phlebotomist waiting on a cashier is the queue the OPD redesign just removed; and the tube is the perishable thing.
- **`deliveryAllowed(item)`** (T7): `intendedPayer='self'` on a `V` encounter ⇒ every self-pay line on the report's items must be `settled` (S1's `settlementState`); `tpa | pmjay | corporate` ⇒ allowed; a `D` encounter ⇒ allowed (the day-care bill is composed at discharge, Plan 15 T7); ER/IPD do not exist yet and inherit "allowed" by the same clause when they do (02 D3). **The doctor's screen and the verification queue NEVER consult it.** Override: approval type `lab.release_unpaid` (approver `billing_manager`), evented `lab.report_released_unpaid`, the dues row untouched — it was already the receivable.
- Reasoning: the legacy harvest wants the interlock; patient safety forbids hiding results from clinicians; and a corporate hospital's lab counter takes money — so the desk is a cashier with a session, reusing 07c's counter machinery rather than a second drawer.

**DD7 — CANCELLATION MONEY (02 O-4 — RULED HERE, adopting R-016's default, as a one-column read).** On `order_item.cancelled`: `cancelled_from='placed'` ⇒ automatic credit note for that line (`issueCreditNote`, reason `lab_cancelled_before_collection`), evented; `cancelled_from='in_progress'` AND a `lab_results` row exists for the item ⇒ **charge stands** (the legacy "no pathology refund once the result is saved"); `cancelled_from='in_progress'` with NO result row (cancelled between accession and entry, or a rejected-and-never-recollected sample after 7 days) ⇒ refund. The exception path is billing's existing credit note with approval and a reason (02 D4). Reasoning: R-016's default is the industry norm and phase 0 DD5 made the stage a stored column precisely so this rule needs no history walk.

**DD8 — REFLEX RUNS SYNCHRONOUSLY, IN THE VERIFYING TRANSACTION, IN THE API PROCESS (§6A.1 — RULED).** When a verified result matches an ACTIVE `lab_reflex_rules` row (analyte, comparator, threshold, adds orderable), T6 calls `placeOrder` **inside the same transaction** with actor `{type:'system', id:'lab-reflex'}`, `authority:'protocol'`, `protocol_ref = rule id`, `origin:'reflex'`, `parent_item_id`, `orderingClinicianId = the verifying pathologist` if S9 says the kind's `requiresClinician` binds a `system` actor, and the charge per DD6. The item is attached to the SAME specimen if its `specimen_type` matches and the tube is not disposed (02 B4), otherwise a recollection task. **Order-time consent** (spec, locked): the desk shows "reflex tests may be added and billed" and stores `lab_items.reflex_consented_at`; a rule fires only when the parent item carries it.
*Why not the worker:* the worker has no encounter resolver (§6A.1) and this plan has NO caller that needs to place from it — the only worker jobs here are the 7-day non-return sweep and the TAT sweep, which `advanceOrderItem`/emit and never resolve an encounter. *The alternative, recorded:* two lines in `worker.module.ts` calling the two exported `register*EncounterResolver()` functions (row 9 — plain functions, no Nest import) plus a parity test on `registeredEncounterPrefixes()`. It is cheap, it collides with Lane B on a file both lanes edit, and nothing in 17 or 18a exercises it — **the plan that first places from the worker (26's package composition if it moves there; 49's standing orders) owes it, and §6 says so.** A worker job that nonetheless calls `placeOrder` today fails loudly with `unknown_encounter`, which is the right failure.

**DD9 — AN ADD-ON IS A NEW ORDER IN THE SAME GROUP (§6A.5/§6A.7 — RULED).** "Doctor adds two tests at the chair" (02 D1) and "add-on three days later" (02 B4) both create a new `orders` row with the parent's `order_group_id`, `origin:'addon'`, `parent_item_id` pointing across orders (phase 0 E2's shape, applied to the open case too), attached to the existing specimen via `lab_specimen_items` when the tube is suitable and not disposed, else a recollection. Reasoning: it avoids the one write into the envelope that has no CAS and no guard and the FOR KEY SHARE / FOR UPDATE interaction §6A.7 predicts; the L-number-per-requisition is what Indian labs print anyway; and the kernel `addOrderItem` the envelope's review asked for is then owed by nobody until a plan needs the same header — which this one does not.

**DD10 — Right-patient scan before the label prints; unscanned collections cannot accession without the identity re-check.** The chair screen calls a token QR or UHID scan; the label API refuses when the scanned UHID ≠ the queue-called UHID (02 A1, `lab.tube_mismatch_flagged`); a ward collection without `wristband_scanned` reaches `received` only with `identity_recheck_by` set at accession (02 A2). Reasoning: spec §11.6's "chair-side barcode labels + right-patient scan before draw" is locked; the two-Ram-Kumars case is the one every lab has had.

**DD11 — Verification is a human act with SoD, and auto-verification ships DISABLED.** `verifyResult` refuses when `verified_by = entered_by` (02 §2 SoD pair; `lab.sod_violation_blocked`) unless the active `lab_item` definition's `single_operator_night_mode` flag is on for the shift, in which case the verify carries `pathologist_review_pending=true` and lands in the morning queue (02 F2). The auto-verify engine (rule = analyte + range-in + no delta flag + no absurd flag + interfaced source) ships with **zero active rules** and `entry_mode='interface'` does not exist until 17-E — so nothing can auto-verify in this phase by construction, and R-022's parallel run is 17-E's. A `system` verify is refused outright here. Reasoning: NABL permits documented technologist release; it does not permit a system releasing a manually keyed number.

**DD12 — Critical values: flag at entry, call ladder as a record on the result, read-back closes it; night release per R-014's default.** `lab_analytes.critical_low/high` (age-band overrides in `lab_reference_ranges.critical_low/high`); entry outside the critical band opens `lab_critical_calls(result_id, opened_at, attempts jsonb[], readback_text, closed_by, closed_at)` and emits `lab.result_critical_flagged`. The item may be VERIFIED by a technician as `preliminary_tech_released=true` when the source is an analyzer that passed QC — which is 17-E's — so in THIS phase every critical goes to the pathologist's queue with the call already opened by the tech (the call does not wait for the verify). Reasoning: the 15-minute clinical need is the call, not the signature; the signature follows by 09:00.

**DD13 — Reports are versioned JSON snapshots; amendment is a new version, never an edit; the print component renders.** `lab_reports(order_id, version, status: draft|published|amended|superseded, snapshot jsonb, signed_by, signed_at, published_at, amendment_reason_code, prior_version_id)`; `lab_results` rows are immutable once verified (trigger, the `patient_identity_forbid_mutation` precedent) and an amendment inserts a new result row with `supersedes_result_id` and a new report version. Re-notification says "AMENDED — please consult your doctor" with a reason CATEGORY (R-018). Reasoning: spec §11.6 "amended reports versioned, never overwritten"; an edit endpoint must not exist (02 H8).

**DD14 — Confidentiality: `restricted` at placement for consent-class tests; sensitive tests are in-person only; sealed patients alias everywhere the kernel does.** `lab_orderables.consent_required` (HIV — NACO/ICTC) ⇒ the desk records `lab_items.consent_recorded_at/by` before the item can be collected (02 E1) and sets `restricted:true` on the envelope item at placement (phase 0 §6.6); `lab_orderables.sensitive` (HIV, HBsAg, pregnancy, STI, genetic) ⇒ `publish_channels` is forced to `in_person` (02 J3). Every lab reader that returns a patient name goes through the kernel's alias rule (`read.ts` E17) and calls `recordPhiAccess` with the new surfaces `lab.results` / `lab.report` (§6A.8). Reasoning: the kernel reader already hides restricted items; the lab must not become the route around it.

**DD15 — The walk-in is a `V` visit opened in the `LAB` department by the desk; the responsible clinician for an outside slip is the pathologist; the referrer is a Plan 09 counterparty or the seeded sentinel.** `openLabWalkin(tx, actor, {patientId, referrer: {partnerId} | {name, unattributed:true}, rxImageRef?})` lives in `modules/opd/` (exported, the module owning `V`), sets `referralSource:'external_rmp'`, and the order carries `authority:'external_prescription'`, `external_referrer_id` (the partner or `EXTERNAL_UNATTRIBUTED`), `ordering_clinician_id = the lab's pathologist of record`. Without an Rx image or patient confirmation the desk emits `attribution.unverified_flagged` (02 I3). Reasoning: phase 0 E9 ruled the letter; the CHECK on `external_referrer_id` forces a row; class (c) referrers accrue nothing (02 D9), so the sentinel is money-safe.

**DD16 — Roles: four new, mapped to S10 cards.** `pathologist` (16), `lab_technician` (17), `phlebotomist` (36), `lab_reception` (front office + cashier grants, NO `lab.results.*`). `doctor` gains `lab.orders.place` and `lab.results.read`; `ot_incharge`/`surgeon` gain `lab.orders.place` (pre-op panel, 15). Permissions declared on the manifest: `lab.orders.place`, `lab.catalogue.read`, `lab.catalogue.manage`, `lab.desk.operate`, `lab.collection.operate`, `lab.accession.operate`, `lab.results.enter`, `lab.results.verify`, `lab.results.read`, `lab.reports.publish`, `lab.reports.print`, `lab.reports.amend`, `lab.reports.release_unpaid`, `lab.criticals.close`, `lab.worklist.read`. Kernel `orders.place`/`orders.read`/`orders.cancel` are granted to the same roles by the seed (phase 0 §8.11: grants are runbook acts, and the seed IS the runbook's instrument in dev; production grants are named in §9.9's deploy block).

**DD17 — Resource kinds: the manifest declares `bench` and `analyzer` with their status vocabularies now, and uses `bench` only.** `bench`: `available | occupied | closed | retired`; `analyzer`: `available | in_use | qc_locked | calibration_due | maintenance | interface_down | retired` (02 §3.7). The bench worklist is keyed by `lab_orderables.bench_key` → a `resources` row. Reasoning: Plan 13 DD4 assigns both to 17; declaring `analyzer` here means 17-E adds no kernel kind and no manifest vocabulary, only drivers. `collectResourceKinds` in both processes is the live refusal for a duplicate (row 7: today nobody declares either).

**DD18 — Events (`entity.verb_past`, phase 0 row 11), subscriber named per 00 §5.** `lab.order_desked` (the desk's conversion, with invoice ids — 24a ignores), `lab.label_printed`, `lab.tube_mismatch_flagged`, `lab.specimen_collected`, `lab.specimen_received` (**the TAT clock**), `lab.specimen_rejected`, `lab.recollection_requested`, `lab.result_entered`, `lab.result_verified`, `lab.result_critical_flagged`, `lab.critical_acknowledged`, `lab.result_delta_flagged`, `lab.reflex_added`, `lab.report_published`, `lab.report_print_blocked`, `lab.report_released_unpaid`, `lab.report_printed`, `lab.report_amended`, `lab.sla_breached`, `lab.notifiable_flagged` (28a subscribes when it exists), `lab.sod_violation_blocked`. Consumed: none in this phase (`subscriptions: []`); `patient.merged` re-linking is the envelope's (phase 0 E8) and the lab's tables key by `order_item_id`, so nothing to re-link.

**DD19 — Idempotency on every document-creating lab route, keys minted where the web client already mints them.** `desk.place`, `collection.collect`, `accession.receive`, `accession.reject`, `results.enter`, `results.verify`, `reports.publish`, `reports.amend`, `reports.print` take `Idempotency-Key` through `withIdempotency` imported from `../billing` (row 8). The lift to `kernel/` is NOT done here — Lane B would want the same edit, and a plain import costs nothing; §6 names it as owed by whichever plan touches the file for a third consumer.

**DD20 — Sweeps in the worker: two jobs, no placements.** `sweepLabNonReturn` (rejected sample, no recollection in 7 days ⇒ `advanceOrderItem(… 'cancelled', {reason:'no_recollection'})` + DD7 refund) and `sweepLabSla` (per-stage SLA from the active definition ⇒ `lab.sla_breached`, the §10.3 alert class). Both are `system` actors calling `advanceOrderItem`/emit only. The unpaid-24h TTL cancel from brainstorm §3.1 is **NOT adopted**: collection is not payment-gated (DD6), so an unpaid order simply never delivers.

**DD21 — Screens: four, plus one print component; the doctor's cockpit gains ONE panel.** `/lab/desk` (walk-in + convert advised tests + bill + print labels for the queue), `/lab/collection` (phlebotomy queue, call, scan, label, collect, ward-round list), `/lab/bench` (accession scan, container check, reject, worklist by bench, manual entry grid with absurd/critical prompts), `/lab/verify` (pathologist queue, deltas, criticals with call ladder, verify, publish, amend, release-unpaid request). `LabReportPrint` (A4, signatory block, abnormal highlighting, QR = the report id, "AMENDED"/"PRELIMINARY"/"QC-SUSPECT" faces, Hindi names alongside codes per patient language). `opd-consult.tsx` gains a read-only "Results" panel over `lab.results.read` — the ONE OPD screen edit, and the doctor's view the interlock never touches.

---

## 4A. RULED, PROVISIONAL, AND ROUTED TO THE OWNER

**Ruled here, mine by the seed's §6:** 02 O-1 (DD6), 02 O-4 (DD7). **Adopted by default under the standing rule and marked DECIDED:** R-014 (night criticals, DD12), R-018 (amendment wording, DD13), R-022 (auto-verify activation — engine ships off), R-020 (no LLM text to patients — templates only, DD18/T7), R-035 (the walk-in rides `V`, DD15).

**Routed to the owner — none blocks a task, each is named because a later step meets it:**
1. **R-015 (procurement) — the reference-lab partner.** 17-M consumes it; nothing in 17 needs it.
2. **R-257 (vendor facts) — the analyzer inventory with protocols.** 17-E cannot be authored without it; DD17 declares the kind so nothing else waits.
3. **The lab's own DATA, which nobody can invent:** the existing lab's test catalogue (codes, names, specimen/container, TATs), its reference-range book and source, the price list mapped to tariff, the pathologist-of-record's name / degree / registration number for the signatory block, and three current report samples. T3 ships a **golden fixture catalogue of ~60 orderables / ~140 analytes** drawn from standard kit-insert ranges so the phase is executable; **production seeding is a runbook act on the owner's data** (§9.9), exactly as 07d's formulary was.
4. **R-017 (law) — adolescent sensitive results.** DD14's `sensitive` flag and the counselling-first flag are built; the release-to-guardian rule is applied as R-017's default and the owner is told it is law, not policy.
5. **R-021 (money) — NABL application timing.** Nothing in 17 depends on it.
6. **Production permission grants** for the four new roles and the three kernel `orders.*` permissions — runbook acts, as 22c-A DD7 and phase 0 §8.11 ruled, listed in §9.9 when it is written.

---

## 5. Tasks

**Files list discipline:** every task names its files; `git status --porcelain` is read before every `git add`; `docs/design/` and anything Lane B writes are never staged. **Kernel edits in this whole phase are exactly three, all in T2, all appends, all named in T2's commit message so Lane B can rebase rather than duplicate.**

### T1 — Migration `0046`: **thirteen** lab tables, two immutability triggers, `truncateAll` — **ROUTINE**

> **CORRECTED AT EXECUTION (finding F4a).** This heading said *fourteen*; the Produces list below
> enumerates THIRTEEN, the migration creates thirteen and `lab.test.ts` asserts thirteen. Amended in
> place rather than left standing, because §2.38's whole subject is an amendment that contradicts
> its own document and costs every later reader a paragraph.

**Files:** Create `apps/core/src/kernel/db/schema/lab.ts`, `lab.test.ts`, `apps/core/drizzle/0046_lab_core.sql` (+ snapshot, journal entry — generated, never hand-edited); Modify `apps/core/src/kernel/db/schema/index.ts`, `apps/core/test/helpers/db.ts`.

**Produces:** `lab_orderables` (`service_id` PK→`services`, `code`, `name_en`, `name_hi`, `discipline`, `specimen_type`, `container`, `min_volume_ml`, `bench_key`, `tat_minutes_routine`, `tat_minutes_stat`, `requires_fasting`, `consent_required`, `sensitive`, `notifiable`, `active`, `version`), `lab_analytes` (`id`, `code` UNIQUE, `loinc_code` NULL, `name_en`, `name_hi`, `result_type` CHECK `numeric|text|coded|formula`, `unit`, `decimals`, `formula`, `formula_guard`, `absurd_low`, `absurd_high`, `critical_low`, `critical_high`, `delta_abs`, `delta_pct`, `delta_window_hours`), `lab_orderable_analytes` (`service_id`, `analyte_id`, `position`; PK both), `lab_reference_ranges` (DD2 columns + `critical_low/high` overrides; CHECK `age_min_days <= age_max_days`, `sex IN ('male','female','other','any')`), `lab_reflex_rules` (`id`, `analyte_id`, `comparator` CHECK, `threshold`, `adds_service_id`, `active`, `version`), `lab_items` (`order_item_id` PK→`order_items`, `instance_id`, `service_id`, `invoice_id`, `invoice_line_id`, `charge_reason`, `consent_recorded_at/by`, `reflex_consented_at`, `priority`, `collection_site`, `identity_recheck_by`, `tat_started_at`, `tat_stopped_at`), `lab_specimens` (`id`, `specimen_no` UNIQUE, `order_group_id`, `patient_id`→`patients`, `specimen_type`, `container`, `status` CHECK over §3.2's vocabulary, `label_source` CHECK `printer|downtime_kit`, `collected_by`, `collected_at`, `wristband_scanned`, `collection_site`, `received_by`, `received_at`, `rejection_reason` CHECK over the closed list, `attributable_to` CHECK `collection|transport|lab|patient`, `recollection_of_specimen_id`, `stored_at`, `disposed_at`, `service_date`), `lab_specimen_items` (`specimen_id`, `order_item_id`, `active`; PK both; partial UNIQUE `(order_item_id) WHERE active`), `lab_results` (`id`, `order_item_id`, `analyte_id`, `specimen_id`, `value_numeric`, `value_text`, `value_coded`, `unit`, `flag` CHECK `L|H|LL|HH|A|N`, `ref_low`, `ref_high`, `ref_text`, `ref_range_id`, `ref_note`, `delta_flag`, `delta_prev_result_id`, `absurd_overridden_by`, `entered_by_type`, `entered_by_id`, `entered_at`, `entry_mode` CHECK `manual|manual_from_printout|interface`, `analyzer_id`, `verification_status` CHECK `unverified|verified|autoverified`, `verified_by`, `verified_at`, `pathologist_review_pending`, `rerun_of`, `supersedes_result_id`, `remarks`; CHECK: exactly one of the three value columns per `result_type`), `lab_reports` (DD13 + `publish_channels text[]`, `print_count`), `lab_report_deliveries` (`report_id`, `channel` CHECK `print|whatsapp|in_person|doctor_screen`, `delivered_by`, `collector_identity`, `approval_id`, `at`), `lab_critical_calls` (DD12), `lab_sla_breaches` (`order_item_id`, `stage`, `due_at`, `breached_at`, `notified`). Triggers: `lab_results_forbid_verified_mutation` (UPDATE on a row with `verification_status <> 'unverified'` raises, the `0043:79-81` shape), `lab_reports_forbid_published_mutation`. Indexes: `lab_items(instance_id)`, `lab_specimens(patient_id, collected_at)`, `lab_specimens(status, service_date)`, `lab_results(order_item_id, analyte_id)`, `lab_results(specimen_id)`, `lab_reports(order_id, version)` UNIQUE, `lab_critical_calls(closed_at) WHERE closed_at IS NULL`.

**`truncateAll`:** `lab_items`, `lab_specimen_items`, `lab_results`, `lab_reports`, `lab_report_deliveries`, `lab_critical_calls`, `lab_sla_breaches`, `lab_specimens` FK into `order_items`/`orders`/`patients`/`invoices` — **they join the statement at `db.ts:269/301` that already carries `order_item_transitions, order_items, orders`** (a table whose parent is truncated must be in that parent's OWN statement). `lab_orderables`, `lab_orderable_analytes`, `lab_reflex_rules` FK into `services` — the same statement if `services` is in it; measure with `grep -n 'services' apps/core/test/helpers/db.ts`. `lab_analytes` and `lab_reference_ranges` are an island pointing only at each other — their own statement (16a F2).

**Acceptance:** `lab.test.ts` asserts every CHECK and both triggers by execution (insert-then-expect-throw, the `orders.test.ts` shape); the migration applies from empty on a private database (rule 8) and the run NAMES it; `pnpm typecheck` green. No fail-first owed; say so.
**Commit:** `feat(core): lab core schema — catalogue, specimens, results, reports, critical calls (17 T1, migration 0046 as measured)`

### T2 — Module skeleton: manifest with the `lab` kind claim, permissions, roles, events, errors, approval type, PHI surfaces, the FIVE censuses — **ROUTINE**

**Files:** Create `apps/core/src/modules/lab/{index.ts, manifest.ts, kinds.ts, events.ts, errors.ts, approval-types.ts, lab.module.ts}` + tests; Modify `apps/core/src/kernel/modules/manifests.ts`, `manifests.test.ts`, `apps/core/src/kernel/worker/worker.module.ts` (install `labManifest` — it carries jobs, T5 — so `manifests.test.ts` leg 3 stays at six), `apps/core/src/kernel/orders/kinds.test.ts:140` (claimed set `['lab']` — **Lane B appends `imaging`; whoever lands second rebases**), `apps/core/scripts/seed-roles.ts` (four roles, grants per DD16, `NOT_YET_MODELLED` entries for anything unheld), `apps/core/test/seed-roles.test.ts` (per-module map, reachability census, sorted unheld literal), `apps/core/test/seed-staff.test.ts` (`KNOWN_ROLE_KEYS` 27 → 31), `apps/core/src/kernel/phi/audit.ts` (**kernel edit 1:** `PhiSurface` gains `"lab.results" | "lab.report" | "orders.patient"`), `apps/core/src/kernel/orders/read.ts` (**kernel edit 2:** ONE `recordPhiAccess(… surface:'orders.patient' …)` call inside `listOrdersForPatient` and `listOrdersForEncounter`, §6A.8; `read.test.ts` gains one assertion that a `phi_access_log` row appears), `apps/core/src/kernel/resources/kinds.test.ts:130` (**census, not an edit to kinds.ts:** the collected kind list gains `bench`, `analyzer`).

**Produces:** `labManifest` — `key: "lab"`, menu (four entries per DD21), the fifteen permissions of DD16, `subscriptions: []`, `orderKinds: [{ kind:'lab', seriesKey:'lab_order', placePermission:'lab.orders.place', requiresClinician:true, requiresIndication:false, selfOrderable:false }]` (phase 0 §6.8, byte-for-byte the `envelope.e2e.test.ts` fake), `resourceKinds` per DD17; `LAB_EVENTS` per DD18 with zod payloads; `LabError` with `toHttp` (Plan 09's specimen: every error code maps or the controller 500s); approval type `lab.release_unpaid` registered via `registerApprovalType` after its definition is drafted+activated (the OT precedent, `approval-types.ts`); `EXTERNAL_UNATTRIBUTED` partner seed per S3.

**The census grep, both halves (§2.131 + §2.138):** `grep -rn "otManifest" apps/core --include=*.ts | grep -v /dist/` for the places that NAME a sibling; `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts | grep -v /dist/` for the places that COUNT the list (row 6: 34 lines); `grep -rn "ot_incharge" apps/core --include=*.ts` for the role censuses. Directory and glob, never a file list (§2.133).

**Acceptance:** `pnpm --filter @hmis/core exec jest src/kernel/modules src/kernel/orders/kinds.test.ts src/kernel/resources test/seed-roles.test.ts test/seed-staff.test.ts` green on the named private database; `manifests.test.ts` leg 3 still enumerates exactly six differences; the API and the worker both boot (`collectOrderKinds` now returns one decl in both processes — assert it in `worker-runtime.e2e.test.ts`'s style). No fail-first owed.
**Commit:** `feat(core): lab module skeleton — the lab order kind claimed, permissions, roles, events, approval type; kernel: PhiSurface + orders reader PHI log (17 T2)`

### T3–T9 — **STRUCK 2026-08-29 AND RE-CUT INTO TWO PHASES, ON THE OWNER'S RULING**

**These seven task bodies and their five Assertion Books now live in two documents, and this section
is a pointer rather than a copy** — the rule-6 pattern this repository uses everywhere, and the fact
rule (§1) applied at document scope: a task defined in two places drifts by construction, which is
§2.54's own mechanism.

| tasks | now owned by | what it covers |
|---|---|---|
| **T3, T4, T5** | [`17a — order to accession`](2026-08-29-phase1-17a-lims-order-to-accession.md) §5 | the catalogue, the desk (order + invoice in ONE transaction, walk-in, consent, add-on, the two definitions), and the tube (labels, `S` numbers, right-patient scan, receive with the CAS and the TAT start, reject/recollect, the two sweeps) |
| **T6, T7, T8, T9** | [`17b — result to report`](2026-08-29-phase1-17b-lims-result-to-report.md) §5 | results with SoD verification and the synchronous reflex, reports with the delivery interlock and the amendment, the five controllers and four screens, and the gate report + go-live runbook for BOTH halves |

**WHY, in one paragraph.** T1 and T2 shipped as `39beff0` and consumed 66% of this phase's 730,000
stop-loss — a ceiling whose per-task term came from a REVIEWER's rate and never contained the main
session at all (§9.7, ledger §2.141, EXECUTE-METHOD-V3 §6 as amended the same day). Seven tasks and
two reviewer passes could not land in what remained, and the honest response to a tripwire is to
stop and re-plan rather than to re-tier mid-phase. **The cut is at a seam this document's own §6
already freezes** — an accessioned item is `in_progress` on the envelope with a tube carrying an `S`
number — so the halves are independently reviewable rather than merely smaller.

**THE TASK NUMBERS DID NOT RESTART.** 17a's tasks are T3–T5 and 17b's are T6–T9, because §9.2 and
§9.4 below cite `T4 A3`, `T4 A7`, `T5 A2`, `T6 A4` and `T7 A1` by number, and renumbering would put a
translation layer between a finding and the row it corrects.

**WHAT DID NOT MOVE, and is still read from THIS document:** §4 (the twenty-one design decisions),
§6 (the CONTRACT), §7 (the edge-case pass), §8 (the freezes), and all of §9 — the kickoff
measurements, the answered spike, the nine findings, the mechanical verification, and the handoff.
**Both new documents point here for those and restate none of them.**


## 6. THE CONTRACT — what 17-E, 17-M, 17-H, 24a, 26, 22c-F and 28a inherit from this phase

A downstream plan may write its phase doc against these sentences without reading this phase's code.

1. **The orderable is the `services` row; the analyte is the resultable; `lab_orderable_analytes` joins them.** Packages (26) compose orderables by `service_id` and never see analytes. 17-M adds `culture`-typed orderables whose "analytes" are organism/sensitivity rows in ITS tables, keyed `order_item_id`; 17-H likewise for cases. Neither adds a column to `lab_results`.
2. **A tube is `lab_specimens` with an `S` number; an item's CURRENT tube is the `active` row in `lab_specimen_items`.** 24a's home collection creates the specimen with `collection_site='home'` and hands it to `receive` by scanning `specimen_no` at the door; a `receive` for a tube whose every item is `cancelled` refuses `no_active_order` and the tube is quarantined — that is 02 M9, and the quarantine STATE is 24a's row on ITS table. 17-E's analyzers query by `specimen_no`.
3. **Results are immutable once verified; correction is a superseding row and a new report version.** 17-E's interface writes `lab_results` with `entry_mode='interface'`, `verification_status='unverified'`, `analyzer_id`; it never verifies. Auto-verification's activation (R-022) is 17-E's and runs only over `entry_mode='interface'` rows with no delta/absurd/critical flag — DD11's engine and its zero-rule seed are the seam.
4. **The envelope's `completed` means VERIFIED; `lab_reports.status='published'` means DELIVERABLE.** 22c-F shows an item when BOTH hold AND `deliveryAllowed` (a kernel-side read it must call — the patient actor's reader is 22c-F's own function, §6A.6). 26's package progress reads `order_item.completed` only.
5. **`deliveryAllowed(exec, orderId)` is the ONE interlock function.** 22c-F, 24a's rider app and 18a (if it adopts the same rule — R-002 says the interlock is shared) call it; nobody re-derives it from invoices.
6. **Money: the lab posts by `issueInvoice` with `charge_reason` on `lab_items`; refunds by `refundOnCancel` from `cancelled_from`.** 24a's convenience fee is ITS line on the same invoice; 26's package price replaces the per-item lines by tags, and `refundOnCancel` is NOT called for package items (26 owes its own cancellation rule and says so by `charge_reason='package'`).
7. **The worker still registers no encounter resolver (§6A.1 stands).** This phase places every order from the API. The plan that first places from the worker owes the two-line registration plus a parity test on `registeredEncounterPrefixes()`; DD8 records the lines.
8. **Add-ons are grouped orders (DD9); the kernel `addOrderItem` is owed by nobody until a plan needs the same header.** 18a inherits the same rule for an added view.
9. **`withIdempotency` stays in billing**; the third module to import it lifts it to `kernel/` in ONE commit that changes no behaviour.
10. **`PhiSurface` gained `lab.results`, `lab.report`, `orders.patient`; the kernel readers log.** 18a appends `radiology.*` and rebases if it lands second.
11. **QC, calibration, reagent lots, Levey-Jennings, `qc_locked` behaviour and `analyzer` status transitions are 17-E's**, over the `analyzer` kind DECLARED here. 17-E adds no manifest vocabulary.
12. **Cultures, send-outs, antibiogram, and the notifiable-disease REGISTER are 17-M's / 28a's; the `notifiable` flag and `lab.notifiable_flagged` event are here.**
13. **Histology, blocks, slides, frozen section are 17-H's**; the OT's `ot_specimens` (Plan 15 F17) draws its `S` number from the same series and 17-H links it by `specimen_no`.
14. **Roles `pathologist`, `lab_technician`, `phlebotomist`, `lab_reception` exist**; 17-M adds `microbiologist`, 17-H `histotechnician`.

---

## 7. Edge-case pass — done before finalising (owner standing rule), drawn from brainstorm §5

| # | case (02 id) | ruled |
|---|---|---|
| E1 | Two Ram Kumars, wrong one sits (A1) | label refuses on scan mismatch; T5 A5 |
| E2 | Ward labels pre-printed, stuck from memory (A2) | unscanned ⇒ identity recheck at accession; T5 A6 |
| E3 | Twins in NICU (A3) | delta is per canonical patient; T6 A7; the twin banner keys on a patients attribute that does not exist — 02 §15.11, flagged to patients, not built |
| E4 | Merge after results (A4) | tables key `order_item_id`; the envelope moves `patient_id`; reports keep the original UHID on their snapshot |
| E5 | Outside-collected sample (A5) | `lab_specimens.collection_site='external'` (not `label_source`, which names the printer) + a report footnote carried in the snapshot; ROUTINE, T5 |
| E6 | Analyzer result for a missing id (A6) | 17-E (`result.orphaned`); nothing here |
| E7 | UNK patient (A7) | `patient_id` is the UNK row; publishes without DOB via H4's estimated path |
| E8 | Same patient, two open orders, two tubes (A8) | accession matches `specimen_no`, never patient; add-on lists both tubes with times |
| E9 | Sealed/VIP (A9) | alias rule on every reader; T7 A8 |
| E10 | Staff's own test (A10) | `restricted` by desk choice + SoD refuses self-entry: `entered_by = patient's user` is refused — T6 gains the check as A1's sibling |
| E11 | Concurrent verify (B1) | T6 A2 |
| E12 | Analyzer retransmit (B2) | 17-E |
| E13 | Rerun after publish (B3) | `requestRerun` on a published item creates an unverified row; publishing it is an AMENDMENT — never a silent replace; T7 A6 |
| E14 | Add-on after serum discarded (B4) | `disposed_at` set ⇒ add-on refuses with the time, opens recollection, billed as new (DD9) |
| E15 | Payer switched mid-way (B5) | `deliveryAllowed` reads the encounter's CURRENT `intended_payer` at every call — no stored interlock state; asserted as T7 A2's sibling |
| E16 | Cancel after the tube is on the bench (B6) | CAS decides; `cancelled_from='in_progress'` needs a reason (phase 0 DD5); money per DD7 |
| E17 | Midnight age band (B8) | T3 A1 |
| E18 | STAT behind a routine batch (B10) | queue order STAT > urgent > routine; the bench worklist likewise |
| E19 | Core down (C1/C2) | 17-E buffers; manual-from-printout is `entry_mode` here |
| E20 | Label printer down (C3) | `label_source='downtime_kit'`; the mapping at accession is T5's `receive` with a kit serial |
| E21 | WhatsApp down at publish (C5) | T7 A7 — publish is independent of the enqueue |
| E22 | Pays for 5, doctor adds 2 (D1) | DD9 + per-item interlock: the paid five deliver; T7 A1's shape |
| E23 | "I'll pay later" (D2) | DD6 — held for delivery, doctor sees; release by approval |
| E24 | ER unpaid critical (D3) | no ER yet; the exempt-payer clause covers it when 40 lands, and the critical CALL never consults the interlock |
| E25 | Refund after result saved (D4) | DD7 + billing's approval credit note |
| E26 | Reflex charge (D6) | DD8 with order-time consent |
| E27 | Package partial (D7) | `partial:true` publish; 26 composes |
| E28 | TPA + non-covered test (D8) | per-line `intended_payer` is NOT modelled — the visit's payer governs; **carried to 46** in the gate report |
| E29 | Outside RMP referrer (D9) | sentinel/partner, class (c) accrues nothing |
| E30 | Duplicate same day, two doctors (D11) | T3 A5/A6 + `origin:'duplicate_confirmed'` |
| E31 | HIV consent (E1) | DD14; T4 A4 |
| E32 | MLC sample (E2) | `lab_specimens.disposed_at` is never set by the sweep when the ORDER's encounter is MLC — MLC does not exist before 40a; the sweep checks a flag that is always false today and the gate report says so |
| E33 | Foetal-sex request (E6) | catalogue validation refuses an orderable/analyte with `reports_foetal_sex` — a boolean on `lab_analytes` that the upsert refuses `true` for; T3 |
| E34 | Night, no pathologist, K⁺ 6.8 (F1) | DD12 — the tech opens the call at entry; R-014 default |
| E35 | Tech alone at night (F2) | DD11 night mode |
| E36 | Glucose 1200 typo (H1) | T6 A8 |
| E37 | Delta creatinine 0.9 → 4.2 (H2) | T6 A7 |
| E38 | LDL with TG 450 (H3) | T3 A3 |
| E39 | DOB missing (H4) / sex other (H5) | DD2 notes |
| E40 | Pathologist edits a verified value (H8) | no edit endpoint; amend only; T7 A6 |
| E41 | Unit change in catalogue (H10) | `version` bump; results keep their unit; trend conversion is a read-model concern for 22c-F/21 |
| E42 | Cashier prints for a friend (I2) | `lab.reports.print` + interlock + release register with identity; T7 A4/A9 |
| E43 | Ghost result (I4) | `enterResult` refuses when the item is not `accessioned`/`in_analysis` — the definition's matrix; T4 A8 |
| E44 | Free recollection abused (I9) | recollection only from `lab.specimen_rejected` by a lab actor; a patient-requested repeat is a new paid order |
| E45 | Waiting-area TV (J1) | no lab display screen in this phase; the OPD display shows tokens only |
| E46 | Shared family phone, pregnancy test (J3) | `sensitive` ⇒ in-person; T7 A7 |
| E47 | 23:58 IST placement (phase 0 E14) | the desk passes the visit's `service_date`, never re-derives |
| E48 | 900 orders/day (L1) | accession is one CAS update + one insert per tube; the p95 budget is measured in the gate report, not promised |
| E49 | Collection sites (L4) | `collection_site` column + queue filter; 24a adds `home` |
| E50 | Analyzer runs a default panel (M3) | 17-E's `unsolicited`; nothing here |
| E51 | Home tube with no active order (M9) | CONTRACT 2 |

---

## 8. What this phase FREEZES for downstream lanes

1. The fourteen table names of T1 and the columns named in §5 T1; the rule that 17-E/17-M/17-H extend by NEW tables keyed `order_item_id` / `specimen_id` / `result_id`, never by columns on these.
2. The two-level catalogue (DD1) and the snapshot rule (DD2).
3. `S` on `lab_specimens.specimen_no` from `lab_specimen`; `lab_specimen_items.active` as the current tube.
4. The three projection points (DD4): `in_progress` at receive, `completed` at last verify, `cancelled` on any lab cancel.
5. `deliveryAllowed`'s signature and its four reasons; the payer branch of DD6.
6. `refundOnCancel`'s rule (DD7).
7. Reflex is synchronous and API-side (DD8); add-on is a grouped order (DD9).
8. Results immutable once verified; reports immutable once published; amendment = new rows (DD13).
9. The fifteen permissions of DD16 and the four roles; the `lab` kind declaration as §6.8 wrote it.
10. The event names of DD18 and their payload keys.
11. `PhiSurface`'s three new members.
12. `bench` and `analyzer` vocabularies (DD17).
13. Zero active auto-verify rules; `system` refused at verify (DD11).

---

## 9. CLOSE — filled at execution

### 9.0 Kickoff — the pre-flight, and §2 re-measured

**Executed 2026-08-29 18:24 UTC on the build host, HEAD `dd6f869`, by the Lane A execution session.**

**Parallel-session pre-flight** (protocol §2, run before the first change):

| probe | result |
|---|---|
| `ps -eo pid,etimes,cmd \| grep -E "jest\|vitest\|deploy\.sh"` | **nothing** — no other suite running (the lines were read, not counted: §2.20) |
| `git status --short` | `?? .ci-watch.log`, `?? docs/design/` — **both another session's; neither staged by this lane** |
| `git log --oneline -5` / `git status -sb` | `## main...origin/main`, clean and current at `dd6f869` |
| `ls apps/core/drizzle \| tail -3` | `0043`, `0044`, `0045` — **`0046` is free** |
| `uptime` | load average **1.02** at kickoff |

**Lane B's uncommitted work is GONE from the tree** — `seed-roles.ts`, `seed-roles.test.ts` and
`privacy-write.test.ts` were committed as `b657a66` (the `mrd_officer` privacy-write ruling) before
this session began, and `.g.log` / `.g.exit` were removed. Nothing of Lane B's is dirty at kickoff.

**§2 re-measured, every row, with its own `how` command.** Rows 1, 2, 3, 5, 7–11, 13–20, 22 are
UNMOVED. Four rows are corrected in place above:

- **Row 1 — `0046` IS FREE.** 46 journal entries, last tag `0045_order_envelope_integrity`. Lane B
  has not generated. This phase takes **`0046`**, re-checking `_journal.json` immediately before and
  after `db:generate` (protocol §7).
- **Row 4** — values unmoved (`111 = 91 held + 20 not yet modelled`); Lane B's `b657a66` moved the
  LINE NUMBERS (`:611`→`:633`, `:739`→`:768`). A census pinned by line number is a census that
  drifts; the greps below name identifiers instead.
- **Row 6 — 88 lines across 31 files, not 34 across ~20.** The authoring measurement was wrong
  rather than stale (the same command returns 88 today and nothing added 54 lines in a day). This
  is the number T2's census sweep works from.
- **Row 12 — 35 screen modules, not 33** (70 files including tests); the 35 `path:` lines are
  unchanged, so T8 moves 35 → 39.
- **Row 21** — `.ci-watch.log` joins `docs/design/` as a foreign untracked file.

**The test database, named here and in every commit that cites a green run (§2.137, v3 §9.9 rule 8):**

```
export TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_a_scratch"
```

Jest appends `_<JEST_WORKER_ID>` (`test/helpers/db.ts:31-41`), so the real databases are
`hmis_lane_a_scratch_1` … `hmis_lane_a_scratch_N`. They are dropped by explicit name in the CLOSE.

### 9.3 The spike answers (S1–S9), answered at kickoff, before T1

Answered by reading code and one read-only production query. **Three change the work as the plan
predicted (S1, S2, S9) and two more change it in ways the plan did not predict (S3, S7) — both are
recorded as findings in §9.2 rather than absorbed silently.**

**S1 — `issueInvoice` (`billing/invoices.ts:712`).**
- Signature is **`issueInvoice(db: Db, actor, input, now?)` and it opens its OWN `withTx`** (`:760`).
  It is NOT a `Tx`-first function. T4's "ONE transaction" is therefore achieved by handing it the
  caller's transaction as `tx as unknown as Db` — drizzle's `transaction()` on a `Tx` opens a
  SAVEPOINT inside it, so the invoice participates in the placement's transaction and a rollback of
  the outer rolls back both. The cast is the shipped house pattern (`place.ts:296`,
  `patients/registration.ts:408`, `materials/grn.ts:379`).
- **It performs NO general permission check** — the route does. The ONLY `hasPermission` call in it
  is in the credit lane (`:801`).
- **An invoice with a remainder and no `credit` block is REFUSED** (`:783`, `credit_extension_required`):
  a credit block without a non-empty `reason` "is not a credit block". The actor must hold
  **`billing.credit.extend`** (`CREDIT_EXTEND_PERMISSION`, `invoices.ts:57`) and, above
  `creditCapPaise`, a granted approval. **So DD6's lab-issued lines (reflex, add-on, walk-in) MUST
  pass `credit: {reason}` AND their actor must hold `billing.credit.extend`** — which the seed
  grants to `pathologist`, `lab_technician` and `lab_reception` in T2 (DD16 amended, §9.2 F2).
- `settlementState` (`billing/settlement.ts:12`) is **PURE over three numbers and keyed on the
  INVOICE, never the line**. The reader that feeds it is `invoiceSettlement(exec: Db | Tx, invoiceId)`
  — exported from `modules/billing`, and it takes `Db | Tx`. **T7's `deliveryAllowed` is therefore
  invoice-grained**: it blocks while ANY invoice carrying one of the order's lab lines is not
  `settled`. That over-blocks on a partially-paid mixed invoice and never under-blocks, which is the
  safe direction; it is stated in the CONTRACT rather than left to be discovered.
- Refunds: **`issueCreditNote(db, actor, {kind:'refund', invoiceId, reason, lines:[{invoiceLineId, qty}]})`**,
  permission `billing.credit_note.issue`. Same `Db`-first shape, same savepoint treatment.

**S2 — the walk-in visit.** `opd_encounters.department_id` and `doctor_id` are **nullable in the
schema** (`schema/opd.ts:232-233`) but `openVisitInTx` **requires both** and validates that the
doctor is active, the department is active and `doctor.departmentId === dept.id`. `opd_departments`
IS a master table (code-unique, `active`), so **the seed creates a `LAB` department and the
pathologist-of-record as an `opd_doctors` row inside it** — that is DD6's "the pathologist is the
visit's responsible doctor", and it is data, not code. `openVisitInTx` accepts
`referralSource:'external_rmp'` + `referrerName` directly (`OpenVisitInput`), requires
`actor.type === 'user'`, mints the `V` number, starts the OPD visit definition, and allocates a
queue token in that doctor's session — the lab desk is a counter, so a token is correct.

**S3 — the referrer.** `counterparties.payee_class` vocabulary is
**`channel_partner | staff_internal | external_rmp`**; class (c) is `external_rmp`, and
`accrual.ts:319` refuses a PAYABLE accrual to one outright (`payout_blocked`), which is 02 D9's
"accrues nothing" enforced by a composite FK plus a CHECK rather than by policy. **`orders.external_referrer_id`
carries NO foreign key** — it is `text` with a biconditional CHECK (`schema/orders.ts:136,169`) — so
the sentinel needs no partners API, and there is none: counterparties are created by direct insert
everywhere in this repo (no `createCounterparty` exists). **The `EXTERNAL_UNATTRIBUTED` sentinel is
therefore a row the lab seed inserts** with `payeeClass:'external_rmp'`, `status:'active'`.
**FINDING (§9.2 F1): `attribution.unverified_flagged` DOES NOT EXIST** — `modules/partners/events.ts`
declares seven events and none of them is it. DD15's flag is emitted as the lab's own
`lab.attribution_unverified_flagged`, appended to DD18's list.

**S4 — the workflow engine checks the role itself.** `transition(tx, instanceId, to, actor, opts)`
(`workflow/instances.ts:72`): a `user` actor **must hold one of the transition's declared roles**,
a `system` actor bypasses the check, an `agent` is denied — the header states it and the code does
it. So **the definitions carry `pathologist` on `verify`**, and T6's SoD guard is a SEPARATE,
additional check, because "the verifier is not the enterer" is a fact about the RESULT ROW that no
role list can express. The CAS is `workflow/instances.ts:136-157`, single-winner on
`(id, status='active', current_state)`, `stale_transition` for the loser.

**S5 — production, read-only** (`docker exec hmis-prod-db-1 psql -U hmis -d hmis -c "select …"`, no
write, no `setsid`):

| fact | value |
|---|---|
| `opd_encounters` | **13** |
| encounters with a non-empty `advised_tests` | **0** |
| `services` | **6**, of which category `investigation` = **1** (`SYN-LAB-CBC`, from the synthetic seed) |
| `orders` | **0** |
| `patients` | **24** |
| `opd_departments` | 12 — **no `LAB`** |

**The demand signal is empty in production today**, so T4's converter meets no orphan `serviceId` on
day one; A5 still asserts the refusal, because the first real catalogue seed is exactly when an
orphan becomes possible. §9.9 must create the `LAB` department — it does not exist.

**S6 — `S` numbers.** `nextEpisodeNo(tx,'lab_specimen','2026-08-29')` → **`S2608290001`**
(`formatEpisodeNo`, `episodes/series.ts:76`: letter + `YYMMDD` + 4 digits). `episode_series`'s key is
`PRIMARY KEY (series_key, service_date)` and the allocator is a single-winner
`UPDATE … RETURNING` whose returned value is the POST-increment counter. Inherited, not designed.

**S7 — the notification template registry is CODE IN THE KERNEL, and this is the finding that
changes T7's Files list.** `kernel/notify/templates.ts:48` is a literal
`Record<string, NotificationTemplate>` with five entries; `templateByKey` **throws** for anything
else; `enqueueNotification` calls it first, deliberately, so a typo dies at the enqueue. **There is
no registration function** — `grep -rn 'notificationTemplates|registerTemplate' apps/core/src`
returns only the definition, `templateByKey` and the census test. A module cannot register a
template, so `modules/lab/notify-templates.ts` as the phase document imagined it **cannot exist**.
**FINDING (§9.2 F3): T7 requires a FOURTH kernel edit** — `patient_lab_report_ready` appended to
`kernel/notify/templates.ts` plus its key in `templates.test.ts:20`'s sorted census. It is the same
class of append as the `PhiSurface` union (kernel edit 1), it is named in T7's commit message, and
the template is patient-audience, transactional, **token-only: no result values, no analyte names**
(02 J3 / R-020). There is no report deep link before 22c-F, so the body says where to collect.

**S8 — the A4 design EXISTS and is UNCOMMITTED.** `docs/design/2026-08-29-opd-counter-flow/ReportA4.dc.html`
(plus `PrescriptionA4.dc.html`) is on disk in the untracked `docs/design/` tree — **another
session's, and this lane never stages it**. T8 may READ it for the print component's layout; if it
is still untracked at T8, `components/rx-print.tsx` is the committed precedent and the layout is
copied from the design by eye, with no file of that tree in this phase's diff.

**S9 — a reflex order NEEDS an `ordering_clinician_id`, and the verifying pathologist is it.**
`place.ts:126` checks `decl.requiresClinician && !input.orderingClinicianId` **for every actor
type**, AFTER `resolveAuthority` has already accepted the `system` actor's `protocolRef`. The two
guards are independent: `system` supplies `protocol_ref` (`place.ts:277`) and STILL owes the
clinician column, because the kind declares `requiresClinician: true`. So DD8's reflex placement
passes `orderingClinicianId = the verifying pathologist's user id` — the doctor answerable for the
added test — and that is read from the code, not remembered.

### 9.1 The commits

| # | SHA | tasks | what landed |
|---|---|---|---|
| 1 | `39beff0` | **T1 + T2** | migration `0046_lab_core` (13 tables, 2 immutability triggers, 3 `truncateAll` statements), `modules/lab/` seam (manifest with the `lab` kind claim, 15 permissions, 22 events, 29 error codes, 1 approval type, 2 resource-kind vocabularies), 4 new roles + 34 non-table grants, and **four** kernel edits |

**Batched T1+T2 into one commit** per v3 §9.9 rule 4 — the run is the unit of cost, the commit is
free — with the two tasks separated in the message.

**T3–T9 ARE NOT EXECUTED.** The phase stopped at the T2 boundary on the stop-loss rule; see §9.7
and the handoff note below.

### 9.2 Findings

**F1 — `attribution.unverified_flagged` does not exist (spike S3).** DD15 says the desk emits it and
`modules/partners/events.ts` declares no such event (seven events, none of them this). The lab emits
its own `lab.attribution_unverified_flagged` instead, appended to DD18's list. The alternative —
declaring an event in another module's namespace — would put a `partners.*` name in the lab's
manifest, which is the kind of cross-module reach `modules/billing`'s index header forbids.

**F2 — the lab roles need `billing.credit.extend` (spike S1).** DD6 has the lab issue unpaid
invoices for reflex, add-on and walk-in lines. `issueInvoice` refuses a remainder without a `credit`
block AND requires the ACTOR to hold `billing.credit.extend`. DD16's grant list is amended: the
three lab roles that can create an unpaid lab line (`pathologist`, `lab_technician`,
`lab_reception`) hold it. This is a grant of an EXISTING billing permission to new roles, not a new
permission, and it is named in T2's commit message.

**F3 — T7 needs a fourth kernel edit: the notification template (spike S7).** The template registry
is a closed literal in `kernel/notify/templates.ts` with no registration seam, so
`modules/lab/notify-templates.ts` cannot exist as the phase document wrote it. `patient_lab_report_ready`
is appended to the kernel registry and to `templates.test.ts`'s sorted census. Disclosed here rather
than absorbed: the plan says three kernel edits and the true number is four.

**F4 — two arithmetic/naming corrections the document carries.** (a) §5 T1's heading says
*"fourteen lab tables"* and its own Produces list enumerates **thirteen**; the migration creates
thirteen and `lab.test.ts` asserts thirteen. (b) DD6 and §5 T2 write the approval type key as
`lab.release_unpaid`; `registerApprovalType` drafts a workflow definition named
`approval_<typeKey>`, and `kernel/workflow/definition.ts:28` validates that key against `KEY_RE`
with the message *"definition key must be lowercase snake_case"*. A dotted key throws on the FIRST
deploy that runs the seed, with the interlock's only override unregistered behind it. The shipped
key is **`lab_release_unpaid`** and `approval-types.test.ts` pins the shape so it cannot drift back.

**F5 — THERE ARE TWO CLAIMED-KIND CENSUSES AND THE PHASE DOCUMENT NAMED ONE.** §5 T2's Files list
names `kernel/orders/kinds.test.ts:140`. `kernel/orders/parity.test.ts:28` pins the same fact
(`collectOrderKinds(ALL_MANIFESTS) === []`) and was not named. Both were found by §2.138's
LIST-grep (`grep -rn "ALL_MANIFESTS" apps/core --include=*.ts`), which is precisely the search that
rule exists for: **neither census writes any manifest identifier**, so no sibling-name grep could
have found either at any scope. The kickoff re-measure also corrected the rule's own input — row 6
is **88 lines across 31 files**, not the 34 across ~20 the authoring measured.

**F6 — three census files that no task's Files list names, moved and disclosed** (the shape Plan 14
recorded as F11 and Plan 15 as T2-f): `kernel/resources/kinds.test.ts` (the collected-kind list,
7 → 9), `kernel/orders/parity.test.ts` (F5 above), and `README.md` — which `seed-roles.test.ts`
PARSES, so the fifth permission table is not a documentation nicety but a test input. A phase that
declares fifteen permissions across four new roles cannot leave it unedited and stay green.

**F7 — `issueInvoice` and `issueCreditNote` are `Db`-first and open their own transactions.** T4's
"ONE transaction" is achieved by handing them the caller's `tx` cast as `Db`; drizzle's
`transaction()` on a `Tx` opens a SAVEPOINT inside it, so the invoice participates in the placement
and an outer rollback rolls back both. The cast is the shipped house pattern (`place.ts:296`,
`patients/registration.ts:408`, `materials/grn.ts:379`) — **but it is a claim about drizzle's
nesting behaviour that this phase has NOT yet proved by execution.** T4's A3 mutant ("invoice
issued after commit") is what proves it, and it is unbuilt. **A successor session must build A3
before trusting the seam.**

**F8 — THE SHARED CHECKOUT MADE `pnpm verify` UNAVAILABLE FOR PART OF THIS SESSION, AND THE FIX WAS
INDEX SURGERY RATHER THAN QUEUING.** Lane B's uncommitted work sat in four files this task also
edits — `_journal.json`, `schema/index.ts`, `orders/parity.test.ts`, `test/helpers/db.ts` — and
their half was not committable: `truncateAll` naming `pcpndt_*` with no migration behind it turns
`main` red for everybody. `git add <path>` stages a whole file, so the commit was built by hashing
**HEAD-plus-my-hunks** for those four (`git hash-object -w --stdin --path … ; git update-index
--cacheinfo …`) and staging the resulting blobs, leaving Lane B's edits untouched in the worktree.
The protocol's §3 rule 1 ("stage explicitly, by path") is not sufficient when two lanes share a
FILE rather than a directory, and this is the mechanical answer. It also means the committed tree
and the tested worktree differ, which is why CI-by-SHA is the load-bearing evidence for `39beff0`
rather than the local run.

### 9.4 The Assertion Book, corrected by execution

**No Assertion Book row was executed, because no CRITICAL task ran.** T1 and T2 are both ROUTINE:
AGENT-RULES §3 owes them tests that pass and NO mutants, and none was built. Fail-first is not owed
at either tier here and none was manufactured — for T1 a red would have been an unresolved-import
error (§2.5: proves nothing), and this is said rather than faked.

**What execution DID correct in the Books that have not run yet, recorded so the successor does not
re-derive it:**

| task | row | correction |
|---|---|---|
| **T4 A3** | "Placement and invoice are ONE transaction" | The mutant is now the ONLY proof of finding F7 — `issueInvoice` is `Db`-first and opens its own `withTx`, so the seam is a drizzle SAVEPOINT rather than a shared transaction handle. **Build it first.** |
| **T4 A7** | the walk-in's sentinel referrer | `orders.external_referrer_id` has NO foreign key (spike S3), so the mutant's stated failure — *"the CHECK throws at `placeOrder`"* — is the BICONDITIONAL check on `authority`, not an FK violation. The refusal text differs and the assertion must match the real one. |
| **T6 A4** | reflex placed in the verifying transaction | S9 changed the input: a `system` reflex order STILL requires `orderingClinicianId` (`place.ts:126` checks `requiresClinician` for every actor type). A mutant that omits it fails with `clinician_required` for the wrong reason. |
| **T7 A1** | `deliveryAllowed` sums every self-pay line | `settlementState` is keyed on the INVOICE, not the line (S1), and the only exported reader is `invoiceSettlement(exec, invoiceId)`. The shipped rule is therefore *"blocked while ANY invoice carrying one of this order's lab lines is unsettled"*, which over-blocks a partially-paid MIXED invoice and never under-blocks. **A1's mutant must discriminate the invoice-grained rule, not a line-grained one that does not exist.** |
| **T5 A2** | `S` numbers unique under concurrency | Inherited unchanged: `nextEpisodeNo`'s single-winner `UPDATE … RETURNING` is phase 0's, measured there over 12 rounds. The lab's row still owes its own ≥ 8. |

**F9 — `main` WAS ALREADY CI-RED WHEN THIS PHASE'S FIRST COMMIT LANDED, AND THE CAUSE IS A CLOCK,
NOT A DIFF. It is diagnosed here because nobody had diagnosed it.**

`ci-watch-host.sh 39beff0` returned **RED**. It is not this commit's red, and the evidence is
three-fold:

1. **`39beff0` touches no file under `apps/web`** (`git show --stat` — zero), and both failures are
   in `apps/web/src/screens/my-day.test.tsx`.
2. **The three commits BEFORE it were red too** — `b657a66` (18:05), `dd6f869` (18:07), `023622a`
   (18:48), against `a7d1673` green at 18:04 (`gh run list`).
3. **`023622a` failed on the SAME two assertions**, verbatim: *"expected […] to include
   `/api/me/report.csv?date=2026-08-29`"* and the `?period=half&date=2026-0…` one.

**THE MECHANISM.** `apps/web/src/screens/my-day.tsx:140` is `useState(todayIst())` — the screen
takes its date from the REAL clock. `my-day.test.tsx` hard-codes `2026-08-29` in its mocked replies
and asserts the request URL contains that date. CI ran at **19:20–19:23 UTC**, which is
**00:50 IST on 2026-08-30**, so the screen asked for `date=2026-08-30` and the assertion for
`2026-08-29` failed. The rendered DOM in the failure output confirms it: `value="2026-08-30"`.

**So every commit pushed between 18:30 UTC and midnight UTC goes red, whatever it contains** — and
the local `pnpm verify` on this host reproduced the same two failures at the same wall-clock, which
is what rules out a CI-environment explanation. `023622a` was a CI fix attempt by the other lane and
did not touch this.

**NOT FIXED HERE, deliberately.** `my-day.test.tsx` is in no Files list of this phase, the other
lane has an in-flight commit in exactly that area, and two lanes editing one test file is finding
F8's own hazard. The fix is one of: inject the clock into `MyDay`, or derive the fixture date from
`todayIst()` instead of hard-coding it. **Whoever takes it should note that the SCREEN is arguably
correct and the TEST is what asserts a frozen day.**

### 9.5 Mechanical verification — name the `TEST_DATABASE_URL` database of every run claimed (§2.137)

**EVERY RUN BELOW USED `TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_a_scratch"`,
so the worker databases were `hmis_lane_a_scratch_1 … _N` and migration `0046_lab_core` was applied
to them FROM EMPTY by `setupTestDb`'s unconditional `migrate()`.** The clause exists because rule 7
requires those databases to be dropped in the same task, so by the time anyone audits, the proof is
gone — and phase 0's second reviewer spent its CRITICAL slot on exactly that phantom (§2.137).
**They were dropped at close; the drop is recorded at the foot of this section.**

**PREFLIGHT (v3 §9.9 rule 6), exit values READ, never inferred from a pipeline:**

| stage | exit |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm lint` | **0** (2 pre-existing warnings, 0 errors) |

**SCOPED RUNS, before the commit — each isolation line read from the OUTPUT (rule 19):**

| suite | result |
|---|---|
| `src/kernel/db/schema/lab.test.ts` | **24/24**, exit 0 |
| `src/modules/lab` (5 suites) | **22/22**, exit 0 |
| `test/seed-roles.test.ts test/seed-staff.test.ts` | **34/34**, exit 0 |
| `src/kernel/orders/read.test.ts` | **25/25**, exit 0 |
| `src/modules/lab src/kernel/modules src/kernel/orders src/kernel/resources` | 164/166 — the two were `advance.test.ts`'s C1/C1b concurrency rows, under load |

**THE FULL RUNS, AND THE HONEST READING OF THEM.**

| run | result |
|---|---|
| `pnpm verify` (whole workspace) | **exit 1** — aborted in `@hmis/web` on F9's date-rollover flake, so `apps/core`'s own summary never printed. `apps/web`: **353 passed / 2 failed** (both F9). `packages/contracts`: **21/21**. |
| `pnpm --filter @hmis/core test` (full core) | **exit 1** — **2,867 passed / 15 failed, 293 suites (12 failed)** |
| the SAME 12 suites, `--runInBand`, box quiet | **exit 0 — 80/80, 12/12 suites passed** |

**THE 15 FAILURES WERE 100% CONTENTION AND 0% REAL, AND THAT IS MEASURED RATHER THAN ARGUED.** The
signature is §2.137's, item for item: **30 occurrences of `Exceeded timeout of 15000 ms`**, zero
foreign-key violations (the private database had already removed that class), failures spread across
twelve suites the diff does not touch — `alerts`, `tariff`, `uhid`, `photos`, `schedules`,
`rbac.e2e`, `seed-admin`, `seed-tariff`, `allergies`, `approvals`, `ot/approval-types` — and
timings that are not the timings of those suites: `ops/mode.test.ts` **181 s**, `ot/cockpit.test.ts`
**131 s**, `auth/patient-actor.test.ts` **121 s**. `uptime` during the run: load average **18.08**,
with the other lane's own full suite in flight in the same checkout. Re-run serially on the quiet
box, all twelve pass. **So the core total is 2,882 of 2,882**, established by execution in two
parts rather than by one green line.

**COUNTS (AGENT-RULES §4):**

- **No test is deleted by `39beff0`** — `git show --stat --name-status` reports zero `D` entries.
- Tracked core `*.test.ts` files **286 → 291**; the commit adds six suites (`schema/lab.test.ts` and
  five under `modules/lab/`) and edits six censuses.
- Core tests **2,882**, up from the phase's kickoff measurement.

**PER-COMMIT `git show --stat` AGAINST THE FILES LISTS:** `39beff0` touches **32 files**. T1's list
(schema, its test, the migration + snapshot + journal, `schema/index.ts`, `test/helpers/db.ts`) and
T2's list are covered in full. **Four files are in NO task's Files list and each is disclosed** —
`kernel/orders/parity.test.ts` (F5), `kernel/resources/kinds.test.ts` (F6), `README.md` (F6, and it
is a TEST INPUT: `seed-roles.test.ts` parses it), and `apps/core/test/seed-staff.test.ts`, which the
document names for T2 but under the wrong count.

**FROZEN-PATH AUDIT:** the diff touches `kernel/orders/` in exactly three places — `read.ts` (the
two `recordPhiAccess` calls), `read.test.ts` and `kinds.test.ts`/`parity.test.ts` (the two claimed-
kind censuses). **`place.ts`, `advance.ts`, `kinds.ts`, `manifest.ts`, `events.ts`, `errors.ts`,
`transitions.ts`, `schema/orders.ts`, `drizzle/0044*` and `drizzle/0045*` are UNTOUCHED**, as are
`kernel/episodes/series.ts` (no new letter), `kernel/resources/kinds.ts` and `schema/resources.ts`
(the two kinds were already in the closed ten), `kernel/auth/*`, `packages/contracts/*`,
`modules/billing/*`, `modules/opd/*` and `modules/patients/*`.

**CI, BY FULL SHA:** `ci-watch-host.sh 39beff0` → **RED**, and it is NOT this commit's red. See
finding F9 for the three-part evidence and the mechanism.

**THE SCRATCH DATABASES WERE DROPPED, BY EXPLICIT NAME, AND THE DROP WAS VERIFIED BY MEASUREMENT
RATHER THAN BY THE COMMAND'S EXIT.** Seven existed — `hmis_lane_a_scratch_1` through
`hmis_lane_a_scratch_7`, one per jest worker across the runs above. Each was dropped by name
(`DROP DATABASE IF EXISTS hmis_lane_a_scratch_<n>`), never by a pattern and never by a prune
(AGENT-RULES rule 7). Two of the seven `docker exec` calls were killed by their own client-side
timeout before printing, so the exit status of the loop is not the evidence; the evidence is the
listing taken afterwards:

```
select datname from pg_database where datname like 'hmis_lane_a_scratch%';   -- (0 rows)
select datname, count(*) from pg_stat_activity where datname like 'hmis_lane_a_scratch%';  -- (0 rows)
```

**Nothing named `hmis_lane_a_scratch*` remains, and nothing is connected to one.** The dev database
`hmis_dev` and the per-worker `hmis_test_*` databases were never touched by this phase — that is the
whole point of the override, and it is why the other lane's full suite and this one could run in the
same checkout without corrupting each other's fixtures.

### 9.6 The independent close review (pass 1, fresh) and 9.6.2 (pass 2, fresh, over the fixes, verdict per fix)
### 9.7 Actuals — recorded only after §9.6 exists (v3 §9.4)

**No actuals row is recorded, and that is the rule rather than an omission** — v3 §9.4: *"a phase
document may not record an actuals row, and a session may not report a phase as cheap, before
§3.4's review has returned."* No reviewer has run. What is recorded instead is the STOP-LOSS
measurement, because it is the reason the phase stopped.

| | value |
|---|---|
| stop-loss (this document, §THE LANE) | **730,000** |
| spent at the T2 boundary | **~482,000 (66%)** |
| tasks delivered | **2 of 9** (T1, T2 — both ROUTINE) |
| subagents used | **0** |
| reviewer passes run | **0 of 2** (budgeted 458,491 between them) |

**THE STOP-LOSS CANNOT COVER THIS PHASE, AND THE ARITHMETIC SAYS SO BEFORE T3 STARTS.** Two ROUTINE
tasks consumed 66% of it. The five CRITICAL tasks still to come each owe a full Assertion Book with
BUILT mutants and, for T4/T5/T6, concurrency rows measured over ≥ 8 rounds; T8 owes four screens, a
print component and an e2e over every route. Even at a marginal rate well below this session's —
much of T1+T2's cost is one-off (the §1 reading order, the nine-question spike, the kickoff
re-measure, and the index surgery F8 describes) — seven tasks plus two reviewer passes cannot land
inside 248,000 remaining tokens. The EXECUTE-PROMPT's §0 rule is *"if you approach it, stop and
report — do not re-tier"*, and this session stopped at a task boundary rather than spending the
remainder discovering the same thing mid-T4.

**AND THE MEASUREMENT WORTH KEEPING, BECAUSE IT IS A DEFECT IN THE FORMULA RATHER THAN IN THIS
PHASE.** The stop-loss came from `1.5 × (per-task rate × task count) + one reviewer pass per
remediation cycle`, with the per-task rate taken as **20,178** — Plan 16a's 181,605 over nine tasks.
This document's own §THE LANE states the bias in one sentence: *"in a LIGHT phase `subagentTokens`
IS the reviewer, so this is review cost in execution clothing; main-session cost is unmeasurable
from inside."* **A term that measures only the reviewer cannot budget the coder.** Measured here:
two ROUTINE tasks of main-session coding, zero subagents, ~482,000 tokens — **24× the per-task rate
the formula used.** The task term was never a task term. It is recorded here as a finding for
EXECUTE-METHOD-V3 §6 and the ledger, because every LIGHT phase since 16a has carried a stop-loss
built the same way and the three that finished did so by coming in under a number that was not
measuring their main cost.

---

## HANDOFF — written at the T2 boundary (v3 §9.6: run first, write second)

**The successor reads this section, then §9.0, §9.3 and §9.2, and then starts at T3.**

**WHAT IS TRUE ABOUT THE CODE, AND HOW IT IS KNOWN.** Everything in `39beff0` was typechecked,
linted and RUN — this is not a "written but unverified" handoff (§9.6's own failure mode). The
suites, the counts and the database name are in §9.5. `pnpm typecheck` exit 0 and `pnpm lint`
exit 0 were read as VALUES before the commit.

**WHAT IS NOT DONE.** T3–T9, in full. No catalogue, no desk, no specimen, no result, no report, no
route, no screen. `modules/lab/` holds the seam and nothing behind it: `errors.test.ts`'s
direction-1 leg is DERIVED from which files exist, so it passes today and starts requiring throwers
the moment T3 lands `catalogue.ts` — no edit to that test at any point, by design.

**THE FOUR THINGS THE SUCCESSOR MUST NOT RE-DERIVE.**
1. **The spike is answered (§9.3) and three of the nine changed the work.** S1 (the transaction
   seam and `billing.credit.extend`), S7 (the template registry is closed kernel code) and S9 (a
   reflex order still owes `ordering_clinician_id`) are the three; read them before T4, T7 and T6
   respectively rather than re-reading the code.
2. **F7 is an UNPROVED claim and it is load-bearing.** The `tx as unknown as Db` savepoint seam is
   how T4 keeps placement and invoice in one transaction. Build T4 A3's mutant FIRST.
3. **The censuses this phase moved are listed in §9.2 F5/F6.** Two claimed-kind censuses, not one.
4. **F8's index surgery is how to commit in this checkout while Lane B is live.** Do not `git add`
   a shared file wholesale.

**THE PRE-CONDITION FOR T3.** `seed-lab-catalogue.ts` needs `services` rows of category
`investigation`; production has exactly ONE (`SYN-LAB-CBC`, synthetic) and no seed script creates
any. T3's own seed creates them from the golden fixture — that is in its Files list — but the
PRODUCTION catalogue is the owner's data and stays a runbook act (§9.9, item 3 of §4A).

**WHAT THE OWNER DECIDED — RULED 2026-08-29, AND THE DOCUMENTS EXIST.** The re-cut below was
adopted: [`17a`](2026-08-29-phase1-17a-lims-order-to-accession.md) (T3–T5, order to accession) and
[`17b`](2026-08-29-phase1-17b-lims-result-to-report.md) (T6–T9, result to report), each with a
stop-loss built from v3 §6's amended three-term formula — 1,350,000 and 1,560,000, arithmetic shown
in each. Both are AUTHORED and NOT APPROVED FOR EXECUTION; each is executed by a FRESH session, and
17b is gated on 17a being code-complete. The original wording of the question follows.

**WHAT THE OWNER MUST DECIDE BEFORE T3 RESUMES.** Whether to raise the stop-loss on the measurement
in §9.7 above, or to re-cut the remaining seven tasks into two phases. This session recommends the
second: **T3+T4+T5 as "17a — order to accession" and T6+T7+T8+T9 as "17b — result to report"**,
each with its own stop-loss set from THIS phase's measured main-session rate rather than from
16a's reviewer-derived one. The seam between them is clean and already frozen by §6: an accessioned
item with `in_progress` on the envelope and a specimen with an `S` number is a complete, testable
state, and it is exactly where a lab's morning ends and its bench begins.

### 9.8 The question this phase existed to answer
### 9.9 Deploy block — the grants, the catalogue seed, the definitions activation, the department, the signatory — written when the owner authorises, never before
