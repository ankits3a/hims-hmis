---
type: decision
id: "0072"
title: "IPD plan, goal targets and the five IPD answers"
description: "Owner 2026-10-12: execute the IPD plan (goals G1–G11, milestones M0–M6, 29 epics); IPD questions are answered by top-hospital practice; desktop screens are 16:9; companion modules are built in parallel."
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
status: stable
ruling: ruled
tags: [ipd, billing, tariff, planning]
supersedes: []
superseded_by: []
sources:
  - { id: issue-712, resource: "https://github.com/ankits3a/hims-hmis/issues/712", title: "IPD core spec" }
---
# 0072 — IPD plan, goal targets and the five IPD answers

- **Date:** 2026-10-12   **Status:** Ruled
- **Area:** IPD (admission, beds, inpatient billing, discharge) and its companion modules

## What is ruled (owner, 2026-10-12)

- *"Execute the plan."* The plan `docs/superpowers/plans/2026-10-12-ipd-PLAN.md` is the build order: goals
  G1–G11 with their targets and windows (plan §1), milestones M0–M6 with their exit gates (plan §2), and 29 epics
  tracked as issues #713–#741 under the milestone "IPD core".
- *"Whatever top hospitals practice is my answer"* for the IPD questions. The five answers below follow from it.
- Desktop and wall screens are 16:9: designed at 1920 × 1080, tested down to 1366 × 768; command boards fit
  without vertical scroll. Phones are 390 px.
- Companion modules (task engine, housekeeping, bio-medical waste, linen, transport, diet, attendant passes,
  maintenance) are built in parallel with IPD core, each as a leaf module in its own lane.

## The five IPD answers (DECIDED by top-hospital practice under the ruling above)

1. **Cutover.** ADT and IPD billing go live hospital-wide on one date after a staging rehearsal week. Patients
   admitted before that date finish their stay in the incumbent system; their beds show as "occupied —
   incumbent". Nursing and eMAR roll out ward by ward, ICU last.
2. **Rates.** The incumbent's IPD tariff is carried over line by line and reviewed by the owner in the tariff
   screen. Go-live is blocked until every bed class has a room rent, a nursing charge and a doctor-visit fee.
3. **Deposit.** Estimate-based: medical admission = 3 days of class charges; planned surgery = 50 % of the
   estimate or package; ICU = 3 ICU days. Top-up alert at 75 % used, escalation at 90 %. No deposit before an
   emergency is stabilised. PM-JAY and state schemes pay ₹0. Cashless-insured patients pay a small deposit for
   non-payable items only. All amounts are configuration.
4. **Wristbands.** Thermal printers at every admitting point; white bands; alerts ride as clips and are also
   printed in words, because colour alone is not an identifier.
5. **Insured patients before the payer phase.** A manual authorisation record (pre-auth number, status,
   approved amount, enhancements, final approval); the bill splits payer-payable and patient-payable; claims
   are filed on the insurer and scheme portals.

## Consequences / how to apply

- The plan's goal targets are the measures the owner is shown; a target changes only by a new decision.
- Every epic PR says `Closes #<epic>` and `Refs #712`; its "done means" checks become acceptance tests.
- Data owed by the hospital, not rulings: the room-level bed layout and the incumbent's IPD tariff export.
  Until they arrive, staging rehearses on a planning workbook built from the confirmed bed split.
- Doctor surfaces never show money (decision 0058).
