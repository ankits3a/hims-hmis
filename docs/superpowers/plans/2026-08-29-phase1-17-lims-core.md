# Plan 17 — Central lab / LIMS core: catalogue, order at the counter, specimen, accession, result, verify, report, interlock

**Written 2026-08-29 on the build host, in LANE A of a two-lane authoring fork (Lane B is authoring Plan 18a in this checkout). NOT APPROVED FOR EXECUTION — execution is a separate session with its own approval.** Seeded by [`2026-08-29-LANE-A-plan-17-lims-AUTHOR-PROMPT.md`](2026-08-29-LANE-A-plan-17-lims-AUTHOR-PROMPT.md). The envelope this plan builds on is phase 0, [`2026-08-29-phase1-17-order-envelope.md`](2026-08-29-phase1-17-order-envelope.md) — **§6 (the CONTRACT), §6A (what it does NOT do), §8 (what is frozen), lines 297–374**; §4.1 for a column name. Its code is LIVE in production (prod 46 migrations, 2026-08-29) and is **inherited, not edited**.

**THE RULING, in one paragraph.** Plan 17 is the **manual-first LIMS core**: it claims the order kind **`lab`** with ONE manifest field (`lab` / `lab_order` / `lab.orders.place`, `requiresClinician: true`, `requiresIndication: false`, `selfOrderable: false` — phase 0 §6.8, proven end to end by `envelope.e2e.test.ts`), and owns **everything after the order**, on tables keyed `order_item_id` that never add a column to the envelope. The catalogue is two-level — an **orderable** (one `services` row, one order item, one tariff line) expands into **analytes** (the resultable things), which is how a profile and a standalone test can share a CBC and be told apart (§6A.3 closed, for lab). **Money is posted at ORDER time at the lab desk**, in ONE transaction with the placement, under the route's `Idempotency-Key` (§6A.2 closed); items the counter never sees — reflex, add-on, walk-in accession — are invoiced by the lab at creation and the **delivery interlock** (print/WhatsApp held until the self-pay line settles; the doctor's screen never held; TPA/PMJAY/corporate/day-care exempt; override = `billing_manager` approval leaving the dues where they already are) is the collection mechanism — that is **02 O-1, ruled here**. **Reflex testing runs SYNCHRONOUSLY inside the verifying transaction** as a `system` actor with `protocol_ref`, in the API process where the encounter resolvers are registered — so this plan places **no order from the worker** and §6A.1 is closed by not needing it, with the alternative recorded. **An add-on is a NEW order in the same `order_group_id`** on the same tube (`origin:'addon'`, `parent_item_id` across orders), so no `INSERT INTO order_items` and no kernel `addOrderItem` (§6A.5/§6A.7 avoided, not solved). **Cancellation money (02 O-4, ruled here): `cancelled_from='placed'` refunds automatically by credit note; `cancelled_from='in_progress'` with a result row keeps the charge — the legacy "no pathology refund once the result is saved", as a one-column read; a rejected sample recollects free and a 7-day non-return cancels with refund.** The envelope's `completed` fires at VERIFICATION; publication is the report's own state. QC/calibration/reagent lots/Levey-Jennings go to **17-E** with the analyzers they lock; cultures and send-outs to **17-M**; histology to **17-H**; the notifiable-disease and incident REGISTERS to **28a** (the lab emits the flag). **Nine tasks, LIGHT lane, migration `0046` as a measurement.**

**Numbering:** [`00-INDEX-AND-SYNTHESIS.md`](../brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md) §3 — `17` LIMS core · `17-E` analyzer edge · `17-M` microbiology · `17-H` histopath; 24a/24b home collection; 26 packages. **Brainstorm argued from, not restated:** [`02-central-lab-lims.md`](../brainstorms/2026-08-27-department-series/02-central-lab-lims.md) §1 (scope table, locked spec decisions), §2 (roles), §3.1/§3.2 (the two definitions), §4 (data sketch), §5 (the 129-row catalogue, cited by id below), §13 (O-1…O-12), §14 (the T1–T10 sketch this plan re-cuts), §15. **Owner rulings register** (`/opt/hmis-context/brainstorm-2026-08-27/00-OWNER-RULINGS-REGISTER.md`): *"nothing here is RULED; an owner ruling is 'adopt default' unless written otherwise"* — defaults are adopted and marked DECIDED under the owner's standing rule of 2026-08-28; money/procurement/law items are named in §4A.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — **at line 1485 as of 2026-08-29 17:52 UTC (measure: `grep -n '^## 5' docs/superpowers/plans/reports/EXECUTION-LESSONS.md`; it moved 1323 → 1485 in one day)**. Never the ledger whole: **407,657 bytes ≈ 102k tokens**, re-billed on every tool call (v3 §9.1). Entries cited by number: §2.54 (one list, one owner), §2.115 (fresh, not resumed), §2.131/§2.133/§2.138 (sibling-grep, directory+glob, grep the LIST), §2.137 (name the test database), §2.139 (assert on the argument, never `not.toHaveBeenCalled()` with a `Db`), §2.140 (the second reviewer is not optional).

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Nine tasks, one migration, four screens and one print component, two workflow definitions, one approval type, four roles. It is a full-module build, which v3 §2 names as LIGHT's *edge* rather than its home — but Plans 14 and 15 (nine tasks each, ten-table modules with four screens) both ran LIGHT to code-complete, and the review terms that made them correct are budgeted below. **Five of nine tasks are CRITICAL** (a formula/range engine that can print a wrong number, a money-plus-idempotency seam, a concurrency-and-money seam at accession, a verification seam with SoD and a synchronous reflex placement, and a confidentiality-bearing interlock), and CRITICAL means executed mutants in either lane.

**The refutation condition, written now:** if the executing session's context passes ~60% before T6 is committed, it hands off AT A TASK BOUNDARY per v3 §9.6 (typecheck → narrowest suite → note) rather than re-tiering mid-phase. A second session picking up from T6 is cheaper than a HEAVY compile.

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

### T1 — Migration `0046`: fourteen lab tables, two immutability triggers, `truncateAll` — **ROUTINE**

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

### T3 — Catalogue service, reference-range resolver, formula evaluator, reflex matcher, analyte-overlap duplicate detector, golden fixtures — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{catalogue.ts, ranges.ts, formula.ts, reflex.ts, duplicates.ts, seed-catalogue.ts}` + tests, `apps/core/scripts/seed-lab-catalogue.ts`, `apps/core/test/fixtures/lab-catalogue.json` (~60 orderables, ~140 analytes, ranges, three reflex rules, all INACTIVE-by-default auto-verify).

**Produces:** `resolveRange(analyte, {ageDays, sex, pregnancyTrimester?}, at)` (DD2, pure); `evaluateFormula(analyte, siblings)` (DD3, pure, guarded, no `eval`); `matchReflex(rules, result)` (pure); `overlappingAnalytes(orderableA, orderableB)` and `duplicateWarnings(exec, actor, canonicalPatientId, serviceIds, now)` — resolves the merge chain via `patients`' `resolvePatientId` FIRST (§6A.4), calls `findRecentItems` per candidate `service_id` AND per every orderable sharing ≥1 analyte with it (§6A.3), window from the catalogue (default 24 h; troponin 6 h — 02 D11); `upsertOrderable`/`upsertAnalyte` with `version` bump and `lab.catalogue.manage`; seed script creating the `investigation` `services` rows the fixture names (row 20: none exist).

#### Assertion Book — T3
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | Range resolution uses age AT COLLECTION in IST days, and the band boundary is inclusive-low/exclusive-high. | Age computed from `now` in UTC. | **DOB `2025-08-29`, collected `2026-08-29T00:30+05:30` (= `2026-08-28T19:00Z`).** Shipped: 365 days → infant band. Mutant: 364 → neonate band, different `ref_high`. |
| **A2** | `sex='any'` is the fallback when no sex-specific row exists; `other`/`unknown` never throws and stamps `ref_note='reference range: unspecified sex'`. | Fallback to `male`. | **Haemoglobin with male/female rows only, patient `other`.** Shipped: no numeric range + note. Mutant: male range, no note. |
| **A3** | Friedewald LDL yields `'not calculable (TG ≥ 400)'` text, never a number, when the guard fails. | Guard ignored. | **TC 200, HDL 40, TG 450.** Shipped: text. Mutant: `70`. |
| **A4** | A formula reads siblings of the SAME specimen only. | Latest sibling result for the patient, any specimen. | **Two specimens same day; TG on the second only.** Shipped: LDL on the first is `'not calculable (TG missing)'`. Mutant: computes with the second's TG. |
| **A5** | Duplicate detection sees a CBC inside "Fever Profile" ordered yesterday when a standalone CBC is ordered today. | Compare `service_id` only. | **Profile P (analytes CBC+Widal) placed −20 h; order CBC now.** Shipped: warning naming P's item. Mutant: none. |
| **A6** | Duplicate detection resolves the merge chain before it looks. | Look up the given id. | **Patient B merged into A; B's order −2 h; order for A now.** Shipped: warning. Mutant: none. |
| **A7** | Reflex matches only ACTIVE rules and only when the parent item carries `reflex_consented_at`. | Active flag ignored. | **TSH 9.0, rule TSH > 6 → FT4 inactive.** Shipped: no match. Mutant: match. |
| **A8** | A `critical_low/high` override on the resolved range row beats the analyte's default. | Read the analyte's only. | **K⁺ neonate range row with `critical_high 7.0`, analyte default 6.0, value 6.5.** Shipped: not critical. Mutant: critical. |

**Acceptance:** rows per rule 21; golden fixture round-trips through the seed script onto a private database and `select count(*) from lab_orderables` matches the fixture; fail-first owed and quoted.
**Commit:** `feat(core): lab catalogue, IST age-band range resolver, guarded formula evaluator, analyte-overlap duplicate detector (17 T3)`

### T4 — Ordering at the desk: advised tests → order + invoice in ONE idempotent transaction; walk-in visit; consent gate; add-on; the two workflow definitions — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{desk.ts, workflow-def.ts, definitions.ts}` + tests, `apps/core/src/modules/lab/definitions/{lab_item.json, lab_specimen.json}`; Modify `apps/core/src/modules/opd/encounters.ts` (export `openLabWalkin` per DD15/S2), `apps/core/src/modules/opd/index.ts` (re-export), `apps/core/src/modules/lab/index.ts`.

**Produces:** `deskOrder(tx, actor, input)` — `{encounterNo, orderGroupId?, items:[{serviceId, priority?, consent?:{recordedBy}}], invoice:{draftId, receipt?}, reflexConsent: boolean, duplicates:{acknowledged:[{itemServiceId, duplicateOfItemId, reason}]}}` → `placeOrder` (kind `lab`, `authority` from the visit — `clinician` with the visit's doctor, or `external_prescription` for a walk-in), `restricted:true` for `consent_required` orderables, `origin:'duplicate_confirmed'` + `duplicate_of_item_id` for acknowledged duplicates, then `issueInvoice` with one line per item and the visit's tags, then `lab_items` rows carrying invoice ids and `startInstance('lab_item')` per item, `lab.order_desked` — all in the caller's transaction; the controller wraps it in `withIdempotency({actorId, route:'lab.desk.place', key})`. `addOnOrder(tx, actor, {parentItemId, serviceIds, specimenId?})` per DD9 with `charge_reason:'lab_addon'`. `openLabWalkin` per DD15. Definitions: `lab_item` states `ordered → awaiting_collection → collected → accessioned → in_analysis → resulted → verified → published`, with `recollection_pending`, `cancelled`, `sent_out` reserved (17-M), `rerun` loop `resulted → in_analysis`; `lab_specimen` per §3.2. Both validate under `defineWorkflow` and are drafted+activated by the seed (Class C default; owner-only activation in production is the §10.4 runbook act).

#### Assertion Book — T4
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | A replayed `lab.desk.place` with the same key returns the SAME `orderNo` and the SAME `invoiceId`, and the database holds ONE order, ONE invoice, ONE `order.placed`. | Idempotency wrapper bypassed (work runs twice). | **Two sequential calls, same key, same body.** Shipped: equal ids, counts 1/1/1. Mutant: `L…0001` and `L…0002`, two invoices. |
| **A1b** | Two CONCURRENT calls with the same key: exactly one does the work; the other returns the replay — measured over ≥ 8 rounds (rule 20: no other agent running; `pgrep -af jest` lines read, not counted). | Claim taken AFTER the work. | **`Promise.all` of two placements.** Shipped: 1 order every round. Mutant: 2 in ≥ 1 round. |
| **A2** | The same key with a DIFFERENT body is refused, not replayed. | Hash not compared. | **Second call adds an item.** Shipped: `idempotency_mismatch`. Mutant: the first invoice returned for a different basket. |
| **A3** | Placement and invoice are ONE transaction: an invoice failure leaves no order and no `order.placed`. | Invoice issued after commit. | **Fixture with a `service_id` the tariff has no price for.** Shipped: 0 orders, 0 events. Mutant: an order with no invoice. |
| **A4** | `consent_required` orderable without `consent` is refused before `placeOrder`; with it, the item is `restricted:true` and `lab_items.consent_recorded_at/by` are set. | `restricted` left default. | **HIV orderable with consent.** Shipped: `order_items.restricted = true`. Mutant: false — and the kernel reader shows it to the ward clerk. |
| **A5** | The doctor's `advised_tests` are converted EXACTLY (same `serviceId` set, same count) and an orphan `serviceId` (S5) refuses with `unknown_service` naming it. | Skip unknowns silently. | **Three advised, one orphan.** Shipped: refusal. Mutant: two placed, patient billed for two of three "as advised". |
| **A6** | An add-on on an OPEN order is a NEW order in the same `order_group_id`, `origin:'addon'`, and touches `order_items` only through `placeOrder`. | `INSERT INTO order_items` on the parent. | **Add LFT to an open CBC order.** Shipped: 2 orders, 1 group; `pg_stat_user_tables`-free proof: the parent's `order_items` count stays 1. Mutant: parent gains an item. |
| **A7** | A walk-in with `authority:'external_prescription'` carries a `partners.id` — the chosen partner or the sentinel — and emits `attribution.unverified_flagged` when no Rx image / confirmation. | Sentinel omitted. | **Unattributed walk-in.** Shipped: sentinel id, flag event. Mutant: the CHECK throws at `placeOrder` and the desk is unusable for walk-ins. |
| **A8** | `lab_item.json` has no transition `ordered → resulted` and no transition INTO `verified` from anywhere but `resulted`; both JSONs validate under `defineWorkflow`. | A shortcut transition added. | **Matrix walk.** |

**Acceptance:** rows per rule 21; `pnpm --filter @hmis/core exec jest src/modules/lab src/modules/opd/encounters.test.ts src/modules/billing/idempotency.test.ts` green on the named database; fail-first owed and quoted.
**Commit:** `feat(core): lab desk — advised tests to order + invoice in one idempotent transaction, walk-in visit, consent gate, add-on as a grouped order, two definitions (17 T4)`

### T5 — Collection and accession: the phlebotomy queue, labels and `S` numbers, right-patient scan, receive/reject/recollect, TAT start, the two sweeps — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{collection.ts, specimens.ts, accession.ts, sweeps.ts}` + tests (+ `accession.concurrency.test.ts`); Modify `apps/core/src/kernel/worker/jobs.ts` (two `scheduler.register` entries, the `sweepBatchExpiry` shape), `apps/core/src/kernel/worker/worker.module.ts` (nothing more than T2's install), `apps/core/src/config.ts` + `JobIntervals` (`workerLabSweepIntervalMs` — a TYPE event: every `JobIntervals` literal in the suite must carry it, `CENSUS_INTERVALS` in `scheduler.test.ts` finds it), `apps/core/test/helpers/db.ts` (only if T1 missed a table — it must not).

**Produces:** `collectionQueue(db, actor, {site, serviceDate})` read model (items `awaiting_collection`, priority order STAT > urgent > routine, token, alias per kernel rule, PHI logged `lab.results`? no — surface `lab.worklist` carries no result; DD14 applies to names: alias rule only); `printLabels(tx, actor, {orderGroupId, scannedUhid})` — refuses `tube_mismatch` when `scannedUhid ≠ patient.uhid` (DD10), mints one `lab_specimens` row per distinct `(specimen_type, container)` across the group's items (`S` via `nextEpisodeNo`, S6), links `lab_specimen_items`; `collect(tx, actor, {specimenId, wristbandScanned, site})`; `receive(tx, actor, {specimenNo, containerSeen, identityRecheckBy?})` — container check (02 G8), unscanned-without-recheck refusal (02 A2), **`advanceOrderItem(… 'in_progress')` for every active item on the tube, `tat_started_at`, `lab.specimen_received`**, walk-in without invoice ⇒ `issueInvoice` on credit (DD6); `reject(tx, actor, {specimenNo, reason, attributableTo})` → new specimen for the same items, `lab.recollection_requested`, no charge; `sweepLabNonReturn`, `sweepLabSla` (DD20).

#### Assertion Book — T5
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | Two concurrent `receive` calls for the same `specimen_no`: one wins, the other gets `already_received`; exactly ONE `lab.specimen_received` and ONE `order_item.started` per item — ≥ 8 rounds measured. | Read status then update without a CAS. | **`Promise.all` of two receives.** Shipped: 1/1 every round. Mutant: 2 events in ≥ 1 round. |
| **A2** | `S` numbers are unique across concurrent label prints on the same day — the counter's row lock, inherited. | Pre-read `nextNo` outside the update. | **Two concurrent `printLabels`.** Shipped: `S…0001`, `S…0002`. Mutant: a duplicate that the UNIQUE refuses in one of them. |
| **A3** | A rejected specimen's recollection posts ZERO additional charge and the item's `lab_items.invoice_line_id` is unchanged. | `issueInvoice` on recollection. | **Reject haemolysed, reprint, receive.** Shipped: 1 invoice line. Mutant: 2. |
| **A4** | The 7-day non-return sweep cancels the item with `cancel_reason='no_recollection'` and DD7 issues a credit note; a rejection 6 days 23 h old is untouched. | `>=` off by a day, or the credit note skipped. | **Two rejections at −7 d 1 h and −6 d 23 h; clock injected.** Shipped: one cancel + one credit note. |
| **A5** | `printLabels` with `scannedUhid` of another patient in the queue refuses `tube_mismatch` and emits `lab.tube_mismatch_flagged`; no `lab_specimens` row is written. | Refusal after the insert. | **Two Ram Kumars, wrong scan.** Shipped: 0 rows. Mutant: a labelled tube for the wrong person. |
| **A6** | An unscanned ward collection cannot reach `received` without `identityRecheckBy`; with it, the recheck is stored. | Check skipped when `wristbandScanned=false`. | **Ward collection, no scan, no recheck.** Shipped: `identity_recheck_required`. |
| **A7** | The TAT clock starts at `receive`, not at `collect` and not at placement. | `tat_started_at = placed_at`. | **Place 09:00, collect 09:20, receive 09:50.** Shipped: 09:50. |
| **A8** | The SLA sweep breaches an item whose stage age exceeds the ACTIVE definition's SLA for its priority, emits once, and never for a `cancelled` item. | Emit every sweep. | **Two sweeps over one breached item.** Shipped: 1 event. Mutant: 2. |

**Acceptance:** rows per rule 21; concurrency rows measured with the private database and load noted (`uptime` at launch quoted); the sweep registration counted by `seed-cursors.test.ts`'s and `scheduler.test.ts`'s censuses; fail-first owed and quoted.
**Commit:** `feat(core): lab collection and accession — S numbers, right-patient scan, receive with CAS and TAT start, reject/recollect free, two worker sweeps (17 T5)`

### T6 — Results: manual entry, absurd envelope, snapshot ranges, flags, delta, SoD verification, night mode, criticals with the call ladder, rerun, SYNCHRONOUS reflex, `completed` at verify — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{results.ts, verify.ts, criticals.ts}` + tests (+ `verify.concurrency.test.ts`).

**Produces:** `enterResult(tx, actor, {orderItemId, analyteId, value, unit?, entryMode, remarks?, absurdOverride?})` — refuses outside `absurd_low/high` unless `absurdOverride` by a second `lab.results.enter` holder (02 H1), resolves and snapshots the range (T3), sets `flag`, runs delta against the previous VERIFIED result of the same analyte for the canonical patient within `delta_window_hours` (02 H2 — a flagged row can never auto-verify, which is moot here but asserted for 17-E), opens a critical call when outside the critical band (DD12), computes formula analytes of the same specimen when all inputs exist (T3), `lab.result_entered`; `verifyResult(tx, actor, {resultId})` — SoD (DD11), `lab.results.verify`, CAS on `verification_status='unverified'`, `verified_by/at`, **reflex** (DD8, `placeOrder` in the same tx), **`advanceOrderItem(… 'completed')` when every analyte of the item has a verified row**, `lab.result_verified`; `requestRerun` (`rerun_of`, free, back to `in_analysis`); `acknowledgeCritical(tx, actor, {callId, attempt | readback})` closing only on read-back text (02 §3.6); a `system` actor is refused at `verifyResult` (DD11).

#### Assertion Book — T6
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | Enterer ≠ verifier is enforced per RESULT ROW even when one user holds both permissions; night mode flips it to allowed-with-flag. | SoD checked on role, not on `entered_by`. | **Tech with both permissions, night mode off.** Shipped: `sod_violation_blocked`. Mutant: verified. |
| **A2** | Two concurrent verifies of one result: one `lab.result_verified`, the loser `already_verified` — ≥ 8 rounds. | Read-then-write. | **`Promise.all`.** |
| **A3** | `completed` fires on the envelope item exactly when the LAST analyte verifies, never earlier, and the transitions row's actor is the verifier. | Advance on the first verify. | **CBC with 3 analytes, verify two.** Shipped: item `in_progress`. Mutant: `completed` with a result missing — and 22c-F would show a report that does not exist. |
| **A4** | Reflex: verifying TSH 9.0 (rule active, consent given) places ONE new order in the same group as `system`/`protocol`/`protocol_ref = rule id`/`origin:'reflex'`/`parent_item_id`, attached to the same specimen, invoiced with `charge_reason:'lab_reflex'`, in the SAME transaction (a forced failure after the reflex rolls both back). | Reflex placed after commit. | **Inject a throw after `placeOrder`.** Shipped: 0 orders, 0 results verified. Mutant: the reflex order survives a failed verify. |
| **A4b** | Reflex is NOT placed when `reflex_consented_at` is null, and NOT placed twice when the same result is re-examined. | Consent ignored. | **Same value, no consent.** Shipped: 0. |
| **A5** | A critical value opens exactly one `lab_critical_calls` row at ENTRY (before any verify), and the call cannot close without `readback_text`. | Open at verify. | **K⁺ 6.8 entered, not verified.** Shipped: 1 open call. Mutant: 0. |
| **A6** | The snapshot on the result is the range as it was at entry: a range-table edit afterwards changes nothing on the row or the flag. | Read the range at report time. | **Enter, then move `ref_high`.** |
| **A7** | Delta compares against the previous VERIFIED result of the same analyte for the CANONICAL patient, not an unverified one and not a sibling's (02 A3). | Previous row regardless of status. | **Prior unverified 4.2, prior verified 0.9, today 4.1.** Shipped: delta flagged (vs 0.9). Mutant: not flagged (vs 4.2). |
| **A8** | An absurd value (glucose 1200 mg/dL) is refused without a second holder's override; with it, `absurd_overridden_by` is stored. | Envelope not checked. | as stated |
| **A9** | A `system` actor is refused at `verifyResult` (`user_actor_required`) — the auto-verify seam is structurally closed in this phase. | Type not checked. | as stated |

**Acceptance:** rows per rule 21 (A4's rollback proof by an injected throw, the OT cockpit precedent); `expect(spy.mock.calls.map(c => c[1]))` shape for any spy on a `Db`-taking function (§2.139); fail-first owed and quoted.
**Commit:** `feat(core): lab results — manual entry with absurd envelope and snapshotted ranges, delta, SoD verify with CAS, criticals with read-back, synchronous reflex, completed at verify (17 T6)`

### T7 — Reports: versioned snapshot, the DELIVERY INTERLOCK, publish, print with release register, WhatsApp "ready" notice, amendment, PHI logging — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{reports.ts, interlock.ts, money.ts}` + tests; Modify nothing outside `modules/lab/` (billing is CALLED: `settlementState`, `issueCreditNote`, `issueInvoice`; notify is CALLED: `enqueueNotification`; templates registered per S7 in `modules/lab/notify-templates.ts`).

**Produces:** `money.ts` — `chargeReasonFor`, `refundOnCancel(tx, actor, orderItemId)` implementing DD7 from `cancelled_from` + `exists(lab_results)`, **invoked synchronously by every lab cancel path** (the sweep, the desk's cancel, the pathologist's cancel) rather than by a subscription to `order_item.cancelled` — the lab is the only writer that cancels lab items, and a subscription would be a second answer to one question; `interlock.ts` — `deliveryAllowed(exec, orderId)` per DD6 returning `{allowed, reason: 'unpaid_lines' | 'exempt_payer' | 'settled' | 'released_by_approval', unpaidLineIds}`; `reports.ts` — `publishReport(tx, actor, {orderId})` (all items terminal or explicitly `partial:true` for a package-style partial at 24 h — 02 D7; snapshot of verified results with ranges/flags/notes; `signed_by = actor` with `lab.reports.publish`; `lab.report_published`; `enqueueNotification` of the "report ready" template with NO values, NOT for `sensitive` orderables (DD14), delivery channel recorded), `printReport(tx, actor, {reportId, collectorIdentity})` (refuses `report_print_blocked` when `!deliveryAllowed` and no `approvalId` for `lab.release_unpaid`; writes `lab_report_deliveries`), `releaseUnpaid` (approval flow, `lab.report_released_unpaid`), `amendReport(tx, actor, {reportId, resultCorrections:[…], reasonCode})` (new result rows superseding, new version, `AMENDED` re-notify per R-018), `getReport(db, actor, reportId)` / `listResultsForEncounter` — alias rule + `recordPhiAccess(surface:'lab.report' | 'lab.results')`, and **the doctor's read never calls `deliveryAllowed`**.

#### Assertion Book — T7
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | `deliveryAllowed` sums the SETTLEMENT of every self-pay line on the report's items — an order with two items, one paid at the desk and one reflex line unpaid, is BLOCKED. | Check the desk invoice only. | **Paid CBC + unpaid reflex FT4.** Shipped: blocked, `unpaidLineIds=[FT4]`. Mutant: allowed. *(The §9.7 operand question, pre-answered.)* |
| **A2** | `tpa`, `pmjay`, `corporate` visits and every `D` encounter deliver with ZERO receipts. | Payer ignored. | **Corporate visit, no receipt.** Shipped: allowed `exempt_payer`. |
| **A3** | The doctor's `listResultsForEncounter` returns verified results for an UNPAID self-pay order; `printReport` for the same order refuses `report_print_blocked` and emits it. | Interlock applied at read. | **Unpaid, verified.** Shipped: read 200 with rows; print refused. Mutant: the doctor sees nothing — the safety defect O-1 forbids. |
| **A4** | Release-unpaid with an approval id prints, records the approval on the delivery row, and does NOT alter the invoice or dues (`patientBalance` unchanged before/after). | Release writes a credit note. | **Approve, print, compare balances.** |
| **A5** | `refundOnCancel`: `cancelled_from='placed'` ⇒ one credit note for exactly that line's paise; `cancelled_from='in_progress'` with a result row ⇒ NO credit note; `in_progress` without a result ⇒ credit note. Three fixtures, three outcomes. | `cancelled_from` ignored (always refund). | **The three fixtures.** Shipped: 1 / 0 / 1 credit notes. Mutant: 1 / 1 / 1 — the legacy rule violated silently. |
| **A6** | A published report's snapshot is immutable: the trigger refuses an UPDATE, and an amendment is version n+1 with `prior_version_id`, the superseded result row still readable. | Update in place. | **Amend Hb 12.0 → 10.2.** Shipped: 2 report rows, 2 result rows, v1 `superseded`. |
| **A7** | The WhatsApp "ready" enqueue carries NO result values and is NOT enqueued for a `sensitive` orderable; `lab.report_published` fires regardless of the enqueue outcome (02 C5). | Values in the body / sensitive not checked. | **HIV report published.** Shipped: 0 notifications, 1 event. |
| **A8** | `getReport` for a sealed patient by a caller without `patients.confidential.read` returns the alias and writes ONE `phi_access_log` row with `surface='lab.report'`; the same caller's second read writes a second row. | Log skipped on the alias path. | **Sealed fixture, clerk.** Shipped: alias, 1 row. Mutant: 0 rows. |
| **A9** | Print without `collectorIdentity` is refused (02 J2); with it the release register row names the collector and the printer. | Identity optional. | as stated |

**Acceptance:** rows per rule 21; **`money.ts` and `interlock.ts` are the reviewer's first two files**; fail-first owed and quoted.
**Commit:** `feat(core): lab reports — versioned snapshots, delivery interlock with payer branch and approval release, print register, ready-notice, amendment, cancel-money rule (17 T7)`

### T8 — Routes, four screens, the print component, the consult panel, i18n, nav parity, realtime — **ROUTINE**

**Files:** Create `apps/core/src/modules/lab/{lab-desk.controller.ts, lab-collection.controller.ts, lab-bench.controller.ts, lab-verify.controller.ts, lab-catalogue.controller.ts, realtime.ts}`, `apps/core/test/lab.e2e.test.ts`; `apps/web/src/screens/{lab-desk, lab-collection, lab-bench, lab-verify}.tsx` + tests, `apps/web/src/components/lab-report-print.tsx` + test; Modify `apps/web/src/router.tsx` (four `path:` lines — the SPA's hard-coded NAV table, Plan 14 M6's specimen), `apps/web/src/locales/{en,hi}.json`, `apps/web/src/screens/opd-consult.tsx` (the ONE results panel), `apps/core/test/nav-parity.test.ts` (census), `apps/web/src/shell-nav.test.tsx` (census), `apps/core/src/modules/lab/lab.module.ts` (controllers; `LabModule` imports `RealtimeModule` for the bench/collection topic spaces `lab:collection:<site>`, `lab:bench:<benchId>` over `lab.worklist.read`), `apps/core/src/app.module.ts` (ONE import line for `LabModule`).

**Produces:** every route zod-validated, `Idempotency-Key` read on the nine DD19 routes, `LabError.toHttp` mapped (the Plan 09 500 specimen asserted by an e2e that hits a refusal over the wire); screens per DD21 with the OPD screens' keyboard/`SubmitButton` conventions; the print component with the "Laboratory report A4" layout if S8 finds it, else `rx-print.tsx`'s; `hi.json` carries every new key (the i18n census test).

**Acceptance:** `pnpm --filter @hmis/web test` and `apps/core/test/lab.e2e.test.ts` green; `nav-parity` and `shell-nav` censuses updated; the wire test for `administrativeGender`'s class of defect — **every route's body is asserted over HTTP, not by calling the service** (22c-A C1). No fail-first owed; say so.
**Commit:** `feat(web,core): lab desk, collection, bench and verify screens, A4 report print, consult results panel, routes with idempotency keys (17 T8)`

### T9 — Gate report, runbook, drills, the production seed of the owner's catalogue, KPIs deferred — **ROUTINE**

**Files:** Create `docs/superpowers/plans/reports/2026-XX-XX-plan-17-gate-report.md`, `docs/runbooks/lab-go-live.md` (grants for four roles + three kernel `orders.*`; catalogue seed from the owner's spreadsheet via `seed-lab-catalogue.ts`; the pathologist-of-record and signatory block as config; the `LAB` department; definitions activation as the owner's §10.4 act; the pilot-as-secondary window and its harvest form; the paper downtime path — 02 C3/C4 — with `label_source='downtime_kit'`); Modify this document's §9.

**Produces:** the honest §19-style lines (what is proven by execution, what is proven by reading, what is not proven); the drill script for the three chaos rows this plan can run (a critical at 02:00 with no pathologist logged in; a rejected tube on a departed OPD patient; a printer-down label fallback). KPI lines (02 §8) are NOT registered — Plan 21's registry does not exist (02 §15.10); the raw events they derive from are DD18's and that is stated.

**Acceptance:** documents committed by path; nothing in `apps/`. No fail-first.
**Commit:** `docs(plan): Plan 17 gate report, go-live runbook, drills (17 T9)`

---

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

### 9.4 The Assertion Book, corrected by execution
### 9.5 Mechanical verification — name the `TEST_DATABASE_URL` database of every run claimed (§2.137)
### 9.6 The independent close review (pass 1, fresh) and 9.6.2 (pass 2, fresh, over the fixes, verdict per fix)
### 9.7 Actuals — recorded only after §9.6 exists (v3 §9.4)
### 9.8 The question this phase existed to answer
### 9.9 Deploy block — the grants, the catalogue seed, the definitions activation, the department, the signatory — written when the owner authorises, never before
