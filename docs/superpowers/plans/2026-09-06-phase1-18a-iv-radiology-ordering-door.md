# Phase 18a-iv — The door the department has no way in through (Radiology series, 5 of n)

**Authored 2026-09-06 in lane `radiology`. NOT APPROVED, NOT EXECUTED.** Everything in §2 was
measured during the commissioning walk
(`docs/superpowers/plans/reports/2026-09-06-radiology-commissioning-walk.md`), not read off a plan.

---

## 1. Why this phase

Radiology can schedule, gate, acquire, report, sign, publish, chase and bill. **Nothing in the
product can put a study into it.** Every study in the commissioning walk was created with `curl`.

This is not a missing nicety. It is the department's entrance, and it is the one screen the imaging
department needs that no other clinical module is missing — **the laboratory has exactly this door
and radiology does not.**

---

## 2. Ground truth — measured 2026-09-06 at `e32598b`; re-measure at kickoff

| fact | measured |
|---|---|
| `/orders` prefix anywhere in `apps/web/src` | **0 occurrences** |
| `"radiology/orders"` anywhere in `apps/web/src` | **0** |
| callers of `placeImagingOrder` in core | `radiology-orders.controller.ts` and `place.ts` only — no OPD path, no consumer |
| `consumers.ts` | `if (payload.kind !== "imaging") return []` — an OPD lab order cannot become a study |
| reception's *Walk in* | `walkIn(studyId)` — auto-slots a study that **already exists** |
| `AdvisedTest` | `{ serviceId, code, name, pricePaise }` — **service-generic, not lab-specific** |
| the doctor's picker (`opd-consult.tsx:333`) | searches the **whole active tariff price list**, no category filter |
| `encounter.advisedTests` | written by the doctor, stored `opd_encounters.advised_tests`, **printed** by `rx-print.tsx` |
| who consumes it | **`lab/desk.ts:718` `advisedLinesFor`, and nothing else** |

**The doctor's half already works.** A physician can advise *CT head, plain* today: it resolves
against `RAD-CT-HEAD`, lands in `advisedTests`, and prints on the prescription. Then nothing reads
it. `lab-desk.tsx:25` records the same discovery from the other side — *"`advisedTestItems` shipped
in 17a with no consumer, and this seat is the first."* **This phase is the second.**

So the gap is exactly one seat wide. It is not a new clinical workflow; it is the missing consumer
of a rail that has been carrying imaging lines all along.

---

## 3. Spike — answered by reading at kickoff, 0 subagents

1. **Does `advisedLinesFor` generalise, or must radiology write its own?** It resolves service ids
   against `labOrderables` and marks `alreadyOrderedItemId` from `orders.kind = 'lab'`. Read whether
   the shape can be lifted with the orderable lookup and the kind as parameters, or whether copying
   it is honest. **Copying a 30-line reader is fine; copying its DECISIONS is not** — say which.
2. **What does an imaging line need that a lab line does not?** `placeImagingOrder` requires an
   `indication` (`radiologyManifest.requiresIndication`), and the doctor's advised line carries none.
   That is the one field the lab door never has to ask for. Read `place.ts` for the rest.
3. **Is the PCPNDT answer already computed at placement?** The order response carries a `pcpndt`
   array per item. Confirm the seat can render it rather than re-deriving it.

---

## 4. Design decisions — DECIDED; none is money, procurement or law

- **D1 — The door is RADIOLOGY RECEPTION's, not a new screen.** `/radiology/reception` already finds
  the patient, shows the day and books the slot. The order belongs at the top of that seat, exactly
  as the lab's sits at the top of `lab-desk`. A second screen would fork the receptionist's day.
- **D2 — The advised line is a SUGGESTION, never an automatic order.** The receptionist confirms it.
  A doctor's advice is a clinical recommendation; the order is an act with a bill and a dose behind
  it, and the patient may decline, defer, or go elsewhere. Auto-placing on consultation close would
  bill people for scans they never had. **This is also why it is not a worker consumer.**
- **D3 — `alreadyOrderedItemId` is shown, and an already-ordered line cannot be ordered twice.**
  The lab's reader computes it; radiology's must too. Without it a receptionist working a second
  visit re-orders the morning's CT, and 18a's duplicate window is a 24-hour warning, not a bar.
- **D4 — The indication is REQUIRED and typed at the desk, never defaulted.** `requiresIndication`
  is the manifest's, and 18a's own comment says a CT with no stated indication is a dose nobody can
  justify to an AERB inspector. **Defaulting it to the diagnosis would be inventing a justification.**
  The desk types it, or the line is not orderable.
- **D5 — The walk-in leg stays.** A patient arriving with an outside slip has no encounter advice.
  `placeImagingOrder` already takes `authority: "external_prescription"` with a referrer; the seat
  offers a manual search over the imaging services in the active study-type book.
- **D6 — Only services in the ACTIVE study-type book are orderable.** The doctor's picker is the
  whole price list, so a physician can advise a service radiology cannot perform. The seat shows
  such a line **greyed with the reason**, rather than hiding it — a receptionist who cannot see the
  advised line believes it was never advised, and phones the doctor.

---

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T1 — CRITICAL · The advised imaging lines, read
`GET /radiology/reception/advised?encounterNo=…` (or on the existing find), resolving
`encounter.advisedTests` against the active study-type book and marking `alreadyOrderedItemId` from
`orders.kind = 'imaging'`. Server only. The test that matters is the negative: a lab line advised in
the same consultation does **not** appear.

### T2 — CRITICAL · The seat places the order
The reception screen renders the advised lines, takes an indication per order, and calls
`POST /radiology/orders`. Zero-to-one web caller of the module's own entrance. Includes D6's greyed
line and D3's already-ordered state.

### T3 — ROUTINE · The walk-in leg
Manual search over the study-type book, `authority: "external_prescription"`, referrer captured.

### T4 — ROUTINE · The census row and the runbook §9 step
`standup-check` gains a row that fails when the department has an active study-type book and no way
to order from it — the shape this phase exists to close. `radiology-go-live.md` §9 gains the step.

---

## 6. Out of scope — named so nobody infers them

- **The contrast administration record, the contrast reaction and the outside-study register have no
  web surface either** (18a-iii T1, T2, T4 — measured, zero web callers each). They are the same
  shape as this and they are **not** this phase: this one is the department's entrance, and they are
  three separate seats' worth of work. **The reaction is the one to schedule next** — 18a's safety
  gate reads the allergy that route writes, so the loop exists at both ends and cannot be entered in
  the middle.
- Ward/bedside ordering, and the portable request (18a-iii T3's columns have no writer either).
- Any change to the doctor's advise picker. It already offers imaging services and that is correct.

---

## 7. Owner rulings — money, procurement, law

**None.** This phase invents no price, buys nothing and decides no statute. D2 (advice is not an
order) is a patient-safety and billing-hygiene reading of standard Indian corporate-hospital
practice, taken under the owner's standing rule.

---

## 8. CLOSE — filled at execution

**Executed 2026-09-28 as Plan 18-S phase RS2, lane `radiology-rs2`, one PR.** 18-S RS2 absorbs
T1–T4. D1, D3, D4, D5 and D6 hold as written. **D2 is superseded** by 18-S RS2: the doctor's explicit
*Send to imaging* is an ORDER that lands at the desk as *to book*, and nothing is billed until the
desk books it. Lines only advised on the prescription are still suggestions the desk confirms.

**RS2 as built:**

- **T1 (core).** `GET /radiology/advised?encounterNo=` (`radiology/advised.ts`), on
  `radiology.orders.place`. DECIDED: one route for both seats, because the doctor holds neither
  `radiology.schedule` nor `radiology.definitions.read`. Spike 1: the lab's reader was **copied, not
  lifted**. The two readers differ in which lines appear. A line appears here when the active book
  names it, or when it is an `investigation` the lab catalogue does not claim (D6, greyed with a
  reason). Lab lines and consultations never appear.
  - The read also returns the visit's standing imaging orders with each study's state, the book with
    tariff prices, and a 30-day look-back that never names a restricted item.
  - It is PHI-logged as `opd.visit`.
  - The 24-hour `duplicate_recent` refusal now carries `recentItemIds`, so the seat can send the
    override pair.
  - The walk-in's referrer is typed as a name plus a registration number. `place.ts` finds or makes
    an `external_rmp` counterparty with code `RMP-<registration>`. DECIDED: both fields are required
    and there is no unattributed sentinel, because the referrer is part of the radiation
    justification. New refusal code: `referrer_required` (422).
  - No new permission. No route or permission pin moved.
- **T2 (web, consult).** `components/radiology/imaging-order-panel.tsx`, mounted by one insertion in
  `opd-consult.tsx`'s Lab & radiology tab. The panel:
  - requires a typed indication;
  - asks the side for a lateralised type (DECIDED: the side is written into the indication, because
    the envelope has no side column and `laterality_confirm` confirms it at the console);
  - shows the price and the priority;
  - asks a reason for a 30-day or 24-hour duplicate;
  - shows the placed order's state afterwards.
- **T3 (web, desk).** `components/radiology/imaging-desk-door.tsx`, in the RS1 station's centre. It has
  two legs:
  - Find by visit number, then the advised lines.
  - An outside slip, searched from the book and placed under `external_prescription` with the
    referrer.

  DECIDED: the visit leg offers no free search. A study the doctor did not advise is never put under
  the doctor's name; it goes through the slip leg. The visit's doctor is the answerable clinician on
  both legs, because the kernel requires one.
- **T4.** No census row. "No screen" is a code property, now closed and pinned by the vitest suites.
  The only data row possible ("an active user holds `radiology.orders.place`") is green on any
  hospital with a doctor. `radiology-go-live.md` §9 step 0 records the ordering walk instead.
- **Deferred: the ward door and the portable-order writer (18-S RS2's `doc:ward`).** There is no IPD
  or ER module in `apps/core/src/modules`, and the owner ruled on 28 Sep that IPD and ER each get their
  own brainstorm. Both go to the IPD plan. The 18a-iii T3 `bedside_location` writer gap stays open
  until then.
- **Tests.**
  - `advised.test.ts`: 10 tests. Fail-first against mutants and against main's `place.ts`: 5 red.
    The lab-exclusion mutant turns the NEGATIVE test red, the cancelled-counts mutant turns D3 red,
    the dropped PHI line turns the PHI test red, and main's `place.ts` makes the referrer and
    duplicate-id tests red.
  - `radiology.e2e` RS2: 1 test. On main it is red (404 in place of 401).
  - `imaging-order-panel.test.tsx`: 7 tests, 5 red under mutants.
  - `imaging-desk-door.test.tsx`: 6 tests, 3 red under mutants.
  - `radiology-reception.test.tsx` gained 1 test, red without the mount.
