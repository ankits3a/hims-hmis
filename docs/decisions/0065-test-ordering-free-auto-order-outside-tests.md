---
type: decision
id: "0065"
title: "While a test fee is Free, the doctor's advised tests order themselves at Complete consult; imaging gets its own Free switch; ECG, echo and the like get an outside-test catalogue; one ordering door serves every doctor screen"
description: "Owner 2026-10-10: free lab tests and free imaging studies are ordered automatically when the doctor completes the consult (or the scribe saves a paper prescription), and the lab or imaging staff then add, remove and proceed. A new Imaging switch joins the OPD consult and lab switches. Tests the hospital does not do (ECG, 2D echo, TMT, PFT, EEG, NCV, endoscopy, colonoscopy, Holter, audiometry) are kept in an outside-test catalogue and print under 'Tests to be done outside'. One server door routes any episode's tests to lab, imaging or outside, ready for the IPD and Emergency screens."
generated: { by: agent:claude, at: 2026-10-10 }
verified: []
status: stable
ruling: ruled
tags: [ordering, lab, radiology, billing, opd, money]
supersedes: []
superseded_by: []
sources:
  - { id: spec-test-ordering, resource: "/opt/hmis-context/SPEC-test-ordering-sync-2026-10-10.md", title: "Spec: doctor's tests become orders when free, outside catalogue, ordering seam" }
---
# 0065 — Test ordering: free tests order themselves, outside tests, one door

- **Date:** 2026-10-10   **Status:** Ruled
- **Area:** ordering (new module), lab, radiology, billing fee switches, OPD prescription print

## What is ruled (owner, 2026-10-10)

The owner's answers, in their words:

- *"No IPD screen, no Emergency screen and no ward ordering in HMIS today: Build the functionality so
  that when the screens are built then it will be easy to get started."*
- *"The doctor's tick does not create a lab or imaging order: If the fee is toggled Free by the admin
  then an automatic order will be created which the lab staff can add/edit and proceed for blood
  collection or imaging."*
- The doctor's test search need not show which department does a test.
- *"Build Catalog for them [ECG, echo …]. The patient would get the tests outside the hospital till
  the hospital don't arrange the facility."*
- Asked and answered: **add an Imaging Free switch** (yes); **order at Complete consult**, not on every
  save (yes); **start the outside list with ECG, 2D echo, TMT, PFT, EEG, NCV, upper GI endoscopy,
  colonoscopy, Holter and audiometry** and let the admin add more (yes).

1. **Free tests order themselves.** When the doctor completes the consult, or the scribe saves a paper
   prescription, each advised lab test is ordered for the lab if the lab fee switch was off at that
   moment, and each advised imaging study for imaging if the imaging switch was off. The order is
   placed by the system under protocol `decision-0065:free-tests`, with the treating doctor as the
   ordering clinician; a lab order still gets its ₹0 bill. With a fee charged, nothing changes: the
   desk orders and bills.
2. **Imaging has its own Free switch** on Billing back office → Fees. A study ordered while imaging is
   free is authorised `free`: it needs no bill to start, it raises no "scanned but not billed"
   decision, and its "report ready" message is not held for payment.
3. **Outside tests** are a catalogue of their own (`outside_tests`, each row its own tariff service
   `OUTSVC-<code>`). The doctor and the scribe find them in the same test box; the prescription
   prints them under "Tests to be done outside" without a price. No order and no bill is made. When
   the hospital starts one, the admin sets it "In hospital" with the department.
4. **One ordering door** (`modules/ordering`, `POST /ordering/orders`, `GET /ordering/tests`) takes an
   episode number, tests and the ordering doctor and routes each test by its id: lab, imaging,
   outside or unknown. It works for any episode series the kernel resolves, so an IPD or Emergency
   module registers its series letter and calls it. `TestPicker` (web) is the matching search box.

## DECIDED (standard practice, open to the owner's objection)

- **A test is ordered automatically once per visit, ever.** If the visit already has that test on any
  order — placed by the desk, by an earlier completion, or cancelled by the lab — it is left alone, so
  the lab's removal is never undone by a later completion.
- **A test needing written consent (HIV, the pre-op and antenatal profiles) is never ordered by the
  system.** It is reported as skipped and the desk orders it after taking consent; the other tests
  still go.
- **A refused department does not stop the other** (a duplicate in the lab does not block the X-ray).
- **The fee is judged at the moment of completion**, the way the consult switch is judged at the
  moment of the visit: switching charging on later does not charge an order already made free.
- **No new permission.** Reading the test lists rides `tariff.read`; editing the outside list rides
  `tariff.services.manage`; ordering rides `orders.place` plus each department's place permission,
  which `placeOrder` already checks.
- **Imaging indication** on an automatic order is the consult's diagnosis, else "Advised at the OPD
  consultation".
- **The phone app's test box** still searches the price list only; outside tests appear there in the
  next app release.

## Consequences / how to apply

- Billing: `FEE_KINDS` gains `imaging`; `fee_switch.changed` carries it.
- Radiology: `IMAGING_AUTHORISATIONS` gains `free` (migration widens the CHECK); `imagingFreeAt`.
- Lab: `placeLabOrder` is `deskOrder` without the counter's permission check; `deskOrder` is unchanged.
- New module `ordering`: consumer `ordering.free_tests` on `consultation.completed` and
  `prescription.paper_transcribed`; events `ordering.free_tests_ordered`, `ordering.outside_test_saved`;
  seed `seed:outside-tests` runs on every deploy and adds missing codes only.
- OPD prescription print payload gains `outsideTestIds`.
