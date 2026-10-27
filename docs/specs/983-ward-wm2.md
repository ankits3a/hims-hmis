---
issue: 983
status: built
approved: 2026-10-27
---
# SPEC — Ward WM-2: safety round, restraints, lines, crash cart, ward stock, ward quality (#983)

Status: APPROVED — owner 2026-10-27: specs yes (all defaults). The four money / law answers below are ruled in decision
0091. Builds on WM-1 (#982, `docs/specs/982-ward-assignment.md`), IPD
nursing (E4.1: the admission assessment already records Morse and Braden), the eMAR and narcotic register (E4.3), and
materials (indents, expiry, consumption). Rulings: decisions 0089 and 0091.

## What

The ward keeps every patient safe between rounds, and the bill shows what the patient used.

- **Safety round.** Morse (falls) and Braden (pressure) are scored at admission (exists) and once a day. Morse 45 or more,
  or Braden 12 or less, adds a care plan with timed checks (fall bundle; 2-hourly turns). A missed check shows on the
  nurse's My shift and on the WM-1 cockpit "Needs you" list.
- **Restraint.** Only on a doctor's order with a reason and type. Checks every 2 hours. The order lapses at 24 hours
  without a doctor's review. The family is told (who and when recorded). Every episode goes in the restraint register;
  psychiatric wards also fill the Mental Healthcare Act register.
- **Lines.** Urinary catheter, central line and cannula each record insertion, site and a due-removal date. The doctor's
  round asks "still needed?" once a day. Line-days per ward feed the infection indicators.
- **Crash cart.** Checked every shift against its numbered seal. A seal number that differs from the last check forces a
  full recount and raises an incident. After a code, the cart shows "needs restock" until recounted and resealed.
- **Ward stock.** Par per item per ward. The in-charge raises one indent to stores (materials) for the shortfall. Lots
  expiring within 30 days are listed for return to stores. Charging per 0089: at use on the patient; at issue when
  indented for one patient; opened and wasted with a reason; refused and unopened not charged.
- **Student and agency limits.** A student cannot be the giving nurse for a high-alert or narcotic dose without a
  registered nurse's PIN. An agency nurse cannot hold the narcotic keys or sign a narcotic count.
- **Ward quality.** One read per ward per month: falls per 1,000 bed-days, new pressure injuries, medication errors,
  line infections per 1,000 line-days, EWS alerts answered in time, handovers on time, shifts with ratio kept.

## Decisions

- DECIDED (standard practice): scales are Morse and Braden as already stored; thresholds as above, editable per ward.
  Restraint checks cover circulation, skin, hydration and toileting. A restraint order cannot be renewed without a new
  doctor's sign. A cannula is due for review at 72 hours, a catheter and central line daily.
- DECIDED: the crash-cart contents list is the hospital's standard list, editable per ward type; an incident is a
  recorded event visible to the nursing superintendent (no separate incident module in WM-2).
- DECIDED: a pressure injury or fall found on admission is recorded as present on admission and does not count against
  the ward. Indicator definitions follow NABH (6th edition) key performance indicators.
- DECIDED: an item found expired on the shelf cannot be charged to a patient.

## Money and law (owner 2026-10-27: the defaults accepted; decision 0091)

1. **Price of a ward-stock charge.** Default: medicines at the pharmacy batch price used for ward issues (#787);
   consumables at the hospital tariff, never above MRP. Items inside a package are not charged separately.
2. **Opened-and-wasted charge.** Default: charged at full price with a reason; the in-charge may waive it, and a waiver
   is logged. Wastage caused by staff error is never charged.
3. **Mental Healthcare Act.** Default: psychiatric wards follow MHCA s.97 (restraint ordered by a psychiatrist,
   nominated representative told within 24 hours) and the register produces the monthly report for the Review Board.
4. **Expiring stock returned from the ward.** Default: stores takes it back at no cost to the ward's cost centre and
   handles the vendor return or write-off.

## Done means

- **D1** A patient with Morse 45 or more, or Braden 12 or less, has a care plan with timed checks; a check not done by
  its time shows on My shift and the cockpit "Needs you" list until done.
- **D2** A restraint cannot start without a doctor's order. A 2-hour check not recorded raises an alert, and the order
  lapses at 24 hours without a doctor's review. Every episode, with the family-told record, lists in the register.
- **D3** Each line has an insertion date and a due-removal date; the doctor's round shows "still needed?" daily for
  each; the ward's line-days per month equal the sum of days each line was in.
- **D4** A crash-cart check with a seal number different from the last check cannot be saved without a full recount and
  writes one incident. A cart used in a code shows "needs restock" until recounted and resealed.
- **D5** A ward indent proposes each item's shortfall to par and reaches stores as one materials indent; lots expiring
  within 30 days are listed for return.
- **D6** Ward stock charges follow 0089: used → charged; indented for one patient → charged at issue; opened and wasted
  → charged only with a reason; refused unopened → not charged; an expired lot → never charged.
- **D7** A student cannot be the only signer of a high-alert or narcotic dose, and an agency nurse cannot take the
  narcotic keys or sign a narcotic count.
- **D8** The ward quality read for a month returns the seven indicators, each traceable to its source rows, with
  present-on-admission falls and pressure injuries excluded.

## Known now

- Morse and Braden are already stored on the admission assessment (`ipd_nursing_assessments`); a reassessment task is
  marked as an owed seam in `ipd/nursing.ts`.
- WM-1 gives the cockpit, "Needs you", My shift and the shift slots; E4.3 gives the narcotic register and second-nurse PIN.
- Materials already has indents, expiry and consumption; the ward is a store location there, not a new stock ledger.

## Out of scope

- An incident-reporting module (root cause, CAPA); infection-control surveillance beyond line-days; ICU-specific bundles
  (ICU milestone #984–#993); device integration; the bed list and pilot rollout (#737).

## Built (2026-10-27, lane ward-wm2-983)

- D1–D8 are `spec #983 Dk` in `apps/core/src/modules/ipd/acceptance/ward-safety-983.acceptance.test.ts`.
- Migration `ipd_ward_safety` (numbered at merge). Notes in `apps/core/src/modules/ipd/MAP.md` ("Ward safety, stock and
  quality").
- DECIDED in the build: the fall bundle is checked every 4 hours, turns every 2; a check is overdue past its time and lists
  until done. A restraint starts only from a doctor's order (a nurse applies it); a lapsed order is never renewed. A
  psychiatric ward is a ward whose department is `PSY`, and a psychiatrist is a doctor-master doctor in that department.
  A line counts one line-day for each IST day it was in, at the ward where it was inserted. The ward's stock is a
  materials store; a ward-stock charge is the ward-issue medicine line, priced by the pharmacy counter's rule. An expired
  lot is refused outright. An agency nurse is the role `agency_nurse`, held beside `ward_nurse`. Quality: EWS answered
  within 10 minutes, a handover accepted within 30 minutes, bed-days as the exact overlap of stays with the month.
- Not built here: the forms that start a restraint, a line, the daily score, a safety event, a crash cart and ward par
  (#1007); the in-charge's seeded `materials.stock.receive` (#1008); the agency witness rule (#1009); one-tap return of
  expiring lots and automatic package detection (#1010).

