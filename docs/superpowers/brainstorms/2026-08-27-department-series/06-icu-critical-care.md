# 06 — ICU / Critical Care — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED.
**Scope:** MICU / SICU / CCU (the three 15-bed halls of spec §11.15), NICU and PICU as hall variants (§11.17 NICU = ICU-hall variant, 15 beds), telemetry, Code Blue, ventilators & pumps, infection control, end-of-life and organ donation.

**Executive summary.** The ICU module is the hospital's highest-acuity, highest-burn-rate, most-instrumented floor: 45 adult beds in three halls plus NICU/PICU, every bed a stream of per-second numerics, every bed-day a ₹15–40k line, every patient a family that cannot sit at the bedside. It IS: admission-approval and bed contention, device↔bed↔patient association, the nurse-validated hourly flowsheet as the legal record over a raw telemetry store, alarm governance, bundle/HAI surveillance registers, sepsis and Code Blue clocks, family counselling and end-of-life law (SC 2023 guidelines, THOTA), running-bill/TPA burn control, and a paper path that works when the CMS, the network or the power dies. It is NOT: a monitor vendor's CMS (waveforms stay on the vendor station), an eMAR/pharmacy (consumed from §11.8), a bed board (Plan 13 registry owns resources; ICU declares statuses), a blood bank, a mortuary or a ward module (IPD doc owns the general stay loop). **Three hardest problems:** (1) device-to-bed-to-patient mapping that is wrong silently — the ICU's version of the wrong-patient transfusion; (2) alarm governance that keeps nurses looking at the patient, not the screen, while still proving every silence was deliberate; (3) money and law colliding at the bedside — deposit exhausted, TPA pre-auth expiring, family asking to withdraw, brain death declared — where the system must record everything and block nothing clinical.

## 1. Frame — what exists, what is locked, what this document adds

**Built (Phase 1):** kernel (events outbox, workflow engine, approvals, RBAC actors, scheduler, ops modes/downtime kit), patients/UHID, tariff/GST, OPD, billing counter, notifications, memberships, formulary + prescribing safety, search, user admin. Plan 13 (resource registry — `resources` + `resource_status_history`, ten kinds incl. `hall`, `bed`, `device`) is in flight (T1 landed `e913845`). **Nothing ICU-specific is built.**

**Locked decisions inherited (do not re-litigate):**
- §3/§5: ICU telemetry is an **edge** — Mosquitto MQTT → TimescaleDB (separate instance); per-second vitals never touch the core DB; edges buffer locally, core restarts without losing edge data.
- §11.15: 3 halls × 15 beds; per-hall vendor CMS bought with the monitors; **procurement mandate: no monitor/ventilator without documented HL7/serial export**; one HL7 feed per hall → MQTT; waveforms stay on the CMS; hall-scoped alarm routing bed-nurse → hall station → floor intensivist → duty manager; **alarm silencing is logged**; raw telemetry = supporting data (~90 days full resolution then downsampled), **nurse-validated hourly chart = legal record**; device-telemetry daily reconciliation (billed-without-telemetry = orphan, telemetry-without-billing = leakage); isolation grains cabin → hall cohort → floor lockdown; Code Blue one-touch with roster-resolved team, seal event, timed code sheet; MTP; ventilated transport bundle; `data_gap.flagged`; titration range orders via eMAR; daily family briefing as counselling record; 48-h readmission flag. Events: alarm.escalated · data_gap.flagged · crashcart.opened · crashcart.replenished · mtp.activated · transport.bundle_completed · titration.adjusted · briefing.recorded · icu.readmission_flagged.
- §11.2: ICU admission requires intensivist/duty-ICU-doctor approval (approvals engine, §8); ICU-full → hold with monitoring + refer-out offer, decision logged; no bedside attendants (lounge passes + visiting slots + scheduled updates); **device-days are chargeable start/stop events**; deposit policy 3 est. days, 75%/90% alerts, ICU burn-rate recalculated daily; TPA enhancement reminder near sanctioned limit; E7 deposit exhausted → **care never stops**.
- §11.19-E item 15: ICU admission approval rides an **interrupting channel** (push + PBX page) with act-first-review-after bypass, evented.
- §11.14: DNR consultant-confirmed, flagged on chart + eMAR (`dnr.recorded`); per-intervention refusal (`refusal.recorded`); organ-donation/brain-death committee protocol deferred *with register noted* — **this document designs it**.
- §11.18 sweep: NTP time truth + `clock.drift_flagged`; interface heartbeats → `interface.down`; late-entry dual stamp; §11.19-D 26 telemetry retention symmetry (legal hold reaches edge stores); §11.19-D 21 device feeds authenticate (mTLS/per-device tokens).
- §11.12: critical-care equipment maintenance 30-min response SLA; handover is a per-patient checklist gate; escalation resolves to on-duty role holders.
- §11.13: 5-min ack timer on critical clinical alerts; only the active-alert list interrupts; rest batches.
- §16: clinical agents cap at T2–T3 forever; automations preferred over inference; fail-open; kill switches; provenance. Copilot design: `icu` care-setting pack is a declared stub landing with this module; narrate-never-originate; deterministic checks only in the alert register.
- §13: ICU integration budget ₹1.5–2.5L (gateway + station terminals); CMS priced with monitors.
- Plan 13 §4A (RULED): bed **class/tariff belongs to IPD**, not the registry; instrument sets are not a kind; master-data governance is its own phase after O1.

**Scope boundaries / neighbours (who owns which table):** Plan 13 owns `resources` (halls, beds, devices as resources) and `resource_status_history`; ICU declares hall/bed status vocabularies (isolation, cohort, blocked-for-cleaning) on the manifest seam. IPD (doc on wards) owns `admissions`, bed class, room-rent posting, deposits, discharge cascade, transfers — ICU *consumes* `patient.admitted/transferred` and *emits* approval and handover events. eMAR/nursing (doc on nursing) owns medication administration; ICU owns titration context and the flowsheet. Pharmacy owns crash-cart stock; ICU owns the seal/check task and the code sheet. Blood bank owns MTP release; ICU owns activation. Lab (Plan 17) owns ABG analyzers as analyzers; ICU owns the POCT worklist link. Biomedical (doc on equipment) owns AMC/calibration; ICU owns device↔bed↔patient association. Mortuary/MRD own body release and death certificate; ICU owns brain-death certification forms. Doc 10 (duty doctor / resident escalation) owns the night ladder; ICU plugs its rungs in.

**This document adds:** the ICU admission/triage workflow, bed contention rules, device association model and its failure modes, alarm governance policy, hourly flowsheet validation model, bundle/HAI/sepsis registers, restraint/sedation/DVT order patterns, family communication and end-of-life legal workflows (SC 2023, THOTA 1994/2011/Rules 2014), M&M, Code Blue drills and crash-cart tasks, tele-ICU, outage modes, sizing, KPIs, agents, and the plan split.

## 2. Actors, roles & role cards

| Role (S10 card) | Shift | What they do in this module | Notes |
|---|---|---|---|
| **Intensivist** (S10 #11) | day consultant + on-call; 610-bed: 10–14 | Approves admissions (§11.2), owns triage scores, ventilator/sedation/vasopressor orders, daily briefing, withdrawal/DNR decisions, brain-death exams, step-down decisions, M&M | Approver role for `icu.admission`; SoD: cannot approve own request when also ER duty doctor — *resolved by role scope*: approval must come from the ICU-scoped holder |
| **ICU Nurse** (S10 #21) | 3 shifts; 1:1 ventilated / 1:2 others; 140–170 | Hourly flowsheet validation, alarms ack, titration logging, bundle checklists, restraint checks q2h, family slot escort, crash-cart shift check | Witness for high-alert meds |
| **ICU In-Charge (Sister)** — proposed variant of Ward In-Charge (#23) | 1 per hall per shift | Bed allocation within hall, roster, handover enforcement, cohort mode execution, visitor pass policy | |
| **Duty ICU Doctor / Resident (MO)** — proposed card | 24×7, 1 per hall at night min. | First responder for alarms rung 3, ABG, lines, Code Blue leader until intensivist arrives, night escalation ladder (doc 10) | Cannot certify brain death alone |
| **Respiratory Therapist** — proposed card | day + night pool | Ventilator settings execution, SBT, circuit changes, vent bundle audit, transport ventilation | India: often nurse-bundled; card exists so the bundle KPI has an owner |
| **Infection-Control Nurse (ICN)** (§11.19-C 25) | day | HAI surveillance, device-day denominators, bundle audits, isolation/cohort declaration with intensivist, outbreak flag | Owns the HAI register tables |
| **Quality Manager / NABH** (§11.19-C 25) | day | Indicator packs, M&M scheduling, Code Blue drill calendar, restraint audits | |
| **Clinical Pharmacist (ICU)** — proposed | day | Antimicrobial stewardship rounds, TDM, renal dosing, crash-cart par | AMS approver per §11.8 |
| **Physiotherapist / Dietician** (S10 #8) | day | Chest physio, early mobilisation, enteral feed orders (diet orders) | |
| **Biomedical Engineer** | day + on-call | Device registry, PM/calibration, backup ventilator, UPS test log, 30-min critical response | |
| **ICU Counsellor / Patient-Relations** — proposed | day/evening | Family briefing scheduling, counselling record scribe, LAMA/DAMA counselling, running-bill explanation | Hindi/Bhojpuri/regional |
| **Billing (IPD) + TPA Desk** (S10 front office) | day | Daily interim bill, deposit top-up, pre-auth enhancement | |
| **Security** | 24×7 | Visitor pass scans, lockdown | |
| **Transplant Coordinator** — proposed (statutory under THOTA Rules 2014 r.?) | on-call | Required request, NOTTO/SOTTO liaison, Form 8/10 flows | Must be a trained, certified coordinator |
| **Chaplain/social worker** | optional | End-of-life support | |
| **Duty Manager / Medical Superintendent** | 24×7 | Rung 4 escalation, refer-out decisions, override admissions (evented) | |

**Agents & automations (see §9):** Alarm Governor (automation T1) · Device-Bed Reconciler (automation T0) · Bundle & HAI Watchman (automation T1) · Sepsis Clock (automation T1) · Deterioration Early-Warning (agent, T0/T1 only) · ICU Handover Note Drafter (agent T2) · ICU Transfer/Discharge Summary Drafter (agent T2, the §16 Discharge Drafter with the `icu` pack) · Family-Update Drafter (agent T2) · Burn-Rate & Pre-auth Nudger (automation T1) · Crash-Cart Expiry Watchman (existing Expiry Watchman, T1) · Code Blue Dispatcher (automation T3, roster-resolved page) · Telemetry Retention Executor (automation T4, policy execution).

**Bundling (night/weekend):** ICU in-charge ← senior ICU nurse of the hall; clinical pharmacist ← duty pharmacist (AMS approvals defer to morning except restricted antimicrobials with intensivist verbal + evented); counsellor ← duty MO (briefings still logged). **Never bundle:** intensivist ↔ duty MO for brain-death exam (two distinct RMPs); alarm-silencer ↔ silence-auditor; restraint orderer ↔ restraint-need reviewer at the 24-h renewal (different physician recommended); crash-cart custodian ↔ crash-cart counter (SoD, S10 §11 stock custodian/cycle counter).

## 3. Core flows as workflow definitions

All lifecycles below are workflow definitions (§10.2), versioned, owner-activated. SLA values are corporate-standard defaults, configurable.

### 3.1 ICU admission request → bed (P1 + approvals overlay)
```
requested ──(intensivist approve)──▶ approved ──(bed assign)──▶ bed_held ──(arrived+handover ack)──▶ admitted
   │ SLA 10 min                          │ SLA 20 min           │ SLA 30 min (TTL, auto-release)      
   ├──(reject)──▶ rejected(reason)       └──(icu_full)──▶ holding_with_monitoring ──▶ referred_out | admitted
   └──(act-first bypass)──▶ admitted_pending_review ──(review ≤ 2 h)──▶ admitted
```
- Sources: ER (`er.disposition_decided`), ward escalation (`vitals.danger_flagged` + doctor request), post-OT (`surgery.completed` with ICU need booked at `ot.booked`), direct/refer-in (ambulance pre-arrival), NICU from labour ward (`birth.recorded`).
- Roles: request — ER doctor / ward consultant / anaesthetist / obstetrician; approve — intensivist or duty ICU doctor (ICU-scoped); bypass — same, evented as `approval.granted` with `bypass=true`; bed assign — ICU in-charge (registry assignment); handover ack — receiving ICU nurse.
- Request carries a **triage score bundle**: NEWS2/MEWS (ward), qSOFA, APACHE II inputs (auto-filled from latest labs/vitals), ventilated? pressors? and an **ICU priority class 1–4** (SCCM-style: 1 needs organ support, 2 needs monitoring likely to need support, 3 limited-benefit, 4 too well/too sick — corporate default; class shown to approver, never auto-decides).
- Escalation: requested > 10 min unacknowledged → PBX page to intensivist on-call → 15 min → medical superintendent (doc 10 rung); bed_held TTL 30 min then bed auto-released (Plan 13 tentative reservation with TTL, roadmap note 15).
- Events: `admission.requested` (payload `unit: icu`, `priority_class`), `approval.requested/granted/rejected`, `bed.assigned`, `patient.admitted` / `patient.transferred`, `handover.completed`; NEW: `icu.triage_scored`, `icu.hold_started`, `icu.hold_resolved`, `icu.bypass_reviewed`.
- Variants: **bed contention** — two requests, one bed: the approver sees both with scores; a 4th-class request may be refused; **bumping** = intensivist may step down the most step-down-ready current patient (see 3.6) to make room; `icu.bump_decided` NEW, with named authoriser, surfaced in weekly digest (§11.14 management-override rule). Disaster mode (§11.3 map 13) auto-applies OT/ICU pre-empt rules. Post-OT elective admissions hold a bed from `ot.booked` (tentative reservation) and release if surgery cancelled. NICU: admission approval by neonatologist; payer inherited from mother.

### 3.2 Device association (device ↔ bed ↔ patient) (P3 device-days)
```
free ──(associate to bed)──▶ on_bed ──(associate to patient/admission)──▶ in_use(patient) ──(stop)──▶ on_bed ──(release)──▶ free
                                                                             └──(patient moved)──▶ pending_remap (SLA 10 min) ──▶ in_use(new) | on_bed
in_use/on_bed ──(fault)──▶ out_of_service ──(biomed verify)──▶ free ; quarantine after isolation patient ──(terminal clean verified)──▶ free
```
- Devices = Plan 13 `device` resources (ventilator, monitor, infusion pump, syringe pump, feed pump, ABG POCT, warmer, phototherapy, ECMO/CRRT, transport monitor, backup vent), each with serial, asset tag QR, AMC, calibration due, HL7 identity (CMS bed slot / device id).
- Association is a **QR double scan on a tablet**: scan device tag + scan wristband (or bed tag when patient-less). Every `device.usage_started/stopped` carries patient, admission, bed, device, actor. Charges accrue from these events (§11.2 device-day).
- **Telemetry binding:** the CMS speaks in *bed slots* (e.g. `H1-B07`). The mapping `CMS slot → registry bed` is governed config; `bed → admission` comes from the registry assignment. A telemetry sample is therefore attributed to a patient only via (slot→bed→current assignment at `occurred_at`). Wrong mapping is edge rows I-1…I-9.
- Events: `device.usage_started`, `device.usage_stopped`; NEW `device.associated`, `device.disassociated`, `device.mapping_conflict_flagged`, `device.quarantined`, `device.remap_pending`.

### 3.3 Hourly flowsheet (legal record) (P5 nursing task + telemetry pre-fill)
```
hour_open ──(auto pre-fill from TimescaleDB at HH:00, median of last 60 s)──▶ prefilled ──(nurse edits/validates)──▶ validated(signed) 
   └──(no telemetry)──▶ manual_entry ──▶ validated        prefilled > 90 min unvalidated ──▶ overdue ──▶ escalated (in-charge)
```
- Columns: HR, SpO2, ABP/NIBP, RR, Temp, CVP, EtCO2, FiO2, vent mode/TV/PEEP/PIP/Pplat, GCS/RASS/CPOT/CAM-ICU, pupils, urine output, drains, infusions with rates (from pump feed or eMAR titration), feeds, I/O balance, blood sugar, position/HOB angle, restraint check, skin/Braden.
- Legal semantics: each validated hour stores `prefill_values`, `validated_values`, `diff`, nurse identity, `validated_at`; a value the nurse changed is visible as changed (audit shows both). Telemetry rows are never edited. Late validation → `late_entry.flagged` dual-stamped.
- Events NEW: `chart.hour_prefilled`, `chart.hour_validated`, `chart.hour_overdue`, `chart.manual_mode_entered/exited`.

### 3.4 Alarm lifecycle (P7)
```
raised(class) ──(nurse ack ≤ 60 s critical / ≤ 5 min advisory)──▶ acknowledged ──(resolve)──▶ resolved
   ├──(silence, duration ≤ policy max)──▶ silenced(logged, reason) ──▶ re-raised on expiry
   └──(no ack)──▶ escalated(hall station) ──▶ escalated(floor intensivist page) ──▶ escalated(duty manager)
```
- Alarm classes: **critical** (asystole/VF/VT, apnoea, SpO2 < threshold sustained 20 s, vent disconnect, high PIP, pump occlusion on vasopressor) → interrupting; **advisory** (limit alarms) → hall station banner only; **technical** (lead off, probe off, low battery) → task to bed nurse; sustained technical on occupied bed > 5 min → `data_gap.flagged`.
- Per-patient limit customisation by intensivist order (evented, expiry 24 h, must be re-ordered) — the actual anti-fatigue lever. Alarm counts per bed per shift in the hall dashboard; > N critical/hour on one bed → "alarm storm" flag → in-charge review.
- Events: `alarm.escalated` (existing); NEW `alarm.raised`, `alarm.acknowledged`, `alarm.silenced`, `alarm.resolved`, `alarm.limits_customised`, `alarm.storm_flagged`.

### 3.5 Code Blue (§11.15 locked; workflow instance per code)
```
activated(one-touch: location) ──▶ team_paged(roster-resolved) ──(first responder arrives, tap)──▶ in_progress(timed code sheet)
   ──▶ outcome(ROSC | died | transferred_ICU) ──▶ debrief_scheduled ──▶ closed(register row, replenish task verified)
```
- SLAs: page → first responder tap ≤ 3 min (drill KPI); crash-cart opened event auto-starts the sheet clock; sheet entries (shock J, adrenaline dose, airway, rhythm) time-stamped by tap; scribe role assignment; `crashcart.opened` → pharmacy replenish task (P5) + seal re-applied + verified. Drill: same workflow with `drill=true` payload; quarterly per hall (NABH). Events: `code.activated`, `crashcart.opened/replenished`; NEW `code.responder_arrived`, `code.outcome_recorded`, `code.debrief_completed`, `code.drill_completed`.

### 3.6 Step-down / transfer out / ICU discharge (P1)
```
stepdown_recommended(intensivist, criteria) ──▶ bed_requested(ward) ──▶ handover_ready(ICU→ward checklist) ──▶ transferred ──(48 h watch)──▶ closed | icu.readmission_flagged
```
- Handover checklist structured (§11.15): lines/tubes, infusions, pending results, antibiotic day, code status, restraint, isolation status, family contact. T2 drafter proposes the transfer summary. `stepdown.recommended` NEW, `patient.transferred`, `handover.completed`, `icu.readmission_flagged` (existing).

### 3.7 Sepsis Hour-1 bundle clock (P5 timed tasks)
`sepsis.clock_started` (NEW; trigger: doctor flags suspected sepsis, or qSOFA ≥ 2 + lactate ≥ 2 auto-suggest T1) → tasks: lactate, blood cultures before antibiotics, broad-spectrum antibiotics ≤ 60 min, 30 ml/kg crystalloid if hypotensive/lactate ≥ 4, vasopressor if MAP < 65 → `sepsis.bundle_completed` / `sepsis.bundle_breached` (NEW) → register row. Repeat lactate at 2–4 h.

### 3.8 Restraint order (P1 sub-workflow, NABH COP)
`restraint.ordered` (NEW; physician, indication, type, max 24 h) → consent counselling recorded (`consent.recorded`, family) → q2h nurse check tasks (circulation, skin, release) → `restraint.reviewed` (NEW; renewal every 24 h by physician) → `restraint.discontinued`. Chemical restraint tracked via sedation orders + RASS.

### 3.9 End-of-life: DNR / withholding / withdrawal (SC guidelines Jan 2023, *Common Cause* modification)
```
eol_discussion_recorded ──▶ dnr_ordered(consultant confirmed; dnr.recorded) 
withdrawal_requested(family/AD) ──▶ primary_board_convened(treating doctor + 2 subject experts ≥5 y exp; decision ≤ 48 h) ──▶ primary_board_opinion
   ──▶ secondary_board_convened(CMO-nominated RMP + 2 experts; ≤ 48 h) ──▶ secondary_opinion ──▶ family_consent(next of kin / AD surrogate) 
   ──▶ jmfc_intimated(copy of decision) ──▶ withdrawal_executed(comfort care orders) | declined(reasons) ; refusal by hospital ──▶ family may approach High Court (recorded)
```
- Advance Directive (living will): captured as a document class on the patient master with executor/guardian details; attested per 2023 simplification (notary/gazetted officer, no JMFC). Events NEW: `eol.discussion_recorded`, `advance_directive.recorded`, `withdrawal.requested`, `withdrawal.board_convened`, `withdrawal.board_opined`, `withdrawal.consented`, `withdrawal.jmfc_intimated`, `withdrawal.executed`, `withdrawal.declined`.

### 3.10 Brain-stem death certification & organ donation (THOTA 1994, 2011 amendment, THOT Rules 2014)
```
suspected(GCS 3, apnoeic, cause known, confounders excluded) ──▶ exam1(board of 4: RMP in charge of hospital, RMP from hospital's approved panel, neurologist/neurosurgeon [or intensivist/anaesthetist where none, per Rules 2014], treating RMP)
   ──(≥ 6 h; 24 h for < 12 y per practice)──▶ exam2 ──▶ certified(Form 10) ──▶ required_request(§3(1A): transplant coordinator asks family; logged) 
   ──▶ consent(Form 8 near relative | donor-card + no objection) ──▶ notto_sotto_notified ──▶ retrieval(only if hospital registered as retrieval/transplant centre; else transfer to registered centre) | no_consent ──▶ ventilator_withdrawal_after_certification
   MLC case ──▶ police NOC / post-mortem coordination before retrieval
```
- Time of death = second exam time. Events NEW: `brain_death.suspected`, `brain_death.exam_recorded` (×2, four signatures each), `brain_death.certified`, `organ_donation.requested`, `organ_donation.consented/declined`, `organ_donation.notto_notified`, `organ.retrieved`.

### 3.11 Telemetry manual-charting mode (downtime overlay, §11.4 pattern)
`telemetry.manual_mode_entered` (NEW; scope hall; trigger `interface.down` > 5 min or manual declaration) → flowsheet switches to manual q1h (q15min for unstable, nurse judgement), alarms rely on bedside monitor's own audible alarm, hall board shows grey tiles; `telemetry.manual_mode_exited` → backfill: telemetry gap remains a gap (never synthesised); manual values carry `source=manual`.

### 3.12 Others (each a definition, briefer)
- **Visitor slot** (P7/P5): lounge pass QR, slot booking per bed (2 slots/day default, 1 visitor, 15 min), security scan, isolation beds require PPE task; `pass.issued/scanned/revoked`; NEW `visit_slot.booked`.
- **Family briefing** (P5 daily task per bed, SLA by 18:00): `briefing.recorded` with attendees, interpreter used, prognosis category (improving/stable/guarded/critical), decisions, questions; missed → in-charge escalation.
- **Bundle checklists** (P5 daily/shift tasks): VAP (HOB 30–45°, daily sedation interruption, SBT readiness, PUD prophylaxis, DVT prophylaxis, oral care CHG q6h, cuff pressure), CLABSI (daily line-need review, dressing date, hub scrub), CAUTI (daily catheter-need review); each element yes/no/contraindicated; NEW `bundle.element_missed`.
- **HAI surveillance**: ICN suspects (`hai.suspected` NEW) → culture linkage → confirmed/ruled-out (`hai.confirmed`) → register; device-day denominators derive from `device.usage_*` events.
- **M&M review** (P5): every ICU death and every unplanned event (unplanned extubation, readmission ≤ 48 h, Code Blue outside ICU with ICU admission) auto-creates `mm_review.scheduled` NEW → monthly meeting → `mm_review.completed` with learning points (privileged quality document class).
- **Isolation cohort**: `isolation.flagged` (bed), NEW `isolation.cohort_activated/ended` (hall), `floor.lockdown_declared` (surge mechanics §11.14).
- **Ventilated transport** (§11.15): checklist + transport task + receiving confirmation; `transport.bundle_completed`.
- **Crash-cart checks** (P5, per shift): seal intact, defib self-test, O2 cylinder pressure, expiry scan of top-10 items via Expiry Watchman; `task.verified`.
- **Oxygen/utility**: `utility.threshold_breached` from manifold/LMO sensors; ICU-specific rule: pipeline pressure < 4 bar or LMO < 24 h burn at current ICU FiO2 load → intensivist + biomed + duty manager.

## 4. Data model sketch

Module `icu` owns (all with `site_id`, ULID ids, `created_by/at`, `updated_by/at`):
- `icu_admissions` — id, admission_id (IPD), patient_id, hall_resource_id, bed_resource_id, source (er|ward|ot|direct|nicu_birth), priority_class, approver_user_id, approval_id, bypass (bool), admitted_at, stepdown_at, discharged_at, outcome (stepdown|death|lama|refer_out|brain_death_donor), apache2_score/prob, sofa_admit, sofa_max, readmit_within_48h (bool), workflow_instance_id.
- `icu_severity_scores` — admission_id, type (apache2|sofa|news2|qsofa|rass|cpot|cam_icu|gcs|braden), value, components JSONB, computed_by (user|automation), occurred_at.
- `icu_device_associations` — device_resource_id, bed_resource_id, admission_id?, started_at, stopped_at, started_by, stopped_by, charge_line_id?, telemetry_slot_id?, stop_reason.
- `icu_telemetry_slots` — cms_id, slot_code, bed_resource_id, effective_from/to (governed config).
- `icu_flowsheet_hours` — admission_id, hour_start, prefill JSONB, validated JSONB, diff JSONB, source (telemetry|manual), validated_by, validated_at, late (bool), occurred_at/recorded_at.
- `icu_alarms` — id, slot/bed, admission_id?, class, code, raised_at (device clock), received_at, acknowledged_by/at, silenced_by/at/until/reason, escalated_rung, resolved_at.
- `icu_alarm_limit_orders` — admission_id, param, low, high, ordered_by, valid_until.
- `icu_data_gaps` — bed, admission, from, to, cause (probe_off|interface_down|manual_mode|unknown), flagged_at.
- `icu_codes` (Code Blue register) — id, location_resource_id, patient_id?, activated_by/at, drill (bool), responders JSONB (user, arrived_at), sheet JSONB (timed entries), outcome, debrief_at, crash_cart_resource_id.
- `icu_crashcart_checks` — cart_resource_id, shift, checked_by, seal_no, defib_test_ok, o2_pressure, expiring_items JSONB, task_id.
- `icu_bundle_checks` — admission_id, bundle (vap|clabsi|cauti), shift_date, elements JSONB, missed_count, checked_by.
- `icu_hai_register` (statutory/NABH) — admission_id, type (vap|clabsi|cauti|ssi_icu|bsi_secondary), suspected_at, confirmed_at, organism, culture_result_id, device_days_at_onset, icn_user_id, status.
- `icu_sepsis_episodes` — admission_id, clock_started_at, elements JSONB (lactate_at, cultures_at, abx_at, fluids_at, pressor_at), completed (bool), breached_elements.
- `icu_restraints` (register) — admission_id, type, indication, ordered_by/at, consent_id, reviews JSONB, discontinued_at.
- `icu_family_briefings` — admission_id, at, by, attendees JSONB (name, relation, id-proof ref), language, interpreter, prognosis_class, content, decisions, drafted_by_agent?, provenance stamps.
- `icu_visit_slots` — bed, date, slot, pass_id, visitor name, scanned_at.
- `icu_eol_records` — admission_id, type (dnr|withhold|withdraw|advance_directive), consultant_user_id, family_consent_id, boards JSONB (members, opinions, times), jmfc_intimation_ref, executed_at, status.
- `icu_brain_death_certs` (statutory register) — admission_id, exam1 JSONB (4 signatories, tests, apnoea test, time), exam2 JSONB, certified_at, form10_doc_id, mlc (bool), police_noc_ref, required_request_at, coordinator_user_id, donation_consent (form8_doc_id | declined_reason), notto_ref.
- `icu_mm_reviews` — trigger, admission_id, scheduled_for, attendees, findings, actions (tasks), privileged (bool).
- `icu_transport_bundles` — admission_id, destination, checklist JSONB, escort, started/received_at.
- `icu_handovers` — admission_id, shift, outgoing, incoming, checklist JSONB, note (drafted/edited/signed), provenance.
- `icu_kpi_snapshots` (daily materialised) — until the KPI formula registry exists.

**Registry kinds used (Plan 13):** `hall` (status vocab: open, cohort_isolation, lockdown, commissioning), `bed` (available, reserved_ttl, occupied, isolation, blocked_cleaning, blocked_equipment), `device` (free, on_bed, in_use, out_of_service, quarantined, at_vendor), `room` (isolation cabin as room containing one bed). Bed class/tariff stays in IPD (RULED).

**Edge store (TimescaleDB, separate instance):** hypertable `vitals(ts, slot_id, param, value)` compressed after 24 h, continuous aggregates 1-min (kept 10 y) and 1-h; `alarms_raw`; `device_settings(ts, device_id, key, value)`; retention policy 90 d full-res default; legal-hold table `hold_windows(slot_id, from, to)` consulted by the retention job (§11.19-D 26).

**FHIR shapes:** `Observation` (vitals, scores with LOINC), `Device` + `DeviceUseStatement`, `Procedure` (intubation, lines), `Consent`, `Flag` (DNR, isolation), `Encounter` (ICU as sub-encounter location), `DocumentReference` (Form 10, Form 8, briefing).

**Retention:** clinical record 10 y IPD (MLC indefinite); brain-death/organ forms permanent; HAI register 5 y (NABH asks 3 y trend); alarm log 2 y; telemetry per policy; M&M privileged 10 y; legal holds freeze all incl. edge.

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.**

### A. Identity, wrong patient, wrong bed/device mapping
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| I-1 | Patient in bed H1-B07 physically moved to B08 during cleaning, registry not updated; telemetry of B08 slot now attributed to B07's admission | Telemetry attribution uses registry assignment at `occurred_at`; a nurse's flowsheet pre-fill shows slot code + bed; **bed move requires registry move first** (tablet: scan bed + wristband); Device-Bed Reconciler flags a monitor whose patient-demographics field (HL7 PID sent by CMS) disagrees with registry → `device.mapping_conflict_flagged` blocks pre-fill for that bed | Fixture: slot PID name ≠ assigned patient → pre-fill state UNAVAILABLE, conflict event emitted, in-charge task created | — |
| I-2 | Two ventilators swapped between beds by RT without rescanning | `device.associated` requires device QR + wristband; vent telemetry (device id) from a slot not matching association → conflict flag within 60 s; charges follow association not telemetry until resolved | Mutation: swap device ids in feed → flag fires; billing unchanged until human resolves | — |
| I-3 | CMS slot-to-bed config edited wrongly during hall commissioning (off-by-one across all 15 beds) | Slot map is governed config with effective dates; changing it needs a second person; a "slot walk" verification task (nurse presses "mark" on each monitor, system shows which tile lights up) before activation | Test: activation blocked until 15/15 slots verified | — |
| I-4 | Unknown patient (ER UNKNOWN flow) admitted to ICU, later identified; duplicate UHID exists | Patient merge (§11.5) relinks `icu_admissions`, device associations, telemetry attribution via admission id (never by name); merge reversible | Merge/unmerge fixture keeps all ICU rows on survivor and restores on unmerge | — |
| I-5 | Twins in NICU, identical names, adjacent warmers | Mother-baby band pairing (§11.5 item 2) + bed tag; EBM scan; warmer device association to baby; pre-fill blocked if two admissions share a slot | Assertion: `icu_telemetry_slots` unique active bed per slot | — |
| I-6 | Wristband unreadable (oedema, burns, dressings) | Bed-tag scan + second nurse verbal verification recorded as `band_verify.manual` with reason; band reprint task | Fixture: scan fails → manual path available, event carries reason | — |
| I-7 | Patient transferred ICU→ward but ventilator telemetry keeps flowing from the empty slot (device still on) | Occupied-status false → telemetry stored but unattributed; telemetry-without-billing on an unassigned bed is a **device-left-on** flag, not leakage | Reconciler classifies unassigned-slot telemetry separately | — |
| I-8 | Same patient two ICU admissions same stay (ward → ICU → ward → ICU) | Separate `icu_admissions` rows under one IPD admission; 48-h readmission flag; device-days per row | Fixture asserts `icu.readmission_flagged` when gap < 48 h | — |
| I-9 | Staff member as patient in ICU (sealed class) | Tiles show alias; treating-team carve-out (§11.19-E 4) shows facts to bedside; hall overview for non-treating roles shows bed as "occupied (restricted)"; family updates via counsellor only | Sealed fixture: non-treating intensivist of other hall cannot open trend | — |
| I-10 | VIP with bodyguards demanding presence in the hall | No-bedside-attendant rule stands; VIP flag → private isolation cabin preference + lounge; exceptions by medical superintendent evented | Pass scan refuses hall entry outside slots | O-6 |

### B. Admission, triage, contention, step-down
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| B-1 | ER Red patient, intensivist not answering page 10 min | Ladder: 10 min → second intensivist/on-call → 15 min → MS; **act-first bypass**: duty ICU doctor admits with `bypass=true`, review task ≤ 2 h | SLA breach + escalation events in order; bypass admission legal | — |
| B-2 | ICU full; three requests (post-op elective, ER trauma, ward deterioration) | Approver screen shows all with priority class and step-down candidates; elective post-op may be cancelled on-day (§11.9 reason-coded), ward patient held with monitoring + refer-out offer; every decision `icu.hold_resolved` with reason | Fixture: bump decision requires named authoriser; digest lists it | O-1 |
| B-3 | Class-4 ("too well") request from a consultant insisting | Approver may reject with reason; consultant may escalate to MS override (evented, weekly digest §11.14) | Override path exists and is loud | — |
| B-4 | Post-OT patient booked for ICU bed, surgery runs 4 h over | Tentative reservation TTL extended by OT `surgery.started` event; hold visible on board; second request may pre-empt only with intensivist decision | TTL extension test | — |
| B-5 | Step-down ordered 09:00, ward bed not available till 22:00 | Patient remains ICU-billed at ICU class until physical transfer (`patient.transferred` time); "step-down-ready" state shown on board as bump candidate; TPA informed ICU day was bed-blocked (documented for claim) | Rent split by days-in-class at transfer timestamp | O-2 |
| B-6 | Family refuses step-down ("keep in ICU, we'll pay") | Allowed only if bed not needed; class stays ICU; documented counselling; when contention arises, intensivist decision prevails, logged | Contention event references step-down-ready | O-2 |
| B-7 | NICU baby admitted whose mother is LAMA | NICU admission is its own admission with inherited payer at birth; payer becomes self on mother's departure; deposit alert on baby's bill; care continues | Payer-inherit then `payer.switched` | — |
| B-8 | Patient admitted to ICU via management override without approval | Impossible without an approver identity: override IS an approval by MS role, evented | RBAC test: clerk cannot create `icu_admissions` | — |
| B-9 | Disaster mode: ICU pre-empt rule fires | Board shows pre-emptable beds (class 3/4, step-down-ready); mass transfer tasks generated; every transfer documented | Map 13 fixture | — |
| B-10 | Transfer-in from another hospital with no records, ventilated, family carrying a WhatsApp photo of the discharge summary | Direct admission path; referral captured; "outside records" document upload; medication reconciliation task (§11.8); MLC check question mandatory | Admission blocked only for missing approver, never for missing records | — |

### C. Timing, concurrency, clocks
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| C-1 | Ventilator clock 40 min behind NTP; monitor 2 min ahead | Ingest stamps `received_at`; per-device offset estimated from heartbeat (`clock.drift_flagged` > 60 s); display uses server time; device time kept in raw row; flowsheet pre-fill uses `received_at` bucket | Fixture: drifted feed lands in correct hour | — |
| C-2 | Two nurses validate the same hour from two tablets | Optimistic lock on `icu_flowsheet_hours` (version); second gets conflict with diff view | Race test | — |
| C-3 | Alarm ack race: hall station and bed tablet ack simultaneously | First ack wins; second recorded as duplicate ack (not error); both actors logged | Idempotent ack | — |
| C-4 | Device-day start at 23:58, stop 00:02 — 4 minutes across midnight | Charging rule (corporate default): device-day = any use within a calendar day, **minimum charge unit 1 day, but < 1 h use across midnight counts one day** (configurable) | Golden billing fixture | O-3 |
| C-5 | Sepsis clock started retroactively ("we suspected at 02:10, entered 02:40") | `occurred_at` claimed 02:10 vs `recorded_at` 02:40, `late_entry.flagged`; bundle timers compute from claimed time but the register shows both | Dual-stamp assertion | — |
| C-6 | Hour pre-fill at HH:00 when telemetry gap covers 58 of 60 s | Pre-fill state "insufficient data"; manual entry required; gap recorded | Threshold test (≥ 30 s valid data required, configurable) | — |
| C-7 | IST DST-free but server in UTC; report timestamps | All display IST; storage UTC; day boundaries for device-day and room rent computed in IST | Midnight-IST fixture | — |
| C-8 | Code Blue sheet entries typed 20 min after the event from memory | Allowed as late entries with dual stamp; scribe identity; sheet locked after debrief | Late-entry flag on each row | — |
| C-9 | MQTT broker replays 3 h of buffered edge data after reconnect | Idempotency keys (slot, device ts, param); duplicates dropped; pre-fills for those hours *not* regenerated retroactively — validated hours stay; unvalidated hours get a "telemetry now available" hint | Replay test: no duplicate rows, validated rows untouched | — |

### D. Partial failure, downtime, power
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| D-1 | Hall 2 CMS crashes; monitors alarm locally | `interface.down` after 3 missed heartbeats (90 s); hall tiles grey; manual mode auto-suggested at 5 min, in-charge confirms; SLA for biomed 30 min; alarms rely on bedside audible | Heartbeat fixture → mode event + tasks | — |
| D-2 | Core app down, edge up | Edge buffers (SQLite/Timescale local); tablets show cached flowsheet forms (PWA) writing to local queue; paper hourly chart printed per bed at shift start as standing practice (downtime kit) | Backfill: queued hours submit with `occurred_at` | — |
| D-3 | Network down between ICU floor and server room, WAN fine | Floor-scoped degradation (§11.4): ICU declared downtime for floor; PBX for pages; Code Blue via PBX overhead + paper sheet; backfill by ward clerk with `downtime.declared` correlation | Floor-scope test | — |
| D-4 | Power failure; UPS on; generator fails to start | Ventilators have internal battery (30–120 min) — device registry stores battery minutes; `ups.on_battery` NEW event from UPS SNMP → countdown per bed listing vent battery vs elapsed; task: manual bagging roster; oxygen manifold electric valves check | UPS event fixture creates per-bed countdown | O-4 |
| D-5 | Oxygen pipeline pressure drop during 30 ventilated patients | `utility.threshold_breached` critical → cylinder issue tasks to ICU (P3), consumption projection at current FiO2; refer-out planning trigger at < 2 h | Projection formula test | — |
| D-6 | TimescaleDB disk full | Ingest continues to MQTT retained + edge SQLite buffer; alert to admin; retention job runs early; core unaffected | Disk-full simulation | — |
| D-7 | Tablet battery dies mid-validation | Draft autosaved locally; resumes on any tablet after PIN switch (§11.18 item 6) | Draft persistence | — |
| D-8 | Printer down for wristband reprint | Handwritten temporary band + reason event; reprint task | Manual band path evented | — |
| D-9 | Telemetry gateway rebooted during hour boundary | Pre-fill job retries at HH:05, HH:15; after that hour marked manual | Retry schedule test | — |
| D-10 | WhatsApp API down; family update due | Fallback ladder SMS → PBX call task to counsellor (§11.5 ladder); briefing record independent of delivery | `notification.failed` → task | — |

### E. Money — billing, deposits, packages, TPA, PMJAY
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| M-1 | Deposit exhausted day 3, family cannot pay | E7: alerts 75/90%, interim bill, top-up request, management escalation; **no clinical throttle** — orders never blocked; credit-stop override by owner only for non-clinical extras | Assertion: order API ignores deposit state | — |
| M-2 | TPA pre-auth ₹1.5L sanctioned; ICU burn ₹35k/day | Burn-Rate Nudger projects breach day; enhancement request task to TPA desk 24 h before; `package.overrun_projected`; family told transparently in briefing | Projection = (sanction − billed)/burn | — |
| M-3 | Pre-auth enhancement denied mid-stay | `preauth.denied` → payer-switch counselling (§11.11), documented; care continues; billing tags lines after denial as self/pending | Payer switch splits bill at timestamp | — |
| M-4 | PMJAY package (e.g. ICU with ventilator per-day package) vs actual consumables | Package machinery: allowances consumed, overrun absorbed or billed per scheme rules (PMJAY: cannot bill beneficiary); `package.allowance_consumed`; overrun to a named cost center (leakage principle) | Cost-center termination test | O-5 |
| M-5 | Ventilator on for 3 days, only 1 day billed (nurse forgot stop/start) | Reconciler: telemetry-without-billing = leakage flag daily; correction posts charge with reason; never silent | Daily reconciliation fixture | — |
| M-6 | Billed ventilator-day but patient on T-piece all day | Billed-without-telemetry orphan → review; credit note if confirmed | Orphan flag fixture | — |
| M-7 | Infusion pumps: 6 pumps on one patient — bill per pump or per patient/day? | Corporate default: per patient per day "infusion pump charge" up to N pumps then per-pump tier; configurable; from `device.usage_*` counts | Tariff rule test | O-3 |
| M-8 | Patient dies at 00:20 — full day ICU charge? | Corporate default: room/ICU rent charged for day of death if past 6-h grace? Recommend: ICU day charged in full only after 06:00; before that, no new day; configurable | Boundary fixture | O-3 |
| M-9 | Family disputes running bill via WhatsApp daily bill | Line-item review from event trail; grievance workflow (§11.14) | Bill lines each reference an event | — |
| M-10 | Refund of unused ICU deposit to a relative not the payer | Refunds to whoever paid (§7); death case: legal heir declaration form + ID; above threshold bank transfer only | Refund gate | — |
| M-11 | Membership/insurance sale attempt at ICU bedside | Forbidden (§11.19-C 32) — UI has no sale action in ICU context | RBAC/UI test | — |
| M-12 | Blood products under MTP: 12 units issued, 3 returned unused within cooler window | Blood bank reconciliation per unit; only transfused units billed; returned cooler units credited | Per-unit event chain | — |
| M-13 | Doctor visit charges: 3 consultants see the ICU patient daily | Consultant attribution per visit note; corporate default: intensivist daily charge + each cross-consult once/day; fee-split ledger | Attribution fixture | O-3 |
| M-14 | TPA asks for hourly charts to justify ICU days | Export of validated flowsheet as PDF with QR verification (§11.18 item 4) | Document verify test | — |

### F. Consent, legal, MLC, minors, unconscious, end-of-life
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| L-1 | Unconscious patient, no attendant, needs central line | Two-doctor consent variant (§11.3) recorded; retro-consent from family when they arrive | Consent record type `two_doctor` | — |
| L-2 | Minor in PICU; parents divorced, disagree on withdrawal | Legal guardian per custody document; conflict → hospital ethics committee + legal; no withdrawal without SC-guideline boards + guardian consent; record every discussion | EOL workflow blocks without consent id | — |
| L-3 | MLC patient (assault) dies in ICU | Death in MLC → police intimation task, body to mortuary with post-mortem flag, no death certificate cause without PM; brain-death donation requires police NOC | MLC flag gates `body.released` | — |
| L-4 | Family requests LAMA of ventilated patient ("take him home") | DAMA counselling recorded (risks, in language), LAMA form signed, ambulance offered, transport ventilation bundle if going; billing settle; typed discharge; ICU outcome = lama | E5 machinery + ICU outcome enum | — |
| L-5 | Family wants "no CPR" but insists on ventilation | DNR is per-intervention (§11.14): code status = DNAR-only; eMAR/chart flag; Code Blue button still logs but team knows | Flag renders on tile + Code screen | — |
| L-6 | Advance directive produced by family from a lawyer's file | Verify attestation (2023 rules: two witnesses, notary/gazetted officer); scan to patient master; executor identity; treating doctor + board still required for withdrawal | Directive document class + verification fields | — |
| L-7 | Hospital's primary board declines withdrawal; family goes to High Court | `withdrawal.declined` with reasons; legal hold on record; document export path | Legal hold freezes telemetry window | — |
| L-8 | Brain death suspected, hospital not registered for retrieval | Certification still done (Form 10) by four-member board; required request still mandatory (§3(1A)); if consent, transfer to registered centre via SOTTO coordination; else withdrawal post-certification | Workflow branches on `retrieval_registered` config | O-7 |
| L-9 | Family consents to donation but one near-relative objects later | Form 8 signed by near relative in order of precedence; objection recorded; coordinator + legal decide; no retrieval while objection open | State `consent_contested` | — |
| L-10 | Brain-death second exam conducted by same three doctors as first plus a different neurologist | Rule: each exam needs the four roles; same individuals allowed; system validates role composition, not identity change; time gap ≥ 6 h enforced | Composition validator | — |
| L-11 | Apnoea test aborted (haemodynamic instability) | Exam recorded as incomplete; ancillary test (e.g. cerebral angiography) reference captured; certification blocked until valid exam pair | Assertion | — |
| L-12 | Death in ICU of a foreign national | MLC-like reporting: embassy intimation task, FRRO; MRD handles; ICU shows checklist | Nationality-triggered task | — |
| L-13 | Restraint applied by nurse at 2 a.m. without order | Nurse can record "emergency restraint" with 1-h physician order SLA; unmet → escalate; NABH audit sees it | SLA breach fixture | — |
| L-14 | Patient regains capacity and refuses further ventilation | Capacity assessment documented; refusal recorded (`refusal.recorded`); psychiatric consult if doubt; treating team decision path; no withdrawal boards needed for competent refusal but counselling recorded | Path distinct from surrogate withdrawal | — |
| L-15 | Family asks for "DNR" verbally on phone from abroad | Not accepted alone; video-consent recorded with identity + witness, consultant confirmation | Consent channel enum | — |
| L-16 | Pregnant ICU patient, foetal viability | Obstetric co-management; MTP Act considerations documented; PCPNDT for scans | Cross-module task | — |
| L-17 | Suspected POCSO case in PICU | POCSO intimation register; sealed-class handling | Auto-task on age + indication | — |
| L-18 | Organ retrieval: NOTTO allocation, green corridor | Coordinator worklist: NOTTO ref, allocation, retrieval team arrival, OT booking (§11.16 emergency pre-empt), ambulance task | Workflow references OT booking | — |

### G. Staff absence, overload, handover
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| S-1 | Night: 15 ventilated beds in hall, 5 nurses (1:3) | Ratio indicator red; `overload.flagged`; Coverage Resolver proposes pulls from ward pool (eligible ICU-trained only per credential registry); duty manager approves | Ratio computed from live roster × occupancy | — |
| S-2 | Nurse leaves mid-shift (emergency) | Open tasks/hours auto-return to hall pool; handover force-escalates | Pool return test | — |
| S-3 | Resident 2 a.m. cannot reach intensivist for a crashing patient | Doc 10 ladder: 5-min ack → second intensivist → anaesthetist on-call → MS; each rung evented; act-first allowed | Ladder fixture with timers | — |
| S-4 | Handover not acknowledged for 3 beds at 08:00 | `handover.completed` missing → 15 min → in-charge → 30 min → matron; tiles show "unhanded" badge | Escalation test | — |
| S-5 | Intensivist on leave, only one covering 45 beds | Roster validation gate: ICU minimum coverage policy (1 intensivist per 15 beds daytime, 1 floor at night) — violating roster doesn't publish (`roster.blocked`) | Roster rule | O-8 |
| S-6 | Locum intensivist (temp role) approving admissions | `temp_role.granted` with expiry, credential verified; approvals work within grant | Grant expiry test | — |
| S-7 | RT absent, nurse changes vent settings on verbal order | Titration/vent change logged via eMAR-style entry with "verbal order" flag → doctor countersign SLA 1 h | Countersign SLA | — |
| S-8 | ICN on leave; HAI suspected | Suspect flag by any nurse; ICN queue; confirmation deferred but register row exists with `suspected` | Role-independent suspect | — |
| S-9 | Handover note drafted by agent but outgoing nurse didn't read | Note requires outgoing edit/sign + incoming ack; agent draft alone never completes handover | Assertion: `handover.completed` requires two human acts | — |

### H. Equipment failure
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| Q-1 | Ventilator fails; backup vent 2 halls away | Backup vent is tracked asset with location; one-touch "need vent" task to biomed + porter; 30-min SLA; device swap re-association | Task + reassociation | — |
| Q-2 | Infusion pump occlusion alarm on noradrenaline | Critical class (pressor pump) → bed nurse + hall station; pump feed if integrated, else nurse-raised | Class mapping test | — |
| Q-3 | Monitor probe off for 20 min on sedated patient, nurse not at bed | Technical alarm → 5 min → `data_gap.flagged` → in-charge; gap in legal chart shown as gap | Gap fixture | — |
| Q-4 | ABG POCT analyser QC failed | QC lockout (§11.15); orders route to central lab with STAT flag; lockout visible on ICU worklist | Lockout blocks result acceptance | — |
| Q-5 | Defibrillator self-test failed at shift check | Crash-cart check fails → device out_of_service → replacement task critical; hall board banner | Check → status → task | — |
| Q-6 | Calibration overdue on 3 monitors | Expiry Watchman flags; device stays usable (no clinical block) but flagged; biomed task | Non-blocking flag | — |
| Q-7 | Recalled infusion pump model (vendor advisory) | Device recall register: list, quarantine tasks, replacement | Recall workflow | — |
| Q-8 | ECMO/CRRT machine on consignment from vendor | Consignment device (Plan 14 ledger) with per-run consumable kit billing; device-days as usual | Consignment + device-day | — |
| Q-9 | Monitor sends HL7 with unit mismatch (mmHg vs kPa) after firmware update | Ingest validates units per param; out-of-range/unit anomaly → quarantine stream + interface alert; pre-fill withheld | Unit validator test | — |

### I. Data quality, late-arriving, backdated
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| X-1 | Nurse validates hour with SpO2 typed 998 | Range validation with hard/soft limits per param; confirm dialog; value stored with `confirmed_out_of_range` | Validator fixture | — |
| X-2 | Lab result (K⁺ 6.8) arrives after hour validated | Flowsheet hour is not amended; lab lives in results with `result.critical_flagged`; ICU worklist raises critical | Separation of concerns test | — |
| X-3 | APACHE II computed with missing ABG | Score shows "incomplete (missing PaO2)"; SMR excludes incomplete or imputes per published method — flagged | Completeness flag | — |
| X-4 | Backdating a briefing to yesterday to meet KPI | Only late entry with dual stamp; KPI counts `recorded_at` by default; gaming vector row F-3 | KPI formula pins `recorded_at` | — |
| X-5 | Telemetry value spike artefacts (suction, movement) | Pre-fill uses median of 60 s, not last sample; nurse edits are expected and not penalised | Median test | — |
| X-6 | Free-text "prognosis" in Hinglish transliteration | Stored as-is; language tag; agent drafts use tokenised text | Scrubber fixture with Hindi names | — |
| X-7 | Device-day stop missing at discharge | Discharge cascade (§11.2 step 4 no-pending-charges) auto-stops open device associations with reason `auto_stop_discharge`, flags for review | Cascade fixture | — |
| X-8 | Duplicate HAI: same VAP suspected twice by two nurses | Dedup on (admission, type, window 7 d); ICN merges | Uniqueness | — |

### J. Fraud, leakage, gaming
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| F-1 | ICU days extended for TPA patients ("keep till sanction exhausted") | KPI: ALOS by payer vs severity-adjusted expected; step-down-ready days per payer; Fraud Sentinel diagnostic, digest to owner | Diagnostic report exists | — |
| F-2 | Ventilator billed on patient never intubated | Orphan flag (billed-without-telemetry) + no intubation procedure event → high-confidence flag | Cross-check fixture | — |
| F-3 | Briefing compliance gamed by 30-second "briefings" | Briefing record requires attendee identity + content fields; duration not KPI; family feedback (post-discharge) sampled | Required-field assertion | — |
| F-4 | Alarm ack gaming: nurse acks from station without visiting | Critical alarms require bedside tablet ack (bed QR scan) for the KPI; station ack allowed but flagged `remote_ack` | Ack source enum | — |
| F-5 | Consumables issued to ICU sub-store, never billed (leakage) | Ward sub-store counts by stores staff (SoD); variance report; per-bed consumption benchmarks | Variance fixture | — |
| F-6 | Crash cart drug diverted (morphine) | Seal event trail; NDPS register with witness; replenish reconciliation vs code sheet doses | Reconciliation: sheet doses = replenished qty | — |
| F-7 | Fake donor consent for organ | Form 8 signatories with ID scan; coordinator certified; NOTTO cross-check; MLC NOC | Document completeness gate | — |
| F-8 | Doctor bumps a self-pay patient to admit a TPA patient | Bump decision evented with authoriser, digest surfaces bump patterns by payer | Digest query | O-1 |
| F-9 | Silencing alarms hall-wide at night | Silence max 3 min critical/10 min advisory; hall-level silence impossible; silence counts per nurse per shift on fatigue audit | Policy limits | — |
| F-10 | Visitor pass sold/lent | Pass QR bound to visitor name + ID; repeated scans different names → security flag | Pass scan anomaly | — |

### K. Privacy, sealed, VIP
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| P-1 | Journalist calls about a VIP in ICU | Single-spokesperson rule; ICU staff have no external status screen; alias on boards | RBAC | — |
| P-2 | Family shares WhatsApp daily update with 40 relatives | Update contains prognosis class only, no clinical detail unless family opted for detail; counsellor-approved template | Template governance | — |
| P-3 | Tele-ICU vendor sees identities | Remote intensivist is an RBAC'd user; vendor platform receives tokenised feed unless DPA in place; DPIA class L1 | Contract gate | O-9 |
| P-4 | Hall dashboard on a 55" screen visible to visitors at door | Public-facing tiles show bed + alias + alarm status only; full view on station terminals | Display mode | — |
| P-5 | DPDP erasure request from a discharged ICU patient | Bounded by retention law (10 y IPD); response documents why; telemetry may be deleted per policy earlier | DSR fixture | — |

### L. Language, literacy, accessibility
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| A-1 | Family speaks only Bhojpuri; consent for tracheostomy | Interpreter field mandatory when language ≠ Hindi/English; consent read aloud, thumb impression + witness; audio recording optional (consent to record) | Consent record fields | — |
| A-2 | Illiterate attendant receives running bill on WhatsApp | Voice note / IVR read-out option; counsellor explains; acknowledgement recorded | Channel option | — |
| A-3 | Deaf patient regaining consciousness on vent | Communication board; note in care plan; capacity assessment aids | Care-plan task | — |
| A-4 | Nurse UI Hindi; drug names English | Bilingual labels; drug names never transliterated | i18n test | — |
| A-5 | Family cannot read visiting-slot QR pass | Printed pass with large time and bed in Hindi; security reads for them | Print design | — |

### M. Scale
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| Z-1 | 10 beds today → 45 + 15 NICU + PICU | Halls commission progressively (registry); slot maps per hall; ingest ~600 pts/s at 1 Hz | Load test at 2× | — |
| Z-2 | TimescaleDB 1 Hz × 12 params × 60 beds ≈ 62M rows/day | Compression (≥ 10×), 90-d full-res ≈ 40–80 GB; 1-min aggregates for 10 y ≈ 5 GB; NVMe 1 TB box adequate | Sizing test | — |
| Z-3 | 45-bed floor overview WebSocket to 20 clients | Server-side 2 s aggregation; clients subscribe by hall; perf budget < 100 ms interaction | Perf test | — |
| Z-4 | Two ICU floors in future (cardiac ICU on heart floor, §11.19-A) | Hall is the unit; floors are registry parents; no code assumes one floor | Fixture with 2 floors | — |
| Z-5 | Monthly HAI denominators over 1,800 device-days | Materialised daily counts | SQL test | — |

### N. Integration failures (device/vendor/ABDM/TPA)
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| N-1 | Vendor CMS HL7 feed uses non-standard OBX codes | Per-vendor mapping table (governed config); unmapped code → quarantine + alert, never silent drop | Mapping test | — |
| N-2 | Two vendors across halls (Mindray in H1, Philips in H2) | Edge adapter per vendor; canonical param ids (LOINC) in Timescale | Adapter contract test | — |
| N-3 | Pumps not integrated (day-one reality) | Infusion rates from eMAR titration entries; pump device-days from association scans; upgrade path when pump server bought | Manual rates path | — |
| N-4 | ABDM care-context push for ICU stay | Encounter-level care context; telemetry never pushed; discharge summary only with consent | Payload allowlist | — |
| N-5 | TPA portal down for enhancement | Task remains open with attempts log; family informed; no clinical effect | Attempt log | — |
| N-6 | Edge device token expired | Feed rejected (§11.19-D 21) → `interface.down` → manual mode suggestion; token rotation task | Auth reject test | — |
| N-7 | Tele-ICU link down | Local intensivist ladder unchanged; tele is additive | Fail-open | — |
| N-8 | Blood bank LIS separate; MTP units | `unit.issued` events from blood bank module; ICU only activates | Event contract | — |

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 02:00 — Hall 2 CMS dies, then the network switch.** 02:00 heartbeat misses; 02:01:30 `interface.down` H2; tiles grey; station banner; biomed paged (30-min SLA). 02:06 manual-mode suggestion; in-charge confirms → `telemetry.manual_mode_entered(H2)`; 15 nurses' worklists gain q1h manual vitals tasks; bedside monitors alarm audibly. 02:20 floor switch dies — tablets lose server; PWA cache serves flowsheet forms locally; downtime kit: pre-printed hourly sheets per bed pulled from the drawer; Code Blue via PBX overhead. 02:40 bed 9 desaturates; nurse bags, resident intubates; paper code sheet; crash-cart seal broken (physical seal number noted). 03:30 network restored; tablets flush queued hours (`occurred_at` = the hour, `recorded_at` = 03:31, `late=true`); ward clerk enters paper code sheet at 07:00 as late entries; seal number reconciles with `crashcart.opened` backfill; pharmacy replenish task. Agents: Deterioration EW silent (no data) — its fail-open is nothing; Reconciler shows a 90-min gap on 15 beds tagged `interface_down`, not leakage. Audit shows: `interface.down`, mode entered, 15×N manual hours with source=manual, code with late entries, `interface.restored`, mode exited, gaps table.

**6.2 Mass casualty (bus crash), 14:00.** `disaster.declared` → ICU pre-empt rules: board lists 6 step-down-ready patients; intensivist confirms 4 transfers (`icu.bump_decided` ×4, all evented with names); porters; ward beds surge. ER sends 5 Reds; approvals ride the interrupting channel; two bypass admissions by duty MO reviewed within 2 h. All casualties auto-MLC; DIS-tags resolve later (map 13); telemetry attribution to DIS-tag admissions works because slots bind to admissions, not names. MTP ×2 activated; blood bank O-neg release documented. Deposit alerts suppressed in disaster mode (money later). Post-event: weekly digest lists the 4 bumps, 2 bypasses, 2 MTPs with per-unit reconciliation.

**6.3 Deposit exhausted + TPA denial + family wants withdrawal, same afternoon.** Day 9, self-pay converted from TPA after `preauth.denied`; deposit at 96% → management escalation; family says "stop everything, we can't pay." System: care continues (M-1); counsellor records EOL discussion; intensivist explains withdrawal is a medical-board process (SC 2023), not a billing action; if clinically appropriate, primary board convened (`withdrawal.board_convened`), 48-h clock; billing desk prepares interim bill; owner digest shows credit exposure. If board declines, family may LAMA (DAMA counselling, ambulance). Audit: no order was ever blocked by billing state — provable by absence of any billing-gated refusal event.

**6.4 Wrong-bed mapping discovered on day 3 of Hall 3 commissioning.** Nurse notices bed 12 tile shows a sinus rhythm while the patient is in AF. Slot walk reveals slots 11–15 shifted by one. `device.mapping_conflict_flagged` had fired twice (PID mismatch) and been dismissed. Actions: hall 3 pre-fills for the 5 beds since commissioning flagged `attribution_suspect`; validated hours stand as legal record (nurse-validated, presumably corrected at bedside) but carry a suspect flag with a review task; incident reported (`incident.reported`); slot map corrected with second-person approval; telemetry rows re-attributed by a migration recorded as an event. Lesson encoded: conflict flags cannot be dismissed without in-charge identity, and the slot walk becomes a hard gate (I-3).

**6.5 Brain death on a Sunday night, MLC patient, family from another state.** Second exam 23:40 → `brain_death.certified`; time of death = 23:40 (Form 10). Required request logged by on-call coordinator 00:10; family consents (Form 8) 03:00 with interpreter (Maithili); MLC → police NOC task; hospital is not a retrieval centre → SOTTO contacted, patient maintained on ventilator (billing: post-certification maintenance charged to a named cost center, not family — O-7); retrieval team from a registered centre arrives 09:00; OT emergency pre-empt; `organ.retrieved`; body release double-verify with post-mortem coordination. Audit: two four-signature exams ≥ 6 h apart, NOC ref, consent doc, cost-center lines.

**6.6 Alarm storm + short staffing + a fall.** Night shift, 5 nurses, 15 beds; bed 4 delirious patient (CAM-ICU positive) triggers 40 technical alarms/hour; `alarm.storm_flagged`; in-charge pulls a ward-float nurse (Coverage Resolver proposes; duty manager approves at 01:15); resident orders emergency restraint via nurse (L-13, order SLA 1 h); patient falls at 01:50 while restraint check task overdue — incident; M&M trigger. Digest next morning: storm flag, overload flag, late restraint order, overdue check task, incident — each a diagnostic, none a penalty; the KPI reading shows the load context (1:3 ratio at the time).

**6.7 Power failure with generator failure, 18:00, 22 ventilated.** `ups.on_battery` → per-bed countdown (vent battery minutes from registry vs elapsed); at 20 min the board sorts beds by remaining battery; bagging roster task; oxygen manifold check; MS informed; refer-out planning threshold at 45 min; generator fixed at 32 min. Audit: UPS event, countdown snapshots, tasks claimed, no patient harm; biomed action item on generator ATS.

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | Table | Who signs | Retention |
|---|---|---|---|---|
| Brain-stem death certificate (Form 10) | THOTA 1994 §2(d), Rules 2014 | `icu_brain_death_certs` | 4-member board, two exams | Permanent |
| Near-relative donation consent (Form 8), donor pledge (Form 7), retrieval reports | THOTA Rules 2014; NOTTO | same + document refs | Near relative, coordinator, RMP | Permanent |
| Required request record | THOTA §3(1A) (2011 amendment) | `organ_donation.requested` event + table | Coordinator | Permanent |
| Withdrawal/withholding decisions, advance directives, JMFC intimation | SC *Common Cause* 2018 as modified 24 Jan 2023 | `icu_eol_records` | Boards, surrogate, treating doctor | Permanent |
| DNR / refusal | NABH COP; §11.14 | flags + consent | Consultant | 10 y |
| Restraint register | NABH COP (restraint standard) | `icu_restraints` | Physician q24h | 10 y |
| HAI register + device-days | NABH quality indicators (VAP/CLABSI/CAUTI per 1,000 device-days), ICMR/NCDC HAI surveillance (Kayakalp) | `icu_hai_register` | ICN | 5 y |
| Code Blue register + drill log | NABH FMS/COP | `icu_codes` | Team leader | 5 y |
| Crash-cart check log, NDPS balance | NDPS Act, D&C Act | `icu_crashcart_checks` + pharmacy NDPS register | Custodian + witness | NDPS 2 y+ |
| Sepsis bundle register | NABH quality; SSC | `icu_sepsis_episodes` | — | 5 y |
| Isolation/outbreak register | Clinical Establishments Act; IDSP notifiable | `isolation.*` events + register | ICN | 5 y |
| Death register (hospital), MLC death intimation | Registration of Births & Deaths Act 1969; CrPC/BNSS MLC | MRD tables; ICU emits `patient.deceased` | RMP | Permanent |
| Consent forms (procedures, restraint, transfer, DAMA) | NABH; Indian Contract/tort law | `consent.recorded` | Patient/surrogate + witness | 10 y |
| Family briefing/counselling record | NABH PRE | `icu_family_briefings` | Doctor/counsellor | 10 y |
| M&M minutes | NABH quality (privileged) | `icu_mm_reviews` | Quality manager | 10 y |
| Alarm silence audit | NABH patient safety (alarm management) | `icu_alarms` | — | 2 y |
| Telemetry retention policy | DPDP Act 2023 (storage limitation), §11.19-D 26 | edge policy table | Owner-approved policy doc | 90 d / 10 y agg |
| Occupational exposure (needle-stick) | §11.14 PEP | exposure register | ICN | 10 y |
| BMW segregation in ICU | BMW Rules 2016 | Plan 19 | — | — |
| Equipment calibration/AMC | AERB (portable X-ray), NABH FMS | biomed | — | life of device |

**What NABH asks to see:** HAI rates with denominators, bundle compliance audits, restraint audits, Code Blue drill records with response times, alarm-management policy, ICU admission/discharge criteria document, mortality with SMR, readmission ≤ 48 h, unplanned extubation rate, family communication records, end-of-life policy, hand-hygiene audits (ICN), crash-cart checks daily.
**What an inspector demands:** THOTA registrations and forms; NDPS balance vs crash-cart usage; death register consistency; MLC intimations; fire/electrical safety for ventilators; medical gas pipeline certification; CEA registration.
**DPDP classes:** L1 clinical telemetry + flowsheet (sensitive); L1+ sealed (VIP/staff); EOL/donation documents highest; family contact data L2; tele-ICU vendor transfer requires DPA + DPIA revision.

## 8. Staff KPI & KRA

All formulas will live in the KPI formula registry (roadmap note 5); until then S10 v1.3 is book of record. Every KPI shows load context (census, ventilated count, ratio) and is diagnostic only.

**Intensivist** — KRA: severity continuously triaged; admission decisions defensible; families informed; end-of-life handled lawfully.
1. Admission-approval response: median(`approval.granted/rejected.at` − `approval.requested.at`) for `icu.admission`; target < 10 min; normalised by simultaneous requests. Gaming: bypass abuse → bypass rate shown alongside.
2. SMR = observed deaths / Σ APACHE-II predicted mortality (complete scores only; incomplete % shown). Diagnostic across quarters, never per doctor.
3. 48-h ICU readmission rate = `icu.readmission_flagged` / step-downs. Target < 5%.
4. Daily briefing compliance = beds with `briefing.recorded` by 18:00 / occupied beds. Resists gaming via required fields (F-3).
5. Step-down decision latency = `patient.transferred` − `stepdown.recommended` (bed-block share attributed to IPD, shown separately).
6. Device-reconciliation exceptions per 100 device-days attributable to their orders.
7. Escalation response (doc 10): rung-1 ack ≤ 5 min rate.

**ICU Nurse** — KRA: 1–2 patients continuously monitored with a defensible record.
1. Critical alarm ack ≤ 60 s rate (bedside-source acks; remote acks reported separately). 2. Hourly chart validation on-time rate (validated ≤ 30 min after hour) and validation *completeness*. 3. Bundle element compliance (VAP/CLABSI/CAUTI elements done / due). 4. Data-gap minutes on assigned beds per shift (cause-classified — probe-off vs interface). 5. Restraint check on-time rate. 6. Handover acknowledgment 100%. 7. eMAR scan compliance (nursing doc). Load context: assigned beds, ventilated beds, admissions/discharges that shift.

**ICU In-Charge** — KRA: hall staffed, handed over, stocked, cohort-ready. KPIs: roster published without block; ratio breaches per shift; overdue hours per shift; crash-cart check completion; visitor-slot policy breaches; storm flags addressed within 30 min; sub-store variance.

**Duty ICU Doctor** — KRA: first response and safe bridging till senior. KPIs: alarm rung-3 response; Code Blue first-responder time; sepsis bundle element timeliness; verbal-order countersign ≤ 1 h; bypass review completion.

**Respiratory Therapist** — KPIs: SBT performed when eligible (daily screen) rate; unplanned extubation per 100 ventilator-days; cuff-pressure checks; circuit-change compliance; transport bundles complete.

**Infection-Control Nurse** — KPIs: VAP/CLABSI/CAUTI per 1,000 device-days (trend, with denominators); suspect-to-confirm latency; bundle audit coverage; hand-hygiene audits done; isolation flag-to-cohort time in outbreak; HAI register completeness.

**Clinical Pharmacist** — KPIs: restricted antimicrobial approvals within SLA; antibiotic day-review compliance; TDM-guided dose adjustments; crash-cart expiry exceptions.

**Counsellor** — KPIs: briefing scheduled and recorded; interpreter use when needed; DAMA counselling completeness; family feedback score (post-discharge, sampled).

**Biomedical** — KPIs: critical response ≤ 30 min; PM on-time; backup vent availability 100%; UPS test log; calibration overdue count.

**Owner's 8 a.m. digest (ICU block):** census per hall + ventilated + isolation; admissions/step-downs/deaths (with SMR trend); bumps/bypasses/overrides (named); alarm storms + silence audit anomalies; data-gap minutes by cause; device reconciliation orphans/leakage ₹; deposit exposure + pre-auth expiring today; bundle compliance %; HAI suspects; sepsis bundle breaches; Code Blues (real/drill); overdue briefings; ratio breaches; EOL/brain-death cases in progress.

## 9. AI agents & the copilot — where inference earns its place

Rule applied: automation unless the task needs inference. Tiers respect the clinical cap.

| Name | Type | Tier | Trigger / inputs | Output | Human sign-off | Fail-open path | Kill scope | Provenance | Eval/guardrail | DPIA | Phase |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Alarm Governor | automation | T1 | alarm events, limit orders, silence policy | escalation ladder, storm flags, silence-limit enforcement | none (policy is owner-activated definition) | monitors alarm locally | per-hall | n/a | policy fixtures | L1 internal | ICU-1 |
| Device-Bed Reconciler | automation | T0 | device.usage_*, telemetry presence, PID mismatch | orphan/leakage/conflict flags, daily report | billing corrects | manual audit | hospital | n/a | golden day fixtures | L1 internal | ICU-1 |
| Bundle & HAI Watchman | automation | T1 | device-days, bundle tasks, culture results | due tasks, missed-element nudges, HAI suspect hints (rule: device ≥ 48 h + new culture positive) | ICN confirms | paper audit | per-hall | n/a | rule fixtures | L1 | ICU-3 |
| Sepsis Clock | automation | T1 | doctor flag or qSOFA≥2 + lactate ≥ 2 (rule-suggest, doctor starts) | timed tasks, breach flags | doctor starts/stops | paper bundle sheet | per-hall | n/a | timer fixtures | L1 | ICU-1 |
| Burn-Rate & Pre-auth Nudger | automation | T1 | charges, deposit, sanction | projection, tasks to TPA desk/family message draft | billing desk | manual interim bill | hospital | n/a | arithmetic fixtures | L2 | ICU-1 (IPD dependency) |
| Code Blue Dispatcher | automation | T3 | code.activated | roster-resolved page via PBX + push; responder tracking | none (act-first) | overhead PBX | hospital | n/a | drill fixtures | L1 | ICU-1 |
| Crash-Cart Expiry Watchman | existing Expiry Watchman | T1 | cart contents batches | expiring-item tasks | pharmacist | manual check | existing | n/a | existing | — | with pharmacy |
| Telemetry Retention Executor | automation | T4 | policy + holds | downsample/delete jobs | owner-approved policy | none needed | edge | job log | hold fixtures | L1 | ICU-2 |
| **Deterioration Early-Warning** | agent (model over trends; may start as rule NEWS2/SOFA-delta) | **T0 report / T1 nudge only, forever** | 1-min aggregates, last labs, scores, vent/pressor settings (tokenised; no identity) | ranked "attention" list per hall + rationale citing fact lines; never an order, never an alarm class | intensivist looks; decision theirs | nothing (silence) | per-hall + global | model id, prompt v, input hash on each flag event | shadow mode vs outcomes ≥ 90 d; false-positive rate cap; no per-user tuning; claims must cite lines | L1 tokenised, pinned provider under DPA | ICU-4 (after 12a gates) |
| ICU Handover Note Drafter | agent (`icu` pack of the Lens) | T2 | validated flowsheet, orders, events of shift | draft SBAR note; typed claims cite line ids | outgoing nurse edits/signs, incoming acks | nurse writes note | per-hall | stamped in event + signed doc | citation entailment fixtures; adversarial free-text | L1 tokenised | ICU-4 |
| ICU Transfer/Discharge Summary Drafter | §16 Discharge Drafter + `icu` pack | T2 | admission timeline, scores, devices, procedures, antibiotics | draft summary | intensivist signs | doctor types | existing switch | stamped | existing suite + ICU fixtures | L1 | with IPD drafter |
| Family-Update Drafter | agent | T2 | briefing record (structured fields) + language pref | plain-language WhatsApp draft in Hindi/English (regional via template) | counsellor/doctor approves send | manual message | hospital | stamped | tone/leak fixtures; never new clinical facts (narrate-never-originate) | L2 (no identifiers in payload) | ICU-4 |
| Workflow Tuner (existing) | agent | T2 | 90 d baselines | proposes SLA/ladder changes | owner activates | — | existing | — | — | — | post-baseline |

**Three presentation lanes for ICU work:** Lane 1 hand-built — hall dashboard (15 tiles + alarms), bedside flowsheet tablet, Code Blue screen, admission-approval interrupt screen (phone). Lane 2 schema-generated — bundle checklists, restraint reviews, crash-cart checks, HAI register forms, M&M forms, visitor slots, transport bundle, EOL/THOTA forms (structured, long-tail). Lane 3 conversation (clinical-roles-last ruling stands) — after 12a: "show me beds with rising lactate", "draft today's family update for bed 7", "who bumped whom last week" — propose→confirm, no free-text orders.
**Journey Feed contributions:** ICU admission approval, device start/stop, hourly validated chart (collapsed), alarms escalated, Code Blue, briefings, bundle misses, EOL decisions, brain-death exams, step-down, readmission flag — the patient's timeline is the ICU chart view.

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context**: bed tag QR on every bed head; scanning opens that bed's flowsheet; wristband scan confirms. Device tags for association.
- **Pre-fill + validate** replaces hourly transcription: target nurse charting time < 3 min/hour/bed (from ~10 on paper).
- **Alarm limits as orders** with expiry; storm flags; bedside-ack via bed QR.
- **Interrupting approvals on the phone**: approve ICU admission in two taps with the score card visible; target median < 5 min.
- **Code Blue one-touch** on every screen and physical button per hall wired to the app (PBX integration); timed sheet with big tap buttons (shock/adrenaline/rhythm).
- **Worklists**: nurse merged queue (hours due, bundle elements, restraint checks, titration confirmations, handover); doctor list sorted by attention score (T0) and critical results.
- **TAT clocks** visible: sepsis hour-1, restraint order due, pre-auth expiry, deposit burn days-left, handover pending.
- **Printing**: hourly chart PDF per day with QR; Form 10/8; transfer summary; visitor pass; downtime hourly sheets pre-printed with bed and slot.
- **Keyboard-first** at station terminals; large touch targets on tablets; Hindi/English toggle.
- **Voice**: dictation for briefing notes (on-device/in-boundary only; no cloud STT without DPIA) — flag-inert until ruled.
- **Measured targets**: pre-fill availability ≥ 98% of occupied-bed hours; critical alarm ack ≤ 60 s ≥ 95%; device-day reconciliation exceptions < 1%; briefing compliance ≥ 95%; approval median < 10 min; dashboard tile latency ≤ 2 s; audit: every flowsheet value traceable to telemetry row or nurse identity.

## 11. Integrations, devices & dependencies

| Device class | Indian-market examples | Protocol | Edge rule |
|---|---|---|---|
| Multipara monitors + per-hall CMS | Mindray BeneVision N-series + CMS; Philips IntelliVue + PIC iX; Nihon Kohden; GE Carescape; Skanray/BPL (budget) | HL7 v2 ORU^R01 unsolicited from CMS (numerics 1–2 s), ADT optional; waveforms stay on CMS | one HL7 listener per hall → MQTT topic `icu/{hall}/{slot}/{param}` → TimescaleDB; heartbeat; mTLS |
| Ventilators | Hamilton C-series, Dräger Evita/Savina, Mindray SV, Skanray, Nihon Kohden NKV | Vendor serial/RS-232 or via CMS integration (Philips/Mindray vent modules), some HL7 via gateway (e.g. Capsule/Masimo-type middleware) | mandate export at purchase; settings + measured values as `device_settings` |
| Infusion/syringe pumps | B. Braun Space + SpaceCom server, Fresenius Agilia Link, Baxter, Medima, Akas (Indian) | vendor pump server → HL7/proprietary API | day-one: eMAR titration entries; integrate when pump server bought |
| ABG POCT | Radiometer ABL90, Siemens RAPIDPoint 500, Werfen GEM 5000, Abbott i-STAT | ASTM/HL7/POCT1-A | lab edge pattern with QC lockout (Plan 17) |
| Defibrillator | Philips/Zoll/BPL | self-test log (manual) | crash-cart check task |
| UPS / generator ATS | APC/Vertiv | SNMP | `ups.on_battery` via utility telemetry |
| Oxygen manifold/LMO | Local sensors | Modbus/4–20 mA → gateway | `utility.threshold_breached` (§11.10) |
| Tele-ICU | Cloudphysician, Medanta e-ICU-type, or own remote intensivist | RBAC web view + camera (separate, DPIA) | additive only |
| Portable X-ray | mobile modality | DICOM (Plan 18) | — |

Dependencies: Plan 13 registry (halls/beds/devices) · IPD/ward plan (admissions, deposits, rent, transfers, discharge cascade) · nursing/eMAR plan · Plan 16 pharmacy (crash cart, NDPS) · Plan 17 LIMS (ABG, cultures) · Plan 18 radiology · Plan 14 procurement (consignment devices, monitor purchase specs) · Plan 19 housekeeping (terminal cleaning verified tasks) · Plan 10 notifications (PBX/push interrupt channel) · Plan 12a agent runtime (drafters) · biomedical/equipment doc (AMC) · doc 10 (escalation ladder) · blood bank module (MTP) · MRD/mortuary (death, body release).
Events consumed: `admission.requested`, `patient.admitted/transferred/discharged/deceased`, `vitals.danger_flagged`, `result.critical_flagged`, `result.verified`, `medication.administered`, `titration.adjusted`, `unit.issued`, `surgery.completed`, `ot.booked`, `interface.down/restored`, `utility.threshold_breached`, `clock.drift_flagged`, `roster.synced`, `handover.completed`, `downtime.declared/ended`, `disaster.declared`, `legal_hold.applied`, `pass.scanned`.

## 12. Buy vs build, hardware & rough INR budget

| Item | Buy/Build | Rough INR |
|---|---|---|
| Per-hall CMS with HL7 export (×3 + NICU) | Buy with monitors; data export in tender spec (locked) | priced with monitors (~₹8–15L per hall CMS incl. licences; monitors ₹2.5–6L/bed) |
| Ventilators with export (≈ 30 + 4 backup + 2 transport) | Buy; export mandate | ₹8–20L each; not in software budget |
| MQTT gateway + TimescaleDB box (1 TB NVMe, 64 GB, UPS) + spare | Build on commodity | ₹1.5–2.5L (§13) |
| Station terminals ×2/hall + 55" hall display ×3 | Buy | ₹3–4L |
| Bedside tablets (1 per 2 beds + spares ≈ 30) + rugged cases + wall mounts | Buy | ₹6–9L |
| Bed/device QR tags, wristband printer per hall | Buy | ₹1–1.5L |
| Physical Code Blue buttons wired to PBX/app | Buy/integrate | ₹1–2L |
| Pump server integration (later) | Buy | ₹5–10L when pumps standardised |
| Tele-ICU service | Buy (per-bed/month) or own remote intensivist | ₹15–40k/bed/month vendor; decide later |
| Software: ICU module (4 plans) | Build | agent-token budget per plan; stop-loss per v3 |
| APACHE/SOFA calculators | Build (published formulas, no licence) | — |
| Clinical content (drug/interaction, antibiograms) | Licensed (§9) | existing line |

## 13. Owner rulings needed

- **O-1 Bumping policy.** Who may step down whom to admit whom. *Recommend:* intensivist decides on clinical priority class alone; payer invisible on the decision screen; every bump evented and in the weekly digest. Why: legal exposure and fairness; corporate standard.
- **O-2 ICU billing while step-down-ready and bed-blocked.** *Recommend:* charge ICU class until physical transfer, but tag "bed-blocked" hours; for TPA patients, the tag supports the claim; consider a "step-down class" tariff after 24 h bed-block. Money.
- **O-3 Device-day and consultant-visit charge rules.** (C-4, M-7, M-8, M-13) *Recommend:* calendar-day device charge with 1-h midnight tolerance; pump charge per patient-day up to 4 pumps then per-pump; no new ICU day charged before 06:00 on day of death; intensivist daily + each cross-consult once/day. Money.
- **O-4 UPS/battery policy and generator.** *Recommend:* SNMP UPS integration + registry field for vent battery minutes; purchase ATS test log; this is a purchase/policy.
- **O-5 PMJAY package overrun cost center.** *Recommend:* a named "scheme absorption" cost center; monthly report. Money/policy.
- **O-6 Visitor policy defaults.** *Recommend:* 2 slots/day × 15 min × 1 visitor, lounge passes 2 per bed, VIP exceptions only via MS, isolation beds PPE-escorted. Policy.
- **O-7 THOTA posture.** Register as retrieval centre (and later transplant centre) or remain a certifying/referring hospital; and who bears post-certification maintenance cost pending retrieval. *Recommend:* register as retrieval centre before ICU go-live (NOTTO/SOTTO application), appoint certified transplant coordinator, and bear maintenance cost on a named cost center. Legal/money.
- **O-8 ICU minimum staffing as a roster gate.** *Recommend:* 1:1 ventilated, 1:2 others, ≥ 1 intensivist per 15 beds daytime, 1 floor intensivist night + 1 duty doctor per hall; violating rosters don't publish. Policy (cost).
- **O-9 Tele-ICU.** Vendor vs own remote intensivist; DPA and DPIA before any camera/telemetry leaves the boundary. Purchase/legal.
- **O-10 Telemetry retention.** *Recommend:* 90 d full-res, 1-min aggregates 10 y, legal holds override; published policy. Legal.
- **O-11 End-of-life policy adoption.** Adopt an institutional EOL policy per SC 2023 + ISCCM guidelines with named board panels and JMFC intimation template; counsel review. Legal.
- **O-12 Alarm policy.** Max silence durations, per-patient limit order expiry 24 h, bedside-ack rule. Policy (safety).

## 14. Plan sketch — how this becomes phase documents

Numbers provisional (series editor reconciles across docs; 20+ per brief). Sequence after IPD wards + nursing/eMAR plans, because ICU consumes admissions, deposits and eMAR.

- **Plan ICU-1 (proposed 24) — ICU core: admission, contention, devices, flowsheet, alarms, Code Blue, sepsis, restraint.** Tasks: T1 tables + migrations + registry kinds/statuses on manifest seam · T2 admission workflow definition + interrupting approval + bypass review · T3 device association (QR double-scan) + charge events + reconciler automation · T4 flowsheet hours (manual mode first, pre-fill hook) · T5 alarm tables + Governor + policies · T6 Code Blue workflow + crash-cart tasks + register · T7 sepsis clock, restraint register · T8 hall dashboard (Lane 1) + tablet flowsheet · T9 KPIs snapshot + digest block · T10 downtime kit (pre-printed sheets, backfill). Gate: IPD admissions live; Plan 13 T6 deployed; nursing worklist exists.
- **Plan ICU-2 (25) — Telemetry edge.** MQTT broker + Timescale + per-vendor HL7 adapters + slot map governance + slot-walk gate + heartbeats + pre-fill job + data-gap flags + retention executor + legal-hold reach + sizing test + manual-mode overlay. Gate: first hall's CMS purchased with export spec; NTP discipline; edge auth tokens.
- **Plan ICU-3 (26) — Infection control & quality registers.** Bundles, HAI register with device-day denominators, isolation cohort mode, M&M, drills, NABH indicator pack, ICN worklist (Lane 2). Gate: LIMS cultures (Plan 17) live.
- **Plan ICU-4 (27) — End-of-life, THOTA, family communication, agents.** EOL workflow, brain-death forms, coordinator worklist, visitor slots, briefing record, Family-Update Drafter, Handover Drafter, `icu` Lens pack, Deterioration EW (shadow first). Gate: 12a runtime + DPIA; counsel-reviewed EOL policy; THOTA registration (O-7).
- NICU/PICU: variants inside ICU-1/2 (hall type, ratios, band pairing, EBM) — no separate plan.

**Must be true before authoring:** Plan 13 shipped; IPD ward plan's admission/deposit interfaces named; monitor tender spec drafted with HL7 sample messages from the chosen vendor (ask vendor for a 1-hour capture file); ICU head interviewed; rulings O-1…O-3, O-7, O-8, O-12 taken.

**Negative-space question — what absence is a signal here?** An occupied ICU bed with *no* telemetry for > 5 min; a ventilated patient with *no* device-day charge; a day with *no* briefing; a shift with *no* alarm at all on a bed (probe off or silence abuse); a code with *no* crash-cart seal event; a death with *no* M&M trigger; a brain-death certification with *no* required-request record; a restraint with *no* order; a step-down-ready patient with *no* transfer for 24 h; a hall with *no* drill this quarter; a sepsis flag with *no* antibiotic event within 60 min; an admission with *no* approver identity. Each is a scheduled absence check (automation, T0/T1).

**Staff edge-case interview questions (ICU head, in-charge, ICN, biomed):**
1. When two patients need the last bed, who decides tonight, and how is it written down today?
2. Show me a case where the monitor showed the wrong patient. How was it caught?
3. How often are alarms silenced and by whom; what do you do about the "alarm-everything" patient?
4. What does the hourly chart look like on a bad night — how much is copied from the monitor vs measured?
5. What happens at 2 a.m. when the consultant doesn't pick up? Second number? Third?
6. When did the ventilator battery last get tested; what is the plan if the generator fails?
7. How do you know a ventilator-day was billed? Who checks?
8. Walk me through the last brain-death case: forms, who signed, how long, police involved?
9. How do families ask for withdrawal, and what do you say? Any court involvement ever?
10. What does the crash cart look like after a code — who restocks, when is the seal put back?
11. Which infections do you count, how do you count device-days today?
12. What is the visiting policy in practice vs on paper; who bends it and why?
13. When the CMS went down last, what did nurses do for charting?
14. Which pumps, vents, monitors are you buying; can the vendor show an HL7 message?
15. What do TPAs reject most in ICU claims?
16. How do you handle a Bhojpuri- or Bengali-only family for consent?

## 15. Open questions & risks

1. Vendor CMS HL7 fidelity varies; some export only 1-min numerics or require a paid gateway — cost and pre-fill quality depend on the tender outcome.
2. Ventilator integration often needs middleware (Capsule-class) that costs more than the gateway budget; day-one may be monitor-only telemetry with vent settings hand-entered.
3. SC 2023 withdrawal procedure implementation varies by state; JMFC intimation format not standardised — counsel needed.
4. THOTA retrieval-centre registration timeline and state SOTTO responsiveness unknown.
5. Doc 10 ladder and this doc's alarm rungs must reconcile (one ladder engine, two definitions) — series editor.
6. Bed class/tariff lives in IPD (RULED) — ICU pricing rules (O-3) need the IPD plan's tariff surface first.
7. Deterioration EW: risk of clinician over-reliance or fatigue; keep at T0/T1, shadow ≥ 90 d, publish FPR; consider starting with deterministic NEWS2/SOFA-delta and never promoting the model if the rule performs equally.
8. Tablet-per-bed hardware and Wi-Fi density in halls (LAN fit-out project) can delay ICU-1 UX regardless of software.
9. Whether NICU EBM/band-pairing lives here or in maternity doc — recommend maternity owns EBM, ICU owns NICU telemetry/admission.
10. Timescale on the same host as core (stage 1 single VM) violates the separate-instance law; acceptable only until first hall commissions on-prem.
