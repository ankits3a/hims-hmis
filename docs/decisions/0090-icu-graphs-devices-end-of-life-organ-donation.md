---
type: decision
id: "0090"
title: "ICU: numbers and trends in HMIS first (option A), live waves per hall later after a regulatory check (option B); devices must export data; the Supreme Court 2023 end-of-life process; organ donors referred out while the hospital applies as a retrieval centre"
description: "Owner 2026-10-26 ('go ahead with your recommendation'). The ICU nurse station gets numbers, trends, the hourly chart and the alarm ladder from one HL7 gateway per hall, while the monitor maker's central station stays the primary alarm and shows the waves (option A). HMIS draws live waves itself (option B) per hall later, only after a regulatory adviser confirms the 'secondary view' label under the Medical Devices Rules 2017. Every monitor and ventilator bought must export its data, and its waves for any hall that will use B. End of life follows the Supreme Court 2023 process. Brain death is certified here and donors are referred to a registered transplant centre while the hospital applies to be a retrieval centre."
generated: { by: agent:claude, at: 2026-10-26 }
verified: []
status: stable
ruling: ruled
tags: [icu, ipd, devices, law, procurement]
supersedes: []
superseded_by: []
sources:
  - { id: spec-ic1, resource: "docs/specs/984-icu-core.md", title: "Spec: ICU core" }
---
# 0090 — ICU: graphs, devices, end of life, organ donation

- **Date:** 2026-10-26   **Status:** Ruled. The owner accepted the recommendations.
- **Area:** ICU (#984 IC-1, #985 IC-2, #990 end of life and organ donation)

## Rulings

1. **Graphs at the nurse station.**
   - Option A comes first. HMIS shows numbers, 24-hour trends, the hourly chart and the alarm ladder, fed by one HL7
     gateway per ICU hall.
   - The monitor maker's central station stays the primary alarm and keeps the live waves.
   - Option B, where HMIS draws the live waves itself, marked "view only", is added hall by hall later (#985).
2. **Regulatory check.** Option B goes live in a hall only after a regulatory adviser confirms the labelling. Software
   that shows physiological signals may be a medical device under the Medical Devices Rules 2017.
3. **Purchase.** Every monitor and ventilator bought must export its data (HL7). For a hall that will use option B, it
   must also export waves. Each hall gets one gateway. Brands and budget remain the owner's.
4. **End of life.** The hospital follows the Supreme Court's 2023 process: living wills, a DNR order with a 24-hour
   review, and withdrawal decided through the primary and secondary medical boards with their timelines.
5. **Organ donation.** The hospital certifies brain death here, using two tests 6 hours apart by a board not involved
   in transplant. A donor is referred to a registered transplant centre. In parallel, the hospital applies under THOTA
   to register as a retrieval centre.
