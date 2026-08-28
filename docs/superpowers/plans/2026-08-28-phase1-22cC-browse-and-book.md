# Plan 22c-C — Browse and book: catalogue, availability, holds, binding, cart

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION.** Two rulings were taken at write time: **the hold is a status, not a table** (DD1, RULED — the shipped partial unique index is already the sole arbiter of slot contention and must stay the only one) and **`appointment_no` becomes nullable for held rows** (DD2, RULED — a browse-abandon must not burn a patient-facing number). Everything else was locked in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md).

**Roadmap:** Track C · the last of M1's three slices (`22c-A` → `22c-B` → **`22c-C`**). **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §11.1 (OPD entry lanes, the <300 ms search budget), §7 (billing, the consult-fee branch), §15 (performance). **Brainstorm:** [`../brainstorms/2026-08-27-patient-self-service/03-JOURNEY-SEGMENTS.md`](../brainstorms/2026-08-27-patient-self-service/03-JOURNEY-SEGMENTS.md) §3–§4 (segments S2, S3), `01-MEDANTA-TEARDOWN.md` §1 (the doctor card and slot grid, observed in production).

**Slot: gated on 22c-B.** It also **completes M1** — at close, a patient can self-register, browse, hold a slot, bind themselves and book, paying at the counter. **No online money in this phase.**

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), ledger §5 (lines 1132–1146). **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed per tool call (v3 §9.1).** Entries that bite: §2.101, §2.115.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Eight tasks, one migration, no workflow definition, no approval band. **Five CRITICAL** — this phase touches the slot-contention arbiter, a money-correctness path, and the wrong-patient seam, and v3 §2 is explicit that the lane does not set verification depth.

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA; reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **700,000 tokens**

`1.5 × (20,178 × 8) = 242,136` + two fresh review passes `244,568 + 213,923 = 458,491` = **700,627 → 700,000.** Same inputs and the same known bias as 22c-A/B: for a LIGHT phase the baseline rate is a review cost wearing an execution cost's clothes; main-session cost stays unmeasurable (runbook **O3**).

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 7,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| `03-JOURNEY-SEGMENTS.md` §3–§4 | ≈ 9,000 | 2,250 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

22c-A made a patient actor. 22c-B let it in and gave it a household. This phase gives it something to do, and it is the first phase whose output the public can reach.

It is also where the two hardest non-money problems in the programme live: **slot contention under a public front door**, and **showing a fee that equals the fee the counter will charge.**

---

## 2. Ground truth — measured 2026-08-28, **re-measure at kickoff** (AGENT-RULES §6)

| fact | value | consequence |
|---|---|---|
| **the slot arbiter** | `opd_appointments_slot_ux` UNIQUE `(doctor_id, slot_start)` **WHERE `status IN ('booked','checked_in','needs_rebooking')`** — migration `0010` | **DD1.** Adding `'held'` to this predicate makes a hold block exactly like a booking, using machinery that is already correct |
| the code's own words | *"the partial unique index … is the SOLE arbiter — the booking-race loser code is `slot_taken` on every interleaving because `availableSlots(...).booked` is never read here for correctness (that flag is display data only)"* | **DD3** restates this rather than re-deriving it |
| **`availableSlots` cost** | **4 queries per doctor per day** — config, templates, leaves, booked rows | A 40-doctor department across 7 days is **1,120 queries per page load**. This is the projection's justification, as a number |
| `appointment_no` | `text NOT NULL`, `opd_appointments_appointment_no_ux` unique; allocated **before** the insert, and a lost race burns a number by design | **DD2** — acceptable for a desk race, not for browse-abandon at self-service volume |
| the consult-fee branch | `feeServiceFor(encounter, chargeRules)` returns **`null` for `revisit`** — *"`revisit` is FREE and passes with no invoice at all … the branch is resolved BEFORE anything is read from the ledger"* (`billing/gate.ts`) | **DD5** — the app must call this, not reimplement it |
| visit types | `new` · `renewal` · `revisit` (`billing/charge-rules.ts`) | |
| slot grain | `opdConfig.slotMinutes` default **10** | Matches the production competitor's grid exactly |
| doctor fields today | `displayName`, `registrationNo`, `departmentId`, `specialty`, `active` | Six card fields missing ⇒ **DD6** |

---

## 3. Spike — answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | **How is `visitType` determined when an encounter opens, and can that classifier be run prospectively for a future date?** | **The sharpest question in this phase.** If it can, T5 calls it. If it cannot, the app must show a fee *rule* ("₹500 · free revisit within 7 days") rather than a number, and DD5 changes shape |
| **S2** | Does anything read `appointment_no` before check-in? | Decides whether DD2's nullable column is free or needs readers fixed |
| **S3** | Can the `0010` index be replaced in a migration without a long lock at production row counts? | A DROP/CREATE on a unique index takes an ACCESS EXCLUSIVE lock. Measure the table size and decide CONCURRENTLY vs in-transaction |
| **S4** | What is the real per-department doctor count and schedule density in production? | Sizes the projection's refresh cost against the measured 4-queries-per-doctor-day |
| **S5** | Do any two doctors share a room in the same slot on the shipped schedules? | The projection must not present a slot the room cannot host |
| **S6** | What is the p95 of the shipped `<300 ms` patient search under the current row count? | The public catalogue inherits that budget and must not spend it |

---

## 4. Design decisions

**DD1 — RULED: the hold is a status on `opd_appointments`, not a separate table.** The partial unique index is already the sole arbiter of slot contention, is already correct on every interleaving, and is already tested. Adding `'held'` to its predicate means a hold blocks a booking through that same arbiter. A separate `appointment_holds` table would need its own exclusion against `opd_appointments` — **two arbiters, and a race between them**, which is the defect class this index exists to eliminate.

**DD2 — RULED: `appointment_no` becomes nullable, `NOT NULL` for every status except `held`.** The number is allocated at hold→booked conversion, not at hold. The shipped design burns a number on a lost race and says so deliberately — correct for a desk, wrong for self-service, where abandoning a cart is normal behaviour and the number is printed on a patient-facing slip.

**DD3 — The projection is display-only, and the booking path never reads it.** `availableSlots` remains the authority at insert time. The projection serves lists, counts and sorts. This is not a new rule; it is the shipped comment, promoted to a phase decision so the projection cannot quietly become an arbiter.

**DD4 — The projection is invalidated, never scheduled.** Booking, hold, hold-expiry, leave, leave-cancel and schedule change each invalidate the affected `(doctor, date)` cells. A cron rebuild would be stale by design and would hide the invalidation bugs.

**DD5 — Prospective fee resolution calls the shipped classifier, and never reimplements it.** Whatever decides `visitType` at encounter open is what the app calls with a prospective date (S1). If it cannot be run prospectively, the app shows **the rule, not a number** — *"₹500 · free revisit within 7 days"* — which is truthful and still beats the competitor's flat fee. **Never show a number the counter will not honour.**

**DD6 — `doctor_public_profiles` is its own table with an explicit `published` flag and a consent record.** Never a projection of the user or HR record. Publishing a doctor's photograph and gender to the public internet is a consent act (locked, C-14).

**DD7 — Taken slots render disabled, not hidden.** The production competitor hides them, so a half-full morning looks like a broken page and the patient cannot see the doctor is busy.

**DD8 — One cart, one patient.** Multi-patient payment is 22a's problem — an intent over a *set* of carts — not the cart's. Modelling a multi-patient cart is a wrong-patient defect waiting for a busy morning.

**DD9 — The hold TTL in this phase is the interaction clock only (10 minutes, locked P-5).** The pending clock and its interaction with a payment intent arrive with 22a. This phase ships the base TTL and the release sweep, and nothing that assumes an intent exists.

---

## 4A. ROUTED TO THE OWNER

**None at kickoff.** S1 may make DD5 fall back to showing a rule instead of a number — a §6.3 finding, not a blocker.

---

## 5. Tasks

Eight. Five CRITICAL.

### T1 — Migration `0038`: the index predicate, nullable `appointment_no`, profiles, projection, cart — **ROUTINE**

Replace `opd_appointments_slot_ux` with the predicate extended to `'held'` (per S3's answer on locking). `appointment_no` nullable + check constraint `status <> 'held' OR appointment_no IS NULL`. `doctor_public_profiles`. `availability_projection`. `carts` + `cart_lines`.

### T2 — Doctor public profiles and consented publication — **ROUTINE**

Photo, designation, experience, gender, consult modes, age bands, qualifications, bio. `published` gates every public read; a consent record is required to set it. Bio is escaped once and the escaping is pinned by a test — the production competitor ships `&amp;` and `&nbsp;` literally in exactly this field.

### T3 — The availability projection — **CRITICAL**

Per `(doctor, date)`: free-slot count, banded counts, earliest free slot. Invalidated per DD4.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A1 | The booking path never reads the projection (DD3) | Have `bookAppointment` consult it → the projection becomes a second arbiter and a stale cell books a taken slot |
| A2 | Booking, hold, expiry, leave, leave-cancel and schedule change each invalidate the cell | Drop the hold-expiry invalidation → a released slot stays invisible until something else touches the doctor |
| A3 | A stale cell degrades the list, never the booking | Serve a booking decision from a stale count → double-booking that the index then rejects confusingly |
| A4 | Earliest-availability sort answers from the projection in one query | Fan out `availableSlots` per doctor → the measured 4-per-doctor-day cost, 1,120 queries a page |

### T4 — Slot holds inside the shipped arbiter — **CRITICAL**

`held` status, TTL, release sweep, hold→booked conversion, hold reclaim by the same patient.

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A5 | A held slot refuses a second booker with `slot_taken` | Leave `'held'` out of the index predicate → **two patients hold and both book the same slot** |
| A6 | Hold→booked is atomic and cannot lose the slot in between | Delete-then-insert instead of updating status → a third party wins the gap |
| A7 | An expired hold releases the slot and consumes **no** `appointment_no` (DD2) | Allocate at hold → every abandoned browse burns a patient-facing number |
| A8 | Two concurrent hold attempts on one slot: exactly one wins | Rely on a read-then-write instead of the index → both succeed |
| A9 | A patient reclaims their own live hold from another device | Key the hold to a session → a dropped connection loses the slot the patient is paying for |
| A10 | An expired hold's message is *"your hold expired"*, not *"slot taken"* | Collapse the two → the patient believes someone stole their slot |

### T5 — Prospective fee resolution — **CRITICAL**

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A11 | A `revisit` prospective classification requests **no money at all** | Charge and refund later → the golden-suite F20 failure, and a refund queue at the desk from day one |
| A12 | The prospective classifier and the encounter-open classifier return the same value for the same inputs | Reimplement the branch in the app → the fee shown and the fee charged diverge silently |
| A13 | The fee displayed at hold time is the fee charged at conversion (R-14) | Re-resolve at conversion → a tariff edit mid-hold changes the price under the patient |
| A14 | If prospective classification is impossible (S1), the surface shows the **rule** and never a number | Show a guessed number → we ship the competitor's defect deliberately |

### T6 — Select-Patient binding and the cart — **CRITICAL**

A dedicated step after slot choice (never inherited from viewing context), showing name, **age to the day**, sex and UHID.

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A15 | The bound patient comes from the binding step, never from the header's viewing profile | Inherit it → the wrong family member is booked, silently |
| A16 | Changing the bound patient recomputes the fee | Cache it → a child's fee is charged for a parent, or a revisit branch is applied to the wrong person |
| A17 | A deceased patient cannot be bound | Allow it → `deceasedAt` is defeated at the one point it most matters |
| A18 | A merged patient resolves to canonical, and the cart shows the canonical UHID | Bind the loser → the booking attaches to a frozen record |
| A19 | A cart holds exactly one patient (DD8) | Allow two → a wrong-patient defect with no defence downstream |
| A20 | Add-profile mid-checkout still runs 22c-B's dedup gate | Bypass under time pressure → the gate's most likely bypass point |

### T7 — Pay-later, the deadline, and the UNPAID surface — **ROUTINE**

Pay-later is a tariff property (R-12). Deadline **4 hours before the slot**; a booking made inside 4 hours cannot choose it (P-4). The UNPAID card pins to the app's home and appointments surfaces, and the deadline is a date and a time on screen — never *"may require payment"*.

### T8 — Public catalogue routes, search, and the e2e — **ROUTINE**

`@Public()` department/speciality/doctor/slot routes, throttled, carrying **no patient context**. Sort and filter per the observed production set. **This is the phase's act of opening 22c-B's routes to the internet.**

Two e2e: *guest browses → registers → holds → binds → books pay-later → counter settles*; and *two sessions race one slot → one books, one sees `slot_taken` and a refreshed grid*.

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S6 — especially S1's effect on DD5, and S3's locking verdict
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification
### 6.6 The independent close review — **and the M1 milestone close**
