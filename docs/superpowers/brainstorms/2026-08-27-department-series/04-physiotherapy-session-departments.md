# 04 — Physiotherapy & Rehabilitation, and the Session-Department pattern — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED.
**Covers:** physiotherapy/rehab (the first instance), and the *generic session-department pattern* it instantiates — dialysis, day-care chemotherapy, speech & occupational therapy, and (later) any "come N times for a course" service line.

**Executive summary.** A session department sells and delivers *courses*: an assessment opens a plan of care, the plan is executed as a calendar of sessions against a prepaid or per-session tariff, the patient is re-assessed at intervals, and the plan is consciously closed. Spec §11.4 map 11 locks the cascade (treatment plan → auto session calendar + reminders → check-in → chair/bed → pre-checks → procedure → observation → same-day discharge; prepaid bundles as entitlement counters; **missed session = clinical alert with recall task, not a no-show**) and §11.19-A locks the dialysis and cancer-floor mechanisms. Plan 09 shipped the entitlement-counter ledger this module *reuses* (it does not rebuild it). Plan 13 shipped the resource registry whose ten kinds already cover every room, chair, machine and gym this module needs — no new kind is proposed. This document is NOT an IPD spec (bedside physio orders consume IPD's order interface when it exists; until then they ride the transition-operations boundary), NOT a pharmacy/LIMS spec (the chemo lab gate and compounding verification are *consumers* of Plans 16/17), and NOT an EMR chart. **Three hardest problems:** (1) money that is prepaid against a course that may be shortened, extended, abandoned, refunded or transferred — every path must end on an append-only ledger line the patient can read; (2) a session that is *missed* is a clinical event, not an appointment event, and the recall machinery must chase it without becoming alarm noise across 200 sessions/day; (3) safety gates that must be hard stops (seropositive machine segregation, pre-chemo counts, pacemaker vs electrotherapy, supervision of students) while never blocking the paper path on a bad day.

---

## 1. Frame — what exists, what is locked, what this document adds

**Locked decisions inherited (not re-litigated):**
- §11.4 map 11 (day-care admissions): the cascade, per-session package rates, prepaid bundles as entitlement counters, missed session = clinical alert + recall task.
- §7: prepaid day-care bundles reuse membership entitlement-counter machinery; billing append-only, corrections are credit notes; refunds to whoever paid, ID + signature, bank transfer above threshold; best-single-benefit no stacking; tariff versioning (admitted patients tariff-locked — a *course* is proposed to lock likewise, see O-3).
- §11.19-A: dialysis — RO water quality as utility telemetry + conductivity/endotoxin register; seropositive machine segregation as a hard assignment rule on the session board; cancer floor — chemo regimen engine (cycles, BSA dosing, **pre-chemo lab hard gate**), tumour board workflow, palliative narcotics on NDPS; physiotherapy — therapy plans as session bundles, therapist worklists.
- §11.8: chemo = high-alert → two-nurse verification at administration + pharmacist compounding verification on the day-care path.
- §11.19-C-13: device-billing reconciliation generalised to every powered modality incl. dialysis (usage events vs billed sessions, both directions).
- §11.19-E E-A-3 / S10 §12.25: chaperone framework — chaperone-required attribute on exam classes, `chaperone.present` as documentation gate, roster gate.
- §11.19-D-31: guardianship model (authority scope, DOB-driven majority transition).
- §10.2/10.3/10.4: every SLA-bearing lifecycle is a workflow definition; SLA structure everywhere, alerts selective; owner activates definitions.
- §16 + roadmap notes 14/15/17: agent tiers, clinical cap T2–T3, reservations are governed state machines with TTL on tentative holds, predictions never hold a resource.
- Plan 13 DD4 (amended): the set of resource kinds is **closed at ten** (floor, ward, hall, room, bed, theatre, store, bench, analyzer, device); modules claim kinds and declare status vocabularies; an eleventh kind is a kernel edit. §4A item 2 RULED: movable assets with a non-occupancy lifecycle are module tables with an FK to a `device`, not kinds.
- Plan 09 (shipped): `membership_plans.kind ∈ {membership, package, card}`, `membership_instances`, `entitlement_counters(instance_id, benefit_key, granted_qty, valid_from, valid_to, state)`, `entitlement_movements` (signed, append-only, `lapsed_restore` flag, FK to invoice line), `consumeEntitlements`/`restoreEntitlements` under `SELECT … FOR UPDATE`; C1–C5 catalogue rows already tested.
- S10 card 30 (Physiotherapist) exists; dialysis/chemo nursing cards do not — proposed in §2.
- Roadmap stage-2 order: 14 → 15 → 16 → 17 → 18 ∥ 19, all after 13. Service-line modules are "sequenced by each floor's commissioning date" (spec §17 item 8). Track B is the Lane-2/Lane-3 conversational-surface pilot cohort.

**Scope boundaries / who owns which table.** `sessions` module (proposed name; folder `apps/core/src/modules/sessions/`) owns: therapy episodes, plans of care, sessions, outcome scores, supervision co-signs, session-department statutory registers, dialysis and chemo specialisations (as sub-folders or sibling modules — see §14). It *references* `patients`, `resources` (registry), `membership_instances`/`entitlement_counters` (Plan 09), `opd_encounters` (referral source), `invoices` (via charge events), `formulary` (drug lines), later `lab_orders` (Plan 17) and `pharmacy` (Plan 16). It never touches those tables directly (law 1). Billing owns money; the module only emits `charge.posted`-bearing events. Nursing eMAR (IPD cluster) owns administration records — the chemo day-care path emits `medication.administered` through the eMAR interface when it exists and through its own day-care administration record until then, with a documented migration.

**What this document adds:** the generic *course* model (episode → plan → sessions → re-assessment → closure) as workflow definitions; the session-board/registry mapping; the money model for courses over Plan 09 counters (validity, carry-forward, refund, transfer, per-session vs package); the safety gates per specialisation; the 100+ edge rows; agents.

---

## 2. Actors, roles & role cards

| # | Role (S10 card / proposed) | Shifts | Stations | Notes |
|---|---|---|---|---|
| 30 | **Physiotherapist** (S10 card 30) | Day 08–20 in two shifts; on-call nights (S10 §10 bundling: physio ← on-call) | Assessment room, cubicles, gym, IPD bedside, ICU | Treats, assesses, scores outcomes, closes plans |
| P1 | **Rehab head / senior physiotherapist** (NEW card) | Day | Department | Approves plan deviations, supervises interns, co-signs student sessions, owns definition drafts, reviews outcome trends, attribution disputes |
| P2 | **Physio intern / student** (NEW card; credential = enrolled, not registered) | Day | Cubicles under supervision | Every session they run is `supervised_by` a card-30/P1 holder; co-sign gate before charge posts (O-6) |
| P3 | **Physio assistant / attendant** | Day | Gym, modality set-up, patient transfer | Sets up modalities, no clinical documentation beyond checklist ticks |
| P4 | **Occupational therapist / Speech-language therapist** (NEW cards, same pattern as 30) | Day | Own rooms | Same episode machinery, different assessment templates and outcome scales |
| P5 | **Session-department coordinator / scheduler** (front-office family, NEW card) | Day | Desk | Books courses, sells bundles, handles reschedules, prints session cards, calls no-shows the Recall automation escalates to a human |
| D1 | **Dialysis nurse** (NEW card, nursing family) | 3 shifts (06–14, 14–22, night for emergency/ICU CRRT support) | Dialysis hall, isolation room | Cannulation, machine pre-checks, on-machine monitoring, two-nurse checks for heparin/EPO |
| D2 | **Dialysis technician** (NEW card) | 3 shifts | Machines, RO plant | Machine set-up, disinfection cycles, water tests, machine logbooks |
| D3 | **Nephrologist** (doctor family) | Rounds + on-call | Hall | Dialysis prescription (Kt/V target, duration, dialysate, heparin, dry weight), monthly review, seropositive assignment authority |
| D4 | **RO plant / biomedical technician** | Day | Plant room | Conductivity/hardness/chlorine daily, endotoxin/microbiology monthly (register) |
| C1 | **Day-care oncology nurse** (NEW card; chemo-competency credential) | Day (day-care hours 08–20) | Chemo chairs | Two-nurse verification, extravasation response, spill response |
| C2 | **Oncology pharmacist** (NEW card; Plan 16 family) | Day | Compounding room / BSC | Compounding verification, dose/BSA check, closed-system transfer |
| C3 | **Medical oncologist** | Rounds | Day-care | Regimen selection, cycle go/no-go against lab gate, dose modification |
| H1 | **Home-care coordinator + home physiotherapist** | Day | Field | Visit routing, geo-stamped visits, consent for home setting |
| — | Duty manager, billing counter, cashier, MRD, quality manager/DPO (card 37), infection-control nurse, biomedical engineer | per S10 | — | Existing cards; touch this module via approvals, charges, registers |

**Agents & automations (all under the 12a harness):** Recall & Follow-up (automation, T1, exists in 12b scope — extended with session scope) · Expiry Watchman (automation, T1 — extended to bundle validity) · **Plan-Adherence Nudger** (automation, T1, NEW) · **Session Slot Packer** (automation/pure-function allocator, T3 behind coordinator confirm, NEW) · **Chemo Gate** (deterministic hard-stop automation, T4-equivalent *refusal* — it blocks a transition, never acts clinically) · **Water-Quality Watcher** (automation, T1) · Leakage Auditor and Fraud Sentinel (T0, extended report classes) · Digest Writer (T0, department lines) · **Therapy Progress Note Drafter** (agent, T2, NEW) · Clinical Context Lens pack `session-daycare` (agent narration, T2). Details in §9.

**SoD hard pairs (added to S10 §11):** student/intern session performer vs co-signer · bundle seller (coordinator) vs refund approver · dialysis machine disinfection recorder vs the nurse who assigns that machine to the next seropositive/negative patient (witness-style) · chemo compounding pharmacist vs administering nurse (structural) · two-nurse verify never the same login (existing) · outcome-score recorder for a discharge vs the therapist whose KPI it feeds — *not* separated (impractical); instead the gaming check in §8.

**Bundling on skeleton shifts:** night — physio on-call only, dialysis reduced to emergency/ICU CRRT support (a nephrologist on the succession chain), chemo day-care closed (an admitted chemo patient is IPD's). A shift running chaperone-required stations (manual therapy on female patients by a male therapist, pelvic-floor rehab) must roster an eligible female staff member (S10 §12.25) — the roster gate applies unchanged.

---

## 3. Core flows as workflow definitions

All are P1 (journey) with P2 (order-to-result) for the referral/order half, P5 for tasks, P6 for charges, P7 for reminders. Every definition is versioned data; SLAs below are recommended defaults; **active alerting at go-live only on: missed-session recall unclosed > 48 h, chemo gate override attempts, seropositive segregation violation, water-quality threshold** (law 7).

### 3.1 Therapy episode (plan of care) — the generic course

```
[referred] --assess--> [assessed] --plan_signed--> [plan_active]
   |                                                   |  (sessions run; every Nth session or T days) 
   |                                                   v
   |<--------------- reassess ------------------ [reassessment_due] --reassessed--> [plan_active] (revised version)
   |                                                   |
   +--no_show_to_assessment(14d)--> [lapsed]           +--goals_met--> [discharge_ready] --closed--> [closed:completed]
                                                       +--patient_stopped/abandoned(3 missed, recall closed)--> [closed:abandoned]
                                                       +--converted (admitted / referred out)--> [closed:converted]
                                                       +--clinician_stopped (adverse event / contraindication)--> [closed:stopped]
```

| State | Allowed roles (transition out) | SLA | Escalation ladder |
|---|---|---|---|
| referred | coordinator books assessment; physio may self-book | assessment booked ≤ 2 working days; IPD bedside ≤ 24 h; ICU chest physio ≤ 4 h from order | coordinator → rehab head → duty manager |
| assessed | physio signs plan (goals, frequency, modalities, expected sessions, re-assessment interval, contraindications, consent set) | plan signed ≤ same day | physio → rehab head |
| plan_active | sessions execute (3.2); plan revisions are versioned rows | re-assessment every N sessions (default 6) or 14 days | Plan-Adherence Nudger → physio → rehab head |
| reassessment_due | physio records scores + revised plan | ≤ 2 sessions | physio → rehab head |
| discharge_ready | physio writes discharge note (scores in/out, home programme) | ≤ 3 days | Nudger → physio |
| closed:* | terminal; re-open = new episode linked `continues_episode_id` | — | — |

**Events:** reuse `referral.issued`, `order.placed (order_type: therapy)` (NEW value in existing family), `consent.recorded`, `chaperone.present`, `patient.recall_initiated`, `task.*`, `sla.breached`. **NEW:** `therapy_plan.opened` · `therapy_plan.revised` · `therapy_plan.reassessed` · `therapy_plan.closed` (payload: outcome `completed|abandoned|converted|stopped`, scores) · `outcome_score.recorded` (scale id, value, instrument version).

**Corporate variants:** (a) *walk-in OPD physio without referral* — allowed for wellness/maintenance classes only, clinical classes require a referral from an in-house or external doctor (O-4); (b) *IPD bedside order* — episode is opened by the order, sessions are `location: bedside`, charge routes to the admission's bill and the tariff lock of admission applies; (c) *ICU protocol order* — chest physio / early mobilisation protocol packs (definition data, Class B) auto-create the session schedule (e.g., 2×/day) with the ICU nurse's worklist consuming the tasks; (d) *ortho post-op protocol* — mini-OT (Plan 15) discharge emits `daycare.discharged` with procedure code; a protocol map (procedure → rehab protocol pack, definition data) opens the episode automatically as `referred` with the surgeon as referrer, day-1 to day-N milestones pre-filled.

### 3.2 Session — one visit inside a plan

```
[scheduled] --check_in--> [checked_in] --start--> [in_progress] --complete--> [completed]
    |                          |                        |
    |                          +--patient_left(>30m)--> [missed:left]   
    +--no_check_in(+15m grace)--> [missed]  (clinical alert + recall task; NOT appointment.no_show)
    +--reschedule--> [scheduled] (new instance, links prior)      +--abandoned(clinical)--> [abandoned] (partial charge rule)
    +--cancelled(by hospital: therapist absent/equipment)--> [cancelled:hospital]  (no counter consume, auto-offer)
```

| State | Roles | SLA | Escalation |
|---|---|---|---|
| scheduled | coordinator / patient self-service (Plan 10 public read surface) / Slot Packer | reminder T-24h & T-2h (P7; quiet hours) | — |
| checked_in | desk scan (QR on session card / UHID) | start ≤ 15 min of slot | therapist → rehab head (batched, not interrupting) |
| in_progress | therapist (or intern + supervisor) | duration per plan; overrun > 50% flags | — |
| completed | therapist signs; charge posts; counter consumes | documentation ≤ 30 min | Nudger |
| missed | Recall automation: WhatsApp → SMS → IVR → call task | recall closed ≤ 48 h (**active alert**) | coordinator → rehab head |

**Events:** reuse `appointment.booked/rescheduled/cancelled` (with `appointment_type: session`), `patient.checked_in`, `vitals.recorded`, `device.usage_started/stopped`, `charge.posted`, `membership.benefit_consumed`, `package.allowance_consumed`, `patient.recall_initiated`, `notification.*`. **NEW:** `session.started` · `session.completed` (payload: plan id, sequence no, modalities, resources used, performer, supervisor, duration) · `session.missed` · `session.abandoned` · `session.cancelled_by_hospital` · `supervision.cosigned`.

**Charge composition rule (P6, corporate standard):** a session charge = base session tariff (per class: physio-standard / physio-advanced / bedside / ICU / group / home) + modality add-ons declared at completion (device-usage events reconcile against them, §11.19-C-13) + consumables scanned. Prepaid bundle: the counter consumes ONE unit per completed session of the bundled benefit key; add-ons outside the bundle post as normal lines (the exclusion list is explicit — map 6). Per-session: line posts to the visit invoice; "pay before treat" is the OPD default, IPD posts to the running bill.

### 3.3 Prepaid course bundle — Plan 09 reuse, not rebuild

A bundle = `membership_plans` row with `kind='package'`, one entitlement `benefit_key` (e.g. `physio.session.standard`), `granted_qty` (6/10/12/20), validity (default 90 days for physio, 45 days for dialysis-12, cycle-bound for chemo), price, and an *exclusions* list. Sale = `membership.sold` + invoice line. Consume = `consumeEntitlements` inside the `session.completed` transaction (same lock, same race semantics — C3). Restore = `restoreEntitlements` on refund/credit note (C1/C2) or on `session.cancelled_by_hospital` if consumed in error. **Expiry** = the counter's `valid_to`; the Expiry Watchman emits `reminder.due` at T-14/T-7/T-1 and `bundle.expired` (NEW, informational) at lapse. **Carry-forward / extension** = `bundle.extended` (NEW) — creates a *new* counter row valued at remaining qty with a new validity (append-only; the old one is voided with a movement naming the successor) behind an approval (coordinator requests, rehab head approves clinically, billing supervisor approves financially above threshold). **Refund of unused** = credit note for `remaining × (bundle price ÷ granted_qty)` minus a policy-configured retention (default: 0 retention if hospital-caused, 10% administrative fee if patient-initiated after ≥1 session, full refund if 0 sessions used — O-1), refund voucher via the approvals engine, restore movement voids the remainder. **Transfer** to another patient: not allowed by default (O-2); family transfer under the same family membership allowed by config.

### 3.4 Dialysis session (specialisation of 3.2)

```
[scheduled] -> [checked_in] -> [pre_checks] -> [on_machine] -> [post_checks] -> [discharged]
                                   |  weight, BP, access site, temp, machine id, disinfection-since-last-use verified,
                                   |  sero-status vs machine class == match (HARD STOP), prescription verified (2 nurses for heparin/EPO)
                                   +--gate_failed--> [held] -> nephrologist decision -> [pre_checks] | [cancelled:clinical] | [converted_to_admission]
```
SLAs: pre_checks ≤ 20 min of check-in; on_machine = prescribed duration ± 15 min (short run must carry a reason code); post-dialysis weight + vitals before discharge; machine disinfection cycle logged before next assignment (**hard**). Events: reuse `vitals.recorded`, `device.usage_started/stopped`, `medication.administered`, `isolation.flagged`, `water_quality.recorded`, `incident.reported`. **NEW:** `dialysis.prescription_recorded` · `machine.disinfected` (machine, cycle type, by whom, duration) · `machine.segregation_violated` (attempt refused — always evented even though blocked) · `access.assessed` (AVF/AVG/catheter status, thrill/bruit) · `dialysis.short_run_recorded`. Charge composition (corporate standard, O-5): session base (machine time + nursing) + dialyser (new vs reuse-count, reuse governed per the hospital's reuse policy and logged per dialyser) + bloodlines + heparin + EPO/iron (from pharmacy stock — Plan 16 issue scan; until then a day-care consumable list) + extra investigations. Bundle of 12 covers the base + standard consumables; EPO is an explicit exclusion by default because its cost varies 10× by brand.

### 3.5 Day-care chemotherapy cycle (specialisation)

```
[cycle_planned] --labs_ordered--> [awaiting_labs] --gate_pass--> [cleared] --compounded(verified)--> [ready]
      --two_nurse_verify--> [administering] --observation--> [discharge_ready] --escort_verified--> [discharged]
[awaiting_labs] --gate_fail (ANC/platelets/creatinine/LFT below regimen thresholds)--> [gate_blocked] --oncologist decision--> [deferred] | [dose_modified → cleared] 
[administering] --extravasation/reaction--> [event_managed] --> observation | converted_to_admission
```
Events: reuse `regimen.cycle_started`, `chemo.gate_blocked`, `result.verified` (Plan 17), `medication.administered`, `adr.reported`, `incident.reported`, `daycare.*`, `escort.verified`. **NEW:** `compounding.verified` (pharmacist, BSA, dose, diluent, stability window) · `extravasation.recorded` (drug, vesicant class, site, antidote used, photo ref) · `spill.recorded` (kit lot, area, staff exposed). The Chemo Gate automation evaluates the regimen's threshold table (definition data, oncologist-owned, MS-activated) against the latest verified results; an override is a **T3-approval by the oncologist with reason**, evented, never silent.

### 3.6 Home physio visit

`[scheduled] → [en_route] → [arrived (geo+time stamp, patient/attendant OTP)] → [in_progress] → [completed (signed on tablet, photo of exercise sheet optional)] | [not_found] | [unsafe_setting → aborted]`. Charge = home tariff class + travel band; consent adds the home-setting clause (chaperone last-resort rules apply — a second person from the household is recorded). Events NEW: `home_visit.arrived` · `home_visit.completed` · `home_visit.aborted`.

### 3.7 Group session
A group session is one `session_group` with N member sessions; check-in per member; completion posts N charges/consumes N counters; a member who leaves early is `abandoned` individually. Max group size and eligible classes (e.g. ante-natal exercise, cardiac rehab phase III, geriatric balance) are definition data.

---

## 4. Data model sketch

**Registry kinds used (Plan 13, no new kind):** `hall` (gym, dialysis hall, chemo day-care hall) · `room` (assessment room, cubicle `attributes.subtype='cubicle'`, isolation dialysis room `attributes.isolation='hbv'|'hcv'|'hiv'`, compounding room) · `bed` (dialysis chair/bed and chemo chair as `attributes.class='daycare_chair'`, recovery/observation couch) · `device` (traction table, IFT/TENS/US combo, CPM, shortwave diathermy, tilt table, treadmill; dialysis machine with `attributes.sero_class='negative'|'hbv'|'hcv'|'hiv'` and `attributes.reuse_policy`; infusion pump; BSC; RO plant). Dialysers under reuse are a **module table** (movable asset with a lifecycle — the §4A item-2 ruling), FK to the machine `device` and to the patient.

**Tables the `sessions` module owns (sketch):**
- `therapy_episodes` — id, patient_id, encounter_id (referral encounter), admission_ref (nullable, for IPD), department (`physio|ot|slt|dialysis|chemo_daycare`), referrer_actor/external_referrer_id, referral_required_class, diagnosis_codes[] (ICD-10), workflow_instance_id, opened_at, closed_at, closure_outcome, continues_episode_id, sealed flag inherits patient.
- `therapy_plans` — id, episode_id, version, signed_by, signed_at, goals jsonb (SMART goals), frequency_per_week, planned_sessions, reassess_every_n, modalities[] (coded), contraindications[] (pacemaker, DVT, malignancy-at-site, pregnancy, open wound, metal implant → no SWD/US), precautions, home_programme_ref, chaperone_required bool, supersedes_plan_id. FHIR shape: `CarePlan` (activity = sessions), `Goal`.
- `sessions` — id, episode_id, plan_id, sequence_no, scheduled_start/end, location_kind (`opd|bedside|icu|home|group`), resource_ids[] (registry), performer_actor, supervisor_actor (nullable), group_id, workflow_instance_id, actual_start/end, outcome (`completed|missed|abandoned|cancelled_hospital|cancelled_patient`), missed_reason, modalities_used jsonb (with device resource id + minutes), consumables jsonb, counter_movement_id (nullable), invoice_line_id (nullable), occurred_at/recorded_at, notes (FHIR `Procedure` + `Encounter.class=AMB`).
- `outcome_scores` — id, episode_id, session_id?, scale_id (`VAS|NPRS|ROM|MMT|Barthel|MRS|Oswestry|NDI|Berg|TUG|FIM|KOOS|DASH|Kt/V|URR|ECOG|CTCAE-grade`), body_site, value numeric, unit, instrument_version, recorded_by, recorded_at (FHIR `Observation` with LOINC where available).
- `supervision_cosigns` — session_id, student_actor, supervisor_actor, cosigned_at, note. Charge blocked until present (O-6).
- `session_groups` — id, class, room resource, max_size, lead_actor.
- `home_visits` — session_id, address_snapshot, geo_arrived, otp_verified_by, second_person_name, aborted_reason.
- `dialysis_prescriptions` — episode_id, version, nephrologist, dry_weight, duration_min, blood_flow, dialysate_flow/composition, anticoagulation (heparin bolus/maintenance; nil for bleeding risk), access type/site, target_ktv, EPO/iron orders, valid_until.
- `dialysis_runs` — session_id, machine_resource_id, dialyser_id, pre_weight/post_weight, pre/post BP, UF achieved, Kt/V or URR computed, short_run_reason, complications[], two_nurse_check (heparin/EPO) actor pair.
- `dialysers` — id, patient_id, model/lot, first_use_at, reuse_count, max_reuses, TCV measurements[], discarded_at/reason (reuse policy per hospital, logged per use).
- `machine_disinfection_log` — machine_resource_id, cycle_type (heat/chemical), started/ended, by_actor, next_use_allowed_after. **Statutory/NABH register.**
- `water_quality_register` — plant resource, test type (conductivity/hardness/free chlorine daily; TDS; microbiology monthly; endotoxin quarterly, AAMI/ISO 23500 limits), value, limit, pass/fail, by_actor, lab_ref. Fed by `water_quality.recorded`.
- `seropositive_assignments` — patient_id, marker (HBsAg/anti-HCV/HIV), test date, result, machine class; every assignment check reads this. Retest cadence definition data (default: HBsAg/HCV every 3 months, HIV every 6, on entry always).
- `chemo_regimens` (definition data), `chemo_cycles` — episode_id, regimen_id, cycle_no, day_no, planned_date, BSA (height/weight snapshot), dose lines (drug, mg/m², computed, rounded, cap), threshold table snapshot, gate_result, override_approval_id, compounding_verification_id, administration_pair, observation_end, discharge.
- `chemo_gate_evaluations` — cycle_id, result refs (Plan 17), verdict, evaluated_at, automation run id.
- `extravasation_register`, `spill_register` — statutory-style incident tables (NABH + BMW). `spill_kits` — location resource, lot, expiry, seal checks (task-driven).
- `session_department_registers`: physio daily treatment register (per Clinical Establishments Act state rules — most states require a treatment register), dialysis register (per state CEA rules; some states require HBV-segregation records), chemo administration register, ADR register feed (PvPI).

**Retention (recommended):** clinical records 10 years adult / until majority + 10 for minors (aligned with the MRD retention in §11.14); registers per state CEA rule (min 5 years); water-quality register 5 years; disinfection logs 3 years; agent provenance per 12a. DPDP classes: health data (sensitive) for every clinical table; seropositive status is *extra-restricted* — visible only to the dialysis roster + nephrologist + infection control; never on boards by name (machine class shows colour, not diagnosis).

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion · ruling ref**.

### A. Identity & wrong-patient
- **A1** Two "Sunita Devi" in the 10:00 cubicle slot; therapist opens the wrong plan → check-in is by QR scan of the session card/UHID band, and the session screen shows photo + age + diagnosis + last-session note before `session.started`; starting a session for a patient not checked in within 60 min is refused → test: start on un-checked-in patient throws `not_checked_in`.
- **A2** Bundle sold to the wrong UHID (father vs son, same phone) → recognition at counter (Plan 09 R-rows) plus consume requires the session patient == counter instance patient/covered member; mismatch = refuse, offer the correct instance → assertion: consume with mismatched patient throws.
- **A3** Patient merge mid-course (Plan 05) → episodes/plans/sessions/counters re-link to survivor; no double consume in one validity (Plan 09 R11) → test: merged patient's remaining = sum of both minus sessions.
- **A4** Wrong merge split (unmerge) after 4 sessions → sessions carry their original patient_id in the movement audit; unmerge restores per session → test: unmerge leaves each episode on its original UHID.
- **A5** Dialysis: nurse loads Prescription A on machine assigned to Patient B → `pre_checks` requires scanning wristband AND machine QR; prescription patient ≠ scanned patient = hard stop → mutant that drops the patient match must fail the test.
- **A6** Twin/infant physio (paediatric CP) — baby has own UHID (map 2); plan on baby, guardian consent per D-31 → test: session on minor without guardian consent record refuses to close.
- **A7** Home visit at wrong house (same lane, same surname) → arrival needs patient/attendant OTP to the registered number; mismatch blocks `arrived` → test.
- **A8** Unknown/UNK patient from ER needing chest physio → episodes accept UNK UHIDs; later `patient.merged` carries over → test.

### B. Timing, concurrency, race
- **B1** Last bundle unit, two sessions completed within a second (group session + solo double booking) → Plan 09 C3 lock; loser posts per-session line with a flag for coordinator review → contention test (0/20 over-consume with lock).
- **B2** Therapist marks complete at 17:58; server clock 18:03 in another tab reschedules the same session → workflow single-winner transition; second call gets `illegal_transition` → test.
- **B3** Counter validity ends at midnight; session runs 23:40–00:20 (dialysis night) → consume evaluated at `session.started` time, not completion → test: session started inside validity consumes even if completed after.
- **B4** Reassessment due at session 6, but session 6 is a `missed` → due-ness counts *completed* sessions → test.
- **B5** Same machine assigned to two dialysis patients for overlapping slots → registry occupancy triad (`already_occupied`) on `device`; the board shows conflict before check-in → test.
- **B6** Slot Packer reshuffles the day while the coordinator is manually booking → Packer proposals are tentative holds with TTL 10 min (note 15), never confirmed without the coordinator's confirm → test: expired tentative hold disappears.
- **B7** IST day-boundary for "sessions this week" quotas in a plan (3×/week) → istDayIndex reuse (Plan 09) → test with UTC-crossing timestamps.
- **B8** Chemo: labs verified at 09:00 pass; a re-run at 11:00 (haemolysed sample recollected) fails — administration started at 10:30 → gate evaluates against the *latest verified result at gate time*; a later contradicting result raises `result.critical_flagged`-style alert to the oncologist and is logged on the cycle, not retroactively blocked → test.
- **B9** Two nurses scan the same chemo bag twice (double-verify replay) → idempotent verify keyed on (cycle, drug line) → test.
- **B10** Disinfection cycle logged as ended 3 minutes *before* the previous run's `device.usage_stopped` (clock skew on the machine) → module rejects a disinfection whose start < last usage stop; requires manual correction with reason → test.

### C. Partial failure & downtime
- **C1** Server down 09:00–11:30; 40 physio sessions delivered on paper (sealed kit: serially-numbered session slips) → backfill screen enters slips with `occurred_at`; counters consume on backfill in slip order; reconciliation lists any slip serial not entered → test: backfill consume orders by occurred_at, not recorded_at.
- **C2** Downtime spans a bundle's `valid_to` → C5 machinery: consume during backfill for a session that occurred inside validity succeeds even if recorded after → test.
- **C3** Dialysis during downtime → paper run sheet (mandatory fields: machine no., sero class, pre/post weight, heparin witness) — the seropositive segregation check is a printed board colour card on each machine (physical control) — backfill re-validates and emits `machine.segregation_violated` retroactively if the paper says a mismatch happened → incident auto-opens → test.
- **C4** WhatsApp gateway down → reminder ladder falls to SMS → IVR → manual-notify flag on the coordinator worklist (§11.5) → test: notification.failed produces the next rung.
- **C5** Registry (kernel) unreachable (should not happen in a monolith, but a migration lock can) → session completion must not require the registry read; resource ids are captured at scheduling → test: completion with registry service mocked failing still succeeds.
- **C6** Water telemetry sensor offline for 6 h → `utility.threshold_breached` (stale-data variant) → manual dip-test task (as oxygen does, §11.5); dialysis continues on the last-passed manual test within 24 h; beyond that, nephrologist decision recorded → test.
- **C7** Tablet battery dies mid-session note → autosave draft every 15 s locally; note resumes on any device; unsigned drafts > 30 min appear on the therapist's worklist → test.
- **C8** Power failure mid-dialysis (UPS 15 min) → machine returns blood manually; session recorded `abandoned` with `reason: power` + partial charge rule (O-5 defines: base charged pro-rata by minutes on machine, consumables in full) → test.
- **C9** Agent runtime halted globally → recalls are still visible as plain worklist rows (fail-open); nothing waits on the agent → test: Recall automation disabled ⇒ `session.missed` still creates the task via the deterministic subscriber.

### D. Money — billing, refunds, payer switch, packages, TPA
- **D1** 10-session bundle, 4 used, patient wants refund → credit note = 6 × unit price − admin fee per policy; approval-gated; restore movement voids the remaining; refund to payer with ID → test (O-1).
- **D2** Bundle bought on a coupon (Plan 09 contest); refund of unused → refund at the *paid* unit price (invoice line price ÷ qty), never list price → test.
- **D3** Bundle expired with 3 left; patient turns up day 95 → counter narrowed out; per-session price offered; coordinator may request a *grace extension* (approval) — Plan 09 O-1 analogue → test: consume after `valid_to` refuses without extension.
- **D4** Hospital cancels 2 sessions (therapist sick) → `session.cancelled_by_hospital` never consumes; validity auto-extends by the cancelled days (policy default) → test.
- **D5** Bundle + membership discount + coupon on the same session → contest; best single; all candidates recorded (Plan 09 R7) → golden fixture.
- **D6** IPD patient gets bedside physio; also holds an OPD physio bundle → bedside sessions post to the admission bill at admission tariff; bundle NOT consumed unless the plan explicitly says so (default: no, avoids TPA double-claim) → test (O-3).
- **D7** TPA patient: physio sessions in the surgical package (map 6) → sessions route "in-package" until the inclusion count; beyond that `package.overrun_projected` + consent before accrual → test.
- **D8** PMJAY dialysis (HBP package per session) → session posts against the PMJAY payer with the package code; consumables inside the package must not post as separate self-pay lines → test: no self-pay line for an in-package consumable.
- **D9** Payer switch mid-course (corporate withdrawn after 5 of 12 dialysis) → map 3: counselling + consent; sessions attributed by payer period; bundle can't be sold to a TPA-payer episode (self-pay only) → test.
- **D10** EPO given but not charged (nurse forgot the scan) → Leakage Auditor orphan: `medication.administered` without `charge.posted` → daily orphan queue → test.
- **D11** Session charged but no `device.usage_*`/no `session.completed` (ghost session) → the inverse orphan, Fraud Sentinel class → test.
- **D12** Partial session (patient faints at minute 10 of 40) → `abandoned` with clinical reason: no consume, no charge, therapist documents; a *second* abandonment in the same plan opens a clinician review → test.
- **D13** Bundle sold at old tariff; tariff revised next week → the bundle's unit value is fixed at sale (invoice line) — refunds use it; per-session tariff uses the current version (§7) → test.
- **D14** GST: physiotherapy by a clinical establishment is exempt health-care service; gym/wellness "fitness" packages are taxable → the tariff item carries the service category; corporate wellness packages default taxable → assertion in the golden GST suite (O-8).
- **D15** Corporate wellness contract (50 employees × 4 sessions) → one `partner_agreement` (Plan 09) + per-employee instances; usage statement monthly; unused lapses to the corporate, not refundable to the individual → test.
- **D16** Family transfer of remaining sessions (husband's knee healed, wife's back) → refused by default; family-plan config allows; either way a movement with reason → test (O-2).
- **D17** Cash refund > ₹10,000 → bank transfer only (§7); 269ST checks → test inherits Plan 08.
- **D18** Deposit for dialysis course + running consumables → deposit ladder per §11.11; top-up request when EPO stock issued exceeds deposit → test.
- **D19** Student-delivered sessions charged at full tariff → policy: student session tariff class (discounted or same, O-6); co-sign gate before charge → test: charge without cosign refused.
- **D20** Referral commission on physio bundle sold on external doctor's referral → accrual on `payment.received` (Plan 09) and reversal on refund pro-rata → test: refund of 6/10 reverses 60% of the commission.

### E. Consent, legal, MLC, minors, unconscious
- **E1** Manual therapy/pelvic floor/female patient, male therapist → chaperone-required class; `chaperone.present` before `session.started`; roster gate → test.
- **E2** Patient refuses chaperone → recorded refusal is acceptable per policy for non-intimate classes only; intimate classes cannot proceed without → test.
- **E3** Minor (16) with sports injury alone → guardian consent on file (episode-level) suffices for sessions; session-level presence not required unless intimate class → test.
- **E4** Unconscious ICU patient — chest physio → order by intensivist stands as clinical authority; consent under emergency doctrine documented on the admission, not per session → test: no per-session consent gate for ICU protocol packs.
- **E5** MLC patient (assault, fracture) on rehab → episode inherits MLC flag; discharge/abscond re-intimation (map 12) is IPD's; physio notes are part of the MLC record set (MRD custody) → test: MLC-flagged episode's documents release only via logged requisition.
- **E6** Chemo consent per regimen (not per cycle) with a re-consent on dose escalation / regimen change; day-care escort mandatory (§11.16-A) → test: cycle discharge refuses without `escort.verified`.
- **E7** Dialysis patient refuses HBV/HCV retest → segregation check treats "unknown > cadence" as *positive-unknown* → cannot be assigned to a negative machine; nephrologist counselling task → test.
- **E8** Electrotherapy requested; patient has a pacemaker/ICD → plan contraindication list blocks TENS/IFT/SWD modality selection (hard, override by rehab head with reason) → test: modality with contraindication throws.
- **E9** Pregnant patient — SWD/US over abdomen/pelvis contraindicated; ante-natal exercise class fine → same mechanism, pregnancy captured at assessment → test.
- **E10** Patient wants recordings/photos of gait on WhatsApp → DPDP consent for media; stored as clinical document, not sent to a personal phone; the Plan 10 gateway sends only templated messages → test.
- **E11** Home visit — family objects to a male therapist → gender preference honoured at scheduling (E-series preference on the episode); if no match available, patient chooses wait vs proceed, recorded → test.
- **E12** Telemedicine follow-up of home programme (video) → Telemedicine Practice Guidelines 2020: physiotherapists are not RMPs; a video *review* is allowed as an allied-health follow-up under the treating doctor's plan; prescribing anything is the doctor's → test: teleconsult session class cannot emit prescription.

### F. Staff absence, overload, handover
- **F1** Sole physio no-show Monday 08:00 with 30 sessions booked → roster gap → Coverage Resolver proposal (on-call physio / reschedule / bedside first); sessions cancelled by hospital extend validity → chaos §6.2.
- **F2** Therapist goes on leave mid-plan → plan `handover` transition to a named therapist with note (map 5 analogue); attribution splits; patient messaged in their language → test.
- **F3** 14 dialysis patients, 1 nurse present (ratio 1:4 corporate norm) → `overload.flagged`; board refuses to open more than N concurrent runs per nurse present unless duty manager overrides (evented) → test.
- **F4** Intern's supervisor leaves the floor → sessions in progress continue; completion queues for co-sign; > 24 h uncosigned → rehab head → test.
- **F5** Rehab head is the only approver and is on leave → succession chain (S10 §12.16) → test: approval routes to deputy.
- **F6** Shift handover in dialysis with 6 patients on machine → per-patient handover checklist gate (§11.12) → test.
- **F7** Coordinator quits; bundles sold with promised "free 2 extra sessions" verbally → no such entitlement exists unless a movement exists; grievance path; Fraud Sentinel checks that sellers' verbal promises don't become manual restores → test: restore without credit-note or hospital-cancel reason needs approval.

### G. Equipment failure
- **G1** IFT unit fails mid-session → `device` status `down` (kind vocabulary), session continues with alternate device or `abandoned:equipment`; maintenance ticket P5 (critical? no — 4-h SLA); modality add-on not charged → test: charge composition excludes unfinished modality.
- **G2** Dialysis machine alarms & fails → run `abandoned`, blood returned, patient re-slotted same day on another machine of the same sero class; machine `down`, biomedical ticket 30-min SLA (critical care equipment) → test: reassignment respects sero class.
- **G3** RO plant conductivity above limit → Water-Quality Watcher raises active alert; new runs blocked on that plant's machines until a passed test is recorded (QC-lockout class, like analyzers) → test: `on_machine` transition refused while plant status `qc_failed`.
- **G4** Only HBV machine down; HBV patient due → no negative machine may be used (hard); options: postpone / refer-out; nephrologist decision recorded; `sla.breached` → test.
- **G5** Infusion pump for chemo not calibrated (AMC expired per Expiry Watchman) → device `blocked`; cannot be selected → test.
- **G6** BSC (biosafety cabinet) certification lapsed → compounding verification refuses; oncologist informed; day-care list postponed → test.
- **G7** Traction table weight sensor drift → not an HMIS concern except calibration task cadence; recorded on device attributes.
- **G8** Gym treadmill emergency stop used → incident report optional; no HMIS gate.

### H. Data quality, late-arriving, backdated
- **H1** Outcome score entered as VAS 80 (0–10 scale) → scale definition validates range; unit-specified → test.
- **H2** ROM recorded without body site/side → required fields per scale → test.
- **H3** Session note signed 3 days later → `occurred_at` from schedule, `recorded_at` now; late-documentation KPI; charge posts at completion regardless → test.
- **H4** Backdated session "yesterday" entered today for a patient who was in ICU yesterday (bedside) — plausible; for an OPD patient who was not checked in yesterday — requires a reason and shows in the audit sample → test.
- **H5** Height/weight for BSA older than 30 days → chemo gate flags stale anthropometrics (warning, not block; block if > 90 days or weight change > 10%) → test.
- **H6** Dry weight not updated for 3 months → nudge to nephrologist; not a block → test.
- **H7** Duplicate plan opened for the same complaint by two referrers → same-department open episode check; second referral attaches to the open episode → test.
- **H8** Lab result for the gate arrives from an outside lab (PDF) → untrusted content (note 13); manual entry by nurse + oncologist acknowledgement; gate treats as `external_verified` with lower assurance → test.
- **H9** Sero test result older than cadence → E7 rule.
- **H10** Scores improve implausibly (Barthel 20 → 100 in one session) → plausibility check flags for supervisor review; does not block → test.

### I. Fraud, leakage, gaming
- **I1** Therapist completes 14 sessions in 60 minutes (attendance clustering) → Fraud Sentinel scan-time clustering diagnostic → report class with reviewer = rehab head / MS → test on synthetic fixture.
- **I2** Sessions completed for a patient whose phone was never in the building (no check-in scan) → completion requires check-in event unless location=bedside/ICU/home → test.
- **I3** Coordinator sells bundles offline for cash and marks sessions "hospital-cancelled" to hide → hospital-cancel requires a reason class tied to a roster/equipment event; unmatched cancellations > threshold per coordinator → report → test.
- **I4** Ghost dialysis consumables (EPO issued to a patient who was not on machine) → material.issued without session that day → leakage triangle → test.
- **I5** Dialyser reuse counted beyond max to save cost → reuse_count > max_reuses refuses assignment → test.
- **I6** Student sessions billed as consultant sessions → performer credential decides tariff class; co-sign doesn't change performer → test.
- **I7** Self-referral gaming: therapist "refers" walk-ins to a specific external doctor to earn commission → outward-referral pattern report (S10 §12.10) → test.
- **I8** Refund to a different person than payer → §7 rule (ID) → inherited.
- **I9** Group session charged as individual → session class from group membership, not free text → test.
- **I10** Home visit never happened (no geo stamp) → charge blocked without `home_visit.arrived`; geo missing → coordinator verification call → test.

### J. Privacy, sealed records, VIP, staff-as-patient
- **J1** Staff nurse gets physio for back pain → confidential record (§14); therapist worklist shows alias; the gym whiteboard is a public surface: tokens only → test: public display never renders the name.
- **J2** Seropositive status on the dialysis board → colour class only; hover/detail requires dialysis-role scope; exports to vendors carry machine ids only → test: non-dialysis role read of `seropositive_assignments` denied.
- **J3** VIP on chemo day-care → sealed; escort verification records the escort's ID with restricted visibility → test.
- **J4** Cancer diagnosis visible to the physio treating lymphoedema → minimum-necessary: the plan shows relevant diagnosis; the Lens pack allowlist excludes oncology notes outside the physio's role → test via pack fixture.
- **J5** WhatsApp reminder text must not name the department for sensitive classes ("your session at 10:00" not "your chemotherapy") → template class per department sensitivity → test.
- **J6** Patient requests DPDP data erasure mid-course → statutory retention overrides erasure for clinical records; DPO response template → test: erasure request creates task, not deletion.

### K. Language, literacy, accessibility
- **K1** Bhojpuri-speaking patient, cannot read the home-exercise sheet → pictorial sheets (definition content) with QR to a Hindi voice note (Plan 10 public read surface); attendant contact set as messaging target → test: message to attendant when preference says so.
- **K2** Hearing-impaired patient in group class → accessibility flag on episode; therapist prompt.
- **K3** VAS for an illiterate patient → faces scale variant selected by the scale definition; recorded as same scale id with `variant` → test.
- **K4** Wheelchair patient booked to a first-floor gym without lift → resource attribute `accessible: false` blocks scheduling when episode says wheelchair → test.
- **K5** Consent in Hindi printed with QR → inherited print law.

### L. Scale (100/day → 2,000/day)
- **L1** 200 sessions/day, 20 therapists, 30 cubicles → board query is the registry board (direct children, indexed) + sessions by day; perf budget < 300 ms → load test.
- **L2** Recall automation: 30 missed sessions/day → batched into the coordinator's worklist; only > 48 h unclosed escalates (alarm fatigue) → test: no per-miss push to the rehab head.
- **L3** Dialysis 20 machines × 3 shifts = 60 runs/day → board realtime via WebSocket; machine history per run appended, not updated → test.
- **L4** Multi-site (second building) → `site_id` already on registry and events (Plan 13 DD3); sessions carry `site_id` → test.
- **L5** 500 active bundles → Expiry Watchman runs daily under advisory lock; idempotent reminders keyed (counter, rung) → test.

### M. Integration failures (device/vendor/ABDM)
- **M1** Dialysis machine data export (Fresenius/Nipro serial/USB) unavailable → runs are hand-entered from the machine screen; interfaced later per the edge-service rule (§5 lab-edge pattern) → no dependency at go-live.
- **M2** Water sensor MQTT broker down → C6.
- **M3** ABDM care-context linking for a physio episode → FHIR `CarePlan`/`Procedure` bundle from stored shapes; failure to link never blocks care → test: ABDM adapter failure is a task.
- **M4** Outcome-scale content licensing (Oswestry, NDI are copyrighted for commercial use; VAS/NPRS, Barthel (public domain variant), TUG, Berg are free) → scale registry marks licence status; licensed scales unavailable until sourced (buy-not-build, O-9).
- **M5** Chemo regimen content (e.g. licensed protocol database vs hospital-authored) → regimens are hospital-authored definition data by the oncologist, MS-activated; licensed content optional → O-9.
- **M6** SMS DLT template rejection for a new reminder template → template registry status; fallback to approved generic template → inherited Plan 10.
- **M7** Biometric/HR roster feed lag shows therapist "absent" though present → sessions proceed; attendance-activity mismatch report (S10 §12.7) → test.

### N. Clinical safety specifics
- **N1** DVT suspected during session (calf pain, swelling) → `session.abandoned:clinical`, task to referring doctor with 5-min ack timer? No — physio is not critical-alert class by default; a *danger flag* (vitals.danger_flagged analogue) routes to the on-duty doctor with the standard ladder → test.
- **N2** Fall in the gym → incident report (NABH), session abandoned, ER handoff if needed → test: incident links session.
- **N3** Hypotension on dialysis → nurse records intervention; run continues/aborts by protocol; complication coded → test.
- **N4** Extravasation of a vesicant → stop, aspirate, antidote per drug table, photo, register, oncologist call, incident; day-care conversion if needed → test: extravasation record requires drug + site + antidote decision.
- **N5** Spill > 5 ml chemo → spill kit use, BMW yellow-category disposal manifest (BMW Rules 2016), staff exposure record, kit replenishment task → test.
- **N6** Anaphylaxis to iron sucrose in dialysis → ADR register + PvPI → `adr.reported` reuse.
- **N7** ICU early mobilisation with a patient on vasopressors → protocol pack exclusion criteria (definition data) evaluated before task creation; ICU nurse sees "hold: exclusion met" → test.
- **N8** Post-op ortho patient with drain → protocol milestone gating (day-2 weight bearing only if surgeon cleared) → surgeon clearance event required → test.
- **N9** Seizure-prone patient in hydrotherapy (if ever) — class exclusion rule.
- **N10** Chemo administered without pharmacist verification during pharmacy downtime → paper verification with two signatures; backfill records `compounding.verified` with `occurred_at`; never a silent skip → test: backfilled cycle without verification record cannot close.

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday, RO plant fails at 06:20 with 12 dialysis patients arriving.** 06:20 conductivity 25 µS/cm → `utility.threshold_breached` (active alert) → Water-Quality Watcher sets plant status `qc_failed`; every machine on that plant refuses `on_machine`. Duty manager + nephrologist paged (5-min ack). 06:35 nephrologist rules: patients with K+ > 6 or fluid overload go to the sister hospital (referral note auto-drafted from prescription — T2 draft, nephrologist signs), the rest reschedule to afternoon. Coordinator's worklist shows the 12 with a one-tap "reschedule + notify in language". Sessions cancelled by hospital extend bundle validity. 09:10 biomedical fixes plant, D4 records a passing conductivity test → plant `available`, runs resume. Paper path: none needed (no downtime). Audit: alert → decision → per-patient outcome, all evented; the digest next morning lists 12 disruptions, 3 referrals out, 0 segregation exceptions.

**6.2 Sole senior physio no-show, 30 sessions, two interns present.** 08:05 roster shows card-30 absent; the interns cannot run unsupervised sessions (co-sign gate). Coverage Resolver (T3) proposes: on-call physio in by 09:30; bedside IPD sessions first (no cubicle needed); OPD sessions shifted +90 min; 6 sessions cancelled-by-hospital. Coordinator confirms (one screen). Patients get language-specific messages; those already in the waiting area are told by the desk (manual-notify flag). Interns run gym-based exercise supervision for patients whose plans mark `supervision_level: indirect` (definition data) — those sessions still queue for co-sign. Audit: `roster.deviation_published`, cancellation reasons tied to the roster gap, no counter consumed for cancelled sessions.

**6.3 Server down 10:00–13:00 in physio + dialysis.** Duty manager declares downtime (map 1). Physio kit: 50 numbered session slips; dialysis kit: run sheets + laminated machine class cards (blue=negative, yellow=HBV, red=HCV) on every machine — the physical form of the segregation rule. PBX for calls. 13:05 backfill: slips entered with `occurred_at`; counters consume in slip order; run sheets entered; the backfill validator re-runs segregation and heparin two-nurse checks (names from the sheet) and emits `machine.segregation_violated` if a mismatch is found → incident + infection-control review. Reconciliation proves every slip serial; a missing serial is a task. Digest shows outage window, slips issued/entered, rupees reconciled.

**6.4 Chemo Tuesday: LIMS analyser down, 8 cycles due.** Pre-chemo counts cannot be verified in-house. Options in definition: outside-lab result (manual entry, `external_verified`), or defer. Oncologist reviews each; 5 proceed on outside results entered by the nurse and *acknowledged* by the oncologist (two events); 3 deferred with cycle re-planned +2 days. One patient's outside PDF carries "ANC 0.9" in a footnote — untrusted content, hand-entered as 0.9 → gate blocks → `chemo.gate_blocked`. Pharmacist compounding proceeds only for `cleared` cycles. Audit: every gate evaluation cites its result refs and assurance level.

**6.5 VIP + fraud + MLC in the same afternoon.** 14:00 a VIP (sealed) arrives for post-op knee rehab; alias on the board, session proceeds; the therapist's Lens shows only rehab-relevant lines. 14:30 Fraud Sentinel's daily run flags coordinator X: 11 hospital-cancellations this week with no roster/equipment cause + 4 manual restores → report to billing supervisor with a disposition workflow. 15:10 an assault-injury (MLC) patient is referred for hand rehab; episode inherits MLC; notes go to MRD custody class. Audit: three separate correlation ids, no cross-contamination; the VIP's session never appears in the Sentinel's report identity fields (instrument ids only).

**6.6 Power + network loss during a dialysis evening shift (8 on machine).** UPS carries machines 15 min; core VM unreachable from the floor. Nurses return blood manually per SOP, record on run sheets (`abandoned: power`, minutes on machine). Generator restores power; network returns 40 min later. Backfill: partial-charge rule pro-rates base by minutes; consumables charged; no counter consume for runs < 50% of prescribed (policy, O-5); each patient gets a re-slot task within 24 h (clinical recall, active alert). Incident report auto-opens (NABH). Digest: 8 abandoned runs, 8 re-slots, 0 missing sheets.

**6.7 Intern co-sign backlog + attribution dispute.** 40 uncosigned sessions after a week; charges blocked; billing sees revenue "missing". Nudger escalates to rehab head at 24 h; at 72 h to MS. Rehab head co-signs in bulk *per session* (no blanket sign; each row acknowledged), a therapist disputes attribution of 6 sessions → `attribution.disputed` → MS resolves. Audit shows exactly who performed and who supervised each.

---

## 7. Compliance, audit & statutory surfaces

- **Clinical Establishments (Registration & Regulation) Act 2010 + state rules:** registration of the physiotherapy unit and the dialysis unit as services; minimum standards (dialysis: nephrologist availability, trained nurse/technician ratio, RO water standards, HBV segregation, infection-control SOP); treatment registers → tables in §4, printable on demand.
- **NABH (5th ed.) asks to see:** dialysis water-quality records (AAMI/ISO 23500 limits), machine disinfection logs, seropositive segregation policy and evidence, dialyser reuse policy + per-dialyser log, HD-related infection surveillance (HAI register — map 9), chemo: safe handling SOP, BSC certification, spill/extravasation registers, two-person verification evidence, consent forms, staff competency (chemo-certified nurses), physio: assessment/plan/reassessment/discharge documentation, patient education evidence, falls in rehab (incident register), equipment calibration/AMC. All are tables or event-derived views, never hand-compiled.
- **BMW Rules 2016:** cytotoxic waste (yellow category), sharps from dialysis (white/translucent), dialysers/bloodlines (red category) → weigh + manifest chain (Track B Plan 19).
- **Drugs & Cosmetics Act / Schedule H/H1; NDPS** for palliative narcotics on the oncology path (existing machinery).
- **DPDP Act 2023:** health data sensitive; seropositive and oncology diagnoses extra-restricted; consent for media; guardian consent for minors (§9); erasure vs statutory retention; processor agreements with any dialysis-machine or water-telemetry vendor whose kit touches patient data (E-A-2).
- **Telemedicine Practice Guidelines 2020:** video follow-up by allied health only under the RMP's plan (E12).
- **PCPNDT** — not applicable unless USG-guided therapy; n/a. **MTP/POCSO** — pregnancy in a minor discovered at assessment forces POCSO intimation (maternity floor rule reused). **MLC** — map 12.
- **AERB** — n/a for physio/dialysis/chemo day-care (radiation oncology is its own module).
- **Consent forms (signed by patient/guardian; witnessed where policy):** therapy consent (episode), manual therapy/intimate-area consent + chaperone acknowledgement, electrotherapy risk (pacemaker screening question on the form), home-visit consent, dialysis consent (access, anticoagulation, blood-borne infection testing consent), dialyser reuse consent (where reuse is practised), chemo regimen consent with re-consent triggers, media consent, DPDP notices in Hindi/English.
- **What an inspector demands on walk-in:** today's dialysis register with machine numbers and sero classes; last 30 days of water tests; disinfection log for a named machine; chemo administration register with two signatures; spill kit locations and expiry; staff credential register (nephrologist, chemo-certified nurses, physio council registrations where the state has a council); consent files for a random patient. Each is one screen/print with QR.

---

## 8. Staff KPI & KRA

All KPIs are event-derived, load-normalised (sessions assigned, case mix class, shift census shown alongside), diagnostic never punitive (S10 §2). Target home: KPI formula registry (note 5). Gaming checks routed to Fraud Sentinel.

**Physiotherapist (card 30, extended):** plan completion rate = closed:completed ÷ closed (target > 85%; load: plans open) · missed-session rate per plan (diagnostic; patient-mix normalised) · reassessment-on-time = reassessed within window ÷ due · outcome documentation coverage = plans with ≥2 scores ÷ closed plans (> 95%) · median score delta per diagnosis class (trend only, never ranking) · documentation latency = signed − session end (median < 30 min) · bedside order-to-first-session (IPD ≤ 24 h, ICU ≤ 4 h) · cosign turnaround for supervisors (< 24 h). Gaming: attendance clustering (I1); score inflation (H10 plausibility + supervisor sampling); closing plans early as "completed" to lift completion — cross-check against score delta and re-referral within 30 days. **KRA:** every plan executed to completion or consciously closed; every session documented and scored; students supervised.

**Rehab head:** cosign latency · plan-deviation approvals turnaround · department missed-session recall closure < 48 h · equipment-down hours · protocol-pack currency (definition versions reviewed quarterly). KRA: definition drafts, supervision, quality reviews.

**Coordinator:** booking lead time (referral → assessment) · reminder delivery rate · reschedule-to-cancel ratio · bundle validity extensions requested (diagnostic) · cash-vs-instrument sale mix. Gaming: unmatched hospital-cancellations (I3), manual restores (F7). KRA: the calendar is full and honest; every recall task reaches a human within SLA.

**Dialysis nurse:** pre-check completion within 20 min · runs achieving prescribed duration (short-run rate, reason-coded) · intradialytic complications per 100 runs (diagnostic) · two-nurse verify compliance (100%) · access-site assessment coverage · handover checklist completion. Gaming: pre-checks time-clustered; verify pairs recurring dyads (S10 §12.23). KRA: safe run, complete record, segregation never violated.

**Dialysis technician / RO tech:** disinfection log completeness (100%) · water tests on schedule (daily/monthly/quarterly) · machine downtime hours · reuse-policy compliance (dialysers within max). KRA: water and machines always fit for use.

**Nephrologist:** prescription currency (dry weight ≤ 90 days) · Kt/V attainment (unit-level, monthly) · seropositive review cadence · referral-out rate (diagnostic). KRA: every patient has a current prescription and a monthly review.

**Day-care oncology nurse:** gate-to-administration time · extravasation/spill events per 100 administrations · two-nurse compliance · escort verified before discharge (100%) · observation completion. **Oncology pharmacist:** compounding verification turnaround · dose-calc discrepancy catches (positive KPI) · BSC certification currency. **Oncologist:** gate override rate with reasons (diagnostic; high rate = threshold table review, not blame) · cycle-on-time rate · deferral reasons distribution.

**Owner's 8 a.m. digest (department lines):** sessions scheduled/completed/missed yesterday by department · recalls open > 48 h · bundles sold ₹ / refunds ₹ / extensions count · dialysis runs, short runs, segregation exceptions (should be 0), water status · chemo cycles given / gate-blocked / overrides · orphan charges in session departments · equipment down · anomaly reports opened.

---

## 9. AI agents & the copilot — where inference earns its place

| Candidate | Type | Tier | Trigger / inputs | Output | Human sign-off | Fail-open path | Kill scope | Provenance/eval | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|
| Recall & Follow-up (session scope) | automation | T1 | `session.missed`, `therapy_plan` reassessment overdue, chemo cycle deferred | reminder ladder + call task at 48 h | coordinator closes | worklist row exists regardless | agent | rule version | health (contact only) | Plan 20 |
| Expiry Watchman (bundles) | automation | T1 | counter `valid_to` T-14/7/1; AMC/calibration on `device` | reminders; `bundle.expired`; device `blocked` on lapsed calibration | none / biomedical | manual list | agent | rule version | minimal | Plan 20 |
| **Plan-Adherence Nudger** | automation | T1 | plan frequency vs completed sessions; documentation unsigned > 30 min; cosign > 24 h | nudges to therapist/rehab head, batched into shift digest | none | worklist | agent | rule version | health | Plan 20 |
| **Session Slot Packer** | automation (pure-function allocator, note 9) | T3 | roster gaps, cancellations, equipment down, waitlist | proposed re-slotting plan with tentative holds (TTL 10 min) | coordinator confirms | manual booking | agent | deterministic; property tests | health (schedule only) | Plan 20 |
| **Chemo Gate** | automation (hard refusal) | n/a (blocks transitions) | regimen threshold table + latest verified results | `cleared` / `chemo.gate_blocked` | oncologist override (T3 approval) | paper verification during downtime, backfilled | never killable by agent switch — it is a workflow guard, not an agent | table version snapshot per evaluation | health | Plan 22 |
| Water-Quality Watcher | automation | T1 | MQTT/manual `water_quality.recorded` | plant status, active alert | nephrologist decisions | manual test cadence | agent | rule | none | Plan 21 |
| Leakage Auditor / Fraud Sentinel (session classes) | automation | T0 | orphan triangles I1–I10 | reports to named reviewers | reviewer disposition | — | agent | rule | health (de-identified ids) | 12b + Plan 20 |
| **Therapy Progress Note Drafter** | agent (LLM) | T2 | on-demand: plan, sessions, scores, tokenised notes | draft progress/discharge summary with cited line ids | therapist signs; rehab head for discharge | therapist writes manually | agent class "drafters" | model id, prompt version, hashes (12a) | health, tokenised (Class-1 lane) | after 12a gates |
| Lens pack `session-daycare` | agent narration over deterministic card | T2 | (patient, session, caller) fact sheet: plan, contraindications, last scores, sero/gate status, allergies, device list | snapshot card (deterministic) + optional narration | none for card; narration is additive | card | Lens | pack version | health | pack lands with Plan 20 |
| Digest Writer lines | agent | T0 | KPI registry | digest section | owner reads | SQL summary | existing | existing | aggregate | Plan 20 |

**Three presentation lanes.** Lane 1 (hand-built, keyboard-first): coordinator booking/sale desk; dialysis session board (per-hall, colour by sero class, live via WebSocket); chemo day-care board. Lane 2 (schema-generated worklists): therapist worklist, cosign queue, water-test entry, disinfection log entry, outcome-score entry, recall queue, spill-kit checks — all from tool-catalog schemas, no bespoke screens. Lane 3 (conversation): rehab head asking "which plans are overdue for reassessment this week and who is treating them" → tool calls under the asker's permissions; coordinator: "move Mr X's Thursday session to Friday afternoon with the same therapist" → propose→confirm. Journey Feed contributions: every `therapy_plan.*`, `session.*`, `chemo.*`, `dialysis.*` event renders on the patient's feed; the referring doctor sees session completion and score deltas without opening physio screens.

**Prompt inputs (concrete, Drafter):** tokenised fact sheet lines — diagnosis codes, plan goals, sessions (dates, modalities, duration), score series with scale ids, contraindications, missed sessions with reasons, therapist free-text (scrubbed). Output: typed claims (`summary`, `observation`) each citing line ids; no recommendations of new modalities (narrate-never-originate — the plan revision is the therapist's).

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One beep context:** session card with QR (UHID + episode + next session) printed at sale; desk scan = check-in + board update + therapist worklist highlight; wristband scan at bedside/dialysis.
- **Pre-filled sessions:** the plan generates the calendar; completion screen pre-fills modalities from the plan — therapist confirms/changes in ≤ 3 taps; charge composition derives from what was confirmed.
- **Protocol packs:** ortho post-op, ICU chest physio/early mobilisation, stroke rehab, cardiac rehab phases, dialysis standard prescriptions, chemo regimens — definition data with milestones; a pack opens a plan in seconds.
- **Outcome scale widgets:** VAS slider/faces, ROM goniometer entry per joint with normal ranges shown, Barthel checklist; score deltas graphed on the plan.
- **TAT clocks:** referral→assessment, order→first bedside session, check-in→start, gate→administration; SLA breaches recorded, only the active list alerts.
- **Board surfaces:** dialysis hall board (machine × slot × patient alias × sero colour × run timer), physio cubicle/gym board, chemo chair board — all from the registry board query + sessions.
- **Tablet at bedside/gym:** large targets; offline-tolerant drafts; voice dictation for notes where lawful (in-app, not WhatsApp).
- **Printing:** session card, home-exercise sheet (pictorial, Hindi/English, QR to voice note), dialysis run sheet, chemo administration record, consent forms — all QR-stamped.
- **Measured targets:** check-in to therapist screen < 2 s; session completion ≤ 20 s of interaction; board refresh < 1 s; documentation median < 30 min; recall closure < 48 h; segregation violations = 0 (attempts logged); orphan charges < 1% of sessions.

---

## 11. Integrations, devices & dependencies

- **Dialysis machines** (Fresenius 4008S/5008, Nipro Surdial, B.Braun Dialog+, Nikkiso): serial/USB or vendor server export; **procurement mandate: no machine purchase without documented data-export** (ICU precedent). Edge service (Node/TS on a mini-PC, SQLite buffer) per hall — the lab-edge rule; go-live is manual entry.
- **RO plant telemetry:** conductivity/TDS sensors → MQTT → TimescaleDB (existing ICU pipeline) → `water_quality.recorded`; manual entry until sensors exist.
- **Chemo:** infusion pumps (Baxter/B.Braun/Terumo) — no interface needed day one; BSC certification as a device attribute; closed-system transfer devices as consumables.
- **Physio modalities:** no data interfaces (IFT/TENS/US/SWD/CPM); device-usage events come from the session screen (start/stop per modality), reconciled per §11.19-C-13.
- **Lab (Plan 17):** `result.verified` consumed by the Chemo Gate and by dialysis monthly bloods; sero tests feed `seropositive_assignments`.
- **Pharmacy (Plan 16):** EPO/iron/heparin/chemo drug issue scans → charges; compounding record; stock of spill kits/antidotes as par-level items.
- **Mini-OT (Plan 15):** `daycare.discharged` with procedure → protocol map opens rehab episode.
- **IPD/ICU cluster:** bedside orders via the order interface; ICU nurse worklist consumes protocol tasks; until then, the transition-operations boundary map governs.
- **Notifications (Plan 10):** reminders, recalls, voice-note links; **Registry (Plan 13):** all resources; **Memberships (Plan 09):** bundles; **Approvals (Plan 04):** extensions, refunds, gate overrides; **Workflow (Plan 03):** all definitions; **12a/12b:** automations/agents.
- **ABDM:** care-context linking of `CarePlan`/`Procedure`/`Observation` bundles, never blocking.
- **Events consumed:** referral.issued · order.placed · daycare.discharged · result.verified · material.issued · medication.administered · roster.published/.deviation_published · device status changes · utility.threshold_breached · payment.received/refunded · credit_note.issued · patient.merged.

---

## 12. Buy vs build, hardware & rough INR budget

**Build:** the `sessions` module (episode/plan/session/scores/registers), dialysis and chemo specialisations, boards, protocol-pack definitions, automations. **Buy/licence:** outcome scales that are licensed (Oswestry, NDI, SF-36 — optional), regimen references (optional), dialysis-machine export SDKs where paid, water sensors, hardware. **Never build:** a scheduling SaaS, a home-care GPS app (use the tablet + browser geolocation), a chemo compounding robot interface (later).

| Item | Qty (day one → 610-bed) | Approx ₹ |
|---|---|---|
| Physio: IFT/TENS/US combo units | 2 → 8 | 60–90k each |
| Traction unit + table, CPM, tilt table, SWD | 1 each → 3 | 40k–2L each; total 4–8L |
| Gym set (parallel bars, treadmill, cycle, weights, balls, mats) | 1 set → 2 | 3–6L per set |
| Ward/gym tablets + rugged cases | 4 → 20 | 15–25k each |
| QR scanners (desk), label printer | 2 → 6 | 5–15k each |
| Dialysis machines | 5 → 20–30 | 6–9L each (HBV/HCV dedicated ×1–2 each) |
| RO plant (2-stage, 1,000–2,000 LPH) + loop + sensors | 1 → 2 | 10–20L + 1–2L sensors/edge |
| Dialysis chairs/beds | 5 → 30 | 40–80k each |
| Chemo chairs, infusion pumps | 4 → 12 | chairs 40–80k; pumps 50–90k |
| Class II BSC + cytotoxic PPE + spill kits | 1 → 2 | BSC 3–5L; kits 3–5k each |
| Edge mini-PCs per hall | 1 → 3 | 25–40k each |
| Water testing (external microbiology/endotoxin) | monthly/quarterly | 2–5k per test |
| Software licences (scales/regimen content, optional) | — | 0–3L/year |

Physio day-one ≈ ₹8–15L; dialysis 5-machine unit ≈ ₹55–80L; chemo day-care 4-chair ≈ ₹12–20L (excluding civil/HVAC). Owner ruling O-10 on the phasing of purchases.

---

## 13. Owner rulings needed

- **O-1 Refund policy for unused prepaid sessions.** Recommended default: full refund if 0 used; after ≥1 used, refund remaining at paid unit price minus 10% admin fee (0% if hospital-caused); always via credit note + approval; bank transfer above ₹10k. Why: corporate-standard, trust-hospital ethos, Plan 09 brainstorm's "unused sessions tracked honestly".
- **O-2 Transfer of remaining sessions to another person.** Default: not allowed; allowed within a family membership by config. Why: fraud surface vs goodwill; family plans already exist in Plan 09.
- **O-3 Course tariff lock.** Default: a prepaid bundle's unit price is fixed at sale; per-session physio bills current tariff; **IPD bedside sessions never consume an OPD bundle** (TPA double-claim risk). Why: mirrors §7 admission lock.
- **O-4 Doctor referral requirement.** Default: clinical physio classes require a referral (in-house or external RMP; external captured with attribution); wellness/maintenance classes walk-in. Dialysis and chemo always by prescription. Why: CEA state rules and medico-legal exposure.
- **O-5 Dialysis charge composition and partial-run rule.** Default: base (machine+nursing) + dialyser (new/reuse) + lines + heparin as bundle inclusions; EPO/iron/extra labs excluded; abandoned run < 50% prescribed = no counter consume, base pro-rata, consumables full. Why: EPO cost variance; fairness on power failures.
- **O-6 Student/intern sessions.** Default: allowed under co-sign gate; charged at the student tariff class (recommend 70% of standard) with disclosure on the session card. Why: attribution honesty, NABH supervision evidence.
- **O-7 Dialyser reuse.** Default: reuse practised per written policy (max reuses, TCV threshold) with per-dialyser log and patient consent; single-use for seropositive. Why: Indian corporate norm; cost; safety trace.
- **O-8 GST treatment of wellness/corporate packages.** Default: clinical physio exempt; fitness/wellness taxable; corporate wellness contracts taxable. Why: legal exposure — counsel confirms.
- **O-9 Licensed content.** Default: ship free scales (VAS/NPRS, ROM, MMT, Barthel, TUG, Berg, mRS, ECOG); licensed scales and regimen databases on the §19 knowledge-sourcing budget line.
- **O-10 Purchase phasing.** Default: physio equipment with Plan 20; dialysis machines when the dialysis floor commissions; chemo day-care after Plans 16/17 are live.
- **O-11 Missed-session recall aggressiveness.** Default: reminder ladder T-24h/T-2h, recall at +2h, human call task at 48 h; chemo/dialysis misses = same-day call task. Why: alarm fatigue vs clinical risk.
- **O-12 Home physio launch.** Default: defer to a later plan (20b) once OPD physio has 90 days of baselines.

---

## 14. Plan sketch — how this becomes phase documents

**Plan 20 — Session Departments Core + Physiotherapy** (after 15 mini-OT, can run parallel to 16/17; needs 13 + 09 + 10, benefits from 15's `daycare.discharged`). Sections: T1 schema (episodes, plans, sessions, scores, cosigns, groups) + registry kind claims (`hall`, `room`, `bed`, `device` vocabularies) + manifest/permissions · T2 workflow definitions (episode, session) + SLA + ladders · T3 bundle wiring on Plan 09 (plan kind `package`, consume in `session.completed`, restore paths, extension via approvals) · T4 coordinator desk (Lane 1) + therapist worklist/cosign/scores (Lane 2) · T5 boards over the registry · T6 protocol packs (ortho post-op, ICU chest physio as definition data; ICU tasks only when the ICU module exists) · T7 automations (Recall extension, Expiry Watchman extension, Nudger, Slot Packer) · T8 registers/prints/consents · T9 KPI formulas into the registry · CLOSE. Gates: Plan 13 T6/T7 deployed; Plan 09 flags armed for counters; roster gate for chaperone in place.
**Plan 21 — Dialysis** (at floor commissioning; needs 20 + 16 for consumable issue scans + 17 for sero/monthly bloods; manual entry fallback): prescriptions, runs, machines/sero classes, disinfection & water registers, reuse, boards, Water-Quality Watcher, edge service later.
**Plan 22 — Day-care Chemotherapy** (after 16 and 17 are live; needs 20): regimen definitions, cycles, Chemo Gate, compounding verification, two-nurse admin, extravasation/spill registers, escort/discharge; NDPS palliative path reuses pharmacy.
**Plan 20b — Home physio + group classes + corporate wellness** (after 90 days of Plan 20 baselines).
**Must be true before authoring Plan 20:** owner rulings O-1..O-6, O-8; the IPD order interface either exists or the boundary map names how bedside orders arrive; Plan 12b Recall is live or the deterministic subscriber ships in 20.

**Negative-space question — what absence is a signal here?** A plan with no sessions in 14 days (silent abandonment); a completed session with no score in 6 sessions; a dialysis patient with no run in 5 days (missed dialysis = danger, same-day call); a machine with usage but no disinfection log between runs; a chemo cycle cleared but never administered within 72 h; a bundle sold with zero sessions after 30 days; a therapist with zero missed sessions across 200 (too clean); a plant with no water test entry today. Each becomes a watcher (note 10), not a red number.

**Staff edge-case interview questions (department head):** 1) How many sessions do you cancel per week and why? 2) What happens today when a bundle expires with sessions left? 3) Who decides a plan is "done"? 4) How do you handle a male therapist with a female patient — always a chaperone? 5) Do interns treat alone? Who signs? 6) What outcome scales do you actually use? 7) How do IPD orders reach you and how fast? 8) Do you do ICU chest physio at night? 9) Any patients with pacemakers you screen for? 10) How do surgeons want post-op protocols to start? 11) Dialysis: how do you segregate HBV/HCV today; how often do you retest? 12) Dialyser reuse: how many times, who logs? 13) Water testing: who, how often, where are the records? 14) Chemo: what blocks a cycle today; who verifies the dose? 15) When did a spill or extravasation last happen and what was recorded? 16) What do patients most often complain about in this department?

---

## 15. Open questions & risks

- **IPD order interface timing:** bedside/ICU sessions depend on an IPD cluster not yet sequenced; Plan 20 must ship with an explicit "order arrives via OPD-consult/referral until IPD" boundary so it is not blocked.
- **Plan 09 counter parent:** `entitlement_counters.instance_id` references `membership_instances`; a standalone bundle needs a `membership_plans.kind='package'` instance with no covered-member semantics — confirm at Plan 20 authoring that instances support a single-patient package without a plan-holder relationship rewrite.
- **Partial charges vs append-only:** pro-rata base charges on abandoned runs must be a first-posted line, never a correction — confirm the tariff engine can price by minutes (device-days precedent suggests yes).
- **Registry status vocabulary for `device`:** Plan 15 declares `device`; the dialysis `qc_failed`/`down`/`blocked` statuses must be agreed with Plan 15's vocabulary before Plan 21 (a kind is declared by exactly one manifest — DD4 boot error on duplicates). Risk: Plan 15 owns `device`; Plan 21 cannot redeclare it. Recommend the kernel or Plan 15 declares a vocabulary wide enough (`available|in_use|down|qc_failed|blocked|retired`).
- **Chemo Gate as a workflow guard vs automation:** it must not be killable by the agent kill switch, yet it runs under the harness for identity/audit — resolve in Plan 22 (recommend: transition guard in the workflow definition, evaluation logged as an automation run).
- **State CEA rules for physiotherapy registration** vary; counsel to confirm register formats for the operating state.
- **Licensed scale content** — sourcing decision sits with the §19 knowledge-sourcing line.
- **Seropositive data class** — DPIA amendment needed before the dialysis board ships (extra-restricted class is new).
- **Home physio geolocation and staff safety** — a solo therapist at a home is a safety and POSH exposure; policy before Plan 20b.
