---
issue: 687
status: built
approved: 2026-10-11
---
# Spec: lab desk, from picking the patient to the sample (owner 2026-10-11) — APPROVED 2026-10-11

**Goal.** After the clerk taps "This is them", the desk says plainly what this person has (or doesn't),
offers the next step as one big choice, and gets a free test to the collection chair with no billing step.

**Flow**
1. **Patient picked → summary panel** (paper-and-pine, like /counter):
   - Today: "Tests advised by Dr X" (from today's consult), or **"No test assigned today"**.
   - **History**: past lab reports (date, tests, ready/printed; tap to open the report) and
     **open items** (orders placed but not reported, bookings not yet done).
   - Two big buttons: **New walk-in** · **Future appointment**. If today's consult advised tests,
     a third, first button: **Order the advised tests**.
2. **New walk-in → test picker screen**: one search box ("CBC", "sugar", "thyroid"), common tests
   as tap-chips, the chosen tests as a basket with tube colour; a panel opens to show its parameters
   (Hb, WBC, platelets…). Tests are ordered as tests/panels; parameters are shown, not ordered one by one.
3. **Lab fee Free** (Billing office → Fees → Lab off): the money step is skipped. Pressing **Send to
   collection** creates the visit (V-number) and the order (L-number) in one step; a ₹0 bill is still
   recorded silently (decision 0021). The confirmation shows "Order L… · Visit V… · sent to sample
   collection" and the patient appears on the collection list. Fee charged: today's price-and-pay step, unchanged.
4. **Future appointment = date + time slots** (owner's answer): the clerk picks a date, then a free slot,
   then the tests (same picker). The booking is listed on that day's lab desk list and in the patient's
   history as open; on the day, **Arrived** turns it into the order in one tap (free → straight to
   collection, charged → the usual pay step). Cancel and no-show are recorded, never deleted.
   DECIDED defaults until the lab sets its own: slots 07:30–12:30 every day except Sunday, 15 minutes each,
   4 patients per slot, bookable up to 30 days ahead.

**DECIDED (standard practice)**
- Lab desk learns the switch state through a new read on its own permission (`lab.desk.operate`), not billing's.
- History uses existing reads `GET /lab/reports/patient/:id` and `GET /lab/desk/orders?patientId=`
  (lab_reception holds both). Results themselves stay behind the report, as today.
- Duplicate-test warning, consent names and the pathologist choice stay, shown inline only when needed.

**Done means**
- Picking a patient with no visit/advice shows "No test assigned today", history, and the two buttons.
- With Lab fee Free, walk-in → pick CBC → Send to collection gives V- and L-numbers with no money screen,
  and the order shows in `/lab/collection` awaiting labels.
- With Lab fee charged, the flow still prices and takes payment exactly as today.
- History lists a past report and an unreported order for a seeded patient.
- A booking for tomorrow 08:00 takes a slot (the 5th booking in that slot is refused), shows in history
  as open, and on its day Arrived creates the order.
- Checked in Chromium at 1440 px and 390 px.
