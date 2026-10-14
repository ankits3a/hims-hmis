---
issue: 642
status: built
approved: 2026-10-11
---
# Spec: the quick lab chain — /lab/counter → /lab/qcollect → /lab/qbench → /lab/qreports (owner 2026-10-11) — APPROVED 2026-10-11

**Goal.** The lab's everyday path in four screens, with /counter's look: find the patient, turn a request
(or a walk-in / booking) into a billed (or free) order, confirm the blood is collected, type results,
print and hand over.

**Screens**
1. **/lab/counter** — like /counter's first screen: one search (name, UHID, mobile, token, V-number,
   live suggestions). Picking the patient opens **two columns**:
   - **Left:** patient (name, age/sex, UHID, guardian, last-4 mobile, today's visit), **credit with the
     hospital**, memberships, **last 3 ordered tests** + **View more**.
   - **Right:** **fresh requests** — tests the OPD doctor advised (IPD/Emergency join when those screens
     exist; the ordering door from PR #576 already accepts them). Pick a request → **bill** it (fee charged)
     or **Send to Sample Collection** (lab fee Free) → order no. + visit no. → straight to /lab/qcollect.
     No request: **New walk-in** · **Future appointment**. Walk-in/booking opens the test form: tests
     already chosen shown as coloured chips (tube colour) + search to add; **Next** → billing (skipped when
     Free) → order → /lab/qcollect.
2. **/lab/qcollect** — the queue of orders waiting for blood. One big **Blood collected** button per
   patient (staff confirm it themselves; no label printing, no tube scan). Collected → a sample number
   is stamped and the patient moves to /lab/qbench.
3. **/lab/qbench** — queue of collected samples; open one → every parameter of its tests, H/L flags
   against the patient's own range, auto summary (editable). **Save draft** · **Save & Complete**.
4. **/lab/qreports** — completed reports: view, **Print & Hand over** (records who/when), **Send back to
   Quick Bench** (becomes a draft again).

**Built on** PR #568 (quick results, ranges, summary, print) and PR #687 (summary, walk-in, free road,
bookings). Both fold into this lane; #568 is closed as superseded. Decision 0061 is updated by a new one.

**Owner's answers (2026-10-11):** no pathologist signature for now (reports print "Quick lab · not signed",
as 0061); Blood collected stamps a **sample number** (the order and V-number are made at billing/send);
keep both paths — the full lab screens stay, `/lab/quick` folds into the new chain.

**Done means**
- Search on /lab/counter → patient → left panel shows credit + last 3 tests (+ View more); right shows
  the OPD doctor's advised tests.
- Fee Free: pick request → Send to Sample Collection → order + visit numbers, no billing screen; patient
  appears on /lab/qcollect. Fee charged: the billing step takes payment first.
- Walk-in: chips + search → Next → (billing) → order → /lab/qcollect.
- Blood collected → patient leaves /lab/qcollect, appears on /lab/qbench with a sample number.
- Save draft keeps values; Save & Complete → report on /lab/qreports; Print & Hand over records the
  hand-over; Send back → draft on /lab/qbench again.
- Checked in Chromium at 1440 px and 390 px.
