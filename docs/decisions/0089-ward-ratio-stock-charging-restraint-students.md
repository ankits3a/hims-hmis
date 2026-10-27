---
type: decision
id: "0089"
title: "Ward management: nurse ratio defaults (breach alerts, never blocks), ward stock charged at use, restraint policy, student and agency nurse limits"
description: "Owner 2026-10-26 ('go ahead with your logical recommendation'): configurable nurse-to-patient ratio defaults by unit type, where a breach is recorded and alerted but never blocks care; ward stock charged when used on the patient; a restraint policy with a doctor's order, 2-hourly checks, a 24-hour review and a register; students never give high-alert or narcotic medicines alone; agency nurses never hold narcotic keys. The bed list is still owed by the owner, and the pilot is the first general-medicine ward on it."
generated: { by: agent:claude, at: 2026-10-26 }
verified: []
status: stable
ruling: ruled
tags: [ipd, nursing, ward, ratio, money, law]
supersedes: []
superseded_by: []
sources:
  - { id: spec-wm1, resource: "docs/specs/982-ward-assignment.md", title: "Spec: ward shift assignment, ratio and acuity, in-charge cockpit" }
---
# 0089 — Ward management: ratio, stock charging, restraint, students and agency nurses

- **Date:** 2026-10-26   **Status:** Ruled. The owner accepted the recommendations ("go ahead with your logical
  recommendation").
- **Area:** IPD wards (#982 WM-1, #983 WM-2, #737 rollout)

## Rulings

1. **Nurse-to-patient ratio.** These are defaults, editable per ward. A breach is recorded and the supervisor is
   alerted. A breach never blocks an admission or care.

   | Unit | Day | Night |
   |---|---|---|
   | General ward | 1:6 | 1:8 |
   | Private ward | 1:4 | 1:6 |
   | HDU and ICU | 1:2 | 1:2 |
   | Ventilated patient | 1:1 | 1:1 |
   | Labour room and NICU | 1:2 | 1:2 |

   Acuity points per patient per shift: self-care 1, partial care 1.5, full care 2.
2. **Ward stock charging.**
   - Ward stock is charged when it is used on the patient.
   - Items indented for one patient are charged at issue.
   - Items opened and then wasted are charged, with a reason.
   - Items refused and unopened are not charged.
3. **Restraint.** A restraint needs a doctor's order. Checks are due every 2 hours. The order lapses at 24 hours without
   a review. The family is told, and every restraint goes in a register. Psychiatric settings also keep the Mental
   Healthcare Act register.
4. **Student nurses.** Students never give high-alert or narcotic medicines alone, and never own a bed alone.
5. **Agency nurses.** Agency nurses never hold narcotic keys. They may witness only if their council registration is
   verified.
6. **Bed list and pilot.** The owner still owes the real bed list for #737. The pilot ward is the first general-medicine
   ward on that list, and the ICU goes last.
