---
issue: 611
status: built
approved: 2026-10-10
---
# SPEC — doctor's tests become orders (when free), outside-test catalogue, ordering seam for IPD/ER

**Status:** APPROVED by the owner 2026-10-10 (imaging Free switch: yes; auto-order at Complete consult; outside list as below). Building in lane `test-orders`.

## Owner's answers (2026-10-10)
- Build the ordering so future IPD and Emergency screens plug in easily.
- If the fee is toggled Free by the admin, the doctor's tests become an automatic order; lab staff can add or remove
  tests and go on to blood collection or imaging.
- Consult search need not mark which tests lab/radiology perform (gap 3: leave as is).
- ECG, echo and similar get a catalogue; patients get them done outside until the hospital has the facility.
- Gap 7 (withdrawn test pre-ticked): FIXED in lab-quick 7b1d9037, on staging.

## Known now
- "Free" = decision 0021 fee switch `lab` (Billing back office -> Fees; modules/billing/config.ts FEE_KINDS
  `opdConsult`,`lab`). Off = lab tests billed at Rs 0. Imaging has NO switch; imaging cannot start without an
  invoice line, day-care, payer or stat (radiology/money.ts authorisationOf).
- Advised tests are saved by `saveConsultNote` / paper transcribe; no event carries them. Lab desk `deskOrder` places
  order + invoice in one step but needs a lab desk user. Episodes plug in by `registerEncounterResolver` (V, D today).

## Spec
1. **Auto-order when free.** When the doctor completes the consult (and when the scribe saves a paper Rx), each
   advised lab test is placed as a lab order (Rs 0 invoice) if the lab switch is off at that moment. Ordered by the
   doctor, placed by "system". The lab desk / quick Start shows them as already ordered; staff can add tests
   (add-on) or cancel one before collection. Fee switch on: today's way (desk converts and bills).
2. **Imaging fee switch** (decision 0021's open item): an `imaging` switch on the same Fees screen; off = imaging
   studies at Rs 0 and auto-ordered the same way, ready for the imaging desk to schedule.
3. **Outside-test catalogue:** a list of other diagnostics (ECG, 2D echo, TMT, PFT, EEG, NCV, endoscopy, colonoscopy,
   Holter, audiometry ...) each a tariff service marked "done outside". Doctor picks them like any test; the slip
   prints them under "Tests to be done outside"; no order, no bill. When the hospital starts one, the admin flips it
   to "in hospital" with a department.
4. **One ordering seam:** a server function + API that takes (visit/episode no., tests, ordering doctor) and routes each
   test to lab, imaging or outside by catalogue id; works for any registered episode series, so IPD/ER screens only
   call it. A reusable web test picker (search, department tag) for those screens.
5. New decision record 0065 for 1-3.

## Done means
- Lab switch off: doctor advises CBC + LFT, completes consult; lab desk shows both as ordered, Rs 0; staff cancels LFT,
  adds TSH, collects. Switch on: nothing auto-ordered.
- Imaging switch off: advised chest X-ray appears on the imaging worklist without a bill.
- ECG advised: prints under "Tests to be done outside"; no order created.
- Seam test: a fake "I" (IPD) episode series registers and orders a CBC through the seam.
- Suites green under the lock; walked on staging.

## Questions for the owner
1. Add an Imaging Free switch too (item 2)? Today only lab and OPD consult have one.
2. Auto-order at "Complete consult" (not on every save)? Recommended.
3. Outside list: start with the 10 above, admin adds more? Recommended.
