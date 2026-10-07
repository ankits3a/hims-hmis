# 0003 — Diagnostic-only visits carry no consult fee; a confidential patient's reprint carries the alias

- **Date:** 2026-09-05   **Status:** Partly open
- **Area:** billing, opd, front desk, lab, printing, patients (§14 confidentiality)

Four rulings taken on the FD-25 front-desk lane.

## Decision

1. **PR #92 is marked ready only once its backlog is fixed.** The lane works the eight untaken close-review
   findings, runs the full suites green, pushes, and then marks #92 ready. CI is still the gate.
2. **A diagnostic-only visit carries NO consult fee, ever, and is never re-charged.** Not "only if a doctor is
   involved": the pathologist signs every lab report, so that wording would re-charge exactly the patients the
   exemption is for. If the patient later sees a doctor, that is a NEW visit with its own fee. There is no
   "fee attaches later" machinery.
   In the owner's words: *"Consultation fee is collected separately and diagnostic fee is collected and billed
   separately."*
3. **A §14 (confidential patient) reprint carries the ALIAS.** Every printed slip and receipt for a confidential
   patient shows the alias by default. The legal name prints only when the operator holds
   `patients.confidential.read` OR has an active break-glass grant for that patient (already logged).
4. **Panel/TPA wording on `/billing` is UNSETTLED.** The behaviour fix ships (the old line "bill to panel — nothing
   to collect" was a money defect; the corrected line is "₹560.00 is still payable — the panel rate is the price"),
   but the owner answered with the model (ruling 2's quote), not the wording.

## Why

- Ruling 2: nothing in the system can raise a charge after the fact (`daily-close.ts`: "money is minted at the
  counter, and a sweep that could mint it would be a far worse defect than the one it reports").
- Ruling 3: break-glass makes the wider answer accountable. Handing a break-glass operator paper that says
  "Patient A" only makes them write the real name in pen, where nothing logs it.

## Consequences / how to apply

- Ruling 2, implementable shape: one additive column `opd_encounters.attendance_kind` (default `'consult'`), written
  at `openLabWalkinInTx`; the decision lives in `feeServiceFor` (`billing/charge-rules.ts`) returning null, and the
  duplicate copy in `refunds.ts` is swept so there is one definition. Do not patch the consumption points (worklist,
  daily close, fee status) and do not key on department code (it misses radiology/ECG walk-ins and the
  `/registration` road). At the time of the ruling the code still raised `opdConsult.new` on every lab walk-in.
- Ruling 3: `printing/render.ts` (`subjectOf`) had read `patients.name` raw. Break-glass does not confer
  `patients.confidential.read`; the two meet only in `getPatient`. The fix is a named sibling,
  `displayNameForRelease`, so the billing worklist was not widened along with the printer.

## Open

- The exact `/billing` panel/TPA sentence is not confirmed, and a front-desk briefing is owed before it reaches a
  live counter.
