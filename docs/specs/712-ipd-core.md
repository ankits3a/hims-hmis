---
issue: 712
status: approved
approved: 2026-10-19
---
# SPEC — IPD core (Phase 1 of the hospital OS blueprint)

Status: APPROVED by the owner 2026-10-19.
v2: owner ruled "whatever the top hospitals practice is my answer" for the five questions, and asked for
deeper edge cases. Answers are in §2 (DECIDED). Edge cases are per lane in §4.
v3: owner asked to design the module from a 15-year lens (an era of advanced AI) with top-notch, fluid UX.
New: §0 the lens, §0A principles, §0B truth / intents / surfaces, §4.9 surfaces with time budgets,
§4.10 AI-era and UX edge cases, §4.11 autonomy ladder, UX checks in §6. Lanes re-cut from 8 to 10 (§3).
Companion modules built in parallel (housekeeping, BMW, linen, transport, diet, passes, maintenance, shared
task engine): SPEC-ipd-companions-2026-10-12.md.
Visual board (owner-facing mockups, 7 boards): https://claude.ai/artifact/RPjXNBUaRqcq2867MUwM77

## 0. The 15-year lens (2026 → 2041)

What hospital software becomes in an era of advanced AI:

1. **Input costs almost nothing.** Speech, cameras, wearables and smart devices capture most data. Forms
   fade; the system asks only what it cannot know.
2. **Software becomes a colleague.** Agents run routine work end to end (bed matching, paperwork, billing,
   claims, supplies). People handle judgement, touch, exceptions and accountability. The interface moves
   from "doing" to "deciding and supervising": proposals, exceptions, approvals.
3. **Views are composed per person per moment.** No fixed menus; the night nurse with a deteriorating
   patient sees a different screen from the day clerk. Composition must stay inside safe, tested parts.
4. **Monitoring is continuous.** Wireless patches report every minute; rounds become reviewing what
   changed; early warning comes hours earlier.
5. **Agents talk to agents.** The patient's own assistant (with ABDM consent) books, asks and pays; insurer
   systems decide in minutes. Every hospital act must be callable by a machine, with consent and limits.
6. **Proof becomes the scarce good.** When machines write most text, value moves to provenance: who or
   what produced each fact, from which source, checkable by anyone allowed.
7. **Rules on clinical AI tighten.** Regulators and courts will ask what the AI suggested, what the human
   did, and why. Suggestions, acceptances and overrides must be logged.
8. **Machines carry things.** Robots move medicines, samples and linen; beds and rooms report their own
   state. Tasks must be addressable to a person or a machine alike.

What does not change: a named human is accountable for every clinical act; families want two answers —
"how is my patient" and "how much"; wrong patient, wrong drug and wrong dose still kill; power, networks
and AI still fail and the hospital must run on paper for a night; money must reconcile to the paisa;
trust is earned by being right, quietly, many times.

So IPD is built in three layers with different lifespans:

| Layer | Lifespan | What it is |
| --- | --- | --- |
| **Truth** | 15+ years | The live model of every bed, admission, order, dose, observation and charge, as events with provenance. Every future AI reads it. Never thrown away. |
| **Intents** | 10+ years | Every act is one module function with a zod contract (packages/contracts), exposed over HTTP and declared as a copilot tool on the manifest. Screens, voice, copilot, devices, robots and later outside agents call the same function. It re-checks permission and state every time and refuses with a reason and a fix. |
| **Surfaces** | 2–4 years | Screens, cards, voice, messages, prints. Calm and exception-first now; replaceable by composed or generated views later without touching truth or intents. |

**Rule: no rule lives only in a screen.** A screen that enforces something its intent does not is a defect;
the acceptance tests call intents, not screens.

## 0A. Design principles (each one testable)

1. **Ask only what the system cannot know.** Every input in §4 names its source (scan, record, device,
   voice, earlier admission); typing is the fallback. A planned admission from OPD advice needs no free
   typing.
2. **Show what needs me now; keep normal quiet.** Every surface opens on its "Now" cards (the existing desk
   provider bands `now` / `today`); a stable patient makes no alert and no badge.
3. **Prepare the next step before it is asked.** Bed proposals exist before the desk asks; the discharge
   summary draft exists the moment fit is declared; tomorrow's likely discharges are listed for the
   evening huddle.
4. **One identity header everywhere.** Photo, name, age and sex, UHID, bed, alert chips — the same layout
   on every surface, proposal card and print. Similar names on one ward carry "Name alert" on both.
5. **No dead ends.** Every refusal names the rule and offers the fix as a button.
6. **Every AI word is traceable.** Numbers, drug names, doses, dates and results are rendered from records,
   never written by a model; model text only joins them. Every line carries a source chip that opens its
   source. Every datum shows its provenance: person, device, copilot draft, agent or import.
7. **Clocks where time matters.** Waits, due doses, handovers and discharge steps show live countdowns; a
   breached clock becomes a task with an owner, not just a colour.
8. **Time and tap budgets are requirements** (§4.9), measured in production from events and reported
   weekly.
9. **Works wherever it is used:** desktop and wall screens are 16:9 (owner, 2026-10-12): design for 1920 × 1080,
   test down to 1366 × 768, and fit command boards (Beds, Ward, supervisor boards) without vertical scroll;
   one-handed at 390 px with gloves (48 px targets, actions in the thumb zone); wall display (no names); and
   paper (every surface has a print view for downtime).
10. **Hindi and English everywhere; voice where hands are busy.** Phone notices are a few words on one line
    (owner rule). Ward surfaces switch to night mode from 22:00 to 06:00. Colour never carries meaning
    alone: every colour comes with a word or a shape.

## 0B. Truth, intents and surfaces for IPD

**Admission workflow states:** requested → reserved → admitted → (transferring) → fit_declared →
discharging → discharged | lama | absconded | deceased | transferred_out; requested or reserved →
cancelled. One workflow instance per admission (spec v4.6 §10.2), mirrored by the module.

**Intent catalogue** (each declares allowed actors — role, copilot proposal yes/no, agent tier, device,
outside agent later — preconditions, refusal codes with fixes, events, and undo kind: undo window,
reversal line, entered-in-error, or irreversible):
request_admission · reserve_bed · release_reservation · admit · assign_bed · print_band · reprint_band ·
record_payer_auth · take_deposit (billing) · start_transfer · accept_handover · swap_beds · change_class ·
block_bed · unblock_bed · mark_bed_clean · record_nursing_assessment · record_vitals · raise_task ·
complete_task · sign_round · place_ip_order · verify_order · issue_med · administer_dose · hold_dose ·
refuse_dose · record_infusion_event · declare_fit · cancel_fit · confirm_charges · sign_summary ·
settle_final_bill · issue_gate_pass · scan_gate_pass · record_lama · record_abscond · record_death.

**Provenance:** every observation, note and document carries its source (person, device, copilot_draft,
agent, import) and actor. A draft shows "Draft" until a named person signs it.

**Now cards:** IPD declares desk providers on its manifest (existing `kernel/desk` seam), typed cards:
due_dose, overdue_vitals, new_order, ews_rising, handover_pending, assessment_due, bed_proposal,
discharge_blocked, deposit_low, cleaning_overdue. Ranking is deterministic rules today; the same API can be
ranked by a model later.

**Live:** every surface subscribes through `kernel/realtime`. A surface that loses connection says
"Offline · last update 14:02" within 5 seconds and never shows stale data as live.

**Offline:** phones queue only safe, append-only entries (vitals, notes, task completions) for up to 30
minutes, stamped with the time they happened. Doses, orders and bed acts are never queued: offline, "Give"
is disabled with "No network — use paper MAR".
Sources: blueprint doc https://claude.ai/code/artifact/f9a50580-20ba-4141-a623-1abf9943e616, spec v4.6
§11.2, §11.4 maps 3–9/11/12, §11.18; decisions 0058 (no money on doctor screens), 0067 (ordering door),
0069 (confirmed copilot acts). Issue #712, milestone "IPD core".

## 1. What it is

Admit a patient to a bed, run the stay, bill it as it happens, discharge in under 3 hours. Reuses:
resource registry (floor → ward/hall → room → bed, statuses available/occupied/cleaning/blocked/retired),
billing advances (`advanceOf`), OT's discharge-bill pattern (`composeDischargeBill`/`settleDischargeBill`),
`patient_coverages`, the ordering door, the copilot harness. Today the incumbent HMIS does IPD; OT day-care
conversions are handed to it (`daycare.converted_to_admission`).

## 2. Owner's five answers — DECIDED by top-hospital practice

1. **Cutover.** Corporate go-lives cut ADT and IPD billing over hospital-wide on one date, then roll the
   clinical record ward by ward. A split where one patient's stay lives in two systems is the failure they
   all avoid. So: lanes 1–4 and 7 (beds, admission, bill, transfer, discharge) go live for every ward on one
   cutover date, after a one-week rehearsal on staging with real staff. Patients already admitted on that
   date finish their stay in the incumbent; their beds show on our board as "occupied — incumbent". Every
   new admission from that date is ours. Nursing and eMAR (lanes 5–6) then roll out ward by ward, starting
   with one adult general ward; ICU goes last, after device feeds.
2. **Rates.** The starting rate card is the incumbent's current IPD tariff, carried over line by line and
   reviewed by the owner in the tariff screen. Go-live is blocked until every bed class has a room rent,
   nursing charge and doctor-visit fee. Standard structure: per day by bed class — room rent, nursing
   charge, RMO charge; consultant visit fee per consultant per day (first visit charged, same-day repeats
   free); cross-consultation per visit; ICU and HDU as their own classes.
3. **Deposit.** Estimate-based, as corporate hospitals do: medical admission = 3 days of estimated class
   charges; planned surgery = 50 % of the procedure estimate or package; ICU = 3 ICU days. Top-up alert at
   75 % used, management escalation at 90 %, ICU burn rate recalculated daily. No deposit before an
   emergency is stabilised. PM-JAY and state-scheme patients pay nothing, ever. Cashless-insured patients
   pay a small deposit for non-payable items only (configurable per class). All amounts are configuration.
4. **Wristbands.** Thermal wristband printers (barcode + QR) at every admitting point: main admission desk,
   ER, labour room, NICU, day care. Nursing stations reprint a damaged band on the nearest one. Bands are
   white for everyone; alerts ride as a coloured clip or sticker (allergy red, fall risk yellow) and are
   also on the band in words, because colour alone is not an identifier. Adult, paediatric and neonatal
   band sizes.
5. **Insured and scheme patients before Phase 3.** Admitted with their payer and a manual authorisation
   record: pre-auth number, status, approved amount, each enhancement, final approval. The bill then splits
   into payer-payable and patient-payable (non-payables, co-pay, room-rent-cap deduction). Claims are still
   filed on insurer and scheme portals by the TPA desk. Phase 3 automates the portal work.

## 3. Lanes, in merge order (one migration each, numbered at merge)

| # | Lane | Builds | Surfaces (§4.9) |
| --- | --- | --- | --- |
| 1 | **ipd-beds** | Bed attributes, rules, board, reservations, blocks, cleaning | A Beds |
| 2 | **ipd-admit** | Admission, payer and authorisation record, deposit, bed assignment, consent, wristband | B Admit |
| 3 | **ipd-charges** | Running bill, nightly rent, visits, deposit ladder, payer split, interim bill | H Bill desk |
| 4 | **ipd-transfer** | Moves, handover accept, class change, bed swap | C Ward, D My shift |
| 5 | **ipd-nursing** | Nursing admission, vitals and early-warning scores, notes, tasks, intake-output, night mode | C Ward, D My shift |
| 6 | **ipd-rounds** | Doctor's inpatient list, round sign (visit charge), inpatient orders through the ordering door, fit for discharge | E Rounds |
| 7 | **ipd-emar** | Pharmacist verify, issue with patient labels, bedside scan, give, infusions | D My shift |
| 8 | **ipd-discharge** | Cascade, summary sign, final bill, gate pass, LAMA, abscond, death | F Discharge tracker |
| 9 | **ipd-copilot** | Now cards ranking, Bed Flow proposals, "since yesterday", SBAR draft, Discharge Drafter | A, B, C, D, E |
| 10 | **ipd-family** | Attendant link with OTP, daily totals, condition word, discharge tracker, questions | G Family |

## 4. Lanes in depth: flow, rules, edge cases

### 4.1 ipd-beds

Rules
- Bed attributes: class, gender rule (male / female / any / paediatric), isolation type it supports
  (none / contact / droplet / airborne — airborne needs a negative-pressure room), ICU flag, equipment tags
  (monitor, ventilator-ready, oxygen point), day-care flag (not in the IP census).
- Shared rooms: an empty twin-share room is "any"; its first occupant fixes the room's gender until empty.
  General halls are segregated by bay.
- Board: floor → ward → room → bed with live counts by class and status; names never on public displays;
  sealed and VIP patients shown by alias.
- Reserve a bed for 2 hours; it lapses back automatically. Block only an available or cleaning bed, with a
  reason and expected return.

Edge cases
- Two desks pick the same bed at the same moment: one wins; the other gets "bed just taken" and the next
  three rule-valid beds.
- Maintenance on an occupied bed: a request, not a block; the block applies on release.
- Surge: overflow beds (extra bed, corridor trolley) exist as a flagged class; counted separately in the
  census; never shown as normal capacity; each needs duty-manager approval.
- Rooming-in newborn: a cot on the mother's bed, not a bed; NICU baby gets a bed.
- Transgender patient: placed by the patient's stated preference, single room when available; recorded,
  not displayed.
- Bed on home leave (patient away overnight): stays occupied, still in the midnight census.
- Midnight census is the occupancy truth; a report after midnight uses it, not the live board.
- A bed retired while reserved: refused until the reservation lapses or is cancelled.
- Incumbent-occupied beds at cutover: shown occupied, released by a tap when the incumbent discharges.

### 4.2 ipd-admit

Flow: admission advice (OPD, OT day-care conversion, direct; ER in Phase 2) → estimate by class and payer →
payer and authorisation record → deposit receipt (or exempt) → bed → general consent → wristband → nursing
told → admission is an encounter of kind `ip`.

Rules
- One open admission per patient. A second is refused and shows the open one.
- Admitting consultant and unit from the roster; consultant on leave → covering consultant, shown.
- ICU admission needs an intensivist's approval in the system; a clerk alone cannot.
- Admission advice expires after 24 hours (planned date + 24 h for future bookings); expiry refunds nothing
  automatically — the advance stays on account until refunded at the desk.
- Bed class booked full → temporary higher class at the booked tariff for 48 hours, auto-move task when the
  booked class frees; declining the move ends protection from the next day.
- Pre-auth approved after admission covers from the admission date (insurer practice). Pre-auth denied →
  cash from admission; the patient signs at admission that cashless is provisional. Any other payer change
  is forward-only and needs signed counselling.

Edge cases
- Unknown patient (temporary UHID) admitted; later merge carries the admission, bill and band reprint.
- Minor: guardian consents; unaccompanied minor → social worker task, MLC check.
- Patient without capacity: nominated representative signs, reason recorded.
- MLC flag carries from OPD or OT; police intimation record created if not already present.
- Readmission within 30 days: flagged with relatedness prompt for the consultant.
- Patient still admitted in the incumbent: refused with "finish the incumbent stay first".
- Deposit paid by a relative: receipt names the payer; refund goes back to that payer.
- Cash deposit at or over ₹2 lakh in a day: blocked by the existing cash law; other tenders offered.
- PM-JAY or scheme admission: every receipt screen refuses money except a line the approver marks
  non-covered with reason.
- Band: damaged → reprint, old voided; allergy added → reprint; patient refuses band → recorded, ankle band
  or photo check used; burns or amputation → ankle band; newborn → mother's name + baby's UHID, paired band.
- Admission during downtime: paper form with a reserved serial; backfilled with real times; the bed board
  reconciles.

### 4.3 ipd-charges

Rules
- Tariff locked at admission; a regulated price (NPPA) that is lower always wins.
- Day rule: one room-rent day per calendar day of stay. Discharge day is free if the patient leaves by
  12 noon + 2 hours grace. A day is billed at the highest class held for more than 1 hour that day; a bed
  held under 1 hour is transit and not billed. A protected higher-class bed bills at the booked class.
- Nightly job posts rent, nursing and RMO charges once per admission per day; a rerun posts nothing new; a
  missed night (server down) is caught up with the right service dates.
- Consultant visit posts from the doctor's own "seen" tap on rounds, never typed by billing. Doctor sees no
  money. Residents' visits are not charged.
- Pharmacy issue posts on issue, credits on return; patient's own medicines post nothing.
- Ward consumables post by scan from ward stock to the patient.
- Every posted line names its source event; a reversal is a new line with a reason, never an edit.
- GST: room rent above the GST threshold per day in non-ICU rooms is taxed as law says; ICU rooms are exempt.
- Interim bill on screen any time; totals only by WhatsApp to the registered attendant daily (no line items
  by message: line items can reveal a diagnosis). Line items at the desk or behind an OTP link.
- Deposit ladder: 75 % alert to desk and unit billing officer; 90 % to management; never to a doctor.
  Care never stops for money.
- Payer split: each line is payer-payable or patient-payable from the authorisation record, non-payables
  list and room-rent cap; the cap's proportional deduction is computed and shown.

Edge cases
- Charge posted to the wrong patient: reversal + repost, both audited; after final bill → credit note.
- Package admission: inclusions absorbed, exclusions billed outside; stay beyond package days → per-day
  charges after, with the overrun projected and consented before it accrues.
- Class change mid-day: highest-class rule handles it; the bill shows the hour of each move.
- Patient on home leave: rent continues (bed retained).
- Price change in the tariff during a stay: no effect on the locked admission.
- Insurer approves less than the bill: difference moves to patient-payable with a reason line.
- Room-rent cap warning shown before any upgrade consent.

### 4.4 ipd-transfer

Rules
- A transfer is complete only when the receiving nurse accepts the SBAR handover; until then the sending
  ward stays responsible; no acceptance in 30 minutes escalates.
- Origin bed released to cleaning only on acceptance (no "patient in limbo with no bed").
- Ward bed kept while the patient is in OT, imaging or dialysis; released only on a transfer decision
  (post-op ICU). Bed kept is billed as normally.
- Swap of two patients (gender or isolation fix) is one atomic act.
- Class upgrade or downgrade on request: consent, effective next noon. A clinical move (ward to ICU) needs
  no consent for class and bills by the day rule.

Edge cases
- ICU full: waitlist by priority; step-down of the most stable ICU patient proposed to the intensivist.
- Isolation flag set after admission: move to an isolation-capable bed proposed; until moved, the bed shows
  isolation and passes tighten.
- Transfer during downtime: paper handover, backfilled.
- Consultant change (not bed): handover note required; billing and payouts split at that moment.
- Refer-out to another hospital is a discharge type, not a transfer.

### 4.5 ipd-nursing

Rules
- Nursing admission within 1 hour: vitals, Morse fall risk, Braden pressure-injury risk, nutrition screen,
  allergy check, home medicines list, pain score, existing pressure injuries photographed and marked
  "present on admission".
- Early-warning score by patient type: NEWS2 for adults; MEOWS for pregnant and post-partum women; PEWS
  for children. Trigger thresholds per score alert the duty doctor once per breach with patient and bed.
- Vitals frequency set by the doctor or by score band; a missed set becomes a task.
- Values outside physiological limits ask "confirm" (typo guard); never silently saved.
- Shared ward terminals: personal PIN or badge switch; no shared accounts.
- Late entries dual-stamped (when it happened, when it was typed) and flagged.

Edge cases
- Fall: incident report drafted automatically, reassessment task.
- Restraint or suicide watch: doctor's order with an end time; renewal required; checks every 15 minutes
  as tasks.
- Patient refuses observations: recorded as refused, not missing.
- Nurse-to-patient ratio below the ward's floor: shown to the nursing supervisor.

### 4.5A ipd-rounds

Rules
- The doctor's inpatient list: own unit's patients plus patients they are consulted on; boarded patients on
  other wards are included and marked with their ward.
- Sign round records the visit; one chargeable visit per consultant per patient per day; residents' and
  interns' entries are drafts until the consultant co-signs; no money is shown (0058).
- Orders go through the ordering door; inpatient drug orders carry dose, route, frequency, duration and
  start time; a stop date is required for antibiotics.
- "Fit for discharge today / tomorrow" sets the discharge clock and wakes the cascade.

Edge cases
- No consultant round by 14:00 on a weekday: one nudge to the consultant, then the unit head.
- Round from outside the hospital (phone review): recorded as "remote review", not a chargeable visit
  unless the owner's tariff says so.
- Order placed for the wrong patient: cancel with reason before issue; after issue, return and credit.
- Fit cancelled after the cascade started: every unsigned step stops; returned medicines are re-issued on
  a new order.
- Doctor on leave with patients still admitted: the roster's covering consultant gets the list at 08:00.

### 4.6 ipd-emar

Rules
- Doctor's inpatient order → pharmacist verify (allergy, interaction, dose, duplicate) → issue → bedside
  scan of wristband and the drug's label → give, hold, miss or refuse with a reason.
- Indian strips often carry no barcode: pharmacy prints a patient-specific label (QR, drug, dose, UHID) for
  every issued unit or strip. The bedside scan reads that label.
- Due window ±1 hour; time-critical drugs (antibiotics, insulin, anti-epileptics, Parkinson's) ±30 min.
- High-alert drugs (insulin, heparin, potassium chloride, opioids, chemotherapy) need a second nurse's PIN.
- Weight required before any weight-based dose; children always weight-based.
- PRN: minimum interval and 24-hour maximum enforced.
- Infusions: start, rate change, stop, each recorded.
- Verbal order only in an emergency: nurse reads back, records; doctor signs within 24 hours; never for
  chemotherapy or high-alert drugs.

Edge cases
- Wristband will not scan: reprint; override only with reason, counted per nurse and ward.
- Patient NPO or off the ward at dose time: hold with reason; the dose re-offers when the patient returns.
- Order stopped after issue: future doses cancelled; stock returned to pharmacy with credit.
- Allergy added later: every active order re-checked; conflicts alert the doctor and pharmacist.
- Look-alike, sound-alike pairs: tall-man lettering and a confirm step.
- Narcotics: ward register, wastage witnessed by a second nurse.
- Patient's own medicines: pharmacist verifies, labels, stores; given through eMAR; not charged.
- Dose given in error: recorded as entered-in-error or medication incident, never deleted.

### 4.7 ipd-discharge

Flow: fit declared (clock starts) → open orders flagged, pharmacy stops → unused medicines returned →
every department confirms no pending charges (silence over 30 minutes escalates) → summary drafted, doctor
edits and signs → final bill → settle or refund → follow-up booked → gate pass → security scan → bed to
cleaning. Target 3 hours for cash; for cashless, as fast as the insurer's final approval.

Rules
- Summary signed before the patient leaves; a resident's draft needs the consultant's co-sign.
- Pending results (histopathology, cultures) listed on the summary; arrival triggers a recall task.
- Discharge medicines as a prescription; buying from our pharmacy is the patient's choice.
- Nobody is detained for unpaid dues; the balance goes to approval (credit with undertaking) and the
  dues register. A body is never held for money.
- Insurer final approval slower than 3 hours: the patient may leave with an undertaking; the deposit
  covers the gap.

Edge cases
- Patient worsens after fit declared: discharge cancelled, every step undone except signed documents.
- Discharge at night or on a holiday: pharmacy and billing on-duty from the roster; otherwise a provisional
  bill and summary with completion next morning.
- LAMA / DAMA: risks explained, form signed by patient or representative, summary still given.
- Absconded: security search, police if MLC, bill frozen, recovery register.
- Death: certification by a doctor, cause-of-death certificate task, mortuary handover with a two-person
  identity check, bill to next of kin with sensitivity, insurer told.
- Transfer out: stabilisation documented, receiving hospital confirmed, records sent.
- Bill reopened after issue (missed charge): only by a supplementary bill or credit note, audited.
- Gate pass not scanned: shown to security at day end.

### 4.8 ipd-copilot

- Bed Flow: proposes only beds that pass every rule; the bed manager confirms; predicts tomorrow's
  discharges from fit-for-discharge marks for the morning huddle.
- Nurse SBAR draft from the shift's events; the nurse edits and signs.
- Discharge Drafter (T2): structured parts (diagnoses, procedures, results, discharge medicines) come from
  the record, not the model; every medicine in the draft must match an active order or it is flagged;
  free text only summarises the notes; stamped with model id and prompt version. Model down → template
  draft from structured data.
- Bill explanation for the family in plain Hindi, shown to staff who then speak to the family.
- Every proposal card shows patient name, UHID, photo, bed; Confirm is a tap.

### 4.9 Surfaces: what each person sees, and the budget it must meet

Every surface opens on its Now cards, uses the one identity header, works offline as §0B says, and has a
print view. Budgets are medians measured from events in production.

**A. Beds — capacity board** (bed manager, admission desk, nursing supervisor, duty manager, owner;
desktop and wall display)
- Top strip: occupied / total and %, free now by class, cleaning, blocked, discharges today (done /
  expected), waiting for a bed (count, longest wait).
- Left: "Waiting for a bed" — each card: identity header, source (OPD, OT, ER, transfer), need (class,
  gender, isolation, ICU), wait clock, Bed Flow's proposal with its reasons, Confirm.
- Centre: floors → wards → bed tiles by status (occupied, free, cleaning with minutes, blocked, reserved,
  discharging today, incumbent). Drag a waiting patient onto a bed: beds that break a rule dim and say
  why on hover; a valid drop is the same `assign_bed` intent.
- Right: next 24 hours — free beds by hour (predicted discharges vs expected admissions from OT lists,
  OPD advice and ER trend) and blockers (cleaning over 60 min, discharges stuck at a named step).
- Wall mode: no names, initials and bed only, auto-scroll by floor.
- Budget: proposal on screen ≤ 30 s after a request; request → bed median ≤ 30 min.

**B. Admit — one flowing sheet** (admission desk; desktop or tablet)
- Sections fill themselves top to bottom: patient (scan UHID card or Aadhaar QR) → advice (pulled from
  the doctor's admission advice) → payer and estimate (class cards with estimate and deposit side by side;
  room-rent cap warning; scheme shows ₹0 to patient) → bed (top three proposals with reasons) → consent
  (tablet signature or OTP to the attendant, Hindi or English, witness) → deposit (or "exempt: emergency /
  scheme") → one button: "Admit and print band".
- After: band printing, ward nurse told, porter task, family message sent — each shown as a tick.
- Emergency lane: one tap admits with a temporary bed hold; everything else catches up later.
- Budget: planned cash admission with advice ≤ 4 min, ≤ 8 taps, no free typing.

**C. Ward — nurse station** (tablet landscape and ward wall)
- Bed cards in bed order: bed number, identity, consultant, day of stay, alert chips (allergy, fall, isolation,
  DNR, NPO, name alert), early-warning score with trend arrow, next due item with countdown, discharge state.
- Empty beds show "Free · cleaned 10:12", "Cleaning · 34 min", or "Reserved · arriving 11:30".
- "Needs me" order (default above 30 beds): score rising, overdue doses, new orders, assessments due.
- Top bar: nurses on duty and ratio, census, admissions expected, discharges today. Night mode 22:00–06:00.
- Budget: a nurse finds what is overdue on the whole ward in one glance (≤ 3 s, observed in rehearsal).

**D. My shift — nurse phone** (390 px, one hand)
- Header: ward, shift, my patients. Now list in time order: due doses, overdue vitals, new orders,
  assessments, handovers — each with bed, patient and countdown.
- Big Scan button in the thumb zone. Scan wristband → the screen pivots to that patient (full identity
  header, short vibration). Scan the drug label → five checks shown (patient, drug, dose, time, route) →
  Give. High-alert: hold to confirm + second nurse PIN.
- Vitals: type, or hold the mic and say "BP 130 by 80, pulse 92, SpO2 96"; numbers read back large before
  save; score computed at once.
- Handover: "6 patients ready" → each SBAR draft → the next nurse accepts per patient with a swipe.
- Budgets: scan → dose recorded ≤ 15 s; vitals ≤ 20 s typed, ≤ 10 s by voice; handover accept ≤ 60 s per
  patient.

**E. Rounds — doctor phone or tablet**
- My inpatients sorted by need: new critical result, score rising, nurse flag, day-one admissions.
- Patient view opens on "Since yesterday 09:10": four to six lines, each with a source chip (vitals, lab,
  note, eMAR). Example: "Fever settled — max 99.1 °F over 12 readings · vitals". Numbers come from records.
- Plan bar: Continue all · Change a drug · Order a test (ordering door) · Ask a colleague · Voice note ·
  "Fit for discharge: today / tomorrow" (starts discharge prep). Sign round posts the visit, silently.
- No money anywhere (0058).
- Budget: "since yesterday" loads ≤ 1 s; a stable patient's round ≤ 60 s.

**F. Discharge tracker** (staff and family)
- Steps with live state and an ETA: fit declared → medicines returned → charges confirmed (each
  department) → summary signed → bill ready → paid or approved → gate pass.
- The blocked step names who it waits for; staff can nudge with one tap.
- Family view: same steps in Hindi or English, no staff names, "What you need to do", expected time out.
- Budget: fit → exit median ≤ 3 h for cash.

**G. Family — WhatsApp and link** (registered attendant, OTP)
- Daily message, one line: patient, ward, day, today's total, deposit left, visiting hours.
- Link page: condition word set by the doctor (stable / improving / under close watch — never written by
  AI), bill with lines, discharge tracker, "Ask": billing questions answered by the copilot; clinical
  questions become a callback request to the nurse in charge.
- Off for sealed, VIP-protected, psychiatric, HIV, MTP, POCSO and MLC-restricted admissions.

**H. Bill desk** (billing and TPA)
- Exceptions only: deposit below 25 % left, payer split changes, authorisations waiting, enhancements due,
  discharges waiting for the bill. A normal running bill makes no card.

### 4.10 AI-era and UX edge cases

1. A proposal goes stale (bed taken, patient moved): the card withdraws itself and says why, with new options.
2. A person and an agent act on the same thing at once: the intent re-checks at confirm (copilot E0.2);
   the loser gets a plain refusal with the fix.
3. A wall display runs for days: heartbeat; "Offline" within 5 s; never names; layout shifts slightly
   every hour so nothing burns in.
4. Voice mishears a number: a dose is never taken from voice for a high-alert drug; every spoken number is
   read back large before save; values outside physiological limits ask to confirm.
5. Noisy ward, or Bhojpuri, Maithili, Magahi speech: the screen shows what it heard; words below the
   confidence line are not filled; tap entry is always there.
6. Similar names or twins on one ward: "Name alert" on both, UHID shown large, scan required for doses.
7. In a shared room the nurse scans the neighbour's band: the screen pivots to the scanned patient with
   a full identity header and a vibration; it never keeps the previous patient silently.
8. Administration interrupted: an unfinished give expires after 5 minutes without recording; coming back
   shows "Not given — scan again".
9. Retried request on a flaky network: every intent carries an idempotency key; a retried give records once.
10. Lost phone: registered devices only, PIN to open, remote sign-out, no patient data kept past the shift.
11. Shared nurse-station terminal: badge or PIN switch, lock after 2 minutes idle.
12. Alert fatigue: one alert per breach per patient; repeats only on worsening; every acknowledgement names
    who; unacknowledged over 10 minutes goes to the nursing supervisor.
13. AI summary wrong or stale: each line has its source; a line whose source changed after drafting shows
    "changed since draft"; model down → plain timeline.
14. A family member asks a clinical question in chat: never answered by AI; becomes a callback request.
15. Impostor relative: link works only for the registered attendant phone with OTP; a capable patient can
    change or revoke it.
16. Death: family messages stop at once; bill messages wait for a person to send them; open tasks for the
    patient close; staff see "Deceased — mortuary handover"; the family view shows only a contact line.
17. Absconding: family surface stops; security alerted; bed held until security closes the case.
18. Phone clock wrong: every clock and stamp uses server time.
19. Very long stays (NICU, burns, 90+ days): bill and timeline group by week; "since yesterday" still works.
20. 60-bed hall: ward board virtualised; "Needs me" order by default.
21. Low-literacy staff (ward attendants, housekeeping): icons with Hindi words, voice prompts, photo proof.
22. Colour-blind users: every colour comes with a word or shape.
23. Gloves, wet hands: 48 px targets, hold-to-confirm instead of small checkboxes, scan instead of typing.
24. Older eyes: text scales to 130 % without breaking any layout.
25. Device and manual readings at the same minute: both kept with source; the score uses the latest
    confirmed one.
26. A looping agent: at most 3 open proposals per patient per agent; the harness halts it beyond that.
27. Downtime: every surface prints (ward census with doses due in the next 4 hours, MAR sheets, bed board);
    recovery back-fills with real times.
28. Cutover night: admissions started before midnight in the incumbent finish there; any after are ours.
29. Discharge summary language: clinical part in English; patient instructions in Hindi and English.
30. Night mode never applies to prints or to the family view.

### 4.11 Autonomy ladder for IPD

| Job | Today | Can climb to | Gate for climbing | Never |
| --- | --- | --- | --- | --- |
| Bed match, routine adult ward | T2: proposes, bed manager confirms | T4 for routine ward beds | 4 weeks with ≥ 95 % accepted unchanged and zero rule breaches; owner approves | ICU, isolation, paediatric, MLC, VIP beds |
| Discharge prediction | T0: shows likely discharges | T1: nudges the team | Prediction within ±1 day for 80 % over 4 weeks | — |
| SBAR handover | T2 draft | stays T2 | — | Auto-accept |
| Discharge summary | T2 draft | stays T2 | — | Auto-sign |
| Deposit reminders to family | T1 | stays T1 | — | Threats or detention language |
| Nightly room charges | Automation (rules) | — | — | Model-decided charges |
| Doses and orders | None | None | — | Ever |

## 5. Out of scope (later phases)

TPA, PM-JAY and scheme portal automation (Phase 3), ER screens and disaster mode (Phase 2), ICU device
feeds (Phase 2), diet orders to kitchen, attendant passes, housekeeping dispatch (Phase 4), blood
transfusion chain (blood bank, Phase 2), antibiotic stewardship approvals (Phase 5).

## 6. Done means (acceptance checks)

Beds
- [ ] A female-only bed refuses a male patient; the refusal names the rule.
- [ ] Two simultaneous assignments of one bed: exactly one succeeds.
- [ ] A reserved bed returns to available after 2 hours if unused.
Admission
- [ ] A second open admission for the same patient is refused and shows the first.
- [ ] ICU admission without an intensivist's approval is refused.
- [ ] A PM-JAY admission refuses a receipt unless a line is marked non-covered by an approver.
- [ ] Pre-auth approved on day 2 makes day-1 charges payer-payable; denial makes them patient-payable.
Bill
- [ ] Admitted 23:00 general, moved to private 10:00 next day, discharged 13:30 the day after: billed
      day 1 general, day 2 private, discharge day free (inside grace).
- [ ] The nightly job run twice posts once; a skipped night is caught up with the right dates.
- [ ] Deposit alerts at 75 % and 90 % fire once each, never to a doctor.
- [ ] No doctor screen or doctor phone view shows any money.
Transfer
- [ ] The origin bed stays occupied until the receiving nurse accepts; no acceptance in 30 min escalates.
- [ ] A swap of two patients leaves both bed states consistent even if one write fails.
Nursing and eMAR
- [ ] A pregnant patient gets MEOWS, a child PEWS, an adult NEWS2.
- [ ] A dose cannot be recorded as given without a wristband scan or a reasoned override.
- [ ] A high-alert dose needs a second nurse's PIN.
- [ ] A PRN dose inside its minimum interval is refused.
Discharge
- [ ] Discharge cannot complete while any department has not confirmed charges.
- [ ] The summary draft carries model id and prompt version; the signed copy names the doctor.
- [ ] A patient with unpaid dues can still be discharged through the approval path.
Cutover
- [ ] On the cutover date every new admission is ours; incumbent-occupied beds show and release correctly.
- [ ] Rehearsal week on staging passes with zero unbilled issued items in the variance report.
Architecture
- [ ] Every intent in §0B is one module function with a zod contract; its acceptance test calls the
      intent, not a screen; a copilot proposal for it runs the same function.
- [ ] A rule check removed from a screen still refuses through the intent (tested per rule).
- [ ] An AI line in "since yesterday" whose number differs from its source record fails the test suite.
Experience (measured in the rehearsal week and then weekly in production)
- [ ] Planned cash admission with advice: median ≤ 4 min, ≤ 8 taps, no free typing.
- [ ] Bed proposal visible ≤ 30 s after the request.
- [ ] Scan → dose recorded: median ≤ 15 s. Vitals: ≤ 20 s typed, ≤ 10 s by voice.
- [ ] Five ward nurses each complete scan-and-give, vitals and handover first time, unaided (observed).
- [ ] Every surface shows "Offline" within 5 s of losing connection, and every surface prints.
- [ ] Every screen passes at 390 px with text at 130 %; no colour carries meaning alone.
- [ ] Zero wrong-patient acts.
