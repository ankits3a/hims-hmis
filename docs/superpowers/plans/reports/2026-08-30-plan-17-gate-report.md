# Plan 17 — Gate report: the laboratory, both halves

**Written 2026-08-30 by the session that executed 17b.** Covers **17a and 17b as one module and one
go-live**, because that is what they are: 17a's accessioned tube is unusable without 17b's number,
and 17b's report is unbuildable without 17a's desk.

**Plans:**
[`17`](../2026-08-29-phase1-17-lims-core.md) (T1–T2) ·
[`17a`](../2026-08-29-phase1-17a-lims-order-to-accession.md) (T3–T5) ·
[`17b`](../2026-08-29-phase1-17b-lims-result-to-report.md) (T6–T9).
**Runbook:** [`../../../runbooks/lab-go-live.md`](../../../runbooks/lab-go-live.md).

> ## THE ONE SENTENCE THAT MATTERS
>
> **Everything below is SHIPPED AS CODE AND NONE OF IT IS LIVE.** Production carries no `LAB`
> department, no lab roles, no catalogue and no activated definitions, and it will keep carrying
> none of them until §2–§5 of the runbook are performed. **Two of those steps are the owner's own
> acts and one of them is blocked**: the hospital still has ONE full administrator, and DD11's
> separation of duties cannot be satisfied by one pair of hands.

---

## 1. What shipped

| commit | task | what it closes |
|---|---|---|
| `39beff0` | 17 T1+T2 | thirteen `lab_*` tables + two immutability triggers (`0046`); the manifest, the `lab` order kind, twenty-two events, the closed error union, the approval type |
| `b06e3d6` | 17a T3 | the catalogue; the IST age-band range resolver; the guarded formula evaluator; the analyte-overlap duplicate detector |
| `fba0d72` | 17a T4 | the DESK — advised tests become an order AND an invoice in ONE transaction; the walk-in visit; the consent gate; the add-on as a grouped order; two workflow definitions |
| `b54acfd` | 17a T5 | collection and accession — `S` numbers, the right-patient scan, `receive` with its CAS and the TAT start, free reject/recollect, two worker sweeps |
| `1e57d65` | 17a | close review pass 1 — two CRITICALs on the recollection path, an ungated PHI worklist, a scan that checked one row of N |
| `b8b03a6` | 17a | close review pass 2 — **three of pass 1's five fixes were themselves defective** |
| `f32c331` | 17b T6 | the NUMBER — manual entry with the absurd envelope and snapshotted ranges, the delta, SoD verify with a CAS, criticals with read-back, the synchronous reflex, `completed` at the last signature |
| `cfba8d5` | 17b T7 | the DOCUMENT — versioned snapshots, the invoice-grained delivery interlock, the print register, the ready-notice, the amendment, DD7's cancel-money rule; **the fourth kernel edit** (the report-ready template) |
| *(T8)* | 17b T8 | five controllers, four screens, the A4 print, the consult panel, the e2e over every route |

Two out-of-plan fixes belong to the record: `d1f316b` (the OPD encounter resolver could not resolve
a single real `V` number — every lab order on a genuine visit was refused) and `cae2f05` (the local
verify was never broken; one test sat at 72% of its default budget, ledger §2.144).

---

## 2. Proven BY EXECUTION

Everything in this section was run, and the run's exit value was read from a file or from the
runner's own summary line.

- **The whole chain over HTTP, row by row** (`test/lab.e2e.test.ts`): desk → labels → collect →
  receive → result → verify → publish → print, with the DATABASE read back after every step. The
  idempotency replay places nothing. The interlock refuses the print with a 422 and its own code,
  and the same request succeeds once the bill is settled.
- **Every error family reaches the wire as a 4xx.** `LabError`, `OrderError`, `BillingError`,
  `TariffError` and a zod refusal each driven through a real route. **No 500 anywhere.** This
  repository has shipped the 500-escape three times (Plan 09, 13, 15).
- **DD7's three legs** — `placed` ⇒ credit note; `in_progress` WITH a result ⇒ **no** credit note;
  `in_progress` without one ⇒ credit note. The mutant that ignores `cancelled_from` refunds all
  three and was killed.
- **The delivery interlock is ORDER-GROUP-grained, and invoice-grained within it** (DD23 as
  amended by F45 — §5): a paid desk order is held while the reflex it caused is unpaid, because the
  grain is the clinical ACT; an order billed across two invoices is held while either is unsettled;
  a partially-paid mixed invoice blocks and the verdict names the INVOICE; `tpa`/`pmjay`/`corporate`
  and every `D` encounter deliver with zero receipts. **The group rule was CONFIRMED BY THE OWNER on
  2026-08-30 (§5 F45) and is now the decided design, not a standing amendment** —
  `interlock.test.ts`'s two `A1` rows assert both grains in as many words.
- **The release moves no money.** `patientOutstandingPaise` identical before and after; the mutant
  that writes a credit note took ₹300 to zero and was killed.
- **The doctor's read is never held for money** (02 O-1). A mutant that applied the interlock at
  READ returned nothing and was killed.
- **Separation of duties is per RESULT ROW.** One user holding both permissions cannot sign their
  own number by day; night mode releases it flagged for the morning queue; the refusal is EVENTED
  on its own transaction and survives its own rollback.
- **Two concurrent verifies: one winner, one `already_verified`, ONE event — over 8 rounds**,
  every round 1/1/1, measured at 4 835 ms on an idle box (load average 1.55).
- **The range is snapshotted at entry.** Moving `ref_high` afterwards changes neither the row nor
  the flag.
- **The delta compares against the previous VERIFIED result of the CANONICAL patient**, not against
  a more recent unverified one.
- **A critical value opens exactly ONE call at ENTRY, before any verification**, and the call closes
  only on a read-back.
- **The reflex is placed inside the verifying transaction.** An injected throw after the placement
  leaves zero orders and zero verified results; the mutant that places it on its own transaction
  leaves the order behind and was killed.
- **A published snapshot is immutable** — the trigger refuses the UPDATE — and an amendment is
  version n+1 with the superseded version still readable.
- **The ready notice carries the order number and nothing else**, and a `sensitive` report enqueues
  nothing while still emitting `lab.report_published`.
- **A sealed patient's report reads as the alias for a caller without `patients.confidential.read`,
  and every read writes one `phi_access_log` row.**
- **Twenty-three mutants built and killed** — ten in T6, thirteen in T7 — each run isolated with the
  isolation line read from the output.

**THE FULL WORKSPACE VERIFY IS GREEN IN ONE RUN — the phase's last open obligation, now closed.**
Launched detached over `3275b11`'s tree at ~18:31 UTC on 2026-08-30, finished 18:48, **exit value
`0` read from `/opt/hmis/.verify.exit`** (rules 16–18, never a pipeline's status):

| stage | result |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **0 errors**, 2 pre-existing warnings not this phase's |
| `apps/web` | **61 files / 374 tests passed**, 39.45 s |
| `apps/core` | **313 suites / 3 052 tests passed**, 1 021.31 s |
| the log | **zero `FAIL` lines** |

On `postgres://hmis:hmis@localhost:5433/hmis_17b_lane` across seven worker databases — the same
lane-private database as every other run in this phase, **proved after the fact** by
`hmis_17b_lane_7`'s latest row at `18:48:30.129Z` rather than remembered from a launcher whose
environment was gone.

**The contention census that convicted the earlier red run is EMPTY here** — `Exceeded timeout` 0,
`deadlock` 0, `SIGKILL` 0, `duplicate key` 0 — and core finished in 1 021 s against jest's own
1 140 s estimate. The **per-suite** times prove nothing either way (the slowest is 219 s, inside run
2's band, because seven workers share the box), and **the load average during the run was never
measured**: the 0.65 / 0.43 / 1.97 reading is from 19:22, half an hour after the run ended.

**Two earlier full runs were red and both stay recorded as red** (phase §9.5): one real defect of
this phase (F42, the twelfth IST clock, fixed in `d2d2274`) and, otherwise, host contention — run 2
was 18 suites at **load average 86** with two other `claude` sessions on the box, all 18 green when
re-run isolated. **This is the first execution in which the whole workspace passed in a single run**,
and until it happened the honest sentence was that it never had.

---

## 3. Proven BY READING, not by execution

- **The catalogue seeded in production is the owner's data.** Every catalogue assertion in this
  phase runs against `test/fixtures/lab-catalogue.json`, which is a fixture chosen to make a suite
  executable. A real catalogue will meet refusals this phase has only met synthetically.
- **`hi.json` carries every new key** — asserted by a key-path comparison, not by a translator.
- **The A4 layout matches the design** (`ReportA4.dc.html`). Copied by eye; that tree is untracked
  and was never staged (spike S8).
- **The realtime topics route correctly.** `labTopicsFor` is a pure function and is exercised only
  by its own shape; no socket was opened in this phase.
- **The two worker sweeps run on the worker's own installed manifest set.** Asserted at the service
  level; no worker process was started.

---

## 4. NOT PROVEN AT ALL

- **Nothing has run against production.** No migration was applied, no seed was run, no route was
  called on the live box.
- **No real specimen has been through it.** Every tube in every test is a row.
- **The printed report has never been printed.** It renders in jsdom; no paper exists.
- **The WhatsApp notice has never been sent.** The enqueue is asserted on the ROW; the pump was not run.
- **Concurrency was measured on an idle single-node box**, not under a morning rush.
- **The interlock has never met a real mixed bill**, because no shipped writer produces a
  two-invoice lab order today (§5).

---

## 4A. What the two close reviews found, because it is the most important number here

**Twenty-three mutants were built and twenty-three died. They found none of what follows.** Neither
did green narrow suites, a green e2e over every route, or a green workspace verify. Every item below
was found by a fresh human-shaped reader looking at the code.

| pass | found | cost |
|---|---|---|
| **1** (fresh) | **4 CRITICAL + 9 MAJOR + 8 MINOR** on the server, **5 CRITICAL** on the screens | 238,225 tokens / 63 calls |
| **2** (fresh, over the fixes) | **4 of 13 fixes condemned**, **2 NEW defects the fixing commit created**, 22 findings | 245,017 / 52 calls |

**The four that would have hurt a patient:**

- A sealed patient's **legal name, UHID and date of birth** returned to any holder of
  `lab.results.read` by a sibling route with no alias rule and no audit row — while the reader
  beside it did both.
- A **corrected critical potassium opened no telephone call**, on the one path where the value is
  known to have been wrong.
- A rerun that corrected a cholesterol left the derived LDL computed from the number it replaced:
  a signed report reading *cholesterol 150, LDL 426*.
- Two pathologists signing the last two analytes of one panel **stranded the item permanently**,
  with no recovery through any shipped route.

**And the one that would have stopped the laboratory working at all:** the Publish button sat on a
worklist row that vanishes at the exact moment publishing becomes legal. **No report could be
published from any screen in the system.** Two mutually exclusive conditions, and nothing in the
phase exercised the pair.

**Pass 2 is the reason four of pass 1's thirteen fixes are not in production**, including one that
made a partial report un-amendable — so a version carrying a wrong haemoglobin would have stayed the
published one. That is ledger §2.140's third specimen and the first with a rate: **across 17a and
17b, roughly a third of a first pass's fixes are wrong.**

## 5. The findings this phase carries forward

| # | finding | who owns it |
|---|---|---|
| F27 | **FIXED.** `issueInvoice`'s §269ST refusal was lost through `deskOrder`'s cast; `deskOrderAtCounter` holds the real `Db` and writes the audit lane on it. **The permanent repair — `issueInvoice` taking a `Db` beside its `Tx` — belongs to the next phase that may edit `modules/billing`.** | a billing phase |
| F28 | **FIXED.** `permission_denied` added; `catalogue.ts` and `desk.ts`'s borrowings repointed. | closed |
| F29 | the duplicate check is a read-then-refuse with no lock. **Not closed**: `desk.ts` is frozen, and the cost of a lost race is a reversible double-bill against a new serialisation point on the desk's hottest path. | 17-E or a desk phase |
| F30 | **CLOSED.** `cancelled_from` is now read — it is DD7's own input. | closed |
| F31 | `lab_specimens` has no `instance_id`, so the tube's state EDGES are unenforced. | a phase that may add the column |
| F34 | **night mode is derived from the IST clock**, because DD11's `single_operator_night_mode` field does not exist and `workflow-def.ts` is frozen. | 17-E |
| F35 | DD7 is written TWICE — `refundOnCancel` and `sweeps.ts`'s inline credit note. They agree today because the sweep's path is a strict subset. | a phase that may edit `sweeps.ts` |
| F36 | `lab.report_print_blocked`'s payload field is called `unpaidLineIds` and carries INVOICE ids. DD23 ruled the grain after `events.ts` was frozen. | a phase that may edit `events.ts` |
| F37 | the `lab_item` definition has **no `resulted → cancelled` and no `verified → cancelled` edge**, so DD7's middle leg leaves the lab instance where it stands. Harmless — every worklist and sweep keys off the ENVELOPE — and stated rather than hidden. | a phase that may edit `workflow-def.ts` |
| F38 | **FIXED.** DD13's superseding row had no writer: the trigger refuses the UPDATE and `enterResult` refuses a `completed` item. `amendResult` is that writer. | closed |
| F39 | **fifteen permissions and no ROLE is a login that cannot draw blood.** Found by the e2e and by nothing else; the runbook's §0 exists for it. | the runbook |
| F42 | `verify.ts` is the **twelfth** IST clock, declared with a written argument. The census found it; the module's own suite could not. | closed |
| F43 | six of sixteen realtime names could never produce a topic; they are removed rather than left as a promise nothing keeps. | a phase that may edit `events.ts` |
| F44 | a reflex that cannot be billed reaches the SCREEN and no durable record — `LAB_EVENTS` is closed and none of its names means "a rule fired and could not be acted on". The runbook's pilot harvest counts it by hand. | a phase that may edit `events.ts` |
| F45 | **DD23's grain is amended from the ORDER to the ORDER GROUP.** A TSH paid in cash that reflexed an unpaid FT4 read `settled` on the very order the counter was handing over. It over-blocks, which is DD23's own safe direction — **It changed a design decision the plan had already made, so it was put to the owner rather than kept on the plan's authority — with the point that under EITHER grain the unpaid reflex's own report stays blocked, so the group grain's only added effect is holding the PAID sibling too. The owner kept it: one collectable number at the counter, and the approval-release path covers the case that deserves release.** | **CONFIRMED BY THE OWNER 2026-08-30 — kept. Closed.** |

**And DD23's multi-invoice loop is defensive rather than exercised by any shipped writer**: today
one lab order carries exactly one invoice, because `deskOrder` bills all of an order's items
together and an add-on is a NEW order. `lab_items.invoice_id` is per ITEM, which is why the loop
exists; 26's package or a re-billing path will be its first real caller.

---

## 6. The Assertion Book, corrected by execution

- **T6 A8's discriminating input is GLUF 1600, not 1200.** The golden catalogue's envelope is
  5 … 1500 mg/dL, so the plan's own value is INSIDE it and would have passed against an
  implementation with no envelope check at all.
- **T6 A1's mutant-killing input is a user holding BOTH ROLES**, not "a tech holding both
  permissions". A technologist is refused by the workflow's own role check before the SoD guard is
  reached, so the plan's input would have died for the wrong reason.
- **T6 A3 uses TFT (three analytes), not a CBC.** The fixture's CBC reports sixteen.
- **T7 A1's shape is corrected.** The plan wrote *"a CBC paid at the desk and a reflex FT4 invoiced
  on credit"* on ONE order; DD9 makes a reflex a NEW ORDER with its own invoice, so
  `deliveryAllowed(deskOrderId)` legitimately never sees it. Both halves are asserted: the reflex
  order's own report is held, and an order billed across two invoices is held while either is
  unsettled.
- **T7 A6 needed a writer that did not exist** — see F38.

---

## 7. What the hospital gets, in one paragraph

A counter can take what a doctor advised and turn it into an order and a bill in one transaction. A
phlebotomist can print a label only after scanning the patient, and a near-miss is recorded whether
or not anybody notices it. A bench can accept or reject a tube, and a rejection costs the patient
nothing. A technologist can key a number, and a value outside the plausible envelope needs a second
person's name. A pathologist can sign it — and cannot sign their own, except alone at night, in
which case the report says so on its face. A critical value opens a telephone call the moment it is
keyed, and the call closes only when somebody repeats the number back. A report is a signed,
versioned snapshot that cannot be edited, only amended. And the printed copy is held at the counter
while the bill is unpaid — **while the doctor who ordered the test sees the number regardless**,
which is the one line in this module whose failure would kill somebody.
