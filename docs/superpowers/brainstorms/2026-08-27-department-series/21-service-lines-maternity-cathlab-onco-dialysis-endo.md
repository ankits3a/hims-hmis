# 21 — Service Lines: Maternity & NICU, Cath Lab & Cardiology, Oncology (Chemo Day-care & Radiation), Dialysis, Endoscopy, Paediatrics — Brainstorm & Planning

Date: 2026-08-27 · Status: **Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED**

**Executive summary.** This document is the clinical/service-line layer for six floors on the owner's real floor list (§11.19-A): mother & child, heart floor + cath lab, cancer floor (chemo day-care + LINAC/brachy), dialysis, endoscopy, and paediatrics (a ward/PICU variant that cuts across the first five). Each line inherits the fabric (P1–P7, workflow definitions, event spine, leakage principle, agent tiers) and gets its own compact set of flows, registers, ≥15 edge rows, a chaos day, compliance surface, KPIs and agents. It is NOT the generic session-bundle machinery — document 04 owns courses/sessions/bundles and proposes Plans 20/21/22; this document supplies the clinical specifics those plans consume, and proposes Plans 23–27 for the lines document 04 does not cover. It is NOT IPD, ICU, OT, pharmacy, LIMS or radiology — those own their tables; we reference them. It does not re-litigate any §11.17/§11.19-A lock. The three hardest problems: (1) **two-patient encounters** — mother+baby dyads and the guardian/minor model create identity, consent, billing and privacy edges nowhere else in the hospital (POCSO on a pregnant minor, sealed MTP register, wrong-milk as the NICU's transfusion error); (2) **vendor-boundary clinical truth** — cath consignment, LINAC R&V/TPS, dialysis machines and endoscope reprocessors all hold facts the HMIS must orchestrate around but never own, with statutory registers (AERB, NDPS, PCPNDT) that must be first-class tables regardless; (3) **decision-forcing clocks under 30 minutes** — LSCS decision-to-delivery, STEMI door-to-balloon, chemo gate, emergency dialysis — where the system's job is to make the *absence* of a decision visible without becoming an alarm generator.

---

## 1. Frame — what exists, what is locked, what this document adds

**Locked decisions inherited (cited, not re-opened):**
- §11.17 maternity: longitudinal pregnancy record; high-risk flags follow the patient; missed high-risk ANC = clinical recall; POCSO intimation forced on minor pregnancy; partograph as decision-forcing workflow; CTG as telemetry; `lscs.decided` → incision 30-min D2D clock routed to nearest ready ED theatre; obstetric codes (PPH→MTP-massive-transfusion, eclampsia, cord prolapse); infant abduction code; registers (delivery, partograph, APGAR, placenta BMW, stillbirth vs live-birth, POCSO, MTP-Act `termination.recorded`); dyad worklists; NICU = ICU-hall variant with own admission, inherited payer; EBM barcoded + scanned before every feed; JSY/JSSK payer tags day one. Events: pregnancy.risk_flagged · labor.triaged · partograph.action_crossed · ctg.abnormal_flagged · lscs.decided · delivery.recorded · apgar.recorded · termination.recorded · pocso.intimated · ebm.verified.
- §11.4 map 2: baby = real patient at birth with own UHID linked to mother; twins separate; paired wristbands; hard-stop double-scan on every baby handover including feeding; baby's routine charges ride mother's bill; birth immunisations start the vaccination-reminder relationship. Map 11: day-care cascade, missed session = clinical alert not a no-show. Map 6: package overrun consented before accrual. Map 3: payer switch requires counselling + consent.
- §11.19-A cath lab: consignment inventory (scan-on-use = charge + patient sticker + vendor liability in one event); `stemi.diagnosed` → `balloon.inflated` 90-min auto-derived; radiation-dose log per procedure; cath reports to PACS. Cancer floor: chemo regimen engine (cycles, BSA from captured height/weight, pre-chemo lab hard gate); tumour board as multi-doctor decision workflow; palliative narcotics on NDPS machinery; **RT = buy vendor R&V + TPS, HMIS orchestrates** (referral → planning handoff → fraction events back → per-fraction/package billing → summary); AERB registers in HMIS (brachy source movement, TLD reads, machine QA with QA-fail = machine blocked); RSO + medical physicist in credential registry; missed fraction = recall; cumulative dose ledger per site. Dialysis: RO water as utility telemetry + conductivity/endotoxin register; seropositive machine segregation as hard rule on the session board. Endoscopy: reprocessing traceability with dwell times; scope-to-patient linkage per procedure. Events: consignment.deployed · stemi.diagnosed · balloon.inflated · regimen.cycle_started · chemo.gate_blocked · tumor_board.decided · water_quality.recorded · scope.reprocessed · fraction.delivered · rt_qa.recorded · source.movement_recorded.
- §11.19-C: item 5 sealed event class (HIV Act, MTP, PCPNDT); item 6 Form-F on any USG on a woman of reproductive age incl. portable; item 9 NRP neonatal code with resuscitaire check chain; item 13 device-billing reconciliation for every powered modality incl. dialysis/endoscopy. §11.19-D-31 guardianship model with authority scope and sensitive-context override. §11.19-E E-A-3 chaperone framework + S10 §12.25 roster gate; E-20 external-access personas; E-31 ICD-10/procedure codes capturable at order/pre-auth.
- §11.8: chemo high-alert → two-nurse administration + pharmacist compounding verification; paediatric dose-range flags use vitals-desk weight; NDPS double-lock/witness/second factor; contrast consent + creatinine gate; pregnancy check before X-ray/CT.
- §11.18: gender-segregation as a bed-board hard rule; paediatric parent-stay pass variant; NICU bed class. §11.15: ICU-hall telemetry pipeline (vendor CMS → HL7 → MQTT → TimescaleDB), nurse-validated hourly chart is the legal record, device-telemetry reconciliation. §11.16: emergency theatres in ED in permanent insert mode; §11.16-A day-care encounter type + `daycare.converted_to_admission`.
- §7/§11.11: prepaid day-care bundles on entitlement counters (Plan 09 shipped: `membership_plans.kind`, `entitlement_counters`, `entitlement_movements`); best-single-benefit; tariff lock at admission; refunds to payer.
- §16: automations vs agents; clinical cap T2–T3; fail-open; provenance; global halt. Copilot design laws 1–9 (narrate never originate; one permission-filtered sheet per caller; four-state render).
- Plan 13 DD4: registry kinds closed at ten; movable assets with a lifecycle are module tables with FK to `device`.
- Document 04: `sessions` module owns episodes/plans/sessions/bundles; Plan 20 core+physio, Plan 21 dialysis, Plan 22 chemo day-care. **This document does not redefine those; it fills their clinical sections and proposes sibling plans.**

**Scope boundaries / table ownership (proposed).** `maternity` module owns pregnancy records, labour/partograph, deliveries, births, NICU-specific registers (EBM, KMC), MTP/POCSO/MDSR registers, dyad links. `cardiology` owns STEMI cases, cath procedures, dose log, post-PCI monitoring, rehab plans; consignment ledger is Plan 14's (procurement) — cardiology consumes its interface. `oncology` owns regimens, cycles, tumour-board records, RT courses, AERB registers, dose ledger; drug lines from `formulary`, dispensing from Plan 16, labs from Plan 17. `sessions/dialysis` (Plan 21) owns prescriptions, runs, machine classes, water/disinfection registers; `sessions/chemo` (Plan 22) owns cycle execution. `endoscopy` owns procedure records, scope instances (FK to registry `device`), reprocessing cycles, biopsy chain handoff to Plan 17 histopath. `paediatrics` is NOT a module — it is a set of rules (weight-based dosing, guardian consent, immunisation schedule) living in `formulary`, `patients`, and IPD/ICU, plus a PICU hall. Neighbours: `patients` (UHID, guardians, ABHA), `opd` (encounters), IPD (admissions, bed board — future), ICU (halls, telemetry), OT (theatres, WHO checklist), `billing` (charges, packages), `membership` (bundles), `notifications`, `formulary`, Plan 14 procurement (consignment), Plan 16 pharmacy, Plan 17 LIMS, Plan 18 radiology (Form F, PACS refs), Plan 19 BMW.

**What this document adds:** per-line workflow definitions with SLAs; statutory registers as tables; ≥90 edge rows; chaos days; agents that earn their place; plan split 23–27 aligned with 20/21/22.

---

## 2. Actors, roles & role cards

| Role | S10 card | Line | Notes (shift · bundling · SoD) |
|---|---|---|---|
| Obstetrician | 14 | Maternity | 24×7 rota; owns partograph decision, D2D; never signs own MDSR review |
| Labour-room nurse / midwife (ANM/GNM) | proposed **new card 40** | Maternity | 1:1 active labour; partograph entries; band pairing; witness for EBM |
| Neonatologist / paediatrician | proposed **41** | NICU, Paeds | NRP responder role; NICU admission authority; weight-based order review |
| NICU nurse | 21 variant | NICU | 1:2; EBM double-verify; KMC tasks; never pairs with the same witness >70% of scans (dyad analytics S10 §12.23) |
| Lactation counsellor | proposed **42** | Maternity | day shift; EBM labelling education; part of discharge readiness |
| Cardiologist / interventional cardiologist | 16 (visiting panel) + fee-split | Cath | STEMI activation authority; cannot approve own consignment reconciliation |
| Cath lab technologist | 18 variant | Cath | dose log, consignment scan-on-use; never the consignment count verifier |
| Cardiac rehab physiotherapist | 30 | Cath | Plan 20 machinery |
| Medical oncologist | proposed **43** | Onco | regimen authoring; cycle clearance; BSA second signature never self |
| Oncology pharmacist (compounding) | 25 variant | Onco | compounding verification; never the administering nurse |
| Chemo nurse (day-care) | doc 04 card | Onco | two-nurse admin; spill/extravasation register |
| Radiation oncologist | proposed **44** | RT | prescription (dose/fractions/site); plan approval in vendor TPS; fraction sign-off |
| Medical physicist | proposed **45** | RT | QA, TLD, source custody; credential registry (§11.19-A) |
| Radiation Safety Officer (RSO) | proposed **46** | RT | AERB registers signatory; QA-fail block release; TLD anomaly action; often = physicist, SoD: RSO cannot release own QA fail |
| RT technologist | proposed **47** | RT | fraction delivery (in R&V); HMIS check-in/identity scan |
| Palliative care physician | 43 variant | Onco | NDPS prescriber; home-care plan |
| Nephrologist | proposed **48** | Dialysis | prescription; sero-class change authority |
| Dialysis technician | proposed **49** | Dialysis | machine start/stop, disinfection log; never the water-test verifier for own machine |
| Dialysis nurse | doc 04 card | Dialysis | cannulation, intra-dialytic monitoring |
| RO plant technician (biomedical) | 35 variant | Dialysis | water tests; conductivity/endotoxin register |
| Gastroenterologist / endoscopist | 16 variant | Endo | procedure, sedation order, biopsy |
| Endoscopy nurse / scope reprocessing tech | proposed **50** | Endo | reprocessing cycles; scope custody; never reprocesses and signs release for the same cycle alone (two-signature on manual reprocessing) |
| Anaesthetist (sedation) | 15 | Endo, Cath, Paeds | roster-resolved on-call |
| Paediatric ward nurse / PICU nurse | 20/21 variants | Paeds | parent-stay pass variant; weight verification at each shift |
| Chaperone (eligible female staff) | S10 §12.25 | all | roster gate; identity recorded on `chaperone.present` |
| MRD birth/death clerk | 33 | Maternity | MCCD, birth registration upload; sealed-class custody |
| TPA/scheme desk (JSY/JSSK/PMJAY) | 5 | all | scheme package codes; pre-auth objects |
| Social worker / medical social service | proposed **51** | Maternity, Paeds, Onco | POCSO liaison, JSY/JSSK facilitation, charity routing |

**Agent/automation actors (see §9):** Partograph Watch (automation, T1) · D2D/Door-to-Balloon Clock (automation, T1) · Dyad Guardian (automation, T1) · ANC/Fraction/Session Recall (Recall & Follow-up, T1, existing) · Chemo Gate (automation, T1 — hard block is workflow-engine refusal, not an agent) · BSA Double-Check (automation, T1) · Water-Quality Watcher (automation, T1, doc 04) · Scope Trace (automation, T0) · Consignment Reconciler (Leakage Auditor extension, T0) · AERB Register Compiler (automation, T2 draft) · Discharge/Procedure Summary Drafter (agent, T2, existing family) · Tumour Board Pack Assembler (agent, T2) · MDSR Narrative Drafter (agent, T2) · Cardiac Rehab Nudger (Recall, T1).

**SoD hard pairs added (proposed):** BSA calculator entrant / BSA verifier · compounding pharmacist / administering nurse · consignment scanner / consignment count verifier · RSO QA-fail declarer / QA-fail releaser · sero-class changer / session-board assigner for that patient same day · MTP opinion doctor 1 / doctor 2 (12–20 weeks) · EBM labeller / EBM feed verifier.

---

## 3. Core flows as workflow definitions

All definitions are versioned data (§10.2); activation by owner (§10.4). SLA breaches are recorded everywhere; **active alerting proposed only on**: partograph action-line, D2D, door-to-balloon, chemo gate breach, emergency dialysis wait, EBM mismatch, band mismatch, water quality out-of-range, QA-fail block, STEMI transfer. Everything else records.

### 3.1 Maternity & NICU

**WF-M1 Pregnancy episode (P1 overlay, longitudinal):** `registered → antenatal_active → (high_risk) → admitted_for_delivery | terminated | transferred_out | lost_to_follow_up → delivered → postnatal → closed(42d)`. Roles: obstetrician opens/closes; ANC nurse records visits. SLA: each scheduled ANC visit has a due window; high-risk overdue > 7 d → `reminder.due` → Recall ladder → call task (`patient.recall_initiated`). Escalation: missed 2 high-risk visits → obstetrician task. Events: pregnancy.risk_flagged · appointment.no_show · patient.recall_initiated · **NEW** `anc.visit_recorded` · **NEW** `pregnancy.closed`.

**WF-M2 Labour (P1):**
```
triaged --admit--> latent --active(≥4cm)--> active_labour --partograph--> [alert_line_crossed] --> [action_line_crossed]
   |                                                   |                                   |
   home/observe                                        v                                   v
                                          documented_decision{augment|LSCS|expectant} (SLA 30 min from action_line)
active_labour --2nd stage--> delivering --> delivered(SVD|assisted|LSCS) --> 3rd_stage --> immediate_postpartum(2h obs) --> postnatal_ward
lscs.decided --> theatre_ready --> incision (D2D ≤30 min) --> delivered
```
Transitions: triage by obstetrician or trained nurse; `partograph.action_crossed` is emitted by the partograph automation and **forces** the `documented_decision` state — the workflow refuses any progression to `delivering` from `action_line_crossed` without a decision record (obstetrician role only). D2D: `lscs.decided` opens a clock; `surgery.started` (incision) closes it; > 30 min = `sla.breached` + auto KPI. Ladder: 20 min without theatre_ready → duty anaesthetist + OT in-charge; 30 min → medical director. Codes: obstetric rapid response uses `code.activated{class: PPH|eclampsia|cord_prolapse}`; PPH links `mtp.activated` (massive transfusion). Events: labor.triaged · partograph.action_crossed · ctg.abnormal_flagged · lscs.decided · surgery.started · delivery.recorded · apgar.recorded · code.activated · **NEW** `partograph.alert_crossed` · **NEW** `labour.decision_recorded` · **NEW** `placenta.disposed` (BMW manifest link) · **NEW** `stillbirth.recorded`.

**WF-M3 Birth & dyad (P1 for a second patient):** `delivery.recorded` → automation creates baby patient (own UHID, `linked_mother_id`, sex, birth weight, time; twins as separate rows with birth order) → `birth.recorded` → band pairing (`band.pair_verified`) → immunisation (BCG/OPV-0/HepB-0) `immunization.administered` → birth register row → statutory birth reporting task (CRS, 21 days) → discharge pair-scan. Stillbirth branch: `stillbirth.recorded` (no patient record created; stillbirth register row; MCCD-style cause; BMW/last-rites custody). Baby's charges route to mother's invoice until NICU admission creates its own encounter with inherited payer (map 2).

**WF-M4 EBM feed (P3 variant):** `expressed(label printed: mother UHID+baby UHID+time) → stored(fridge slot, temp log) → issued_for_feed → verified(two-scan baby band + bottle) → fed | discarded(expiry 4h room/24h fridge, reason)`. `ebm.verified` hard-stop; mismatch → `band.pair_mismatch` + incident. Donor milk (if a bank is ever tied up) is a separate item class with consent.

**WF-M5 NICU admission (P1):** ICU-hall variant per §11.15 with NICU pack: `requested → accepted(neonatologist) → admitted → (KMC eligible) → stepdown → discharged | transferred | deceased`. KMC sessions and ROP/hearing/metabolic screening as P5 tasks with due dates by corrected gestational age; missed screening = recall alert. Parent lounge passes on `pass.issued`.

**WF-M6 MTP (statutory):** `requested → opinion_1 (≤12w) | opinion_1+2 (12–20w) | medical_board (20–24w, MTP Amendment Act 2021 categories) → consent (woman; guardian if minor or mentally ill — plus POCSO intimation if minor) → performed → follow_up → closed`. Every transition sealed-class (§11.19-C-5); `termination.recorded` payload holds Form C/I refs; register keeps custody rules. **Cannot be opened if the facility's approved-place certificate config is absent/expired (§19 gate).**

**WF-M7 Maternal death surveillance (MDSR):** `patient.deceased{pregnancy_linked}` → automation opens `mdsr_case`: `opened → facility_review(within 72h notification; FBMDR) → cause_classified → reported_to_district (state MDSR portal; 24h notification, 1-week review) → closed`. Reviewer cannot be the treating obstetrician.

### 3.2 Cath lab & cardiology

**WF-C1 STEMI pathway (P1+P2):**
```
er.arrived --ECG≤10min--> ecg_acquired --> stemi.diagnosed --> cath_team_activated --> patient_in_lab --> access --> balloon.inflated (D2B ≤90 min; FMC-to-device ≤120 if transferred)
                                       |--> thrombolysis (door-to-needle ≤30 min) --> pharmaco-invasive transfer/lab
post-PCI --> ccu_monitoring(24h: access site, rhythm, contrast nephropathy creatinine at 48–72h) --> stepdown --> discharge(rehab enrolled)
```
Ladder: 60 min from diagnosis without patient_in_lab → interventionalist + duty manager; 90 min → medical director. Events: er.arrived · stemi.diagnosed · balloon.inflated · surgery.started/completed reused for procedure · **NEW** `ecg.acquired` · **NEW** `cath_team.activated` · **NEW** `thrombolysis.administered` · **NEW** `pci.completed` · **NEW** `access_site.checked`.

**WF-C2 Elective cath/PCI (P2 with OT-variant gates):** `booked → pre_procedure_gates(consent incl. radiation + contrast; creatinine/eGFR; allergy; anticoagulant hold; NPO; pregnancy check for women of reproductive age; PCPNDT n/a) → in_lab → timeout → procedure → consignment scan-on-use → dose_recorded → recovery → same-day discharge | admission`. Consignment: `consignment.deployed{item, batch, vendor, NPPA_ceiling_ref, price}` = charge + sticker + vendor liability in one event (Plan 14 ledger). Dose: `**NEW** radiation_dose.recorded{DAP, air kerma, fluoro_time}` per procedure; cumulative per patient; alert at threshold (skin dose > 3 Gy → follow-up task). Cath report → PACS (Plan 18) with reference in encounter.

**WF-C3 Cardiac rehab (Plan 20 course):** enrolment on `pci.completed` or post-CABG; phases I–III as sessions; missed = recall.

### 3.3 Oncology — chemo day-care

**WF-O1 Regimen course (the "course" of doc 04, chemo specialisation, Plan 22):** `prescribed(regimen id + version, intent, site, stage, BSA inputs) → cycle_n_scheduled → pre_cycle_gates → cleared | gate_blocked(reason) → compounding_verified → administering → completed → observation → discharged → next cycle | course_completed | stopped(toxicity/progression/death)`. Pre-cycle gates (deterministic, workflow-engine refusal): ANC ≥ threshold, platelets ≥ threshold, creatinine/bilirubin per regimen, weight within ±10% of BSA weight else recalc + second signature, consent on file, tumour-board decision ref if policy requires, funding (package/PMJAY pre-auth) status, pharmacist compounding verification, two-nurse admin (band + bag barcode). `chemo.gate_blocked` reason-coded; override only by oncologist with reason (e.g., G-CSF support) and logged — **never silent**. Events: regimen.cycle_started · chemo.gate_blocked · medication.administered · **NEW** `regimen.prescribed` · **NEW** `bsa.verified` · **NEW** `compounding.verified` · **NEW** `extravasation.recorded` · **NEW** `cytotoxic_spill.recorded` · **NEW** `regimen.stopped`.

**WF-O2 Tumour board (documented decision):** `case_listed → pack_assembled(T2 draft) → discussed(quorum: ≥3 specialties present, recorded) → tumor_board.decided{recommendation, dissent?} → communicated_to_patient(counselling record)`. Quorum failure = not decided.

**WF-O3 Palliative & NDPS:** opioid prescriptions on §11.8 NDPS machinery (Form/register per NDPS Rules 2015 Recognised Medical Institution for essential narcotic drugs — morphine); home supply limits; balance reconciliation; return of unused on death (register row).

### 3.4 Radiation oncology (buy R&V/TPS; HMIS orchestrates)

**WF-R1 RT course:** `referred → simulation_booked → simulated(CT-sim, immobilisation) → planning(vendor TPS; HMIS holds handoff record) → plan_approved(radiation oncologist + physicist sign in TPS; HMIS receives `**NEW** rt_plan.approved` via interface or manual entry) → fractions_scheduled(n fractions, days, machine slot) → fraction_i_delivered (`fraction.delivered` from R&V export) → course_completed → follow_up`. Missed fraction (no `fraction.delivered` by slot + 24h) = recall alert. Cumulative dose ledger per site updated per fraction; re-irradiation of a site triggers physicist review task. Package or per-fraction billing on `fraction.delivered`.

**WF-R2 Brachytherapy:** `planned → source_checked_out(source.movement_recorded, RSO) → applicator/insertion (OT or brachy suite; anaesthesia) → delivered → source_returned(source.movement_recorded) → survey_recorded`. Source out without return within planned window = active alert.

**WF-R3 Machine QA (QC-lockout class):** `daily_qa_due → qa_recorded{pass|fail} (rt_qa.recorded)` → fail = registry device status `blocked` → all fractions on that machine rescheduled cascade (doctor-leave mechanics) → RSO release. Monthly/annual QA schedules as recurring tasks; AERB licence, radiation survey, TLD badge quarterly reads as register rows; TLD overexposure → RSO investigation task.

### 3.5 Dialysis (clinical specifics for Plan 21)

**WF-D1 Dialysis run:** `scheduled(slot, machine class matched to sero-status) → checked_in → pre_run(weight, BP, access check, machine disinfection verified since last run, water test in date) → connected(device.usage_started) → intra_run(hourly obs; alarms) → disconnected(device.usage_stopped) → post_run(weight, BP, dialyser reuse decision) → discharged`. Hard rules: HBsAg+/HCV+/HIV+ patients only on dedicated machines (hard rule on session board; HIV Act 2017 confidentiality — the *class* is visible, the diagnosis is sealed); no run on a machine whose last disinfection log is missing; water test out-of-range or expired = plant blocked, all machines blocked (`utility.threshold_breached`). Emergency dialysis (hyperkalaemia, pulmonary oedema): `**NEW** dialysis.emergency_requested` → SLA 2 h to connected; ladder nephrologist → duty manager. Sero-conversion mid-course: nephrologist changes class → session board reassigns future slots automatically; the machine last used enters enhanced-disinfection task.

**WF-D2 Vascular access:** AVF creation referral (mini-OT/vascular), maturation checks, catheter days as tracked device-days; catheter-related infection register.

**Money:** prepaid bundles (Plan 09 counters), PMJAY dialysis package (per-session, pre-auth object per block), state dialysis scheme (PMNDP) tags; HepB vaccination series as tasks with reminders.

### 3.6 Endoscopy

**WF-E1 Procedure:** `booked(prep instructions sent in patient's language; NPO; anticoagulant hold) → checked_in → pre_procedure(consent, sedation assessment ASA, chaperone if required, pregnancy check) → scope_assigned(scope id scanned, reprocessing cycle valid) → sedation(anaesthetist or endoscopist-directed per policy) → procedure → biopsy(specimen labelled, chain to Plan 17) → recovery(Aldrete score) → discharge(escort verified) | admission`. Events: **NEW** `scope.assigned` · scope.reprocessed · specimen.dispatched · **NEW** `sedation.administered` · recovery.scored · escort.verified.

**WF-E2 Scope reprocessing (P5 + device lifecycle):** `used → pre_clean(bedside, ≤1 h) → leak_test → manual_clean → AER cycle(dwell, temp, chemical lot, HLD concentration test) → dried/stored(hang time ≤ policy hours) → ready`. Each cycle a row with operator, times, results; `scope.reprocessed`. Scope with >N procedures since last culture surveillance → surveillance task. Any state skipped → scope status `quarantined`.

### 3.7 Paediatrics (rules, not a module)

Weight-based dosing: every paediatric order requires a weight ≤ 24 h old (ward) / ≤ 7 d (OPD) captured on vitals; dose-range check against licensed content (§9 knowledge content); mg/kg and max-dose caps hard-warn. Consent: guardian with authority scope `consents` (§11.19-D-31); emancipated/mature-minor exceptions logged; adolescent confidentiality flags. Immunisation schedule (NIS + IAP optional vaccines) as a recurring task series from birth or first visit; catch-up logic. PICU = ICU-hall variant with paediatric pack; parent-stay pass variant; NRP/PALS code classes.

### 3.8 Cross-line
Female-patient chaperone rule: procedure classes flagged (obstetric exam, USG, ECG, endoscopy on female patients, cath access site prep, dialysis cannulation femoral) → `chaperone.present` gate. Gender segregation: bed-board hard rule (§11.18); day-care chairs in shared bays follow the same rule with configurable mixed-bay exception for chemo (corporate norm: mixed chemo bays with curtains, female-only bay preferred). Day-care encounter (`daycare` enum, §11.16-A) reused for chemo, dialysis, endoscopy, elective cath: one journey definition, per-line gates as pack data. Package billing & TPA: every line's packages are Plan 06/08 packages with inclusion/exclusion, pre-auth objects (§11.19-D-6), overrun consent (map 6).

---

## 4. Data model sketch

**`maternity` (proposed):** `pregnancies(id, patient_id, lmp, edd, gravida, para, living, abortions, risk_flags jsonb, serology jsonb, planned_mode, state, closed_reason)` · `anc_visits(pregnancy_id, occurred_at, recorded_at, bp, weight, hb, fundal_ht, fhs, findings, next_due)` · `labours(pregnancy_id, encounter_id, triage_at, active_at, partograph jsonb[time-series rows in child table], alert_crossed_at, action_crossed_at, decision{type, by, at, reason}, lscs_decided_at, incision_at, delivery_at)` · `partograph_entries(labour_id, at, cervix_cm, descent, contractions, fhr, drugs, bp, temp, urine)` · `deliveries(labour_id, mode, blood_loss_ml, placenta_status, complications, attended_by, episiotomy, pph_flag)` · `births(delivery_id, baby_patient_id, birth_order, sex, weight_g, apgar1, apgar5, resuscitation, live_birth bool, stillbirth_type, band_id, immunisations)` · `stillbirth_register` · `delivery_register` (statutory shape: Form per state) · `dyads(mother_patient_id, baby_patient_id, band_pair_id, active)` · `ebm_units(id, mother_id, baby_id, expressed_at, expires_at, location, state, label_qr)` · `ebm_feeds(unit_id, baby_id, verified_by_a, verified_by_b, at)` · `nicu_screenings(baby_id, type ROP|OAE|metabolic|hip, due_at, done_at)` · `kmc_sessions` · `mtp_register(sealed)` (woman ref, gestation, opinion doctors, category, consent form ref, method, outcome, follow-up; Form I/II/III fields) · `pocso_register(sealed)` (minor ref, intimation to SJPU/police at, acknowledgment, MLC ref) · `mdsr_cases` · `birth_reports(CRS submission, 21-day due, ack ref)` · `mccd_records(Form 4/4A fields, cause I(a)(b)(c) II, certifier, ICD-10, submitted_at)`. Registry: `hall` (labour room, NICU hall), `bed` (LDR, postnatal, NICU incubator as bed class), `room` (nursery), `device` (CTG, warmer, phototherapy, resuscitaire — with check-chain tasks).

**`cardiology`:** `stemi_cases(patient_id, encounter_id, symptom_onset, fmc_at, door_at, ecg_at, diagnosed_at, strategy, needle_at, lab_in_at, balloon_at, transfer_from)` · `cath_procedures(encounter_id, type, operator_id, access, findings jsonb, report_pacs_ref, contrast_ml, contrast_agent, dose_dap, dose_ak, fluoro_s, complications)` · `consignment_usages(procedure_id, ledger_row_id[Plan 14], item, batch, sticker_scan_at, nppa_ceiling, price_charged)` · `post_pci_obs` (or ICU chart rows) · `rehab_enrolments` (Plan 20 episodes). Registry: `theatre` (cath lab as OT-variant), `bed` (CCU/recovery), `device` (C-arm with dose export, IVUS/FFR, contrast injector).

**`oncology`:** `regimens(id, name, version, cycle_days, n_cycles, drugs[{drug, dose_per_m2|per_kg|flat, day, route, max}], gates{anc_min, plt_min, crea_max, bili_max}, premeds, emetogenicity)` (Class B governed master) · `regimen_courses(patient_id, regimen_id, version, intent, icd10, site, stage, bsa_height_cm, bsa_weight_kg, bsa, bsa_formula, verified_by, tumour_board_ref, consent_ref, funding)` · `cycles(course_id, n, scheduled_at, gate_results jsonb, cleared_by, blocked_reason, override{by, reason})` · `cycle_drugs(cycle_id, drug, calc_dose, rounded_dose, compounded_by, verified_by, admin_nurse_a, admin_nurse_b, started_at, ended_at)` · `extravasation_register` · `cytotoxic_spill_register` · `tumour_boards(case, date, attendees[], quorum_ok, decision, dissent)` · `rt_courses(patient_id, site, intent, prescribed_dose_gy, fractions, technique, machine_id, tps_plan_ref, plan_approved_at, approvers[])` · `rt_fractions(course_id, n, scheduled_slot, delivered_at, machine_id, dose_gy, source: rnv_export|manual, r_and_v_ref)` · `dose_ledger(patient_id, site, cumulative_gy, last_updated)` · `aerb_registers`: `rt_machine_qa(device_id, type daily|monthly|annual, at, by, result, block_released_by)` · `tld_reads(staff_id, badge_id, period, dose_msv, threshold_flag)` · `source_movements(source_id, activity, from, to, by, at, survey)` · `aerb_licences(device_id, licence_no, valid_to)` · `radiation_incidents`. `ndps_palliative_register` reuses Plan 16 NDPS tables with palliative flag. Registry: `device` (LINAC, brachy afterloader, CT-sim, TPS server as interface), `room` (bunker), `bed`/chairs (day-care).

**`sessions/dialysis` (Plan 21 clinical adds):** `dialysis_prescriptions(patient_id, modality HD|HDF|SLED, duration, bfr, dfr, dialysate, dialyser model, heparin, dry_weight, access type, sero_class)` · `dialysis_runs(prescription_id, session_id, machine_id, pre_wt, post_wt, uf, pre_bp, post_bp, complications, dialyser_reuse_n, started_at, ended_at)` · `dialysis_machines(device_id FK registry, sero_class HBV|HCV|HIV|NEG, last_disinfection_at, cycles_since_service)` · `machine_disinfections` · `water_tests(plant_id, at, conductivity, hardness, chlorine, endotoxin, culture, result, by, verifier)` · `dialyser_reuse(dialyser_id, patient_id, uses_n, tcv_pct, max_uses)` · `vascular_access(patient_id, type AVF|AVG|CVC, site, created_at, matured, catheter_days)` · `hepb_vaccinations`.

**`endoscopy`:** `endo_procedures(encounter_id, type, scope_id, endoscopist, sedation{type, drug, dose, by}, asa, findings, biopsies[], complications, aldrete, escort_verified)` · `scopes(device_id FK, model, serial, channel_count, procedures_since_culture)` · `reprocessing_cycles(scope_id, used_in_procedure_id, pre_clean_at, leak_test, manual_clean_at, aer_id, cycle_start, cycle_end, dwell_s, hld_lot, hld_conc_test, operator, verifier, result, stored_at, hang_expiry)` · `scope_cultures`.

**Paediatrics:** no tables; `patients.guardians` (exists), `vitals.weight` currency rule, `immunisation_schedule` rows as tasks (owner: `patients` or a small `immunisation` sub-table — recommended in `patients` since it starts at birth and outlives any encounter).

**FHIR shapes:** Patient (link to mother via `Patient.link`), Encounter, Procedure, Observation (partograph, APGAR, dose), MedicationAdministration (chemo), Immunization, Specimen, Device/DeviceUseStatement (scope, machine), CarePlan (regimen, RT course), Condition. **Retention:** maternity/paediatric records until child reaches 21 years + 3 (corporate norm; owner to confirm with counsel), MTP register 5 years (MTP Regulations) sealed, PCPNDT Form F 2 years minimum (keep 5), AERB registers life of machine + 5 y, NDPS registers 2 years minimum (keep 5), MLC indefinite, dose ledger lifetime of patient.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.** Grouped per line; themes tagged in brackets.

### 5.1 Maternity & NICU (M-1…M-26)

| ID | Scenario → behaviour → test |
|---|---|
| M-1 [identity] Twins delivered, both girls, 1.9 kg and 2.1 kg; nurse bands both from the same printer roll in the wrong order → two baby UHIDs created with `birth_order` and weight from the delivery record; band pairing requires scanning the band *and* reading weight aloud against the record (weight on band); a mismatch between band birth-order and recorded weight blocks `band.pair_verified` → test: fixture with swapped bands asserts `band.pair_mismatch` and no `pair_verified`. |
| M-2 [identity/wrong-patient] Mother from bed 12 handed a baby from bed 14 for feeding → hard-stop double scan (map 2) refuses; `band.pair_mismatch` fires incident + nursery in-charge task → test: mismatch scan returns block; incident row exists within same transaction. |
| M-3 [timing] Partograph action line crossed at 02:10; obstetrician on-call asleep, phone off → `partograph.action_crossed` opens 30-min decision SLA; at 15 min nurse nudged; at 30 min `sla.breached` → escalation ladder to second on-call obstetrician + medical director; no progression allowed without `labour.decision_recorded` → test: clock simulation asserts ladder rungs and refused transition. |
| M-4 [timing] `lscs.decided` at 03:00, both ED theatres occupied by trauma → D2D clock runs; system shows nearest ready theatre = none, surfaces main-suite emergency insert; breach recorded not hidden; KPI counts with reason `theatre_unavailable` → test: reason-coded breach row, KPI denominator includes case. |
| M-5 [concurrency] CTG abnormal flag and partograph decision entered simultaneously by two nurses on two tablets → both events append; workflow transition serialised on instance lock; second writer sees current state and re-renders → test: parallel transition attempts yield one accepted, one `409` with state. |
| M-6 [downtime] Server down during a delivery at 04:30 → paper partograph + delivery register serial from sealed kit; baby banded from pre-printed blank band pairs (serially numbered pairs in the kit); backfill screen creates baby patient with `occurred_at` = birth time, band serial linked → test: backfill with kit serial produces `birth.recorded` with occurred≠recorded and `late_entry.flagged` absent (downtime window recognised). |
| M-7 [money] JSY-eligible mother (BPL card) delivers; JSSK entitles free delivery, drugs, diet, transport → payer tag `JSY/JSSK` at admission; all charges route to scheme cost centre; any cash collection attempt on a JSSK-tagged encounter blocks with reason and management override only → test: charge posting on JSSK encounter lands on scheme head; cashier receipt attempt refused. **O-1**. |
| M-8 [money] Delivery package (normal) converts to LSCS mid-labour → package switch with counselled consent (map 6/3); package_applied event for new package; consumed inclusions carry across; TPA pre-auth enhancement task → test: invoice lines attributed by package period; consent record present before overrun accrual. |
| M-9 [consent/legal] 15-year-old presents in labour with mother-in-law, says she is 19; no ID → age-estimation recorded; if any evidence of minority (school certificate, Aadhaar later) POCSO intimation forced (`pocso.intimated`), MLC opened, sealed channel away from default guardian; treatment never blocked → test: DOB edit to minor age on an open pregnancy retro-triggers POCSO task; sealed-class access evented. |
| M-10 [legal] Family demands foetal sex disclosure after USG → report template has sex-determination lockout; Form F recorded per scan; any free-text containing sex-indicative terms in obstetric USG report flagged for review (deterministic term list) → test: template field absent; scrubber flags fixture text. PCPNDT Act 1994 §5/6. |
| M-11 [legal] MTP requested at 22 weeks for foetal anomaly → WF-M6 routes to medical board category (MTP Amendment Act 2021); cannot proceed on two opinions; register sealed → test: 22-week gestation without board decision refuses `performed`. |
| M-12 [unconscious] Eclamptic, unconscious, no relative → emergency treatment under implied consent, documented; two-doctor note; consent later from relative or recorded as emergency exception → test: `code.activated{eclampsia}` allows LSCS decision with `consent.recorded{type: emergency}`. |
| M-13 [staff] Only one obstetrician on the floor, two labours cross action line within 10 min → both decisions required; system shows queue of undecided labours on obstetrician workspace, escalates second to on-call; Partograph Watch (T1) never decides → test: two instances, one decider; both SLA clocks independent. |
| M-14 [handover] Night nurse hands over 6 labouring women; one partograph last entry 3 h old → handover gate lists stale partographs (> 1 h in active labour) and requires acknowledgment; stale entry = `late_entry.flagged` if backfilled → test: handover payload includes stale flags. |
| M-15 [equipment] CTG machine feed silent 20 min on an active labour → `interface.down` + `data_gap.flagged`; nurse manual FHR entry task every 15 min until restored → test: heartbeat timeout emits both events; tasks generated. |
| M-16 [equipment] Warmer/resuscitaire check chain not done this shift and NRP code fires → code proceeds; missing check surfaced in debrief and incident → test: `code.activated{NRP}` with open check task → incident auto-row. |
| M-17 [data quality] EDD recorded from LMP; later dating scan disagrees by 10 days → EDD versioned with source; high-risk logic and ANC schedule recompute; old EDD retained for audit → test: `pregnancy.updated` with prior/new EDD; schedule regenerated. |
| M-18 [backdated] Delivery at 23:58 entered at 00:20 next day → `occurred_at` 23:58 governs birth date and register; `recorded_at` next day; CRS 21-day clock from occurred → test: date boundary fixture. |
| M-19 [fraud] Fake JSY claim: same Aadhaar used for two "deliveries" in 6 months → Fraud Sentinel rule: deliveries per patient interval < 6 months → flag; scheme desk task → test: rule fires on fixture. |
| M-20 [leakage] Baby's NICU consumables billed to mother's OPD bill after NICU admission opened → charge routing rule: post-`patient.admitted{baby}` charges go to baby encounter; misroute = orphan report → test: charge posted with wrong encounter is rejected by routing rule. |
| M-21 [privacy/VIP] Staff nurse delivers here; colleagues browse her record → confidential-by-default (§11.5); alias on boards; access evented and reviewed → test: access by non-treating role logged and included in weekly access-review flag. |
| M-22 [privacy] HIV-positive mother; PPTCT protocol → serology in sealed class; NICU staff see "PPTCT protocol applies" flag, not the diagnosis text, unless in treating team (E-4 carve-out) → test: role fixtures render four-state "not visible to your role". |
| M-23 [language] Bhojpuri-only mother, husband away; danger-sign education and discharge instructions → language preference Bhojpuri falls back to Hindi audio/pictorial; counselling record notes interpreter (relative/staff) identity → test: message renders in fallback language; counselling row carries interpreter. |
| M-24 [scale] 2027: 25 deliveries/day, 15 NICU beds full, referral in from periphery → NICU bed request waitlist with forecast; refer-out path evented; labour room census on floor dashboard → test: 16th NICU request enters waitlist with ETA. |
| M-25 [integration] Birth registration portal (CRS) down for 3 days → task remains open with due date; export of birth report PDF for manual submission; ack ref entered later → test: task overdue escalates to MRD in-charge; manual ack accepted. |
| M-26 [infant abduction] Unknown woman in burqa carrying an infant exits nursery corridor → infant abduction code (§11.17): gate seal, band-check every infant exit, CCTV task; any infant exit without `band.pair_verified` at gate = alarm → test: exit scan without pair → alarm event. |

### 5.2 Cath lab & cardiology (C-1…C-18)

| ID | Scenario → behaviour → test |
|---|---|
| C-1 [identity] Two Mr. Ram Kumars in ED, one STEMI; cath team calls the wrong one → STEMI activation carries UHID + photo + ECG image; lab check-in scans wristband; mismatch blocks `patient_in_lab` → test: wrong band scan refused. |
| C-2 [timing] STEMI diagnosed 10:00; lab occupied by elective PCI until 10:40 → clock runs; elective case flagged as `can_interrupt?` by operator; breach recorded with reason `lab_occupied`; secondary lab (if any) or lysis decision prompted at 30 min (pharmaco-invasive) → test: reason code and prompt at 30 min. |
| C-3 [timing] Transferred STEMI from 60 km away; FMC at periphery 08:00, arrival 10:30 → FMC-to-device clock (120 min) alongside door-to-balloon; both recorded; KPI uses FMC for transfers → test: transfer fixture computes both. |
| C-4 [concurrency] Two stents scanned on-use for one lesion; one was opened but not deployed → scan-on-use = deployed; undeployed opened stent needs `consignment.opened_not_used{reason}` (NEW) → return-or-charge decision (§11.16 pattern) → test: opened-not-used row lands on vendor/hospital decision, not patient. |
| C-5 [money] NPPA stent price ceiling (DES ~₹38k) exceeded on invoice → tariff engine caps consignment item price at NPPA ceiling config; attempt to price above blocks; ceiling versioned with NPPA order date → test: price above ceiling refused; ceiling version on invoice line. **O-2**. |
| C-6 [money/TPA] PMJAY package for PCI single stent; second stent needed intra-procedure → pre-auth enhancement task from lab; if denied, counselled self-pay consent (map 3) before charge → test: second `consignment.deployed` beyond sanction → `preauth.deviation_flagged` + consent gate. |
| C-7 [consent] Patient in cardiogenic shock, unconscious, no relative; primary PCI needed → emergency consent path with two-doctor note; radiation/contrast consent recorded as emergency exception → test: `consent.recorded{type: emergency}` allows `patient_in_lab`. |
| C-8 [MLC] Cocaine-associated MI in a 24-year-old brought by police → MLC flag; treatment unblocked; MLC register + injury report custody → test: `mlc.registered` on ER arrival propagates to cath encounter. |
| C-9 [staff] Interventionalist on-call unreachable 20 min → `cath_team.activated` ladder: second operator → medical director; time to team arrival logged as KPI component → test: ladder rungs evented. |
| C-10 [equipment] C-arm dose export fails; procedure proceeds → dose entry manual from console with `source: manual`; procedure cannot close without dose fields → test: close without dose refused; manual entry accepted. |
| C-11 [equipment] Contrast injector failure mid-case → hand injection; contrast volume captured manually; `device.usage_stopped{reason}` → test: manual contrast field required when injector event absent. |
| C-12 [data quality] eGFR 28 on file from 6 months ago; no fresh creatinine → contrast gate requires creatinine ≤ 7 days (elective) / POCT (emergency); elective blocks, emergency proceeds with post-procedure creatinine task at 48–72 h → test: elective without fresh creatinine refused; emergency creates follow-up task. |
| C-13 [fraud/leakage] Stent scanned but sticker not in the patient's file; vendor challan shows 3 used, HMIS shows 2 → Consignment Reconciler daily 3-way (challan/usage/invoice) mismatch task; unreconciled > 7 days = `consignment.aging_flagged` → test: mismatch fixture creates task. |
| C-14 [fraud] Operator with 40% higher stents-per-patient than peers → Fraud Sentinel diagnostic only, load- and case-mix-normalised, routed to medical director, never auto-punitive → test: rule output carries context fields. |
| C-15 [privacy] Politician with STEMI; media at the gate → VIP alias; single-spokesperson rule; CCU board shows alias → test: public-surface rendering uses alias. |
| C-16 [language] Elderly Maithili-speaking patient signs radiation+contrast consent via thumb impression → consent form in Hindi with pictorial; witness identity recorded; thumb-impression flag → test: consent row has witness + thumb flag. |
| C-17 [scale] 2027: 8 primary PCIs/night, one lab → second lab commissioning trigger from KPI (lab occupancy > 85% + D2B breaches); until then pharmaco-invasive protocol default at 30-min prompt → test: KPI computes occupancy. |
| C-18 [rehab/recall] Post-PCI patient never attends rehab or 1-month review → Recall ladder; DAPT adherence reminder in patient language; missed review = clinical alert (not no-show) per map 11 spirit → test: recall task after no `session.completed` in 14 d. |

### 5.3 Oncology — chemo day-care (O-1…O-20)

| ID | Scenario → behaviour → test |
|---|---|
| O-1 [identity] Two patients on the same regimen in adjacent chairs; bags swapped → bag barcode = (patient, cycle, drug); two-nurse band+bag scan hard-stops → test: wrong bag scan refused, incident row. |
| O-2 [dosing] Weight fell 12% since BSA capture → gate blocks; BSA recalc requires oncologist + verifier (SoD); dose rounding rule per drug (vial size, ±5% band) recorded → test: >10% weight delta → `chemo.gate_blocked{reason: weight_delta}`. |
| O-3 [dosing] Height typed 16.5 cm instead of 165 → BSA plausibility bounds (0.4–3.0 m²) refuse; Mosteller vs DuBois formula pinned per regimen → test: out-of-range BSA refused. |
| O-4 [dosing] Carboplatin AUC dosing (Calvert) needs creatinine clearance; lab result 9 days old → gate requires ≤ 7 d; block → test: stale creatinine blocks AUC-dosed drug only, not the rest? No — whole cycle blocks (corporate default), reason visible. |
| O-5 [gate] ANC 1,400 vs threshold 1,500 → block; oncologist override with reason (G-CSF given) logged with second signature; override rate is a KPI → test: override without reason refused. |
| O-6 [timing] Cycle 3 due day 21 falls on a holiday → scheduler proposes ±2 d window per regimen tolerance; beyond tolerance = oncologist decision recorded → test: window logic. |
| O-7 [concurrency] Pharmacist verifies compounding while nurse starts premeds → allowed (premeds not gated); cytotoxic administration transition requires `compounding.verified` → test: admin transition before verification refused. |
| O-8 [downtime] Server down; cycle cleared yesterday on-screen → paper chemo chart from kit with printed gate summary; two-nurse signatures on paper; backfill `medication.administered` with occurred_at → test: backfill accepted within downtime window. |
| O-9 [money] Prepaid 6-cycle bundle (Plan 09) — patient dies after cycle 2 → refund of unused counters to payer (legal heir with ID) via credit note + approval; lapsed_restore rules from doc 04 → test: refund path with heir identity. |
| O-10 [money/TPA] PMJAY chemo package per cycle; drug dose increased needs extra vial beyond package → overrun projected + consent (map 6) before compounding → test: projected overrun blocks compounding until consent. |
| O-11 [consent] Regimen change from adjuvant to palliative intent → new consent; old course `regimen.stopped{reason}`; tumour board ref → test: intent change without new consent refused. |
| O-12 [minor] 6-year-old with ALL; parents separated, father has custody order → guardian authority scope `consents` on father only; mother gets `messages` if permitted → test: mother's consent attempt refused. |
| O-13 [staff] Only one chemo-certified nurse on shift → two-nurse rule accepts any licensed nurse as second verifier (S10 §12 witness rule), cross-ward pull; last resort video witness logged → test: witness eligibility accepts cross-ward nurse. |
| O-14 [equipment] Biosafety cabinet certification expired → compounding blocked (QC-lockout class on the `device`); outsourced compounding or postpone → test: expired cert → device blocked → compounding transition refused. |
| O-15 [waste] Cytotoxic waste bag (yellow, cytotoxic label) weighed and manifested; spill of 50 ml 5-FU → `cytotoxic_spill.recorded`, spill kit replenish task, staff exposure record if any → test: register row + task. BMW Rules 2016 Schedule I. |
| O-16 [data quality] Lab result arrives *after* nurse hung the bag (result was pending) → gate should never have cleared — assertion: gate requires result *verified* not *ordered*; if a result later shows below threshold, incident + oncologist notified → test: pending result → blocked. |
| O-17 [fraud] Vials issued for a cycle that was cancelled; no return → leakage triangle per cycle (issued vs administered vs returned); unreturned cytotoxic = leakage flag same day → test: cancelled cycle with issued vials → flag. |
| O-18 [privacy] Cancer diagnosis of a staff member → confidential; day-care board shows alias → test: alias rendering. |
| O-19 [language] Consent for a 12-page regimen in English to a Hindi-only patient → Hindi consent template mandatory when language = hi; counsellor identity recorded → test: language mismatch refuses consent close. |
| O-20 [scale/integration] Regimen library from licensed content updates a threshold → regimen master is Class B governed; in-flight courses keep their version; new version needs owner activation → test: version pin on course. |

### 5.4 Radiation oncology (R-1…R-15)

| ID | Scenario → behaviour → test |
|---|---|
| R-1 [identity] Two patients with same name on the LINAC schedule; R&V identifies by its own MRN → HMIS↔R&V patient ID mapping table with UHID; fraction import with unmapped MRN is quarantined, never auto-matched by name → test: unmapped import → quarantine row. |
| R-2 [vendor boundary] R&V export feed down for 2 days → `interface.down`; fractions entered manually from R&V printout with `source: manual`; reconciliation on restore flags duplicates → test: duplicate (manual+import) collapses by (course, n). |
| R-3 [timing] Fraction 12 of 25 missed (patient sick) → recall alert; overall treatment time extension computed; radiation oncologist decides compensation → test: missed fraction alert after slot + 24 h. |
| R-4 [QA] Daily QA fails on output constancy → `rt_qa.recorded{fail}` → device blocked; today's 30 fractions rescheduled cascade with notifications; RSO release requires reason → test: block cascade generates 30 reschedule tasks. |
| R-5 [AERB] TLD quarterly read for a technologist = 6 mSv (investigation level) → RSO task, register row, AERB reporting if limits exceeded → test: threshold rule fires. |
| R-6 [brachy] Ir-192 source checked out 09:00, not returned by planned 11:00 → active alert; RSO + physicist; source register row open → test: overdue source alert. |
| R-7 [money] Package "25 fractions IMRT" but plan changed to 30 → overrun projected + consent; per-fraction billing continues → test: fraction 26 posts as overrun after consent. |
| R-8 [consent/pregnancy] Woman of reproductive age; pregnancy check before simulation CT and each fraction week → gate; positive test → course held, board review → test: missing pregnancy check refuses simulation. |
| R-9 [dose ledger] Re-irradiation of a previously treated site → cumulative ledger shows prior dose; physicist review task mandatory → test: second course on same site → task. |
| R-10 [staff] Physicist on leave; RSO delegate not in credential registry → QA cannot be signed; machine blocked at day start → test: unsigned daily QA → blocked status. |
| R-11 [equipment] LINAC AMC lapse and AERB licence expiry within 30 d → Expiry Watchman flags; licence expired = device blocked (statutory) → test: expiry → block. |
| R-12 [downtime] HMIS down; R&V and LINAC run independently → treatment continues (vendor system); fractions backfilled from R&V export later; billing catches up → test: backfilled fractions accepted with occurred_at from R&V timestamp. |
| R-13 [privacy] Oncology summary shared to TPA includes RT dose ledger → export governance (E-28): approval + watermark; sealed fields excluded → test: export without approval refused. |
| R-14 [palliative/NDPS] Home morphine supply for 10 days; patient dies day 4; family returns 6 days' stock → NDPS return register row, balance reconciled, witness → test: return row balances ampoule count. |
| R-15 [scale] Second LINAC commissioned → registry device add; machine QA schedule instantiated; scheduling across machines with plan-machine compatibility → test: plan bound to machine model cannot schedule on incompatible machine. |

### 5.5 Dialysis (D-1…D-17)

| ID | Scenario → behaviour → test |
|---|---|
| D-1 [identity] Walk-in "regular" patient, wrong file pulled; different dry weight → check-in by band/QR + photo; prescription shown with photo; UF target derived from that record → test: wrong UHID scan on chair mismatches booking → block. |
| D-2 [sero] HBsAg+ patient booked on negative machine by a new nurse → hard rule refuses slot; sero class visible, diagnosis sealed (HIV Act 2017 §8/9 for HIV) → test: assignment refused; UI shows class only. |
| D-3 [sero] Patient seroconverts (HCV+ on monthly bloods) → nephrologist changes class; future bookings auto-move; last machine used → enhanced disinfection + contact review task → test: class change cascade. |
| D-4 [sero] HBV machine down; HBV patient due today → no fallback to negative machines ever; refer-out or postpone decision recorded → test: no eligible machine → decision task, never assignment. |
| D-5 [water] Endotoxin result 0.5 EU/ml (limit 0.25) → plant blocked; all runs blocked; running sessions: nephrologist decides continue/stop with reason → test: threshold → `utility.threshold_breached` → new starts refused. |
| D-6 [water] Monthly culture not done (test expired) → plant status `test_overdue`; warning 3 d before; overdue = block (corporate default; configurable) → test: expiry → block. **O-3**. |
| D-7 [reuse] Dialyser reuse #7 with TCV 78% (< 80%) → discard forced; reuse policy per patient consent; seropositive dialysers never reused across patients (single-patient by design) → test: TCV below → discard. |
| D-8 [emergency] K+ 7.1 at 23:00; no slot → `dialysis.emergency_requested`; SLA 2 h; ladder; machine allocation overrides elective board with logged displacement → test: emergency preempts and evented. |
| D-9 [timing] Patient arrives 90 min late; next slot's patient waiting → board proposes shortened run or reschedule; nephrologist approves shortened duration; run < prescribed = flagged → test: duration deviation flag. |
| D-10 [money] PMJAY dialysis: 3 sessions/week sanctioned; patient wants 4th → pre-auth object deviation; self-pay consent or refuse → test: 4th session beyond sanction → gate. |
| D-11 [money] 12-session prepaid bundle; 3 sessions missed for hospitalisation elsewhere; validity expires → doc 04 extension rules; clinical-absence extension by nephrologist logged → test: extension movement row. |
| D-12 [downtime] Server down mid-shift; 12 patients on machines → runs continue; paper run sheet from kit; machine usage backfilled; `device.usage_started/stopped` reconcile to billed sessions (§11.19-C-13) → test: backfilled usage matches billed count. |
| D-13 [equipment] Machine alarm (blood leak) → technician stops; complication row; machine `needs_service` status → not bookable → test: status → exclusion from board. |
| D-14 [vaccination] HepB series dose 2 due; patient non-responder after series → booster schedule; anti-HBs titre task → test: task generation from vaccination rows. |
| D-15 [privacy] HIV+ patient's class visible to porter on board? → board for non-clinical roles shows machine id only, not class; class visible to dialysis staff → test: role rendering. |
| D-16 [fraud/leakage] Dialyser and bloodlines issued for 14 runs, 12 runs recorded → leakage triangle per shift → test: variance flag. |
| D-17 [scale] 2027: 30 machines, 3 shifts, 90 runs/day → board performance budget < 300 ms; sero-segregated pools; technician:machine ratio KPI → test: perf fixture. |

### 5.6 Endoscopy (E-1…E-16)

| ID | Scenario → behaviour → test |
|---|---|
| E-1 [identity] Biopsy jars from two consecutive patients labelled after both procedures → specimen label printed at `specimen.dispatched` inside the procedure record; unlabelled jar cannot be received by Plan 17 (accession requires QR) → test: dispatch without procedure ref refused. |
| E-2 [trace] Post-ERCP CRE outbreak suspicion → one query: scope id → procedures in window → patients → contact list (Recall) → test: query returns full chain. |
| E-3 [reprocessing] AER cycle aborted at 8 min → cycle `failed`; scope `quarantined`; cannot be assigned → test: assignment refuses quarantined scope. |
| E-4 [reprocessing] Hang time exceeded (scope stored 8 days, policy 7) → status `reprocess_required` → test: expiry rule. |
| E-5 [sedation] Propofol sedation without anaesthetist (policy requires) → order refused unless anaesthetist role present on case → test: role gate. |
| E-6 [prep] Bowel prep instructions sent in English to a Hindi-only patient; poor prep → prep template per language, pictorial; poor-prep outcome recorded as quality field → test: template language. |
| E-7 [timing] Emergency upper GI bleed at 02:00; only scope is mid-reprocessing (25 min left) → board shows earliest ready scope; decision recorded; never skip cycle → test: no `scope.assigned` from `in_cycle`. |
| E-8 [consent] Adolescent 16 with abdominal pain; parent refuses endoscopy; patient consents → guardian authority + mature-minor policy; documented counselling; medical director route → test: refused without documented path. |
| E-9 [money] Diagnostic OGD package; polypectomy performed → package exclusion → overrun consent (post-hoc allowed for intra-procedure findings with pre-consented "if found" clause) → test: pre-consent clause present → charge posts; absent → approval. |
| E-10 [MLC] Foreign body ingestion in a child; suspected abuse → MLC + child-protection flag; POCSO if indicated → test: flag propagation. |
| E-11 [equipment] Scope leak test fails → repair loop; loaner scope registered as temporary device with own cycles → test: loaner device row. |
| E-12 [staff] Reprocessing tech absent; nurse reprocesses manually → two-signature on manual cycle; competency check in credential registry → test: uncredentialed operator refused. |
| E-13 [downtime] AER printout only; server down → cycle backfilled with printout serial → test: backfill row with printout ref. |
| E-14 [privacy] Colonoscopy on a female patient by male endoscopist → chaperone gate; identity recorded → test: `chaperone.present` required for female + flagged class. |
| E-15 [leakage] Biopsy forceps (single-use) opened not used → return-or-charge decision → test: opened-not-used row. |
| E-16 [scale] 40 procedures/day, 6 scopes → scope availability simulation on booking; turnaround KPI per scope → test: booking refuses beyond scope capacity. |

### 5.7 Paediatrics & cross-line (P-1…P-14)

| ID | Scenario → behaviour → test |
|---|---|
| P-1 [dosing] Weight 8 days old on OPD order → refused; vitals task → test: currency rule. |
| P-2 [dosing] Paracetamol 15 mg/kg on a 40 kg child = 600 mg; max adult dose logic → cap rule; licensed dose-range content version pinned → test: cap warning. |
| P-3 [dosing] Weight entered in lb → unit enforced kg; range check by age → test: implausible weight refused. |
| P-4 [consent] Child brought by neighbour; parents unreachable; emergency → emergency consent path; social worker task → test: path exists. |
| P-5 [immunisation] Baby born here; family moves; vaccine due at 6 weeks → Recall ladder in language; missed = clinical alert; catch-up schedule recompute → test: schedule regenerates. |
| P-6 [immunisation] Vaccine batch recalled → dispensed-batch patient recall (§11.18 lock 9) → test: contact list generated. |
| P-7 [PICU] Parent-stay pass; father drunk and abusive → Code Violet; pass revoked; guardian channel changed → test: pass.revoked + guardian override. |
| P-8 [chaperone] Female patient, male doctor, no female staff on night shift → roster gate should have blocked publish; at runtime: remote-video witness last resort logged → test: publish validation fails without eligible female. |
| P-9 [gender] Male patient assigned to female general ward bed → bed-board hard rule refuses → test: rule. |
| P-10 [day-care reuse] Chemo patient converts to admission (febrile neutropenia) → `daycare.converted_to_admission`; until IPD ships, documented handoff to incumbent system (E-11 boundary) → test: event with crossing ref. |
| P-11 [package/TPA] TPA rejects claim citing "no pre-auth for day-care chemo" → pre-auth object per cycle block; claim drafter attaches; dispute trail → test: pre-auth object exists per cycle. |
| P-12 [abuse] Adolescent girl, recurrent UTI, mother insists on being present → adolescent-confidentiality flag allows private interview; documented → test: sealed-channel rules. |
| P-13 [adolescent pregnancy in paeds OPD] 16-year-old found pregnant on USG in paediatric OPD → PCPNDT Form F + POCSO intimation + maternity thread opens; guardian channel override → test: three triggers from one result. |
| P-14 [scale] 2,000 OPD/day: 300 paediatric; weight capture at vitals desk bottleneck → integrated scale (serial) at vitals; manual fallback → test: device event or manual entry. |

**Total rows: 26 + 18 + 20 + 15 + 17 + 16 + 14 = 126.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Maternity: Sunday 02:00, two labours cross the action line, one PPH, server down.** 02:00 server dies (`downtime.declared` by duty manager + second person at 02:07 via phone). Labour room switches to paper partographs from sealed kit (serials LR-0451/0452). 02:20 bed 3 action line crossed — obstetrician decides LSCS, writes on paper with time; 02:25 phone (PBX) to ED theatre — theatre 2 ready; incision 02:48 (D2D 28 min, on paper). 02:35 bed 5 PPH → obstetric rapid response by PBX; blood bank issues O-neg on paper MTP register. 03:30 baby from bed 3 banded from kit pair #17. Agents: none run (global halt is not needed; agents fail-open, scheduler idle). 05:10 server back; backfill: `lscs.decided` 02:20, `surgery.started` 02:48 (occurred), D2D KPI computes 28 min from occurred; `birth.recorded` with kit pair #17; `mtp.activated` and `unit.issued` backfilled with paper serials; PPH incident auto-row. Reconciliation: kit serials LR-0451/0452 and pair #17 accounted; O-neg units reconciled to blood-bank paper. Audit shows downtime window, dual stamps, no `late_entry.flagged` inside the window, digest lists the window with duration.

**6.2 Cath lab: Monday 09:00, STEMI arrives while elective PCI in progress, second STEMI 09:30, consignment vendor rep absent, NPPA ceiling revised that morning.** 09:02 ECG at triage, `stemi.diagnosed` 09:08; clock running; lab occupied — operator flags elective interruptible at 09:25; patient in lab 09:35; balloon 09:58 (D2B 50 min). 09:30 second STEMI: clock; lab busy → pharmaco-invasive prompt at 10:00; lysis given 10:05 (door-to-needle 35 min, breach recorded reason `lab_occupied`); transferred to lab 11:30. Stents: scan-on-use; second STEMI needs stent not in consignment stock → `consignment.deployed` refused for missing batch → hospital-owned stent from OT store issued via P3, evented. NPPA ceiling: config version 2026-08 applied at invoice time; line shows ceiling ref. Rep absent: no impact (reconciliation is data). Digest: two STEMIs, one breach with reason, one lysis, consignment stock-out flag → Replenishment.

**6.3 Chemo day-care: Tuesday, LIMS analyzer down, 14 patients due, one BSA error, one bag swap attempt, cytotoxic spill.** Lab CBC results delayed 3 h → all gates `blocked{lab_pending}`; day-care board shows 14 waiting; nurse starts hydration only. Manual CBC from backup analyzer entered at 11:30 with `source: manual` → gates re-evaluate; 12 clear, 1 ANC low → override with G-CSF plan and second signature; 1 weight −12% → BSA recalc, oncologist + verifier. 13:00 two-nurse scan blocks a bag swap (incident, near-miss = success). 14:00 spill 30 ml → spill register, exposure nil, kit replenish task. Prepaid counters consumed on `session.completed`; 2 postponed cycles restore nothing (not consumed). Audit: every block reason, every override signature, spill row.

**6.4 Radiation: Wednesday daily QA fails, R&V feed down, brachy source out.** 07:30 QA output 4% off → `rt_qa.recorded{fail}` → LINAC blocked; 32 fractions rescheduled; WhatsApp in patient language; physicist recalibrates 10:00; RSO releases with reason. R&V export feed down since 06:00 → `interface.down`; fractions after 10:00 entered manually from R&V printouts; on restore at 16:00, import dedups on (course, n). Brachy source checked out 11:00 for a cervix insertion, returned 13:10 with survey; register two rows. TLD batch results arrive: one badge 5.8 mSv → RSO task. Digest: QA fail + release, 32 reschedules, 1 TLD investigation.

**6.5 Dialysis: Thursday endotoxin fail at 06:30, HBV machine down, emergency K+ at 22:00, server down 23:00.** 06:30 water test fails → plant blocked; 10 morning patients cannot start; nephrologist decides refer 3 critical to partner centre (evented referral), rest wait; plant retest passes 09:15 → release. HBV machine fault → HBV patient postponed (no fallback). 22:00 emergency dialysis request → preempts an elective slot (displacement logged). 23:00 server down: 8 running; paper run sheets; backfill at 01:00; usage-vs-billed reconciliation exact. Audit: water register, machine status history (Plan 13 `resource_status_history`), displacement, downtime window.

**6.6 Endoscopy: Friday CRE alert from microbiology on a post-ERCP patient.** Infection control queries scope trace: duodenoscope D-02 → 23 procedures in 30 days → patient list → Recall campaign (T1) drafts contact messages, infection-control nurse approves → D-02 quarantined, culture task, manufacturer notified (vendor access logged). Digest: outbreak query time-to-list 4 min, 23 contacts, 0 blocked human paths.

**6.7 Cross-line VIP + MLC + fraud in one hour (paeds):** MLA's grandchild in PICU (VIP alias), a burn case with suspected abuse (MLC + child protection), and a JSY duplicate-claim attempt at the maternity desk — three different registers, one duty manager; each evented; access review flags a curious clerk opening the VIP chart.

---

## 7. Compliance, audit & statutory surfaces

| Statute / standard | Surface (table/register) | Who signs | Retention | Inspector demands |
|---|---|---|---|---|
| PCPNDT Act 1994 + Rules | Form F per scan (Plan 18 table), machine/sonologist registration config, sealed | Sonologist | ≥2 y (keep 5) | Form F register, machine list, monthly report to appropriate authority |
| MTP Act 1971 + 2021 Amendment, Regulations 2003 | `mtp_register` (Form I opinion, Form II admission, Form III report), consent (Form C), approved-place cert | RMP(s), owner of place | 5 y | Monthly report, approved-place certificate, opinion forms |
| POCSO Act 2012 §19 | `pocso_register`, intimation record, MLC link | Treating doctor + MS | Indefinite (MLC) | Intimation proof, timing |
| Registration of Births & Deaths Act 1969 / CRS | `birth_reports`, `mccd_records` (Form 4/4A) | Institution head/MRD | Indefinite | 21-day reporting proof |
| MDSR guidelines (MoHFW) | `mdsr_cases` | Facility nodal officer | 10 y | 24 h notification, review within 1 week |
| JSY/JSSK/PMJAY/state dialysis scheme | payer tags, pre-auth objects, scheme claims | Scheme desk | 8 y (fiscal) | Beneficiary registers, claim trails |
| NPPA stent/knee price orders | tariff ceiling config versioned | Billing head | 8 y | Invoice vs ceiling |
| AERB (Atomic Energy Radiation Protection Rules 2004; AERB safety codes) | licences, QA registers, TLD reads, source movements, incident register, RSO credential | RSO, physicist | Life of machine + 5 y | e-LORA licence, QA logs, TLD records, source inventory |
| NDPS Act + Rules 2015 (RMI for essential narcotics) | narcotic registers (Plan 16) with palliative path | Prescriber, pharmacist, witness | 2 y (keep 5) | Stock/consumption register, Form 3-C |
| BMW Rules 2016 | placenta/cytotoxic/sharps manifests (Plan 19) | BMW in-charge | 5 y | Annual return, manifests |
| HIV & AIDS (Prevention & Control) Act 2017 | sealed serology; class-only display | — | — | Confidentiality controls |
| Drugs & Cosmetics Act / Schedule H1 | chemo/sedation dispensing registers | Pharmacist | 2 y | H1 register |
| NABH 5th/6th ed. (COP for obstetrics, paediatrics, oncology, dialysis, endoscopy; MOM; HIC) | KPIs, incident, HAI, reprocessing logs, water register | Quality head | 5 y | Indicator data, SOP acknowledgment |
| Clinical Establishments Act | minimum standards for each line | Owner | — | Registration |
| DPDP Act 2023 | data classes: **sealed** (MTP, PCPNDT, HIV, POCSO), **sensitive** (all clinical), **child data** (guardian consent §9) | DPO | per record law | Consent records, DPIA |
| ABDM/NHCX | care-context links, package codes | — | — | — |

**Consent forms:** ANC/delivery package, LSCS, MTP Form C, PCPNDT declaration, blood, sedation, radiation (RT and fluoroscopy), contrast, chemo (regimen-specific, language), dialyser reuse, dialysis catheter, endoscopy + biopsy, paediatric guardian consent, clinical photography. All QR-verified prints (§11.18 lock 4).

---

## 8. Staff KPI & KRA

All KPIs: event-derived, load-normalised (context shown), diagnostic only (S10 §2). Gaming checks routed to Fraud Sentinel as diagnostics.

| Role | KPIs (formula → events) | KRA | Gaming vector → resistance |
|---|---|---|---|
| Obstetrician (14) | D2D compliance = count(`surgery.started`−`lscs.decided` ≤30m)/count(lscs.decided) · partograph completion = labours with ≥1 entry/30 min in active phase · decision-at-action-line = `labour.decision_recorded` within 30 min / `partograph.action_crossed` · LSCS rate (Robson group-adjusted) · PPH rate/100 deliveries · stillbirth rate | every labour to a documented decision | delaying `lscs.decided` entry → decision time vs partograph trend anomaly; late-entry flags counted |
| Labour nurse (40) | partograph entry timeliness · band-pair scan compliance = pair_verified/handover events · EBM verify compliance · handover acks | partograph current, pairs verified | scan clustering at shift end → time-distribution check |
| Neonatologist (41) / NICU nurse | NICU admission acceptance time · KMC hours/eligible baby · screening on-time (ROP/OAE) · EBM mismatch near-misses (a catch counts positive) · data-gap incidents | every neonate screened and fed safely | — |
| Interventional cardiologist | D2B median + ≤90 compliance · FMC-to-device for transfers · contrast volume/eGFR-adjusted · dose per procedure (DAP) vs peers · stents/lesion (case-mix) · 30-day readmission | STEMI clock met; dose and consignment honest | selecting easy cases → case-mix normalisation |
| Cath technologist | consignment scan-at-use compliance (usage rows with sticker scan) · dose log completion 100% · reconciliation variance | nothing deployed unrecorded | — |
| Medical oncologist (43) | gate-override rate (should be low, reason-coded) · cycle on-schedule rate (±tolerance) · BSA verification 100% · tumour-board coverage for new cases · febrile-neutropenia admissions/100 cycles | every cycle cleared honestly | overriding gates → override rate visible |
| Chemo nurse / pharmacist | two-nurse scan compliance · compounding verification time · extravasation/100 infusions · spill count · vial leakage triangle | safe administration | — |
| Radiation oncologist (44) / physicist (45) / RSO (46) | missed-fraction rate · OTT extension · daily QA done-before-first-fraction 100% · TLD read completeness · source movement pairs closed 100% · plan-approval to first fraction days | course delivered as prescribed; AERB clean | — |
| Nephrologist (48) / dialysis tech (49) | runs delivered vs prescribed · sero-rule violations (0) · water tests in date 100% · disinfection log gaps · emergency-request-to-connect ≤2 h · access infection rate/1000 catheter-days · run-time deviation | safe segregated runs | shortening runs → duration vs prescription deviation flag |
| Endoscopist / reprocessing tech (50) | scope trace completeness 100% · cycle-skip count 0 · hang-time expiries · biopsy dispatched with label 100% · sedation adverse events · prep adequacy | traceable, sterile, labelled | — |
| Paediatric nurse | weight currency on orders · immunisation on-time · parent-pass compliance | dose-safe children | — |

**Owner's 8 a.m. digest (this department set):** deliveries (SVD/LSCS), D2D breaches with reasons, NICU census, EBM near-misses; STEMIs + D2B, consignment aging; chemo cycles/blocked/overrides, spills; RT fractions, QA status, source register; dialysis runs, water status, sero incidents; endoscopy count, scopes quarantined; open POCSO/MTP/MDSR tasks (counts only, sealed).

---

## 9. AI agents & the copilot

| Name | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval/guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Partograph Watch | automation | T1 | partograph entries; alert/action line geometry | `partograph.alert_crossed/.action_crossed`, nurse nudge | obstetrician decides | paper partograph | per-automation | n/a | golden partographs | sensitive | Plan 23 |
| D2D / D2B / Door-to-needle Clock | automation | T1 | lscs.decided, stemi.diagnosed, surgery.started, balloon.inflated | SLA breach + ladder | — | wall clock + paper | per-automation | n/a | clock fixtures | sensitive | 23/24 |
| Dyad Guardian | automation | T1 | band scans, EBM scans, gate exits | mismatch block + incident | — | manual two-person check | per-automation | n/a | mismatch fixtures | child | 23 |
| Chemo Gate | automation (engine refusal) | T1 | verified lab results, weight, consent, funding | `chemo.gate_blocked` | oncologist override | paper gate sheet | per-automation | n/a | threshold fixtures | sensitive | 22 |
| BSA Double-Check | automation | T1 | height/weight, formula | plausibility + verifier request | verifier signs | calculator | — | n/a | bounds tests | sensitive | 22 |
| Water-Quality Watcher | automation | T1 | water_tests, plant telemetry | block/release | RO tech + nephrologist | manual log | — | n/a | threshold | none | 21 |
| Scope Trace | automation | T0 | procedures, cycles | trace query, quarantine | — | paper log | — | n/a | chain test | sensitive | 26 |
| Consignment Reconciler | automation (Leakage Auditor ext.) | T0 | Plan 14 ledger, usage, invoices | mismatch tasks | — | manual 3-way | — | n/a | — | none | 24 |
| AERB Register Compiler | automation | T2 draft | QA, TLD, source rows | draft monthly AERB reports | RSO signs | manual compile | — | n/a | — | staff | 25 |
| Recall (ANC/fraction/session/immunisation/rehab) | automation (existing) | T1 | no-show, missed slots | ladder messages, call tasks | — | call list | existing | n/a | existing | sensitive | 12b + each plan |
| Procedure/Discharge Summary Drafter (cath, endo, delivery, NICU) | agent | T2 | permission-filtered fact sheet (tokenised) | draft narrative referencing structured fields | doctor signs | template | per-agent | model id, prompt v, hashes | leak fixtures; four-state | sensitive | with modules, post-12a |
| Tumour Board Pack Assembler | agent (assembly deterministic, narration inference) | T2 | staging, pathology, imaging refs (tokenised) | one-page pack draft | board | manual pack | per-agent | stamps | narrate-never-originate | sensitive | 22 |
| MDSR Narrative Drafter | agent | T2 | timeline of the maternal death (tokenised) | chronology draft | nodal officer | manual | per-agent | stamps | must cite event ids | sealed-adjacent (DPIA L1) | 23 |
| Labour-trend watch (S10 A3 vision) | agent | T1 (nudge only) | partograph + CTG series | "review bed 3" nudge | obstetrician | Partograph Watch | per-agent | — | precision/recall on retrospective labours | sensitive | post-90-day baselines |

**Three lanes:** Lane 1 hand-built: labour board, STEMI clock banner, chemo day-care board, dialysis session board, scope status board, EBM scan screen, band-pair scan. Lane 2 schema-generated: ANC visit form, water test, disinfection log, QA log, TLD entry, source movement, reprocessing cycle, KMC/screening tasks, cardiac rehab worklist. Lane 3 conversational: "which scopes are ready", "who is overdue for fraction", "show undecided labours", "draft delivery summary" — under user ∩ agent permissions, propose→confirm. **Journey Feed contributions:** pregnancy thread posts ANC/risk/labour/birth/NICU; STEMI thread posts every clock milestone; chemo posts gate results; RT posts fractions; dialysis posts runs and sero class changes (class only); endoscopy posts scope id and biopsy status.

**Prompt inputs (concrete, delivery summary):** tokenised sheet = `[PT-1]` age band, gravida/para, risk flags (enum), mode of delivery, blood loss, APGARs, baby weight, complications (coded), medications (coded), follow-up dates. No free text unless scrubbed. Output must reference line-ids; unknown token → drop.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context:** wristband/QR on mother, baby, EBM bottle, chemo bag, dialyser, scope, stent sticker, biopsy jar. Target: any desk resolves context < 300 ms.
- **Decision-forcing screens:** partograph with the action line drawn and a modal decision; STEMI banner with the running clock on every ED/cath screen; chemo gate summary card (four-state render) before compounding.
- **Pre-filled forms:** ANC visit from last visit; run sheet from prescription + last run; fraction check-in from R&V schedule; reprocessing cycle from AER export.
- **Keyboard-first** at scheme/TPA desks; **large touch** on labour-room, NICU, day-care tablets; thumb-impression consent flow.
- **TAT clocks:** D2D 30, D2B 90, DTN 30, emergency dialysis 120 min, chemo lab-to-clear median, scope turnaround, fraction on-time.
- **Printing:** birth certificate draft, MCCD, discharge summary, chemo chart, dialysis run sheet, AERB monthly — all QR-verified.
- **Voice (lawful):** Whisper (via 12a InferenceClient choke) for dictated procedure notes only after tokenisation review; never for orders.
- **Perf budgets:** boards < 300 ms; scan response < 100 ms; fraction import batch < 5 s.

---

## 11. Integrations, devices & dependencies

| Line | Devices/vendors (Indian market examples) | Protocol | Edge rule |
|---|---|---|---|
| Maternity | CTG (Edan, BPL, Philips Avalon) with data export; warmers/phototherapy (Phoenix, GE Lullaby); NICU monitors via vendor CMS (§11.15) | serial/HL7 → MQTT → TimescaleDB | edge box per hall; heartbeat |
| Cath | C-arm/cath lab (Philips Azurion, Siemens Artis, GE) DICOM + RDSR dose; IVUS/FFR; injector (Medrad) | DICOM (Orthanc), RDSR parse | dose extractor on edge |
| Onco | LINAC + R&V/TPS (Varian ARIA/Eclipse, Elekta MOSAIQ/Monaco); CT-sim DICOM; brachy afterloader | HL7/FHIR/CSV export mandate | HMIS never writes into R&V; import-only |
| Dialysis | Machines (Fresenius 4008/5008, Nipro, B.Braun) with serial/USB export; RO plant sensors | serial/MQTT | usage events; manual first |
| Endoscopy | Scopes (Olympus, Pentax, Fujifilm), AER (Olympus OER, Medivators, local) with printouts/USB | CSV/serial | cycle import; manual fallback |
| Paeds | integrated scale at vitals desk | serial | — |
| All | PACS Orthanc (Plan 18), LIMS (17), pharmacy (16), procurement consignment (14), BMW (19), notifications (10), Plan 09 counters, Plan 13 registry, ABDM care-context | FHIR internal | — |

Events consumed: result.verified, vitals.recorded, patient.admitted, consent.recorded, device.usage_*, material.issued, payment.received, preauth.*, roster.published, chaperone.present, form_f.recorded, specimen.dispatched, code.activated.

---

## 12. Buy vs build, hardware & rough INR budget

Buy: R&V/TPS (with LINAC, ₹15–25 Cr machine; software bundled), vendor CMS for NICU/CCU (with monitors), AER with export (₹8–15 L each), cath-lab dose export (with machine), dialysis machines with data ports (₹6–9 L each), CTG with export (₹1.5–3 L), licensed dose-range and regimen content (§9 §19 line), TLD service (AERB-accredited, ~₹100/badge/quarter). Build: all module tables/workflows above; edge extractors (dose, fraction import, AER import, machine usage). Hardware adds: 3 edge mini-PCs (₹40–60k each), tablets for labour room/NICU/day-care/dialysis (~20 × ₹25k), band printers (2 × ₹60k), label printers for EBM/chemo/biopsy (6 × ₹25k), scanners (15 × ₹3k), integrated scales (3 × ₹40k). Software budget for this document's plans: build only; ~₹0 licence beyond content and vendor bundles. Indicative total add ≈ ₹12–16 L excluding clinical capital equipment.

---

## 13. Owner rulings needed

- **O-1 JSSK zero-cash rule.** Default: JSSK/JSY-tagged encounters block cashier collection; override by management only, evented. Why: scheme audit exposure.
- **O-2 NPPA ceiling enforcement mode.** Default: hard block above ceiling (versioned config). Why: legal exposure; corporate practice.
- **O-3 Dialysis water-test overdue = block.** Default: block new starts when monthly culture/endotoxin overdue by >3 d. Why: NABH + patient safety; some centres only warn.
- **O-4 Sero-positive dialysis policy.** Default: dedicated HBV machines; HCV dedicated where feasible; HIV on dedicated or last-slot with full disinfection (NKF/ISN norms). Why: capital cost vs safety.
- **O-5 Chemo gate override authority.** Default: oncologist + second oncologist/physician signature. Why: policy.
- **O-6 Mixed-gender chemo/dialysis bays.** Default: allowed with curtains, female-preferred bay; maternity/gynae day-care female-only. Why: policy + space.
- **O-7 Maternity/paediatric retention period.** Default: until age 21 + 3 y. Why: legal counsel.
- **O-8 MTP approved-place + PCPNDT certificates** (already opened by stage-2 ruling; go-live gates for Plans 23/26 scan use).
- **O-9 AERB licence/RSO appointment** for LINAC/brachy/cath fluoroscopy — owner action; go-live gate for Plans 24/25.
- **O-10 Dialyser reuse policy.** Default: reuse allowed for seronegative with consent, max 6 uses, TCV ≥ 80%; no reuse for seropositive. Why: cost vs infection.
- **O-11 Sedation policy for endoscopy.** Default: propofol only with anaesthetist; conscious sedation by endoscopist with monitoring. Why: legal exposure.
- **O-12 Plan numbering** — accept 23–27 as proposed or renumber at series reconciliation.

---

## 14. Plan sketch

Consistent with doc 04: **Plan 20** session core + physio, **Plan 21** dialysis (this doc supplies §3.5/§4/§5.5/§7 clinical content), **Plan 22** chemo day-care (§3.3/§5.3). New:

- **Plan 23 — Maternity & NICU** (after IPD cluster + 13 + 17 + 18 Form F; NICU needs ICU hall telemetry). T1 schema + registers (sealed classes) · T2 WF-M1/M2/M3 definitions + D2D clock · T3 dyad/band/EBM scan screens · T4 NICU pack on ICU hall + KMC/screening tasks · T5 MTP/POCSO/MDSR/CRS/MCCD surfaces · T6 JSY/JSSK payer tags + packages · T7 agents (Partograph Watch, Dyad Guardian, MDSR drafter) · T8 downtime kit forms + backfill · T9 fixtures from §5.1. Gate: MTP/PCPNDT certificates.
- **Plan 24 — Cath lab & cardiology** (after 14 consignment, 18 PACS, ED module). T1 STEMI case + clocks · T2 WF-C2 gates + dose log · T3 consignment scan-on-use + NPPA ceiling · T4 post-PCI monitoring on ICU pack · T5 rehab on Plan 20 · T6 Consignment Reconciler · fixtures §5.2. Gate: AERB fluoroscopy registration.
- **Plan 25 — Radiation oncology orchestration** (at LINAC commissioning; vendor chosen with export mandate). T1 courses/fractions/dose ledger · T2 R&V import edge + mapping table · T3 AERB registers + QA lockout on registry device · T4 brachy source workflow · T5 billing per fraction/package · T6 AERB compiler · fixtures §5.4. Gate: e-LORA licence, RSO.
- **Plan 26 — Endoscopy** (after 15 mini-OT patterns, 17 histopath). T1 procedures/scopes/cycles · T2 WF-E1/E2 · T3 AER import · T4 sedation + chaperone gates · T5 Scope Trace · fixtures §5.6.
- **Plan 27 — Paediatric rules pack** (small; with IPD/PICU): weight currency, dose caps via licensed content, immunisation schedule in `patients`, parent-pass variant, PALS/NRP codes; fixtures §5.7.

**Sequencing/gates:** 13 → 14 → 15 → (16, 17, 18 ∥ 19) → 20 → 21/22 → IPD/ICU cluster → 23/24/26 → 25 at LINAC; 27 rides IPD. **Must be true before authoring:** owner rulings O-1..O-11; statutory certificates; vendor export capability confirmed per device; IPD/ICU boundary map (E-11) for day-care conversions.

**Negative-space question:** a labour in active phase with no partograph entry for 60 min; `lscs.decided` with no `surgery.started` in 30 min; a `stemi.diagnosed` with neither balloon nor lysis in 120 min; a chemo cycle cleared but no `medication.administered` in 24 h; a dialysis patient with no run in 5 days; a machine with usage and no disinfection between runs; a source checked out with no return; a scope used with no cycle after; a live birth with no immunisation event in 24 h; a newborn with no band-pair event in 30 min; a Form F-applicable scan closed with no `form_f.recorded` (must be impossible); a minor pregnancy with no `pocso.intimated` in 24 h; a maternal death with no MDSR case in 24 h.

**Staff edge-case interview questions:** 1) How often is the partograph actually started before 4 cm, and who fills it at night? 2) What happens today when both ED theatres are busy and an LSCS is decided? 3) How do you label EBM now, and has a wrong-milk event ever happened? 4) How are JSY beneficiaries identified and paid — where does the cash come from? 5) Cath: who counts consignment stock and how often does the rep's challan disagree? 6) What do you do when the creatinine is not back and the patient is on the table? 7) Onco: how many gate overrides per month and who signs? 8) Who computes BSA today and on which weight? 9) RT: how does the R&V export look — file, print, nothing? 10) Who holds the brachy source keys? 11) Dialysis: how do you handle a seroconversion discovered mid-month? 12) What is your dialyser reuse practice and who consents? 13) Endoscopy: how long do scopes hang before reuse, and is the AER printout kept? 14) Paeds: where is weight measured, and how often is it stale on the order? 15) How do you handle a mother who refuses a female chaperone's presence or a male doctor?

---

## 15. Open questions & risks

- R&V/TPS export formats vary by vendor (ARIA HL7 vs MOSAIQ); the mapping table and import edge cannot be designed until the LINAC vendor is chosen — Plan 25 blocks on procurement.
- Whether NICU shares the ICU module's hall implementation or maternity owns NICU tables: recommended NICU admission = ICU module instance with a `nicu` pack; maternity owns only EBM/KMC/screening. Needs the ICU plan author's agreement.
- Immunisation table home (`patients` vs a `preventive` module) — recommended `patients`; may conflict with a preventive-health/checkup document in this series.
- Sedation policy legal exposure (O-11) and dialyser reuse (O-10) are practice-dependent; counsel input.
- Maternal-death and POCSO surfaces touch police/district portals with no APIs — manual tasks with proof uploads; risk of task backlog.
- Day-care encounter conversion before IPD ships remains a two-system handoff (E-11); every line in this document inherits that risk until the IPD cluster lands.
- Dose-range and regimen content licensing (§9 v4.6) is still a §19 decision; Chemo Gate thresholds and paediatric caps must not be hand-authored beyond the pilot.
- Plan numbers 23–27 may collide with other documents in this series; reconcile before roadmap entry.
