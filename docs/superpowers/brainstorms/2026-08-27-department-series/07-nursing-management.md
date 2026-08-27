# 07 — Nursing Management — Brainstorm & Planning

Date: 2026-08-27 · Status: **Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED** · Series: Department Brainstorm & Planning (overnight, 2026-08-27) · Author: AI agent under the authoring brief

**Executive summary.** Nursing Management is the module that owns *who is caring for which patient right now, what they must do next, whether they did it, and what they hand over*. It owns nurse-patient assignment, the eMAR dose ledger, the nursing task fabric (P5), vitals/early-warning charting, nursing assessments and care-plan bundles, structured shift handover, ward-level narcotic custody, and the nursing quality registers (falls, pressure injuries, restraints, needle-sticks, violence). It is **not** the roster authoring system in full (rosters are authored/validated/published in the HMIS per S10 §12.15 but that is a separate workforce plan this document treats as a dependency), not the bed board (IPD), not pharmacy stock (P3 owner is Plan 16), not the ICU telemetry pipeline (§11.15 edge), and not HR attendance/payroll (bought). Its three hardest problems: **(1) the wrong-patient/wrong-dose hard stop must survive every degradation** — dead tablet, torn wristband, night skeleton, downtime — without teaching nurses to bypass it; **(2) alarm economy** — an early-warning score and a task SLA that page a resident at 03:00 must be right often enough that the resident still comes at the 40th page; **(3) the legal record** — nursing notes and the MAR are the documents a court, NABH and a consumer forum read first, so late entries, witness identities, student attribution and verbal orders need structural (not policy) integrity while staying fast enough for a 1:8 ward at 2,000 OPD/day scale.

---

## 1. Frame — what exists, what is locked, what this document adds

**What exists (built, Phase 1):** kernel events outbox with full envelope (§10.5), workflow engine with versioned definitions and SLA ladders (§10.2, Plan 08.5 escalation delivery), approvals engine (§8), RBAC actor fabric with agents as first-class actors (§14/§16), scheduler/worker, ops modes + downtime kit, patients master with allergies and language preference (§6), formulary + prescribing safety checks (copilot design §1), notifications gateway (§11.13), global search. **Plan 13 (in flight)** gives the resource registry with the ten kinds `floor|ward|hall|room|bed|theatre|store|bench|analyzer|device`, the occupancy triad, and `resource_status_history`.

**Locked decisions this module inherits (extend, never re-litigate):**
- §11.8: eMAR auto-generates dose tasks from drug orders; wristband scan per dose; given/missed/refused each evented with reason; high-alert meds two-nurse verification at administration; NDPS/Schedule X double-lock, witnessed, second factor, running ampoule balance, witnessed wastage; medication reconciliation at admission/transfer/discharge; patient's-own-meds path.
- §11.12: HMIS consumes the live on-duty picture; escalation ladders resolve to the on-duty *role holder*, never a named person; handover is a per-patient checklist gate — outgoing flags, incoming acknowledges, unacknowledged escalates; one merged time-ordered worklist per nurse; ratio indicator per shift; mid-shift departure returns tasks to pool; credential lapse = hard block.
- S10 §12.15: **roster system-of-record = HMIS**; HR keeps payroll/attendance. S10 §11 SoD pairs (narcotics issuer/witness; ward sub-store custodian never counts own stock), witness eligibility (any licensed nurse on floor, cross-ward, logged remote-video last resort; a shift without a witness does not publish). §12.5 statutory roster limits, §12.13 `overload.flagged`, §12.17 women's night-shift provisions, §12.25 chaperone gate, §12.27 matron reviews nursing/scan anomaly classes.
- §11.18: floor→ward/hall→room→bed hierarchy in the registry; gender-segregation is an IPD bed-board rule over the registry; nurse-call buttons are bought hardware landing as tasks in the ward's pooled queue; nursing-ratio indicator is a bed-class attribute.
- §11.15: nurse-validated hourly chart is the legal record; telemetry pre-fills; alarm silencing logged; titration adjustments log via eMAR.
- §11.19-C fix 8 (allergy re-screen sweeps queued eMAR doses), fix 23 (witness eligibility), fix 38 (Morse/Braden/pain scales day one of IPD — a **pre-IPD-go-live gate**); §11.19-B verbal orders with read-back and countersign window; §11.19-D fix 23 signed QR wristbands, fix 25 sealed-class propagation restricts handover views; §11.19-E fix 4 treating-team carve-out (eMAR context and bedside handover always see the sealed fact).
- §11.2 map 2: baby handovers hard-stop on paired-band double scan; map 10: transfusion bedside = two staff + wristband + unit barcode hard stop; §11.14: DNR flagged on chart + eMAR; per-intervention refusal documented.
- §16: clinical actions cap at T2–T3 forever; Coverage Resolver (T3, automation) and Turnover Dispatcher (T4, automation) are named roster members shipping with IPD.
- §11.11: completed nursing-procedure task → procedure charge; eMAR administration → drug charge; daily orphan report.

**Scope boundaries and neighbours (who owns what table):**

| Concern | Owner | This module's relation |
|---|---|---|
| Bed board, admission, transfer, discharge cascade, gender-segregation rule | IPD module (Plan 21 proposed) | consumes `patient.admitted/.transferred/.discharged`, `bed.assigned`; emits nurse assignment per bed |
| Roster authoring, publication gates, credential registry, on-duty picture | Workforce/roster module (Plan 20 proposed; S10 §12.15) | consumes `roster.published`, `roster.synced`; owns nurse↔patient assignment only |
| Drug orders, formulary, dispensing, ward stock ledger, NDPS *store* register | Formulary (built) + Pharmacy (Plan 16) | eMAR consumes `prescription.issued`/`order.placed(drug)`; ward-stock indents via P3 interface; ward NDPS custody ledger lives **here**, store ledger in pharmacy |
| ICU telemetry (TimescaleDB, CMS) | ICU edge (§11.15) | pre-fill source for vitals validation |
| Blood bank issue, cross-match | Blood bank module | bedside verification step and transfusion monitoring chart live here |
| Incident reporting (NABH), quality dashboards | Quality pack | nursing registers here emit `incident.reported`; quality pack owns the RCA workflow |
| Housekeeping/porter/turnover | Plan 19 | nursing tasks that need a porter spawn P5 tasks in their pool |
| Diet orders/kitchen | Diet module | nursing marks NPO/feed given as tasks |

**What this document adds:** the nurse-assignment and acuity model, the eMAR state machine at dose grain, the nursing task/bundle catalogue, EWS and escalation to residents (doc 10), structured ISBAR handover as an event-backed document, ward narcotics custody, bedside transfusion verification, nursing quality registers, KPIs/KRAs per nursing grade, and the agent placements.

---

## 2. Actors, roles & role cards

**S10 cards reused:** 20 Staff Nurse (ward) · 21 ICU Nurse · 22 OT Nurse (out of scope here except handover interfaces) · 23 Ward In-Charge (Sister In-Charge) · 24 Matron/Nursing Superintendent · Infection-Control Nurse (§11.19-C fix 25) · Quality Manager/NABH (card 37) · Medical Superintendent (card 39) · Duty Manager · Vitals-desk assistant (OPD; not ward).

**Proposed new cards (S10 lacks them):**

| # | Role | Reports to | Stations | Notes |
|---|---|---|---|---|
| N-A | **Nursing Supervisor (shift, floor)** | Matron | floor at night/weekend; 1 per 60–90 beds per shift | the night authority for float moves, witness pulls, ratio breaches; succession-chain post (S10 §12.16) |
| N-B | **Float-pool nurse** | Matron | any ward per shift assignment; competency tags (ICU/paeds/maternity) | assignment gated by competency tag; never ICU without ICU tag (S10 §10) |
| N-C | **Agency/contract nurse** | Nursing Supervisor | as float, with CLRA evidence (S10 §12.17/28) | time-boxed `temp_role.granted`; no narcotics-issuer role; witness eligibility only if council-registered and verified |
| N-D | **Student nurse (GNM/BSc) / intern** | clinical instructor + ward in-charge | supervised documentation and administration only | own login, **every act co-signed** by the supervising RN in the same transaction; never a witness; never high-alert or narcotics |
| N-E | **Nursing Assistant / GDA (patient-care attendant)** | Ward in-charge | hygiene, positioning, transport escort, feeding assistance, I/O recording | tasks only; cannot administer meds; can record I/O and positioning as tasks |
| N-F | **Nursing Educator / Clinical Instructor** | Matron | training matrix, competency sign-offs, student rotation | owns competency tags that gate assignments |
| N-G | **Ward Pharmacist / clinical pharmacist (interface)** | Pharmacy | eMAR reconciliation reviews, ward stock cycle counts (S10 §11: never the ward custodian) | not a nursing role; named because eMAR flows route to them |
| N-H | **Resident / duty doctor (doc 10)** | HoD | EWS escalation target, verbal orders, countersigns | consumer of `ews.escalated` |

**Agents/automations touching the module (see §9):** Coverage Resolver (T3 automation) · Missed-Dose Nudge (T1 automation) · Deterioration Watch (T0 report/T1 nudge automation) · Handover Note Drafter (T2 agent) · Turnover Dispatcher (T4 automation, interface only) · SLA Chaser (T1, kernel) · Fraud Sentinel (T0, scan-cluster analytics) · Digest Writer (T0) · Discharge Summary Drafter (T2, consumes nursing data).

**Shifts (corporate default, configurable):** 3 shifts (M 07–14, E 14–21, N 21–07) or 2×12 h for ICU; handover window 30 min overlap paid; statutory limits from S10 §12.5 (max 6 consecutive days, ≤ 48 h/week base, overtime capped — see O-3). Night skeleton: 1 RN per 10–12 general beds is **never** allowed below the NABH-configured floor (default general 1:8 day/1:10 night as a ceiling, ICU 1:1 ventilated/1:2 otherwise, NICU 1:2, HDU 1:3, step-down 1:4, maternity postnatal 1:6, paediatric 1:5) — proposed defaults per NABH 5th/6th edition guidance and INC norms; owner ruling O-1 on the exact table.

**Bundling (S10 §10 inherited, extended):** may bundle at night — ward in-charge ← senior staff nurse; educator ← off; nursing supervisor covers 2 floors max. **Must stay distinct:** narcotic ward custodian vs witness; administering nurse vs witness for high-alert; student vs any witness; ICU-tagged vs untagged for ICU beds; nurse who documents a fall vs the nurse who verifies the post-fall assessment (quality integrity); incident reporter vs incident reviewer.

**SoD hard pairs added (RBAC-enforced, `sod.violation_blocked`):** ward narcotics custodian / ward narcotics cycle-counter · high-alert administering nurse / witness · transfusion checker 1 / checker 2 · restraint-applying nurse / restraint-review doctor · handover outgoing / handover incoming (same person cannot be both, even across a double shift — the double-shift case requires supervisor acknowledgment).

---

## 3. Core flows as workflow definitions

All lifecycles below are **workflow definitions** (§10.2), versioned, owner-activated; module tables mirror state only. Event names in the existing catalog are used as-is; **NEW** marks proposals.

### 3.1 Nurse-patient assignment per shift (P5 overlay on P1)

States: `unassigned → proposed → assigned → active → handed_over → released`. Triggers: `roster.published` + `bed.assigned`/`patient.admitted` create an *assignment slot* per occupied bed per shift. The in-charge (or Coverage Resolver draft, §9) proposes the map; publication validates ratio per unit acuity, competency tags, gender preference for female wards (see §3.8), continuity (same nurse as prior shift preferred), and witness availability.

- Allowed roles: propose = ward in-charge, nursing supervisor, Coverage Resolver (T3 draft); confirm = ward in-charge; override ratio breach = nursing supervisor with reason (evented `ratio.breached` NEW).
- SLA: assignment map confirmed ≥ 30 min before shift start; at shift start with no map → auto-carry previous map + `sla.breached` + supervisor page.
- Events: `nurse_assignment.made` NEW · `nurse_assignment.changed` NEW (mid-shift reassign, reason) · `nurse_assignment.released` NEW · `ratio.breached` NEW · `float.assigned` NEW · `overload.flagged` (existing).

```
[roster.published]+[bed occupied] -> unassigned --propose--> proposed --confirm--> assigned
assigned --shift starts--> active --handover.completed--> handed_over --shift ends--> released
active --mid-shift departure--> unassigned(tasks->pool, handover force-escalates)
```

### 3.2 eMAR dose lifecycle (P3 tail + P5)

Each order line × schedule slot = one **dose task**. States: `scheduled → due → (in_window) → administered | held | refused | missed | not_available | cancelled`; sub-flow for high-alert: `due → witness_requested → witnessed → administered`.

Five rights enforced in-transaction: right patient (signed wristband QR scan, §11.19-D fix 23), right drug (unit-dose barcode or ward-stock batch scan; free-text confirm allowed only under downtime or non-barcoded item with reason), right dose (order snapshot compared; dose edits require doctor order or titration range), right route, right time (window default ±60 min, STAT ±15 min, insulin/anticoagulant ±30 min; configurable per drug class).

- Allowed roles: administer = RN with `nursing.emar.administer`; student = only with co-sign in same transaction; witness = eligible RN (S10 §11). Hold = RN with reason code (NPO, vitals parameter, patient off-ward) — hold beyond 1 window auto-notifies prescriber. Cancel = prescriber or pharmacist on order discontinue.
- SLA per state: `due` → `administered` within window; beyond window = `medication.dose_late` NEW (recorded, not paged); beyond window + grace (default 60 min) with no action = `medication.missed` (auto, actor=system, reason `no_action`), pages assigned nurse T1; ×2 in a shift for the same patient → in-charge; critical-class drug (anti-epileptics, anticoagulants, insulin, antibiotics first dose, immunosuppressants) missed → resident too.
- Events: `medication.administered` · `medication.missed` · `medication.refused` · `medication.held` NEW · `medication.witnessed` NEW · `medication.dose_late` NEW · `medication.not_available` NEW (feeds pharmacy indent, P3) · `titration.adjusted` · `adr.reported` · `allergy.recorded` (re-screen sweep) · `charge.posted` (P6 read model).

```
scheduled -> due -(scan patient, scan drug, [witness])-> administered -> charge.posted
        \-> held(reason) -> due(next) | cancelled
        \-> refused(reason, counselling, doctor informed?)
        \-> not_available -> material.requested(P3) -> due
        \-(window+grace, no action)-> missed(system) -> nudge ladder
```

### 3.3 Nursing task & bundle (P5)

Generic P5 states: `created → assigned → accepted → in_progress → completed → verified` with `escalated` overlay. Task sources: care-plan bundles (auto-generated on assessment score), orders (dressing, catheter care, physiotherapy assist, NPO), nurse-call button, doctor rounds, transfer/discharge checklists, device counters (IV cannula day-3 review, urinary catheter daily necessity review, central line bundle), vitals schedules, patient education. Verification required on: restraint checks, pressure-injury turns for Braden ≤ 12, transfusion monitoring, post-fall assessment, isolation precautions.

Events: `task.created/.assigned/.accepted/.completed/.verified/.escalated` (existing) · `bundle.activated` NEW · `bundle.due` NEW · `line.inserted` / `line.removed` NEW (IV/central/arterial) · `catheter.inserted` / `catheter.removed` NEW · `wound.assessed` NEW · `dressing.done` NEW · `nurse_call.raised` NEW (from bought hardware via edge) · `education.delivered` NEW.

### 3.4 Vitals charting & early-warning escalation

Vitals schedule = frequency per order/acuity (default q4h general, q2h post-op 12 h, q1h HDU, continuous ICU with hourly validation). Each record computes a **NEWS2** (adult; MEWS optional config) / **PEWS** (paediatric) / **MEOWS** (obstetric) score in a deterministic rule, versioned in the KPI/formula registry style.

States of a vitals slot: `due → recorded → scored → (escalated → acknowledged → reviewed) | closed`. Escalation ladder (proposed NABH-aligned default): NEWS 0–4 routine · 5–6 or any single 3 → inform resident within 30 min, repeat vitals q1h · ≥ 7 → resident **and** ICU registrar/rapid-response within 15 min, continuous monitoring, in-charge informed · unacknowledged at SLA → next on ladder → duty manager (dead-end rule §11.19-C fix 11). Late vitals: `vitals.recorded` with `occurred_at`< `recorded_at` beyond 15 min = `late_entry.flagged`.

Events: `vitals.recorded` · `vitals.danger_flagged` · `ews.scored` NEW · `ews.escalated` NEW · `ews.acknowledged` NEW · `ews.reviewed` NEW · `data_gap.flagged` (ICU) · `alarm.escalated` (ICU).

### 3.5 Nursing assessment & care plan (P1 overlay)

Admission nursing assessment within 2 h of arrival to ward (NABH): Morse fall, Braden, pain (NRS/FLACC/Wong-Baker), nutritional screen (MUST), VTE risk (Caprini/Padua — nursing prompts, doctor orders), IPD-specific (restraint need, suicide risk screen, elopement risk, allergy re-confirmation, own-meds capture, valuables). Reassessment triggers: every shift for pain, every 24 h for Braden/Morse, on transfer, on event (fall, condition change). Score thresholds **auto-activate bundles** (Morse ≥ 45 → fall bundle: bed low, rails, call-bell reach, yellow band, hourly rounding tasks; Braden ≤ 18 → pressure bundle: 2-hourly turns, support surface request, dietician referral task).

Events: `assessment.recorded` NEW (type, score, version of scale) · `care_plan.activated` NEW · `care_plan.updated` NEW · `bundle.activated` NEW · `restraint.applied` / `restraint.reviewed` / `restraint.released` NEW.

### 3.6 Shift handover (ISBAR, per patient, event-backed)

States per patient per shift boundary: `pending → drafted → flagged → acknowledged → completed`; escalate on `flagged` unacknowledged ≥ 20 min after shift start. Content is **assembled** deterministically from the spine (last 12 h events: EWS trend, doses missed/held, open tasks, pending results, lines/catheters with day counts, isolation, DNR, allergies, restraint, fall/pressure bundle status, pending discharge, deposit alerts if the nurse has billing scope — usually not) into an ISBAR skeleton; the outgoing nurse adds Situation/Recommendation free text; T2 drafter (§9) may pre-write the narrative from the same fact sheet under copilot design law "narrate never originate". Bedside verbal handover is the human step; the system records who, when, and that both scanned the patient band at bedside (**bedside scan optional day one, KPI-visible; O-5**).

Events: `handover.initiated` NEW · `handover.flagged` NEW · `handover.acknowledged` NEW · `handover.completed` (existing) · `handover.escalated` NEW (or `task.escalated` with type).

```
shift T-30min: pending -(assemble)-> drafted -(outgoing adds ISBAR, flags)-> flagged
flagged -(incoming ack per patient, at bedside)-> acknowledged -(in-charge closes ward)-> completed
flagged -(20 min past shift start, no ack)-> escalated(in-charge -> supervisor)
```

### 3.7 Ward narcotics custody (NDPS, two-key)

Ward sub-store for NDPS/Schedule X/H1 items: `indented → issued_by_pharmacy → received_on_ward(two-person count) → in_custody → administered(witnessed) | wasted(witnessed) | returned → balanced(shift count)`. Two-key = custodian (in-charge/shift custodian) + witness, both authenticated with second factor (§14). Running balance per item per ward; shift-change count is a handover gate for the ward (not per patient). Discrepancy → `narcotic.discrepancy_flagged` NEW → supervisor + pharmacist + MS ladder, register line, incident.

Events: `material.requested/.issued/.returned` (existing, P3) · `narcotic.ward_received` NEW · `narcotic.administered` NEW (paired with `medication.administered`) · `narcotic.wasted` NEW · `narcotic.balanced` NEW · `narcotic.discrepancy_flagged` NEW.

### 3.8 Bedside transfusion verification (map 10 interface)

`unit.issued → arrived_on_ward(cold-chain time check) → bedside_verified(2 staff + wristband + unit barcode + ABO/consent check) → transfusion.started → monitored(vitals at 0/15/30 min, then q30) → transfusion.completed | transfusion.reaction_flagged`. 30-min rule from issue to start (default; configurable) — breach blocks start without a doctor override.

Events: existing transfusion.* · `transfusion.bedside_verified` NEW · `band.pair_verified` reused for mother-baby.

### 3.9 Nursing quality registers (incident-fed)

Fall, pressure injury (stage at detection, present-on-admission flag), restraint, needle-stick/sharps, patient/attendant violence, medication error (near-miss/error), transfusion reaction, DVT, absconding, unplanned extubation (ICU) — each is a first-class register table (§7) written from events, each opens an incident workflow in the quality pack.

Events: `incident.reported` (existing) · `fall.recorded` NEW · `pressure_injury.recorded` NEW · `needle_stick.reported` NEW · `violence.reported` NEW · `medication_error.recorded` NEW.

**Standard corporate variants covered:** 2×12 h ICU shifts; per-patient indent vs ward-stock dispensing; "sister-only" female wards; PMJAY wards with no attendant limits; step-down HDU with mixed ratios; day-care (mini-OT, chemo) using the same eMAR with a 1-day encounter; agency nurses for surge.

---

## 4. Data model sketch

Module folder `nursing/` (own schema). All tables carry `id` ULID, `site_id`, `created_by/at`, `updated_by/at`; clinical rows carry `occurred_at` + `recorded_at`.

| Table | Key columns (sketch) |
|---|---|
| `nurse_shift_assignments` | shift_id, unit_resource_id (ward/hall, Plan 13), nurse_user_id, role_tag (primary/secondary/float/student/supervising_rn), patient_id, encounter_id, bed_resource_id, valid_from/to, reason_changed, workflow_instance_id |
| `unit_acuity_snapshots` | unit_resource_id, shift_id, census, acuity_points (sum of per-patient acuity), required_rn, rostered_rn, ratio_ok bool, breach_reason |
| `patient_acuity` | encounter_id, computed_at, level 1–5 (rule: EWS, devices, isolation, mobility, meds count, post-op day), inputs jsonb |
| `emar_orders_snapshot` | order_line_id (FK to prescribing), encounter_id, drug, dose, route, freq, start/stop, high_alert bool, controlled_class (NDPS/X/H1/none), prn bool, titration_range jsonb, snapshot_version |
| `emar_doses` | order_snapshot_id, scheduled_at, window_start/end, status, administered_at, administered_by, witnessed_by, patient_scan_token_id, drug_scan (batch/serial), dose_given, site, reason_code, note, late_entry bool, workflow_instance_id, charge_event_id |
| `emar_reconciliations` | encounter_id, stage (admission/transfer/discharge), lines jsonb (home meds, decisions continue/hold/stop/substitute), pharmacist_id, doctor_id, completed_at |
| `vitals_records` | encounter_id, occurred_at, recorded_at, source (manual/monitor_prefill/validated), values jsonb (FHIR Observation shape, LOINC-coded), device_resource_id, validated_by |
| `ews_scores` | vitals_record_id, scale (NEWS2/PEWS/MEOWS), version, score, band, escalation_workflow_instance_id |
| `nursing_assessments` | encounter_id, type (morse/braden/pain/must/vte/suicide/restraint/elopement), scale_version, score, items jsonb, assessed_by, cosigned_by (student case) |
| `care_plans` / `care_plan_items` | encounter_id, problem, goal, interventions[], bundle_id, active, reviewed_at |
| `bundles` (config) | code, trigger_rule (assessment type + threshold), tasks_template jsonb, verification_required |
| `nursing_tasks` | mirror of workflow instance: encounter_id, type, due_at, assigned_to, pool_id, priority, verify_by_role, source_ref (order/bundle/nurse_call/device_counter) |
| `device_lines` | encounter_id, kind (peripheral IV/central/arterial/urinary catheter/NG/drain/ET tube), site, inserted_at, inserted_by, removed_at, reason, day_counter (generated), bundle_id |
| `wounds` / `wound_assessments` | encounter_id, location, type, stage, size, photo_ref (object storage, sealed-class aware), assessed_at |
| `handovers` / `handover_items` | shift_boundary_id, unit, patient encounter_id, outgoing_id, incoming_id, isbar jsonb (assembled facts + free text), flags[], bedside_scan bool, acknowledged_at, draft_provenance (model id/prompt ver/hashes if T2 used) |
| `ward_narcotic_ledger` | ward_resource_id, item_id, batch, txn_type (receive/administer/waste/return/count), qty, balance_after, custodian_id, witness_id, patient_id?, emar_dose_id?, second_factor_ref |
| `ward_stock_par` | ward_resource_id, item_id, par, current (read model from pharmacy issues − consumption) |
| `transfusion_bedside_checks` | transfusion_id, checker1_id, checker2_id, wristband_scan, unit_scan, abo_match bool, consent_ref, started_at, vitals refs |
| `patient_education` | encounter_id, topic, language, method, delivered_by, understood (teach-back) bool, materials_ref |
| Registers (§7): `fall_register`, `pressure_injury_register`, `restraint_register`, `needle_stick_register`, `violence_register`, `medication_error_register`, `ward_nd ps_register` (view over ledger + statutory columns) | each with incident_id FK |
| `nursing_notes` | encounter_id, occurred_at, recorded_at, author_id, cosigned_by, note (immutable; addenda as new rows referencing parent), late_entry bool, verbal_order_id? |
| `verbal_orders` | encounter_id, doctor_id, nurse_id, read_back bool, content, recorded_at, countersigned_at, workflow_instance_id |

**Registry kinds needed (Plan 13):** ward/hall/room/bed (exist), `device` (monitors, infusion pumps, wristband printers, tablets as assets), `store` (ward sub-store, narcotic cupboard as a store child). No new kind proposed; "ward narcotic cupboard" = `store` with attribute. **Proposed attribute on ward resource:** `nursing_unit_type` (general/HDU/ICU/NICU/maternity/paeds/psych/isolation) driving the ratio table, and `female_only` bool.

**FHIR shapes:** vitals → `Observation`; eMAR dose → `MedicationAdministration` (status completed/not-done with `statusReason`); assessments → `Observation` with scale codes / `RiskAssessment`; care plan → `CarePlan`; tasks → `Task`; handover → `Composition` (ISBAR sections) + `Communication`; device lines → `DeviceUseStatement`/`Procedure`.

**Retention (proposed):** MAR, nursing notes, vitals, handovers, assessments = part of the medical record → as per hospital MRD policy (IPD records 10 years adult; minors until age 21 + 3; MLC permanent — align with Clinical Establishments Act state rules and NABH); NDPS ward register 2 years minimum after last entry (NDPS Rules 1985, r. 67 — hospital policy keeps 5); needle-stick register 5 years (occupational); incident registers 5 years. Event log follows §11.18 sweep 10 with legal holds.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion · ruling ref**.

### 5.1 Identity & wrong-patient
- **N-ID1** Two Ram Kumars in beds 12 and 14, same ward, similar age → dose task cannot be opened by bed number; only wristband scan of the *task's* patient unlocks; bed-tile tap shows photo + UHID + DOB before scan → test: scanning bed-14's band on bed-12's task refuses with `wrong_patient` and logs `band.pair_mismatch`-class event.
- **N-ID2** Wristband torn/illegible/removed for MRI → nurse requests reprint from ward station (evented, old token rotated, §11.19-D fix 23); until then admin path = two-identifier verbal check + second RN co-sign, flagged `identity_manual` → test: reprint revokes old signature; manual path requires co-sign row.
- **N-ID3** Photographed wristband on an attendant's phone used to "scan" → signed payload with rotation; scanner verifies signature + issued-at; stale/cloned fails → test: replayed token after reissue fails.
- **N-ID4** Unconscious unknown patient from ER (UHID "UNKNOWN-0421") → wristband issued on temporary identity; when identity resolved, `patient.merged` re-links all doses/vitals; MAR shows alias history → test: merge carries eMAR rows; no dose duplicated.
- **N-ID5** Mother-baby: breast-feeding handover, twins → paired band double scan hard stop (map 2) for every feed/return; NICU twins with near-identical names → task cards colour-differ and show "Twin A/Twin B" + birth-order → test: scanning mother's band with Twin B's task when Twin A intended refuses.
- **N-ID6** Patient transferred to another bed mid-shift, task list still shows old bed → task carries `patient_id` not bed; bed shown as live lookup; stale bed on card marks "moved → B-22" → test: `patient.transferred` refreshes worklist within 2 s.
- **N-ID7** Two patients swapped beds physically without system transfer (attendants "adjusted") → scan at bedside detects band ≠ expected bed occupant; warns, allows administration (right patient is what matters), raises `bed.occupant_mismatch` NEW task for in-charge → test: dose succeeds against the *scanned* patient; mismatch task created.
- **N-ID8** Sealed/VIP patient on ward under alias → bedside surfaces show alias + photo; eMAR shows the real allergy/DNR facts (E-4 carve-out); handover to a nurse outside the treating team shows alias-only → test: seal carve-out access evented.
- **N-ID9** Wrong patient scanned *and* correct drug for that other patient also due now (both on paracetamol) → system still refuses because task ≠ scanned patient; nurse must open the scanned patient's own task → test: no cross-task auto-match.
- **N-ID10** Day-care (mini-OT) patient has no admission wristband → day-care encounter prints a band at check-in; eMAR requires it like IPD → test: mini-OT eMAR dose without band scan refused unless downtime mode.

### 5.2 Timing, concurrency & race
- **N-T1** Two nurses open the same dose task on two tablets (float and primary) → optimistic lock; second save refuses "already administered by X at hh:mm" → test: concurrent completes → exactly one `medication.administered`.
- **N-T2** Order discontinued by doctor at 09:58, dose due 10:00 already scanned at 09:57 → administration in flight completes; system posts `medication.administered` with `order_state_at_scan=active` and flags prescriber "given after stop" → test: no silent loss; flag event emitted.
- **N-T3** STAT order at 03:10 while nurse is in a witnessed narcotic transaction → STAT bubbles to top with sound; witness transaction is not interrupted (it's atomic) → test: worklist order; no half-committed narcotics txn.
- **N-T4** Clock drift on a tablet (offline 8 h, clock wrong by 40 min) → server timestamps `recorded_at`; `occurred_at` from device flagged if drift > 5 min (`clock.drift_flagged`) → test: buffered dose replay uses server clock for recorded_at.
- **N-T5** Shift boundary at 21:00; dose due 20:50 window until 21:50 → task belongs to whoever is *assigned* at the moment of action; outgoing nurse's unadministered due doses appear in the handover as flags → test: handover item lists dose; incoming nurse's worklist contains it after ack.
- **N-T6** Vitals frequency changed q4h → q1h mid-shift by resident → schedule regenerates from the next slot; already-recorded slots preserved → test: no duplicate slots; next due within 60 min.
- **N-T7** PRN paracetamol given 14:00, second request 17:00 (min interval 6 h) → refuses with countdown; override requires doctor order → test: interval enforced across nurses and across a transfer.
- **N-T8** Insulin sliding scale depends on a glucometer reading recorded 90 min ago → task demands fresh CBG (≤ 30 min) before enabling administration → test: stale reading blocks; new POCT value unlocks.
- **N-T9** Handover ack race: incoming nurse acknowledges patient list while outgoing still editing → acknowledging locks the item version; later edits create addendum requiring re-ack → test: version conflict → addendum, not overwrite.
- **N-T10** Daylight: none in India, but NTP outage → time-truth sweep #1: drift alarm; eMAR windows compute on server time only → test: tablet clock irrelevance.
- **N-T11** Antibiotic q8h started at 23:00; discharge at 07:00 with dose due 07:00 → discharge cascade (§11.2 step 2) shows open dose; nurse gives or documents "not given — discharged" → test: no `missed` generated by system after discharge; state `cancelled(discharged)`.
- **N-T12** Two float nurses assigned same patient by two supervisors → assignment table unique (shift, patient, role_tag=primary) → second write refuses → test: constraint.

### 5.3 Partial failure & downtime
- **N-D1** Server down at 22:15 during night med round → downtime declared (floor-scoped); tablets show last-synced worklist read-only; **paper MAR pre-printed at every shift start** (auto-print job, QR per page); doses charted on paper; backfill screen after `downtime.ended` requires per-dose `occurred_at` and batch, dual-stamped → test: backfilled doses carry `late_entry=false` (downtime flag) and `downtime_id`.
- **N-D2** Wi-Fi dead in one ward only, server fine → tablet offline buffer (IndexedDB) queues administrations with local scan verification (signed band tokens verifiable offline using cached public key); on reconnect, replays idempotently (idempotency key = dose_id + device) → test: replay twice → one event.
- **N-D3** Offline buffer holds a dose for 6 h; meanwhile the order was stopped → replay is accepted (fact happened) and flagged `given_after_stop_offline` to prescriber → test: flag emitted, dose not rejected.
- **N-D4** Tablet battery dies mid-scan → nothing committed until final confirm; partial state discarded → test: no orphan `witness_requested`.
- **N-D5** Wristband printer down at admission → admission desk prints from any other ward's printer or hand-writes temporary band + `identity_manual` mode for the patient until printed; task to print → test: patient flagged until first signed scan.
- **N-D6** Power loss and network loss whole building (UPS dies) → PBX/paper; downtime kit's pre-printed MAR/vitals sheets per ward per shift; nurse-in-charge declares floor downtime via phone to duty manager who declares in-system (or later backfills the declaration itself with the paper time) → test: `downtime.declared` accepts backdated `occurred_at`.
- **N-D7** Barcode on a ward-stock ampoule missing (loose ampoules) → manual item pick with reason `no_barcode` (KPI-visible); pharmacy nudged to relabel → test: reason code mandatory.
- **N-D8** Agent runtime (Missed-Dose Nudge) crashed → SLA ladder in kernel still records `medication.missed` and `sla.breached` (automation is additive; fail-open) → test: kill switch on, ladders still fire.
- **N-D9** Notification gateway down; resident cannot be paged for NEWS 8 → escalation falls to PBX call task on the in-charge's worklist + loud in-app banner; dead-end fallback to duty manager → test: `notification.failed` triggers alternate route.
- **N-D10** Restore from backup loses last 20 min of doses → reconciliation report lists doses scanned on tablets (local logs) but absent on server → re-entry as backfill → test: tablet keeps local audit log 72 h.

### 5.4 Money (billing, refunds, payers, packages, TPA)
- **N-M1** Dose administered → `charge.posted` for the drug (per-patient indent already billed at issue; ward-stock items bill *at administration*) → test: ward-stock dose posts exactly one charge; indent-issued dose posts none (already billed) — the dispensing mode on the order snapshot decides.
- **N-M2** Dose refused/wasted from ward stock (ampoule opened, half discarded) → full ampoule charged? Corporate default: **charge the opened unit** with wastage reason; no charge if dose never opened → test: refused-before-opening posts no charge; wasted-after-opening posts unit.
- **N-M3** Patient's own meds administered → eMAR row `unbilled=true`, no charge → test: orphan report excludes own-meds rows.
- **N-M4** Nursing procedure (catheterisation, dressing large) completed → procedure charge from `task.completed(verified)`; PMJAY package patient → charge posts to package with `package.allowance_consumed`, never to patient → test: payer branch.
- **N-M5** Payer switches mid-stay (self → TPA approved on day 3) → charges already posted stay; `payer.switched` triggers nothing in nursing; MAR is unaffected → test: no eMAR mutation on payer switch.
- **N-M6** Deposit exhausted (E7) → **care never stops**: eMAR never checks the bill; a deposit banner shows to in-charge only → test: dose administration path has no billing dependency (lint: nursing module imports no billing interface for writes).
- **N-M7** Handover drafter agent per-shift inference cost → per-ward budget, falls back to deterministic skeleton → test: budget exceeded → skeleton only.
- **N-M8** Attendant disputes a charged injection "never given" → line links to `medication.administered` with scan timestamps, nurse, witness; attendant bill view shows time given → test: charge line carries event id; verification view resolves.
- **N-M9** Agency nurse hours vs tasks — CLRA invoice reconciliation (S10 §12.28) → activity-attendance mismatch report includes agency tags → test: `activity_attendance.mismatch` includes contractor id.
- **N-M10** Blood unit returned unused after bedside check fails (ABO mismatch caught) → no transfusion charge; unit returns to bank within 30 min or is discarded (cost centre: blood bank wastage) → test: return event terminates on a cost centre.

### 5.5 Consent, legal, MLC, minors, unconscious
- **N-L1** Patient refuses a dose (competent adult) → `medication.refused` with reason, counselling note, doctor informed task; repeated refusal → treatment-refusal documentation (§11.14) → test: 3rd refusal same drug opens refusal workflow.
- **N-L2** Minor (14) refuses injection, parent consents → administer per guardian consent; note both; POCSO-sensitive exams need chaperone (`chaperone.present`) → test: guardian ref from patient master (fix 31) required.
- **N-L3** Unconscious patient, no attendant, needs restraint for ET tube safety → restraint order by doctor (emergency verbal permitted, countersign 1 h), 2-hourly checks tasks with verification, 24 h review → test: restraint without order beyond 1 h escalates to MS.
- **N-L4** MLC patient (assault) on ward: nursing notes have evidentiary weight → notes immutable, addenda only; any late entry flagged; export for police via records-request workflow, never from ward screen → test: no delete/edit path on nursing_notes.
- **N-L5** Verbal order at 02:00 for morphine → nurse records read-back; second nurse witness for narcotics; doctor countersigns within 24 h (config); uncountersigned at window → escalates to HoD; the MAR row references the verbal order id → test: `verbal_order.recorded` → `.countersigned` linkage; escalation fires.
- **N-L6** DNR flagged; Code Blue button pressed by a junior → code team page still goes (button cannot know competence) but the bedside tile shows DNR banner immediately; the resus decision is human → test: DNR banner on every bedside surface within 1 s of `patient.flag`.
- **N-L7** Student nurse administers under supervision → dual identity on the row (`administered_by=student`, `cosigned_by=RN`) in one transaction; MAR print shows both; the KPI attributes to the RN → test: student without co-sign refused.
- **N-L8** Non-literate patient's consent for transfusion → thumb + witness + vernacular form (§11.19-B); bedside check refuses if consent ref absent → test: transfusion start blocked without consent ref; emergency override by doctor evented.
- **N-L9** Patient records a nurse on phone alleging rough handling → violence/grievance register entry from either side; nurse's contemporaneous notes protect both; CCTV retention hold task → test: `violence.reported` opens hold task for security card 34.
- **N-L10** Death on ward at 04:30 → vitals/tasks auto-cancel after `patient.deceased`; last-dose reconciliation; narcotics on hand for that patient returned/wasted witnessed → test: no `missed` after death; pending narcotic tasks convert to return tasks.
- **N-L11** LAMA at 23:00 with IV cannula in situ → discharge checklist forces `line.removed` or documented refusal to remove with counselling → test: LAMA path blocks on open device lines without reason.
- **N-L12** Psychiatric patient elopement risk → elopement bundle: hourly rounding, gate alert, pass revoke on `patient.absconded` → test: security gate scan of the patient's own band raises alarm.

### 5.6 Staff absence, overload, handover
- **N-S1** Two of six night nurses no-show at 20:45 → roster gap visible; Coverage Resolver drafts float/agency/on-call-back options; supervisor approves (T3); ratio breach recorded if unresolved by 21:00; elective transfers into the ward shed → test: `ratio.breached` + `overload.flagged`; approved fix emits `nurse_assignment.changed`.
- **N-S2** Nurse leaves mid-shift (family emergency) → in-charge releases her assignments; tasks return to pool; **forced handover** to the in-charge with flags; doses due in next 60 min highlighted → test: `nurse_assignment.released` + pool contains her tasks within 1 s.
- **N-S3** Same nurse works double shift (M+E) → handover step still required (self-handover disallowed): supervisor acknowledges instead; fatigue counter increments; second double in a week blocks roster publication (O-3) → test: `handover` with outgoing==incoming refused.
- **N-S4** Only one RN on floor at night; high-alert insulin due → witness must be pulled cross-ward (eligible list shown with distance/floor); last resort remote video witness logged → test: witness picker excludes students/GDAs; remote witness stores video ref.
- **N-S5** In-charge on leave; no one holds `ward.in_charge` role → escalation resolves to nursing supervisor (role holder), never a named person → test: ladder resolution with empty role → next rung.
- **N-S6** New joiner day 1 assigned 8 patients incl. 2 on chemo → competency tag missing → assignment refused for chemo patients; educator notified → test: tag gate.
- **N-S7** Nurse's login credential (RN registration) expires mid-employment → `credential.blocked`: she cannot administer; her patients reassigned; no clinical acts until renewed → test: administer permission revoked within one roster sync.
- **N-S8** Overloaded ward: acuity points/RN exceed threshold two shifts running → `overload.flagged` to matron; KPI reports for that ward carry load context; never auto-punitive → test: fairness metadata on every rate KPI export.
- **N-S9** Handover not acknowledged for 3 patients 25 min into shift (incoming nurse busy with a crashing patient) → escalation to in-charge who can acknowledge on her behalf with reason → test: proxy-ack recorded with reason and both identities.
- **N-S10** Agency nurse's `temp_role` expires at 07:00 while she is mid-administration → grant expiry is graceful: in-flight transaction completes, next action blocked → test: expiry at boundary.
- **N-S11** Needle-stick at 03:00 → one-touch protocol: wash/first aid card, source patient serology check ordered (consent), PEP within 2 h task to ER doctor, register entry, HR/insurance task, 6-week/3-month follow-up reminders → test: `needle_stick.reported` creates 4 tasks with SLAs.
- **N-S12** Attendant assaults a nurse → panic button (nurse-call long press) → security task priority critical, supervisor page, `violence.reported`, incident, police MLC path if injury, staff support task → test: panic path < 5 s to security queue.
- **N-S13** Female ward at night rostered with only male nurses → roster gate refuses publication for `female_only` unit without ≥1 female RN (S10 §12.25 analogue); daytime male nurse performing intimate care requires chaperone → test: publication blocked with reason.
- **N-S14** Nurse fatigue: 7 consecutive nights → statutory validator blocks roster; emergency override by matron evented with expiry → test: `roster.blocked` reason=consecutive_shifts.

### 5.7 Equipment failure
- **N-E1** Infusion pump alarms occlusion; pump not interfaced → nurse records pump event as task note; biomedical ticket via P5 with 30-min SLA if critical bed → test: maintenance task priority class.
- **N-E2** Monitor pre-fill sends BP 300/200 (probe artefact) → validation screen shows outlier flag; nurse corrects with reason; raw retained → test: validated ≠ raw, both stored.
- **N-E3** Scanner on a tablet fails → fallback camera scan; then manual 2-identifier mode with co-sign, KPI-visible → test: reason codes cascade.
- **N-E4** Wristband printer prints unreadable QR (ribbon) → scanner test-print at each admission; failed scan on first attempt → reprint; printer maintenance task → test: first-scan-fail rate per printer is a device KPI.
- **N-E5** Nurse-call hardware controller offline → `interface.down` for the ward; in-charge informed; hourly rounding tasks auto-tightened to 30 min for fall-risk patients → test: bundle intensification rule.
- **N-E6** Oxygen cylinder on transport bundle low → ventilated transport checklist computes O₂ minutes; refuses to close checklist if < trip estimate ×1.5 → test: calculation in checklist.
- **N-E7** Narcotic cupboard electronic lock fails → mechanical key protocol; two-person entries recorded manually then backfilled; cupboard `device` status `degraded` → test: manual-mode entries carry witness.
- **N-E8** Tablet stolen from ward → device revoked (MDM), offline buffer encrypted with device key, sessions invalidated; incident → test: revoked device replay refused.

### 5.8 Data quality, late-arriving, backdated
- **N-Q1** Nurse charts 06:00 vitals at 08:30 → allowed; `late_entry.flagged`; handover shows the late mark; KPI counts as late → test: dual stamps; no true backdating (recorded_at immutable).
- **N-Q2** Weight missing for paediatric dose check → eMAR task shows "weight required" and blocks weight-based drugs until weight recorded (vitals desk or ward) → test: block on missing weight for mg/kg orders.
- **N-Q3** Allergy recorded on ward *after* doses queued → re-screen sweep (fix 8) flags queued doses; task marked `hold_pending_review` → test: sweep runs within 5 s; flagged dose cannot be administered without prescriber ack.
- **N-Q4** Duplicate vitals entry (two nurses both record 10:00 set) → both retained; EWS uses the latest recorded_at; duplicate flagged for cleanup → test: no averaging.
- **N-Q5** NEWS scale version upgraded (NEWS2 → local variant) → scores store scale version; historical not rescored; KPI registry semver bumps → test: version on every row.
- **N-Q6** Order snapshot differs from live order after dose edit by doctor (dose 500 → 650 mg) → new snapshot version; pending doses regenerated; administered ones keep old snapshot → test: audit shows which version each dose used.
- **N-Q7** Nurse note "patient comfortable" pasted 12 times (copy-forward) → near-duplicate note detector (T0 diagnostic to in-charge, not blocking) → test: similarity report.
- **N-Q8** Braden reassessment overdue 30 h → task overdue, `sla.breached`, recorded not paged; in-charge digest → test: alert selectivity.
- **N-Q9** I/O chart totals at 24 h with missing entries → chart shows gaps explicitly ("not recorded 14:00–18:00"), never zero (copilot law 6 "blank is not a state") → test: render four-state.
- **N-Q10** Same drug ordered twice by two doctors (duplicate therapy) → prescribing warns; if both active, eMAR shows both with duplicate badge; pharmacist review task → test: badge + task.
- **N-Q11** Backfilled downtime doses entered by a nurse who was not on that shift → allowed with `entered_on_behalf_of` + reason; report to in-charge → test: field mandatory when actor ∉ shift roster.

### 5.9 Fraud, leakage, gaming
- **N-F1** Nurse scans all 8 patients' bands at station at 09:00 and "administers" all doses in 3 minutes → scan-time clustering anomaly (S10 §2 integrity rule) → Fraud Sentinel diagnostic to matron; bedside geofence optional (BLE beacon per room, O-6) → test: cluster detector fires on ≥ 5 administrations < 60 s apart across ≥ 3 patients.
- **N-F2** Photocopied/second wristband kept at station to scan later → signed token includes nothing about location; countermeasure is timing analytics + random bedside audits (quality) + optional beacon → test: audit-sample task generated weekly.
- **N-F3** Ward stock consumption without administration (ampoules disappear) → daily variance: issued − administered − wasted − returned − counted = leakage flag → test: variance report per ward per item.
- **N-F4** Narcotic "wasted" repeatedly by same nurse-witness dyad → dyad analytics (fix 30) report; blind recount by pharmacy → test: dyad report class.
- **N-F5** Marking dose `refused` to hide missed doses → refused rate per nurse vs ward baseline; patient-side micro-survey ("did you refuse?") sampling for high refusers → test: refused-rate outlier report.
- **N-F6** Handover acknowledged blindly in bulk → per-patient ack required; bulk ack disabled above 3 patients; time-per-ack metric → test: UI cannot ack all.
- **N-F7** Procedure task completed but never done (billing leakage inverse — overbilling) → verification sampling on charged tasks; attendant bill shows tasks; disputes route to billing supervisor → test: sample task.
- **N-F8** Agency nurse shares login with colleague → no shared accounts; PIN/badge switching; concurrent sessions from two tablets on the same user flagged → test: concurrent-device anomaly.
- **N-F9** Student's supervising RN co-signs from another floor without presence → co-sign requires RN's own PIN on the *same device* within 2 min → test: cross-device co-sign refused.
- **N-F10** Timing gaming: nurse marks dose "held — NPO" to dodge late KPI → held reasons audited against diet orders (NPO must exist) → test: held(NPO) without NPO order flags.

### 5.10 Privacy, sealed records, VIP, staff-as-patient
- **N-P1** Staff nurse admitted to her own ward → confidential class; colleagues on treating team see; others do not; her own login cannot open her record (self-access block; MRD request path) → test: self-read refused + evented.
- **N-P2** HIV status of patient needed for needle-stick source testing → consent flow per NACO guidelines; result to occupational health, not to ward chart broadly → test: sealed result scope.
- **N-P3** Handover printout left at station → prints carry alias for sealed, QR, and are watermarked with printer id + user; printing handover sheets is discouraged (tablet), allowed with `document.release_logged` → test: print event.
- **N-P4** WhatsApp "dose given" notification to attendant reveals psychiatric drug → outbound uses neutral text for sealed classes (fix 25) → test: message template masking.
- **N-P5** Wound photos on tablets → captured in-app only, no gallery persistence, object storage with encounter ACL → test: file never on device FS.
- **N-P6** DPDP: nursing notes contain attendant's phone/personal facts → data classes: patient clinical (sensitive), staff identity, third-party incidental; retention and access as §7 → test: DPIA data map lists nursing tables.
- **N-P7** Auditor persona asks for MAR of a sealed patient → external persona excludes sealed class always (E-20); MS-authorised specific export → test: persona query returns "not visible".

### 5.11 Language, literacy, accessibility
- **N-A1** Bhojpuri-only patient, discharge medication teaching → teach-back captured; printed schedule in Hindi with pictograms (sun/moon icons, meal markers); WhatsApp voice note option (recorded by nurse, stored) → test: `education.delivered(language, method, teach_back)`.
- **N-A2** Patient cannot read the consent → thumb + witness + vernacular audio consent; nurse marks literacy in assessment → test: literacy flag drives print variant.
- **N-A3** Deaf patient → communication plan in care plan; whiteboard; attendant as interpreter recorded → test: care plan item type.
- **N-A4** Nurse's own UI in Hindi; drug names remain Latin script; dose instructions bilingual → test: i18n coverage of eMAR strings.
- **N-A5** Elderly patient with delirium at night (sundowning) → fall bundle intensifies; family presence allowed beyond pass hours by in-charge (pass override evented) → test: pass override.
- **N-A6** Low-vision nurse-facing accessibility: large-target mode, 44 px minimum, high contrast on ward tablets → test: UI budget assertions.

### 5.12 Scale (100/day → 2,000/day; 10 → 610 beds)
- **N-X1** 610 beds × ~12 doses/day = ~7,300 dose tasks/day + ~3,000 vitals slots + tasks → worklist query per nurse must return < 300 ms with 8 patients; dose generation batched nightly + on-order → test: perf budget with 610-bed fixture.
- **N-X2** Handover at 07:00 hospital-wide: 610 assemblies in 10 minutes → assembly precomputed from 06:30 incrementally; the T2 drafter is rate-limited per ward → test: assembly latency p95 < 2 s.
- **N-X3** WebSocket fan-out of worklist changes to 200 tablets → per-ward channels, not per-hospital → test: message count per event bounded by ward tablet count.
- **N-X4** 45 ICU beds × hourly validation = 1,080 validated rows/day + telemetry pre-fill → pre-fill reads TimescaleDB, writes only validated to core → test: no per-second data in core DB.
- **N-X5** Ratio computation for 40 units every shift → materialised `unit_acuity_snapshots`; recompute on events debounced 60 s → test: recompute cost.
- **N-X6** Commissioning ramp: legacy paper wards continue until absorption date (S10 §12.29) → per-ward absorption flag gates eMAR mandatory-ness → test: unabsorbed ward has no missed-dose ladder.

### 5.13 Integration failures (device/vendor/ABDM/HR)
- **N-I1** Roster feed from HR heartbeat silent 2 h → `interface.down`; on-duty picture frozen with "as of" stamp; assignments continue on last-known roster; supervisor confirms present staff manually → test: freeze banner + manual confirm path.
- **N-I2** Pharmacy interface (Plan 16) unavailable — ward indent cannot post → indent queued locally; ward stock consumption continues; pharmacy replays → test: P3 request idempotent.
- **N-I3** ICU CMS HL7 feed stops → `data_gap.flagged` per occupied bed; hourly chart shows "no pre-fill"; nurse manual entry → test: gap does not block validation.
- **N-I4** Nurse-call vendor sends duplicate presses → debounce 10 s per bed; escalate if unanswered 3 min (configurable) → test: dedupe.
- **N-I5** ABDM care-context push of MAR — out of scope day one; when enabled, only discharge medication list is shared, never MAR grain → test: export shape.
- **N-I6** Glucometer POCT device (interfaced later) sends result for wrong patient id (operator typed) → POCT result requires band scan at device or ward reconciliation task → test: unmatched POCT lands in reconciliation queue.
- **N-I7** Blood bank issue printed label barcode unreadable → bedside check refuses; manual unit number entry requires 2 checkers + phone confirmation with blood bank logged → test: manual path fields.

### 5.14 Medication-specific
- **N-R1** High-alert (KCl) witnessed by a nurse whose own login expired → witness eligibility evaluated at moment of witnessing → refuse → test: eligibility check at witness time.
- **N-R2** Insulin pen shared between patients (cost saving habit) → pen is patient-specific in ward stock; scanning another patient's pen refuses → test: item-patient binding on serialised items.
- **N-R3** Look-alike drugs (e.g., two vials with same colour) → Tall-Man lettering on task cards; drug barcode must match order salt+strength → test: strength mismatch refuses.
- **N-R4** Titration (noradrenaline range order) → each rate change logs `titration.adjusted` with MAP value; out-of-range attempt refuses → test: range enforcement.
- **N-R5** Antibiotic first dose ordered "STAT then q8h" → STAT task 15 min window with sound; downstream schedule anchored to STAT administration time → test: schedule anchoring.
- **N-R6** Chemo on day-care → pharmacist compounding verify event required before task unlocks; two-nurse verify; extravasation kit checklist → test: gate chain.
- **N-R7** Patient off-ward (CT) at dose time → nurse marks `held(off_ward)`; dose re-dues on return (`patient.returned` from transport task) → test: re-due generation.
- **N-R8** Crushed tablet via NG for a modified-release drug → formulary flag "do not crush" shows at administration; nurse confirms or queries pharmacist → test: flag rendering.
- **N-R9** Medication reconciliation at transfer ICU→ward missed → transfer handover blocked until reconciliation completed or explicitly deferred by doctor → test: gate.
- **N-R10** Discharge meds schedule WhatsApp derived from reconciliation shows a stopped drug → derivation uses discharge reconciliation only, never active MAR → test: source assertion.
- **N-R11** NDPS ward balance count mismatch by 1 ampoule at 07:00 → discrepancy workflow: recount by two others, pharmacist, MS informed within 1 h, register entry, incident; ward cannot receive new NDPS stock until closed → test: receive block.
- **N-R12** Nurse administers from own pocket stock (carried ampoules) → no scan possible → manual reason `unscanned_source` triggers in-charge review; repeated → matron → test: reason-code analytics.

### 5.15 Transfusion & bedside bundles
- **N-B1** Second checker is a student → refused; eligibility list → test.
- **N-B2** Transfusion started 45 min after issue (30-min rule breached) → block; doctor override with reason; blood bank notified → test.
- **N-B3** Reaction at 20 min → one-touch "stop": vitals capture, unit retained, workup orders template, `transfusion.reaction_flagged`, incident, register → test: 5 side effects in one transaction.
- **N-B4** Fall while nurse at another bed → post-fall: injury assessment task, doctor notify, incident, Morse re-score, family informed record → test: bundle spawns 5 tasks.
- **N-B5** Pressure injury found stage 2 at day 3, not present on admission → hospital-acquired flag; photo; dietician; surface; register → test: POA flag logic uses admission Braden/skin check.
- **N-B6** Restraint in place 26 h without review → escalation to MS; auto-release not allowed (safety) but loud → test: ladder.

Row count: 10+12+10+10+12+14+8+11+10+7+6+6+7+12+6 = **141 rows**.

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**C1 — Server down 22:15, night med round, 180 beds live.** 22:15 core unreachable; tablets show "offline — last sync 22:14", worklists read-only, scan verification works offline. 22:18 in-charge of each ward pulls the shift's pre-printed MAR (auto-printed 20:45 with QR per page). Duty manager phones the on-call engineer; declares floor-scoped downtime by phone; the declaration is entered when the system returns with `occurred_at` 22:15. Nurses chart on paper; high-alert doses still get two signatures on paper. Agents: all automations halted by absence of events (fail-open, nothing blocks). 23:40 server back; each ward's backfill screen lists the printed pages by QR; nurses enter doses with paper times; system dual-stamps, marks `downtime_id`, suppresses `missed` for the window. Audit shows: `downtime.declared`(backdated occurred_at), N `medication.administered` with downtime flag, reconciliation report of paper vs system, `downtime.ended`. Missed-dose KPI excludes the window but shows it as a grey band.

**C2 — Two night nurses no-show on a 40-bed surgical ward.** 20:40 roster shows 4/6. Coverage Resolver (T3) drafts: float pool 1 available (paeds-tagged, allowed on surgical), agency 1 on call (CLRA-verified), on-call-back nurse from morning shift (would breach consecutive-hours → flagged). Nursing supervisor approves float + agency at 20:52; `nurse_assignment.changed` ×2, `temp_role.granted` for agency until 07:30. Ratio 1:10 until agency arrives at 21:40 → `ratio.breached` recorded with reason; elective post-op transfers into the ward held by bed board (IPD rule reading the ratio flag). Handover proceeds with the in-charge acknowledging the missing nurses' patients as proxy. Owner digest at 08:00: "Surgical ward night: ratio breach 50 min, resolved via agency; no missed doses."

**C3 — Mass casualty (bus accident) 40 patients, 6 to wards at 01:00.** `disaster.declared`; surge mode widens bundling; ward tablets switch to "surge worklist" (vitals q1h auto for all new arrivals, admission assessments deferred to 6 h with flag). Unknown patients under temporary UHIDs with bands; MLC flags. Narcotics demand spikes: ward NDPS receive from pharmacy emergency issue, two-key still enforced (no bypass; second factor via supervisor). Deterioration Watch shows a floor-level EWS heat map to the supervisor. After: `patient.merged` for identified patients carries every dose; MLC notes immutable; the disaster log lists every proxy ack and deferred assessment.

**C4 — Power + network loss, 20 minutes, ICU with 30 patients.** UPS holds monitors, not the ward switch. CMS stays local; HL7 to core stops → `data_gap.flagged` on 30 beds when core returns. Nurses continue hourly validation on paper hourly sheet. Infusion pumps on battery. Narcotic cupboard electronic lock → mechanical key, manual register. Restore: hourly chart backfill from CMS trend export (nurse validates per hour); `interface.restored`; TimescaleDB gap noted on the record ("telemetry unavailable 03:10–03:30").

**C5 — VIP + MLC + fraud in one hour.** 10:00 a politician's relative (sealed VIP) admitted under alias; 10:20 an assault victim MLC admitted to the same ward; 10:45 Fraud Sentinel flags a nurse's scans clustered at station for 7 patients within 90 s. System: VIP surfaces alias except treating-team eMAR/handover (carve-out evented); MLC notes immutable; the scan-cluster diagnostic goes to matron (never auto-punitive); matron orders a bedside audit task. Agents: only diagnostics. Audit trail: carve-out accesses, MLC register, anomaly report with disposition.

**C6 — Wristband printer and Wi-Fi fail on the maternity floor during a twin delivery night.** Paired bands cannot print; manual bands with hand-written UHIDs; baby handovers use two-identifier verbal + second RN co-sign (`identity_manual`); infant-abduction gate checks fall to security visual verification with a logged exception. Printer fixed 02:00; reissue rotates tokens; all manual handovers listed in the morning quality report.

**C7 — Resident does not answer NEWS 8 at 03:20.** `ews.escalated` → resident (WhatsApp + in-app) → 15 min no ack → ICU registrar + in-charge → 10 min → duty manager + PBX call task → MS SMS (dead-end). Nurse meanwhile follows the standing "deteriorating patient" order set (O₂, IV access, repeat vitals) — tasks auto-created from the escalation state. Afterwards the timeline shows every rung with timestamps; the nurse's actions are documented as tasks, not blame.

---

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | Register/table | Signer | Retention |
|---|---|---|---|---|
| Ward NDPS/Schedule X custody | NDPS Act 1985 + Rules; Drugs & Cosmetics Rules (Sch. X, H1) | `ward_narcotic_ledger` (+ view with statutory columns: date, patient, prescriber, qty issued/administered/wasted, balance, custodian, witness) | custodian + witness (2FA) | ≥ 2 y (NDPS r.67); policy 5 y |
| MAR / eMAR | Clinical Establishments Act (record standards), NABH MOM/COP chapters, Consumer Protection Act exposure | `emar_doses` immutable + print view | administering RN (+ witness) | medical record retention (IPD 10 y proposed) |
| Nursing notes | NABH IMS, Indian Evidence Act (electronic records s.65B), IT Act | `nursing_notes` append-only, addenda | author (+ co-sign) | as above |
| Verbal orders | NABH COP; hospital policy | `verbal_orders` | nurse + doctor countersign | as above |
| Falls, pressure injury, restraint | NABH quality indicators (COP, PSQ) | registers | reporting nurse; reviewer (in-charge) | 5 y |
| Needle-stick | Bio-Medical Waste Rules 2016 (sharps), NACO PEP guidelines, ESI/occupational | `needle_stick_register` | staff + infection-control nurse | 5 y+ (occupational; policy) |
| Violence against healthcare staff | state Medicare Service Persons Acts (e.g., Maharashtra 2010), Epidemic Diseases (Amendment) Act 2020 where applicable | `violence_register` → MLC path | supervisor + security | 5 y |
| Transfusion bedside | NBTC/DGHS guidelines, Drugs & Cosmetics (blood) | `transfusion_bedside_checks` + reaction register (blood bank owns) | 2 checkers | 5 y |
| Restraint | NABH; Mental Healthcare Act 2017 (s.97 for psychiatric settings) | `restraint_register` | doctor order + RN | 5 y |
| Roster statutory limits | Factories/Shops & Establishments Acts (state), Maternity Benefit Act, women's night-shift rules, CLRA | roster module (Plan 20); this module consumes | matron | HR retention |
| Student attribution | INC regulations for clinical training | co-sign rows | RN | record retention |
| Sharps/BMW at ward | BMW Rules 2016 | Plan 19 chain; nursing emits segregation tasks | — | 5 y |
| DPDP Act 2023 | consent, data classes | data map: patient clinical (sensitive personal), staff identity, biometrics (none stored), incidental third parties | DPO (card 37) | as per DPIA |

**What NABH asks to see (assessor walk-in):** nurse:patient ratio per shift with acuity evidence (`unit_acuity_snapshots`), handover completeness, MAR with two signatures on high-alert, medication error rate and near-miss reporting culture, fall/pressure/restraint indicators per 1,000 bed-days, narcotic register with balances, credential/competency matrix, training records, patient education evidence, incident closure. Every one is a query over registers here, not a compiled report. **Inspector (drug inspector) demand:** NDPS ward register + balance vs physical — one screen, printable with QR verification. **Consumer forum:** MAR + nursing notes timeline with late-entry marks — the QR-verified print (§11.18 sweep 4).

**Consent forms surfaced from nursing:** transfusion (vernacular, thumb/witness), restraint (family information), procedure-level (catheter, NG in some policies), HIV testing of source patient (NACO), photography of wounds (DPDP), student participation notice (policy).

---

## 8. Staff KPI & KRA

All formulas target the KPI formula registry (deferred note 5); until then S10 is book of record. Every rate is reported with load context (patients assigned, acuity points, shift census). Diagnostic, never auto-punitive.

**Staff Nurse (card 20)** — KRA: assigned patients' care executed as ordered, documented as done, escalated when deviating.
| KPI | Formula (events) | Normalisation | SLA link | Diagnostic reading | Gaming resistance |
|---|---|---|---|---|---|
| Dose on-time rate | administered within window / (all non-cancelled, non-held doses) | per doses assigned; excludes downtime windows | eMAR window | < 95% with high acuity → staffing, not nurse | held-reason audit (N-F10) |
| Scan compliance | doses with signed band scan / administered | — | — | low with printer faults → device KPI | manual-reason distribution |
| Missed-dose rate | `medication.missed` / doses due | per acuity | grace | clustered at shift ends → handover design | refused-rate outlier check |
| Vitals timeliness | slots recorded ≤ 15 min late / slots due | per patients | vitals schedule | — | late-entry share |
| EWS escalation latency | `ews.scored`(≥5) → `ews.escalated` | — | 30/15 min | delay ≠ nurse if paging failed (`notification.failed` excluded) | — |
| Handover ack completeness | items acknowledged before shift+20 / items | — | 20 min | proxy-ack share shows overload | bulk-ack disabled |
| Bundle compliance | bundle tasks verified / due (fall, pressure, line care) | per active bundles | task SLA | — | verification by different nurse |
| Documentation late-entry share | late_entry rows / rows | — | — | high late share = tablet shortage? | — |
| Incident reporting count (near-miss) | `incident.reported` by nurse | — | — | **higher is better** (culture) | none needed |

**ICU Nurse (card 21)** — add: alarm ack < 60 s rate; hourly validation rate; line-day bundle compliance; data-gap on their beds (device diagnostic); titration logging completeness.

**Ward In-Charge (card 23)** — KRA: ward staffed, handed over, stocked, honest. KPIs: assignment map published ≥ 30 min pre-shift; ratio breaches (count, minutes) with reason; ward handover completion 100%; ward stock variance (issued − administered − wasted − counted); NDPS balance discrepancies (target 0); overload flags addressed within 1 shift; incident closure within SLA; student co-sign compliance.

**Nursing Supervisor (N-A)** — KPIs: coverage-gap resolution time; witness availability breaches per floor; night escalations answered within SLA; float utilisation; agency hours vs plan.

**Matron (card 24)** — KPIs: hospital falls/1,000 bed-days; hospital-acquired pressure injury/1,000 bed-days; medication errors/1,000 doses (reported; higher reporting is not worse); restraint-days/1,000 bed-days; needle-sticks/100 FTE; attrition; competency coverage per unit (≥ 2 tagged per station); statutory roster compliance; anomaly-report disposition SLA (S10 §12.27).

**Educator (N-F)** — training compliance, competency sign-offs on time, student co-sign integrity.

**Float/agency** — same KPIs as staff nurse, reported separately with "unfamiliar unit" context.

**KRA per nurse grade (proposed):** GNM staff nurse: execution + documentation; BSc/senior: plus high-alert witness duty, preceptor; in-charge: ward operations; supervisor: floor at night; matron: workforce and quality.

**Owner's 8 a.m. digest — nursing block:** ratio breaches last 24 h (unit, minutes, cause); missed critical doses (count, patients, resolved?); EWS escalations ≥ 7 and response times; falls/pressure injuries new; NDPS discrepancies open; needle-sticks; violence reports; handover completion by ward; agency hours; anomalies awaiting matron disposition.

---

## 9. AI agents & the copilot — where inference earns its place

Rule: deterministic automation first; the T2 cap for clinical text; agents API-only, fail-open, kill-switch per agent, global halt, draft provenance.

| Candidate | Kind | Tier | Trigger / inputs | Output | Human sign-off | Fail-open manual path | Kill scope | Provenance | Eval/guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Coverage Resolver** | automation (rules) | T3 | `roster.published` gap, no-show at T-20, `nurse_assignment.released`; inputs: roster, competency tags, float/agency pools, statutory limits | ranked fix options as approval request | nursing supervisor approves | in-charge reassigns by hand | agent | rule version | never proposes statute-violating or untagged fix (unit test) | staff identity only | IPD/nursing plan |
| **Missed-Dose Nudge** | automation | T1 | dose past window (no action) | in-app nudge to assigned nurse → in-charge → resident for critical classes | none (nudge) | ladder still records `sla.breached` | agent | — | alert budget: max N nudges/nurse/hour, batched otherwise | patient id internal | nursing plan |
| **Deterioration Watch** | automation (T0 report) + T1 nudge; **trend inference deferred** | T0/T1 | `ews.scored`, vitals trend, `data_gap`, missed critical doses | floor heat map; "rising trend 3 readings" nudge to nurse and resident; T0 daily report of unescalated ≥ 5 scores | none; escalation stays the deterministic ladder | ladder | agent | rule version | must never suppress the ladder; alert cap per unit per hour | de-identified in reports | nursing plan (rules); ML trend model only after 12 months data, T1 max |
| **Shift-Handover Note Drafter** | agent (LLM) | T2 | outgoing nurse taps "draft ISBAR"; input = permission-filtered fact sheet (`ipd-ward` pack, copilot §2.3) tokenised | ISBAR narrative with cited line-ids; uncited claims dropped | outgoing nurse edits/signs; incoming acknowledges | deterministic skeleton (always rendered first) | agent | model id, prompt ver, hashes into `handover.completed` | citation entailment fixtures; no alert originates from model | clinical text → DPIA L1 revision; pinned provider under DPA | after 12a gates + copilot Phase B; nursing plan ships the skeleton |
| **Turnover Dispatcher (interface)** | automation | T4 (ops) | `patient.discharged` / bed released | housekeeping dispatch | none | pooled queue | — | — | — | — | Plan 19; nursing only emits "bed ready for cleaning" |
| **Discharge Summary Drafter (consumer)** | agent | T2 | consumes nursing facts (lines removed, education delivered, last vitals) | — | doctor | — | — | — | — | — | IPD |
| **Fraud Sentinel — scan analytics** | automation | T0 | `medication.administered` timing per nurse/device | clustering, dyad, refusal-outlier reports to matron | matron disposition workflow | — | agent | — | false-positive review loop | staff | 12b |
| **Wound-photo assessor** | *rejected for now* | — | — | — | — | — | — | — | clinical image inference, no DPIA basis | — | not before stage 4 |
| **Acuity scorer** | automation (rules) | T0 | vitals, devices, meds count, isolation | `patient_acuity` level driving ratio | in-charge may override with reason | manual acuity | — | rule ver | — | — | nursing plan |

**Three presentation lanes for nursing:** Lane 1 hand-built — the nurse worklist (tablet), eMAR administration screen, vitals entry with EWS, handover ack, narcotic cupboard screen, ward board for in-charge (high frequency, low diversity). Lane 2 schema-generated — assessments (Morse/Braden/pain forms), bundle task forms, device-line insert/remove, patient education, registers (needle-stick, violence, restraint), ward stock indent. Lane 3 conversational — **clinical roles last** (roadmap note 3): in-charge asks "who is uncovered tonight?", "show open EWS escalations on floor 3", "draft the roster gap request" → propose→confirm tool calls; never an order, never a dose.

**Journey Feed contributions:** every `medication.*`, `vitals.recorded` with EWS band, `handover.completed` (ISBAR as a Composition), `assessment.recorded`, bundle activations, device line insert/remove, `education.delivered`, register events — all structured posts; nursing notes appear as feed entries with author/co-sign.

**Prompt inputs (handover drafter), concretely:** allowlisted fields only — age band, sex, admitting diagnosis (coded), day of stay, last 12 h EWS series (values+times), doses missed/held/refused (drug class, reason), open tasks (type, due), pending results (type only), lines/catheters (kind, day), isolation flag, DNR flag, allergies (coded), restraint status, discharge planning state, outgoing nurse's free-text (scrubbed). Excluded: names, UHID, phone, locality, kin, free-text of other staff, billing.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context:** scan band → patient's due-now card (doses, vitals, tasks) in < 300 ms; scan drug → match/refuse in < 100 ms (local cache of order snapshot).
- **Tablet UX:** 44 px targets, one-hand mode, glove-friendly; colour-blind-safe status; "due now / overdue / next" three-bucket worklist; offline banner with queued count; PIN/badge switch in < 2 s (§11.18 lock 6).
- **Pre-filled vitals from monitors (ICU/HDU)** with validate-in-one-tap; EWS auto-computed and shown before save.
- **Auto-printed shift packs** (paper MAR + vitals sheets) as the always-ready downtime path — printing is a first-class surface (§15).
- **TAT clocks:** dose window countdown, EWS escalation countdown, handover ack countdown, transfusion 30-min clock, restraint review clock — all visible on the card, not in a report.
- **Bundles as task templates** — no free-text care plans for the top 8 risks; free text is the exception.
- **Witness picker** resolving eligible RNs on the floor with proximity.
- **Voice:** dictation-to-note for nursing notes (on-device/pinned provider, lawful under DPIA) — note remains typed-confirmed; no voice for orders.
- **Keyboard at station:** in-charge's ward board keyboard-first (assignment drag or keys; bulk task verify with per-item confirm).
- **Targets:** dose on-time > 95%, scan > 98%, handover ack 100% within 20 min, admission assessment ≤ 2 h in 95%, EWS ≥ 7 escalation ack ≤ 15 min in 90%, worklist p95 < 300 ms, offline replay success 100% idempotent, documentation time per nurse per shift ≤ 60 min (S10 §12.21 budget).

---

## 11. Integrations, devices & dependencies

| Device/vendor | Protocol | Edge rule | Notes |
|---|---|---|---|
| Wristband printers (Zebra ZD-series / TSC; thermal, signed QR) | print via CUPS/ZPL | core prints | ₹25–40k each (§13) |
| Ward tablets (Android 10–11", rugged case; e.g., Samsung Tab Active/A series) | HTTPS/WebSocket, PWA offline | MDM enrolment, device key | 2 per 20 beds + 1 per station |
| 2D scanners (Zebra DS2278/Honeywell Voyager BT) + tablet camera | HID/BT | — | signed token verify |
| Nurse-call system (e.g., Schrack, Ackermann, Indian OEMs like Kavach/Tekcare) | dry-contact/IP → edge → `nurse_call.raised` | edge service, heartbeat | lands in ward pooled queue |
| Patient monitors/CMS (Philips/Mindray/BPL/Skanray) | HL7 v2 ORU → MQTT → TimescaleDB (§11.15) | ICU edge | pre-fill only |
| Infusion pumps (B.Braun/Fresenius/Indian) | proprietary/HL7 where available | interface later; procurement mandate: data export | device-days billing via `device.usage_*` |
| POCT glucometers (Roche Accu-Chek Inform, Nova) | POCT1-A/serial | lab edge pattern | result to eMAR with band scan |
| BLE beacons per room (optional, O-6) | BLE | tablet reads | bedside presence evidence |
| HR SaaS (attendance/payroll; e.g., Keka, greytHR, Darwinbox) | REST/CSV | roster module owns; heartbeat | `roster.synced` |
| Pharmacy (Plan 16) | internal interface (P3) | — | indents, ward stock, NDPS issue |
| Blood bank | internal | — | unit issue, bedside check |
| Quality pack | internal events | — | incident workflows |

**Dependencies:** Plan 13 (registry) · Plan 20 roster/workforce (proposed) · Plan 21 IPD beds/admission (proposed) · Plan 16 pharmacy (ward stock, NDPS issue) · Plan 19 housekeeping (turnover, BMW) · 12a runtime (agents) · copilot Phase B (drafter). Events consumed: `patient.admitted/.transferred/.discharged/.deceased`, `bed.assigned`, `prescription.issued`, `order.placed`, `order.cancelled`, `roster.published/.synced`, `credential.blocked`, `temp_role.*`, `unit.issued`, `allergy.recorded`, `downtime.*`, `disaster.*`, `isolation.flagged`, `material.issued`.

---

## 12. Buy vs build, hardware & rough INR budget

**Build (owns tables + workflow):** assignment/acuity, eMAR, tasks/bundles, vitals+EWS, assessments, handover, ward narcotics ledger, registers, KPIs. **Buy:** HR/attendance SaaS (₹50–150/employee/month), nurse-call hardware (₹8–15 L per 100 beds), monitors/CMS (ICU plan), MDM (₹150–300/device/month or open-source Headwind), tablets, printers, scanners, BLE beacons (optional, ₹1.5–3k each), clinical content (drug KB already in §19 line; NEWS2/Braden/Morse are public-domain scales — no licence).

| Item | Day one (≈ 60 beds absorbed) | 610 beds |
|---|---|---|
| Tablets 10–11" + rugged case + MDM | 12 × ₹25k = ₹3 L | 90 × ₹25k = ₹22.5 L |
| BT 2D scanners | 12 × ₹8k = ₹1 L | 90 × ₹8k = ₹7.2 L |
| Wristband printers | 3 × ₹35k = ₹1 L | 18 × ₹35k = ₹6.3 L |
| Wristbands/ribbons (consumable) | ₹4/band × 8k adm/yr = ₹0.3 L/yr | ₹4 × 50k = ₹2 L/yr |
| Nurse-call system | (bought with building) | ₹60–90 L |
| Wi-Fi density (APs per ward) | part of network plan | +₹15–25 L |
| Narcotic cupboards with electronic dual-key locks | 3 × ₹40k | 18 × ₹40k = ₹7.2 L |
| BLE beacons (optional) | — | 700 × ₹2k = ₹14 L |
| Development (agent-driven, tokens + owner time) | Plan 22 ≈ same band as Plan 11 cluster | — |

---

## 13. Owner rulings needed

- **O-1 Ratio table by unit type (NABH-aligned defaults above).** Recommend adopting the table in §2 as configuration with breach = recorded + supervisor page, never a block on admission (care never stops). Why: legal exposure sits with ratios; owner owns policy.
- **O-2 Roster ownership boundary confirmation.** S10 §12.15 says HMIS authors rosters; the brief says "roster consumed from HR SaaS". Recommend: **HMIS authors/publishes (S10 stands), HR SaaS receives the published roster and owns attendance/payroll**; a Plan 20 workforce module builds it. Why: the publication gates (witness, SoD, statutes, chaperone) are unenforceable if HR authors.
- **O-3 Fatigue/overtime limits.** Recommend: max 12 h/shift, max 1 double/week, ≥ 11 h rest between shifts, ≤ 6 consecutive days, night runs ≤ 7; violations block publication; emergency override by matron with 72 h expiry, evented. Why: policy + labour-law exposure.
- **O-4 Ward-stock charging rule.** Recommend: charge at administration for ward stock, at issue for per-patient indents; opened-and-wasted units charged with reason; refused-unopened not charged. Why: money.
- **O-5 Bedside scan at handover mandatory or KPI-only.** Recommend KPI-only for 6 months, then mandatory per ward on evidence. Why: documentation-time budget vs safety.
- **O-6 BLE beacons for bedside presence.** Recommend defer; use timing analytics + audits first; revisit at 300 beds. Why: purchase.
- **O-7 Student nurse policy.** Recommend: students may administer non-high-alert, non-controlled meds only with same-device RN co-sign; never witness; documentation always co-signed. Why: legal exposure + INC norms.
- **O-8 Agency nurses and NDPS.** Recommend agency nurses never hold custodian role; may witness only if council-verified. Why: NDPS liability.
- **O-9 Verbal-order countersign window.** Recommend 24 h (narcotics 12 h); uncountersigned escalates to HoD then MS. Why: policy.
- **O-10 Restraint policy.** Recommend NABH-style: doctor order, 2-hourly checks, 24 h review, family informed; psychiatric settings additionally Mental Healthcare Act s.97 register. Why: legal.
- **O-11 Violence-against-staff response.** Recommend: panic path → security → police MLC on injury; hospital files under the state Medicare Service Persons Act; legal counsel retainer. Why: legal/policy.
- **O-12 Handover drafter activation.** Recommend: skeleton ships with the module; LLM narration only after copilot Phase B gates, and **nursing before doctors** is *not* recommended — clinical roles last stands. Why: DPIA/policy.

---

## 14. Plan sketch — how this becomes phase documents

Roadmap has 14–19; this document proposes **Plan 20 — Workforce & roster** (S10 §12.15 home; on-duty picture, credentials, competency tags, publication gates, HR sync) → **Plan 21 — IPD beds/admission/wristbands** (bed board over registry, gender rule, passes) → **Plan 22 — Nursing management** (this document) in two phase docs: **22a eMAR + worklist + vitals/EWS + assessments/bundles + handover** and **22b ward narcotics + transfusion bedside + registers + KPIs + Coverage Resolver/Deterioration Watch**. Turnover Dispatcher stays in 19.

**Plan 22a task list (section level):** T1 schema (assignments, acuity, emar_*, vitals, ews, assessments, care plans, tasks mirror, device lines, handovers) + migrations · T2 workflow definitions (dose, task, vitals/EWS, handover, assignment) as seeded versioned data, owner activation · T3 dose generation from orders (snapshot versioning, PRN, titration, STAT anchoring) · T4 administration API with five-rights checks, witness, student co-sign, offline idempotency · T5 vitals + EWS rules (NEWS2/PEWS/MEOWS versioned) + escalation ladder · T6 assessments/bundles (Morse/Braden/pain day one — the pre-IPD gate) · T7 handover assembly + ack + escalation · T8 nurse worklist tablet UI (Lane 1) + schema-generated forms (Lane 2) · T9 print packs (paper MAR/vitals) + downtime backfill screen · T10 charges read model (`charge.posted` from administration/task verified) + orphan report lines · T11 perf tests at 610-bed fixture · T12 deploy gate: absorption flag per ward.

**Plan 22b:** ward narcotics ledger + two-key + discrepancy workflow · transfusion bedside check · registers (fall, pressure, restraint, needle-stick, violence, med error) + incident hook · KPI definitions into the formula registry · Coverage Resolver + Missed-Dose Nudge + Deterioration Watch (rules) on the 12a harness · Fraud Sentinel scan analytics · digest block.

**Gates before authoring:** Plan 13 shipped (registry with `device`/`store`) · Plan 20 on-duty picture and competency tags exist · Plan 21 bed board + wristband issuance live · Plan 16 exposes ward-stock and NDPS issue interfaces (or 22b waits) · 12a runtime for automations · O-1..O-4, O-7 ruled · DPIA data map extended for nursing tables · absorption date per ward set (S10 §12.29).

**Negative-space question — what absence is a signal here?** A patient with *no* vitals in 6 h; a shift with *no* `medication.missed` on a 40-bed ward (too clean = gaming or paper path); a nurse with *no* incident reports in a year on a busy ward; a ward with *no* held/refused doses; *no* late entries at all (implies backdating or tablet always at station); *no* `ratio.breached` ever (implies the rule is off); silence from the nurse-call interface for a whole night; a handover acknowledged in < 2 s per patient.

**Department-head interview questions (ask the matron/in-charges):**
1. Which drugs do nurses currently draw from "pocket stock" and why?
2. How are narcotics counted at shift change today and who signs?
3. What happens now when a resident does not answer at night?
4. How many wristbands are removed for procedures per day and re-applied how?
5. Which wards will refuse tablets and why (gloves, hands wet, theft)?
6. How are student nurses supervised and who signs their entries?
7. What is the real handover duration per patient and is it bedside?
8. How often do nurses double-shift; what is the current overtime practice?
9. Where does violence against staff happen most (ward, ER, night) and who responds?
10. Which high-alert drugs are given without a second nurse today?
11. What paper registers exist on each ward (list all; each is a table candidate)?
12. Which ward has female-only staffing rules and how are male nurses deployed?
13. How are float nurses received on an unfamiliar ward — orientation checklist?
14. What is the attendant's role in care today (feeding, turning) and should it be recorded?

---

## 15. Open questions & risks

1. **Roster ownership contradiction** (brief vs S10 §12.15) — routed as O-2; the design here assumes S10.
2. **Where the acuity rule lives** — nursing (proposed) vs IPD bed board; both need it; proposed as a nursing read model the bed board consumes via interface.
3. **Offline-capable signed-token verification** on tablets needs a key-distribution design not yet in the spec (public key cache, rotation on reissue) — a Plan 21/22a design decision.
4. **Doc 10 residents** escalation ladder must agree on the NEWS thresholds; cross-document reconciliation needed.
5. **Per-dose charging vs pharmacy's issue-time charging** (O-4) touches Plan 16's billing read model; must be decided before either plan's T-charges task.
6. **Alert budgets** (nudges/hour) have no baseline yet; ship recorded-only for 30 days per ward, then enable pages (§10.3 posture).
7. **Documentation-time budget** (S10 §12.21): the mandatory step count per shift for a 1:8 nurse must be summed at definition time; the assessment set proposed here may exceed 60 min on admission-heavy days — needs measurement on the first absorbed ward.
8. **Mental Healthcare Act** applicability for restraint outside psychiatric units is a legal read for counsel.
9. **Hindi/Bhojpuri patient-education content** licensing/authoring — no source yet.
10. **Wound photography** DPDP basis and storage cost — deferred; text-only assessment day one.
11. **ICU pack for the Context Lens** (copilot §2.3) is a stub; the handover drafter for ICU depends on it.
12. **Risk:** if eMAR ships before pharmacy ward-stock interfaces (Plan 16), the drug-scan right-drug check degrades to order-line confirmation; state this on the card (copilot law 10) and time-box it.
