# 0046 — OPD vitals: no RR tile, and a guardian with reports may skip the bay on a revisit

- **Date:** 2026-10-07   **Status:** Partly open
- **Area:** opd, vitals, front desk, doctor

## Decision

### (a) RR is hidden in OPD

- No OPD band requires a respiratory rate, so the vitals bay (web and phone, one shared `tileOrder` in
  `packages/contracts/src/vitals-entry.ts`) no longer shows an RR tile. RR is now like MUAC: a tile only where the
  band requires it. A band that requires RR gets the tile back unchanged; RR readings already saved are untouched.

### (b) A guardian with reports may skip vitals on a revisit

- Owner: *"When the patient's guardian comes with the report of the patient as a revisit patient, add an option to
  skip the vitals taking process, as the patient didn't come — his guardian came to show the report to the doctor."*
- The vitals bay and Desk One's visit card offer **"Patient not present — guardian with reports"** on a **revisit**
  that is still waiting for vitals. The desk picks who came (father, mother, spouse, son, daughter, brother, sister,
  other relative, attendant) and may type a name (80 characters at most).
- The visit then makes the move a vitals save makes: `registered → waiting`, the token `waiting_vitals → waiting`,
  callable from that moment. No vitals row is written.
- The doctor sees it on the queue row (a "Guardian (Father: Ramesh)" tag) and on the consultation screen and the
  brief: *"Patient absent — guardian (Father: Ramesh) brought reports. Vitals not taken."*
- **The fee is unchanged.** The bay's pay-before-vitals door (FD-32) is asked exactly as the bay asks it and refuses
  with the same code; the front desk's bypass opens it as always. The visit is billed as the revisit it is.

## DECIDED around the ruling (not ruled; the owner may overturn)

- **Revisit only.** A new or renewal visit is refused (`patient_absent_revisit_only`, 409). A visit past the bay is
  refused (`encounter_state_conflict`).
- **Who may.** Anyone holding the bay's grant (`opd.vitals.record`) or the front desk's (`opd.visits.open`) — the two
  seats a guardian walks up to. No new permission.
- **The workflow move is made by a named system actor** (`opd-patient-absent`), because the activated `opd_visit`
  definition gives `registered → waiting` to the bay, nurses and doctors only; widening it would let the counter
  skip the bay for every visit. The person is on the row (`patient_absent_by`) and in the event
  (`visit.patient_absent`, which carries the relation and whether a name was given, never the name).
- **Once marked, it stays.** A second mark answers with the first and changes nothing. A visit closed from paper by
  mistake and reopened goes back to the doctor's line, not to the bay.
- **The bench lets it go.** A marked visit is no longer listed on the vitals bench.
- **The doctor's start needed no change**: starting a consultation has never asked for a chart.

## Still open

- **The fee for a guardian-only revisit** — the owner may rule on whether it differs from an ordinary revisit.
- The mobile staff app does not offer the mark; the doctor's phone does not show the tag.

## Why

A guardian carrying reports cannot be weighed, and a token held at the bay for a patient who is not in the building
never reaches the doctor. The mark says why the chart is empty, in the doctor's own screen, and costs nothing else.
