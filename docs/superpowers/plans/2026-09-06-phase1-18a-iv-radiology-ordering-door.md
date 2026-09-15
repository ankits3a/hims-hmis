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
