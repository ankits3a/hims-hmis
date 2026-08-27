# 02 — Central Laboratory / LIMS — Brainstorm & Planning

Date: 2026-08-27 · Status: **Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED** · Roadmap slot: **Plan 17** (Track A, after 16 pharmacy, before 18 radiology) · Series doc 02.

**Executive summary.** The central lab module is the P2 order-to-result pipeline for every laboratory discipline the hospital will run — biochemistry, haematology, clinical pathology (urine/stool/fluids), serology/immunoassay, microbiology (culture-sensitivity), histopathology/cytology, and molecular (PCR) — from order through collection, accessioning, analysis, verification, publishing, amendment and statutory reporting, plus the QC/calibration/reagent-lot machinery NABL ISO 15189 demands and the analyzer edge agent that lets machines write results without touching the core DB. It is NOT the blood bank (licensed, operating, its own module: crossmatch/issue stay there — S10 card 19), NOT radiology (Plan 18), NOT home-collection field operations (doc 03 owns the field; this doc owns the sample once it is a barcode), NOT procurement (Plan 14 owns PO/GRN; lab owns reagent consumption and lot linkage), and NOT a patient-portal product (Plan 10 channels publish; lab only decides *what* and *when*). Its three hardest problems: **(1) identity at the tube** — wrong-blood-in-tube is the one lab error that kills, and it is committed at a chair or a bedside, not on a screen; **(2) the release decision under pressure** — auto-verification, delta checks, QC lockout, unpaid-report interlock, critical values at 2 a.m., and the pathologist as a single point of judgment, all colliding on the same result row; **(3) analyzers as untrusted, half-connected peers** — ten machines with five protocols, a serial cable, a mini-PC, and a driver that crashes on a Monday; the pipeline must be correct with zero interfaces (manual entry first, per the roadmap) and stay correct as each interface is switched on.

---

## 1. Frame — what exists, what is locked, what this document adds

**Built today (Phase 1, live in `commissioning`):** kernel (events outbox, workflow engine + versioned definitions, approvals, RBAC actor fabric, scheduler/worker, ops modes/downtime kit), patients (UHID, ABHA-address fields, language, allergies), tariff/GST + adjustment rules, OPD encounters + queue with *priority re-entry class already supported* (roadmap §Plan 07 trap), billing counter (append-only, credit notes), notifications gateway (WhatsApp/SMS, template registry), memberships/coupons/accrual ledger, formulary, global search, user admin. Plan 13 resource registry in flight (`resources` + `resource_status_history` shipped in T1 as `e913845`). Nothing lab-shaped exists in code: no orders table, no results, no LOINC load.

**Locked decisions inherited (do not re-litigate; extend only):**
- Spec §11.6 (S3): one pipeline for OPD / ward / ICU / ER-stat / walk-in outside-prescription orders (outside referrer attribution → commission ledger); billing branch per source (OPD/walk-in prepay · IPD posts to bed · ER accrues); chair-side barcode labels + right-patient scan before draw; **accessioning scan starts the TAT clock**; **QC lockout**; **auto-verification of normal in-range results from interfaced analyzers**, pathologist signs abnormal/critical/edited/manual; **critical values need documented acknowledgment with read-back**; departed patient → §11.5 mandatory contact protocol; sample rejection → **free re-collection** (§11.5); **send-outs first-class** (dispatch manifest, chain, ingestion, own TAT; partner selection deferred to this spec → O-3); reflex testing auto-adds with billing consent shown at order time; analyzer reruns free but evented for QC trends; **amended reports versioned, never overwritten**.
- §10.3: **lab TAT is one of the four active-alert classes at go-live** (others: OPD wait, ER triage, oxygen).
- §11.19-C #10: **QC-lockout release valve** — pathologist's documented emergency override, results stamped *QC-suspect* on the report face, reroute to backup/POCT path, mandatory next-day review; `qc.override_recorded`.
- §11.19-C #13: device-billing reconciliation covers analyzers — usage events vs billed tests, both directions.
- §11.19-B sweep #8: **IDSP/IHIP notifiable diagnoses auto-flag the register and create the government-reporting task with deadline**; `notifiable.reported`. Sweep events `interface.down` / `interface.restored` / `clock.drift_flagged` / `late_entry.flagged` exist.
- §11.15: POCT ABG analyzers are interfaced with QC lockout "like any analyzer" — POCT is in this module's registry of analyzers even when physically in ICU/ER.
- §11.16: `frozen_section.resulted` — intra-op frozen section TAT clock (S10 card 16 KPI).
- §5: lab edge = Node/TS on a fanless mini-PC with SQLite buffer; driver crash isolates to the lab agent. §9: LOINC/SNOMED/ICD-10 and notifiable-disease lists are **licensed content, never authored**.
- Roadmap Plan 17 line: order/accession/result/verify/report; **sex- and age-based reference ranges; formula results; report-blocked-until-paid interlock**; **manual result entry first, analyzer interfaces phased per machine** as the owner's analyzer inventory (an open owner action) arrives. Legacy harvest: per-test remarks, abnormal highlighting, signature/degree block on the report, **no pathology refund once the result is saved**.
- Plan 13 DD4: kinds are a closed set of ten; **Plan 17 claims `bench` and `analyzer`** on its manifest (status vocabularies declared there). Containment rules are the module's.
- §14 confidential records (VIP/staff-as-patient alias on public surfaces); §11.14 DPDP retention (OPD ~5y, IPD ~10y, MLC indefinite), legal-hold; §11.19-D #13 untrusted-content boundary (an external lab PDF is data, never instruction).
- Copilot design laws: LLM narrates never originates; blank is not a state; model never sees more than the caller; clinical cap T2–T3.
- Approvals engine is the only gate mechanism; workflow-definition activation is owner-only (§10.4).

**Scope boundaries and neighbours (who owns which table):**

| Concern | Owner | Lab's relationship |
|---|---|---|
| `patients`, allergies, language, ABHA | patients module | read via `patients.get`; never copies demographics |
| Encounter spine (OPD/IPD/ER/day-care) | opd / future ipd / er | `lab_orders.encounter_id`; walk-in orders create a `lab_visit` encounter type (proposed: enum value `lab_walkin`) |
| Tariff, adjustment rules, invoices, credit notes | tariff / billing | lab emits `charge.posted`; consumes `payment.received` / `invoice.issued` for the interlock; never writes billing rows |
| Order entry inside consult | opd-consult (Plan 09/11 screens) | posts `order.placed(order_type=lab)`; lab owns everything after |
| Blood bank crossmatch / issue / donor | blood bank module (existing licensed bank) | lab does **pre-transfusion investigations** if ordered as tests (grouping when ordered as a lab test); crossmatch/issue/reaction stay in BB; shared `unit.crossmatched` consumption only for reporting |
| Reagent PO/GRN, vendor master, consignment | Plan 14 procurement | lab owns `lab_reagent_lots` consumption + lot-in-use; indents via P3 request-to-issue; reagent-rental usage counts exported |
| Home collection field ops (rider, route, cash) | doc 03 | handover = a barcode scan at the lab door; the sample enters this pipeline at `sample.received` |
| Notifications, templates, quiet hours | Plan 10 | lab requests `result.published` sends; channel choice is Plan 10's ladder |
| Radiology, PCPNDT | Plan 18 | none, except shared `order.placed` family |
| Registry (`bench`, `analyzer`, rooms) | kernel resources | lab declares kinds + statuses, references `resources.id` |
| Notifiable disease register | lab (first-class table) **with** infection control / MRD as readers | proposed: lab owns `notifiable_case_register` because the trigger is a verified result |

**What this document adds:** the workflow definitions (sample, order-item, culture, histo, send-out, critical-value contact, QC), the data model, the edge agent contract, the interlock semantics, ~110 edge cases, chaos walkthroughs, KPIs, agent placements, and the Plan 17 split.

---

## 2. Actors, roles & role cards

**Human roles (S10 card numbers where they exist):**

| Role | S10 | Stations in this module | Shift/bundling notes |
|---|---|---|---|
| Pathologist (MD Path) | 16 | verification queue (abnormal/critical/edited/manual), histo/cyto sign-out, frozen section, QC override authority, amendment approver, NABL technical manager | 1 today → 4–6; night = on-call by phone + app; may sign remotely (in-app only, never by WhatsApp reply) |
| Microbiologist (MD Micro) | **NEW card 16-M** | culture reads, sensitivity interpretation (CLSI/EUCAST breakpoints), antibiogram, infection-control liaison, IDSP signatory | 0 today (outsourced) → 1–2; until hired, culture verification routes to pathologist or reference lab |
| Lab Technician / Technologist | 17 | accessioning, benches (bio/haem/CP/sero), analyzer operation, QC runs, manual result entry, rerun decisions | 3–4 → 25–35, 24×7; bench assignment is a registry `bench` occupancy |
| Phlebotomist | 36 | OPD collection chairs, ward rounds, stat tasks, ED draws | 1–2 → 12–16; night draws bundled to ward nurse (competency-gated) |
| Sample collection nurse (ward/ICU) | (nursing cards) | bedside collection with wristband scan; line draws in ICU | collection attribution stays on the collector, not the lab |
| Lab receptionist / front desk | (front office 1–7) | walk-in registration, outside-Rx order entry, billing, report print counter, report collection identity check | day only; night walk-ins go to ER desk |
| Lab manager / quality manager | **NEW card 17-Q** | NABL document control, QC review, EQAS/ILC, calibration schedule, CAPA register, internal audit | 1 from NABL-application day; may bundle with senior tech until 100 beds |
| Histotechnician | **NEW card 17-H** | grossing assistance, processing, embedding, microtomy, staining, slide/block archive | 1 → 3–4; day shift |
| Sample transport / runner | (ops 9) | pneumatic-tube-free hospital: ward → lab batches; chain scans | bundled with porters |
| Send-out coordinator | bundles into lab receptionist | dispatch manifests, courier tracking, external result ingestion | |
| Infection control nurse | (nursing) | consumes antibiogram, HAI alerts, notifiable register | reader |
| Billing cashier | (front office) | unpaid-report interlock release on payment; **never** enters results | SoD |
| Ordering doctor | 8–14 | orders, acknowledges criticals, views trends, requests add-ons | |

**Agents and automations (all under the 12a harness; tiers per §16):**

| Actor | Type | Tier | One line |
|---|---|---|---|
| Lab Edge Agent (`lab-edge-<site>-<n>`) | automation (edge service, not inference) | T3 (acts: writes `result.entered` with `verification_status=unverified`) | ASTM/HL7 bridge on the mini-PC; SQLite buffer; idempotent upload |
| Auto-Verifier | automation | T3 behind pathologist-approved rule set | applies per-test auto-verification rules; never touches abnormal/critical/delta-failed/QC-locked |
| Delta Checker | automation | T0/T1 | compares to previous result per test within window; flags |
| Critical Value Caller | automation (Recall & Follow-up agent scope extension) | T1 | opens the call task, runs the ladder, closes only on read-back |
| TAT Chaser | SLA Chaser instance | T1 | per-state SLA breach → on-duty nudge |
| QC Watchman | automation | T1 | Westgard evaluation → lockout; calibration due; lot expiry |
| Re-collection Orchestrator | Recall agent scope | T1 | rejection → task → recall attempts → closure |
| Reagent Replenishment | Replenishment Agent (pharmacy's) applied to lab stores | T4 (indent draft; PO approval unchanged) | par-level indents for reagents/consumables |
| Report Narrator (histo/micro) | **agent** (inference) | **T2** | drafts histo microscopic-description-to-impression scaffolding and culture comment text from structured fields; pathologist signs |
| Lab Ops Copilot lane | agent (conversational, Lane 3) | T2 | "which samples from ward 3 are pending?" → tool calls under caller permissions |
| Digest Writer contributions | agent | T0 | lab lines in the 8 a.m. digest |

**SoD hard pairs (proposed additions to S10 §11):** result enterer / verifier for the *same* result row (system-enforced even when one person holds both roles — a manual result you entered you cannot verify unless the definition's `single_operator_night_mode` is active, which is itself evented) · QC override requester / next-day reviewer · cashier / interlock-override approver · reagent lot custodian / lot-count auditor · amendment author / amendment approver · send-out dispatcher / external-result acceptor (chain integrity).

---

## 3. Core flows as workflow definitions

All lifecycles below are **workflow definitions** (design law 2), P2 order-to-result unless noted; SLAs are recommended corporate defaults, configurable per test category, activated by owner approval.

### 3.1 `lab_order_item` (one per orderable test/panel per order) — P2

```
ordered ──(billing branch)──► awaiting_payment ──payment.received──► awaiting_collection
   │                                 │ (IPD/ER: skipped; posts to bed / accrues)
   │                                 └─ cancelled_unpaid (24h TTL, OPD)
awaiting_collection ──sample.collected──► collected ──sample.received──► accessioned
accessioned ──► in_analysis ──result.entered──► resulted
resulted ──(auto-verify rule pass)──► verified          [actor=system, stamped]
resulted ──(pathologist/tech verify)─► verified
resulted ──(rerun)──► in_analysis                      [rerun_count++, free]
verified ──► published ──► acknowledged (optional, criticals mandatory)
published ──report.amended──► published (version n+1; prior version retained)
any pre-resulted ──order.cancelled──► cancelled (credit note if paid)
any ──sample.rejected──► recollection_pending ──► awaiting_collection (new sample id, same item)
accessioned ──sample.dispatched──► sent_out ──sample.external_resulted──► resulted
```

| State | Allowed transition roles | SLA (routine / STAT / ER) | Escalation ladder |
|---|---|---|---|
| ordered → awaiting_collection | system on payment; cashier; IPD auto | OPD: payment within 30 min else nudge; auto-cancel 24h | — |
| awaiting_collection | phlebotomist, nurse | OPD 15 min queue / ward 60 min from round start / STAT 15 min | phleb lead → lab manager |
| collected → accessioned (transport) | runner, tech | 45 min / 15 min / 10 min | tech-in-charge → lab manager |
| accessioned → resulted | tech, analyzer (edge) | per test: CBC 60 min, LFT/RFT 120, electrolytes 45, troponin 45, HbA1c 4 h, cultures n/a, histo 3–5 working days, cyto 2 d | bench tech → tech-in-charge → pathologist |
| resulted → verified | pathologist (abnormal/critical/manual/edited), auto-verifier (normal interfaced) | abnormal < 2 h (S10), critical < 15 min | pathologist → backup pathologist on-call → medical superintendent |
| verified → published | system | immediate unless interlock | — |
| critical → acknowledged | ordering doctor / ward nurse / on-call | 15 min in-house; departed patient: §11.5 contact ladder 30 min / 2 h / 24 h | nurse → doctor → duty medical officer → medical superintendent → owner digest |

The **overall TAT clock** starts at `sample.received` (accessioning scan; locked) and stops at `result.published`; the **collection clock** (order → collected) is measured separately so lab TAT is not polluted by phlebotomy queue — but the *patient-facing* clock (order → published) is what the OPD priority re-entry loop and the patient WhatsApp promise use. Three clocks, all derived, none stored as columns.

Events emitted: `order.placed` (order_type=lab), `charge.posted`, `sample.collected`, `sample.received`, `sample.rejected`, `result.entered`, `result.verified`, `result.published`, `result.critical_flagged`, `result.acknowledged`, `report.amended`, `sample.dispatched`, `sample.external_resulted`, `order.cancelled`, `sla.breached`. **NEW:** `sample.recollection_requested` · `test.added_on` (add-on to existing sample) · `result.autoverified` (payload: rule id + version; distinct from human verify for audit and KPI) · `result.delta_flagged` · `result.rerun_requested` · `label.printed` · `tube.mismatch_flagged` · `report.print_blocked` (interlock) · `report.released_unpaid` (interlock override, approval-gated) · `result.orphaned` (analyzer result with no matching accession).
Consumed: `payment.received`, `invoice.issued`, `credit_note.issued`, `patient.merged`, `patient.discharged`, `patient.transferred`, `downtime.declared/ended`, `mode.context_applied`.

### 3.2 `lab_sample` (container lifecycle, one per tube/container) — P2 with P5 tasks

```
label_printed ─► collected ─► in_transit ─► received(accessioned) ─► aliquoted? ─► on_bench ─► analysed ─► stored ─► disposed
        └─ rejected(reason) ─► (recollection task)          received ─► dispatched(external) ─► returned|consumed
```
Rejection reasons are a closed vocabulary (haemolysed, clotted, insufficient/QNS, wrong tube/anticoagulant, unlabelled, mislabelled, leaked, delayed transport >limit, wrong temperature, lipaemic, contaminated/unsterile container, no requisition match, patient identity mismatch at accessioning). Each reason carries `attributable_to: collection|transport|lab|patient` — S10 card 17/36 split their KPIs on exactly this. Storage: serum retention 7 days at 2–8 °C (retest/add-on window), then `disposed` as BMW yellow/red stream with a `material.consumed`-shaped event to the BMW cost center (Plan 19 consumes).

### 3.3 `lab_culture` (microbiology, multi-day) — P2

```
inoculated(day0) ─► incubating ─► read_d1 ─► {no_growth_d1 → incubating → read_d2 → … → final_no_growth(d2/d5/d7 per specimen)}
                                          └─► growth_observed ─► identification ─► sensitivity_setup ─► sensitivity_read ─► verified ─► published
preliminary reports at each read (report version 1..n, "PRELIMINARY" watermark); gram stain resulted separately within 1 h for sterile-site specimens
```
Blood culture instrument positivity (BacT/ALERT) → `culture.positive_flagged` NEW → treated as **critical value** (gram stain phoned within 1 h). Antibiogram is a quarterly aggregate `antibiogram_snapshots` table (WHONET-compatible export) — first-isolate-per-patient-per-period rule applied. Events NEW: `culture.stage_advanced` · `culture.positive_flagged` · `antibiogram.finalized`.

### 3.4 `histo_case` (histopathology/cytology) — P2, working-day TAT

```
received(specimen count verified vs requisition) ─► grossed(pathologist; blocks created) ─► processing ─► embedded ─► sectioned(slides) ─► stained ─► screened ─► reported_draft ─► signed ─► published
                                       └─► special stains / IHC (send-out or in-house) ─► addendum
                                       └─► second_opinion_requested ─► external_opinion_received ─► signed
frozen_section (OT): received ─► resulted (≤20 min clock, phone + `frozen_section.resulted`) ─► permanent section follows the normal path; discordance flagged
```
Small biopsy 3 working days, large resection 5–7, IHC +3–5, cytology 2, Pap 5 (NABL 112 turnaround expectations are documented targets not statute). Blocks/slides are physical assets with barcodes: `histo_blocks`, `histo_slides`; retention slides/blocks 10 years, wet tissue 4 weeks post sign-out (recommended default aligned to NABL 112; O-9 to confirm). Events NEW: `specimen.grossed` · `block.created` · `slide.created` · `second_opinion.requested` · `second_opinion.received`.

### 3.5 `send_out` (reference lab) — P2 + chain of custody

```
dispatch_pending ─► manifested(batch, courier, temp log) ─► dispatched ─► received_by_partner(ack) ─► resulted_external ─► ingested(mapped to our test codes; PDF attached as evidence) ─► verified(pathologist reviews, signs "reported by <partner>, reviewed by") ─► published
                         └─► lost_in_transit ─► recollection (free; partner-charged per contract)
```
Own TAT per partner contract; partner-reported reference ranges are shown as the partner's, never silently remapped to ours. Partner master lives in Plan 14's vendor master (kind=`reference_lab`).

### 3.6 `critical_value_contact` — P7 notify-remind-escalate, P5 task

```
flagged ─► notifying(in-house: ward screen + app push + PBX page) ─► acknowledged_with_readback(value, name, time, read-back text) ─► closed
      └─ departed/OPD: call_task(attempt 1..n, outcome each) ─► reached(readback) | unreachable(ladder exhausted) ─► escalated_to_dmo ─► closed_with_documented_decision
```
Recorded **on the result**: who called, whom, at what time, what was read back, by whom. Critical list per test (age-specific) is master data class A (owner + MS two-key, §11.19-D #15).

### 3.7 `qc_run` and `analyzer` states — P5 over registry

Analyzer registry statuses (declared on the Plan 17 manifest): `available` · `in_use` · `qc_locked` · `calibration_due` · `maintenance` · `interface_down` · `retired`. QC: `lab_qc_runs` per (analyzer, test, level, lot) → Westgard rules evaluated (1-3s reject; 2-2s, R-4s, 4-1s, 10-x per configuration) → `qc.passed` / `qc.failed` → `qc_locked` → results for that (analyzer, test) held at `resulted` with `hold_reason=qc_lock` until `qc.passed` or `qc.override_recorded` (pathologist; report face stamped QC-SUSPECT; next-day review task). Levey-Jennings is a read model, not a table.

**P-pattern map:** order item, sample, culture, histo, send-out = P2; recollection, critical call, transport = P5; interlock = P6 overlay; TAT alerts = P7; reagent indents = P3; QC/calibration = P5 with registry status side-effects; approvals overlay on: interlock override, QC override, amendment, auto-verification rule activation, workflow activation.

**Corporate-hospital variants covered:** health-checkup package batch (one order → many items, one report bundle, staggered TAT, single publish when all verified or "partial report" at 24 h); pre-op panel from mini-OT (Plan 15) with STAT class; ICU standing orders (daily 6 a.m. panel auto-ordered from a doctor-approved protocol — deterministic automation, T3 behind the protocol's activation, not per-order); camp/outreach bulk registration with deferred publishing; corporate-tie-up billing to a company account (`payer=corporate`, interlock configured off).

---

## 4. Data model sketch

Module folder `apps/core/src/modules/lab/`. All tables carry `site_id`, `created_by/at`, `updated_by/at`; workflow state mirrors engine instances, never owned.

| Table | Key columns (sketch) |
|---|---|
| `lab_tests` (catalogue) | id, code (internal), loinc_code (nullable until licensed load), name_en, name_hi, discipline, specimen_type, container/tube_type, min_volume_ml, method, analyzer_capable (bool), result_type (numeric/text/coded/formula/free-text-report), unit, decimals, formula (expression referencing sibling codes; e.g. `ldl = tc - hdl - tg/5` with validity guards `tg<400`), reflex_rules (JSONB), critical_low/high overrides per age band, tat_minutes_routine/stat, requires_fasting, category_for_billing → tariff service id, active, version |
| `lab_panels` / `lab_panel_items` | package/profile → tests; ordering a panel expands to items at order time (snapshot, versioned) |
| `lab_reference_ranges` | test_id, sex (M/F/any/other), age_min_days, age_max_days, pregnancy_trimester?, low, high, text_range, source, effective_from, version — resolved at result time and **snapshotted onto the result row** |
| `lab_orders` | id, encounter_id, patient_id, order_source (opd/ipd/er/walkin/package/protocol), ordering_doctor_id, outside_referrer_id, priority (routine/stat/er), clinical_notes, payer_tag, interlock_state, correlation_id (instance) |
| `lab_order_items` | order_id, test_id, panel_id?, sample_id, state mirror, tariff_snapshot, charge_event_id, add_on_of_sample_id? |
| `lab_samples` | id (ULID; barcode = id), patient_id, order_id, container_type, collected_by, collected_at (occurred), recorded_at, collection_site (chair/ward/home/er), received_at, received_by, rejection_reason, attributable_to, storage_location (registry ref), disposed_at, parent_sample_id (aliquots), chain JSONB (scans) |
| `lab_results` | order_item_id, sample_id, analyzer_id?, value_numeric, value_text, value_coded, unit, flag (L/H/LL/HH/A), reference_low/high snapshot, delta_flag, delta_prev_result_id, entered_by (user\|agent), entered_at, verification_status (unverified/autoverified/verified), verified_by, verified_at, autoverify_rule_version, rerun_count, raw_analyzer_payload_ref, qc_lock_at_entry (bool), remarks, version (amendments create new rows; `superseded_by`) |
| `lab_reports` | order_id, version, pdf_ref, signed_by (+degree/registration no. block), signed_at, published_at, published_channels, print_count, print_blocked_reason, amendment_reason, prior_version_id |
| `lab_cultures`, `lab_culture_reads`, `lab_isolates`, `lab_sensitivities` | organism (SNOMED/coded), method (disk/MIC/Vitek), antibiotic, zone/MIC, interpretation (S/I/R), breakpoint_standard_version |
| `histo_cases`, `histo_specimens`, `histo_blocks`, `histo_slides`, `histo_opinions` | specimen count verified, gross description, block barcode, slide barcode, stain, storage slot, second opinion partner + result |
| `lab_send_outs`, `lab_send_out_items` | partner_id (vendor master), manifest_no, courier ref, temp log, dispatched_at, partner_ack_at, external_result_ref, partner_range_text |
| `lab_analyzers` (references `resources.kind=analyzer`) | model, serial, protocol (ASTM E1394/LIS2-A2, HL7 v2.x, CSV/none), connection (RS-232/TCP/USB), edge_agent_id, driver_version, host mapping table (analyzer test code → lab_tests.id), bidirectional (bool) |
| `lab_qc_lots`, `lab_qc_runs`, `lab_calibrations`, `lab_reagent_lots` | lot no, expiry, target mean/SD, run value, rule violations, lockout id; calibration due dates; reagent lot in-use per analyzer/test with `lot_changed_at` (results carry lot id) |
| `lab_critical_calls` | result_id, opened_at, ladder step, attempts JSONB (to, at, outcome, by), readback_text, closed_at, closed_by |
| `lab_edge_inbox` | raw message id (idempotency key), analyzer_id, received_at (edge), uploaded_at, parse_status, mapped_result_ids |
| **Statutory registers (first-class)** | `notifiable_case_register` (disease, IDSP form S/P/L, reported_to, reported_at, reference no., signatory) · `lab_incident_register` (NABL nonconformance/CAPA) · `lab_equipment_register` (NABL: calibration, maintenance, breakdown log — can be a view over registry history + calibrations) · `lab_document_control` (SOP id, version, approver, acknowledgement — candidate for the one Expertise store, deferred note 8) · `lab_eqas_register` (EQAS/PT scheme, cycle, result, performance) · `lab_amendment_register` (view over `lab_reports` versions) · `lab_report_release_register` (who collected a printed report; identity shown) |
| `lab_walkin_visits` | if encounter enum gains `lab_walkin`, this collapses into encounters — preferred |

**Registry kinds claimed (Plan 13 DD4):** `bench` (statuses: available / occupied / closed / retired; occupant = tech shift assignment) and `analyzer` (as above; occupant = run id). Collection chairs are `room`-kind children of the lab room with attribute `chair=true` (no eleventh kind). Storage racks/freezers: `device` kind (Plan 15 declares `device`; lab reuses).

**FHIR shapes (JSONB where clinical):** `ServiceRequest` (order item), `Specimen`, `Observation` (result; `referenceRange`, `interpretation`, `hasMember` for panels), `DiagnosticReport` (report version), `Device` (analyzer). ABDM care-context = DiagnosticReport per published report.

**Retention:** results/reports per §11.14 (OPD 5y, IPD 10y, MLC indefinite, legal-hold freeze); NABL: QC records, calibration, EQAS, equipment logs, document versions ≥ 5 years (recommended: 5 y; O-9); slides/blocks 10 y; raw analyzer payloads 2 y (dispute window); edge SQLite buffer purged 30 days after acknowledged upload.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion · ruling ref**. All "free" re-collections and refunds cite §11.5 / §7.

### A. Identity & wrong-patient
- **A1** Two Ram Kumars in the phlebotomy queue, same age; phlebotomist calls the token, wrong one sits → chair scan of the patient's token QR against the label batch is mandatory before the printer fires; label prints only for the scanned UHID → *test: label print API rejects when scanned UHID ≠ queue-called UHID; event `tube.mismatch_flagged`.*
- **A2** Ward nurse pre-prints labels for the whole round, sticks them at the bedside from memory → wristband scan required per collection; `sample.collected` carries `wristband_scanned=true|false`; unscanned collections route to a **mandatory accessioning identity re-check** (patient name + UHID + DOB read from the requisition) and are flagged for the collector's KPI → *test: collection without scan cannot reach `accessioned` without the re-check field set.*
- **A3** Twins (neonates, same surname, sequential UHIDs) in NICU → labels carry `Baby of <mother>` + twin ordinal + wristband colour; collection UI shows the sibling warning banner; result delta check runs against the *same* patient only → *test: NICU twin fixture — delta check never references sibling.*
- **A4** Patient merge after results exist (`patient.merged`) → results re-link to survivor with `patient.merged` in causation; delta checks recompute; prior published reports keep their original UHID on the PDF face (immutable) with a merge note in the record; unmerge splits back by sample id → *test: merge/unmerge round-trip preserves result→sample→patient chain.*
- **A5** Sample received with a label from another hospital / a handwritten label (outside collected sample brought in) → accessioning "unbarcoded intake" path: register as `external_collected`, print our label, record the presenter's declaration; report carries "sample collected outside; identity not verified by this lab" → *test: report face text present for external_collected.*
- **A6** Result on the analyzer for a sample id that does not exist (typed-in id on the analyzer keypad, one digit off) → `result.orphaned`; tech resolves by scanning the physical tube; no auto-matching by "nearest id" ever → *test: orphan cannot be linked without a physical-tube scan event.*
- **A7** Unknown/unconscious ER patient (UNK-registration, §11.4 map 8) → orders allowed; labels print with UNK id + ER band; later merge carries results → *test: UNK orders publish without demographics, merge later re-links.*
- **A8** Same patient, two open orders, two tubes — one from OPD morning, one from ward afternoon → accessioning matches tube id, never patient id; add-on request UI shows both samples with collection times → *test: add-on on the wrong (older) sample when a fresher exists produces a warning; allowed with reason.*
- **A9** Sealed/VIP patient sample → label shows alias + barcode only; analyzer host query returns alias; worklists show alias; only pathologist's verify screen with permission shows the true name → *test: sealed fixture — no true name in any lab list, print, or analyzer message.*
- **A10** Staff member gets their own test done → confidential class by default (§14); their own department cannot see it; the lab tech who *is* the patient cannot enter or verify their own result → *test: self-result entry blocked with `sod.violation_blocked`.*
- **A11** Patient gives a relative's UHID to use their membership discount → registration photo shown on the chair screen; phlebotomist confirms; mismatch → refuse + incident (insurance-identity-fraud machinery §11.14) → *test: photo displayed on collection screen when present.*

### B. Timing, concurrency, race
- **B1** Auto-verifier and pathologist act on the same result within the same second → engine single-winner transition; second actor sees "already verified by X" → *test: concurrent verify → exactly one `result.verified`/`result.autoverified`.*
- **B2** Analyzer sends result twice (retransmit after ACK lost) → idempotent by (analyzer, message id, sample id, test code, run timestamp); duplicate dropped, logged → *test: replay fixture yields one result row.*
- **B3** Rerun result arrives after the first was already verified and published → new result row `rerun_count=2`, prior stays; pathologist must choose "amend" (versioned report) or "discard rerun" — never silent replace → *test: post-publish rerun cannot mutate the published value.*
- **B4** Add-on test requested 3 days after collection, serum discarded yesterday → add-on rejected with "sample disposed at HH:MM"; opens a re-collection task, billed as new (patient informed) → *test: add-on on disposed sample refuses and creates task.*
- **B5** Payment received while sample already collected (IPD converted to self-pay mid-stay, `payer.switched`) → interlock re-evaluates on `payer.switched`; report holds if new payer's rule says so → *test: payer switch flips interlock state and emits `report.print_blocked`.*
- **B6** Order cancelled by doctor after the tube is on the analyzer → cancellation lands as `cancelled_after_analysis`; result stored but not published; charge stays if analysed (policy) → **O-4**; *test: state machine refuses `cancelled` from `in_analysis` without the reason code.*
- **B7** Clock drift on the mini-PC (BIOS battery) → edge stamps both `device_time` and `edge_received_at`; core uses its own receive time for TAT and flags `clock.drift_flagged` when |drift| > 2 min → *test: drift fixture.*
- **B8** Midnight rollover / IST vs UTC on reference-range age computation (patient turns 1 day older into a new band) → age computed at *collection* time in IST, snapshotted → *test: boundary fixtures at 00:00 IST.*
- **B9** Culture day-2 read entered before day-1 read saved by another tech (out of order) → stage transitions are ordered; out-of-order read stored with `late_entry.flagged` and displayed chronologically by `occurred_at` → *test: ordering invariant.*
- **B10** STAT sample lands behind a 40-tube routine batch on a single analyzer → STAT priority on the analyzer worklist (bidirectional) or a "STAT rack" manual instruction task on the bench screen; TAT clock unchanged → *test: STAT item visible at top of bench worklist.*

### C. Partial failure & downtime
- **C1** Core VM down; analyzers keep running → edge buffers to SQLite; on restore, uploads in order; results carry `occurred_at` = analyzer time, `recorded_at` = upload → *test: 6-hour buffer replay → all results, correct times, no duplicates.*
- **C2** Edge mini-PC dies (power supply) → analyzer prints/stores results internally; techs enter manually from the analyzer printout with `entry_mode=manual_from_printout`; when the edge returns and re-sends, the duplicate detection matches on sample+test+value±tolerance and *links* instead of duplicating; mismatch → tech reconciliation task → *test: manual+interface merge fixture.*
- **C3** Label printer offline at the chair → fall back to any printer in the room (Plan 13 registry device) or the sealed downtime kit's pre-printed serial labels (§11.4 map 1) mapped at accessioning → *test: downtime-label mapping produces a valid sample row with `label_source=downtime_kit`.*
- **C4** Downtime declared mid-verification → paper worksheet from the kit; results backfilled with `occurred_at` per worksheet; verification signatures on paper scanned as evidence; report PDF regenerated with "backfilled" footnote → *test: backfill path events carry both timestamps and the downtime window id.*
- **C5** WhatsApp gateway down at publish → publish state reached; notification ladder (Plan 10) handles fallback; report visible on doctor screen regardless → *test: `result.published` independent of `notification.sent`.*
- **C6** Internet down, reference lab portal unreachable → dispatch proceeds on paper manifest (printed from local core); external results entered manually when available → *test: send-out states do not require partner API.*
- **C7** Postgres failover mid-accession batch → idempotent accession (sample id is the key); retry safe → *test: replay accession batch.*
- **C8** Power loss to the histology processor overnight → tissue processing cycle interrupted; instrument log captured; case flagged `processing_incident` with CAPA entry; report footnote if quality affected → *test: incident register row auto-created from device event when interfaced, else manual.*
- **C9** Edge agent bug corrupts mapping (analyzer code "GLU" mapped to HbA1c) → mapping changes are Class B config with two-person activation and a *result sanity envelope* per test (value outside physiologically possible range → hold, never publish) → *test: implausible-range fixture holds.*

### D. Money
- **D1** OPD patient pays for 5 tests, doctor adds 2 more at the chair → add-on creates new order items on the same order; payment collected before publish of those two; the paid five publish independently → *test: partial interlock per item, not per order.*
- **D2** Unpaid OPD report; patient at counter says "I'll pay later" → report **print/WhatsApp blocked** (locked); doctor screen still shows results (clinical safety is not the interlock's business); override = approval-gated `report.released_unpaid` with reason code + dues entry (legacy dues concept — roadmap open ruling) → **O-1**.
- **D3** ER patient, unpaid, critical result → interlock **never** applies to ER/IPD accrual sources; critical publish + call happen regardless of payer state → *test: ER order publishes with zero payment.*
- **D4** Refund requested after result saved → legacy rule "no pathology refund once the result is saved" (roadmap harvest) → refuse; exception path = credit note with approval + reason (e.g., lab error) → *test: refund API refuses `resulted+` items without approval.*
- **D5** Sample rejected (haemolysed) → re-collection free (§11.5); no second charge; if patient does not return within 7 days → item `cancelled_no_recollection`; refund per O-4 default = refund the test (no result produced) → *test: rejected→recollected posts zero additional charge.*
- **D6** Reflex test auto-added (TSH abnormal → FT4) → charge posts with `reflex_rule_id`; consent shown at order time (locked); OPD interlock applies to the reflex item only → *test: reflex charge carries rule id; order-time consent flag stored.*
- **D7** Package (checkup) with 40 tests; 2 tests fail QC and are re-run tomorrow → package report publishes as partial with pending list; no extra charge → *test: package report v1 partial, v2 complete.*
- **D8** TPA patient: non-covered test ordered → payer rule marks item `self_pay` within a TPA episode; patient informed at order; cash-law aggregation (269ST) counts it → *test: mixed-payer order produces two charge streams.*
- **D9** Outside-Rx walk-in with referrer "Dr. X" (external RMP) → attribution captured, payout **structurally off** (§11.19-C #1) → *test: referrer class (c) produces no accrual.*
- **D10** Doctor fee-split on lab? → not applicable; consultant attribution kept for reporting only → *test: no `commission.accrued` from lab-only events unless referrer class (a)/(b).*
- **D11** Same test ordered twice same day by two doctors (duplicate order) → duplicate warning at order time with the existing result/pending status; if proceeded, second order flagged `duplicate_reason`; billing posts once unless reason = "repeat clinically required" → *test: duplicate detector window per test (default 24 h; troponin 6 h) fixture.*
- **D12** Analyzer usage events vs billed tests mismatch (100 CBC runs, 92 billed) → §11.19-C #13 reconciliation report; unbilled runs → leakage tasks; controls/calibrators/reruns excluded → *test: reconciliation excludes QC runs.*
- **D13** Reagent-rental contract counts tests per month → export of run counts by analyzer/test to the vendor with QC runs marked → **O-7** (rental vs purchase).
- **D14** Corporate camp: 300 patients, bill to company → `payer=corporate`, interlock off, single consolidated invoice from billing; results publish individually → *test: corporate order publishes without payment events.*
- **D15** GST: diagnostic services exempt; but a printed report re-issue fee or courier charge is taxable → tariff service category handles; lab never computes tax → *test: re-print line carries tariff GST class.*

### E. Consent, legal, MLC, minors, unconscious
- **E1** HIV test ordered → NACO: pre-test counselling and informed consent required; order screen requires `consent.recorded` (ICTC form) before collection; result visible only to ordering doctor + pathologist; no WhatsApp publishing; patient collects in person → *test: HIV item cannot reach `awaiting_collection` without consent event; publish channel forced to `in_person`.*
- **E2** MLC case (poisoning, assault) sample → chain-of-custody form; every scan records handler; sample retained as evidence (not disposed at 7 d); report release only via MRD release discipline (§11.14 single-spokesperson) → *test: MLC flag disables auto-dispose and external publish.*
- **E3** Alcohol level for police request → same as E2; requisition from police recorded; consent or magistrate order reference field → *test: police-request items require `legal_basis` field.*
- **E4** Minor (under 18) → guardian consent for invasive collection (biopsy) recorded; results to guardian; adolescent sensitive tests (pregnancy, STI) — corporate default: release to guardian per law but flag for doctor counselling first → **O-5** for the adolescent-confidentiality default.
- **E5** Unconscious ICU patient, HIV/HBsAg for exposure of a staff member (needle-stick, §11.14) → source testing under the exposure protocol with the consent rule the protocol defines; result routed to staff health, not the ward → *test: exposure-protocol order type routes results to occupational-health role only.*
- **E6** PCPNDT-adjacent: a lab test is never sex-determination, but a molecular request for foetal sex (NIPT with sex) → **blocked** at catalogue level (test code cannot exist with `reports_foetal_sex=true`); NIPT panels configured without sex reporting → *test: catalogue validation rejects such a test.*
- **E7** DPDP data-principal request to erase lab results → refused where medical-record retention law applies; response records why (§11.14); legal-hold freezes → *test: `dsr.requested` on lab data produces the retention explanation.*
- **E8** Patient asks for report to be sent to a different phone number than registered → verified change via registration (OTP) only; the lab desk cannot free-type a number → *test: publish target is `patients.contact`, not an order field.*
- **E9** Genetic test results → sensitive class; counselling flag; storage under sealed-class rules → *test: genetic discipline tests default to `sealed_class=true`.*
- **E10** Death after a critical value was not acted on → audit shows call ladder, attempts, timestamps; medico-legal pack export contains the full `lab_critical_calls` trail → *test: MLC export includes critical-call rows.*

### F. Staff absence, overload, handover
- **F1** Single pathologist unreachable at 2 a.m., critical potassium 6.8 on a ward patient → critical call ladder goes to the **ordering doctor/on-call RMO first**, not the pathologist; result publishes unverified? Recommended default: critical values from an interfaced, QC-passing analyzer publish to the clinician immediately as `preliminary — technologist-released, pathologist verification pending`; the call is made by the tech → **O-2**.
- **F2** Night tech alone, must enter and verify manual results → `single_operator_night_mode` per roster: tech-verified with a `pathologist_review_pending` flag; morning review queue; the mode is evented and appears in the digest → *test: night-mode verify carries the flag; morning queue lists it.*
- **F3** Phlebotomist no-show, 60 patients in queue at 8 a.m. → queue SLA breach → nurse pool pulled (competency-gated per S10 witness/bundling rules); Coverage Resolver proposes → *test: `overload.flagged` on queue depth > threshold.*
- **F4** Shift handover with 12 pending verifications and 3 open critical calls → handover screen lists open instances by state; incoming tech accepts (P5 `task.accepted` per open item) → *test: unaccepted handover items escalate at +30 min.*
- **F5** Microbiologist not hired yet → culture verification definition routes to pathologist; if neither, send-out path for cultures → *test: role-absent routing fixture.*
- **F6** Pathologist on leave for 10 days → histo TAT expected to breach → planned-leave cascade (§11.5 doctor leave) applied to lab: pre-announce longer TAT on order screen; second-opinion partner default → *test: leave window extends histo SLA and shows on order.*

### G. Equipment failure
- **G1** Haematology analyzer down Monday 9 a.m. → analyzer `maintenance`; items on that bench re-route to backup analyzer (if any) or send-out; TAT promise on OPD screen updates; patients notified of delay via WhatsApp (transactional) → *test: re-route creates new worklist entries without re-collection.*
- **G2** QC fails on level 2 only (2-2s) → lockout for that test on that analyzer; other tests continue → *test: lockout scope is (analyzer, test).*
- **G3** Pathologist overrides QC lockout at 11 p.m. to release an ER troponin → `qc.override_recorded`; report stamped QC-SUSPECT; next-day review task assigned to quality manager → *test: override visible on PDF face.*
- **G4** Reagent lot changed mid-run → `reagent_lot.changed` NEW; results after the change carry new lot id; a lot change without a QC run since = auto-lockout → *test: lot change forces QC before release.*
- **G5** Calibration overdue → `calibration_due` status → warning at 7 days, lockout at due date (configurable, NABL requires per manufacturer schedule) → *test: results held at due+1.*
- **G6** Centrifuge failure → samples clot/haemolyse waiting; rejection reason `delayed_processing`, attributable_to lab → *test: attribution not on collector.*
- **G7** Fridge temperature excursion (reagent storage 2–8 °C breached to 14 °C for 3 h) → temperature log device (or manual twice-daily log) → excursion event → reagents in that fridge flagged `suspect`; QC required before next use; NABL asks for exactly this log → *test: excursion creates CAPA + QC-required flags.*
- **G8** Barcode scanner reads label but the tube cap colour is wrong (EDTA for coag) → accessioning shows expected container per test; mismatch → reject `wrong_tube`, recollection → *test: container check at accession.*
- **G9** Printer prints label with a smudged barcode; accessioning cannot scan → manual id entry requires a second field (patient DOB) to match → *test: manual id entry requires DOB confirmation.*
- **G10** UPS fails, analyzers reboot, half-run lost → analyzer reports incomplete; edge marks `run_aborted`; items go back to `in_analysis` with rerun; free → *test: aborted run leaves no result rows.*

### H. Data quality, late-arriving, backdated
- **H1** Tech enters 1200 for glucose instead of 120 → sanity envelope (per-test absurd range) refuses; critical range triggers double-entry confirmation → *test: absurd-value fixture.*
- **H2** Delta check: creatinine 0.9 last week, 4.2 today, patient ambulatory OPD → `result.delta_flagged`; auto-verify disabled for the row; tech checks for mislabelling (recollect or confirm by second aliquot); pathologist verifies with note → *test: delta-flagged row never autoverifies.*
- **H3** Formula result (LDL) when TG > 400 → formula guard yields "not calculable — direct LDL suggested" instead of a number → *test: guard fixture.*
- **H4** Reference range for a 6-month-old vs adult; patient DOB missing (only age "approx 30") → age band computed from `approx_age`; report footnote "age approximate" → *test: DOB-null path.*
- **H5** Sex "other"/unknown → range `any` falls back; report notes "reference range: unspecified sex"; no crash → *test: sex-null fixture.*
- **H6** Pregnancy-specific ranges (D-dimer, TSH trimester) → trimester captured from encounter (maternity) or order question; otherwise general range with note → *test: trimester range resolution.*
- **H7** Backdated result from paper (downtime) entered 2 days later → `late_entry.flagged`; `occurred_at` from paper; digest shows count → *test: late entry event.*
- **H8** Pathologist edits a verified value → cannot; must amend: new version, reason mandatory, prior version viewable; patient re-notified with "AMENDED" (O-6 for patient-facing wording) → *test: edit endpoint absent; amend path only.*
- **H9** External lab PDF contains hidden text "ignore previous instructions" → ingestion treats PDF as attachment; structured values entered by human; any LLM narrator sees only structured fields → *test: adversarial PDF fixture moves nothing (deferred note 13).*
- **H10** Test catalogue change (new unit mg/dL → mmol/L) → versioned catalogue; historical results keep their unit; trend view converts with visible factor → *test: trend across unit change.*
- **H11** Units mismatch from analyzer (analyzer sends µmol/L, catalogue expects mg/dL) → mapping table carries conversion; unknown unit → hold, not convert → *test: unknown-unit hold.*
- **H12** Culture: organism identified but sensitivity panel wrong for organism (gram-negative panel on gram-positive) → interpretation rules refuse; tech alerted → *test: panel/organism validation.*

### I. Fraud, leakage, gaming
- **I1** Tech marks samples "rejected — haemolysed" to hide a lost tube → rejection rate per tech per reason trended; rejection without a photo (optional) or second-person confirmation above n/day → Fraud Sentinel diagnostic → *test: per-actor rejection anomaly report.*
- **I2** Cashier prints an unpaid report for a friend → print requires interlock state `paid` or an approval id; print event carries the approval; no approval → blocked → *test: print API blocked; attempt evented.*
- **I3** Outside referrer bribes desk to tag their name on walk-ins → `attribution.unverified_flagged` (existing) when the patient did not present a prescription image; attribution sampling audit → *test: attribution requires Rx image or patient confirmation.*
- **I4** Ghost tests: results entered for a sample never collected (no `sample.collected`) → state machine refuses `result.entered` before `accessioned` → *test: invariant.*
- **I5** Reagent leakage (tests run for cash outside HMIS) → analyzer run count vs HMIS orders reconciliation (D12) → weekly variance to owner digest → *test: variance report row.*
- **I6** Auto-verification rule loosened by a tech to skip pathologist → rule set is Class A config (owner + MS two-key); every rule version stamped on every autoverified result → *test: rule change requires two approvals.*
- **I7** TAT gaming: tech accessions at the last minute so the clock starts late → collection→accession lag KPI per tech; clustering anomaly to Fraud Sentinel → *test: lag distribution report.*
- **I8** Result copy-paste from the previous day for a stable ICU patient → identical-value-run detector (n consecutive identical to 2 decimals across ≥3 analytes) → review flag → *test: identical-run fixture.*
- **I9** Free re-collection abused (patient demands re-test claiming rejection) → re-collection only from `sample.rejected` by lab; patient-requested repeats are new paid orders → *test: no free path without rejection event.*

### J. Privacy, sealed records, VIP, staff-as-patient
- **J1** Public TV in the lab waiting area shows "your report is ready" → tokens only, never names (§11.5) → *test: display payload has no name.*
- **J2** Report collection counter: someone else collects a printed report → identity check (any photo ID or the QR on the receipt) recorded in `lab_report_release_register` → *test: print release requires collector identity field.*
- **J3** WhatsApp report goes to a shared family phone; patient is an adult woman with a pregnancy test → patient-level preference "sensitive results in person only" default for configured sensitive tests (pregnancy, HIV, STI, genetic) → *test: sensitive tests never auto-publish to WhatsApp.*
- **J4** VIP flagged: analyzer host query broadcasts demographics over ASTM → edge sends alias only; analyzer never receives true name → *test: ASTM message fixture for sealed patient.*
- **J5** Lab Ops Copilot asked "show me Dr. Y's own reports" → permission-filtered; sealed class not visible; four-state render "not visible to your role" → *test: sealed fixture in copilot tool.*
- **J6** Bulk export for NABL audit → de-identified sample of records; auditor sees UHIDs only with access logged → *test: audit export logs `document.release_logged`.*

### K. Language, literacy, accessibility
- **K1** Bhojpuri-only patient at the chair → chair screen shows pictogram instructions (fasting, tube count) + Hindi audio prompt; consent for HIV via counsellor in person → *test: collection screen renders Hindi/pictogram mode.*
- **K2** Report PDF language → patient's language preference (§6): Hindi test names alongside English codes; numeric values unchanged; abnormal highlighted; QR on every page → *test: Hindi render snapshot.*
- **K3** Illiterate patient, WhatsApp PDF is useless → notification ladder adds IVR "your report is ready, collect at counter / doctor will explain" → *test: preference `voice` chooses IVR.*
- **K4** Visually impaired patient → report available as large-print and as accessible PDF (tagged) → *test: PDF/UA tags present.*
- **K5** Doctor writes "Sugar F & PP" free text → order search maps synonyms (FBS/PPBS) with LOINC; unknown → free-text order routed to lab desk for coding, never dropped → *test: synonym fixture.*

### L. Scale (100/day → 2,000/day)
- **L1** 2,000 OPD/day ≈ 900 lab orders ≈ 2,500 tubes/day; accessioning must be scan-only, sub-second → perf budget: accession API < 100 ms p95; label print < 1 s → *test: load fixture 3,000 samples/hour.*
- **L2** Worklist screens over 5,000 open items → server-side paging by state, bench, priority; no full-table renders → *test: p95 < 300 ms at 50k rows.*
- **L3** Edge agent per analyzer bank (not per analyzer) → one mini-PC handles ≤ 6 serial devices; separate process per driver → *test: driver crash isolation (kill one → others continue).*
- **L4** Multiple collection sites (OPD floor, ER, wards, home) → `collection_site` from registry; queue per site; one accession point per site or central → *test: site-scoped queue.*
- **L5** Reference range table lookups at 20k results/day → cached catalogue version; snapshot on result → *test: no per-result table scan.*
- **L6** Notifications: 900 report-ready messages/day → batching within quiet hours (§11.13) → *test: batch respects quiet hours except criticals.*

### M. Integration failures (device / vendor / ABDM)
- **M1** ASTM checksum errors from a noisy RS-232 cable → NAK + retry 3; then `interface.down`; tech alerted; manual entry allowed → *test: checksum fixture.*
- **M2** Analyzer firmware update changes test codes → unmapped code → `result.orphaned` with `reason=unmapped_code`; mapping task; no silent drop → *test: unmapped fixture.*
- **M3** HL7 ORU from immunoassay carries a result for a test not ordered (analyzer ran a default panel) → stored as `unsolicited`, not published, not billed; tech decides; leakage report → *test: unsolicited result never posts a charge.*
- **M4** Bidirectional host query: analyzer asks for orders for tube 123, core is down → edge answers from its SQLite order cache (synced every minute); stale cache flagged → *test: cache-served query logged.*
- **M5** Reference lab returns results under a different patient name spelling → ingestion matches on our sample id printed on the manifest, never on name → *test: name mismatch does not block; id mismatch does.*
- **M6** ABDM care-context push for DiagnosticReport fails → retry queue; publish unaffected; sealed class suppresses link (§11.19-E #30) → *test: ABDM failure independent.*
- **M7** WHONET/antibiogram export format change → export is versioned; failure does not touch data → *test: export version fixture.*
- **M8** IDSP portal (IHIP) unreachable → reporting task stays open with deadline; paper S-form printed; `notifiable.reported` recorded with `channel=paper` → *test: paper channel path.*
- **M9** Home-collection app (doc 03) hands over a tube without a matching order (order cancelled while rider en route) → lab door scan shows "no active order"; sample quarantined; task to reconcile → *test: quarantine state.*
- **M10** Vendor remote-support requests a TeamViewer session on the mini-PC → edge host has no core credentials, only the upload token scoped to that edge id; token revocable per edge → *test: edge token cannot read patients API.*

### N. Discipline-specific (micro / histo / molecular / POCT)
- **N1** Blood culture flags positive at 3 a.m. → `culture.positive_flagged` treated as critical; gram stain within 1 h; call ladder → *test: positivity opens critical call.*
- **N2** Contaminant (CoNS in 1 of 2 sets) → report comment template "probable contaminant"; not counted in antibiogram → *test: contaminant flag excludes from aggregate.*
- **N3** Histo specimen count mismatch (requisition says 3 containers, 2 received) → cannot accession; call OT/ward; incident → *test: count mismatch blocks.*
- **N4** Lost block/slide → incident register; report note; no re-cut possible → *test: slide status `lost`.*
- **N5** Frozen section discordant with permanent → discordance event, surgeon notified, QA register → *test: discordance flagged when final diagnosis category differs.*
- **N6** Second opinion abroad/outside (send slides) → `second_opinion.requested`; slide chain; return tracking; opinion attached; final report cites → *test: slide out/in scans.*
- **N7** PCR run with failed internal control → whole run invalid; results held; rerun free → *test: run-level QC lock.*
- **N8** POCT glucometer on the ward, no interface → results entered by nurse in eMAR/vitals (not lab) but the device sits in the lab's analyzer registry for QC; lab QC lockout blocks the device's use flag → *test: POCT device QC status readable by nursing.*
- **N9** TB (CBNAAT) positive → notifiable (Nikshay) → register + task; and also a critical? Corporate default: notifiable, not phone-critical → *test: Nikshay task created.*
- **N10** Dengue NS1 positive during outbreak → IDSP weekly + immediate reporting rules; dashboard for the district → *test: outbreak-mode aggregation.*

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 8:40, haematology analyzer dead, 140 CBCs queued.** 08:40 tech marks analyzer `maintenance` (registry status change, evented). System: worklist items on that analyzer re-route to the backup 3-part analyzer if configured, else to `send_out_pending`; TAT promise on OPD queue screens updates from 60 → 180 min; Plan 10 sends one transactional WhatsApp per affected OPD patient ("CBC delayed; expected by 12:30"). Humans: tech-in-charge calls the vendor engineer (AMC contract in Expiry Watchman's registry); lab manager decides send-out for 60 samples to the partner lab — dispatch manifest printed, courier logged. Agents: TAT Chaser nudges only once per breach cluster (cluster suppression rule, not 140 pings). Paper path: none needed. Backfill: partner results ingested by sample id; reports state "reported by partner"; charges unchanged. Audit: registry history shows downtime window; `sla.breached` rows carry cause=`analyzer_down`; digest shows 140 breaches attributed to equipment, not staff (load-normalised KPI reading).

**6.2 Server down 14:00–16:30 mid-shift.** 14:02 duty manager declares downtime (two-person). Lab: edge agents buffer analyzer output in SQLite; chair-side printers cannot print labels → sealed kit's pre-numbered labels (range LAB-DT-0001…) used with the paper requisition; accessioning on paper worksheet with time. Verification: pathologist signs paper worksheets for criticals; critical calls made by phone (PBX) and logged on the kit's critical-call sheet. 16:30 restore: edge uploads 2.5 h of results (`occurred_at` from analyzer); techs map DT labels to orders (scan DT label → pick order → system mints the sample row with `label_source=downtime_kit`); paper results typed with `late_entry.flagged`; paper sheets scanned as attachments. Reports regenerate with the backfill footnote; WhatsApp releases as interlock permits. Audit: `downtime.declared/ended` bracket every late entry; digest shows the window and count; Workflow Tuner excludes the window from baselines.

**6.3 2:07 a.m. potassium 7.1, ward 3, ordering doctor's phone off.** Interfaced analyzer, QC passed at 22:00. Auto-verify refuses (critical). Night tech sees the critical banner; system opens `critical_value_contact`; push + PBX page to ward 3 nurse station (step 1). Nurse acknowledges on the tablet with read-back "potassium seven point one" typed. Ladder step 2: ordering doctor — no answer in 10 min logged; step 3: on-call RMO reached at 02:21, read-back recorded; step 4 (DMO) not needed. Pathologist not woken (O-2 default: tech-released preliminary critical with morning verification). 08:10 pathologist verifies; result already acted on (calcium gluconate given, logged in eMAR when IPD ships). Audit: complete ladder with attempts; KPI "critical comms documented" = 100%; doctor's phone-off is a roster/coverage finding, not a lab finding.

**6.4 Mass casualty (bus accident), 35 patients, 22:15.** `disaster.declared` → lab mode context: all ER orders STAT; grouping/crossmatch demand spikes (blood bank's problem, but samples come through phlebotomy); UNK registrations with ER bands; labels print from ER band scan. System suspends non-critical alerts (mode gate), keeps criticals; OPD interlock irrelevant. Humans: second tech called in (Coverage Resolver proposal → duty manager approves); phlebotomy moves to ER bays. Agents: nothing acts autonomously; TAT Chaser silent in disaster mode except criticals. Paper: ER downtime forms for identity if needed. Reconciliation next day: UNK → identified merges re-link results; billing per disaster policy (charity/goverment head as logged decision). Audit: every result tagged with the disaster window; equity report.

**6.5 Mislabelled twins + a VIP + a fraud attempt in the same hour.** 11:00 NICU nurse sticks twin B's label on twin A's capillary tube (no scan; night habit). Accessioning re-check passes (both "Baby of Sunita"). Result: twin A's bilirubin 18 reported under twin B → delta check against twin B's yesterday value (9) flags a jump; tech calls NICU; recollection both; incident. Fix in this document: A2/A3 rules (wristband scan mandatory, twin banner). 11:20 VIP politician's HbA1c: alias on all surfaces; a tech tries the copilot "show the MLA's sugar" → not visible; attempt logged. 11:40 a walk-in with a photocopied Rx claiming referrer "Dr. Z" for commission → attribution unverified; Rx image required; the desk cannot add referrer without it. Audit: three incidents, three registers, one digest section.

**6.6 QC fails at 07:00 on the chemistry analyzer, OPD rush at 09:00, ER troponin at 09:15.** Level 1 and 2 both out (2-2s). Lockout for all chemistry on that analyzer. Tech recalibrates, reruns QC — passes at 08:20; 40 held results release automatically (they were `resulted` with hold). 09:15 ER troponin on the immunoassay analyzer — separate analyzer, unaffected. Had it been locked: pathologist override → QC-SUSPECT on the face, next-day review. Audit: `qc.failed` → `qc.passed` bracket; held results show hold duration; Levey-Jennings shows the shift; CAPA opened by QC Watchman as a task, not an alert.

**6.7 Reference-lab courier loses a box of 30 samples (histo included).** Manifest shows contents; partner never acks. 48 h: `send_out.lost` NEW; each item → recollection task (free), histo cases → irreplaceable: incident, clinician informed, patient counselled, re-biopsy decision clinical. Money: partner contract penalty tracked by procurement. Audit: manifest chain scans end at courier pickup; courier accountability documented.

**6.8 Ransomware/cyber incident isolates the core; lab must run 3 days.** Security-incident declaration (§11.14; CERT-In 6 h). Lab runs A1 (paper registers + analyzer printouts); edge agents keep buffering but the upload token is revoked during isolation (edge cannot be the re-infection path — edge → core is one-way HTTP with a scoped token; core never connects to edge). Restore from immutable backup; three days of backfill via the downtime path; the digest carries the window. Lesson for design: the SQLite buffer must hold ≥ 7 days of results at 2,000/day scale (sized in §12).

---

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | System object | Who signs | Retention |
|---|---|---|---|---|
| Lab registration | Clinical Establishments Act (state rules), Shops & Establishments | config: registration no., validity → Expiry Watchman | owner | — |
| NABL ISO 15189:2022 accreditation (NABL 112 checklist) | quality manual, SOP document control, equipment register, calibration & maintenance logs, IQC/EQAS records, staff competency, TAT monitoring, nonconformance/CAPA, sample retention policy, uncertainty of measurement, report format (signatory, degree, registration) | `lab_document_control`, `lab_equipment_register` (view), `lab_qc_runs`, `lab_calibrations`, `lab_eqas_register`, `lab_incident_register`, staff competency in HR SaaS linked by id | quality manager + technical manager (pathologist) | ≥ 5 y records; slides/blocks 10 y |
| Report signatory rules | NABL + MCI/NMC: reports signed by a registered pathologist (MD/DCP/DNB); tech may not sign; degree and registration number on the face | `lab_reports.signed_by` + credential block from user admin (credential expiry → Expiry Watchman) | pathologist | with report |
| Notifiable diseases | IDSP/IHIP (weekly S/P/L forms; immediate for outbreak-prone), Nikshay (TB), NACO (HIV — aggregate, confidential), state notifications (dengue, malaria) | `notifiable_case_register` + reporting task with deadline | microbiologist/pathologist; hospital IDSP nodal officer | permanent |
| HIV testing | NACO guidelines: consent, counselling, confidentiality, no name on external documents | consent event, sealed publishing rules | counsellor + patient | per NACO |
| MLC samples | CrPC/BNSS chain of custody | chain scans, evidence retention | handler at each scan | indefinite |
| BMW | BMW Rules 2016 (yellow: pathological waste, red: tubes/plastics, sharps white, blue glass) | disposal events to BMW cost center (Plan 19 consumes) | — | per rules (1 y records) |
| DPDP Act 2023 | consent for messaging (transactional ok), sensitive data class for health; data-principal rights; breach notice | data classes: **Class 1 — sensitive health data** (all results), **Class 1S — sealed** (HIV, genetic, VIP, staff, MLC), Class 2 — operational (TAT, QC, no identity) | DPO | per §11.14 |
| PCPNDT | no lab test may report foetal sex; catalogue validation | — | — | — |
| Radiation / AERB | not applicable to lab (Plan 18) | | | |
| Drugs & Cosmetics Act | in-vitro diagnostic reagents licensing (Medical Device Rules 2017 class of IVDs) — vendor's license captured in Plan 14 vendor master | | | |
| Ethics / research use of leftover samples | ICMR guidelines — out of scope; flag as absent | | | |
| GST | diagnostic services exempt; ancillary taxable — tariff engine | | | |
| Patient rights charter (NABH) | report TAT displayed, cost displayed, right to a copy of the report | displayed on order screen and receipt | | |

**What NABH/NABL asks to see (walk-in demand list):** TAT compliance by test for the last quarter (read model over instances); critical-value communication log with read-back (table); IQC charts per analyzer per test with Westgard violations and corrective action (Levey-Jennings read model + CAPA rows); EQAS participation certificates and performance; calibration records per analyzer with traceability; reagent lot logs with expiry; temperature logs (fridges, incubators, room); sample rejection log with reasons and trend; amended-report register with reasons; equipment breakdown log; SOP versions with staff acknowledgement (`sop.acknowledged`); staff competency assessment; internal audit + management review minutes (`committee.minuted`); patient complaint register; BMW records; report format sample with signatory credentials. Every one of these must be a *query*, never a compiled document.

**Consent forms (as templates in the Plan 10/document registry):** HIV pre-test; biopsy/FNAC procedural consent; genetic testing; research/leftover (out of scope); MLC sample handover; report-collection authorisation for third parties.

---

## 8. Staff KPI & KRA

Formulas are event-derived; all rates reported with load context; none auto-punitive (S10 §2). Target home: KPI formula registry (deferred note 5).

**Lab Technician (card 17)**
1. `tat_compliance[test_category]` = count(published_at − received_at ≤ SLA) / count(items) per bench per shift; load = items/bench-hour; diagnostic reading: low with high load → staffing; low with low load → process.
2. `lab_attributable_rejection_rate` = rejected(attributable_to=lab) / accessioned; separated from collection.
3. `qc_lockout_honoured` = 1 − results released under `qc.override_recorded` by request of this tech / results in locked windows (expect ~100%).
4. `manual_entry_error_rate` = amendments whose prior row was manually entered by tech / manual entries.
5. `accession_lag` = median(received_at − collected_at) for samples this tech accessioned; gaming: clustering anomaly.
6. `rerun_rate` = reruns / runs (equipment vs technique diagnostic).
7. `recollection_closure` = re-collections completed ≤ 24 h / rejections.
KRA: pipeline integrity — right sample, right process, QC honoured, on time. Gaming resisted by: attribution split, lag distribution, identical-run detector.

**Phlebotomist (card 36)**
1. `collection_attributable_rejection_rate` (< 1%) by reason. 2. `draws_per_hour` with queue depth shown. 3. `wristband_scan_rate` (target 100%; each unscanned collection is visible). 4. `label_print_to_collect_seconds` (label printed long before the draw = pre-printing habit). 5. `ward_round_on_time` = rounds started ≤ 15 min of schedule. 6. `stat_collection_tat` = median(collected − ordered) for STAT. Gaming: scan-time clustering (scanning wristbands at the station later) flagged by scan-location (tablet GPS/room beacon) mismatch.

**Pathologist (card 16)**
1. `abnormal_verification_tat` (< 2 h). 2. `critical_verification_tat` (< 15 min in hours; night per O-2). 3. `amended_report_rate` (diagnostic: quality vs volume). 4. `frozen_section_tat_compliance` (100%). 5. `histo_tat_working_days` by specimen class. 6. `qc_override_count` (expected near zero; each reviewed). 7. `autoverify_share` (higher is good if amendment rate stays flat — measures rule quality, not the person). 8. `second_opinion_rate`. KRA: nothing abnormal leaves unverified; intra-op answers in surgical time; the release decision is documented. Gaming: verifying in bulk without viewing → time-in-view before verify (automation-bias instrumentation §11.19-D #36).

**Microbiologist (NEW)**
1. `culture_prelim_report_within_24h`. 2. `blood_culture_positive_to_gram_call_minutes` (< 60). 3. `final_report_tat` by specimen. 4. `antibiogram_published_quarterly` (binary). 5. `notifiable_reporting_within_deadline`. 6. `contamination_rate` (blood culture; diagnostic on collection technique, routed to phlebotomy).

**Lab manager / quality manager (NEW)**
1. `qc_runs_scheduled_vs_done`. 2. `eqas_cycles_on_time` and performance. 3. `calibration_overdue_days_sum`. 4. `capa_closure_within_30d`. 5. `sop_acknowledgement_rate`. 6. `document_versions_current` (no expired SOPs). 7. `overall_lab_tat_p90` by category with load. 8. `reagent_stockout_events`. KRA: NABL-ready every day.

**Lab receptionist**: `walkin_registration_seconds`, `report_release_identity_compliance`, `unpaid_release_overrides_requested`, `send_out_manifest_completeness`.

**Owner's 8 a.m. digest — lab section:** orders yesterday by source; TAT p90 per category vs SLA with breach count and top cause (equipment/staff/volume); critical values: count, all closed?, longest ladder; QC lockouts and overrides (names); rejections by attribution; unpaid reports held (count, ₹); send-outs open > contract TAT; reagent below par; analyzer run-vs-billed variance; notifiable reports due today; amendments issued; downtime windows; late entries.

---

## 9. AI agents & the copilot — where inference earns its place

Rule applied throughout: a deterministic automation wins whenever a rule is safer (§16). Inference earns its place only in narrative drafting and low-frequency conversational asks.

| Candidate | Auto/Agent | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval/guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Lab Edge Agent | automation (edge) | T3 | analyzer message | `result.entered` unverified | verification tier | manual entry from printout | per edge id | message hash, driver version | replay fixtures, checksum, unmapped-code | Class 1 (in-hospital only) | 17 T-edge, per analyzer |
| Auto-Verifier | automation | T3 (behind Class A rule set) | `result.entered` from interfaced analyzer + QC state + delta + range | `result.autoverified` | rules approved by pathologist + owner + MS | all results to pathologist queue | per rule set | rule id + semver on result | golden suite: never autoverify abnormal/critical/delta/qc-locked/manual/edited/sealed-sensitive | Class 2 | 17 (activated per test after 30 days of parallel run: auto-decision logged but human verifies; agreement ≥ 99.5%) |
| Delta Checker | automation | T1 | new result + previous within window (per-test %/absolute) | `result.delta_flagged` | none | — | per test | — | fixtures per test | Class 2 | 17 |
| Critical Value Caller | automation (Recall agent scope) | T1 | `result.critical_flagged` | contact task + ladder | human read-back | phone + paper sheet | per agent | — | ladder fixture; never closes without read-back text | Class 1 (phone numbers of staff) | 17 |
| TAT Chaser | SLA Chaser instance | T1 | `sla.breached` | nudge with cluster suppression | — | worklist colour | global chaser | — | alarm-rate cap per hour | Class 2 | 17 (definition data only) |
| QC Watchman | automation | T1 | `qc_run` recorded; calibration/lot dates | lockout + tasks | pathologist override only | manual QC log | per analyzer | — | Westgard fixtures | Class 2 | 17 |
| Re-collection Orchestrator | automation | T1 | `sample.rejected` | task + patient message + recall attempts | — | desk call list | per agent | — | free-path only from rejection | Class 1 (patient phone) | 17 |
| Reagent Replenishment | Replenishment automation | T4 for indent draft | par levels, run counts, lot expiry | indent draft | PO approval (Plan 14) | manual indent | per store | — | par fixtures | Class 2 | 17 + 14 |
| **Report Narrator (histo/micro)** | **agent** | **T2** | structured fields only: specimen type, gross measurements, block count, microscopic coded findings (SNOMED), organism, sensitivities; **no free text from outside** | draft microscopic description + impression scaffold; culture comment ("probable contaminant…") from template library | pathologist/microbiologist signs; edit distance tracked as the agent's KPI | blank template | per agent | model id, prompt version, input/output hash in `report.signed` | citation of field ids; adversarial fixtures; no diagnosis originated — impression restates coded findings | Class 1 → tokenised (no identifiers needed at all: input is fields) | after 12a + DPIA; histo volume justifies |
| Lab Ops Copilot (Lane 3) | agent | T2 (propose→confirm) | staff ask | tool calls: list pending by ward, re-print label, open recollection, explain a hold | human confirm | Lane 2 worklists | copilot class | — | permission ∩ agent grants; sealed fixtures | Class 1 filtered | with conversational surface pilot (Track B first; lab as second cohort) |
| Result Explainer for patients (WhatsApp "what does this mean?") | agent | **T2 max, and recommended NOT in Plan 17** | published report | plain-language explanation | doctor-approved templates only; no model text to patients initially | template text | — | — | risk: Telemedicine Guidelines 2020 — interpretation is medical advice | Class 1 | deferred; O-8 |
| Digest Writer lab section | agent | T0 | read models | digest lines | — | fact sheet | global | stamp | fact-sheet fallback | Class 2 | 12a |
| Test-utilisation nudger ("CBC ordered 3rd time today") | automation | T1 | order entry | inline duplicate/repeat warning | doctor decides | — | per rule | — | window fixtures | Class 2 | 17 |
| Anomaly detection on QC/analyzer drift (predictive maintenance) | agent (statistical) | T0 | LJ series | "drift likely" report | quality manager | LJ chart | per agent | — | back-test | Class 2 | post-baselines |

**Three presentation lanes for lab work:** Lane 1 hand-built keyboard-first: phlebotomy chair screen (scan → print → collect, F-keys), accessioning station (scan-only), result entry grid (manual bench; tab-through, Enter to save, per-test hotkeys for "normal"), verification queue, report print counter. Lane 2 schema-generated from tool-catalog schemas: QC entry, calibration log, reagent lot log, send-out manifests, culture stage forms, temperature logs, incident/CAPA, EQAS — the NABL long-tail nobody should hand-build. Lane 3 conversation: lab manager and quality manager asks; ward nurse "what's pending for bed 12?"; never result entry.

**Journey Feed contributions:** `order.placed(lab)`, `sample.collected` (by whom, where), `sample.rejected` (reason, recollection task), `result.published` (link, abnormal count), `result.critical_flagged` + acknowledgement with read-back, `report.amended`, `sample.dispatched` (partner, expected date), `culture.stage_advanced` (prelim), `report.print_blocked` (billing lane posts "report held — ₹ due", per deferred note 3's "agents post billing status before blocking").

**Prompt inputs (Report Narrator, concretely):** `{specimen_type_code, site_code, procedure_code, gross: {dimensions_mm[], weight_g, colour_code, consistency_code, lesion: {size_mm, distance_to_margin_mm}}, blocks: n, micro_findings: [SNOMED codes with qualifiers], special_stains: [{stain, result_code}], clinical_indication_code}` → output: typed claims `{section: gross|micro|impression, text, cites: [field ids]}`; renderer drops uncited claims (copilot §2.4).

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One beep contexts:** token QR at chair → patient + orders + tube list + labels; tube barcode at accessioning → order, expected containers, priority, TAT clock start; wristband at bedside → orders due for this patient now; report QR at any desk → the report and its version history.
- **Label design:** 50×25 mm thermal, 2D (DataMatrix) + 1D fallback, patient alias/name, UHID, age/sex, test short codes, tube type colour word, collection site, print time; **printed at the chair after the patient scan, never before**; reprint requires reason.
- **Keyboard flows:** result grid supports "N" = all normal for the panel (only when values are typed? — no: manual entry requires each numeric; "N" allowed only for qualitative tests), arrow navigation, per-cell flag colour, Enter = save row, Ctrl+V = verify (pathologist), `/` = search test.
- **TAT clocks on every worklist row**, colour at 70%/100% of SLA; cluster-suppressed alerts.
- **Pre-filled:** ICU standing-order protocol generates tomorrow's collection list at 21:00 with labels queued for the 05:30 round (printed at bedside on a mobile printer after wristband scan).
- **Tablet surfaces:** ward collection app (scan → collect → mark), critical-value acknowledgement with read-back typing, QC entry at the bench.
- **Printing:** report PDF template with signatory block, QR, abnormal highlighting, Hindi/English, "PRELIMINARY"/"AMENDED"/"QC-SUSPECT" watermarks; print counter with identity capture.
- **Voice:** none for results (accuracy); allowed for critical-call read-back capture as an audio attachment where lawful (staff consent, DPDP notice) — optional.
- **Measured targets:** accession < 100 ms p95; label print < 1 s; result grid save < 100 ms; verification queue load < 300 ms; OPD routine chemistry order→published p90 ≤ 3 h; CBC ≤ 1 h; STAT ≤ 45 min; critical call open→read-back p90 ≤ 15 min; rejection < 2% total, < 1% collection-attributable; auto-verification share ≥ 60% of interfaced chemistry/haematology within 6 months; amendments < 0.5% of reports; zero unscanned collections on wards after 90 days.

---

## 11. Integrations, devices & dependencies

**Analyzers (Indian market examples; the owner's inventory list is the open action from the acceleration ruling):** haematology 5-part (Sysmex XN-550/XN-1000, Mindray BC-5150/BC-6000, Horiba Yumizen) — ASTM/HL7 over TCP or RS-232; chemistry (Mindray BS-240/BS-360E, Beckman AU480, Roche cobas c311/c501, Erba XL-640, Transasia) — ASTM E1394 bidirectional; immunoassay (Roche cobas e411, Abbott Architect i1000SR, Mindray CL-900i, Siemens Immulite, Beckman Access 2) — ASTM/HL7; electrolytes (Roche 9180, Medica EasyLyte) — serial, unidirectional; coagulation (Sysmex CA-660, Stago) ; urine (Sysmex UF/UC, Dirui) ; HbA1c (Bio-Rad D-10, Tosoh) ; ABG/POCT (Radiometer ABL, Nova, Abbott i-STAT) — HL7/POCT1-A; blood culture (bioMérieux BacT/ALERT, BD BACTEC) — HL7; ID/AST (VITEK 2 Compact) — HL7; PCR (Cepheid GeneXpert — HL7/CSV; Bio-Rad CFX — file export); histology instruments (no LIS interface; barcode workflow only).

**Edge-service rule:** one `lab-edge` service per mini-PC; one child process per driver; drivers are pure protocol adapters (ASTM LIS2-A2 low-level + high-level, HL7 v2.5.1 ORU^R01/ORM^O01/QRY, CSV-watch); SQLite buffer with WAL; outbound only (HTTPS to core, edge token scoped to `lab.edge.results.write` + `lab.edge.orders.read` for the bidirectional cache); heartbeat → `agent.heartbeat_missed` (exists); `interface.down/restored`; capacity ≥ 7 days at 5,000 results/day (~50 MB); config from core (mapping tables), pulled, versioned; no inbound ports open on the mini-PC except the analyzer's TCP where required; OS: Ubuntu LTS, unattended-upgrades off, snapshot image for re-flash.

**Protocols:** ASTM E1381/E1394 (LIS1-A/LIS2-A2), HL7 v2.x, POCT1-A (later), FHIR R4 for ABDM `DiagnosticReport`; WHONET export for antibiogram; IHIP CSV/API for IDSP; LOINC (test codes), SNOMED CT (organisms, histo findings), ICD-10 (notifiable mapping).

**Dependencies on other plans:** 13 registry (bench/analyzer kinds) — hard; 14 procurement (vendor master, reagent GRN with lot/expiry, reference-lab partner as vendor, AMC) — hard for reagent lots, soft otherwise (lots can be entered manually first); 10 notifications (templates: report ready, delay notice, recollection recall, critical-departed contact); 09 memberships (lab discounts as adjustment rules — already generic); 15 mini-OT (frozen section, pre-op panels) — consumer; 16 pharmacy (ADR/PvPI links; antibiogram → antibiotic policy) — soft; 18 radiology (shared order family) — none; 19 BMW (disposal events) — soft; 12a agent runtime — for the Narrator only; IPD/ICU cluster — ward rounds and standing orders full value; clinical knowledge sourcing (§19 gate): LOINC load (free), SNOMED (free in India via NRCeS), notifiable list (licensed/curated).

**Events consumed:** `order.placed`, `order.cancelled`, `payment.received`, `invoice.issued`, `credit_note.issued`, `payer.switched`, `patient.merged/unmerged`, `patient.discharged/transferred`, `disaster.declared/ended`, `downtime.declared/ended`, `mode.context_applied`, `grn.received` (reagent lots), `resource.status_changed`, `consent.recorded`, `exposure.reported`.

---

## 12. Buy vs build, hardware & rough INR budget

**Build:** the module (orders, samples, results, verification, reports, QC, send-outs, registers), the edge agent and its drivers (no commercial middleware — an Indian LIS middleware licence costs ₹3–8 L/yr and hides the protocol; our stack owns it), reference ranges/formula engine, report templates.
**Buy/licence:** LOINC/SNOMED (free), notifiable-disease list curation (small), NABL consultant for the first accreditation cycle (₹3–6 L), EQAS scheme subscriptions (CMC Vellore/AIIMS/Bio-Rad EQAS ~₹1.5–4 L/yr across disciplines), WHONET (free), barcode printers/scanners, mini-PCs, UPS, temperature loggers, and the analyzers themselves — typically on **reagent-rental** in India (analyzer placed free against a committed monthly reagent volume; ₹ exposure moves to opex and lock-in) vs outright purchase (O-7).

Indicative 2026 list prices (quotes vary ±30%; GST extra; reagent-rental sets capex to ~0 for the big four):

| Item | Stage 1 (now, ~100 OPD/10 beds) | 610-bed target |
|---|---|---|
| Haematology 5-part | ₹8–12 L ×1 (Mindray BC-5150 class) | ×3 incl. XN-class ₹25 L |
| Chemistry (200–400 tests/h) | ₹10–14 L ×1 (BS-240/360 class) | AU480/cobas class ₹30–40 L ×2 + backup |
| Electrolyte | ₹2.5–4 L | ×3 (lab, ICU, ER) |
| Immunoassay | ₹25–40 L (or rental) | ×2 |
| Coagulation | ₹5–8 L | ×2 |
| Urine analyzer + microscopy | ₹3–5 L | ×2 |
| HbA1c (HPLC) | ₹6–9 L | ×1–2 |
| ABG (ICU/ER POCT) | ₹8–15 L ×1 | ×4 |
| Blood culture (BacT/ALERT 3D 60) | defer; send-out | ₹18–25 L |
| ID/AST (VITEK 2 Compact 30) | defer | ₹45–60 L |
| PCR (GeneXpert IV / real-time) | defer | ₹12–25 L |
| Histology suite (processor, embedding, microtome ×2, stainer, cryostat, microscope) | defer or minimal manual (₹12–18 L) | ₹60–90 L |
| Centrifuges, fridges, incubators, safety cabinet, autoclave, DI water | ₹6–10 L | ₹30–45 L |
| Barcode label printers (TSC TE244 / Zebra ZD230) | ₹15–22 k ×4 (2 chairs, accession, ward mobile) | ×25 |
| 2D scanners (Zebra DS2208 / Honeywell 1470g) | ₹7–12 k ×6 | ×50 |
| Mobile label printer (Zebra ZQ320) for ward rounds | ₹35–45 k ×1 | ×12 |
| Fanless mini-PC (Intel N100 class, 8 GB, 256 GB SSD) + USB-serial (FTDI) + serial cables | ₹22–35 k ×1 | ×8 |
| Ward tablets (collection app) | reuse Plan 11 tablets | +20 |
| Online UPS for analyzer bank | ₹60–90 k (3 kVA) | 10–20 kVA ₹3–5 L |
| Wireless temperature loggers (fridges/incubators) | ₹4–8 k ×4 | ×30 |
| Pneumatic tube system | no | optional ₹40–80 L (defer; runners + scans first) |
| **Rough total** | **₹75 L–1.2 Cr outright, or ₹15–25 L capex + reagent commitments on rental** | **₹4–6 Cr outright; ₹1.5–2.5 Cr on rental + histo/micro/molecular capex** |

Software build effort is the plan's stop-loss, not this table.

---

## 13. Owner rulings needed

- **O-1 Unpaid-report interlock scope and override.** Recommended default: applies to OPD/walk-in self-pay only; blocks *print and patient publish*, never the doctor's screen; override = approval-gated (billing supervisor) with dues entry; ER/IPD/corporate/PMJAY/TPA exempt. Ties to the roadmap's open dues ruling. Why: the legacy harvest wants it; patient safety forbids hiding results from clinicians.
- **O-2 Critical value at night without a pathologist.** Recommended: interfaced + QC-passed critical → technologist-released *preliminary* to clinician immediately, pathologist verifies by 9 a.m.; manual-bench criticals require a second tech or the on-call pathologist by phone (evented phone verify, in-app sign later). Why: 15-minute clinical need beats signature ceremony; NABL permits documented tech release under policy.
- **O-3 Reference-lab partner(s).** Recommended: one primary NABL-accredited national chain (e.g., SRL/Metropolis/Dr Lal/Neuberg class) + one regional backup; contract with TAT, sample-loss liability, electronic result feed; partner selection is a purchase.
- **O-4 Cancellation after analysis and non-return after rejection.** Recommended: charge stands if analysed; refund if no result was produced; both auto, evented.
- **O-5 Adolescent sensitive results.** Recommended: release to guardian per law, with mandatory doctor counselling flag before publish; sensitive-test list configured (money/legal exposure).
- **O-6 Patient-facing amendment wording and re-notification.** Recommended: always re-send with "AMENDED — please consult your doctor" and the reason category (not free text).
- **O-7 Reagent rental vs outright purchase per analyzer class.** Recommended: rental for chemistry/immunoassay/haematology at stage 1 (cash preservation, service included), purchase electrolytes/coag/urine; revisit at 300 beds.
- **O-8 Patient result explanation via WhatsApp.** Recommended: templates only, no LLM text to patients before a counsel opinion on Telemedicine Guidelines exposure.
- **O-9 Retention numbers** for slides/blocks/wet tissue/QC records/raw payloads as proposed in §4 — confirm against the NABL assessor's current expectation.
- **O-10 NABL application timing.** Recommended: apply after 6 months of live QC data on the new system (assessors want records); budget line now.
- **O-11 Auto-verification activation policy.** Recommended: per test, after 30-day parallel run with ≥ 99.5% agreement, pathologist-signed, owner-approved as Class A config.
- **O-12 Microbiologist hiring vs outsourcing cultures** until ~150 beds. Recommended: outsource cultures, keep gram stains/rapid tests in-house; hire at ICU commissioning.

---

## 14. Plan sketch — how this becomes phase documents

**Plan 17 — Central lab / LIMS core** (one phase doc, v3 method; manual first):
- T1 catalogue + reference ranges + formula engine + LOINC load (data, validators, golden fixtures for ranges/formulae/critical/absurd envelopes) — ROUTINE.
- T2 orders/samples/results schema + manifest (kinds `bench`, `analyzer`; permissions; events incl. NEW list) — ROUTINE.
- T3 workflow definitions: `lab_order_item`, `lab_sample`, `critical_value_contact`, `qc_run`; SLA data; escalation ladders — CRITICAL (assertion book: every state reachable, interlock per item, rejection→free recollection, critical never autoverified).
- T4 collection surfaces: phlebotomy queue (extends Plan 07 queue engine), chair screen, label service, ward tablet collection; accessioning station — CRITICAL.
- T5 manual result entry grid + verification queue + auto-verifier (rules engine with parallel-run mode) + delta checker — CRITICAL.
- T6 reports: PDF template, signatory block, interlock, print counter with identity, publishing via Plan 10, amendments — CRITICAL.
- T7 QC/calibration/lots + Levey-Jennings read model + lockout + override — CRITICAL.
- T8 send-outs + external ingestion — ROUTINE.
- T9 registers (notifiable, incident/CAPA, amendment view, release register) + IDSP task — ROUTINE.
- T10 KPIs/digest lines, worklists (Lane 2 generation for QC/logs), golden suite + adversarial pass + staff interview fixtures — ROUTINE.
- Deploy gate: parallel with the legacy lab for a pilot-as-secondary window (edge-case harvest per roadmap).

**Plan 17-E — Analyzer edge agent** (separate phase, per machine): E1 edge runtime + SQLite + token + heartbeat + replay tests; E2 first driver (whichever analyzer the inventory says is ASTM bidirectional, likely chemistry); E3 haematology; E4 immunoassay; E5 POCT ABG (with ICU); each driver = its own task with a replay-fixture corpus captured from the real machine before coding.

**Plan 20 — Microbiology & antibiogram** (culture workflow, isolates, sensitivities, WHONET, infection-control feed); gated on O-12.
**Plan 21 — Histopathology/cytology** (cases, blocks, slides, frozen section with Plan 15, second opinion, Report Narrator T2 after 12a).
**Plan 22 — NABL pack** (document control via the Expertise store, EQAS, equipment register views, audit exports) — after 6 months of live QC data (O-10). Could fold into the Quality/NABH pack.
Home collection = doc 03's plan; hooks in 17 T4 (`collection_site=home`, quarantine state).

**Sequencing/gates:** 13 shipped → 14 vendor master (or manual lots) → 17 → 17-E per analyzer inventory → 20/21 as staffing arrives → 22. Must be true before authoring 17: analyzer inventory with protocols (owner action open), test catalogue list from the existing lab (spreadsheet), current report format samples, the legacy lab's reference-range book, price list mapping to tariff, the dues ruling, O-1/O-2/O-11.

**Negative-space question answered:** the signals that are *absences*: a collected sample with no `sample.received` within 60 min (lost tube); an accessioned item with no result within SLA (fell off the bench); a critical with no read-back; an analyzer with runs today but no QC run; a reagent lot in use past expiry with no lot change; a ward with orders but no collection round started; an order paid but never collected in 24 h (patient left — recall); a published report never opened by the doctor in 48 h for an abnormal (unseen result — a Recall task); an interfaced analyzer silent for > 2 h during working hours (interface.down not raised — heartbeat gap); a histo case with blocks but no slides after 48 h.

**Staff edge-case interview questions (department head / senior tech):**
1. Show me the last five samples you rejected and what happened to each patient afterwards. 2. What do you do when the analyzer prints a result for a barcode you cannot find? 3. How do you handle a critical value for an OPD patient who has already gone home, at night? 4. Which tests do you release without the pathologist and how is that documented today? 5. What happens when QC fails at 7 a.m. and the OPD rush is at 9? 6. How do add-on requests reach you, and how do you find the tube? 7. Which reports are held for payment today, and how do doctors get around it? 8. How are reference ranges maintained — who last changed one, and why? 9. How do you handle twins, unknown patients, and patients with the same name on the same day? 10. What is the paper flow when the system is down, and how did you backfill last time? 11. Which analyzers have serial ports, which have printed only, which has a vendor PC attached? 12. Where do reagents get stolen or wasted? 13. What does the NABL assessor ask first? 14. How do you dispatch to the reference lab and what got lost last year? 15. How do you get IDSP forms out today and who signs?

---

## 15. Open questions & risks

1. **Encounter type for walk-in lab visits** — the enum is open (Plan 07 trap) but `lab_walkin` must be agreed with the OPD module before 17 T2; otherwise lab grows a private visit table (the Plan 13 lesson).
2. **Dues/receivable instrument** (roadmap open ruling) — the interlock override creates a receivable; without the ruling the override cannot land cleanly.
3. **Auto-verification legal standing** — NABL accepts documented auto-verification (CLSI AUTO-15 style); confirm with the NABL consultant that technologist release of criticals under O-2 is acceptable in the quality manual.
4. **Analyzer inventory unknown** — the whole 17-E sequence depends on it; risk that most machines are printout-only, which makes manual entry the steady state longer than hoped (design tolerates this).
5. **Reference-range source** — ranges are vendor kit-insert or textbook derived; NABL expects verification/validation of ranges; the module stores source and version but someone must do the validation study.
6. **Pathologist single point of failure** — every verification and override path ends at one person until HC grows; the night-mode design mitigates but does not remove the dependency.
7. **Home-collection identity** — doc 03 must specify the field identity check (photo ID + OTP?) because the lab's right-patient assurance ends at the door scan.
8. **Untrusted-content boundary for external PDFs** is stated but the ingestion tooling (OCR?) is not designed; recommend no OCR in 17 — human structured entry.
9. **Reagent-rental contract data** (run counts by test) must match what the vendor bills; reconciliation ownership sits between lab and procurement.
10. **KPI formula registry** does not exist yet; the formulas in §8 must be pinned in S10 v1.x until it does.
11. **Twin/NICU flows** depend on the maternity module's band pairing (§11.17) — before it ships, the lab's twin banner keys off a patient-master attribute that may not exist (`multiple_birth_ordinal`) — flag to patients module.
12. **DPIA** for the Report Narrator and any patient-facing explanation text: counsel-gated, not on the critical path for 17.
