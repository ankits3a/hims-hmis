# Pharmacy P2 — a registered pharmacist is a fact the system holds (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-registration`. It is stacked on P1 (#214) and
P3 (`lane/pharmacy-partly-checked`), and cut after #213 put migration `0098` on main.

**Why.** The Pharmacy Act 1948 §42 reserves dispensing to a registered pharmacist, and the README
already says so: *"`pharmacy.dispense.scheduled` … is the `pharmacy` role's alone: the Pharmacy Act
1948 §42 reserves the completion of such a dispense to a registered pharmacist"*. But the system
only knows who holds a **role**, not who holds a **registration**.
- The go-live census says so in its own words: `pharmacist_council_number` is *NOT MODELLED —
  "Keep the certificate in the counter's file; the census cannot check it."*
- In production, `pharmacy` is held by `admin`, a login that is not a pharmacist.

## 1. DECISIONS (owner instruction 2026-09-16: follow the Indian hospital standard)

- **P2-1. The register.** `pharmacy_pharmacist_registrations` has one row per registration:
  - `user_id`, the state `council` (for example "Maharashtra State Pharmacy Council"),
    `registration_no`, and `valid_until`. Council registrations are renewed periodically; a
    lifetime registration has none.
  - `recorded_by` and `recorded_at`; and, when the registration stops being current, `ended_at`,
    `ended_by` and `end_reason`.
  - One current row per person (partial unique index). One current holder per `(council,
    registration_no)`.
  - A row is never updated in place: a renewal ends the old row and records a new one, so the
    register shows its history.
- **P2-2. Who records it.** The pharmacist in charge files colleagues' certificates. The new
  permission `pharmacy.pharmacists.manage` goes to the `pharmacy` role.
  - **Never one's own** (`self_registration`), the PCPNDT `same_actor` rule. A certificate
    checked by its holder is not checked.
  - The person recorded must hold the `pharmacy` role at hospital scope (`not_a_pharmacist_role`):
    a registration on someone who cannot dispense is noise.
- **P2-3. Where it is enforced: the acts the Act reserves.**
  - `verifyDispense`, the pharmacist's professional check of the prescription (D9's re-check),
    places the order.
  - `handOverDispense` of a scheduled dispense (`pharmacy.dispense.scheduled`).
  - Both refuse `pharmacist_not_registered` unless the actor has a current registration
    (`valid_until` null or on or after today, IST).
  - Claim, pick and an unscheduled hand-over are not refused: the aide's acts stay the aide's.
- **P2-4. The record carries it.**
  - `dispense.verified` and `dispense.handed_over` carry the acting pharmacist's
    `registrationNo`.
  - The counter label prints "Dispensed by `<name>` · Reg. `<council abbreviation or name>`
    `<no>`" for the pharmacist who verified.
  - The H1 register row carries the handing-over pharmacist's registration number.
- **P2-5. The census row becomes a check.** `pharmacist_council_number` (G4) is green when at least
  one active holder of `pharmacy.dispense.scheduled` has a current registration.
- **P2-6. The screen.** `/pharmacy/pharmacists` lists the `pharmacy` role holders, each with a
  current registration or "none on file", and lets a holder of the permission record or end
  someone else's.

## 1.1 AS BUILT

- **Schema.** `pharmacy_pharmacist_registrations` has:
  - two partial unique indexes over current rows: per person, and per `(lower(council),
    lower(registration_no))`;
  - checks that a row is never self-filed and that all three `ended_*` columns are written
    together or not at all.
  - `pharmacy_reg_h1.pharmacist_reg_no` is nullable, because earlier rows predate the register.
- **Module.** `pharmacists.ts` holds:
  - `recordPharmacistRegistration`. Its refusals are `self_registration`,
    `invalid_registration`, `registration_expired`, `not_a_pharmacist_role` and
    `registration_in_use`. A renewal ends the current row in the same transaction.
  - `endPharmacistRegistration`, which also refuses `self_registration`, and refuses
    `registration_ended` for a row already ended.
  - The gate `requireRegisteredPharmacist`.
  - `registrationAt`: the registration current at a given moment, so a reprinted label keeps the
    old number.
  - `listPharmacists`.
- **Enforcement.**
  - `verifyDispense` asks the gate **after** `placeOrder` has asserted the permission. A login
    without the permission is refused exactly as before; a refusal rolls the order back.
  - `handOverDispense` asks it inside the scheduled branch, after the permission check.
- **Records.**
  - `dispense.verified.pharmacistRegNo` and `dispense.handed_over.pharmacistRegNo`, each with a
    null default for older payloads.
  - The H1 register row.
  - The label's "Dispensed by `<name>` · Reg. `<no>`".
- **Permission `pharmacy.pharmacists.manage`**, granted to `pharmacy`, took four edits: the manifest,
  `seed:roles`, a README row and a README sentence, and the census counts (declared 167, model 147,
  held 153, pairs 332).
- **Surface.**
  - `GET /pharmacy/pharmacists`, `POST /pharmacy/pharmacists/:userId/registrations` and
    `POST /pharmacy/pharmacists/registrations/:id/end`.
  - The `/pharmacy/pharmacists` screen, with its nav entry.
  - The web route count goes 55 → 56.
- **Census.** `pharmacist_council_number` is a G4 check, where it used to be NOT MODELLED.
- **The fixture** gains `ph.incharge`: a `pharmacy` holder with no registration, who files
  `ph.mehta`'s. So every existing counter test runs as a registered pharmacist, and the new tests
  run as an unregistered one.

**Tests.**
- `pharmacists.test.ts`: 9 tests, covering filing, the refusals, renewal, ending, the database
  checks, the verify gate, a lapsed certificate, and the scheduled hand-over with its H1, event and
  label numbers.
- An HTTP test.
- A census test: green, then red once the only registration ends.
- The web screen (2 tests) and the label line.

**Mutants (10, predicted, all killed):**
- R1: a lapsed registration counts.
- R2: verify skips the gate.
- R3: hand-over skips it.
- R4: self-filing is allowed in code, so the database check is the only guard left.
- R5: the role is not required.
- R6: a renewal does not end the old row. Predicted 2 failing tests, got **3**: the valid-until
  test also files a renewal.
- R7: the label reads the live registration.
- R8: ending one's own is allowed.
- R9: the census row is always green. Predicted 1 failing test, got **3**.
- R10: the label omits the number.

## 2. NOT BUILT

- Proof of the certificate itself (a scan). That is the owner's document store, when there is one.
- Verification against the council's register. No state council publishes an API.
- Expiry reminders. The Expiry Watchman already reads licences in doc 16 §9; a `valid_until`
  within 30 days is a candidate for it later.
