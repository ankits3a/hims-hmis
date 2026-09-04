# Phase 16c — The OPD dispense counter (Pharmacy series, 3 of n)

**Lane: LIGHT** (7 PRs: two tiny hub exports + five tasks; one new leaf module; one additive migration — EXECUTE-METHOD-V3 §2). Money lives in the tariff engine, locking in the materials ledger; 16c calls both, writes neither.
**Stop-loss: 2,120,000** = main-session `7 × 200,000` + subagents `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145).
**Balance at kickoff: ~14.85M** (§2.141).
**Lane:** `/opt/hmis-lanes/pharmacy/hmis`, `lane/pharmacy`, own test DBs; `origin/main` at `5feef43`. One task = one PR, squash, auto-merge, CI as the gate; locally only touched suites; `tools/lane.sh status` before any full core run (LIMS and radiology lanes are live); rebase each morning. **Migration number taken at rebase** (head `0052` today).

## 1. Why this phase, and where it stops

No pharmacy module exists. Formulary (16a) is live; materials (14) is code-complete with ONE stock ledger; OPD issues QR-signed prescriptions; billing carries a batch-grain cap only the OT uses. Doc 16 §14 gave 16c the batches; Plan 14 §4A.2 ruled the ledger into materials and this document keeps it: **pharmacy consumes the ledger; `pharmacy_batches` does not exist.**

**Finish line:** one patient end to end over HTTP (T5): e-Rx → scan or token → pharmacist verifies → FEFO pick from materials stock → invoice at `min(batch MRP, ceiling, tariff)` → hand over with the ledger debited through `materials/index.ts` and the `medication` kind claimed. No deploy: gated on 14's.

## 2. Ground truth — measured 2026-09-02 at `5feef43`; re-measured at kickoff

| # | rail (where) | consumer | 16c |
|---|---|---|---|
| 1 | Kind **`medication`** reserved for Plan 16 (`orders/kinds.ts` DD9); series **`pharmacy_dispense` = `P`** (`series.ts:26`); claimed today `lab`, `imaging` | `parity.test.ts` pins | T1; the brief's "pharmacy_dispense kind" is the SERIES (D1) |
| 3 | `fefoPick`, `reserveStock`/`consumeReservation`/`releaseReservation`, `postMovement`, `mrpPerBaseUnit`, `toBase`/`fromBase`: "the pharmacy seam, NO route" | **NONE** | T4 |
| 4 | `material.consumed` carries `caseRef{type,id}`, MRP and ceiling per base; OT's consumer skips other types | OT | T4 |
| 5 | `InvoiceLineInput.capUnitPaise`, a per-UNIT bound in the `min` with MRP and NPPA; `regulated_prices` is per SERVICE; `priceLine` throws `tariff_item_missing` without a version price; `services.category` admits `pharmacy` | OT bill only | T4; **S2/T0b** is 14 §4A.4's bridge |
| 6 | `issueInvoice` with tenders; OPD resolver `V`; a pharmacy-only invoice flips no token; `placeOrder(tx, actor, decls, input)` items need `serviceId` | counter, lab, OT | T3, T4 |
| 7 | `verifyPrescriptionQr` (`POST …/prescriptions/verify`), `listPrescriptions`, `runRxChecks` — **none in `opd/index.ts`** | HTTP only | **T0a** |
| 8 | `RxLine` has no quantity; no token→visit export (`listVisits` only) | lab | D4, D5 |
| 9 | `listAllergies`, `verifyQrScan`, `searchPatients`; `schedule_flag ∈ H/H1/X/OTC`; `resolveMedicines`, `listInteractionsAmong` | opd | T3 |
| 10 | `items.gst_rate_bps`, `hsn_code`; `stock_batches.mrp_paise/mrp_uom/expiry_date`; `item_price_regulations.ceiling_paise` | GRN, OT | T2 |
| 11 | Role `pharmacy`: 8 permissions, **no holders**; 149 permissions / 278 pairs pinned; 44 routes, two parity tests; seat primitives (`PatientStrip`, `TokenSlip`, `QrCard`, `PatientPicker`); `materials.e2e` does a GRN over HTTP | — | T1, T3–T5 |

## 3. Spike — answered by reading at kickoff

- **S1** — does `consumeReservation` emit `material.consumed`? If not, T4 releases and posts via `postMovement` in the same tx.
- **S2** — GST per line: `computeGst` is category-keyed. If it cannot take `items.gst_rate_bps`, the bridge maps slabs to data-only categories (`pharmacy`, `pharmacy_12`, `pharmacy_18`). Decides T0b's size.
- **S3** — what `issueInvoice` demands of the actor (permission, cashier session, both); `pharmacy` receives what `lab_reception` holds, named in T1.
- **S4** — `runRxChecks`' signature; if bound to the consult, T0a exports `matchAllergies` and the formulary pair read instead.

## 4. Design decisions — DECIDED (money and law: §7)

- **D1 — Claim `medication`, numbered `P`**: series `pharmacy_dispense`, `placePermission: pharmacy.dispense.place`, clinician required, no indication, not self-orderable. Placed AT THE COUNTER when the Rx is claimed, `orderingClinicianId` = the prescriber (17a T4's shape). OPD is untouched: the prescription stays the MedicationRequest, the order is its dispensing envelope, one item per line.
- **D2 — One ledger; pharmacy holds reservations, never balances.** Pick = `fefoPick` + `reserveStock` (30-min expiry); hand over = `consumeReservation`, one `consume` row per line with patient and encounter; decline/cancel = `releaseReservation`. Counter = materials store `PHARM-OPD`. Pharmacy rows carry batch and ledger ids as references only.
- **D3 — The item→service bridge is a pharmacy table.** `pharmacy_sale_items(item_id PK, service_id, active)`; `registerSaleItem` creates the tariff service through `tariff/index.ts` in the same tx (`RX-<item code>`, category per S2, `regulated:false`; the law arrives per batch as `capUnitPaise`). Plan 14 §4A.1 is CONFIRMED.
- **D4 — One field, three doors** (17c D4): Rx QR → `verifyPrescriptionQr`; patient QR → `verifyQrScan` then today's Rx; `T-n` → today's visit; `UH…` → patient. Names confirm, never select; 17c's token export is reused if it lands first.
- **D5 — Quantity is the pharmacist's.** Prefilled by a pure frequency parser × `durationDays` (`SOS` → blank), confirmed or edited in base units; strips via `fromBase`.
- **D6 — Substitution, minimal.** A null `medicineId` is RESOLVED at the counter (exact, else formulary search). GENERIC substitution only for the same salt set, strength and route class, never on `noSubstitution`, only with consent captured and printed; `substitution.recorded` emitted. No HELD states: an undispensable line is DECLINED with a reason code.
- **D7 — Schedule gate.** Any `H`/`H1` line needs `pharmacy.dispense.scheduled` at hand over (pharmacist only; the assistant claims and picks); `X` refused at claim (R-3); a scheduled hand over needs a second identity confirmation (token or phone last-4, doc 16 A1).
- **D8 — verify → pick → bill → hand over; stock consumed at hand over.** Money moves before the drug leaves; the reservation holds the batch between. Paid-not-collected past 24 h is 16d's refund path. Class-B definition `pharmacy_dispense` (lab shape): `queued → claimed → verified → picked → billed → handed_over | cancelled`; envelope `in_progress` at pick, `completed` at hand over.
- **D9 — Re-check at dispense.** Salt-aware allergies and severe interactions re-run on the RESOLVED medicines at verify; a hit blocks `verified` unless that line carries the prescriber's override.
- **D10 — The queue is pharmacy's own row.** A worker consumer of `prescription.issued` inserts `queued` (idempotent on prescription, version); a scan for an unqueued Rx creates it, so the e2e runs without the worker. `partnersManifest` rule: subscription, handler, install, census in ONE commit.

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T0a — ROUTINE · OPD exports (tiny hub PR, first)
**Files:** `opd/index.ts`, `opd/prescriptions.ts` (`getPrescription(db, actor, id)`, PHI-logged like `listPrescriptions`) + test. Exports it, `verifyPrescriptionQr`, `runRxChecks` or `matchAllergies` (S4), types. No behaviour change. Commit `feat(opd): prescription read surface for the dispensing counter (16c T0a)`

### T0b — ROUTINE · Tariff: a line may price from the batch (tiny hub PR)
**Files:** `tariff/types.ts`, `tariff/pricing.ts` + test. `InvoiceLineInput.batchUnitPaise?` honoured ONLY for `pharmacy*` categories (else `batch_price_not_allowed`); stands in when the version has no row, joins the `min` when it has; recorded on the clamp.
**Assertion book:** a `consultation` line with `batchUnitPaise` throws; mutant — guard dropped; kill — priced vs thrown. Commit `feat(tariff): pharmacy lines price from the batch MRP, category-guarded (16c T0b)`

### T1 — CRITICAL · The seam: schema, manifest, the kind claimed, roles
**Files:** `kernel/db/schema/pharmacy.ts` (+1 line in `index.ts`), `drizzle/00NN_pharmacy_dispense.sql`, `modules/pharmacy/{manifest, events, errors, config, workflow-def, definitions, index, pharmacy.module}.ts` + tests, `app.module.ts`, `orders/parity.test.ts`, `seed-roles.ts` + census.
Tables: `pharmacy_sale_items`; `pharmacy_dispenses` (P number, order, prescription+version, patient, encounter, store, status, actors, invoice); `pharmacy_dispense_lines` (medicines ordered/dispensed, substitution and consent, item, qty, batch, reservation, ledger entry, invoice line, order item, price and winner, schedule, declined reason); `pharmacy_reg_h1` (Rule 65(3) fields; UPDATE/DELETE trigger-refused). Permissions `pharmacy.dispense.{place,read,scheduled}`, `pharmacy.sale_items.manage`; `pharmacy` widened (+`orders.place`, S3 grants); new `pharmacy_assistant` (never `.scheduled`).
**Assertion book:** boot lists `medication` on series `P`; mutant — `seriesKey:"lab_order"`; kill — clean boot vs refusal. Second: UPDATE on `pharmacy_reg_h1` raises.
**Commit:** `feat(pharmacy): module seam — four tables, the medication kind claimed on the P series, two roles (16c T1)`

### T2 — CRITICAL · Sale items and the price rule at batch grain
**Files:** `pharmacy/{sale-items, price}.ts` + tests, `pharmacy-items.controller.ts`, `fixtures/pharmacy-price.json`, `lib/pharmacy-api.ts`, `screens/pharmacy-items.tsx` (+test), locales.
`registerSaleItem` (D3); `priceForBatch(batch, regulation, uoms) → {batchUnitPaise, capUnitPaise, winner}` PURE: MRP per base and `min(MRP, ceiling)` per base, `price_unknown` when both null. Golden fixtures per GST slab and per winner.
**Assertion book:** MRP above ceiling prices at the ceiling; mutant — `max` for `min`; kill — paise differ. Second: a `consumable` item refused as a sale item.
**Commit:** `feat(pharmacy): sale items bridge a drug item to a tariff service; the batch-grain price rule with golden fixtures (16c T2)`

### T3 — CRITICAL · Queue, claim, verify — the counter's first half
**Files:** `pharmacy/{queue, consumers, claim, verify, qty}.ts` + tests, `pharmacy-counter.controller.ts` (queue, find, claim, verify, decline, cancel), worker install, `screens/pharmacy-counter.tsx` (+test, `[data-seat="pharmacy-counter"]`), locales.
Claim: D4 → `placeOrder` → dispense `claimed`, lines resolved (D6), schedule flags, qty prefilled (D5). Verify: D9; H1 flagged; X refused (D7).
**Assertion book:** two counters claiming one `(prescription, version)` concurrently yield ONE order and ONE dispense; mutant — unique index dropped; kill — 2 vs 1. Second: a line matching an active allergy salt cannot reach `verified` without that line's override.
**Commit:** `feat(pharmacy): the counter — three doors to the Rx, the medication order placed, verify with re-check, decline and cancel (16c T3)`

### T4 — CRITICAL · Pick, bill, hand over — stock and money
**Files:** `pharmacy/{pick, bill, handover, label}.ts` + tests incl. `pick.concurrency.test.ts`, controller (pick, bill, handover, label), `components/dispense-label.tsx`, counter screen second half, locales.
Pick: `fefoPick` per line at `PHARM-OPD` (override evented), `reserveStock` per batch; short stock → partial with reason, or decline. Bill: `issueInvoice` in the dispense tx, lines `{serviceId, qty, batchUnitPaise, capUnitPaise}` from T2, tenders from the screen, encounter = the OPD visit. Hand over: D7 gates, `consumeReservation` per line (S1), `advanceOrderItem → completed`, H1 rows, `dispense.handed_over`, the bilingual label.
**Assertion book:** two dispenses picking the last 10 tablets of one batch concurrently: one holds, one gets `insufficient_stock`, balance never negative; mutant — a plain insert outside the ledger lock; kill — two holds vs one. Second: a ceiling-clamped line's `netPaise` equals the T2 fixture to the paisa. Third: `pharmacy_assistant` handing over an `H1` line is refused and no ledger row exists after.
**Commit:** `feat(pharmacy): pick FEFO under the ledger lock, bill at batch grain, hand over debits materials and writes the H1 register (16c T4)`

### T5 — ROUTINE · Routes, NAV, the walk, the CLOSE
**Files:** `router.tsx` (`/pharmacy/counter`, `/pharmacy/items` appended; NAV), manifest menu, parity tests if they pin, `test/pharmacy.e2e.test.ts`, `runbooks/pharmacy-go-live.md`, this doc §8.
One `it`: register → visit → Rx of three lines (H1, `noSubstitution`, OTC) → item, sale item, GRN into `PHARM-OPD` → scan → verify → decline the unstocked line → pick → bill cash → pharmacist hands over → read back ledger rows and balance, invoice clamp, order items, one H1 row, `material.consumed` from `pharmacy_dispense`.
**Commit:** `test(pharmacy): one patient from e-Rx to hand over over HTTP; go-live runbook; 16c CLOSE`

**Verify economy:** per task `pnpm typecheck && pnpm lint`, then `modules/pharmacy/*.test.ts`, the hub suite touched, `seed-roles.test.ts` (T1), `pharmacy.e2e.test.ts` (T5), `vitest run screens/pharmacy-*`. CI runs everything. Whoever rebases second across the pair resolves the tail of `router.tsx` and both locale files.

## 6. Out of scope

IPD indents, eMAR charge point (O-1); ward stock, crash carts; NDPS, Schedule X, Form 3E; returns (O-7), abandoned-paid refunds; cold chain; AMS; HELD_FOR_DOCTOR; interventions, ADR, recall actions; walk-in retail and outside-Rx (O-3 first); repeats (O-5); home delivery (O-10); counts; the three automations; realtime, agent bar; pack-level pricing.

## 7. Owner rulings — money and law only, each with a recommended default

**RULED 2026-09-02: the owner adopted every recommended default below ("do the needful which is most logical"); execution proceeds on them.**

- **R-1 (money, law) — price at batch grain.** Recommend `min(batch MRP per base unit, NPPA ceiling on the dispense date, contracted tariff if any)`; no MRP and no ceiling → unsaleable; the invoice line records the winner. Plan 14 F5: pharmacy bills BEFORE it consumes, so the invoice line is the freeze.
- **R-2 (money) — GST on medicines.** Recommend the item's slab from `items.gst_rate_bps` (5/12/18, nil), mechanism per S2; HSN on the invoice.
- **R-3 (law) — Schedule X and NDPS at the OPD counter.** Recommend refused in 16c; no such stock until 16d's double custody and the RMI application (doc 16 O-2).
- **R-4 (law) — Schedule H1 register from day one.** Recommend yes: Rule 65(3) fields at hand over, append-only, 3 years.
- **R-5 (money) — discounts on pharmacy lines** (O-6). Recommend only the tariff contest's existing `pharmacy` category cap in 16c; the landed-cost floor goes with 16d's returns.
- **Not a ruling, reversible by config:** D6 substitution ON with consent (O-4's default), a `config.ts` constant.

**Owner ACTIONS:** a second administrator; a registered pharmacist holding `pharmacy`; Plan 14's deploy.

## 8. CLOSE — executed 2026-09-02, one session, code-complete, NOT deployed

### 8.0 §2 re-measured at kickoff
Every row held. Two of the "consumer today" cells changed under us during the day: the LIMS lane's 17c T1/T2 merged (`798611c`, `b362f02`) and appended to `styles.css` and both locale files — one conflict at rebase (the stylesheet's seat block), resolved by keeping both blocks. Main moved five times in the session; PR #4 was re-based four times because branch protection requires an up-to-date branch and the token cannot re-run a workflow.

### 8.1 The commits (one PR each, in this order)
| task | commit | what moved |
|---|---|---|
| doc | `docs(pharmacy): Plan 16c phase doc…` + §7 RULED + a CI re-run commit | PR #4 |
| T0a | `feat(opd): prescription read surface…`; part 2 `findVisitByToken`; part 3 `getDoctor` on the index | three tiny OPD exports, each its own commit |
| T0b | `feat(tariff): pharmacy lines price from the batch MRP, category-guarded` | `batchUnitPaise`, `batch_price_not_allowed`, clamp `batch_mrp` |
| T1 | `feat(pharmacy): module seam — four tables, the medication kind claimed on the P series, two roles` | migration `0056`, README's seventh role table, every census pin |
| T2 | `feat(pharmacy): sale items bridge…; the batch-grain price rule with golden fixtures` | 9 golden rows, 3 GST slab rows in `seed:tariff` |
| T3 | `feat(pharmacy): the counter — three doors…; the Rx-issued consumer` | queue/claim/verify/decline/cancel, worker install, `PhiSurface` +1 |
| T4 | `feat(pharmacy): pick FEFO under the ledger lock, bill at batch grain, hand over…` | reserve/consume, `material.consumed`, H1 register, label |
| T5 | `test(pharmacy): one patient from e-Rx to hand over over HTTP; …` | 2 routes, NAV, menu, `seed-pharmacy`, e2e, runbook |

### 8.2 Findings and deviations — recorded, not hidden
- **F1 — the order is placed at VERIFY, not at claim** (D1 as executed). A line's tariff service is known only after resolution, substitution or decline; placing at claim would mean cancelling envelope items for every declined line. The `P` number is minted at verify. `pharmacy_dispenses_claimed_has_order_ck` was tightened to verified-or-later.
- **F2 — Class C, not Class B** (D8). Class B activation needs a `department_head` and a `duty_manager` approval no seed can supply on a one-administrator box; the lab made the same call at 17a. The gate that matters (schedule) is a permission, not a transition role.
- **F3 — S1 answered NO:** `consumeReservation` posts the movement and emits nothing; the pharmacy appends `material.consumed` itself with the batch's price facts (`caseRef.type = "pharmacy_dispense"`; the OT consumer already skips it).
- **F4 — S2 answered:** `computeGst` is category-keyed; four `pharmacy*` categories are data (`seed:tariff` +3) and `gstCategoryFor` maps `items.gst_rate_bps` to one.
- **F5 — S3 answered:** `issueInvoice` needs the cashier grants and an open session; `pharmacy` gained `lab_reception`'s four billing strings; the aide none. Verify needs `orders.place`, so verify is the pharmacist's act and the aide claims and picks.
- **F6 — supersession is keyed by ENCOUNTER:** a re-issued Rx is a new `opd_prescriptions` row (version + 1), so the queue cancels the older queued version on the same encounter, and a claimed one is told `prescription_superseded` at verify.
- **F7 — the aide lost `materials.stock.read`** (README census guard: a materials pair must live in the materials table); the counter's routes read stock for it.
- **F8 — the invoice carries the ENCOUNTER ID**, not the visit number: billing accepts both, but `encounterFeeStatuses` and `listInvoices` match by id (found by the e2e's consult gate).
- **F9 — one batch per line.** Short stock is a partial with a reason or a named later batch (evented); a line never spans two batches in 16c.
- **F10 — `PhiSurface` gained `pharmacy.dispense`** (a one-line kernel edit) so the counter's reads count apart from the consult's.

### 8.3 Assertion book as executed
T0b guard: DIED (category guard dropped → priced instead of thrown). T1: boot lists `medication` on `P`; `pharmacy_reg_h1` UPDATE and DELETE both raise. T2 A2: `max`-for-`min` mutant DIED on the ceiling row and the property leg (2 of 17). T3 A1: two concurrent claims → one `claimed`, one `dispense_not_in_state`, lines written once. T3 second: an allergy recorded after issue blocks verify; the prescriber's override lets the re-issue through. T4 A1: two dispenses on the last ten tablets → one holds, one refused by the ledger, `qty_reserved` 10 on 10. T4 second: the ceiling row prices at 1000 not 1500, `boundApplied: caller_cap`, totals to the paisa. T4 third: the aide's hand-over of an H1 line refused, no ledger row after.

### 8.4 Evidence (local, the suites touched; CI runs everything per PR)
core: `modules/pharmacy` 55/55 + `pharmacy.e2e` 2/2 + `seed-pharmacy` 1/1 + schema 4/4 + parity (deploy, caddy, nav, manifests, orders) green + `seed-roles` 16/16 + `seed-tariff` 5/5 + `opd/prescriptions` 21/21 + `tariff/pricing` 16/16. web: 71 files, 514/514. `pnpm typecheck` 0 errors; `pnpm lint` 0 errors (2 pre-existing warnings on main).

### 8.5 Close review — RUN 2026-09-03 (contract pass + one review pass + a pass over the fixes)

**Instrument order, §5A:** the contract pass (§5A.1) ran FIRST, clause by clause over D1–D10 and
R-1..R-5 against the shipped code; then the assembly check (§5A.3); then a pass over the fixes
themselves (§5A.4 / §2.140). Three defects found, three fixed, each red before its fix and green
after. **Both reviewing passes were run by the closing session, not by two fresh reviewers** — the
session was instructed not to spawn subagents. That is a real weakening of §2.140, whose whole
finding is that a reviewer briefed at the fixes catches what the author cannot; it is recorded here
rather than papered over. **One independent pass is still owed before deploy.**

**C1 — MAJOR (money, D8) — the drug left against money that had been given back.**
`handOverDispense` asked `status = 'billed'`, a column, where D8 promises *"money moves before the
drug leaves"*, an amount. Settlement is DERIVED (`settlement.ts` — no status column on `invoices`,
which is what keeps the immutability triggers total), and it is derived from allocations and credit
notes that the billing desk can still write while the patient stands at our window: one
`reverseAllocation` (a receipt voided as taken on the wrong invoice) and the invoice is unpaid, the
column still says `billed`, and the medicine goes out. Fixed: the money is re-read at the
irreversible act. **The short-tender road is NOT a defect** — `issueInvoice` refuses to leave a
remainder unsettled (`unsettled_issue_refused`, `invoices.ts:880`) and pharmacy requests no credit
extension; a test now pins that inheritance, because the counter's own suite never tried a short
tender (its `amountPaise: 1` call is refused for being the SECOND bill — the two behaviours agree on
that fixture, §5A.1's exact warning).

**C2 — MAJOR (law, R-3) — a substitution walked Schedule X past the claim's guard, and the screen
offered it.** `claimDispense` refuses X on the medicine the PRESCRIPTION named; `verifyDispense` may
then name a different one, and the substitution equality (salts + strength + form + route) says
nothing about schedule. Worse than a missing check: `alternativesFor` **listed the X medicine in the
counter's substitution dropdown**, so the pharmacist was offered it. One mistyped `schedule_flag`
looks the same. Fixed at both points — verify refuses it, the offer never includes it — and, in the
pass over the fixes, at hand over too: claim and verify each judge a medicine the next step can
still change, so the law is asked at every gate that can name one.

**C3 — MAJOR (§5A.3, the assembly) — the desk was not cleared between two patients.** Every screen
test took ONE patient in ONE state (3 renders of the assembly, 0 of its parts — the ratio was not
RC-3's problem; the CYCLE was). `take()` reset what belongs to the prescription — lines,
alternatives, picks, draft, label — and nothing that belongs to the transaction. So patient B's
Schedule H1 hand-over went out with **patient A's token already sitting in the identity box**. The
server refuses the mismatch, which is exactly why 537 green tests never saw it; but D7's second
identity confirmation (doc 16 A1) is an act the pharmacist performs for THIS patient, and a
prefilled box is that control answered before anyone looked up. Fixed: taking a patient clears the
identity, the tender, the cancel reason and the last refusal. The two-patient cycle is now asserted.

**The pass over the fixes returned two INCOMPLETE — both in this session's own C1/C2 fixes:**
- the settlement was read BEFORE `withTx`, so a reversal landing in the gap would still hand the
  drug over — the same defect, only narrower. Moved inside the transaction that consumes the stock.
- R-3 was fixed at verify and at the offer, but not at hand over, the one gate that reads a line
  already written. Added, with the caller enumeration as its comment (§5A.4's RC-4 amendment); it is
  defence in depth over state that verify now refuses, and carries no test of its own rather than a
  fabricated one.

**F11 — MAJOR, FIXED 2026-09-04 (this was recorded as "16d inherits it" and that call was
reversed).** D2 and `PICK_RESERVATION_MINUTES = 30` promise that a pick "holds a batch before the
ledger may release it to somebody else". `pick.ts` wrote `expires_at` from T4; **nothing in
`apps/core/src` ever read it** — no sweeper, no job, and `releaseReservation` is called only by
decline and cancel. An abandoned pick therefore held `qty_reserved` for ever, and because `fefoPick`
and `balances` both subtract reserved stock, the counter reported short stock on a full shelf.

It was deferred on the grounds that the mechanism belongs in `materials` (a shared, census-pinned
module) and that 16d owns abandoned-dispense handling. **16d is gated on the IPD cluster's first
plan, which does not exist**, so the deferral had no date on it — and this is a live defect in
shipped code, not a missing feature. Closed here instead, entirely in the pharmacy module plus the
worker registration every module's sweep uses.

- **`sweepExpiredPicks`** (`modules/pharmacy/expiry.ts`), the worker's SIXTEENTH job, `every: 60_000`
  — a cadence finer than the 30-minute window it enforces, as a literal rather than a new
  `JobIntervals` key (widening that `Pick` is a type event that stops every census literal
  compiling, and this job has no operator knob worth that).
- **DECIDED — an expired pick is an abandoned one:** the stock goes back on the shelf and the
  dispense is CANCELLED with the reason recorded, which is what D2 already describes. The patient
  re-presents, the Rx is still active, and the same scan queues a fresh dispense. No new transition
  and no new state: `picked → cancelled` is in the definition and `cancelDispense` already releases
  every reservation, cancels every order item and closes the instance in one transaction.
- **`billed` is never swept.** A paid-for medicine belongs to the patient; releasing that stock
  would sell it twice. Paid-not-collected stays a REFUND path and stays 16d's (D8, §6).
- Revert pairs: **R1** (drop the expiry clause) `1 failed / 1 passed` → 2 passed. **R2** (drop the
  `status = 'picked'` filter) **SURVIVED — recorded, not hidden**: `cancelDispense` refuses a
  `billed` dispense independently, so the protection is doubled and the suite asserts the outcome.
  Per §5A.4's amendment the filter is KEPT with its caller enumeration written in as a comment: a
  reservation is written only by `pickDispense`, which moves the dispense to `picked` in the same
  transaction, so no road to a non-`picked` row exists **today** — which is not the same as none.

**And a finding about the method, not the code: the job census tax is FIVE places, not four.** Every
comment in the repo that names it says "`jobs.ts`, both censuses, `alerts.yml`, and that number" —
four — and four separate plans have repeated it. Registering this job turned **five** tests red:
`jobs.test.ts` (a count AND a last-position pin), `scheduler.test.ts` (`THE_SIXTEEN` and its spy
list), `alerts-parity.test.ts` (sorted names AND a separate `toHaveLength`), `alerts.yml`, and
`test/worker-runtime.e2e.test.ts`. The prediction has been undercounting itself since Plan 14, and
`worker-runtime.e2e.test.ts` now says so at the point a sixth registrant will read it. The
last-position assertion in `jobs.test.ts` was RETIRED rather than re-pointed at the newest job —
pinning "last" makes every future registration edit that line for no assertion value.

### 8.5b Second contract sweep, 2026-09-04 — a CRITICAL the first pass walked past

Closing F11 meant reading `fefoPick`, and `pick.ts` turned out to check `recallStatus` on the
explicitly-named batch path while trusting FEFO on the automatic one. That asymmetry was worth a
question, and the answer was the worst defect in the phase.

**C4 — CRITICAL (law, patient safety): the counter dispensed EXPIRED medicine by preference.**
`fefoPick` excluded recalled batches (`recallStatus = 'none'`) from the start and ORDERED by
`expiry_date asc nulls last` — it never EXCLUDED a date already past. First-expiring-first-out means
the first batch offered is the most expired one the store holds, and `pickDispense` takes
`offered[0]`. Proved at the counter before it was fixed: a Crocin batch dated **2026-08-01 was
picked and reserved for a patient on 2026-08-17**, ahead of two good batches. Selling it is an
offence under the Drugs and Cosmetics Act, and doc 16 §14 put "expired block" inside 16c's scope
while §6 never listed it as deferred — so this is missing scope, not a deferral.

Fixed where the recall exclusion already lives, as the same kind of clause: `fefoPick` takes the
caller's clock (`asOf`, defaulted) and excludes `expiry_date < today`. `expiry_date` is the last day
a batch may be used, so today's stock is still good; a NULL expiry is KEPT, because DD8 rule 3
exempts whole item classes from carrying one and "none recorded" is not "expired". Expired stock
stays transferable by NAMING its batch, which is how it reaches quarantine or destruction — a FEFO
override skips the query. And when the pharmacist names an expired batch at the counter, they are
told which batch and which date (`batch_expired`) rather than "cannot cover 20".

- **R3** (drop the exclusion from `fefoPick`) — `2 failed / 8 passed` → 10 passed.
- Blast radius measured, not assumed: **41 suites / 467 tests green** across `materials`, `ot`,
  `pharmacy`, `materials.e2e` and `pharmacy.e2e` — `fefoPick`'s only other production caller is
  `transfers.ts`, which has a named-batch path.
- Tested where the guard lives (`ledger.test.ts` A10b) as well as at the counter: the batch expiring
  TODAY is picked and the same batch is gone the next day.

**What this says about the first pass.** The contract pass reads the plan's clauses against the
code, and it found three defects that way. This one was NOT in D1–D10 or R-1..R-5 — the plan never
wrote down "do not dispense expired stock", because nobody thinks to write it down. It surfaced only
from an ODDITY in the code: one path checking recall and its sibling not. **A contract pass is
bounded by what the contract happens to say; the asymmetries in the code are a second, independent
index of things to ask about, and they are cheap to scan for.**

### 8.5a Evidence for the close
core `modules/pharmacy` + `pharmacy.e2e`: **10 suites / 60 tests, all green** (57 before; +3 written
here, each RED first — C1 "Received promise resolved instead of rejected", C2 the X medicine present
in the alternatives array, C3 the identity box holding `"14"`). web `pharmacy-counter`: **4/4**.
`pnpm typecheck` 0 errors; `pnpm lint` 0 errors, the same 2 pre-existing warnings §8.4 recorded.

**Full web suite: 78 files / 595 pass, 1 FAIL — `lab-reports.test.tsx` D9.** CORRECTED: this was
first written up here as a red `origin/main`. **It is not.** It is a FLAKE on a loaded build host.

The record, because the first reading was wrong and the evidence is what settles it: D9 failed three
times consecutively between 23:16 and 23:23 UTC — including once with this lane's work stashed, which
is what made "red main" look right — and **passed on this box at 23:32 UTC** with the work restored,
and the `web` job is **green in CI on this branch's exact SHA `9cad87c`**. The failure is
`todays.length === 0` where the fixture is dated today, so the tempting reading is the FD-6 date bomb
in that file's own header comment. **That reading was tested and disproved:** inside jsdom the
screen's `istToday()` (`Intl`, `Asia/Kolkata`) and the fixture's `IST_TODAY` (arithmetic) both return
`2026-09-04` and compare equal. Cause not identified; four lanes were running suites at the time.
**Do not search a pharmacy diff for it, and do not report a frozen main on it — re-run it.**

### 8.6 Actuals
One authoring-plus-execution session; token count not readable by the session about itself (the 11e precedent). Stop-loss 2,120,000 not breached by the visible token meter.
