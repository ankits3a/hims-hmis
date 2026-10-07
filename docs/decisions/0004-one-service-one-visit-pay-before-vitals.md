# 0004 — One service is charged once per visit; the patient pays before vitals

- **Date:** 2026-09-13   **Status:** Partly open
- **Area:** billing, opd, vitals, front desk, lab

## Decision

1. **One service, one visit, one charge.**
   > *"The hospital must not charge twice for the same service in one visit. If the patient wish to consult another
   > doctor/department for another problem, he must be billed a second receipt, a separate token, a separate
   > prescription."*
   - A second problem is a SECOND visit: its own token, receipt and prescription.
   - The duplicate-invoice guard (FD-27) is correct and stays. Test fixtures that bill the same panel two or three
     times on one encounter are what must change, not the guard.
2. **Pay before vitals, with a named bypass.**
   > *"No patient should reach vitals desk until he has paid. However, in case of emergency or VIP patient, the
   > front desk could enable the patient to bypass the billing with a warning sign/disclaimer/notification on each
   > desk where the patient goes."*

## Consequences / how to apply

Built as FD-32:
- A second guard registry, `registerVitalsStartGuard`, separate from `consultStartGuards`, because the two doors
  treat a waiver differently. OPD owns the registry and the refusal; billing hands in the same `feeGate` verdict.
- The bypass is read by the DOOR (`vitalsGateVerdict`), not by each guard, so a new guard cannot forget to honour it.
- A bypass waives the ORDER, never the fee: `feeUnpaid` stays true afterwards, so the warning does not switch
  itself off.
- On a hospital with no fee policy configured, `feeUnpaid` is false, so commissioning does not paint every patient red.

## Open

- ~~Does the bypass also open the DOCTOR's door?~~ **Answered by 0037 (2026-09-20): no.** Only payment, or the
  treating doctor opening the token, releases it. Built that way: the bypass opens the vitals door only.
