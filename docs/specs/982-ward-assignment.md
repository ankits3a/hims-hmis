---
issue: 982
status: built
approved: 2026-10-26
---
# SPEC — Ward WM-1: shift assignment, ratio and acuity, in-charge cockpit (#982)

Status: APPROVED 2026-10-26 by the owner ("go ahead with your logical recommendation"). It builds on IPD nursing
(E4.1 #733). The rulings are in decision 0089. The safety round, restraints, line-days, crash cart, ward stock and quality
indicators are WM-2 (#983).

## What

Every patient on a ward has one named nurse every minute.

- **Assignment.** For each ward and shift, the in-charge gives every occupied bed to exactly one registered nurse.
  Students are paired with a registered nurse. The in-charge starts from the previous shift's map and publishes the new
  one at least 30 minutes before the shift. If nothing is published by shift start, the previous map carries over and
  the supervisor is alerted.
- **New patients.** An admission or a transfer into a bed with no nurse shows red until someone is assigned. The system
  suggests the nurse with the lowest load.
- **Mid-shift.** A nurse with beds cannot end her duty until each bed is handed to a named registered nurse. A
  reassignment needs a reason and notifies both nurses.
- **Ratio and acuity.** Each patient has acuity points per shift: self-care 1, partial care 1.5, full care 2. A nurse's
  load is the sum over her beds. The ward's ratio is checked against a configurable table by unit type, day and night.
  A breach is recorded and the supervisor alerted. It never blocks an admission or care.
- **Float.** The supervisor sees the least-loaded nurses on duty across a block, and can move one to another ward for a
  shift. The move is recorded.
- **In-charge cockpit.** One screen shows:
  - census and staff on duty
  - the ratio
  - every bed with its nurse's initials, early-warning score, risk icons and the next thing due
  - a "Needs you" list
  - load per nurse, with a rebalance action

## Decisions (0089)

Default ratio table, configurable per ward:

| Unit | Day | Night |
|---|---|---|
| General ward | 1:6 | 1:8 |
| Private ward | 1:4 | 1:6 |
| HDU and ICU | 1:2 | 1:2 |
| Ventilated bed | 1:1 | 1:1 |
| Labour room and NICU | 1:2 | 1:2 |

## Done means

- **D1** Once a shift's assignment is published, every occupied bed has exactly one assigned registered nurse. A
  student cannot be published as a bed's only nurse.
- **D2** If no assignment is published by shift start, the previous one carries over and the supervisor is alerted.
- **D3** A bed admitted or transferred in with no nurse shows red on the Beds board and the cockpit until assigned.
- **D4** A nurse with beds cannot end her duty until each bed is handed to a named registered nurse. A reassignment
  needs a reason and notifies both nurses.
- **D5** The ratio is computed from acuity points against the configured table. A breach writes one event and one
  supervisor alert per shift per ward, and never blocks an admission.
- **D6** The supervisor can move a float nurse to another ward for a shift. The move is recorded, and her beds count on
  that ward.
- **D7** My shift and the nurse station list exactly the beds assigned to that nurse.

## Built (2026-10-26, lane ward-982)

- D1–D7 are `spec #982 Dk` in `apps/core/src/modules/ipd/acceptance/ward-assignment-982.acceptance.test.ts`.
- The ratio counts registered nurses on duty against patients: one nurse per ventilated patient, the rest at the
  table's value. Acuity points set each nurse's load, the cockpit's "overloaded" flag and the lowest-load suggestion.
  The latest acuity record counts until a new one; a patient with none counts as self-care.
- A ward that has never published a map shows no red and keeps the whole-ward list ("No assignment yet").
- Not built here: narrowing transfer acceptance to the receiving ward's nurses; the copilot's float suggestion on the
  cockpit. Both are tracked as issues.
