# 18 — Blood Bank / Transfusion Services — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED · **Series:** Department Brainstorm & Planning 2026-08-27, document 18 · **Roadmap anchor:** phase-1 plan series step 4(c) "blood bank module — digitizes the already-licensed operation".

**Executive summary.** The hospital already runs a Drugs & Cosmetics Act–licensed blood bank on paper registers with ~2 staff. This module digitises that operation vein-to-vein: donor → collection → TTI testing → component preparation → quarantined/released inventory → grouping/crossmatch → issue → bedside verification → monitored transfusion → reaction/haemovigilance → discard/BMW, plus e-RaktKosh stock reporting, NBTC-ceiling pricing and inter-bank transfer. It is NOT a lab module (LIMS, Plan 17, owns analyzers and general serology; the bank owns immunohaematology results only), NOT a pharmacy (no drug ledgers), NOT the ward's eMAR (nursing owns administration charting; the bank owns the unit's chain of custody and the transfusion event) and NOT a CRM (donor camps borrow the camps hook noted in §11.19 but the donor register is the bank's). The three hardest problems: **(1) wrong-blood-in-tube / wrong-patient at the bedside** — the one error that kills within minutes, which the module must make physically hard rather than merely documented; **(2) the paper-to-digital absorption of a live licensed bank** whose registers are inspected by the State Drugs Controller — the statutory registers must be first-class tables that print in the Schedule F shape from day one, with no gap during cutover; **(3) inventory truth under expiry, quarantine and replacement-donor pressure** — units are perishable, group-specific, quarantined until five TTI results clear, and the commonest Indian failure is a family coerced into replacement donation while a usable unit expires on the shelf.

---

## 1. Frame — what exists, what is locked, what this document adds

**Locked decisions inherited (do not re-litigate, only extend):**
- Spec §9 module catalog: *blood bank — already licensed and operating; the module digitizes the existing operation (donor management, screening, cross-match, issue register).* New module folder: owns tables + workflows (design law 1).
- Spec §11.4 map 10 **Blood transfusion chain** (locked): order + consent → cross-match → in-house licensed bank issues (external sister-bank only as shortage fallback; processing charges per NBTC norms) → cold-chain transport task → **bedside two-staff + wristband + unit-barcode hard stop** → monitored transfusion → completion or reaction branch (stop, workup, unit returns, register + auto incident report) → BMW-compliant disposal.
- Spec §10.6 catalog names already exist: `transfusion.ordered · unit.crossmatched · unit.issued · transfusion.started · transfusion.completed · transfusion.reaction_flagged · adr.reported · consent.recorded · incident.reported · band.pair_verified/band.pair_mismatch (reuse for bedside pair) · batch.expiring · stock.below_reorder · material.returned · bmw.manifest_recorded · utility.threshold_breached · license.expiring · statutory_return.due/.filed · mtp.activated`.
- Spec §11.9/§11.16: OT **blood reserve = cross-match hold, auto-released after 48 h unused**; OT list published previous evening synchronises bank reserves; "blood confirmed" is a hard pre-op gate.
- Spec §11.15 ICU: **Massive Transfusion Protocol** — activation → MTP release rules incl. documented emergency O-neg uncrossmatched issue → cooler tracking → per-unit reconciliation. `mtp.activated` stays with massive transfusion (§11.17 collision note); MTP-Act uses `termination.recorded`.
- Spec §11.17: PPH links into MTP. §11.19-D item 9: **blood-refusal directive** satisfies the OT reserve gate; the transfusion chain checks the refusal flag before any crossmatch. §11.19-D item 11: transition-operations boundary map — the legacy bank continues current processes until its absorption date. §11.19-D item 33: **cold-chain logging** on the utility-telemetry pattern (sensors or manual recurring verified tasks day one); excursion events + register. §11.19-C item 39: blood transfusion committee on the committee machinery (Quality pack). §11.19-B: compliance calendar carries the blood bank licence.
- S10 role card 19 *Blood Bank Officer/Technician* (A1 register-run → A2 holds with auto-release, issue scans, MTP rules, reaction workflow → A3 inventory forecasting by agent; HC 2 → 8–10 24×7); S10 §11 witness eligibility for transfusion two-person verify; S10 §12 item 16 succession chain for the single-incumbent blood-bank officer.
- §16 agent laws: clinical cap T2–T3; automations over agents where a rule suffices; fail-open; kill switch; provenance.
- Plan 13 registry: ten kinds (floor, ward, hall, room, bed, theatre, device, store, bench, analyzer); the set of kinds is closed; a module declares status vocabularies for kinds it claims. The bank needs `store` (blood storage refrigerator/freezer/agitator as stores? no — see §4), `device`, `room`, `bench`.
- Billing law: charges accrue from module events; append-only; corrections are credit notes; every unit movement terminates on a bill or a cost centre.

**Scope boundaries / neighbours.** Patients (UHID, ABHA, allergy, blood group *as a patient-master attribute written only by this module*); OT (Plan 15/major OT — reserve requests, MTP in theatre); ICU/ED (MTP activation, emergency issue); IPD nursing/eMAR (bedside administration, vitals during transfusion — the bank's `transfusion_episode` is the clinical anchor; nursing charts vitals against it); LIMS Plan 17 (TTI analyzers may be shared central-lab ELISA/CLIA instruments — results flow to the bank via LIMS's declared interface, the bank never touches LIMS tables); Procurement Plan 14 (bags, reagents, kits — P4); Materials Plan 14/16 (reagent stock P3); Billing (processing-charge lines, PMJAY/state-scheme zero-charge rules); Quality pack (incident, committee, haemovigilance submission evidence); Notifications Plan 10 (donor recall, camp reminders); Compliance calendar (licence, SBTC inspection, e-RaktKosh returns).

**What this document adds:** the full donor/collection/testing/component/inventory side that §11.4 map 10 only points at; the statutory register tables; the e-RaktKosh and haemovigilance surfaces; pricing under ceilings; ~115 edge cases; 7 chaos walkthroughs; KPIs; four agent/automation candidates; a plan split.

---

## 2. Actors, roles & role cards

| Role (S10 card / proposed) | Shift | Responsibilities in this module | Notes |
|---|---|---|---|
| **Blood Bank Medical Officer (BBMO)** — S10 card 19 is a combined officer/technician card; **propose splitting into 19a BBMO** | Day + on-call 24×7 with published succession chain (S10 §12.16) | Licence signatory (medical officer in charge per Schedule F Part XII-B), donor deferral adjudication, TTI-reactive disclosure sign-off, reaction workup sign-off, MTP release authority, uncrossmatched issue authority, discard authorisation, transfusion committee secretary | MBBS with blood bank training or MD Pathology; the bank cannot operate without one on the licence |
| **Blood Bank Technician** — 19b | 3 shifts once 24×7 (today 2 staff: day + on-call) | Phlebotomy, grouping, TTI runs/coordination with LIMS, component separation, crossmatch, issue, temperature logs, QC | DMLT/BSc MLT; competency-gated for crossmatch sign |
| **Donor Counsellor / Donor Organiser** — **NEW card 19c** | Day | Pre-donation counselling, questionnaire, consent, post-donation care, TTI-reactive notification & referral (ICTC), camp organising, donor recall relationship | Often one social worker; NACO-trained counsellor for HIV disclosure |
| **Transfusion Nurse (ward function, not a post)** — nursing card + competency flag | Ward shifts | Sample draw with right-patient scan, bedside two-person verification, vitals at 0/15 min/hourly/end, reaction first response | Any licensed floor nurse eligible as witness (S10 §11) |
| **Ordering doctor** — S10 doctor cards | — | Orders, indication code, consent counselling, reaction management, MTP activation | Clinical cap: agents never order or release |
| **Transport attendant** | Shifts | Cold-chain carriage in validated box; return within window | P5 task-and-track |
| **Pathologist / BB head** | — | Reports to; QC review, committee chair | S10 card 19 "reports to" |
| **Billing counter / IPD billing** | — | Processing charges, scheme zero-rating, replacement credit | P6 |
| **Duty manager** | 24×7 | Downtime declare, shortage escalation, sister-bank sourcing approval | |
| **Transfusion Committee** (§11.19-C item 39) | Quarterly | Reaction review, utilisation audit (C:T ratio), wastage review | Quality pack committee machinery |
| **Drugs Inspector / SBTC inspector** (external) | — | Walks in; demands registers | Read-only inspector view + register print |
| **Agents/automations:** Expiry & Inventory Watchman (automation, T1) · Donor Recall (automation, T1, extends Recall & Follow-up) · Crossmatch Queue Chaser (automation, T1, SLA Chaser instance) · Reaction Report Drafter (agent, T2) · Cold-chain Excursion Sentinel (automation, T1, utility-telemetry) · Leakage Auditor (existing T0, consumes unit movements) | | | §9 |

**SoD hard pairs (proposed additions to S10 §11):** phlebotomist of a unit ≠ its TTI result verifier where staffing permits (small-bank waiver logged); crossmatch performer ≠ issue verifier for the same unit (the second scan); discard authoriser ≠ discard executor; TTI-reactive discloser must be the counsellor or BBMO, never the technician; bedside verifier pair are two distinct licensed staff neither of whom drew the sample when possible (soft rule, logged). Bundling: night shift may bundle technician + issue desk; BBMO on-call may not be the same person as the on-call pathologist witness for a reaction workup (waivable with log at today's HC).

---

## 3. Core flows as workflow definitions

All lifecycles below are **workflow definitions** (versioned data, owner-activated per §10.4). Pattern mapping: donor lifecycle = P1-variant (a donor is a *person journey* without an encounter — see §4 for the `donor` entity vs patient); collection→component→inventory = P3 (request-to-issue with the unit as the item); order→crossmatch→issue→transfuse = **P2 order-to-result** (§10.1 explicitly lists "blood"); transport = P5; charges = P6; recalls/expiry = P7.

### 3.1 Donor lifecycle (`donor_visit`)
```
registered ──screened──▶ eligible ──consented──▶ phlebotomy ──collected──▶ post_donation ──released──▶ closed
     │                      │                                     │
     └──deferred(temp)──▶ deferred_temp (recall date)             └──reaction──▶ donor_reaction_workup ──▶ closed
     └──deferred(perm)──▶ deferred_perm (register, no recall)
```
- **States/SLA:** registered→screened ≤15 min (queue, active alert off); eligible→phlebotomy ≤20 min; phlebotomy ≤12 min bleed time (over 15 min flags slow-bleed, unit marked for component restriction); post_donation observation ≥15 min minimum (hard: cannot close earlier); `donor_reaction_workup` has BBMO sign-off.
- **Roles:** counsellor registers/screens; technician/BBMO signs eligibility (Hb, weight, BP, pulse, temp, questionnaire); phlebotomy by technician/nurse; deferral decision by BBMO (temporary deferrals per NBTC table may be auto-suggested by rule, doctor confirms).
- **Variants:** voluntary walk-in · replacement (linked to a patient encounter — `replacement_for_encounter_id`) · camp (offsite, batch intake, paper questionnaire backfilled) · autologous (patient = donor; unit tagged, never enters general stock) · apheresis platelet (own sub-flow with cell-separator device, 48-h interval, ≤24/yr rule) · directed donation (discouraged; allowed with BBMO note, unit tagged, still TTI-tested).
- **Events:** NEW `donor.registered` · NEW `donor.screened` · NEW `donor.deferred` (temp|perm, reason code) · `consent.recorded` (type donation) · NEW `unit.collected` · NEW `donor.reaction_recorded` · NEW `donor.recall_due` (P7) · NEW `camp.scheduled` / `camp.closed` (the §11.19 "camps" hook).

### 3.2 Unit lifecycle (`blood_unit`) — collection to final disposition
```
collected ─▶ quarantined ─(all TTI non-reactive + group confirmed)─▶ available ─▶ reserved ─▶ crossmatched ─▶ issued ─▶ transfused
                │                                                        │            │             │           │
                ├─ TTI reactive ─▶ tti_reactive_hold ─▶ discarded         └─ released  └─ released    └─ returned(≤30 min) ─▶ available
                ├─ component_separated ─▶ (parent closed; children start at quarantined)             └─ returned(>30 min) ─▶ discarded
                ├─ expired ─▶ discarded            ├─ qc_sampled ─▶ discarded (QC consumption)
                ├─ cold-chain excursion ─▶ excursion_hold ─▶ BBMO decision ─▶ available | discarded
                └─ transferred_out (to another bank) ─▶ closed
```
- **Hard rules:** no transition out of `quarantined` until 5 mandatory TTI results (HIV-1/2, HBsAg, anti-HCV, syphilis, malaria) are `non_reactive` **and** ABO/Rh confirmed (forward + reverse) **and** the label is printed from the system (no hand-written labels). NAT, if enabled, is a 6th gate (configurable). Expiry computed per component and anticoagulant (PRBC CPDA-1 35 d / SAGM 42 d; whole blood 35 d; FFP 12 mo at ≤−30 °C; platelets 5 d at 20–24 °C agitated; cryo 12 mo; thawed FFP 24 h at 2–6 °C; opened/pooled system 4 h; paediatric aliquot inherits parent expiry unless open system → 24 h).
- **Component preparation** (`component_batch`): parent whole blood → PRBC + FFP (+ platelet concentrate + cryo) within 6–8 h of collection (config) for FFP/platelet eligibility; yields recorded (volumes, weights); each child gets its own unit number suffixed (ISBT-128 product code if adopted, else internal). Slow-bleed or under-/over-weight bags restricted from FFP/platelets by rule.
- **Events:** `unit.collected` · NEW `unit.quarantined` · NEW `tti.resulted` (per test, per unit) · NEW `unit.released` (to available) · NEW `unit.tti_reactive_held` · NEW `component.prepared` · `batch.expiring` (reuse, payload `item_type: blood_unit`) · NEW `unit.expired` · NEW `unit.discarded` (reason code, BMW category) · NEW `unit.transferred_out` / NEW `unit.transferred_in` · NEW `coldchain.excursion_recorded` (specialises `utility.threshold_breached`) · NEW `unit.excursion_decided`.

### 3.3 Transfusion request → issue → transfusion (`transfusion_request`, `transfusion_episode`)
```
ordered ─▶ sample_pending ─▶ sample_received ─▶ grouped ─▶ [screened] ─▶ crossmatching ─▶ ready ─▶ issued ─▶ in_transit ─▶ bedside_verified ─▶ transfusing ─▶ completed
   │           │                  │                                          │              │                         │                 │
   │           └ sample rejected ─▶ recollect task                            └ incompatible ─▶ BBMO review          └ mismatch ─▶ HARD STOP + incident   └ reaction ─▶ stopped ─▶ reaction_workup ─▶ closed
   ├ refusal flag ─▶ blocked_refusal (doctor must resolve)
   ├ emergency uncrossmatched ─▶ emergency_issued (O-neg / group-specific unscreened) ─▶ retrospective crossmatch
   └ reserve (OT) ─▶ reserved ─(48 h unused)─▶ auto_released
```
- **Order content (hard fields):** indication code (corporate practice: NBTC/AABB indication list + Hb/platelet/INR trigger value captured), component, units, urgency (routine ≤ 2 h / urgent ≤ 45 min / emergency ≤ 15 min / MTP), special requirements (leucoreduced, irradiated, CMV-safe, washed, paediatric aliquot, phenotype-matched), consent status, refusal check (§11.19-D item 9), previous transfusion/reaction history auto-shown, pregnancy/Rh status for females 15–50.
- **Sample rule:** pretransfusion sample drawn with right-patient scan (band QR) → tube label printed at chair/bedside → two identifiers; sample validity 72 h (config; 3 days if transfused/pregnant in last 3 months). A second confirmatory ABO sample is required for first-ever grouping at this hospital (corporate default; configurable to "historic group on file suffices").
- **Crossmatch:** major crossmatch at AHG phase mandatory; **electronic crossmatch disabled by default** (owner ruling O-6 to enable ever); minor crossmatch not required for components (config); antibody screen (3-cell) as corporate default where reagent available, else flag "unscreened". Incompatible → BBMO review, extended workup, send-out to reference lab as `sample.dispatched` (reuse).
- **Issue:** issue desk scans unit + request + issuing staff badge; prints issue slip with QR; transport box temperature logger id; `unit.issued`. **Return window 30 min** (config) with unit temp check; beyond → discard.
- **Bedside:** two licensed staff scan patient band + unit + issue slip; system compares ABO/Rh compatibility table, patient identity, expiry, special requirements; any mismatch = `band.pair_mismatch` variant NEW `transfusion.verification_failed` + hard stop + auto incident; vitals pre, 15 min, hourly, post; completion ≤4 h from issue.
- **SLA per urgency** as above; escalation ladder: technician → BBMO on-call → duty manager (shortage) → sister bank.
- **Events (existing):** `transfusion.ordered` · `sample.collected/received/rejected` (reuse with `order_type: blood`) · `unit.crossmatched` · `unit.issued` · `transfusion.started` · `transfusion.completed` · `transfusion.reaction_flagged` · `incident.reported` · `consent.recorded` · `refusal.recorded`. **NEW:** `blood.reserved` · `blood.reserve_released` · `unit.emergency_issued` · `transfusion.verification_failed` · `transfusion.stopped` · `reaction.workup_completed` · `haemovigilance.reported` · `unit.returned` · `mtp.pack_issued` · `mtp.reconciled`.

### 3.4 Reaction & haemovigilance (`transfusion_reaction`)
suspected → transfusion stopped (bag + set preserved, saline line) → clerical recheck at bedside (repeat identity check) → samples (post-transfusion EDTA + clotted, first urine, bag + set returned to bank) → bank workup (repeat group patient pre/post, unit group, DAT, repeat crossmatch, haemolysis check, culture if febrile/septic) → classification (FNHTR / allergic / AHTR / DHTR / TRALI / TACO / septic / other; severity 1–4; imputability) → BBMO sign → HvPI TRRF submitted (Haemo-Vigil) → committee review. SLA: bank acknowledges within 15 min, preliminary workup 2 h, TRRF within 24 h (internal), Haemo-Vigil upload per programme timeline. Emits `transfusion.reaction_flagged` → `adr.reported`-class NEW `reaction.workup_completed` → `haemovigilance.reported` → `incident.reported`.

### 3.5 MTP (`mtp_episode`) — consumed from ICU/OT/ED/maternity `mtp.activated`
activated → pack 1 issued (e.g., 4 PRBC : 4 FFP : 1 platelet pool, config ratio; O-neg/group-specific uncrossmatched allowed under documented emergency release signed by the treating doctor) → cooler tracked (issue time, box id, temperature strip) → subsequent packs on demand → deactivated → **per-unit reconciliation** (transfused / returned in window / discarded) → charges post per unit transfused; unused-in-window units return to stock. NEW `mtp.pack_issued`, `mtp.deactivated`, `mtp.reconciled`.

### 3.6 Inter-bank transfer & shortage (`blood_transfer`)
requested (shortage rule: group stock below par or special product unavailable) → duty-manager/BBMO approval → sister bank confirmed → transport with cold-chain → received: re-verify group + TTI certificate + expiry → `unit.transferred_in` (units keep origin unit number, get local accession). Outbound the mirror: NBTC transfer note, no charge beyond processing (config). e-RaktKosh stock update follows every movement.

### 3.7 Donor camp (`camp`)
proposed (organiser, venue, date, expected donors, DDO/SBTC permission where required) → approved → kit issued (bags by lot, forms by serial, cold boxes) → conducted (offline capture; paper questionnaires with serials) → units received at bank (count reconcile vs bags issued) → backfill of donors → closed with camp report and certificates.

---

## 4. Data model sketch

Module folder `blood_bank` (own schema). Sketch columns only.

**Donor side**
- `donors` — id, donor_no (bank series), patient_id? (nullable link when donor is also a patient; autologous requires it), name, sex, dob/age, phone, address, id_proof_type/last4, abo, rh, phenotype jsonb, donor_type (voluntary|replacement|autologous|directed|apheresis), first_donation_at, last_donation_at, donation_count, permanent_deferral (bool, reason, by, at), language_pref, consent_to_recall (DPDP), created/updated audit. **Not a `patients` row** — donors are data principals with a different purpose (DPDP data class D-donor); linking is explicit.
- `donor_visits` — id, donor_id, workflow_instance_id, mode (walkin|camp|apheresis), camp_id?, replacement_for_encounter_id?, hb, weight, bp_sys/dia, pulse, temp, questionnaire jsonb (versioned form id), screened_by, eligibility (eligible|deferred_temp|deferred_perm), deferral_reason_code, deferral_until, consent_id, bleed_start/end, volume_ml, bag_lot_id, phlebotomist_id, observation_end_at, outcome.
- `donor_deferral_register` (statutory) — append-only projection of deferrals: visit_id, donor_id, type, reason, until, adjudicated_by.
- `donor_reactions` — visit_id, type (vasovagal/haematoma/nerve injury/citrate…), severity, management, DRRF submitted_at.
- `camps` — id, organiser, venue, date, permission_ref, kit_issued jsonb, bags_issued, bags_returned, units_collected, report.

**Unit side**
- `blood_units` — id, unit_no (unique, bank prefix + year + serial; ISBT-128 DIN if adopted), parent_unit_id? (component), component_type (WB|PRBC|FFP|PLT|PLT_APH|CRYO|PLT_POOL|PAED_ALIQUOT), donor_visit_id, collected_at, anticoagulant, volume_ml, weight_g, abo, rh, phenotype jsonb, special_flags (leucoreduced|irradiated|washed|cmv_neg|autologous|directed), expiry_at, status (mirror of workflow), location_resource_id (registry `device` = refrigerator/freezer/agitator shelf), quarantine_release_by/at, label_printed_at, current_reservation_id?, current_request_id?, final_disposition, disposition_at.
- `unit_status_history` — append-only (unit_id, from, to, at, by, reason, event_id).
- `tti_results` — unit_id, test (HIV|HBsAg|HCV|SYPHILIS|MALARIA|NAT), method, kit_lot, result (reactive|non_reactive|indeterminate|invalid), value, analyzer_id/run_id (LIMS ref), performed_by, verified_by, at, repeat_of? (repeat-in-duplicate on initial reactive).
- `tti_reactive_register` (statutory + confidential class) — unit_id, donor_id, test, confirmatory_ref (ICTC/reference lab), counselled_by, disclosed_at, referral, NACO report ref. Sealed access: BBMO + counsellor only.
- `component_batches` — parent_unit_id, prepared_at, by, centrifuge_run, children unit ids, yields.
- `quarantine_log`, `discard_register` (statutory: unit_no, component, reason code {expired, TTI-reactive, under/over-weight, haemolysed, leak, lipaemic, clotted, excursion, returned>30min, QC sample, reaction-returned}, authorised_by, executed_by, bmw_bag_manifest_id, at).
- `cold_chain_devices` → registry `device` resources (fridges, freezers, agitators, transport boxes) with `temperature_readings` (device_id, at, value, source sensor|manual, recorded_by) and `excursion_register` (device, start, end, min/max, units affected, decision, by).
- `bag_lots`, `reagent_lots` (anti-A/B/D, AHG, screen cells, TTI kits) — batch, expiry, QC pass (P3 stock via Plan 14/16 interface; bank keeps usage linkage per test).
- `qc_register` — daily reagent QC, equipment calibration, centrifuge validation, thermometer checks; `qc.passed/failed` reuse with lockout (a failed reagent lot blocks its use — the §11.6 QC-lockout class).

**Request side**
- `transfusion_requests` — id, encounter_id, patient_id, workflow_instance_id, ordered_by, ordered_at, component, units_requested, urgency, indication_code, trigger_values jsonb, special_requirements, consent_id, refusal_checked_at, pregnancy_rh_flag, sample_id, sample_valid_until, group_result_id, antibody_screen_result_id, reserve_expires_at (OT holds), payer_tag, status mirror.
- `patient_blood_groups` (immunohaematology record, FHIR `Observation` shaped) — patient_id, abo, rh, phenotype, antibodies jsonb, method, sample_id, tested_by, verified_by, at, confirmed (two-sample rule), historic_discrepancy flag. **Writes `patients.blood_group` via patients' declared interface**; the bank is the only writer.
- `crossmatches` — request_id, unit_id, method (IS|AHG|electronic-disabled), result (compatible|incompatible), performed_by, verified_by, at, valid_until.
- `issues` (statutory issue register) — unit_id, request_id, issued_to (staff id, ward), issued_by, at, box_id, temp_at_issue, slip_qr, return_at?, return_temp?, return_outcome.
- `transfusion_episodes` (FHIR-shaped, `Procedure`/`Observation` bundle) — request_id, unit_id, verifier_1, verifier_2, verified_at, started_at, vitals refs (nursing charting via declared interface), stopped_at, completed_at, volume_transfused_ml, outcome (completed|stopped_reaction|stopped_other), notes.
- `transfusion_reactions` (statutory adverse reaction register) — episode_id, onset, symptoms jsonb, category, severity, imputability, workup jsonb (DAT, repeat groups, haemolysis, culture), BBMO sign, TRRF json, HvPI submission ref, committee_review_id.
- `mtp_episodes` — activated_by, at, location, packs jsonb, reconciled_at, reconciliation jsonb.
- `blood_transfers` — direction, counterpart bank (licence no.), units, transport, received_by, verification, e-RaktKosh ref.
- `eraktkosh_submissions` — payload hash, at, status, response; `haemovigilance_submissions`.
- `blood_tariff_rules` — processing charge per component (base), ceiling reference (NBTC/state GO version), scheme zero-rate list (PMJAY, thalassaemia/haemophilia/sickle-cell registrants, state schemes), replacement-credit policy (config: **none by default**, see O-3).

**Registry kinds (Plan 13):** `room` (donor area, component lab, storage room, counselling room), `bench` (grouping bench, crossmatch bench), `device` (refrigerator ×n, plasma freezer, platelet agitator, cell separator, centrifuge, tube sealer, transport boxes), `bed` (donor couches, kind bed with status vocabulary `available|occupied|cleaning|retired`; occupant_type `donor_visit` — **check that DD6's occupant contract admits a non-encounter occupant; if not, donor couches stay a `room` attribute — routed to §15**), `store` (reagent store).

**Retention:** Schedule F Part XII-B: records ≥5 years (donor, testing, issue, reaction, discard); recommended default in this hospital: **donor/unit/issue/reaction registers 10 years, TTI-reactive register permanent, MLC-linked transfusions permanent** (aligns with IPD 10-y and MLC indefinite from §11.14). DPDP erasure bounded by these.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref**.

### A. Identity, wrong-patient, wrong-blood-in-tube (the killers)
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| A1 | Nurse draws pretransfusion sample from bed 12 but sticks bed 11's label (WBIT) | Sample label prints only after band scan at bedside; label carries band-scan nonce; bank accessioning rejects a tube whose nonce ≠ request's patient | Fixture: label nonce mismatch → `sample.rejected` reason WBIT_SUSPECT, recollect task | — |
| A2 | Historic group on file O+, today's sample types A+ | Discrepancy → hard hold; second fresh sample by different collector; BBMO adjudicates; no unit released until resolved; incident auto-raised (possible WBIT on a prior visit) | Assert `patient_blood_groups.historic_discrepancy` set and request blocked | — |
| A3 | First-ever grouping at this hospital; single sample | Corporate default: group-specific (non-O) release requires a second independent sample; until then issue O (Rh-appropriate) or wait | Config toggle test; default = two-sample | O-5 |
| A4 | Two patients same name + same ward (two "Ram Kumar") | Every scan uses UHID/band QR; issue slip shows UHID + DOB + photo thumbnail; name-only lookup disabled at issue desk | UI test: issue by name search impossible | — |
| A5 | Wristband missing/illegible at bedside (soiled, cut for surgery) | Verification cannot proceed; nurse re-prints band from registration with two-identifier confirmation; event `band.reprinted` NEW; transfusion delayed, SLA clock annotated | Assert verification screen refuses manual override without break-glass | — |
| A6 | Emergency, unknown patient (UNK-registration per §11.4 map 8) | UNK UHID + temporary band; O-neg (females ≤50) / O-pos (males, older females) uncrossmatched under emergency release; retrospective group; `patient.merged` later carries the transfusion history | Assert episode re-links on merge | — |
| A7 | Patient merged after transfusion; one of the merged records had a different blood group | Merge gate shows blood-group conflict as a patient-safety blocker requiring BBMO review before merge completes | Merge test with conflicting groups → blocked | — |
| A8 | Bedside verifier 2 scans their own badge twice | Two distinct staff ids enforced; same id twice rejected; remote-video witness only as logged last resort (S10 §11) | Unit test on verifier distinctness | — |
| A9 | Unit label barcode damaged/condensation-unreadable | Manual unit-number entry allowed only with second staff scan + reason; flagged for label reprint; event carries `manual_entry: true` | Assert manual entries surface in weekly digest | — |
| A10 | Twins/neonates: mother's sample used for baby's crossmatch | Allowed per standard (maternal plasma for infants <4 months) with explicit linkage `sample_source: maternal`; baby's own band scanned at bedside | Fixture: neonate request with maternal sample | — |
| A11 | Patient transferred beds mid-request | Request follows encounter, not bed; issue slip prints current bed at issue time; verifier compares band not bed | Bed change fixture | — |
| A12 | Directed donation: father wants his blood for his daughter | Allowed only via BBMO note, full TTI, tagged unit; **first-degree relative units must be irradiated** (TA-GVHD) — no irradiator on site → block or outsource irradiation | Assert directed+relative without irradiation flag cannot be issued | O-8 |

### B. Timing, concurrency, race
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| B1 | Two technicians pick the same O-neg unit for two emergencies | Unit reservation is a row lock/`SELECT FOR UPDATE`; second claim fails and the picker refreshes; both attempts evented | Concurrency test, 50 parallel claims, exactly one wins | — |
| B2 | OT reserve for 4 PRBC placed; surgery postponed 3 days | Auto-release at 48 h (`blood.reserve_released`); OT list re-sequence re-requests; surgeon notified; reserve can be extended once by BBMO with reason | Timer test with clock injection | — |
| B3 | Crossmatch valid 72 h; surgery on day 4 | Ready state expires → back to `sample_pending`; chaser nudges ward for fresh sample day 3 evening | SLA expiry test | — |
| B4 | Unit expires at midnight while `issued` and in transit | Expiry check at bedside verification uses transfusion-start time; unit expiring during a transfusion that started before expiry is allowed to complete (config) | Boundary test at 23:59/00:01 | — |
| B5 | Platelets (5-day) received from sister bank on day 4 | Expiry inherited from origin, not receipt; inventory shows hours-to-expiry; Watchman flags immediately | Import fixture | — |
| B6 | Return within 30 min: clock starts at issue scan, not at ward arrival | `unit.returned` computes elapsed from `unit.issued.occurred_at`; >30 min or temp >10 °C → discard path with reason | Clock test at 29/31 min | — |
| B7 | Transfusion running >4 h (slow drip) | At 3 h 30 min ward nudge; at 4 h hard flag; nurse must stop and document; remainder discarded | Timer + eMAR interface test | — |
| B8 | Sample received but request cancelled by doctor after crossmatch | Units released to stock; crossmatch work logged; charge for crossmatch posts only if policy says (default: crossmatch charge posts on `unit.crossmatched`, not on issue) | Event → charge fixture | O-3 |
| B9 | MTP: packs issued faster than reconciliation | Each pack issue increments open-unit counter; reconciliation task auto-created at `mtp.deactivated`; no charge posts until reconciliation per unit | Reconciliation completeness assertion | — |
| B10 | Donor arrives 89 days after last whole-blood donation | Rule: 90 days (male) / 120 days (female) NBTC 2017 (config); auto-deferral suggestion with date; BBMO can override only upward (longer), never shorter | Rule table test | — |
| B11 | Component separation at 8 h 10 min after collection | FFP eligibility window (config 6/8 h) closed → FFP becomes "recovered plasma – not for transfusion" or is labelled per SOP; system prevents FFP labelling | Boundary test | — |
| B12 | Nightly job computing expiries runs while a unit is being issued | Expiry transition uses row versioning; a unit that became `issued` since the job's read is skipped and re-evaluated | Optimistic-concurrency test | — |

### C. Partial failure & downtime
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| C1 | Server down; ED needs 2 units now | Paper emergency-release form from the sealed bank kit (serial range); technician issues from physical stock using the printed unit label; backfill with `occurred_at` on recovery; bedside two-person check on paper form | Downtime drill fixture: backfilled `unit.issued` with `recorded_at` > `occurred_at`; reconciliation proves serials | — |
| C2 | Label printer dead in the bank | No unit can be released from quarantine without a printed label; fallback printer registered as device; if none, BBMO may authorise hand-written label with photo evidence — evented, surfaced in digest | Assert release blocked without `label_printed_at` unless override event | — |
| C3 | LIMS interface down; TTI results sit in the analyzer | Units stay quarantined; manual result entry with double-entry verification (two technicians) allowed as declared downtime path; reconciled when LIMS resumes (duplicate detection by unit+test+run) | Duplicate-result reconciliation test | — |
| C4 | Temperature sensor gateway offline for 3 h | Manual 4-hourly reading task auto-created for each device (§11.19-D item 33); gap shown on chart as `data_gap.flagged` (reuse ICU event) | Gap detection test | — |
| C5 | Power failure; fridge on UPS/generator; freezer alarm | Excursion sentinel raises on threshold; units in affected device move to `excursion_hold` automatically when excursion > configured minutes; BBMO decision per unit/batch | Excursion-to-hold automation test | — |
| C6 | Partial write: `unit.issued` event committed but issue slip print failed | Reprint allowed from issue record; no second `unit.issued` event; slip carries same QR | Idempotent print test | — |
| C7 | WhatsApp gateway down during donor camp reminders | Fallback ladder WhatsApp → SMS → manual list export to organiser (§11.5) | Notification fallback test | — |
| C8 | Backfill of a transfusion done on paper 2 days ago | Backfill screen accepts `occurred_at`; bedside verifier names typed from the form; unit that is physically gone but shows `available` triggers a stock discrepancy task, never a silent status fix | Assert discrepancy task creation | — |
| C9 | Bank works in commissioning/transition boundary mode (legacy paper is the source of truth until absorption date) | Module runs shadow: e-RaktKosh still fed from paper counts; absorption date flips SoT and KPI activation (S10 §12.29) | Absorption flag test | O-1 |
| C10 | e-RaktKosh portal down at daily submission | Submission queued with retry; `statutory_return.due` stays open; evidence of attempt logged for the inspector | Retry + evidence test | — |

### D. Money — billing, refunds, payer switches, packages, TPA, ceilings
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| D1 | Processing charge above NBTC/state ceiling configured by mistake | Tariff rule carries `ceiling_ref` and value; tariff activation validation refuses a base above the ceiling for the component (ceiling table is governed config) | Tariff validation test | O-2 |
| D2 | PMJAY patient receives 2 PRBC | Zero-rated line still posts (₹0, rule "PMJAY-zero") so utilisation is visible and the package claim carries the units; never an omitted line | Assert ₹0 line with rule id | — |
| D3 | Thalassaemia child registered under state free-blood scheme | Scheme registration id on patient; zero-rate; monthly scheme return counts units | Scheme rule test | O-2 |
| D4 | Self-pay patient switches to PMJAY mid-stay after 3 transfusions | §11.4 map 3: lines attributed by payer period; earlier units remain charged; later zero-rated; no retro credit unless approval | Payer-switch fixture | — |
| D5 | Family brought a replacement donor; asks for refund of processing charge | **Default: no refund/credit for replacement** (2024 NBTC/CDSCO guidance: only processing fee chargeable, replacement is not a price instrument); if owner rules a credit, it is an adjustment rule with reason, never a cash refund at the bank | Assert bank UI has no refund action | O-3 |
| D6 | Unit issued, returned within 30 min unused | No charge for the unit; crossmatch charge stands (config); `unit.returned` reverses nothing because unit charge posts only on `transfusion.started` | Charge-timing fixture | O-3 |
| D7 | Reaction after 50 mL; unit discarded | Unit charge posts (transfusion started); reaction workup tests charged? Corporate default: **no charge to patient for reaction workup** — cost centre `transfusion_quality` | Cost-centre routing test | O-3 |
| D8 | MTP: 12 units issued, 9 transfused, 2 returned in window, 1 discarded (warm) | Charges post for 9 (+1 discard to cost centre `bank_wastage_clinical`), 2 back to stock, all in reconciliation; digest shows MTP wastage | Reconciliation → charge fixture | — |
| D9 | Units sourced from sister bank at their processing fee | Inbound cost recorded on transfer; patient charged our tariff (not pass-through) unless config; margin/loss visible in Leakage Auditor | Transfer cost test | O-2 |
| D10 | TPA queries "why 3 units" | Indication code + trigger Hb + consent + episode timestamps exported in claim bundle (Claims Drafter input) | Claim bundle fixture | — |
| D11 | Package (e.g., CABG) includes 2 units; 5 used | Package overrun machinery (§11.4 map 6): units 3–5 route outside package with consent-before-accrual | Package routing fixture | — |
| D12 | Autologous unit collected, surgery cancelled, unit expires | Collection/processing charge as per policy (default: charge processing at collection); expiry to cost centre; patient informed | Fixture | O-3 |
| D13 | Donor camp costs (refreshments, certificates, transport) | Cost centre `donor_programme`; camp report carries cost per unit collected (KPI) | Cost capture test | — |
| D14 | Discount request on blood charges by consultant | Discount governance per §7; caps; reason; blood tariff lines are eligible unless config excludes | Discount cap test | — |
| D15 | GST on processing charges | Health-care services exempt; bag/consumable lines inside processing fee not split out; tariff engine category `healthcare_exempt` | GST engine fixture | — |
| D16 | Inter-bank outbound transfer priced above NBTC transfer norm | Transfer note validated against config; approval required above norm | Validation test | O-2 |

### E. Consent, legal, MLC, minors, unconscious, refusal
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| E1 | Jehovah's Witness patient with signed blood-refusal directive | Refusal flag on patient blocks `transfusion.ordered` from proceeding without doctor override + second consultant + documented reason; OT gate satisfied by bloodless plan (§11.19-D item 9) | Assert block + override path | — |
| E2 | Unconscious patient, no relative, urgent | Emergency consent path: two-doctor documented necessity note; consent captured later from relative; event chain shows necessity before issue | Emergency consent fixture | — |
| E3 | Minor patient; parents refuse transfusion for child in danger | Doctor's override path exists with medico-legal documentation and hospital ethics/legal escalation task (child welfare); consent record marks `parental_refusal_overridden` | Fixture + escalation ladder | O-9 |
| E4 | Minor donor (17 y) at camp with parent's consent | Blocked: minimum age 18 (NBTC) — no override | Rule test | — |
| E5 | MLC patient (assault) transfused | Transfusion records marked MLC-linked; retention indefinite; release only against requisition (§11.4 map 12) | Retention flag test | — |
| E6 | Wrong transfusion (ABO-incompatible) occurred | Automatic incident (severity: sentinel), legal hold on all involved records (`legal_hold.applied`), unit + samples preserved, root-cause workflow, HvPI report, management notified within 1 h; records cannot be edited, only appended | Sentinel-event fixture; edit attempt rejected | — |
| E7 | Rh-negative pregnant woman receives Rh-positive platelets in emergency | System flags Rh-mismatch for female ≤50 as requiring BBMO acknowledgment + anti-D consideration task to obstetrics (within 72 h) | Rh-mismatch flag test | — |
| E8 | Rh-negative mother post-delivery: anti-D issue | Anti-D is a pharmacy item; bank provides Kleihauer/ICT result; the maternity module's 72-h task consumes `result.verified` | Interface test | — |
| E9 | Donor asks for own TTI result | Non-reactive: disclose via counsellor; reactive: face-to-face counselling only, never WhatsApp/SMS/print; confirmatory referral (ICTC for HIV); no result on any patient-facing channel | Assert notification gateway refuses reactive-result payloads | — |
| E10 | Police ask who donated the unit given to an accused | Donor identity is confidential; release only against court order via MRD release discipline; unit-to-donor linkage query logged | Access log test | — |
| E11 | Consent form language: Bhojpuri-speaking attendant | Consent counselling recorded with language + interpreter/witness name; Hindi form printed; thumb impression path with witness | Consent metadata test | — |
| E12 | Patient signs consent for one transfusion; second unit next day | Corporate default: consent per admission episode covering the course, re-consent if >X days or new component type (config) | Consent validity test | O-9 |
| E13 | Deceased patient's unit in transit | Issue for a `patient.deceased` encounter rejected; in-transit unit recalled → return path | Fixture | — |
| E14 | POCSO case child needs transfusion | Sealed-class encounter; bank sees minimum-necessary (UHID, group, component); no name on bank worklist beyond alias | Sealed RBAC test | — |

### F. Donor management, coercion, camps
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| F1 | Ward tells family "bring 2 donors or no blood" while 6 compatible units sit in stock | Replacement donation is **never a precondition** to issue: the request workflow has no state that waits on donors; a "replacement pending" note is informational; digest shows replacement-to-issue ratio per ward; grievance hook | Assert no transition depends on donor arrival | O-4 |
| F2 | Professional (paid) donor presenting as "relative" for 3rd patient this month | Donor identity dedup (phone + id-proof hash + photo); frequency rule flags >1 replacement donation in 90 d; BBMO interview; permanent deferral for paid donation (offence under D&C Rules) | Dedup + frequency test | — |
| F3 | Donor conceals high-risk behaviour | Confidential self-exclusion option (CUE-style tick after donation: "do not use my blood") → unit discarded quietly, donor not confronted | CUE flag test | — |
| F4 | Donor faints post-donation in car park | Observation-time minimum enforced; reaction register entry even if off-site; DRRF | Fixture | — |
| F5 | Camp: 120 donors, paper questionnaires, 3 forms lost | Bags issued vs units received reconciled; missing form → unit quarantined until donor traced or discarded; camp report flags | Reconciliation test | — |
| F6 | Camp organiser (political/corporate) demands donor list | DPDP: donor list is the bank's; organiser gets counts + certificates; export requires purpose + consent flag `consent_to_recall` | Export guard test | — |
| F7 | Donor deferred permanently (HBsAg) donates again at another bank | Our register marks; e-RaktKosh donor deferral sharing where available; recall suppressed | Recall suppression test | — |
| F8 | Donor with Hb 12.3 g/dL (below 12.5) | Auto temporary deferral with iron advice + recall date; counsellor note | Rule test | — |
| F9 | Female donor: pregnancy/lactation/menstruation questions | Questionnaire versioned form; deferral rules per NBTC; no override below rule | Form version test | — |
| F10 | Donor age 64 first-time | NBTC: first-time donors ≤60 (config), repeat ≤65; rule engine | Rule test | — |
| F11 | Apheresis donor: 25th platelet donation this year | Blocked (≤24/yr); interval 48 h enforced; cumulative plasma-loss tracked | Counter test | — |
| F12 | Donor wants a certificate and a WhatsApp "thank you" | Certificate with QR; message in language preference; opt-out honoured | Notification test | — |
| F13 | Donor is a hospital staff member | Staff-as-donor record confidential class; supervisor cannot see deferral reason | Confidential test | — |
| F14 | Same donor phone used by 4 family members | Phone is not identity; id-proof + photo + DOB; soft dedup prompts | Dedup precision test | — |

### G. Testing, components, inventory, quarantine
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| G1 | HIV initially reactive, repeat-in-duplicate one reactive one non-reactive | Unit discarded regardless (any repeat reactive); donor referred for confirmatory; NACO reporting counts | Decision-table test | — |
| G2 | Malaria smear negative but rapid antigen positive | Any positive = discard; both methods recorded | Test | — |
| G3 | TTI kit lot fails daily QC | QC lockout: all results from that lot/run invalid; units stay quarantined; rerun on new lot | Lockout test | — |
| G4 | Unit released from quarantine, then reference lab confirms donor HIV+ (lookback) | Lookback workflow: locate all components from that donation and prior donations (config 12 months); recall issued units; notify recipients' doctors; register | Lookback traversal test across parent/child units | — |
| G5 | Recipient later seroconverts; hospital asked to trace donor | Trace-back: episode → unit → donor visit → donor → other components → other recipients; single query, logged | Trace-back query test | — |
| G6 | PRBC bag leaking on shelf | Discard with photo; check siblings from same bag lot; bag lot complaint to vendor (Plan 14) | Fixture | — |
| G7 | Fridge at 8 °C for 40 min | Excursion register; units in fridge → hold; BBMO decides; NBTC guidance: PRBC >6 °C beyond 30 min → discard (config) | Excursion decision test | — |
| G8 | Platelet agitator stops overnight | Platelets without agitation >24 h → discard; sentinel alarm active alert (this is a §10.3 "active alert" candidate) | Alarm + hold test | O-7 |
| G9 | Whole blood weighs 300 g (under) | Under-collection: PRBC only if within limits, else discard; rule by weight band | Weight band test | — |
| G10 | Component prep yields 2 platelet concentrates from one bag (data error) | One parent → at most one of each component type (except aliquots); validation | Schema test | — |
| G11 | Paediatric aliquots: 1 PRBC → 4 satellite bags | Aliquots inherit parent group/TTI; expiry per closed/open system; each scanned separately; crossmatch once per parent valid for aliquots (config) | Aliquot lineage test | — |
| G12 | Irradiation required; no irradiator | Send-out to partner bank for irradiation (`unit.transferred_out` reason irradiation) and back; expiry shortened to 28 d from irradiation for PRBC | Expiry recompute test | O-8 |
| G13 | Leucoreduced product requested; only bedside leucoreduction filters available | Order special requirement satisfied by "bedside filter issued" line (consumable) with nurse confirmation at verification | Requirement satisfaction test | — |
| G14 | FIFO violated: technician issues a 30-day-old unit when a 34-day unit exists | Picker sorts FEFO and warns on skip with reason; wastage KPI attributes | FEFO warning test | — |
| G15 | Stock count finds one more O+ unit than system | Discrepancy task; unit quarantined until identity resolved; never auto-added to stock | Count reconciliation test | — |
| G16 | Rare group (Bombay phenotype, Rh-null) patient | Rare-donor registry flag on donor + patient; national rare donor registry (NIIH Mumbai) contact task; phenotype fields | Registry flag test | — |
| G17 | Antibody screen positive, identification pending | Request → extended workup; suggests phenotype-negative units; send-out to reference lab; SLA extended with reason | Fixture | — |
| G18 | Group-specific stock zero; O-neg last 2 units | Substitution rules table (ABO/Rh compatible components; plasma compatibility reversed); BBMO approval for Rh-pos to Rh-neg male >50; O-neg reserved for females ≤50 and unknowns | Substitution matrix test | — |
| G19 | Reagent anti-D lot expired last night | Grouping run blocked with that lot; Watchman warned 30/7/1 d before | Lockout + warning test | — |
| G20 | Two units with the same unit number (label reprint after damage) | Unit number unique; reprint keeps number, increments `label_version`; old label void | Uniqueness test | — |

### H. Staff absence, overload, handover
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| H1 | Only technician on night; BBMO unreachable; incompatible crossmatch | Succession chain (S10 §12.16): on-call pathologist → duty manager → sister bank; chain shown in the screen; every rung evented | Escalation ladder test | — |
| H2 | Technician mid-crossmatch handed over at shift end | Crossmatch record must be signed by the performer; unfinished → reassigned with note; no split signature | Handover test | — |
| H3 | 5 emergency requests in 10 min, one technician | Worklist sorted by urgency + expiry-of-need; chaser escalates to BBMO at 10 min; ED told ETA | Prioritisation test | — |
| H4 | Bedside witness unavailable on a 2-nurse night ward | Cross-ward witness pull (S10 §11); roster guarantees ≥1 eligible witness per floor per shift | Roster validation test | — |
| H5 | Roster shows BBMO on leave, no succession published | Roster publication blocked (`roster.blocked`) | Test | — |
| H6 | New technician not yet competency-signed for crossmatch | Cannot sign crossmatch; can perform under supervision; second signature required | Competency gate test | — |

### I. Equipment failure
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| I1 | Plasma freezer fails; 200 FFP at risk | Excursion sentinel → active alert to BBMO + maintenance task + move-to-backup task; units tracked to new device; thaw status | Device-move fixture | — |
| I2 | Cell separator error mid-apheresis | Donor safety first: procedure aborted, reaction register; partial product discarded; device incident | Fixture | — |
| I3 | Centrifuge calibration overdue | Device QC due → component preparation on that device blocked (QC-lockout class) | Lockout test | — |
| I4 | Transport box logger missing | Issue allowed with manual temperature strip + note; digest flags frequency | Fixture | — |
| I5 | Barcode scanner dead at bedside | Tablet camera scan fallback; manual entry with double-key only under downtime declaration | Fallback test | — |

### J. Data quality, late-arriving, backdated
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| J1 | TTI result arrives after the unit was (wrongly) released | Release path structurally requires all results; a result arriving for an already-released unit triggers incident + lookback | Assert impossibility + incident fixture | — |
| J2 | Reaction reported 3 days after transfusion (DHTR) | Reaction can attach to a completed episode within 28 d; workup with new samples; TRRF | Late-attach test | — |
| J3 | Vitals entered at 15 min but timestamped by nurse 40 min late | `occurred_at` vs `recorded_at` shown; KPI uses occurred; digest shows late-entry rate | Timestamp test | — |
| J4 | Donor DOB typo makes them 17 | Age gate fires; correction requires id-proof re-check; audit | Correction flow | — |
| J5 | Legacy paper donor register imported (10 years, 8,000 donors) | Import quarantine with dedup; deferral flags carried; unknown fields left null not defaulted | Import fixture | O-1 |
| J6 | Unit number series from legacy overlaps new series | Prefix by era; uniqueness across both | Test | — |
| J7 | Component prepared but parent unit collection time missing | Cannot compute FFP eligibility → FFP blocked until time entered by phlebotomist with reason | Null-handling test | — |

### K. Fraud, leakage, gaming
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| K1 | Units "issued" to a ward but no `transfusion.started` and no return | Leakage Auditor triangle: issued vs transfused vs returned/discarded; open units >4 h → task; weekly orphan report | Auditor rule test | — |
| K2 | Staff sells units to an outside nursing home | Every unit disposition terminates on encounter or cost centre or transfer note with counterpart licence; e-RaktKosh stock must equal ledger; nightly parity | Parity assertion | — |
| K3 | Technician marks units "expired-discarded" that are actually sold | Discard requires two-person (authoriser ≠ executor) + BMW manifest weight linkage; discard spikes flagged | SoD + anomaly test | — |
| K4 | Ward over-orders to hoard | Reservation-to-use ratio per doctor/ward; C:T ratio > 2.5 flagged to committee (diagnostic) | KPI test | — |
| K5 | Fake replacement donor bookkeeping to waive charges | No charge instrument depends on replacement (O-3 default) → no incentive | Design assertion | O-3 |
| K6 | Doctor bills 3 units in package overrun, transfused 2 | Charges only from `transfusion.started` per unit; cannot bill without episode | Charge derivation test | — |
| K7 | Scan-time clustering (all three bedside scans within 1 s from one device) | Integrity check: verifier 2 must scan from own session/device or with own credential; clustering anomaly to Fraud Sentinel | Anomaly test | — |
| K8 | Camp organiser inflates donor count for publicity | Certificates issued only against `unit.collected`; counts derive | Test | — |

### L. Privacy, sealed records, VIP, staff-as-patient
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| L1 | VIP patient's blood request | Alias on bank worklist; issue slip shows alias + UHID; bedside scan resolves true identity only on ward device | Alias test | — |
| L2 | Staff nurse's own TTI-reactive donor result | Sealed register; only counsellor + BBMO; HR never | Access test | — |
| L3 | Donor's HIV status shared with recipient's family "to explain" | Impossible by design: recipient side never sees donor identity or results | Data-flow test | — |
| L4 | DPDP data-principal request from donor to erase | Erasure bounded by Schedule F retention; response template cites; recall consent withdrawn immediately | DSR test | — |
| L5 | Inference agent (Reaction Drafter) receives narrative with donor name | Tokenisation boundary (copilot §2.2); donor names in scrubber list | Leak fixture | — |

### M. Language, literacy, accessibility
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| M1 | Donor questionnaire for illiterate donor | Counsellor-read mode with audio prompts (Hindi/Bhojpuri audio files), thumb impression + witness | Form mode test | — |
| M2 | Consent counselling in Hindi, form in English | Bilingual print; language recorded | Print test | — |
| M3 | Donor certificate name in Devanagari | Unicode; search finds Devanagari names (11h lesson) | Search test | — |
| M4 | Colour-blind technician reading agglutination? | Not a system concern, but UI never encodes group by colour alone; text always | UI a11y test | — |
| M5 | Ward tablet: large touch targets for verification; keyboard-first at bank desk | §15 | Perf/UI budget | — |

### N. Scale (100/day → 2,000/day; 10 → 610 beds; 10 OTs; 45 ICU)
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| N1 | 40 crossmatches/day → 400/day | Worklist paging; crossmatch bench as registry resource ×n; TAT KPIs per bench | Perf test at 10× | — |
| N2 | Stock 150 units → 2,000 units across 12 devices | Inventory board grouped by device/component/group/expiry buckets; queries <300 ms | Perf budget test | — |
| N3 | 10 OTs' reserves for tomorrow: 60 units held | Reserve board with auto-release; over-reservation warning vs stock; ratio KPI | Board test | — |
| N4 | e-RaktKosh daily stock with 8 components × 8 groups | Automated payload | Payload snapshot test | — |
| N5 | Daily component separation of 60 bags | Batch screens; centrifuge run linkage; label printing throughput | Throughput test | — |
| N6 | Two sites (future) | `site_id` on all tables from day one (spec envelope) | Schema test | — |

### O. Integration failures (device/vendor/ABDM/e-RaktKosh/HvPI)
| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| O1 | ELISA reader posts result for unit number with trailing space | Normalisation at edge; unmatched results park in a reconciliation queue, never dropped | Edge parser test | — |
| O2 | e-RaktKosh schema change | Adapter versioned; failed validation → task with payload; stock parity not affected | Adapter test | — |
| O3 | Haemo-Vigil accepts only its form; no API | Drafter produces TRRF PDF/CSV in the programme's format; submission evidence (screenshot/ack no.) attached manually; `haemovigilance.reported` carries ack ref | Export format test | — |
| O4 | ABDM: patient wants transfusion record in ABHA PHR | Transfusion episode serialises to FHIR (`Procedure` + `Observation` for group); care-context via gateway | FHIR shape test | — |
| O5 | Temperature sensor vendor MQTT topic renamed | Sentinel detects silence → data-gap task; manual readings resume | Silence detection test | — |
| O6 | Sister bank's unit has ISBT-128 label; ours internal | Scanner parses both symbologies; DIN stored; local accession number printed on over-label | Symbology test | — |
| O7 | LIMS (Plan 17) not yet live when bank ships | Bank ships with manual TTI entry (double-entry); LIMS interface later; declared interface stub | Interface stub test | — |

**Row count: 116.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 09:40 — bus crash, 14 casualties, 5 need blood, one technician on duty.** 09:41 `disaster.declared` (§11.3) → bank enters surge mode: worklist collapses to emergency queue; O-neg/O-pos stock shown as a single number on the ED board. 09:45 ED activates MTP for two patients (`mtp.activated` ×2); technician issues pack 1 each under emergency release signed on tablet by the ED consultant (`unit.emergency_issued` ×8; retrospective crossmatch tasks auto-created). 09:50 Crossmatch Queue Chaser pages BBMO on-call (rung 2 at 5 min in disaster mode); BBMO arrives 10:05. 10:00 O-neg stock hits 2 → Watchman fires active alert; duty manager approves sister-bank transfer request (`blood_transfer` requested); transport attendant dispatched with logger box. 10:20 pretransfusion samples from all 5 arrive with band-scan labels; one tube's nonce mismatches (WBIT suspect, A1) → rejected, recollect task, ED told in 30 s. Humans: BBMO groups, technician crossmatches, counsellor manages the 20 relatives asking "how many donors to bring" — screen says none required (F1); they are invited to a voluntary donation after the crisis (recall consent). Agents: none act clinically; chaser and watchman nudge; Digest Writer's next-morning digest carries MTP wastage, C:T, and the WBIT near-miss. Paper path: if the server drops, the sealed kit's emergency-release forms; PBX to ED. Backfill: each paper form serial → `unit.emergency_issued` backfilled with true `occurred_at`. Audit shows: who signed each emergency release, cooler timestamps, per-unit reconciliation at `mtp.reconciled`, 3 units returned in window, 1 discarded warm with cost centre.

**6.2 Server down 02:00–05:30; a PPH at 03:10.** Duty manager declares downtime (`downtime.declared` backfilled). Maternity calls the bank on PBX; nurse sends a runner with a paper request + sample labelled by hand with two identifiers and a witness signature (the A1 protection is gone — the paper form forces two-signature identity). Technician groups and crossmatches on the bench, records on the paper crossmatch register (reserved serials), issues on paper issue form; bedside two-person check written on the form. 05:40 recovery: the technician backfills `sample.received`, `unit.crossmatched`, `unit.issued`, `transfusion.started/completed` with `occurred_at` from the forms; reconciliation screen lists every serial in the downtime range and demands each be used or voided; physical stock count at 06:00 vs ledger; discrepancy zero or task. Audit shows the `recorded_at` skew and the serials; the KPI TAT for those cases is marked `downtime` and excluded from load-normalised means but shown in the digest.

**6.3 Refrigerator #2 compressor fails Saturday 23:00, sensor gateway also down (power flicker).** 23:02 Excursion Sentinel sees silence from both → `data_gap.flagged`; creates manual reading tasks every hour for 4 devices. 23:15 night technician reads 9 °C on fridge #2 manual thermometer; enters reading → threshold rule fires `coldchain.excursion_recorded`; 48 PRBC units auto-move to `excursion_hold`. Task: relocate to fridge #1/#3 (capacity check from device attributes); technician scans each unit into the new device (`unit.moved` NEW, 48 scans, ~6 min). BBMO decides at 00:10 by duration/temperature rule: excursion 35 min at ≤10 °C → release with note (config); if >30 min above 10 °C → discard batch with two-person authorisation and BMW manifest. Maintenance task to biomedical (Plan 19-class). Digest shows the excursion, decision, units affected, ₹ value at risk. Inspector later sees: temperature chart with gap annotated, manual readings with names, excursion register row, decision, sign-off.

**6.4 BBMO no-show + inspector walk-in + incompatible crossmatch, same morning.** 09:00 Drugs Inspector arrives for SBTC joint inspection. Inspector view (read-only role) prints: donor register, TTI register, issue register, reaction register, discard register, temperature charts, QC register, licence and calibration certificates — each with QR, date range filters, Schedule F column shapes. 09:20 technician reports an incompatible AHG crossmatch for an oncology patient; BBMO not answering; succession chain: on-call pathologist (rung 2) reached at 09:35, orders antibody identification + send-out; ward informed of delay with ETA; request state `extended_workup` with SLA reset reason. 10:00 inspector asks "who released unit X from quarantine and on what results" — one query, unit timeline. 11:00 BBMO absence logged as `overload/coverage` event to duty manager; Coverage Resolver (T3, IPD-era) proposes cover. Audit: the inspector's session itself is logged (vendor/inspector access pattern, §11.19-E).

**6.5 Wrong patient nearly transfused — Tuesday evening, general ward.** Nurse A scans band of bed 7 patient; scans unit meant for bed 9; system shows RED: "UHID mismatch — unit crossmatched for another patient" → `transfusion.verification_failed`, hard stop; no override exists on that screen. Auto incident (near-miss class), ward in-charge notified, unit must return to bank (30-min clock started at issue), bank re-verifies unit integrity and re-issues to the correct patient with a fresh slip. Committee sees the near-miss with the full scan sequence (device, time, staff). Had a downtime been declared, the paper form's two-signature check would have been the only barrier — the drill measures this.

**6.6 Reactive donor, replacement pressure, and a coercion complaint in one afternoon.** 14:00 TTI run: donor D-2231 (a replacement donor brought by a patient's family) is HBsAg reactive on repeat. Unit → `tti_reactive_held` → discard path (BMW). The family is told only "the unit was not usable" — never the reason. Counsellor books a confidential face-to-face for the donor within 7 days (`donor.recall_due`, reason coded confidential; no reason in WhatsApp text). 15:00 the ward's junior doctor tells the family "arrange another donor before we issue"; family files a grievance at reception (`grievance.raised`). Digest shows the ward's replacement-pending ratio; committee agenda auto-feeds. The patient's request was `ready` since 13:30 — the system proves the unit was available and the delay was human policy, not stock. Owner ruling O-4 governs whether replacement is even recorded on the request.

**6.7 e-RaktKosh mismatch found by the State Blood Transfusion Council.** SBTC emails: portal shows 41 O+ PRBC, your monthly return says 37. Parity job history shows the ledger at each submission; two discards and two transfers-out on the 28th were submitted late because the portal timed out (C10) and the retry succeeded next morning under the next date. Evidence pack (submission attempts, payload hashes, ack numbers) generated in one click; correction submitted; committee note. Nothing hand-edited; the discrepancy has a causal chain.

---

## 7. Compliance, audit & statutory surfaces

- **Licence:** Drugs & Cosmetics Act 1940 / Rules 1945, Schedule F Part XII-B; licence Form 27C (whole blood/components; 27E where component/apheresis licence is separate), renewal application Form 26G/26I; validity 5 years post-2017 amendment (verify against the actual licence). Joint inspection by CDSCO zonal office + State Licensing Authority/SBTC. Compliance calendar (§11.19-B) carries: licence expiry, medical officer change intimation, equipment additions, layout changes (require prior approval), annual returns.
- **Standards:** NBTC/NACO *Standards for Blood Banks & Blood Transfusion Services*; NBTC donor selection & deferral guidelines 2017; NBTC processing-charge ceiling circulars (2014 base; state GOs); NBTC 2023–24 directive on no charges beyond processing fee and no replacement pricing; NACO TTI testing guidelines; e-RaktKosh mandatory reporting (NHM/NBTC); Haemovigilance Programme of India (NIB Noida) — TRRF/DRRF via Haemo-Vigil; NABH 5th ed. standards for blood bank/transfusion (MOM/COP chapters) and NABH blood bank accreditation programme; NABL ISO 15189 where the TTI lab is under LIMS scope; BMW Rules 2016 (discarded bags, category yellow, autoclave/incineration by CBWTF; manifest per bag); DPDP Act 2023 (donor and TTI data — sensitive class); Clinical Establishments Act tariff display (processing charges displayed); Transplantation of Human Organs Act not applicable except cross-reference for tissue.
- **Statutory registers as tables (print in Schedule F shape):** donor register · donor deferral register · TTI test register (per test, with kit lot, controls) · TTI-reactive/confidential register · component preparation register · blood/component stock register (daily) · issue register · transfusion reaction register · discard/wastage register · temperature charts (per device, 4-hourly or continuous) · equipment QC & calibration register · reagent QC register · bag/reagent lot register · inter-bank transfer register · camp register · autologous register · apheresis register · MTP/emergency uncrossmatched release register · lookback/trace-back register · compliance/inspection register.
- **Consent forms (signed by whom):** donor consent (donor + counsellor/witness; Hindi/English; minor impossible) · apheresis consent (donor + BBMO) · transfusion consent (patient/guardian + treating doctor + witness; refusal form same shape) · emergency release/uncrossmatched (treating doctor, two signatures) · directed/autologous consent · TTI-result disclosure acknowledgement (donor + counsellor).
- **What the inspector demands:** licence + MO qualification, staff list with qualifications, donor questionnaires (sample), TTI raw data and kit QC, temperature charts with alarm logs, discard register with BMW manifests, issue register with crossmatch evidence, reaction register with workup, calibration certificates, stock vs e-RaktKosh, layout. What NABH asks: policy for transfusion, C:T ratio, reaction rate, wastage, bedside verification compliance, committee minutes, staff training records.
- **DPDP data classes:** donor identity + contact (personal; purpose: donation, recall — consent-based) · donor health questionnaire + TTI results (sensitive; sealed) · patient immunohaematology + transfusion (health data; encounter-scoped) · staff credentials (staff data) · inference payloads (tokenised, copilot §2.2).
- **Retention:** as §4 — ≥5 y statutory, recommended 10 y, reactive register + MLC permanent.
- **Audit surfaces:** every unit has a complete timeline (collection → disposition) queryable in one screen; every scan carries device + staff; every override evented and in the digest; register prints carry QR + generation hash.

---

## 8. Staff KPI & KRA

All KPIs event-derived, diagnostic, load-normalised (S10 §2), formulas headed for the KPI formula registry (roadmap note 5). Gaming checks route to Fraud Sentinel as diagnostics.

**Blood Bank Technician (19b)** — KRA: provable chain, testing integrity, cold chain, stock truth.
| KPI | Formula (events) | Normalisation | SLA link | Diagnostic reading / gaming resistance |
|---|---|---|---|---|
| Crossmatch TAT | median(`unit.crossmatched.at − sample.received.at`) by urgency | per requests/shift, staff on duty | routine 2 h / urgent 45 min / emergency 15 min | Long TAT with high load = staffing, not person; gaming (marking received late) caught by sample-collected→received gap |
| Emergency issue TAT | `unit.issued − transfusion.ordered` for emergency/MTP | per emergency count | 15 min | — |
| Label/scan compliance | scans with `manual_entry:false` / all | — | — | Manual entries listed by name; clustering flagged |
| Temperature log completeness | manual readings done / due when sensors down | devices × hours | 4-hourly | — |
| Quarantine release correctness | releases with all gates satisfied / releases (should be 100% structurally) | — | — | Any non-100% is a code bug, not a person |
| FEFO adherence | issues where a shorter-expiry compatible unit existed / issues | stock depth | — | High skip rate with reasons = policy review |

**BBMO (19a)** — KRA: safe release decisions, reaction management, statutory standing, wastage.
| KPI | Formula | Normalisation | Reading |
|---|---|---|---|
| Unit wastage % | `unit.discarded` (reason ≠ TTI/QC) / (`unit.collected` + `unit.transferred_in`) monthly | by component | Target <3% (S10 OKR); expiry-driven wastage = over-collection or poor forecasting; committee agenda |
| TTI reactive rate | reactive donations / donations, by donor type | camp vs walk-in vs replacement | Replacement-heavy reactive rate is the coercion signal |
| Reaction documentation 100% | `transfusion.reaction_flagged` with `reaction.workup_completed` + `haemovigilance.reported` / flagged | — | Any gap = open task |
| Reaction rate | reactions / `transfusion.completed` | by component | Rising FNHTR → leucoreduction policy |
| C:T ratio | `unit.crossmatched` / `transfusion.started` | by ward/doctor | >2.5 = over-ordering conversation |
| Emergency uncrossmatched % | `unit.emergency_issued` / issued | — | Rising → ED/OT process |
| Statutory returns on time | `statutory_return.filed ≤ due` | — | — |
| Succession coverage | shifts with published succession / shifts | — | — |

**Donor Counsellor/Organiser (19c)** — KRA: safe, willing, returning donors.
| KPI | Formula | Reading |
|---|---|---|
| Voluntary share | voluntary `unit.collected` / all | Target rising toward 100% voluntary (national policy) |
| Donor return rate | donors with ≥2 visits in 12 m / donors | Recall effectiveness |
| Deferral rate & reasons | `donor.deferred` / `donor.screened` by reason | High Hb deferral → outreach nutrition messaging |
| Reactive-donor counselling closure | disclosures within 14 d / reactive | Confidential; count only |
| Donor reaction rate | `donor.reaction_recorded` / collections | Camp vs bank |
| Camp yield & cost/unit | units / expected; cost centre / units | Organiser quality |

**Transfusion Nurse (ward)** — KRA: right patient, monitored transfusion.
| KPI | Formula | Reading |
|---|---|---|
| Bedside verification compliance | episodes with two distinct verifier scans / episodes | Structural 100%; downtime cases excluded and listed |
| Vitals set completeness | episodes with pre/15-min/hourly/post vitals / episodes | Load-normalised by patients assigned |
| Issue-to-start time | `transfusion.started − unit.issued` | >30 min = return-window breach; ward transport pattern |
| Return-window breaches | returns >30 min / returns | — |
| Reaction first-response time | `transfusion.stopped − onset` | — |

**Owner's 8 a.m. digest (department card):** stock by group/component with days-of-cover · units expiring ≤7 d (₹ value) · yesterday's issues/transfusions/returns/discards · wastage MTD % · C:T ratio by top 5 ordering doctors · emergency uncrossmatched count · reactions (count, any sentinel) · open reconciliation tasks (MTP, downtime, count discrepancies) · cold-chain excursions · e-RaktKosh parity status · replacement-pending mentions by ward (coercion signal) · licence/return countdowns · donor camp pipeline.

---

## 9. AI agents & the copilot — where inference earns its place

**Rule applied:** every candidate first tried as a deterministic automation; only the reaction-report drafter needs a model.

| # | Name | Automation/agent | Tier | Trigger/inputs | Output | Human sign-off | Fail-open path | Kill-switch scope | Provenance | Eval/guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Expiry & Inventory Watchman (blood scope)** — extends §16 Expiry Watchman | automation | T1 | nightly + on every unit event; stock by group/component/expiry buckets; par levels (config); reagent/bag lots; licence/calibration dates | nudges: expiring ≤7/3/1 d list to BBMO; below-par O-neg active alert; reagent lot expiry; FEFO suggestions to picker; e-RaktKosh parity mismatch task | none (nudge) | screens show the same buckets; manual stock check SOP | `agent:expiry_watchman` | n/a (rule) | rule fixtures; alert-count budget per day (fatigue guard) | none (no PHI; unit ids) | Blood bank plan T-series 1 |
| 2 | **Donor Recall** — instance of Recall & Follow-up | automation | T1 | donor eligibility date reached; group shortage forecast (par × days-of-cover); donor `consent_to_recall`; language pref; camp schedule | WhatsApp/SMS invitation (template, no health info); call-list for counsellor; camp reminders | none | counsellor's manual call list | `agent:donor_recall` | n/a | never sends to deferred_perm or TTI-reactive; message templates contain no reason text; rate limits | donor contact (consent-based) | same plan, after Plan 10 templates |
| 3 | **Crossmatch Queue Chaser** — SLA Chaser instance | automation | T1 | request state age vs urgency SLA; staff on duty; succession chain | nudges to technician → BBMO → duty manager; ETA post to ward's Journey Feed | none | ward phones bank (PBX) | `agent:sla_chaser` | n/a | ladder fixtures; disaster-mode compressed ladder | encounter refs only | same plan |
| 4 | **Reaction Report Drafter** | **agent** (inference) | **T2** (clinical cap) | on `transfusion.reaction_flagged`: tokenised fact sheet — episode timeline, vitals series, unit data (component, age, group), workup results, symptoms checklist; prompt playbook versioned | draft TRRF fields (category/severity/imputability *suggestions*, narrative), draft incident narrative, draft committee summary; typed claims citing fact-sheet line ids (copilot §2.4) | BBMO edits and signs; category/imputability are BBMO's decision — the draft is a restatement | BBMO fills TRRF manually (form exists regardless) | `agent:reaction_drafter` | model id, prompt version, input/output hashes into `haemovigilance.reported` and the signed TRRF | entailment fixtures on 30 synthetic reactions; uncited claims dropped; leak scrubber (donor/patient names) | health data, tokenised; DPIA addendum | after 12a runtime; Phase C of copilot |
| 5 | **Cold-chain Excursion Sentinel** | automation | T1 (moves units to hold = state change under rule, still T1 nudge-class because BBMO decides disposition) | MQTT/sensor readings, manual readings, silence detection | excursion events, auto-hold, tasks, active alert on freezer/agitator | BBMO decides disposition | manual thermometer rounds | `agent:coldchain_sentinel` | n/a | threshold fixtures; silence fixtures | none | same plan (sensors optional; manual tasks day one) |
| 6 | Leakage Auditor (existing T0) | automation | T0 | unit movement events | issued-not-transfused-not-returned triangle; discard spikes | — | — | existing | — | — | — | extend in this plan |
| 7 | *Deferred:* Inventory forecaster (S10 A3) | agent | T2 | seasonal demand, OT list, ICU census | collection targets/camp scheduling suggestions | BBMO | — | — | — | needs 12 months of baselines | none | post-baseline |

**Three presentation lanes for this department:** Lane 1 hand-built keyboard-first screens: issue desk (scan-scan-print), crossmatch bench worklist, bedside verification (tablet, large targets), donor screening form. Lane 2 schema-generated worklists/forms: deferral register views, discard authorisation, transfer requests, camp kit issue, QC entry, inspector register prints, excursion decisions. Lane 3 conversational copilot (after 12a spike; ops roles first): "how many O-neg PRBC expire this week?", "draft the discard batch for fridge 2 excursion" → propose→confirm; "what is our reaction protocol?" → governed Expertise store read with version cited (roadmap note 8). **Journey Feed contributions:** `transfusion.ordered`, `sample.received`, `unit.crossmatched` (ETA), `unit.issued`, `transfusion.started/completed`, reactions — the ward sees the bank's progress in the patient's timeline without phoning; the bank's "block" (incompatible, refusal flag) appears as the engine refusing a transition with reason.

**Prompt inputs (Reaction Drafter), concretely:** `[PT-1]` age band, sex, diagnosis category, transfusion history count, prior reaction flags; episode lines L1..Ln (issue time, start, stop, volume, vitals rows); unit lines (component, ABO/Rh, age days, special flags); workup lines (DAT, repeat groups, haemolysis, culture); nurse's symptom checklist (enum) + free-text scrubbed. Output: typed claims only; renderer drops uncited claims.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context:** unit barcode (Code 128 internal or ISBT-128), issue slip QR, patient band QR, staff badge; every desk/tablet scan resolves full context <300 ms.
- **Label discipline:** no hand-written labels ever; label printed only from state (quarantine release, sample collection at bedside). Thermal printers at bank + each ward's transfusion cart (or ward printer).
- **Bedside verification screen:** three scans, one screen, green/red, no free text; verifier 2 authenticates on own credential; 20-second target end-to-end.
- **Issue desk:** scan request slip → suggested FEFO-compatible units listed → scan unit → confirm → slip prints; target 60 s/unit.
- **Crossmatch worklist** sorted by urgency + need-by; TAT clock per request visible to ward in Journey Feed (removes phone calls).
- **Pre-filled order form:** last group, last transfusion, allergy, refusal flag, pregnancy/Rh prompt, indication list with trigger values; consent status inline.
- **Reserve board** for OT: tomorrow's list → reserves auto-proposed from list's "blood reserve" field; auto-release visible.
- **Inventory board:** group × component × expiry-bucket heat grid; hours-to-expiry for platelets; device map.
- **Cold chain:** sensors publishing MQTT → thresholds → auto-hold; manual fallback tasks; charts print for inspector.
- **Register prints in statutory shape, QR-signed**, generated on demand — the inspector's day becomes 10 minutes.
- **Mobile/tablet:** donor screening on tablet at camps (offline-capable PWA with queue-sync); ward verification on ward tablet.
- **Voice:** none (no lawful/useful case; reaction narrative typed).
- **Targets:** crossmatch routine TAT ≤ 60 min median; emergency issue ≤ 10 min; verification 100% two-scan; wastage <3%; C:T <2; return-window breaches <2%; zero hand-written labels; e-RaktKosh parity 100% daily; TRRF within 24 h internal 100%.

---

## 11. Integrations, devices & dependencies

| Item | Detail |
|---|---|
| TTI analyzers | ELISA readers/washers (e.g., Bio-Rad, Erba, Transasia), CLIA (Abbott Architect/Alinity, Roche cobas, Ortho Vitros) — via **LIMS Plan 17** edge (ASTM/HL7 v2) and LIMS's declared result interface; NAT (Roche cobas/Grifols Procleix) if adopted, same route |
| Immunohaematology | Manual tube/gel (Bio-Rad ID-gel, Ortho BioVue, Tulip Matrix); automated (Ortho Vision, Bio-Rad IH-500) — HL7/ASTM via edge; day one manual entry with double-key |
| Cold chain | Blood bank refrigerators (Remi, Bluestar, Haier Biomedical, Vestfrost), −40 °C plasma freezers, platelet agitator/incubator (Helmer, Remi), with temperature sensors (Wi-Fi/LoRa/MQTT loggers e.g., Elpro, tempsens; or Tuya-class with local gateway) → Mosquitto → TimescaleDB pattern (§5); transport boxes with data loggers |
| Labels/scanners | Zebra/TSC thermal printers; 2D scanners (Zebra DS2208/Honeywell); tablet camera fallback |
| Cell separator | Haemonetics MCS+, Trima, Fresenius Amicus — device event capture optional; procedure record manual |
| e-RaktKosh | NHM portal; API/bulk upload availability varies by state — adapter with manual fallback; daily stock, donor camps, transfers |
| Haemo-Vigil (HvPI) | Form-based; export in required layout; ack ref stored |
| ABDM | FHIR `Procedure`/`Observation` via gateway (§6) |
| Edge-service rule | all device I/O through the Node/TS edge on a mini-PC with SQLite buffer; core never speaks serial/MQTT directly |
| Dependencies | Plan 13 registry (rooms/devices/benches) · Plan 14 procurement (bags, reagents, lots) · Plan 15/major OT (reserves, MTP) · Plan 17 LIMS (TTI results) · Plan 10 notifications (donor recall) · 12a runtime (drafter) · Quality pack (committee, incident) · nursing/eMAR (vitals, administration) · compliance calendar |
| Events consumed | `order.placed`(blood) · `mtp.activated` · `ot.booked` (reserve) · `patient.deceased` · `patient.merged` · `refusal.recorded` · `downtime.declared/ended` · `result.verified` (LIMS TTI) · `utility.threshold_breached` · `roster.published` |

---

## 12. Buy vs build, hardware & rough INR budget

**Build:** the module (own tables, workflows, registers, e-RaktKosh adapter, HvPI export, bedside verification). Commercial blood-bank software exists (e.g., eSwasthya-class, vendor BBMS) but it would break law 1 (one spine, one bedside-scan discipline shared with EBM/narcotics) and none integrates the ward side; the bank is small enough to build. **Buy:** sensors/loggers, printers, scanners, immunohaematology and TTI instruments (already owned), vendor middleware where an analyzer requires it, Haemo-Vigil (free), e-RaktKosh (free).

| Item | Qty (today → 610 beds) | INR (approx.) |
|---|---|---|
| Thermal label printers (bank 2, wards/OT/ICU carts) | 3 → 15 | ₹15k each → ₹0.5–2.5 L |
| 2D barcode scanners | 4 → 25 | ₹6–8k each → ₹0.3–2 L |
| Ward/bank tablets (verification, donor screening) | 3 → 20 | ₹20–30k each → ₹0.6–6 L |
| Temperature sensors/loggers + gateway | 6 devices → 20 | ₹8–15k per point + ₹30k gateway → ₹1–3.5 L |
| Transport boxes with loggers | 3 → 12 | ₹10–25k each → ₹0.5–3 L |
| Edge mini-PC (shared with lab edge) | 1 | ₹40k |
| Optional later: automated IH analyzer / NAT (owner purchase, clinical policy) | — | ₹25–60 L / ₹1–2 Cr + reagents (out of module budget) |
| Optional: irradiator (typically not bought; outsource) | — | ₹1.5–3 Cr — recommend outsource |
| **Module-scope total day one** | | **≈ ₹4–8 L hardware** |

---

## 13. Owner rulings needed

- **O-1 Absorption date & legacy import scope.** Recommend: absorb the bank as the first unit of IPD cluster step 4(c) with a 30-day shadow (paper remains SoT, system fed in parallel) and import the legacy donor register (dedup-quarantined) but not historical unit registers (kept as scanned PDFs under the compliance calendar). Why: the inspector needs continuity, not migration risk.
- **O-2 Pricing table.** Recommend: base processing charges = state/NBTC ceiling for private banks per component (verify current GO), governed config with ceiling reference; zero-rate for PMJAY, state free-blood schemes and registered thalassaemia/haemophilia/sickle-cell patients; sister-bank inbound cost not passed through. Money → owner.
- **O-3 Charge timing & replacement credit.** Recommend: crossmatch charge on `unit.crossmatched`; unit charge on `transfusion.started`; **no replacement-donor credit or refund instrument at all**; reaction workup and MTP wastage to named cost centres. Why: NBTC direction and coercion prevention.
- **O-4 Replacement donation policy.** Recommend: replacement donation is recorded as a donor-type only; the request workflow has no state or field that waits on it; ward-side "replacement pending" is a coercion signal in the digest, not a gate. Policy → owner.
- **O-5 Two-sample rule for first grouping.** Recommend ON (corporate standard; costs one extra tube). Clinical policy with cost.
- **O-6 Electronic crossmatch.** Recommend OFF permanently at this scale (requires validated IH automation + two-sample history + antibody screen infrastructure); revisit only with NABH blood bank accreditation.
- **O-7 Active alerts at go-live (§10.3 says selective).** Recommend adding: freezer/agitator excursion, O-neg below par, quarantine backlog >24 h. Everything else recorded, not alerted.
- **O-8 Irradiation & special products.** Recommend: outsource irradiation via a partner bank (agreement), block directed first-degree-relative units without irradiation, bedside leucoreduction filters stocked. Purchase/legal → owner.
- **O-9 Consent validity & minor-refusal escalation.** Recommend: consent per admission episode; re-consent for new component class or >30 days; parental refusal for a minor in danger escalates to a two-consultant + medical superintendent documented decision with legal counsel template. Legal exposure → owner.
- **O-10 Plan number & sequencing.** Recommend a dedicated plan (proposed **Plan 24 — Blood bank & transfusion**, placeholder until the series editor allocates) after Plan 17 LIMS and the IPD nursing/eMAR plan, with bedside verification shared with EBM/narcotics two-person verify.

---

## 14. Plan sketch

**Plan 24a — Bank core (donor → unit → inventory → registers):** T1 schema (donors, visits, units, TTI, components, registers, devices as registry resources, kinds/status vocabularies) · T2 donor workflow + screening form (versioned) + deferral rules table + consent · T3 unit workflow (quarantine gates, component prep, expiry engine, FEFO picker) · T4 TTI entry (manual double-key) + LIMS interface stub + lookback/trace-back queries · T5 cold-chain: device readings, manual task fallback, excursion sentinel, auto-hold · T6 discard register + BMW manifest link + Watchman (blood scope) · T7 e-RaktKosh adapter + parity job + statutory register prints (inspector view) · T8 legacy donor import (quarantine) · T9 fixtures from §5 A–C, F, G, I–K; adversarial pass; deploy in shadow mode.
**Plan 24b — Transfusion chain (order → issue → bedside → reaction):** T1 request workflow + order form + refusal/consent gates + sample rule + two-sample config · T2 grouping/antibody/crossmatch records + bench worklist + chaser · T3 issue desk + slips + transport task + return window · T4 bedside verification (tablet) sharing the two-person verify component with EBM/narcotics · T5 reaction workflow + TRRF export + HvPI evidence · T6 MTP integration + emergency release register + reconciliation · T7 OT reserve integration (48-h auto-release) · T8 charges (P6) per O-2/O-3 + scheme zero-rating · T9 inter-bank transfer + shortage ladder · T10 KPIs into formula registry + digest card · T11 fixtures §5 A, B, D, E, H, L–O; chaos drills 6.1–6.5 as scripted tests.
**Plan 24c (later) — Reaction Report Drafter** on the 12a runtime, after DPIA addendum; camps offline PWA; apheresis sub-flow; inventory forecaster after 12 months.

**Gates before authoring:** Plan 13 shipped (kinds available; DD6 occupant question for donor couches answered) · Plan 14 lot/batch interface exists · Plan 17's result interface contract published (or explicit stub decision) · nursing two-person verify component designed once (owner: which plan owns it) · rulings O-1…O-4 · owner supplies: licence copy (form, validity, MO name), current registers (photos of one page each), current price list, equipment list with sensor capability, sister-bank agreements, e-RaktKosh credentials/state process, HvPI enrolment status.

**Negative-space question:** *what absence is a signal here?* — a request `ready` for >2 h with no `unit.issued` (ward waiting for a donor = coercion); a unit `issued` with no `transfusion.started` and no return (leakage or unverified transfusion); a fridge with no reading for 4 h; a reaction `flagged` with no `haemovigilance.reported` in 7 d; a donation month with zero deferrals (screening not happening); a camp with zero donor reactions across 150 donors (not recorded); zero manual-entry scans on a ward whose scanner has been dead for a week (they are not verifying); a month with zero discards (expired units are being issued or not logged).

**Staff edge-case interview questions (department head / technician / counsellor):**
1. Show me the last time you issued blood during a power cut — what did you write, where?
2. How do you decide when a fridge excursion means discard? Is it written anywhere?
3. What happens when a family says they cannot find a donor? Who talks to them?
4. When was your last incompatible crossmatch and who did you call at night?
5. How do you label a unit today, and has a label ever been wrong?
6. What do you do with a reactive TTI result at 6 p.m. on a Saturday?
7. How do you count stock for e-RaktKosh, and how often does it not match?
8. Have you ever had a unit come back from a ward after an hour? What did you do?
9. How are platelets handled when the agitator trips?
10. What does the inspector ask first, and which register takes longest to produce?
11. Do you ever hold O-neg for a specific surgeon? How is that recorded?
12. Has anyone ever asked you for a donor's name or result? What did you say?
13. Which forms do families sign, in which language, and who witnesses a thumb impression?
14. How do you handle a sample tube that arrives without a request form?

---

## 15. Open questions & risks

1. **Plan 13 DD6 occupant contract vs donor couches** — does a registry `bed` admit `occupant_type: donor_visit`? If not, donor couches are room attributes, not resources. Needs a Plan 13 reading.
2. **Who owns the two-person verification component** shared by transfusion, EBM, narcotics and counts — nursing plan or kernel? Recommend kernel UI component + per-module rules; unassigned.
3. **LIMS Plan 17 timing** — if the bank ships before LIMS, TTI results are double-keyed; acceptable, but the interface contract must be frozen early so the bank does not build a private analyzer path.
4. **Exact current ceiling GO for this state and the 2024 NBTC pricing directive text** — to be fetched and attached before tariff config; this document does not assert the numbers.
5. **e-RaktKosh technical route** (API vs portal upload) differs by state; unknown for this state.
6. **ISBT-128 adoption** — cost (ICCBBA registration) vs benefit at this scale; recommend internal Code 128 with DIN-compatible structure, revisit at NABH blood bank accreditation.
7. **Licence form specifics** (27C vs 27E, validity) must be verified against the physical licence; the document uses the common shape.
8. **Risk:** bedside verification adoption on wards before ward tablets exist — mitigation: bank-side issue scan + printed slip with QR works with any USB scanner at the nursing station; tablet later.
9. **Risk:** the shadow period doubles work for two staff; mitigation: absorb registers one at a time (issue register first — it is the safety register), donor register last.
10. **Risk:** alarm fatigue from cold-chain sensors with poor placement; mitigation: hysteresis + minutes-over-threshold rules, tuned in shadow.
