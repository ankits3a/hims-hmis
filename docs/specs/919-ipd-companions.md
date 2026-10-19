---
issue: 919
status: approved
approved: 2026-10-19
---
# SPEC — IPD companion modules, built in parallel with IPD core

Status: APPROVED by the owner 2026-10-19.
Refs #712 (milestone "IPD core").
Owner, 2026-10-12: "consider bio-medical waste, housekeeping module in parallel and other small modules that
work hand in hand." Answers not given are DECIDED by top Indian corporate-hospital practice (owner's standing
ruling). Same lens, principles and budgets as the IPD core spec v3 (§0–§0B): truth / intents / surfaces; no rule
lives only in a screen; desktop surfaces are 16:9.

## 1. Which modules, and why these

A ward bed works only when six support services work with it. Each one is a leaf module (safe to own alone),
built in its own lane beside the IPD lanes.

| # | Module (lane) | Hands in hand with IPD at | Merge after |
| --- | --- | --- | --- |
| 0 | **tasks** — shared task engine (P5 task-and-track) | Every service request below | first, before IPD lane 1 |
| 1 | **housekeeping** — bed turnover, cleaning, spills, inspections | bed release → cleaning → available | tasks + ipd-beds |
| 2 | **bmw** — bio-medical waste, ward to treatment facility | every ward, OT, lab, ICU | tasks |
| 3 | **linen** — par stock, soiled and infected linen, laundry count | admission, bed turnover, discharge | tasks |
| 4 | **transport** — porters and patient movement | admit, transfer, imaging, OT, discharge | tasks + ipd-admit |
| 5 | **diet** — doctor's diet order to kitchen meal list | admission, NPO before OT, discharge | ipd-rounds |
| 6 | **passes** — attendant and visitor passes | admission, discharge, death, ICU rules | ipd-admit |
| 7 | **maintenance** — repair tickets for beds, rooms, oxygen points, fixtures | blocked beds | tasks + ipd-beds |

Mortuary (death branch), CSSD and the full kitchen and catering business stay in their later phases; IPD's
death branch hands over to a minimal mortuary register in ipd-discharge.

## 2. tasks — one engine for every service request (new leaf module `tasks`)

- A task: kind, place (resource registry node), patient (optional), priority, due time, required skill, assignee
  (person, team, or later a robot), proof needed (none / tap / photo / scan / weight), verify step (optional).
- States: created → assigned → accepted → in progress → done → verified; any → cancelled with reason;
  escalation ladder per kind (spec v4.6 P5, P7).
- Dispatch: nearest free worker of the right skill on duty from the roster; re-dispatch when not accepted in
  5 minutes; Turnover Dispatcher agent may climb to T4 for routine cleaning (IPD autonomy ladder).
- Worker phone: one list, big buttons (Accept · Start · Done · Photo), Hindi first, icons, voice prompts; works
  for low-literacy staff. Supervisor board (16:9): open tasks by floor, late ones first, worker load.
- Edge cases: worker goes off shift with a task open (returns to the pool, supervisor told); two workers tap
  Accept together (one wins); task for a bed that was re-occupied (auto-cancel); duplicate requests for one
  place within 10 minutes (merged); robot or outside vendor later (assignee kind).

## 3. housekeeping

Flow: bed released (discharge, transfer, death) → cleaning task with type by bed status → clean → photo →
nurse or supervisor verifies → bed `available`. Also scheduled area cleaning, spill response, terminal clean.

Rules (DECIDED, top-hospital practice)
- Cleaning type: routine discharge clean; terminal clean for isolation and infected beds (needs supervisor
  verification, bed stays blocked until verified, IPD §4.10); spill clean (blood, body fluid, chemotherapy, mercury)
  with the matching spill kit.
- Targets: routine bed turnover ≤ 45 min from release to available; terminal ≤ 90 min; spill response
  ≤ 10 min. Clocks visible on the Beds board.
- Scheduled cleaning by area class (critical: ICU, OT, NICU; semi-critical: wards; non-critical: corridors) with
  checklists and frequency.
- Chemical use logged per area (for infection control audit).

Edge cases
- Bed released at night with a thin team: tasks queue by expected admission need (Bed Flow tells which beds
  are needed first).
- Patient arrives before verification: bed cannot be assigned; bed manager sees "cleaning, 12 min left" and
  may pick another.
- Verification failed: task reopens with the photo and reason.
- Isolation organism unknown at discharge: terminal clean by default.
- Housekeeping outsourced to a vendor: same app, vendor staff accounts, vendor TAT report for the contract.

## 4. bmw — bio-medical waste (Bio-Medical Waste Management Rules 2016, as amended)

Flow: ward or department generates waste → colour-coded bag with a barcode label printed at the point of
generation → weighed at the department collection point → internal transport to the central storage room →
handover to the common treatment facility (CBWTF) vehicle with a digital manifest → CBWTF weight received
→ reconciled. Daily register, monthly report, annual report to the pollution control board.

Rules
- Categories and colours per the rules: yellow (anatomical, soiled, chemical, discarded and cytotoxic
  medicines, chemical liquid), red (contaminated recyclable plastics), white translucent puncture-proof
  (sharps), blue (glass, metallic implants). Each bag label: category, department, date and time, weight, bar
  code, generator.
- Untreated waste stored no longer than 48 hours: a clock per bag from generation; alert at 36 hours.
- Pre-treatment of microbiology and blood bank waste on site before handover (autoclave log entry).
- Weighing: a department weight and a central weight; a gap above 5 % flags (DECIDED).
- Segregation audits by the infection control nurse with photos; errors per ward on the quality board.
- Needle-stick and splash injuries: incident with post-exposure prophylaxis task within 2 hours; links to HR
  for the staff health record.
- Training records per staff (yearly); immunisation (hepatitis B) records for handlers.

Edge cases
- Missed CBWTF pickup: storage clock alarms; supervisor logs the vehicle no-show; escalation to admin.
- CBWTF weight differs from ours by more than 5 %: dispute record with both weights.
- Unlabelled bag found: photo, ward traced by location, counted as a segregation error.
- Cytotoxic waste from chemo day care: separate yellow-cytotoxic label and its own count.
- Mercury spill or broken thermometer: spill task plus hazardous log.
- Downtime: pre-printed serial bag labels; back-fill weights.

## 5. linen

- Par stock per ward by bed count and class; daily top-up from the linen store.
- Soiled linen collected in bags; infected linen in a separate marked bag and washed separately.
- Laundry out and in counts per item type; loss and damage variance per ward per week.
- Linen change on every admission and discharge (task from IPD events); daily change per policy.
- Edge cases: shortage on a ward (borrow from another ward with a transfer record); vendor laundry short-delivers
  (variance); condemned linen written off with approval.

## 6. transport — porters and patient movement

- Requests from IPD intents (admit, transfer, imaging, OT, discharge to gate) and by hand; each says
  wheelchair / stretcher / bed, oxygen, monitor, nurse escort needed, isolation precautions.
- Critical patients (score high, on infusions, ICU) need a nurse or doctor escort: the task cannot start without one.
- Handover at destination by scan of the wristband; the IPD transfer is still accepted by the receiving nurse.
- Samples and documents runs use the same engine.
- Edge cases: lift out of service (route note); patient deteriorates on the way (Code Blue from the porter phone);
  oxygen cylinder low at start (check is part of the task).

## 7. diet

- Diet order is an inpatient order from the doctor (normal, diabetic, renal, cardiac, soft, liquid, tube feed,
  NPO with start and end), plus allergies and religious or personal preferences from the record.
- Dietitian assessment for patients flagged by the nursing nutrition screen.
- Kitchen meal list per meal per ward with bed, diet and allergy; tray tags printed; delivery tapped per bed.
- NPO always wins: an NPO order or an OT booking removes the patient from the next meal list.
- Edge cases: patient transferred after the list printed (list updates and the old ward is told); late
  admission (late meal from a small stock); patient refuses meals (recorded, nurse told).

## 8. passes — attendant and visitor passes

- At admission: N attendant passes by bed class (DECIDED: general 1, semi-private 1, private 2, ICU 0 at bedside
  with lounge pass), QR on paper or on the attendant's phone; visitor passes in visiting hours.
- Security scans at ward entry: valid / wrong ward / outside hours, one beep.
- Lost pass: reissue revokes the old one at once. Discharge, transfer out, death or absconding expire all passes.
- Paediatric and maternity: parent-stay pass variant; NICU mother pass linked to the baby.
- Edge cases: sealed or VIP admission (no name on pass, alias); police custody patient (passes only to police
  guard); visitor ban by the doctor (passes paused with reason).

## 9. maintenance

- Ticket from a bed block, a nurse, or a device alarm: place, item, photo, urgency.
- Bed or room blocked until the ticket is closed and the nurse confirms.
- Biomedical equipment tickets route to biomedical engineering (asset register comes later).
- Edge case: repeated faults on one item (3 in 30 days) flag for replacement.

## 10. Surfaces (16:9 on desktop)

- Supervisor boards for housekeeping, BMW, transport and linen: 1920 × 1080 without scrolling; open work by
  floor, late first, clocks visible; wall mode.
- Worker phones: one task list with big buttons, Hindi first, photo and scan in the thumb zone.
- Beds board gains cleaning clocks and blocked-bed ticket state; ward board shows linen and meal state per bed.

## 11. Done means

- [ ] A discharge creates exactly one cleaning task; the bed cannot be assigned until it is verified clean.
- [ ] An isolation bed's release creates a terminal clean that only a supervisor can verify.
- [ ] A waste bag older than 48 hours in storage raises an alert; one at 36 hours warns.
- [ ] A 6 % gap between department and CBWTF weight creates a dispute record.
- [ ] Monthly BMW report and annual Form IV figures come from the bag records with no typing.
- [ ] A transport task for a high-score patient cannot start without an escort.
- [ ] An NPO order removes the patient from the next meal list.
- [ ] Discharge expires every pass of that admission at once.
- [ ] Two workers accepting one task: exactly one gets it.
- [ ] Every supervisor board fits 1920 × 1080 without scrolling; every worker screen works at 390 px.
