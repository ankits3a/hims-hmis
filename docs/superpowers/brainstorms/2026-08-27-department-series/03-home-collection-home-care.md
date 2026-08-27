# 03 — Home Sample Collection & Home-Care Services — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED
**Series:** Department Brainstorm & Planning (2026-08-27) · **Authoring brief:** `_AUTHORING-BRIEF.md`
**Scope word:** "field" = anything the hospital does at a patient's doorstep or at a partner/camp site: phlebotomy, home nursing visits, home physiotherapy, partner-performed home ECG/portable X-ray, medicine delivery, corporate/society camps, franchise collection centres.

**Executive summary.** This module (`homecare`, proposed Plan 20) is the hospital's *field arm*: it takes an order or a request that would normally be fulfilled inside the building and fulfils it at a doorstep, then returns the evidence — a sample, a dispensed medicine, a completed nursing task — into the same LIMS/pharmacy/billing spines every other order uses. It is NOT a lab (Plan 17 owns accessioning, analysis, verification), NOT a pharmacy (Plan 16 owns stock and dispense legality), NOT a CRM (campaigns/teleconsult stay in the CRM item, spec §11.5 "noted for later"), and NOT a logistics company — third-party riders are a bought commodity behind one adapter. What it owns is **the visit**: who goes where, when, proves they were there, proves who they served, proves what they carried and how cold, and proves the money. Its three hardest problems: (1) **identity and custody at a doorstep with no desk, no wristband and no witness** — the wrong-person / relative-gives-sample / sample-swap family; (2) **cold chain and transit time** — a 42 °C Indian afternoon with a scooter and a two-hour ride turns a valid potassium into a rejected one, and the rejection lands after the patient has already paid and the phlebotomist has already left; (3) **cash and attribution in the field** — doorstep UPI/cash, 269ST aggregation across a family, referral commissions accruing on payments a rider collected, and the fraud triangle of ghost visits, cash skim and swapped tubes. Everything else is scheduling, and scheduling is a solved problem we buy the maps for.

---

## 1. Frame — what exists, what is locked, what this document adds

**Inherited, locked (cited, not re-litigated):**
- §4 module framework; a module owns its tables + manifest; cross-module only via declared interfaces/events. `homecare` owns visits, routes, custody, field sessions, camps, partner sites. It does **not** own orders (`order.placed` is the lab/imaging/pharmacy family's), samples' analytical lifecycle (Plan 17), dispense legality (Plan 16), or patients.
- §11.6 lab pipeline: one pipeline for all order sources; **barcode tube labels + right-patient scan before draw**; accessioning scan starts the TAT clock; **sample rejection → free re-collection** (§11.5); send-outs first-class (dispatch manifest, chain tracking); walk-in outside-prescription orders feed referral attribution automatically.
- §11.8 medications: Schedule H/H1/X rules; H1 register writes itself from dispense events; NDPS never leaves the double-lock; **returns never for cold-chain or narcotics**.
- §7 billing: tenders, **cashier sessions with float/close/variance**, refunds as credit notes, silent accrual ledger (commission accrues on `payment.received`, reverses on refund); §11.19-C-1 referral payee classes (external RMPs: attribution captured, payout structurally OFF pending counsel); §11.19-C-2 **Section 269ST per-payer-per-episode cash aggregation**; §11.19-C-17 attribution verification gate.
- §10 fabric: P2 order-to-result, P3 request-to-issue, P5 task-and-track, P6 charge-to-cash, P7 notify-remind-escalate; every SLA lifecycle is a workflow definition; alerts selective.
- §11.4 map 1 downtime protocol; `occurred_at ≠ recorded_at` backfill.
- §11.13 communication matrix; DPDP promotional/transactional split; quiet hours 21:00–08:00; fallback ladder WhatsApp → SMS → IVR → manual desk.
- §11.14 needle-stick → PEP protocol task with first-dose clock; Code Violet one-touch; DPDP data-principal rights; legal hold.
- §11.19-D-31 guardianship model (authority scope; sensitive-context override); §11.19-E-3 chaperone framework (ECG on female patients is a chaperone-required class — this reaches the home).
- §14 sealed/VIP/staff-as-patient classes; agents as first-class actors; §16 tiers, clinical cap T2–T3, fail-open, kill switches, provenance.
- S10: phlebotomist card 36 (collection-attributable rejection <1%, draws/session load-shown, ward-round on-time); cashier card 3; SoD hard pairs §11 (cashier vs refund approver; requester vs approver); mechanism 17 (women's night-shift provisions), 25 (chaperone roster gate), 27 (anomaly-report reviewer roles).
- Plan 13 registry: resources are registry kinds with status history; this module adds kinds (§4).
- Roadmap: 17 LIMS is "manual result entry first, analyzer interfaces phased"; Track B is the Lane-2/Lane-3 pilot cohort; deferred note 3 (Journey Feed + three lanes), note 5 (KPI formula registry).
- Copilot design laws: narrate-never-originate; Class-1 tokenisation; identified PHI never enters inference (roadmap design law, 12a).

**Neighbouring modules — who owns which table:**
| Concern | Owner | `homecare` relationship |
|---|---|---|
| `patients`, guardians, language, sealed flag | Plan 03 patients | read via `patients.get`; never copies demographics into the field app beyond a visit-scoped card |
| `orders`, `samples`, accession, rejection reasons | Plan 17 LIMS | consumes `order.placed`; emits `sample.collected` with `collection_site: home`; LIMS emits `sample.received/.rejected` |
| `prescriptions`, dispense, batch/MRP, schedule flags | Plan 16 pharmacy | delivery starts only after `dispense.completed` (Plan 16 event) |
| invoices, tenders, cashier sessions, refunds | Plan 06/07 billing | field staff run a **field cashier session** — the same table, `session_kind: field` |
| referrer master, accrual ledger | Plan 09/09a | attribution captured on the visit; accrual rides `payment.received` unchanged |
| notifications/templates | Plan 10 | all patient messages go through the gateway |
| tasks/pooled queues | Plan 19 task fabric | nursing/physio visits are P5 tasks with a home location |
| registry resources (vehicles, boxes, centres) | Plan 13 | new kinds registered here |
| camps as CRM campaigns | later CRM | camps' *field execution* is here; campaign targeting is CRM |

**What this document adds:** the visit lifecycle as workflow definitions; custody as an evented chain; the field app's offline contract; the doorstep money and identity rules; partner/franchise and camp variants; delivery under Schedule H; ~100 edge cases; KPIs; agents; plan split.

---

## 2. Actors, roles & role cards

| # | Role (S10 card or NEW) | Reports to | Stations | Shift | Notes |
|---|---|---|---|---|---|
| 36 | **Phlebotomist (field)** — S10 card 36, field variant | Lab manager | route worklist, doorstep collection, cold box | 06:00–14:00 core (fasting window), evening band 16:00–20:00 | female phlebotomists get paired/escort rules at night (S10 mech. 17) |
| NEW-H1 | **Field Dispatcher / Home-care Coordinator** | Front-office supervisor → Ops manager | booking desk, slot board, route planner, exception queue | 06:00–21:00 two shifts | the human behind the routing automation; owns not-at-home and rebooks |
| NEW-H2 | **Rider / Delivery Associate** (in-house or vendor) | Pharmacy in-charge (deliveries) / Lab manager (sample runs) | pickup → hand-over → return | vendor-defined | **may never collect samples**; may carry sealed boxes between centre and lab |
| NEW-H3 | **Home-care Nurse** (GNM/ANM) | Nursing superintendent | visit tasks: injections, dressings, catheter/RT care, vitals, vaccinations | day visits; night only for enrolled packages | task-and-track P5; eMAR-at-home subset |
| NEW-H4 | **Home Physiotherapist** | Rehab head | session tasks | day | session packages ride the entitlement counter (map 11) |
| NEW-H5 | **Partner Technician** (ECG/portable X-ray/USG vendor) | Radiology head (clinical), Dispatcher (ops) | performed at home, upload to hospital | vendor | AERB-registered portable X-ray; chaperone rule for ECG on women |
| NEW-H6 | **Collection Centre Operator** (franchise/partner lab) | Lab manager | sample intake at centre, manifest to lab | centre hours | franchise = partner, not staff; NABL sample-transport SOPs bind |
| 3 | **Cashier (field session reconciler)** | Billing supervisor | evening float-in, denomination count, UPI recon | 18:00–21:00 | SoD: the reconciler is never the field collector of that session |
| 17 | Lab Technician (accessioning) | Pathologist | receiving bench: custody close, temperature read, rejection | 24×7 | rejection reason coded `collection|transit|accession` — separates whose fault |
| 8/9 | OPD Consultant / RMO | — | orders home visits; verifies deliveries' prescriptions (pharmacist actually verifies) | — | clinical decisions only |
| 37 | Quality Manager / DPO | Owner | field incident register, DPIA, NABL transport SOP audits | — | anomaly-reviewer for safety classes |
| 4 | Billing Supervisor | — | reviewer for money anomaly classes (S10 mech. 27) | — | |
| 34 | Security Supervisor | — | staff-safety escalation (Code Violet-at-home), vehicle custody | 24×7 | |

**Automation/agent actors** (all first-class per §14/§16, detail in §9): Route Planner (automation), Slot Offerer (automation), Custody Watchman (automation), Field Session Reconciler (automation, under Leakage Auditor), Field Fraud Sentinel patterns (automation, under Fraud Sentinel), Recall & Follow-up (existing T1, gains re-collection + not-at-home retries), Doorstep Rx Verifier Assist (agent, T2, pharmacist signs), Visit Note Drafter (agent, T2, nurse signs), Digest Writer contributions (existing).

**Bundling & SoD (hard pairs, RBAC-enforced, extending S10 §11):**
- Field collector of a session **/** reconciler of that session.
- Rider **/** sample collector (a rider identity has no `sample.collect` permission — structural, not policy).
- Prescription verifier (pharmacist) **/** delivery hand-over actor.
- Camp registrar **/** camp cash reconciler.
- Partner-centre operator **/** hospital accessioning technician.
- Dispatcher **/** approver of a not-at-home visit-charge waiver above cap.
- Night bundling allowed: dispatcher ← front-office supervisor (evening); field cashier reconciliation ← billing supervisor.

---

## 3. Core flows as workflow definitions

All are workflow definitions (versioned data, owner-activated per §10.4). SLA minutes below are **recommended defaults**, configurable. Escalation ladders resolve to on-duty role holders (§11.12).

### 3.1 `home_visit` (P5 task-and-track, with a P2 overlay when it carries orders)

```
requested ──(slot offered/accepted)──▶ scheduled ──(assigned)──▶ assigned ──(accepted by staff)──▶ accepted
   │                                        │                            │
   │ (unfulfillable)                        │ (reschedule)               │ (declined/expired) → assigned (re-assign)
   ▼                                        ▼                            ▼
cancelled                              rescheduled ──▶ scheduled     en_route ──(geo arrive)──▶ arrived
                                                                                             │
                              ┌──────────────────────────────────────────────────────────────┤
                              ▼                          ▼                        ▼          ▼
                        not_at_home               unsafe_aborted           identity_failed   serving
                              │                          │                        │          │
                        (retry ≤2 / rebook)        (incident + rebook)     (rebook/cancel)   ▼
                                                                                    completed ──▶ closed (money + custody + notes all settled)
                                                                                         │
                                                                                    partially_completed (some orders done) ──▶ closed
```

| State | Allowed roles (transition out) | SLA (default) | Escalation ladder |
|---|---|---|---|
| requested | Dispatcher, booking automation, patient self-service (WhatsApp/app), OPD consult (order-driven) | slot offered ≤ 15 min (working hours), ≤ 60 min otherwise | rung 0 dispatcher → rung 1 front-office supervisor (30 min) → rung 2 ops manager |
| scheduled | Dispatcher / Route Planner | assigned ≥ 12 h before slot, or ≤ 20 min for same-day | dispatcher → supervisor |
| assigned | field staff (accept/decline), dispatcher (re-assign) | accepted ≤ 10 min | auto re-assign after 10 min; supervisor at 2nd expiry |
| accepted → en_route | field staff | en_route by (slot start − travel estimate) | nudge at −5 min; dispatcher at slot start |
| en_route → arrived | field staff (geo-confirmed, or manual with reason) | arrival within slot window (default 60-min slot; on-time = ≤ 15 min late) | patient WhatsApp "running late" auto at +10; dispatcher call at +20 |
| arrived → serving | identity + consent gates (§3.2) | ≤ 10 min | none (record only) |
| serving → completed | field staff; **all child orders resolved** (collected / not_collected_reason) | phlebotomy: ≤ 20 min per patient; nursing: task-defined | record only |
| completed → closed | system: money settled (paid / credit-approved / waiver), custody handed (samples) or none, notes signed | ≤ 4 h after completion; hard stop at field session close | Custody Watchman → lab manager; money → billing supervisor |
| not_at_home | field staff (after call attempt evented) | retry decision ≤ 5 min | dispatcher calls patient; 2 documented attempts then rebook/cancel with visit-charge rule (§5 M-row) |
| unsafe_aborted | field staff, one-touch | immediate | security supervisor + dispatcher, real-time; incident auto-opened |

**Events emitted (NEW unless noted):** `visit.requested` · `visit.slot_offered` · `visit.scheduled` · `visit.rescheduled` · `visit.assigned` · `visit.accepted` · `visit.declined` · `visit.en_route` · `visit.arrived` (payload: geo, accuracy_m, method `gps|manual`) · `visit.identity_verified` (method) · `visit.not_at_home` · `visit.aborted` (reason class) · `visit.completed` · `visit.closed` · `visit.cancelled` · `visit.charge_waived`. Reused: `task.created/.assigned/.accepted/.completed/.verified/.escalated` (a visit **is** a task instance with location), `sla.breached`, `escalation.triggered`, `notification.sent`, `consent.recorded`, `incident.reported`, `appointment.no_show` (**not** used — not-at-home is its own state because money differs).

**Variants (corporate-hospital standard, configurable):** (a) order-driven — consult orders "home collection" → visit auto-requested with orders attached; (b) walk-in/WhatsApp — patient lists tests, dispatcher creates a walk-in order with outside-prescription photo (§11.6 outside-prescription path; attribution captured); (c) package/recurring — home nursing daily dressing ×7, physio ×10: one `home_care_episode` parent, N child visits generated from a calendar; (d) partner-performed — visit assigned to a partner technician identity, results ingested as send-out (§11.6).

### 3.2 `sample_custody` (P2 overlay per sample, from draw to accession)

```
labelled_at_bedside ──▶ collected ──▶ in_cold_box ──▶ in_transit ──▶ handed_to_centre? ──▶ in_transit ──▶ received_at_lab ──▶ accessioned
                                                                     (partner leg)                                    │
                                                                                                                 rejected ──▶ recollection_task
```
- `sample.collected` (existing; payload adds `collection_site: home|camp|centre`, `collector_id`, `geo`, `tube_barcode`, `requisition_photo_id`) → `sample.custody_transferred` (NEW: from_actor, to_actor, container_id, both scans, temp at hand-over) → `sample.temperature_logged` (NEW; from logger or manual) → `sample.transit_breached` (NEW; analyte rule violated: time or temperature) → `sample.received` (existing, at accession; **starts the lab TAT clock, not the visit**) → `sample.rejected` (existing; reason class `collection|transit|accession|clinical`).
- Analyte transit rules are **definition data** (`analyte_transit_rules`): e.g. potassium/ammonia/lactate ≤ 1 h or on ice; glucose without fluoride ≤ 30 min; coagulation ≤ 4 h at 18–24 °C never on ice; ESR ≤ 4 h; blood culture room temp never refrigerated; urine culture ≤ 2 h or 4 °C ≤ 24 h. **Order-time guard:** a home order containing an analyte whose rule cannot be met from that address at that slot is flagged at booking (T0 rule), and the dispatcher must pick a nearer slot/centre or the order is split (K-rows in §5).
- SLA: collected → received within the tightest analyte rule in the box; breach = `sample.transit_breached` + pre-emptive re-collection offer *before* the lab rejects.

### 3.3 `medicine_delivery` (P3 request-to-issue, last mile)

```
requested ──(rx verified by pharmacist: `rx.verified_for_delivery` NEW)──▶ dispensed (Plan 16 `dispense.completed`) ──▶ packed (sealed, tamper label, cold-chain flag) ──▶ dispatched (rider assigned; `delivery.dispatched` NEW) ──▶ handed_over (`delivery.handed_over` NEW: OTP or ID, photo of recipient hand + label, geo) ──▶ closed
                                                                                                                     │
                                                                                                        undeliverable → returned (`delivery.returned` NEW) → pharmacy return path (never cold-chain/NDPS restock without pharmacist)
```
- Schedule H/H1: **no verified prescription, no dispatch** — the verification is a pharmacist action on an uploaded/known prescription (`rx.verified_for_delivery`, with prescription hash); H1 register entry written at dispense (§11.8) and carries `delivery_id`; **Schedule X / NDPS never delivered** (structural: item schedule flag blocks the delivery request). Telemedicine Practice Guidelines 2020 list of what a teleconsult may prescribe applies when the Rx originated from teleconsult.
- Third-party riders (Dunzo/Porter/Shadowfax-style) integrate behind one `DeliveryProvider` adapter; the rider is a **vendor actor identity** with hand-over permission only; the OTP is generated by us, sent to the patient by our gateway, and validated by our API — never trusted from the vendor's callback alone.

### 3.4 `home_care_episode` (P5 recurring: nursing/physio/elderly monitoring)

`enrolled → active (visits generated) → paused (hospitalised/travel) → completed | discontinued`. Each visit is a `home_visit` whose tasks come from the care plan (dressing, injection, RT feed teaching, catheter change, physio protocol). Nursing tasks at home reuse the eMAR grammar: `medication.administered/.missed/.refused` (existing) with `setting: home`; vitals → `vitals.recorded` (existing) → `vitals.danger_flagged` → **home escalation ladder**: RMO call → advise ER → ambulance task (ambulance module deferred; a phone task until then). **Scope limit (recommended default, ruling O-6):** no ventilated/home-ICU patients under this module in Phase 1; the module may *visit* such patients for nursing tasks only under a consultant-signed care plan that names escalation and a 24×7 responsible doctor.

### 3.5 `camp` (P1 bulk-intake, field execution)

`planned → approved (owner/ops; consent form + pricing pack attached) → live (bulk registration + collection) → closed (samples manifested, cash reconciled) → reported (results distributed, follow-up leads to Recall)`. Camp registrations are real `patient.registered` events with `source: camp:<id>` and referral attribution to the corporate/society (§6 "every visit carries referral-source"); results publish per patient in their language; **bulk export to the corporate only as de-identified aggregates unless each employee consented to employer disclosure (DPDP)** — see C-rows.

### 3.6 Field cashier session (P6, reuse)

`cashier_session.opened` with `session_kind: field`, `float_amount` (usually 0), `custodian: field staff id`; tenders at doorstep post `payment.received` (tender `cash|upi_dynamic_qr|upi_static|card_mpos|pay_later`); **close by hand-over to the reconciling cashier with denomination count** → `cashier_session.closed` + `cash_variance.recorded` if any. Same tables, same variance register, same Fraud Sentinel input. Field session must close **same day**; an open field session at 23:00 is an active alert to the billing supervisor.

---

## 4. Data model sketch

Module `apps/core/src/modules/homecare/` (own schema, manifest, permissions: `homecare.book`, `homecare.dispatch`, `homecare.visit.execute`, `homecare.custody.transfer`, `homecare.delivery.handover`, `homecare.camp.manage`, `homecare.partner.manage`, `homecare.reconcile`).

| Table | Key columns (sketch) |
|---|---|
| `home_visits` | id (ULID), episode_id?, patient_id, encounter_id (a `home` encounter type — enum extension on the encounter spine), requested_via `whatsapp|call|app|opd_order|camp|partner`, service_kind `phlebotomy|nursing|physio|partner_ecg|partner_xray|delivery`, address_id, geo_point, geo_source, slot_start/end, zone_id, assigned_staff_id, vehicle_id?, workflow_instance_id, referral_source_id, payer_tag, visit_charge_line_id?, distance_band, chaperone_required, female_staff_required, risk_flags jsonb (dog, no-lift, unsafe-area, prior-incident), created_by, site_id |
| `visit_addresses` | patient_id, label, lines, pincode, landmark, geo_point, geocode_confidence, last_verified_at, access_notes (gate code, floor, "ring twice"), serviceable (bool), zone_id |
| `service_zones` | id, name, polygon (PostGIS or bbox v1), distance_band, base_charge, surcharge rules, active hours, female_staff_policy `any|pair|day_only` |
| `visit_orders` | visit_id, order_id (lab/imaging/pharmacy), status `pending|done|not_done`, not_done_reason, requisition_photo_id |
| `visit_events_geo` | visit_id, actor_id, kind `arrive|depart|photo|scan`, geo, accuracy_m, device_time, server_time, device_id, offline_seq |
| `field_devices` | device_id, staff_id, model, app_version, last_sync_at, offline_queue_depth, remote_wipe_flag |
| `sample_custody` | sample_id, seq, from_actor, to_actor, container_id (registry resource), scanned_at, geo, temp_c?, method `scan|manual`, source_event_id UNIQUE |
| `containers` | registry kind `cold_box`: id, logger_device_id?, calibration_due, current_custodian |
| `transit_temperature_log` | container_id, ts, temp_c, source `logger|manual|probe` |
| `analyte_transit_rules` | test_code, max_minutes_ambient, max_minutes_chilled, temp_min/max, no_ice flag, light_protect flag, version, active |
| `deliveries` | id, prescription_id, dispense_id, patient_id, address_id, provider `inhouse|vendor:<code>`, vendor_ref, rx_verification_id, cold_chain, otp_hash, otp_expires, handed_to_name, handed_to_relation, handover_photo_id, geo, status via workflow instance |
| `rx_verifications` | id, prescription_ref (internal id or uploaded image id + hash), verified_by (pharmacist), schedule_class, valid_until, outcome `ok|refused|clarify`, refusal_reason |
| `home_care_episodes` | patient_id, care_plan jsonb (FHIR CarePlan-shaped), consultant_id, start/end, frequency, package_instance_id?, escalation_doctor_id, status |
| `home_care_tasks` | episode_id, visit_id, task_code, FHIR Task-shaped detail, done_by, done_at, verified_by?, charge_line_id |
| `camps` | id, sponsor (corporate/society referrer id), venue geo, dates, approved_by, price_pack_id, consent_form_version, employer_disclosure_default, cash_session_id |
| `camp_registrations` | camp_id, patient_id, employee_ref?, employer_disclosure_consent bool, collected_at |
| `partner_sites` | registry kind `collection_centre`: id, partner id (vendor master, Plan 14), NABL scope?, agreement, manifest cadence, pricing share, active |
| `partner_manifests` | partner_site_id, manifest_no, samples[], dispatched_at, received_at, discrepancies |
| `field_incidents` | visit_id, class `unsafe_premises|violence|dog_bite|needle_stick|road_accident|harassment|other`, reported_at, actor, linked incident_id (quality module), PEP task id? |
| `staff_safety_checkins` | staff_id, ts, geo, kind `start|end|sos|late_checkin_missed` |
| `visit_feedback` | visit_id, score, text, language, channel |
| **Statutory registers (first-class tables)** | `schedule_h1_dispense_register` (Plan 16 owns; this module writes `delivery_id`), `needle_stick_register` = `exposure.reported` projection (quality), `sample_rejection_register` (Plan 17 owns; `collection_site` column), `camp_register` (Clinical Establishments Act state rules often require camp intimation — keep the intimation record), `dpdp_consent_register` entries for employer disclosure |

**Registry kinds needed (Plan 13):** `vehicle` (two-wheeler/van, registration no, insurance/PUC expiry → Expiry Watchman), `cold_box` (with logger), `collection_centre`, `camp_site` (transient, status history is the camp's live/closed), `field_device` (Android handset as an asset). Status history gives "which box was this sample in, who held it" for free.

**FHIR shapes:** `Encounter.class = HH` (home health) for visits; `Specimen` with `collection.collector`, `collection.collectedDateTime`, `container`, `condition` (transit breach as `Specimen.condition`); `Task` for nursing tasks; `CarePlan` for episodes; `MedicationDispense` (Plan 16) with `destination` = home address; `Location` for zones/centres.

**Retention:** visit/custody/geo events follow the encounter's class (OPD ~5 y); geo traces beyond 90 days pseudonymised to zone-level (DPDP minimisation); staff safety check-ins 1 y; photos of requisitions kept with the order (5 y); recipient hand-over photos 1 y then purged unless dispute/legal hold; camp registers as per state CEA rules (recommend 5 y).

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref**. "Cfg" = configurable default proposed. Rows are tests the phase doc must own.

### 5A. Identity & wrong-patient (doorstep has no desk)

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| I-1 | Phlebotomist arrives; the person presenting is the patient's brother "giving blood on his behalf" for a lipid profile | Identity gate: name + DOB/age + phone-OTP to the registered number *or* photo-ID scan; mismatch = `identity_failed`, no draw; dispatcher offered rebook. Never "collect anyway" | Fixture: relative answers OTP on patient's phone but face/age mismatch flagged by staff → draw blocked; event `visit.identity_verified` absent; no `sample.collected` | — |
| I-2 | Two family members, both booked, tubes labelled in the kitchen for both before drawing | Label print/scan is **per patient at the moment of draw**: app forces "scan patient card/OTP → print labels → scan tube → draw" sequence; labels for patient B cannot be printed while patient A's draw is open | Assertion: `sample.collected` for B before A's `collected` on same visit with interleaved label prints → rejected by API (state machine) | — |
| I-3 | Patient has no phone (elderly, phone with son at office) | OTP to guardian-scoped number allowed only if guardian authority includes `consents`; else photo-ID + face photo captured (visit-scoped, purged 30 d) as identity evidence | Test: guardian without scope → OTP route disabled in app; ID-photo route mandatory | — |
| I-4 | Same name, same colony, two UHIDs (Ram Kumar ×2) | Dispatcher booking screen shows phone-first search with age/address disambiguation; booking without selecting a UHID impossible; field card shows age + photo if any | Perf: search < 300 ms; UI test: duplicate-name picker | — |
| I-5 | Camp: 400 employees, names from an Excel, 30 have same phone (HR desk number) | Camp registration allows shared phone but forces employee-ID + DOB; duplicates flagged for merge review, never auto-merged (Plan 05 machinery) | Assertion: no `patient.merged` emitted by camp import | — |
| I-6 | Patient is a sealed/VIP record; field app must not show alias-breaking data to a vendor rider | Rider sees address + OTP only; name rendered as alias; vendor API payload contains no name/UHID | Contract test: vendor adapter payload schema has no identity fields | — |
| I-7 | Wrong address geocoded (pincode maps 3 km off); staff arrives at a stranger's house who "agrees" to give blood for money | Identity gate (I-1) is the guard; additionally arrival geo > 300 m from address geo raises a soft flag on the visit for reviewer | Fixture: arrival 2 km from geocode → `visit.arrived` payload `distance_from_address_m` and anomaly row | — |
| I-8 | Newborn heel-prick at home (TSH/day-3 screen) | Mother's identity + baby UHID (map 2); label carries baby UHID; consent by parent | Test: label print refuses mother's UHID on baby's order | — |
| I-9 | Patient merged (Plan 05) between booking and visit | Field sync resolves to survivor UHID; labels print survivor; old UHID scan still accepted with warning | Assertion: `patient.merged` consumer updates open visits | — |
| I-10 | Staff-as-patient books home collection to hide a diagnosis | Confidential class applies: dispatcher sees alias; assignment excludes the staff member's own department colleagues where roster data allows | Test: sealed flag → assignment filter | — |

### 5B. Timing, concurrency, race

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| T-1 | Two dispatchers assign the same 07:00 slot to two phlebotomists | Slot capacity per zone is a row-locked counter (Plan 06-2 lock discipline); second assignment fails with a conflict, not silent overbook | Mutant: remove lock → concurrent test overbooks | — |
| T-2 | Patient reschedules on WhatsApp while staff is en_route | Reschedule from `en_route` allowed only via dispatcher; patient's message creates a task; staff gets instant push; visit charge rule for late reschedule applies (M-4) | State test: `patient` actor cannot transition `en_route→rescheduled` | — |
| T-3 | Fasting sample: patient ate at 06:30; slot 07:15 | App asks fasting status (structured); non-fasting → order-level flag, tests requiring fasting marked `not_done: non_fasting`, others collected; rebook for the fasting subset without a second visit charge (Cfg) | Assertion: partial completion emits per-order status; no charge for the not-done lab lines | — |
| T-4 | Staff's phone clock is wrong (manual time set back 2 h) | App uses server-synced monotonic offset; `device_time` and `server_time` both stored; if drift > 5 min, arrival/collection timestamps flagged `clock_untrusted`; analyte clocks use server time of the *sync* as upper bound | Test: inject drift → flag set; transit rule uses conservative bound | — |
| T-5 | Same patient, two orders from two doctors, one visit | One visit, N orders, one visit charge; attribution per order preserved | Assertion: exactly one `visit_charge` line; two `order.placed` with distinct referrers | — |
| T-6 | Route planner recomputes while staff already left | Re-optimisation never reorders stops already `en_route`; only unstarted stops move; staff sees a diff prompt | Test: en_route stop position invariant | — |
| T-7 | Slot at 06:00 but lab accessioning opens 07:30 | Cold box hold rules apply; custody stays with staff; sample `in_cold_box` time counts against analyte rule; if rule would breach, booking guard prevents the 06:00 slot for those analytes | Booking-guard test over rule table | — |
| T-8 | Not-at-home retry #2 arrives same day; first visit's labels already printed | Old labels invalidated (`label.voided` NEW? — reuse `sample.rejected`? No: labels are not samples; propose `label.voided` NEW); app forbids scanning a voided barcode | Test: voided barcode scan → hard error | — |
| T-9 | Visit closes after field session closed (staff forgot to close visit) | Closing a visit with a cash tender after session close is refused; the tender must be recorded in the *open* session; supervisor path: reopen with reason (evented) | Assertion: `payment.received` in closed session → 409 | — |
| T-10 | Dispatcher double-clicks "confirm" — two visits created from one WhatsApp request | Idempotency key = (patient, slot, requested_via, source message id) | Test: duplicate POST returns same visit id | — |

### 5C. Partial failure, offline & downtime

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| D-1 | No network at patient's home (basement, village) | Field app is **offline-first**: today's route, patient cards, label numbers pre-allocated (a per-device reserved barcode range), consent forms, price list cached; all actions queue with `offline_seq` and `occurred_at`; sync on reconnect; server accepts out-of-order with causation | Test: full visit offline → sync → identical event set, `recorded_at > occurred_at` | — |
| D-2 | Label printer (Bluetooth) dead at bedside | Pre-printed **reserved-range** blank barcode labels in the kit; app binds a blank barcode to the sample by scan; hand-written name never sole identifier | Assertion: bind blank barcode → `sample.collected.tube_barcode` from reserved range | — |
| D-3 | Phone dies mid-route | Paper route sheet printed at start (QR per stop); collected samples recorded on paper custody form (serial-numbered, downtime kit); backfill at lab via QR scan; `occurred_at` from form | Backfill screen test | — |
| D-4 | Core server down (map 1) during the morning wave | Field app keeps working (offline mode is the same code path); the dispatcher's board is unavailable → PBX voice routing; on recovery, sync order = custody first (lab needs it), money second | Chaos test: server 503 for 2 h → zero lost events | — |
| D-5 | Sync conflict: dispatcher cancelled the visit while staff completed it offline | Server records both; visit resolves to `completed` (physical truth wins), cancellation becomes a `visit.cancel_conflicted` (NEW) review task; money stays | Conflict test | — |
| D-6 | Vendor delivery API down | Delivery falls back to in-house rider queue or "hold at pharmacy, patient informed"; never stuck silently; SLA breach after 30 min | Adapter fault injection | — |
| D-7 | UPI dynamic QR generation fails at doorstep | Static QR fallback on the staff's laminated card with UTR capture; T+1 reconciliation matches (§7) | Test: tender `upi_static` with UTR; recon job matches | — |
| D-8 | App update mid-day breaks label scanning | Staged rollout by zone; killswitch config flag for scanner module → manual barcode entry with double-entry check | Feature-flag test | — |
| D-9 | Photo upload fails; requisition photo lost | Photos stored locally until server ACK; visit cannot `close` until photo synced or dispatcher waives with reason | Assertion: close blocked on unsynced media | — |
| D-10 | Partner centre's manifest never arrives (their system down) | Paper manifest with serials accepted at accessioning; discrepancy list generated when digital manifest arrives late | Late-manifest reconciliation test | — |

### 5D. Money — billing, refunds, payers, packages, TPA, 269ST, commissions

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| M-1 | Home visit charge structure | Charge = base by distance band + optional surcharge (odd hours, urgent same-day) + tests at OPD tariff; visit charge is a tariff line (Plan 06), GST per CA (diagnostic services exempt; delivery/convenience fee taxable at 18 % — CA to confirm) | Golden fixtures per band; GST split per line | **O-1** |
| M-2 | Patient pays cash ₹18,000 for a family of four at the door | 269ST aggregation is **per payer per episode**; family paid by one father = one payer → aggregate warning at configured threshold, hard block at ₹2 L; PAN/Form-60 prompt above line; app pushes UPI | Test: four invoices one payer → aggregate computed | — |
| M-3 | Sample rejected in transit; patient already paid | Free re-collection (§11.5) — no new charge, no refund; **visit charge not charged again**; if patient refuses re-collection → credit note for the affected test lines only, refund to payer method | Assertion: re-collection visit has `visit_charge_line_id = null` and `reason: recollection` | — |
| M-4 | Not-at-home twice after confirmed slot | Cfg default: visit charge posted as "failed-visit charge" only if patient was confirmed by OTP/WhatsApp ≤ 2 h before and never answered; waiver by dispatcher up to cap; above cap approval | Waiver ladder test; `visit.charge_waived` | **O-2** |
| M-5 | Doorstep collection by rider for a delivery — rider takes cash (COD) | Rider tender posts into the **rider's** field session (vendor riders: `pay_later`/prepaid only — no vendor COD cash into our sessions) | Assertion: vendor identity has no `cash` tender permission | — |
| M-6 | Referral doctor attribution on walk-in home order; commission accrual | Attribution captured on order (§6); accrual on `payment.received` unchanged; verification gate (§11.19-C-17): requisition photo = prescription-evidenced; class-(c) RMP payout stays structurally OFF | Accrual test: payment at doorstep → `commission.accrued` only if referrer verified & class allows | inherits 09a rulings |
| M-7 | Doorstep discount ("uncle-ji bargained") | Field staff hold **zero discount permission**; discount only via dispatcher/billing supervisor role caps + reason code; app has no discount field | RBAC test | — |
| M-8 | Package holder (12 physio sessions prepaid) | Session consumes entitlement counter; home visit charge separately unless package includes home; counter restore on cancelled visit | Counter restore test (Plan 09 C1) | — |
| M-9 | TPA/corporate cashless home collection (rare; some corporates cover annual checks) | Payer tag `corporate` → credit line on invoice; no doorstep tender; camp pricing pack | Test: corporate payer → tender step skipped, invoice to credit ledger | — |
| M-10 | Staff loses ₹3,200 cash on the road | Variance at close → approval + variance register; incident; Fraud Sentinel pattern on repeats; no auto-deduction (S10 non-punitive; HR decides) | `cash_variance.recorded` + approval | — |
| M-11 | Partial collection (2 of 5 tests done — vein collapsed) | Invoice for done tests only; undone lines cancelled with reason or held pending rebook; visit charge once | Line-level cancel test | — |
| M-12 | Patient wants GST invoice in company name for reimbursement | Invoice bill-to fields editable pre-issue by dispatcher; post-issue = credit note + re-issue (§7 immutability) | Immutability test | — |
| M-13 | Camp: society pays lump sum ₹40,000 for 100 tests; individuals pay for add-ons | Camp invoice to sponsor (credit); add-ons individual invoices in the camp cashier session; two payers, two ledgers, one camp | Test: mixed payer camp closes with sponsor receivable + individual tenders | — |
| M-14 | Refund for cancelled home visit paid via UPI yesterday | Credit note + refund voucher to same UPI VPA; > threshold → bank transfer | Existing refund tests + `refund_to_payer` | — |
| M-15 | Distance band disputes (patient says 4 km, map says 7 km) | Band computed from road distance at booking and **shown before confirmation** (WhatsApp quote); band frozen on the visit | Quote-then-freeze test | — |
| M-16 | Price of a test revised between booking and visit | OPD rule: current tariff at invoice; but **quoted price honoured** if quote given ≤ 72 h earlier (Cfg) — implemented as an adjustment rule with reason `quote_honoured` | Adjustment-rule fixture | **O-3** |

### 5E. Consent, legal, MLC, minors, unconscious, chaperone

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| C-1 | Minor (14) alone at home, mother booked | Draw only with guardian present or guardian OTP consent + adult present (Cfg: adult present mandatory for < 12) | Consent gate test with age branches | — |
| C-2 | HIV test ordered for home collection | HIV Act 2017: pre-test counselling + informed consent documented; home collection allowed only if counselling recorded by an authorised counsellor (phone counselling evented); sealed class for the result | Test: HIV order without counselling record → booking blocked | — |
| C-3 | Home USG requested (partner) for a pregnant woman | **PCPNDT: no portable USG at home, ever** — the Act ties machines to registered premises; request refused with statutory reason | Structural: no `partner_usg` service kind exists | — |
| C-4 | ECG on a woman at home by a male partner technician | Chaperone rule (§11.19-E-3): female staff/adult female family member present, `chaperone.present` recorded; else reschedule | Gate test | — |
| C-5 | Injury sample suggests assault (nurse notices bruises during home dressing) | Staff raises MLC-suspect flag → RMO review → MLC register path; staff safety first; no confrontation | Flag → task test | — |
| C-6 | Unconscious elderly at home, family asks nurse to "do something" | Nurse scope: BLS + call ambulance/108 + RMO; app one-touch "emergency at home" → RMO call + ambulance task; documented | Escalation ladder test | — |
| C-7 | DPDP consent for employer disclosure at camp | Per-employee explicit opt-in checkbox on the camp form (default OFF); without it the employer gets only aggregates | Export test: opt-out employees absent from named export | **O-4** |
| C-8 | Patient asks to delete their home address after service | DSR path (§11.14); address soft-deleted; visit records survive under retention law with response documenting why | DSR fixture | — |
| C-9 | Consent language — patient signs Hindi form on tablet; staff speaks Bhojpuri | Consent forms in Hindi/English with audio playback (voice where lawful); signature + photo of signer; witness field | i18n test; audio asset present | — |
| C-10 | Schedule H1 delivery to a relative | Hand-over requires patient OTP; relative hand-over allowed with relation recorded; H1 register carries patient, not relative; Schedule X never | Register write test | — |
| C-11 | Telemedicine-origin Rx contains a drug not permitted for tele-prescription (TPG 2020 List) | Pharmacist verification refuses; reason coded; consultant notified | Verification rule test | — |
| C-12 | Elderly patient with dementia "consents" | Guardian consent scope required; if no guardian on file → dispatcher creates guardian link task before booking | Guardian-scope test | — |
| C-13 | Domestic worker at the door offers to receive cold-chain insulin | Hand-over allowed to any adult with OTP (Cfg) **but** cold-chain items require immediate refrigeration prompt + acknowledgment; photo | OTP + ack test | — |

### 5F. Staff absence, overload, handover

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| S-1 | Phlebotomist no-show at 06:00, 14 fasting visits | Roster gap → Coverage Resolver (T3) proposes re-split among on-duty; dispatcher approves; patients auto-messaged with new ETA; fasting visits prioritised by rule | Re-plan fixture: all fasting stops ≤ 09:30 | — |
| S-2 | Staff mid-route sick | "Hand over route" action: remaining stops return to pool; **samples in hand require a physical custody transfer scan** to the relieving staff or a lab drop | Custody continuity test: no sample orphaned | — |
| S-3 | Overload: one staff assigned 22 stops | Route planner hard cap per staff per band (Cfg 12–16 phlebotomy stops/shift); `overload.flagged` (S10 mech. 13) | Cap test | — |
| S-4 | Nurse's shift ends mid-episode with an open injection task | Task returns to pool with handover note; missing dose → `medication.missed` with reason; RMO informed | Handover test | — |
| S-5 | Dispatcher goes to lunch; WhatsApp requests pile up | Slot Offerer automation answers structured requests; free-text requests queue with 15-min SLA and escalate | SLA breach test | — |
| S-6 | Female phlebotomist assigned 20:30 slot in a flagged-unsafe zone | Zone policy `pair|day_only` blocks assignment; roster validation (S10 mech. 17) | Assignment refusal test | — |
| S-7 | Vendor rider quits mid-delivery with a cold-chain packet | Vendor SLA breach → delivery `returned` expected; not returned in 4 h → incident + pharmacy writes off + re-dispense; patient informed | Timeout ladder test | — |

### 5G. Equipment, cold chain, vehicles

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| E-1 | Cold box logger shows 14 °C for 40 min in May | `sample.temperature_logged` above threshold → `sample.transit_breached` for analytes with a temp rule; lab accessioning sees the breach before rejecting; pre-emptive re-collection offer | Rule engine test per analyte | — |
| E-2 | No logger (v1 uses gel packs + manual probe) | Manual temperature at pickup and at hand-over mandatory fields; missing → custody transfer refused | Required-field test | — |
| E-3 | Centrifuge needed for serum separation on long routes | Zone rule: routes > 90 min from lab use collection centre with centrifuge or gel-separator tubes; order-time guard | Guard test | — |
| E-4 | Vehicle breakdown with 30 samples | Hand-over to relief vehicle with custody scans; time-in-transit continues; breach predictions surface to lab | Custody chain test | — |
| E-5 | Portable X-ray by partner at home | AERB: partner's licence + RSO on file, checked by Expiry Watchman; pregnancy screening question mandatory; image ingested as send-out study | Credential expiry block test | — |
| E-6 | Barcode scanner misreads (damaged label) | App requires check-digit; manual entry = double entry + supervisor flag | Check-digit test | — |
| E-7 | Lost cold box | Registry resource status `missing`; every sample last custodied to it flagged; incident | Registry status test | — |
| E-8 | Glucometer/BP device calibration overdue at home visit | Device is a registry resource with calibration due; overdue → reading flagged `uncalibrated_device`, task to biomed | Calibration flag test | — |

### 5H. Data quality, late-arriving, backdated

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| Q-1 | Handwritten outside prescription photographed; dispatcher mis-keys "CBC" as "CBP" | Order lines built from a test-catalogue picker; photo attached; OCR suggestion (T2) never auto-orders; verification at accession compares | OCR-suggest test: no `order.placed` without human pick | — |
| Q-2 | Collection time entered as 09:00 but arrival geo at 09:40 | `sample.collected.occurred_at` cannot precede `visit.arrived`; app enforces; backfill path allows with reason | Ordering invariant test | — |
| Q-3 | Address landmarks in Hinglish/Devanagari | Free-text preserved; geocode confidence shown; low confidence → dispatcher calls to pin | Devanagari search test (F7 regression) | — |
| Q-4 | Paper custody backfilled next day | `recorded_at` next day, `occurred_at` from form; transit rule evaluated on `occurred_at`; audit shows backfill actor | Backfill fixture | — |
| Q-5 | Patient weight for paediatric dose at home not captured | Nursing task requiring weight blocks injection task until weight recorded | Required-vital test | — |
| Q-6 | Partner ECG report arrives 3 days late with wrong UHID | Send-out ingestion matches on order id + DOB; mismatch → quarantine queue, never auto-attached | Quarantine test | — |
| Q-7 | Duplicate `sample.collected` from double sync | Idempotent on (device_id, offline_seq) | Dup-sync test | — |

### 5I. Fraud, leakage, gaming

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| F-1 | **Ghost visit**: staff marks arrived/completed from home, sample "collected" tomorrow at the lab from a walk-in | Geo at `arrived` vs address; `sample.collected` geo; time-between-stops physics check (speed > 60 km/h between stops = anomaly); Fraud Sentinel report class `field_ghost_visit`; reviewer: lab manager | Anomaly detector fixture | — |
| F-2 | **Sample swap**: staff draws own blood for a paying patient's HbA1c "to save a trip" | Bedside label print bound to identity gate + photo of draw arm with label (Cfg, sensitive) + random re-verification calls by dispatcher; repeat low-variance results per collector = Sentinel diagnostic | Photo-required fixture; anomaly fixture | **O-5** |
| F-3 | **Cash skim**: staff collects ₹1,500, records ₹1,200 "discount" | No discount field (M-7); patient gets invoice on WhatsApp at `payment.received` showing amount; mismatch complaints route to grievance; Sentinel: cash share per staff vs zone mean | Invoice-message test; anomaly fixture | — |
| F-4 | Staff runs private collections for a competitor lab on our route | Time-gap anomalies; unexplained stops; leakage report; HR matter (non-punitive KPI) | Gap detector test | — |
| F-5 | Referral doctor's clinic submits 40 home orders/day, all "patient-confirmed" by the same phone | Attribution verification requires patient's own OTP; same-phone clustering → `attribution.unverified_flagged` | Clustering fixture | — |
| F-6 | Rider marks delivered without OTP (vendor callback says delivered) | Our OTP validation is the only `handed_over` path; vendor "delivered" without our OTP → `delivery.disputed` (NEW) task | Adapter test | — |
| F-7 | Camp registrar registers 30 fake patients to inflate camp count (commission per head) | Camp registrations without a collected sample or vitals within camp window = ghost pattern; accrual eligibility only for registrations with a clinical event | Accrual gate test | — |
| F-8 | Dispatcher waives visit charges for friends | Waiver cap per dispatcher/day; above cap approval; Sentinel per-actor waiver rate | Cap test | — |
| F-9 | Staff sells reserved-range blank labels to a partner centre | Reserved ranges are device-bound; scan of a range outside the scanning device's allocation → hard error + flag | Range-binding test | — |
| F-10 | Franchise centre sends "home-collected" samples actually collected at their shop to earn home rates | Pricing per site type; `collection_site` is set by the actor's permission, not typed; manifests audited | Permission-derived field test | — |

### 5J. Privacy, sealed records, VIP, staff-as-patient

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| P-1 | VIP's address and diagnosis on a rider's phone | Vendor payload minimal (P-6 pattern); in-house app shows tests only to the collector for that visit, purged after close | Payload + purge test | — |
| P-2 | Geo trail of staff = surveillance of staff | Tracking only during on-duty window; start/end evented; staff can see their own trail; DPIA covers staff data (copilot §3.3 spirit) | Window enforcement test | — |
| P-3 | WhatsApp "your HIV test sample collected" to a shared family phone | Sealed class messages never name the test; generic "sample collected"; results never via WhatsApp for sealed classes | Template class test | — |
| P-4 | Requisition photo shows another patient's prescription on the same page | Crop tool + reviewer; photos stored per order under order ACL | ACL test | — |
| P-5 | Camp employer asks "who tested positive" | Only aggregates; named data only with per-employee consent (C-7) | Export test | — |
| P-6 | Field device lost | Remote wipe flag on next heartbeat; local DB encrypted at rest (device keystore); cached data ≤ today's route | Encryption + wipe test | — |

### 5K. Language, literacy, accessibility

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| L-1 | Bhojpuri-only grandmother, booking by grandson in Bengaluru via WhatsApp | Booking language English; patient language Bhojpuri → messages Hindi (nearest supported), voice IVR confirmation; staff shown language flag | Language-fallback test | — |
| L-2 | Illiterate patient consent | Audio consent playback + thumb impression photo + witness | Consent-mode test | — |
| L-3 | Visually impaired patient | OTP via voice call not SMS | Channel preference test | — |
| L-4 | Staff literacy in English low | Field app Hindi-first, icon-driven, large targets; test names bilingual | i18n coverage test | — |

### 5L. Scale (100/day → 2,000/day)

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| X-1 | 300 home visits/day across 12 zones | Route planning batch < 30 s; slot board renders < 300 ms; per-zone partitions | Perf test | — |
| X-2 | Monday 06:00 spike: 120 fasting visits in 3 h | Slot capacity model; dynamic surcharge suggestions (T1) | Capacity fixture | — |
| X-3 | 40 vendor riders | Adapter per vendor; rate limits; webhook idempotency | Webhook dup test | — |
| X-4 | Franchise network of 25 centres | Manifests as batches; accessioning queue per centre; partner scorecards | Batch accession perf | — |

### 5M. Integration failures (device/vendor/ABDM/maps)

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| G-1 | Maps API quota exhausted | Cached geocodes; fallback to pincode-centroid band with dispatcher confirm; never block booking | Fallback test | — |
| G-2 | WhatsApp template rejected by Meta | Ladder → SMS → IVR (§11.5) | Ladder test (Plan 10) | — |
| G-3 | ABDM care-context for home encounter | `Encounter.class HH` linkable; sealed suppression honoured (D-30) | Link-suppression test | — |
| G-4 | Partner lab result file (PDF/HL7) malformed | Send-out ingestion quarantine; TAT continues; manual attach | Malformed file test | — |
| G-5 | Payment gateway settlement file missing a doorstep UPI | Recon mismatch task (existing) with visit reference | Recon test | — |
| G-6 | LIMS (Plan 17) not yet live at Plan 20 time | Custody chain terminates at a **manual accession screen** with barcode scan (roadmap: manual result entry first) | Interface contract test | — |

### 5N. Home nursing, elderly, delivery specifics, safety

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| H-1 | Dog bite on staff at gate | One-touch incident → nearest ER/ARV protocol task, first-dose clock (same pattern as PEP), route re-planned, address flagged `dog` for future visits | Incident + flag test | — |
| H-2 | Needle-stick at home | §11.14 PEP task with first-dose clock; source serology requires **patient consent** captured at the visit; exposure register | PEP clock test | — |
| H-3 | Lock-out: gated society refuses entry without resident's call | Dispatcher calls patient; society-access notes stored on address; 15-min wait rule then not_at_home | Wait-rule test | — |
| H-4 | Unsafe premises (drunk male relative, harassment) | One-touch **SOS** → security supervisor + dispatcher real-time (Code Violet-at-home variant), live location shared 30 min, visit aborted, address flagged, police assist optional; POSH not applicable (non-employee) but incident register + support | SOS ladder test | — |
| H-5 | Female staff night check-in missed | Start/end check-ins; missed end check-in +30 min → call ladder | Check-in timeout test | — |
| H-6 | Ventilated patient's family asks for home ICU nursing | Out of Phase-1 scope (O-6); referral to a home-ICU provider; module may do nursing tasks under signed plan only | Scope refusal test | **O-6** |
| H-7 | Elderly monitoring package: BP/glucose weekly + fall | Vitals at home evented; danger flag → RMO call ladder; trend to consultant queue | Danger-flag ladder test | — |
| H-8 | Home dressing reveals wound infection | Nurse escalates via structured note → consultant task; photo (consented) attached | Escalation test | — |
| H-9 | Medicine delivery: patient wants substitution at door | No substitution at door; pharmacist substitution rule at dispense only (§11.8) | Structural | — |
| H-10 | Cold-chain insulin left at reception of a building | Not a valid hand-over (no OTP) → returned; insulin not restocked without pharmacist decision (never cold-chain returns per §11.8) | Return path test | — |
| H-11 | Delivery of antibiotics with a 3-month-old prescription | Rx validity window per Cfg (H: 6 months per convention, refills per Rx); expired → refuse + teleconsult offer | Validity rule test | — |
| H-12 | Physio session: patient's condition worse than plan | Therapist may stop and escalate; session charged as assessment only (Cfg) | Charge variant test | — |
| H-13 | Patient death discovered at home on arrival | Do not touch; call RMO/police as per MLC-suspect rule; visit `aborted: death_found`; sealed handling; support for staff | Abort reason test | — |
| H-14 | Road accident of staff carrying samples | Staff first; samples' custody `lost` → all orders re-collection tasks, free; insurance/incident | Custody-loss cascade test | — |
| H-15 | Patient asks staff to also "check the neighbour's sugar" | Only booked patients; walk-in at home allowed via dispatcher creating a booking on the spot (identity gate applies) with price shown | On-the-spot booking test | — |

**Row count: 126** (I-10, T-10, D-10, M-16, C-13, S-7, E-8, Q-7, F-10, P-6, L-4, X-4, G-6, H-15).

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday, 42 °C, the fasting wave and a dead server (06:00–10:30).** 05:45 routes published; 06:10 core DB restarts and stays down 90 min (map 1: duty manager declares `downtime.declared` from the standby's screen). Field apps notice heartbeat failure and switch banner to "offline — continue"; nothing changes for staff: identity OTPs cannot be sent, so the app falls to photo-ID route (I-3) automatically; labels from reserved ranges; custody scans queue. Dispatcher's board is dark; she uses the printed morning sheet and PBX to answer patient calls; new requests are written on the downtime form. 07:40 server back; apps sync custody first (D-4), then tenders; the dispatcher's backfill screen enters the six phone bookings with `occurred_at`. Lab accessioning reads temperature and time from the custody payloads; two potassiums breach (E-1) because the box sat 100 min in a scooter box; Custody Watchman had no server to run on, so the breach is computed at sync — the lab sees `sample.transit_breached` before reject and Recall offers re-collection at 16:00 free (M-3). Audit afterwards: every event shows `recorded_at` 07:40–07:55 with `occurred_at` spread 06:15–07:35; `downtime.declared/.ended` bracket it; the two breaches show the analyte rule version that fired.

**6.2 The key no-show.** 05:30 one of three phlebotomists messages sick; 15 fasting stops orphaned. Coverage Resolver (T3) proposes: split 15 across two remaining staff (caps: 14 each), move four non-fasting stops to the 16:00 band, call one bench phlebotomist from the lab for a 07:00 start. Dispatcher approves in one tap; `roster` gap evented; 19 patients get "new ETA" messages in their language (quiet hours over at 08:00 — but these are transactional/urgent, exempt). Two patients decline the new ETA → rebooked, no failed-visit charge (M-4 exception: hospital-initiated). Digest at 08:00 shows: 1 gap, 19 re-timed, 2 rebooked, on-time projection 78 %.

**6.3 The sample swap that almost worked.** A collector with the lowest rejection rate and the fastest stops is flagged by the Fraud Sentinel field pattern: 11 % of his HbA1c results fall within 0.2 of each other across unrelated patients, and three "arrived" geos are 400 m+ from addresses. Report class `field_sample_integrity` → lab manager reviewer (S10 mech. 27). Dispatcher's random re-verification calls (F-2) reach two patients who say "he did not come, he said he'd take it from our earlier report". Incident, HR, and — the system part — every sample he collected in 30 days gets a review flag; affected patients offered free re-collection; the Sentinel is diagnostic, the humans decided.

**6.4 VIP + MLC + fraud in one hour.** 11:00 a sealed-flag patient (a politician's spouse) books a home collection; dispatcher sees alias, assigns the senior female phlebotomist; vendor rider not used. 11:20 at a different address, a nurse doing a dressing sees a wound inconsistent with the story and old bruises on a minor (C-5): she taps MLC-suspect; RMO calls her; POCSO intimation path opens as a task for the MS (not the nurse). 11:40 a referral clinic's fifth "patient-confirmed" order of the day from the same phone hits F-5: `attribution.unverified_flagged`; accrual ineligible; billing supervisor's queue. Audit trail: three unrelated workflow instances, three correlation ids, none visible to the others' actors; the sealed visit's events carry alias on every surface but the actor's own app.

**6.5 Power + network loss at the lab while a route returns.** 13:00 the lab's edge and building network go down; 60 samples arrive. Accessioning uses the paper custody form (serial-numbered) and the phlebotomist's app (still online on mobile data) to *transfer custody to "LAB-DOWNTIME-BENCH"* — a registry resource that exists for this; temperatures written by hand; on restoration the technician scans each tube against the form and the TAT clock backdates to `occurred_at`. Nothing is lost; `sample.received` shows `method: backfill`.

**6.6 Vendor rider vanishes with 12 deliveries incl. insulin.** 17:00 vendor webhook stops; Custody Watchman times out at +4 h → `delivery.disputed` ×12; pharmacy re-dispenses the two cold-chain items (write-off to pharmacy cost centre, leakage principle — named cost centre, evented), in-house rider dispatched; the ten Schedule H items are re-dispensed only after pharmacist re-verifies the same `rx_verification_id` (no new Rx needed); H1 register entries reference the disputed delivery; vendor scorecard drops; owner's weekly digest lists ₹ value written off.

**6.7 Society camp, 400 people, one registrar, 35 °C, rain.** Bulk pre-registration from HR sheet flagged 30 shared phones (I-5); on the day, two tablets, one printer dies (D-2 blank labels); cash sponsored fee plus add-ons (M-13); a 58-year-old collapses — camp nurse BLS, ambulance task; 380 samples in eight boxes with loggers; manifest by box; back at the lab three boxes are late by 40 min against the potassium rule (rule fires; camp analytes were pre-guarded to a 4 h box, so no rejection). Results in 48 h per employee in their language; the employer gets an aggregate report; the 12 who opted in to employer disclosure appear by name (C-7). Recall picks up 41 abnormal results with no follow-up booking after 7 days.

---

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | Register (table) | Who signs | Inspector asks for |
|---|---|---|---|---|
| Sample transport & custody | NABL ISO 15189 (pre-analytical, sample transport SOP), NABH | `sample_custody`, `transit_temperature_log`, `analyte_transit_rules` (versioned) | lab manager (SOP), QM | chain per sample, temperature evidence, rejection reasons by site |
| Rejection & re-collection | NABH lab indicators | `sample_rejection_register` (Plan 17) with `collection_site`, `collector_id` | pathologist | rejection rate by collector/site; corrective action |
| Schedule H/H1 delivery | Drugs & Cosmetics Act & Rules (Sch. H, H1 register 3 y, Sch. X prohibition), Pharmacy Act (registered pharmacist verifies), e-pharmacy draft rules (watch) | `rx_verifications`, H1 register (Plan 16) with `delivery_id` | pharmacist | Rx for every H/H1 delivery, H1 register, no Sch. X |
| Tele-Rx | Telemedicine Practice Guidelines 2020 (List O/A/B, prohibited) | `rx_verifications.outcome` | pharmacist | refusal reasons |
| Home nursing | Clinical Establishments Act (state rules on home-care services — some states require registration of home-care as a service), Nursing Council registration | credential registry (§11.12) | NS | credentials, care plans, escalation doctor |
| Portable X-ray at home | AERB (licence, RSO, portable use approval) | partner credential rows | radiology head | partner licence, dose records |
| USG at home | PCPNDT — prohibited outside registered premises | structural refusal | — | none should exist |
| ECG on women | chaperone (NABH patient rights) | `chaperone.present` events | — | chaperone log |
| Needle-stick / dog bite | NABH occupational safety; BMW Rules 2016 (sharps from home visits return in puncture-proof containers; home-generated BMW belongs to the hospital's stream) | `field_incidents`, exposure register, BMW pickup log (Plan 19) | ICN | PEP within window; sharps return counts |
| Money | 269ST, 40A(3), GST (exempt diagnostics vs taxable convenience/delivery fee — CA), Tally export | cashier sessions, variance register | billing supervisor | field session closes, variance approvals |
| Referral commission | IMC Professional Conduct Regs 6.4 (class-c OFF), TDS | accrual ledger (09a) | owner | payee classes, PAN/TDS |
| Camps | state CEA rules (camp intimation to CMO in several states), DPDP §6 consent for employer disclosure, promotional messaging opt-in | `camps`, `camp_registrations`, consent register | ops manager/owner | intimation copy, consent evidence |
| DPDP data classes | Class 2 identified PHI (field app, dispatcher); Class 1 de-identified (any inference); Class 0 aggregates (digest, employer reports); **staff geo = personal data of employees** (DPIA staff coverage) | DPIA annex | DPO (card 37) | purpose limitation, retention, processor agreements with maps/vendor riders/partner labs |
| Vendors | DPDP processor agreements (rider vendors, partner labs, maps provider) | vendor master (Plan 14) | owner | agreements on file |
| Consent forms | phlebotomy (implied, but home-visit terms), HIV counselling, minors (guardian), photo/ID capture, nursing procedures, employer disclosure, promotional messaging | `consent.recorded` with form version | patient/guardian + staff witness | signed/audio consents per visit |
| Retention | OPD-class 5 y; sealed classes per statute; H1 3 y (recommend 5); incident registers 5 y; geo 90 d then pseudonymised | retention job (existing pattern) | MRD | retention policy doc |

**NABH walk-in demand list (field):** SOP for home collection with identity verification; transport validation study (time/temperature) per analyte; rejection trend by collector; staff safety policy incl. women at night; incident register with RCAs; competency records of field staff; patient feedback for home services; consent templates in local language.

---

## 8. Staff KPI & KRA

All formulas target the KPI formula registry (deferred note 5); until it exists these are the book of record. Every rate is reported with its load context; **none auto-punishes**.

**Field Phlebotomist (card 36, field)**
| KPI | Formula (events) | Load norm | SLA link | Diagnostic reading |
|---|---|---|---|---|
| Visits per productive hour | count(`visit.completed`) / (Σ(`visit.completed.at` − `visit.en_route.at` of first stop)) | zone density, band mix | — | low with high travel share → routing problem, not the person |
| On-time arrival % | `visit.arrived.at` ≤ slot_end + 15 min / visits | stops/route, traffic zone | slot SLA | drops on rainy days for all = weather; drops for one = coaching |
| Collection-attributable rejection % | `sample.rejected.reason_class = collection` / `sample.collected` | tube mix (paediatric, coag) | <1 % target | separates from `transit` and `accession` classes |
| Transit-breach % of own samples | `sample.transit_breached` / collected | route length, analyte mix | analyte rules | high for one zone → box/route fix |
| Identity-gate completion | `visit.identity_verified` present / `visit.completed` | — | hard gate | should be 100 %; less = backfill or bypass to review |
| Cash variance | Σ`cash_variance.recorded` on own sessions / sessions | cash share | same-day close | pattern → Sentinel; single event → nothing |
| Not-at-home % | `visit.not_at_home` / assigned | zone | — | mostly a booking-confirmation problem |
| Patient feedback score | mean `visit_feedback.score` | response rate | — | language-corrected |

**Dispatcher (NEW-H1)** — slot-offer TAT (`visit.requested`→`visit.slot_offered`); confirmation rate; re-plan latency after gaps; failed-visit charge waiver rate (with cap); same-day fill %; unresolved requests at shift end = 0; grievance first response. KRA: every request answered, every route staffed, every not-at-home closed.

**Home-care Nurse (NEW-H3)** — task completion in window (`task.completed` vs plan); missed-dose rate (`medication.missed`, reason-coded); danger-flag acknowledgment latency; documentation completeness; escalation appropriateness (reviewed by NS, not auto). KRA: care plan executed and every deviation escalated.

**Rider (NEW-H2)** — OTP hand-over % (100 % expected); dispatch-to-handover median; returns %; cold-chain hand-over ack %; disputes per 100. KRA: right packet, right person, sealed, on time.

**Collection Centre Operator (NEW-H6)** — manifest accuracy (discrepancies/manifest); centre-attributable rejection %; transit compliance; pricing-site integrity flags. KRA: what the manifest says is what arrives.

**Cashier (field reconciler)** — sessions closed same day %; variance approvals; UPI recon match.

**Gaming vectors and resistance:** on-time % gamed by marking `arrived` early → geo + address distance + next `sample.collected` gap check; visits/hr gamed by ghost completes → F-1 physics; rejection % gamed by discarding difficult draws (marking `not_done`) → not-done rate is paired KPI; feedback gamed by staff entering it → feedback only via patient channel token; cash variance hidden by "discounts" → no discount permission.

**Owner's 8 a.m. digest (field section):** yesterday's visits (done / not-at-home / aborted), on-time %, rejection by class, transit breaches, field sessions unclosed, cash variance ₹, waivers ₹, deliveries disputed, safety incidents (always real-time anyway), top zone by demand, unfilled requests, camp pipeline.

---

## 9. AI agents & the copilot — where inference earns its place

Rule applied: deterministic wherever a rule is safer/cheaper/more auditable. Most of this department is **automations**.

| Candidate | Kind | Tier | Trigger / inputs | Output | Human sign-off | Fail-open manual path | Kill scope | Provenance | Eval / guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Route Planner** | automation (VRP heuristic; no LLM) | T3 → T4 after 60 d | 05:00 daily + on change; zone, slots, staff caps, analyte constraints, female-staff policy | proposed routes | dispatcher approves (T3); auto-publish (T4) | dispatcher drags stops manually | per-agent | job id + input hash | on-time %, cap violations = 0, constraint solver tests | Class 2 internal (addresses); never inference | Plan 20 |
| **Slot Offerer** | automation | T4 (operational) | structured WhatsApp/app request | slot options + price quote | patient confirms | dispatcher | per-agent | — | quote = tariff engine output (golden) | Class 2 in-boundary | Plan 20 |
| **Custody Watchman** | automation | T1 | custody + temperature events vs analyte rules | `sample.transit_breached`, pre-emptive re-collection offer | lab tech at accession | lab reads temperature by eye | per-agent | rule version | rule fixtures per analyte | Class 2 in-boundary | Plan 20 |
| **Field Session Reconciler** | automation (Leakage Auditor pattern) | T0 | session closes, tenders, invoices | unclosed sessions, variance, tender-vs-invoice gaps | billing supervisor | manual day book | under Leakage Auditor | — | fixtures | Class 2 internal | Plan 20 |
| **Field Fraud patterns** | automation (Fraud Sentinel) | T0 | geo, timing, result variance, waivers, attribution clusters | report classes `field_ghost_visit`, `field_sample_integrity`, `field_cash_skim`, `attribution_cluster` | reviewer roles (mech. 27) | none needed | under Fraud Sentinel | — | synthetic fraud fixtures; false-positive budget | Class 2 internal; no inference | Plan 20 |
| **Recall & Follow-up (extended)** | automation T1 (existing) | T1 | `sample.rejected`, `visit.not_at_home`, abnormal camp results w/o follow-up | rebook offers, call tasks | dispatcher | call list | existing | — | existing | Class 2 | Plan 20 |
| **Doorstep Rx Verifier Assist** | agent (vision/LLM on Rx image) | T2 | uploaded prescription image | draft: drug lines, schedule class, red flags (Sch. X, tele-prohibited) | **pharmacist signs `rx.verified_for_delivery`** | pharmacist reads image | per-agent | model id, prompt v, image hash, output hash | fixture set of real-shaped Rx images; refusal fixtures; never auto-verify | Class 1: image with patient/doctor name regions masked before inference (in-text scrubber) | post-12a, with Plan 16 |
| **Visit Note Drafter** | agent | T2 | nurse's structured checkboxes + dictation | draft visit note | nurse signs | type note | per-agent | stamps | citation-only claims (copilot §2.4) | Class 1 tokenised | post-12a |
| **Requisition OCR suggest** | agent | T2 | requisition photo | suggested test picks from catalogue | dispatcher picks | manual pick | per-agent | stamps | never emits `order.placed` | Class 1 (names masked) | post-12a |
| **Demand/surcharge advisor** | agent or stats | T1 | slot fill history | suggest opening extra band / surge fee | dispatcher/owner | — | per-agent | — | — | Class 0 | later |
| **Digest Writer** (existing) | agent | T0 | Class-0 fact sheet | field paragraph | — | — | existing | existing | existing | Class 0 | 12a |

**Three lanes for this department (deferred note 3):** Lane 1 hand-built — the **field Android app** (offline-first, barcode, camera, geo; the one screen family that must be hand-built and perf-budgeted) and the dispatcher's slot/route board. Lane 2 schema-generated — partner manifests, camp admin, analyte rule editor, zone editor, incident forms, feedback review, waiver queue. Lane 3 conversation — dispatcher copilot ("move all of Rekha's 09:00–11:00 stops to Sunil", "who is nearest to Sector 12 with a cold box?", "book a CBC+HbA1c for UHID X tomorrow fasting") under propose→confirm; **pilot cohort candidate** alongside Track B ops roles (non-clinical error surface). Copilot inputs: on-duty roster, open visits, zone capacity, tariff quote API, address book — all via the 12a tool catalog under the dispatcher's own permissions; no free-text order creation ever.

**Journey Feed contributions:** `visit.*`, `sample.custody_transferred`, `sample.transit_breached`, `delivery.*`, home vitals and `medication.administered (home)` render on the patient's timeline; the consultant sees "collected at home 07:12, received 08:40, breach: none".

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context at the door:** patient's WhatsApp confirmation carries a signed QR; staff scans it → identity step half-done (still OTP/ID for high-risk). Tube barcode from reserved range; **scan-tube-to-order binding at the moment of draw** (never pre-labelling). Target: identity + labels ≤ 90 s.
- **Pre-filled everything:** orders, tube list with colours and draw order (order-of-draw per CLSI as a picture), fasting flags, price already paid or to collect, language, access notes, risk flags (dog/no-lift).
- **Dynamic UPI QR per invoice** (amount-locked) so the patient cannot pay the wrong amount and the staff cannot pocket the difference; static QR only as fallback.
- **TAT clocks that start at the right place:** lab TAT starts at accession (§11.6); the **field TAT** (`visit.completed`→`sample.received`) is its own clock with analyte-rule colouring on the dispatcher board.
- **Worklists, not menus:** staff sees today's stops in order with ETA; dispatcher sees exceptions only (unassigned, late, not-at-home, unclosed, breach-risk).
- **Cold box with logger** (₹6–10k each) pays back in one avoided-rejection week; manual probe as fallback.
- **Printing:** route sheet with QR per stop; blank reserved barcodes; consent forms bilingual; camp registration cards with QR.
- **Voice:** IVR confirmation calls in Hindi/English for no-WhatsApp patients; dictation for visit notes (T2 drafts).
- **Perf budgets:** app cold start < 3 s on ₹12k Android; scan-to-label < 1 s; sync of a 12-stop day < 20 s on 4G; dispatcher board < 300 ms.
- **Auditability levers:** every `visit.arrived` carries geo + accuracy + method; every custody hop carries two identities; every tender carries a UTR or a session; every waiver carries a reason and a cap; every agent draft carries its stamp.
- **Measured targets (recommended):** on-time ≥ 90 %; collection-attributable rejection < 1 %; transit breach < 0.5 %; identity-gate completion 100 %; field sessions closed same day 100 %; OTP hand-over 100 %; slot-offer TAT ≤ 15 min; not-at-home < 5 %.

---

## 11. Integrations, devices & dependencies

| Item | Choice / Indian market examples | Protocol | Note |
|---|---|---|---|
| Field handset | Android 12+, 4 GB RAM (Samsung M-series / Redmi Note class), rugged case | React Native or PWA-with-offline (decide in spike; barcode+Bluetooth printing favours RN/Capacitor) | one device per field staff; MDM (buy: e.g., Scalefusion/Hexnode) for remote wipe |
| Label printer | Bluetooth thermal 2-inch (TSC Alpha-2R, Zebra ZQ220, Brother RJ) | ESC/POS-class via BT | reserved-range blanks as fallback |
| Scanner | phone camera (ML Kit) + optional BT ring scanner | — | check-digit barcodes (Code 128 with mod-103 + our own check digit) |
| Cold box + logger | 4–8 L vaccine-carrier class boxes; USB/BT temperature loggers (Elitech RC-5/LogEt, Tempsen) | CSV/BT read at accession; MQTT later if live loggers | gel packs; "no ice" analyte rule |
| Maps/geocode/route | Google Maps Platform or MapmyIndia (Indian addresses, pincode quality) | HTTPS | quota fallback G-1; data-processor agreement |
| UPI | existing gateway (dynamic QR API), static VPA fallback | HTTPS/webhook | UTR capture; T+1 recon (§7) |
| mPOS | optional (Pine Labs/Paytm Soundbox for cash-heavy zones) | vendor SDK | |
| Delivery vendors | Dunzo/Porter/Shadowfax/Borzo APIs behind `DeliveryProvider` | HTTPS webhooks, idempotent | our OTP, never theirs |
| Partner labs/centres | manifest exchange: CSV/JSON v1; HL7 v2 ORU / FHIR DiagnosticReport ingestion for results (send-out, §11.6) | HL7 v2 / FHIR | quarantine on mismatch |
| Partner ECG/X-ray | PDF + DICOM (X-ray → Orthanc as send-out study) | DICOM C-STORE via edge | AERB credentials in registry |
| WhatsApp/SMS/IVR | Plan 10 gateway | — | templates: booking, quote, confirmation, ETA, running-late, collected, paid invoice, report-ready, feedback |
| ABDM | care-context for `HH` encounters | FHIR | suppression for sealed |
| Edge-service rule | any serial/BT device talks to the app or an edge service, never the core directly; logger files uploaded through the app | — | |

**Dependencies:** Plan 13 registry (kinds) · Plan 10 gateway · Plan 06/07 billing sessions · Plan 09/09a accrual · **Plan 17 LIMS** (accession + rejection; a manual accession screen is the minimum contract) · Plan 16 pharmacy (dispense, H1 register) · Plan 19 task fabric (P5 tasks, BMW sharps return) · Plan 14 vendor master (partners, riders) · Plan 12a agent runtime (for the T2 agents only) · patients guardian model (D-31). Events consumed: `order.placed`, `order.cancelled`, `sample.received`, `sample.rejected`, `dispense.completed` (Plan 16 NEW), `payment.received/.refunded`, `patient.merged`, `roster.synced`, `credential.blocked`, `downtime.declared/.ended`.

---

## 12. Buy vs build, hardware & rough INR budget

**Build (own tables + workflow):** visits, custody, field sessions (reuse), camps, partner manifests, analyte rules, field app, dispatcher board. **Buy:** maps/geocoding, MDM, delivery vendors, UPI gateway, loggers, printers, vehicle GPS (if vans; two-wheelers use the handset).

| Item | Qty (day one → 2,000/day) | INR |
|---|---|---|
| Android handsets + cases | 6 → 60 | ₹12–15k each → ₹0.9 L → ₹9 L |
| BT label printers | 4 → 40 | ₹9–14k each → ₹0.5 L → ₹5 L |
| Cold boxes + loggers | 6 → 60 sets | ₹8–12k/set → ₹0.6 L → ₹7 L |
| Ring scanners (optional) | 0 → 20 | ₹4–6k |
| MDM SaaS | per device | ₹150–300/device/month |
| Maps API | — | ₹5–25k/month by volume |
| Delivery vendor | per drop | ₹40–90/drop intra-city |
| Two-wheelers (in-house riders) | 0 → 10 (EV) | ₹1–1.3 L each; or staff-owned + allowance |
| Van (camps) | 0 → 1 | ₹8–12 L (or hire) |
| Uniform, ID badge with QR, first-aid/ARV kit, sharps containers, staff safety (pepper spray where lawful, SOS) | per staff | ₹3–5k |
| Total day-one capex | | **≈ ₹2.5–3.5 L** |
| Total at 2,000/day | | **≈ ₹35–45 L** + vehicles |

---

## 13. Owner rulings needed

- **O-1 Pricing structure & GST for home visit charge.** Recommend: base by distance band (0–5 km ₹150, 5–10 km ₹250, 10–15 km ₹350; beyond = quote), free above a bill threshold (₹1,500) as an adjustment rule; **GST on the convenience component at 18 % as a separate taxable line, diagnostics exempt** — CA confirms; camps priced per pack. Why: corporate chains (Dr Lal, Metropolis, SRL) all use band + free-above-threshold; it is legible on WhatsApp.
- **O-2 Failed-visit charge.** Recommend: charge ₹100 only when confirmed ≤ 2 h prior and no answer to 2 logged calls; waived automatically if hospital-initiated re-time; dispatcher waiver cap ₹500/day. Why: deterrent without a grievance magnet.
- **O-3 Quote honouring window.** Recommend 72 h on WhatsApp quotes.
- **O-4 Employer disclosure default at camps.** Recommend default OFF (aggregates only); per-employee opt-in. Legal exposure (DPDP) is the owner's.
- **O-5 Draw-arm photo with label as anti-swap evidence.** Recommend OFF by default, ON for staff under integrity review or for HbA1c/HIV/drug-screen classes; it is intrusive and the DPIA must cover it.
- **O-6 Home ICU / ventilated outreach.** Recommend OUT of Phase 1; nursing visits under a consultant-signed plan only; revisit with IPD cluster.
- **O-7 Female-staff night policy.** Recommend `day_only` for solo women; evening (till 20:00) allowed in green zones; pair or male-accompanied otherwise; zone flags editable by security supervisor. Labour-law and reputational exposure are the owner's.
- **O-8 Third-party rider COD.** Recommend NO cash via vendor riders; prepaid/UPI-at-booking only; in-house riders may take cash into a field session.
- **O-9 Partner/franchise model.** Recommend start with 2–3 partner collection centres on a manifest + revenue-share agreement (Plan 14 vendor master), no franchise brand licensing until NABL scope covers sample transport validation.
- **O-10 Rx validity for delivery.** Recommend 6 months for Schedule H acute (single fill unless refills marked), chronic refills per Rx; H1 single fill per Rx date; this is legal exposure.
- **O-11 Vehicle policy.** Recommend staff-owned two-wheelers + per-km allowance day one; EV fleet at ~30 riders.
- **O-12 Activation of `home` encounter class in the encounter enum** (touches the spine) — recommend yes, with Plan 20.

---

## 14. Plan sketch — how this becomes phase documents

**Proposed: Plan 20 — Home Collection & Home Care**, in two phase docs, after 17 LIMS (needs accession) and 19 task fabric; 20b after 16 pharmacy.

**20a — Field collection core (gate: Plan 17 accession screen live, Plan 13 kinds added, Plan 10 templates approved)**
1. Schema + manifest: `home_visits`, addresses/zones, `visit_orders`, `sample_custody`, `transit_temperature_log`, `analyte_transit_rules`, `field_devices`, `field_incidents`, registry kinds (`vehicle`, `cold_box`, `collection_centre`, `field_device`).
2. Workflow definitions `home_visit`, `sample_custody` (data, owner-activated); events NEW list; SLA defaults.
3. Booking surfaces: dispatcher board (Lane 1), WhatsApp structured booking via Plan 10 (Slot Offerer automation), OPD consult "home collection" order flag.
4. Tariff lines: visit charge bands, adjustment rules (free-above, quote-honoured), failed-visit charge; golden fixtures; 269ST aggregation test at doorstep.
5. Field app v1 (Android, offline-first): route, identity gate, consent, label print/bind, draw, custody scan, temperature, tender (dynamic UPI QR/cash), not-at-home, SOS. Perf budgets.
6. Field cashier session (`session_kind: field`) + reconciliation screen (Lane 2) + SoD pairs.
7. Custody Watchman, Route Planner (T3), Field Session Reconciler, Fraud Sentinel field patterns, Recall extensions.
8. Safety: check-ins, SOS ladder, incident classes, PEP/ARV clocks; zone female-staff policy in roster validation.
9. Camps v1 (bulk registration with consent flags, camp session, manifests).
10. Downtime kit: printed route sheet, blank reserved labels, paper custody form, backfill screen.
11. Assertion book: the §5 rows by ID; mutants on lock (T-1), idempotency (T-10, Q-7), custody continuity (S-2), identity gate (I-1/I-2), 269ST aggregation (M-2).

**20b — Home care & delivery (gate: Plan 16 dispense events + H1 register live; 12a runtime for any T2 agent)**
1. `home_care_episodes`, `home_care_tasks`, care-plan calendar, eMAR-at-home subset, vitals/danger ladder, physio packages on entitlement counters.
2. `medicine_delivery` workflow, `rx_verifications`, `DeliveryProvider` adapter (one vendor + in-house), OTP hand-over, returns path, H1 register link, Sch. X structural block.
3. Partner services (ECG/X-ray) as send-outs with credential gates; partner manifests/results ingestion.
4. T2 agents (Rx Verifier Assist, Visit Note Drafter, OCR suggest) behind the copilot design gates.
5. Dispatcher Lane-3 copilot pilot (with Track B cohort).

**Sequencing/gates:** 13 → 17 (accession) → 20a; 16 → 20b; 19's task fabric before 20b's nursing tasks; DPIA revision for staff geo + draw photos (O-5) before 20a go-live; Plan 10 template approvals (Meta) started 4 weeks early.

**Negative-space question — what absence is a signal here?** (a) A completed visit with **no `visit.arrived` geo** or with `method: manual` at a rate above zone mean; (b) a collected sample with **no custody hop** before `sample.received` (it teleported); (c) a paid invoice with **no `visit.identity_verified`**; (d) a not-at-home with **no call attempt event**; (e) a field session with **no close** by midnight; (f) a delivery with a vendor "delivered" and **no OTP validation**; (g) a camp registration with **no clinical event** in the camp window; (h) a female staff evening route with **no end check-in**; (i) an abnormal home result with **no follow-up booking** in 7 days. Each of these is a Leakage/Fraud/Recall report row, not an alert.

**Staff edge-case interview questions (for the lab manager, senior phlebotomist, pharmacy in-charge, nursing superintendent):**
1. What do you do today when the person at the door is not the patient? How often?
2. Which tests do you refuse for home collection, and at what distance/temperature? Do you know your rejection rate by collector?
3. How are tubes labelled at home today — before or after the draw? Where do labels come from?
4. How is cash handled at the door and reconciled? Has cash ever gone missing?
5. What happens when a patient is not at home? Do you charge? Who decides?
6. Have staff faced dogs, harassment, drunk relatives, lock-outs? What did they do? Is there a callback rule?
7. Which referral doctors send home orders, and how do you know the patient actually chose you?
8. How do camps run today — registration, consent, results distribution, employer reports?
9. What does a partner centre send you and how do you know the manifest is complete?
10. Which medicines have you been asked to deliver without a prescription, and how was it refused?
11. What do nurses at home do when the patient deteriorates? Whom do they call, and is anyone always reachable?
12. Which analytes have you actually seen rejected after home collection, and in which months?
13. What is the longest a sample has sat before reaching the bench, and why?

---

## 15. Open questions & risks

1. **Legal status of home-care nursing as a service** under the state's Clinical Establishments rules — some states require separate registration/intimation; counsel needed before 20b.
2. **GST treatment** of home-visit convenience fees bundled with exempt diagnostics — composite vs mixed supply; CA ruling drives O-1's line structure.
3. **E-pharmacy rules** (draft amendments to the Drugs & Cosmetics Rules on online sale) may change what a hospital pharmacy may deliver; the delivery module must be flag-inert until counsel confirms the current position.
4. **Staff geo-tracking as employee personal data** — DPIA must cover it; unions/POSH considerations for women's night policy (O-7).
5. **NABL sample-transport validation** — the analyte rule table needs a validation study per analyte for accreditation; until then rules are literature defaults (recommended default: conservative).
6. **Map data quality** in peri-urban addresses — pilot zone-based bands before distance-based bands if geocode confidence is poor.
7. **Draw-arm photo** (O-5) — intrusive; ethics/consent wording and DPIA needed; may be replaced by random re-verification calls alone.
8. **Encounter class `home`** touches the encounter enum on the spine — small, but the spine change must be scheduled with Plan 17's encounter work, not slipped in.
9. **Vendor rider identity** — vendors rotate riders; our "actor" is the vendor plus a rider ref; the audit chain is weaker than for staff; accept and document.
10. **Home vitals danger-flag ladder** depends on a 24×7 reachable RMO for outpatients — a staffing commitment the nursing superintendent must confirm before elderly-monitoring packages are sold.
11. **Franchise brand liability** — a partner centre's error is our name on the report; the manifest + rejection-by-site machinery is the control, but the agreement's indemnity is a counsel item.
