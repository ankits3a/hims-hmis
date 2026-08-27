# 22 — Quality, NABH Accreditation, Incident Reporting, Infection Control, Internal Audit, Committees & Governance — Brainstorm & Planning

Date: 2026-08-27 · Status: **Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED** · Series: Department Brainstorm & Planning 2026-08-27 · Author: planning agent, from spec v4.8, S10 v1.3, copilot design, roadmap, Plan 13, and documents 01–20 of this series.

**Executive summary.** This module is the hospital's *evidence engine and conscience*: the place where NABH's ten chapters, the statutory registers, the incident/near-miss/RCA/CAPA loop, HAI surveillance, committees, controlled documents, credentialing, licences, drills, clinical audits, the internal-audit program, DPDP compliance and the owner-as-governance-role machinery all become **tables, workflow definitions and event subscriptions** rather than binders. It is deliberately thin in code and thick in configuration: almost everything it "measures" already happens elsewhere (spec §6: *audit is structural*), so the module mostly **subscribes, computes, registers, schedules and proves**. It is NOT: an HR/payroll system (bought), a document-management SaaS (the Expertise store from roadmap note 8 is the one document layer, shared with agent playbooks), an accounting/internal-audit ledger (Tally + the external §138 auditor), a clinical rules engine (Phase-2, licensed content), or a place where any KPI becomes a punishment (S10 §2, law 11). Its three hardest problems: **(1) the reporting-culture paradox** — the more incidents a good hospital reports, the worse it looks on any naïve number, so the design must make reporting rate a *health* signal, anonymous reporting genuine, and RCA blameless, while still letting the owner see negligence; **(2) evidence honesty** — NABH indicators computed from events are only as true as the events, and the read-model honesty clause (§11.19-C-20) says care without an event is invisible, so every indicator must carry a completeness/denominator-validation flag instead of a confident number; **(3) governance without a second adult** — production has one full admin and the owner is a solo director (Plan 13 §4A-3, runbook O1); two-key rules, SoD, committee quorum and incapacity protocols are theatre until a second approving actor exists, and the module must be built so it is *honest about that* rather than pretending.

---

## 1. Frame — what exists, what is locked, what this document adds

**Inherited, locked (cite, never re-litigate):**
- §6 *audit is structural*: event log + append-only financials + `updated_by/updated_at` = NABH-grade traceability; no separate audit subsystem. This module therefore builds **registers and views over events**, plus the few genuinely new lifecycles (incident, RCA/CAPA, outbreak, committee action, audit finding, licence, SOP acknowledgement, DSR).
- §9 module catalog: *incident reporting (NABH) · quality-indicator dashboards · feedback/grievance* are named future modules; biomedical AMC/calibration is BME (doc 19 / Plan 20-21 there).
- §11.14: code system (Violet/fire/Yellow), live grievance workflow, needle-stick → PEP task with first-dose clock → incident register, DPDP data-principal rights with retention-bounded erasure and legal holds, cyber incident → CERT-In 6 h, insurance identity fraud → incident.
- §11.19-C-25: five governance role cards (Quality Manager/NABH, ICN, MS, …) "staffed from day one"; C-31 two-key rule for Workflow-Tuner changes to clinical-safety definitions; C-20 read-model honesty clause + care-audit mismatch agent (T0).
- §11.19-D: **D-10 owner is a governance role** (two-key emergency activation: duty manager + MS; medical director for clinical definitions; declared-incapacity deputy pair, time-boxed, evented, ratified, legal instrument); **D-12 technical continuity kit** + annual stranger drill; **D-15 risk-tiered change classes A/B/C** (taxonomy itself Class A); D-17 internal-audit program; D-36 automation-bias instrumentation; D-38 nursing scales day one + patient-satisfaction micro-survey Phase 1; **D-39 committee machinery** (entity, cadence, agenda auto-fed, minutes, action-taken with due dates; DTC, infection control, quality & safety, mortality, tumour board, blood transfusion, POSH ICC); **D-40 controlled-document layer** (SOPs versioned/approved, read-and-acknowledge per staff, each workflow definition links its SOP); **D-41 HR-evidence bridge** (HMIS owns training, drills, occupational health/immunisation, credential files); **D-42 DPDP architecture** (DPO = quality manager dual-hat day one, grievance officer, DPIA before each agentic phase); D-44 inference locus decided in DPIA.
- §11.19-E: E-5 emergency-governance precedence over SoD; **E-17 internal-audit program** (Companies Act §138 external auditor, concurrent audit, control-testing calendar, quarterly management control-review committee); E-19 evidence-retention map; **E-20 external-access personas + inspection-visit workflow**; E-28 bulk-export governance; E-32 HFR/HPR on compliance calendar; E-34 CLRA registers.
- §14 security (break-glass loudly logged and *queued for review* — that review queue lives here), §16 agent tiers and guardrails, S10 §2 KPI philosophy, S10 cards 37/38/39, S10 §11 SoD (quality auditor ≠ audited-station holder), S10 §12.19/20 owner succession + DPO.
- Roadmap: Quality/NABH pack is a **Phase-2 fast-follow** (spec §17); roster module ships in that window (D-16); **note 8 — one Expertise store for humans and agents, vehicle = this pack**, versioned + change-classed on the 12a governance shape; **note 12 — continuous protocol-adherence evaluation as deterministic automation, deviations are review tasks (T2 cap applies to quality machinery)**; 12a's prompt/playbook governance (versioned artefacts).
- **Plan 13 §4A-3 RULED 2026-08-26:** master-data change control is **its own phase after the IPD cluster, and cannot be scheduled before runbook O1 closes** (one approver = theatre). This document treats the *governance* half accordingly: it designs the shapes, and sequences the two-actor parts behind O1.
- Plan 12a: draft provenance stamps, per-agent kill switch, global halt, action budgets, eval harness — reused verbatim.

**Neighbours and table ownership.** ICU owns `icu_hai_register`/device-days (doc 06) — this module owns the **hospital-wide HAI case register** and consumes ICU's device-day feed via interface, never its table; the ICU register row is the clinical source, the quality row is the surveillance case (confirmed/ruled-out per CDC/NHSN-style definitions, adapted). Housekeeping owns BMW registers, environmental samples, cleaning runs (doc 08); this module *reads* them for HIC evidence and hosts the BMW authorisation on the licence register. Nursing (doc 07) owns hand-hygiene *moments observed* if recorded at bedside; this module owns the **audit instrument and the sampled audit rounds**. Staff-KPI (doc 11) owns the KPI formula registry (`kpi_metric_versions`); **NABH indicators are metric ids in that registry** with an `indicator_set = nabh_5e|nabh_6e` tag — this module owns the indicator *set*, its validation status and submission packs, not the compute engine. CSSD (doc 15) owns sterilisation loads and BI results; this module owns the monitoring *audit* and the recall workflow trigger. Pharmacy (doc 16) owns medication error *capture at dispense*; this module owns the medication-error taxonomy (NCC MERP category) and the register view. Blood bank (doc 18) owns transfusion reactions and the haemovigilance report; the transfusion committee lives here. Front office (doc 20) owns feedback/NPS/grievance capture; the grievance *committee* and the NABH PRE evidence live here. ED (doc 14) owns MLC; MLC oversight sits with the MS worklist here. BME (doc 19) owns equipment, AMC, calibration; the FMS evidence pack reads it. IPD/MRD (doc 17) owns the medical-record audit *sample frame* (files); this module owns the audit instrument and findings. Kernel owns `workflow_definitions`, `approvals`, `events`, `resources` — the module never writes them directly.

**What this document adds:** the register/indicator/evidence architecture; the incident → classification → RCA → CAPA lifecycle as a workflow definition; HAI surveillance and outbreak as workflows; committees as entities with action items as P5 tasks; the controlled-document and acknowledgement model as the Expertise store's human face; credentialing/privileging and licence registers with an expiry watchman; the internal-audit control-testing calendar; inspection-readiness "one-click" answer surfaces; DPDP compliance program; the owner-as-governance-role runbook rendered as evented workflows; agents; ~100 edge rows; chaos walkthroughs; plan split.

---

## 2. Actors, roles & role cards

| # | Role (S10 card) | Stations in this module | Shift/coverage | Notes |
|---|---|---|---|---|
| 37 | **Quality Manager / NABH coordinator** (S10) — **DPO dual-hat day one** (D-42, S10 §12.20) | Incident triage queue, RCA facilitation, indicator validation, audit calendar, committee secretary default, document controller, inspection-visit host, DSR register owner | Day; on-call for sentinel events | SoD: auditor ≠ audited-station holder; cannot close an incident she reported |
| 38 | **Infection Control Nurse (ICN)** (S10) | HAI case adjudication, hand-hygiene audits, isolation compliance, outbreak workflow, PEP clock owner, sterilisation-monitoring audit, BMW segregation audits, antibiogram compilation with micro | Day; ICN-on-call ladder for exposures at night (falls to duty nurse-in-charge + protocol) | HC 1 → 3–4; night PEP first dose never waits for the ICN |
| 39 | **Medical Superintendent** (S10) | Credentialing/privileging decisions, mortality review chair, MLC oversight, sentinel-event owner, two-key clinical definitions, incapacity-deputy pair member, RCA sign-off for clinical incidents | Day + deputy chain | Succession chain mandatory (S10 §12.26) |
| — | **Owner (governance role)** (D-10) | Class-A approvals, committee ratification, licence signatory, NABH application signatory, CERT-In/DPB notification signatory (recommended default: owner = "occupier"; MS as alternate), incapacity declaration counterpart | Asynchronous via approvals queue | Two-key emergency path; every act evented |
| NEW-Q1 | **Quality Executive / MIS analyst** | Indicator data-validation checks, audit rounds (hand hygiene, medical-record, prescription), evidence-pack assembly review, drill logistics | Day | HC 0 → 2–3 at 300+ beds; day one the QM does it |
| NEW-Q2 | **Infection Control Officer (microbiologist/physician)** | Chairs HICC, antibiogram sign-off, antimicrobial stewardship, outbreak declaration co-signatory | Part-time day one (visiting microbiologist per doc 02 O-12), full-time at ICU commissioning | Clinical authority the ICN lacks |
| NEW-Q3 | **Patient Safety Officer** | May be the QM or MS day one; sentinel-event 24-h owner, IPSG audit owner | — | NABH 6th edition asks for a named patient-safety lead; recommend MS deputy holds it |
| NEW-Q4 | **Document Controller** | SOP versioning, acknowledgement chasing, superseded-copy withdrawal, print-control of controlled forms | Day; QM day one | Expertise store custodian for human documents |
| NEW-Q5 | **Compliance & Licence Officer** (admin) | Licence register upkeep, renewal filings, inspection scheduling, CEA/fire/AERB/PCPNDT/BMW/drug-licence/lift/DG/boiler/PNG correspondence | Day | Reports to owner; QM verifies (doc 01 O-13 precedent) |
| — | **Department heads / HODs** | Incident reviewers for their area, CAPA owners, clinical audit participants, committee members | — | Cannot review incidents in which they are the named actor |
| — | **Any staff member** | Incident/near-miss reporter (named or anonymous), SOP acknowledger, training attendee, drill participant, grievance raiser | — | Reporting is a permission every login holds; anonymous path needs no login |
| — | **Committee chairs & secretaries** (per committee) | Agenda approval, minutes sign, action assignment | Cadence per committee | Chair ≠ secretary (SoD light) |
| — | **Internal auditor (external firm, §138)**, **concurrent auditor**, **NABH assessor**, **statutory inspectors** (CEA, fire, AERB, PCPNDT appropriate authority, SPCB, drug inspector, labour, DPB) | Read-only scoped personas, inspection-visit workflow (E-20) | Time-boxed grants | Sealed class always excluded |
| — | **Deputy pair (incapacity protocol)** — pre-designated, D-10 | Time-boxed owner authorities | Dormant | Legal delegation instrument on file (owner action) |
| — | **Grievance officer** (DPDP §13; D-42) and **POSH ICC presiding officer + external member** | DSR/grievance register, ICC register | — | ICC records are sealed-class |
| Agents/automations | Evidence Pack Compiler (automation) · Licence & Credential Expiry Watchman (T1 automation; extension of §16 Expiry Watchman) · HAI Cluster Detector (T0 automation) · Protocol-Adherence Evaluator (automation, note 12) · Indicator Data-Validation checker (automation) · Committee Agenda Feeder (automation) · Audit Round Sampler (automation) · Indicator Anomaly Explainer (T0 agent) · Incident Classifier (T2 agent) · RCA Drafter (T2 agent) · SOP-Change Impact Summariser (T2 agent) · Care-Audit Mismatch (T0, C-20, inherited) · Digest Writer contributions | Under 12a harness | Kill-switch per actor; global halt |

**Bundling/night collapse.** Night: incident intake is self-service (no human station); sentinel events page the duty manager → MS deputy → owner SMS (dead-end fallback C-11). PEP first dose: duty nurse-in-charge executes the protocol task; ICN reviews by morning. Outbreak declaration cannot be made at night by a single person — *suspected cluster* flag + cohort isolation is available to the duty manager (§11.15 hall cohort mode), formal declaration needs ICO + QM/MS in the morning. **SoD hard pairs (add to S10 §11):** incident reporter ≠ incident closer · RCA facilitator ≠ named actor in the incident · CAPA owner ≠ CAPA verifier · document author ≠ document approver · licence-register updater ≠ renewal-filing verifier · privileging applicant ≠ privileging approver (obviously) · audit-round auditor ≠ station on duty during the audited window · anonymous-report de-anonymiser (never exists; see §5 F-rows).

---

## 3. Core flows as workflow definitions

All lifecycles below are **workflow definitions** (law 2), activation by owner (§10.4), Class A where they touch patient safety or statutory reporting. Events reuse the catalog; NEW names are marked.

### 3.1 Incident / near-miss / sentinel event (P5 task-and-track with a P7 ladder; the module's spine)

```
[reported] --triage(QM/deputy, SLA 1 working day; sentinel: 1 h)--> [classified]
   |                                                    |
   | (anonymous: no actor on envelope; see 4.x)          +--> [closed_no_action] (near-miss, reviewed, learning note only)
   v                                                    |
[classified] --assign_review(HOD, SLA 3 d)--> [under_review] --review_done--> [rca_required?]
                                                                     | yes                     | no
                                                                     v                         v
                                                            [rca_open] (SLA 14 d; sentinel 45 d per NABH/JCI norm, recommend 30) [capa_planning]
                                                                     |                               |
                                                                     v                               v
                                                            [rca_signed] (MS for clinical; QM for non-clinical) --> [capa_planning] --> [capa_open] (n tasks) --> [capa_verified] --> [closed]
                                                                                                                                                  ^                       |
                                                                                                                                                  +--- reopen (recurrence within 90 d) ---+
[any state] --sentinel_declared(MS/QM/duty manager)--> sentinel flag: 24 h owner+MS notification, external reporting checklist, legal-hold offer, open-disclosure task (O-3)
```

- **Trigger sources:** manual form (any login, or anonymous QR/kiosk/WhatsApp link), and **auto-raised** from events: `transfusion.reaction_flagged`, `adr.reported`, `count.mismatch_flagged`, `band.pair_mismatch`, `medication.missed` (pattern), `exposure.reported`, `code.activated`, `patient.missing_flagged`, `break_glass.used` (review class, not incident), `qc.override_recorded`, `coldchain.excursion`, `fall` (NEW `fall.recorded` from nursing), `pressure_injury.recorded` (NEW, nursing), `wrong_patient.flagged` (NEW; any right-patient scan mismatch on a hard stop), `return_to_ot.recorded` (NEW, OT), `unplanned_extubation.recorded` (ICU), `icu.readmission_flagged`, `readmission.flagged`, `security_incident.declared`, `message.spoof_reported`, `qr.signature_failed`, `care_audit.mismatch`, `sod.violation_blocked` (pattern), `patient.deceased` (mortality review feed, not incident), `grievance.raised` (category = safety).
- **Roles:** reporter any; triage QM/Quality exec/duty manager (night); HOD reviewer; RCA facilitator QM; sign-off MS (clinical) / QM (non-clinical) / owner (sentinel ratification); CAPA owner HOD; CAPA verifier QM or ICN; closure QM.
- **SLA per state:** triage 1 working day (sentinel 1 h) · review 3 d · RCA 14 d (sentinel 30 d) · CAPA per item, default 30 d · verification 15 d after CAPA completion · total incident closure target 45 d (S10 card 37 OKR: RCAs closed <14 d).
- **Escalation ladder:** breach → QM → MS → owner digest; sentinel breach → owner SMS.
- **Events:** `incident.reported` (existing) · NEW `incident.classified` (severity: near_miss | no_harm | minor | moderate | severe | sentinel; category taxonomy; harm scale = NABH/WHO ICPS-derived) · NEW `incident.review_assigned` · NEW `incident.rca_opened` · NEW `rca.signed` · NEW `capa.created` (→ `task.created` for each action) · NEW `capa.verified` · NEW `incident.closed` · NEW `incident.reopened` · NEW `sentinel_event.declared` · NEW `disclosure.recorded` (open disclosure to patient/family) · NEW `external_report.filed` (to: PvPI, haemovigilance, CERT-In, DPB, SPCB Form I, AERB, police — one event, `authority` in payload).
- **Corporate-standard variants:** (a) *good-catch programme* — near-misses get a lightweight path and a monthly "good catch" recognition list (non-monetary; law 11); (b) *just-culture algorithm* — the classifier attaches a human-factors category (system/at-risk/reckless) as a *draft*, MS confirms; only "reckless" may route to HR, and only via a human decision that is itself evented; (c) *patient-reported incidents* via feedback (doc 20) join the same queue with source = patient; (d) *aggregate review* — falls, med errors, pressure injuries get monthly aggregate RCA instead of per-case when volume > threshold, per-case only for moderate+ harm.

### 3.2 HAI surveillance case (P2-like adjudication)

```
[suspected] (auto from rule: culture positive + device-day context, or fever+device, or clinician/ICN flag)
   --icn_review(SLA 24 h)--> [under_investigation] --criteria_met--> [confirmed:VAP|CLABSI|CAUTI|SSI|other]
                                                  --criteria_not_met--> [ruled_out]
[confirmed] --> registers: HAI case register, device-day denominator link, SSI 30/90-day follow-up task (implant), antibiogram link, incident (if preventable bundle breach)
```
Events: NEW `hai.case_suspected` · NEW `hai.case_confirmed` (type, onset date, device, unit, organism, MDRO flag) · NEW `hai.case_ruled_out` · NEW `bundle_audit.recorded` (bundle: VAP/CLABSI/CAUTI/SSI, compliance bitmap) · NEW `hand_hygiene.audit_recorded` (WHO 5-moments, observer, unit, opportunities, actions) · NEW `isolation.audit_recorded` · NEW `ssi.followup_recorded` (day 30/90). Consumes: `result.verified` (micro), `device.usage_started/stopped` (denominators), `isolation.flagged`, `surgery.completed`, `implant.recorded`, `patient.discharged` (post-discharge SSI surveillance via recall automation).

### 3.3 Outbreak management (P1-ish with surge-mode mechanics)

```
[cluster_flagged] (automation: ≥ threshold same organism/unit/window, or ICN manual)
   --icn_triage(4 h)--> [suspected_outbreak] --ICO+QM/MS co-sign--> [declared] --> cohort/hall isolation (§11.15), enhanced cleaning tasks (doc 08), screening orders, staff screening, admission restrictions, DHO/IDSP notification task, daily HICC huddle tasks
[declared] --no new case × 2 incubation periods, ICO sign--> [ended] --> outbreak report to HICC, CAPA
```
Events: NEW `outbreak.suspected` · NEW `outbreak.declared` · NEW `outbreak.ended` · `surge.activated/ended` reused for capacity; `notification`… ; NEW `notifiable_disease.reported` (IDSP/state list — licensed list per §9).

### 3.4 Occupational exposure (needle-stick / splash / TB / COVID-class)

`exposure.reported` (exists) → **PEP protocol task with first-dose clock** (≤ 2 h HIV PEP; HBIG ≤ 24 h) → source-patient serology order (consent rules; if source unknown → treat as high risk) → staff health record → follow-up serology at 6 w / 3 m / 6 m via Recall automation → incident register → HICC monthly. Events: NEW `pep.first_dose_given` (with minutes-since-exposure) · NEW `exposure.followup_recorded` · NEW `exposure.closed`. Night: duty nurse-in-charge can execute; the kit is a registry `store` resource with a seal-check task (crash-cart precedent §11.15).

### 3.5 Committee cycle (P5 with cadence)

`committee` entity → automation creates the meeting instance per cadence → agenda auto-fed (flagged events, open CAPAs, overdue actions, indicator exceptions, policy renewals due) → chair approves agenda → meeting → minutes (draft may be agent-drafted from agenda + decisions typed live; T2) → sign (chair + secretary) → each decision becomes a `task.created` with owner/due → action-taken register → next agenda carries open items. Events: NEW `committee.convened` · `committee.minuted` (exists) · NEW `committee.action_closed` · NEW `committee.quorum_failed`. Statutory committees with fixed composition: **HICC** (HIC), **DTC/Pharmacy & Therapeutics** (MOM), **Quality & Patient Safety** (PSQ/ROM), **Mortality & Morbidity** (COP), **Blood Transfusion** (COP, NBTC), **Ethics** (research/IEC only if research; clinical-ethics consult otherwise), **Grievance Redressal** (PRE; CEA state rules), **ICC/POSH** (POSH Act 2013 §4; ≥ 4 members, presiding officer woman, external member; annual report to District Officer §21), **Safety** (FMS; fire/disaster), **Medical Records/Audit**, **Credentials & Privileging**, **Radiation Safety** (AERB; doc 01), **Management control-review** (E-17, quarterly), **Organ-donation/brain-death** (deferred, §11.14).

### 3.6 Controlled document (SOP/policy) — the Expertise store's human lifecycle

`[draft] → [under_review] → [approved (approver ≠ author; Class per D-15)] → [published (effective_from)] → [acknowledgement_open (assignments per role/department)] → [superseded | retired]`. Events: NEW `sop.published` · `sop.acknowledged` (exists) · NEW `sop.superseded` · NEW `sop.acknowledgement_overdue`. Each workflow definition links its SOP (D-40); each SOP links its NABH objective elements and its training module. Review cadence default 2 y, or on any linked incident CAPA that names it.

### 3.7 Credentialing & privileging (§11.12 inherited, extended)

`[applied] → [documents_verified (NMC/NMR lookup, state council, degree, registration validity, HPR id)] → [privileges_proposed (procedure list)] → [committee_recommended] → [MS_approved] → [active] → [renewal_due (60/30 d)] → [expired → hard block]`; `[active] → [suspended|restricted]` on MS decision (peer review). Events: `credential.expiring/blocked` (exist) · NEW `privilege.granted` · NEW `privilege.restricted` · NEW `privilege.revoked` · NEW `credential.verified` (source, reference no., verifier).

### 3.8 Licence / statutory registration item

`[active] → [renewal_due (T-120/90/60/30/7 d, configurable per licence)] → [filed (ack no.)] → [renewed] | [lapsed → consequence policy: block dependent operations (e.g. USG without PCPNDT — doc 01 O-7; blood issue without licence; BMW handover without authorisation)]`. Events: NEW `licence.expiring` · NEW `licence.filed` · NEW `licence.renewed` · NEW `licence.lapsed` · `inspection.visit_logged` (exists) · NEW `inspection.direction_recorded` (→ task).

### 3.9 Internal audit / control test / clinical audit round

`[planned (calendar)] → [sample_drawn (automation; random, seeded, logged)] → [fieldwork] → [findings_recorded] → [management_response] → [capa] → [closed]`. Events: `audit.control_tested` (exists) · NEW `audit.round_opened` · NEW `audit.finding_recorded` (severity, standard ref) · NEW `audit.closed`. Types: hand hygiene, prescription audit, medical-record audit (open + closed file), consent audit, IPSG audit, restraint audit, crash-cart, medication storage, SoD control test, gate test, backup-restore drill result ingest, access review (E-…), export review.

### 3.10 Mock drill (P5)

`[scheduled] → [announced|unannounced] → [conducted (start/stop, participants scanned by badge QR)] → [debriefed] → [capa]`. Types: fire (quarterly per floor; NBC 2016 Part 4/state fire rules), Code Blue (monthly), disaster/MCI (half-yearly), Code Violet, Code Yellow, spill, downtime (A1 drill — S10), DR restore (weekly automated; results ingested), stranger drill (annual, D-12), evacuation. Events: NEW `drill.scheduled` · NEW `drill.conducted` (type, duration, response times) · NEW `drill.debriefed`.

### 3.11 DPDP data-principal request & breach

DSR: `dsr.requested → [verified] → [processing] → dsr.fulfilled | [refused_with_reason]` with statutory TAT (rules prescribe; recommend 30 d default, configurable) — inherits §11.14. Breach: `security_incident.declared → [contained] → CERT-In within 6 h (CERT-In Directions 28-Apr-2022) → DPB notification + affected data principals (DPDP §8(6); form/timing per Rules) → [post-incident review = RCA] → closed`. Events: NEW `breach.notified` (authority, reference, at). Consent artefacts: `consent.recorded` (exists), `dsr_consent.withdrawn` (exists).

### 3.12 Owner governance: emergency activation and incapacity (D-10, E-5)

`governance.emergency_activated` (exists): duty manager + MS both confirm within the same approval item (two distinct sessions, second factor) → time-boxed authority (default 72 h) → every act under it carries `authority_ref` → auto-expires → queued for owner ratification (`ratification` approval). `incapacity.declared` (exists): declared by deputy pair against the legal instrument → authorities for 30 d renewable → weekly digest to a named external (counsel/family) → owner return = ratify/reverse each act. **Continuity kit**: escrow unseal is a two-person evented act (NEW `continuity_kit.unsealed`); annual stranger drill is a drill type in 3.10.

---

## 4. Data model sketch

Module folder `quality` (tables prefixed `q_`); registry kinds needed: none new — uses `ward`, `hall`, `room`, `bed`, `device`, `store` (for PEP kit, spill kit, emergency drug box) from Plan 13's closed set (an eleventh kind is a kernel edit; not needed).

| Table | Key columns (sketch) |
|---|---|
| `q_incidents` | id, reporter_actor_id (nullable — anonymous), anonymous bool, reporter_channel (form/qr/whatsapp/kiosk/auto), occurred_at, recorded_at, location_resource_id, patient_id?, encounter_id?, category (taxonomy id), subcategory, description (sealed-text class), harm_level, severity, sentinel bool, source_event_id?, workflow_instance_id, status mirror, triage_actor, reviewer_actor, rca_id?, disclosed bool, legal_hold bool, closed_at, site_id |
| `q_incident_taxonomy` | id, code, label_en, label_hi, harm_default, auto_rule_ref?, nabh_std_refs[], version |
| `q_rcas` | id, incident_id, method (5-whys/fishbone/london), timeline_json (agent-drafted from events; provenance stamp), contributing_factors[], root_causes[], facilitator, signed_by, signed_at, draft_provenance (model, prompt v, in/out hash) |
| `q_capas` | id, rca_id/incident_id/audit_finding_id, type (corrective/preventive), description, owner_actor, due, task_id (P5), verification_method, verified_by, verified_at, effectiveness_check_due, status mirror |
| `q_hai_cases` | id, patient_id, encounter_id, unit_resource_id, type, onset, device_id?, device_days_at_onset, organism, mdro bool, criteria_version, status, adjudicated_by, incident_id?, ssi_procedure_ref?, followup_30, followup_90 |
| `q_device_days` (materialised) | unit, date, ventilator_days, central_line_days, urinary_cath_days, patient_days — computed from `device.usage_*` + census; `completeness` flag |
| `q_hh_audits`, `q_bundle_audits`, `q_isolation_audits` | audit id, unit, observer, window, opportunities, compliant, per-moment breakdown, per-cadre breakdown (never per named individual on reports — see §5) |
| `q_outbreaks` | id, organism, unit(s), declared_at, declared_by[2], line-list (case ids), control measures (task ids), ended_at, report_doc_id |
| `q_exposures` | id, staff_actor_id (sealed), type, occurred_at, reported_at, source_patient_id? (sealed), pep_started_at, first_dose_minutes, serology schedule, status |
| `q_med_errors` | id, incident_id, stage (prescribing/transcribing/dispensing/administering/monitoring), ncc_merp_category (A–I), drug, high_alert bool, lasa bool, source_event_id |
| `q_committees`, `q_committee_members`, `q_meetings`, `q_minutes`, `q_actions` | committee (type, cadence, quorum rule, chair, secretary, statutory ref), meeting (scheduled, held, attendance by badge scan, quorum met), minutes (doc id, signed_by[], version), actions (task_id, due, status) |
| `q_documents` (Expertise store human face; may be the same table family as 12a playbooks — **decide at plan time, recommend shared kernel `documents` table with `kind = sop|policy|playbook|form|prompt`**) | id, code, title, kind, version (semver), change_class, author, reviewer, approver, effective_from, review_due, supersedes_id, file/markdown, nabh_refs[], linked_workflow_definition_ids[], linked_training_module_id |
| `q_document_acks` | document_id, version, actor_id, assigned_at, acknowledged_at, method (click/quiz), overdue bool |
| `q_credentials` | actor_id, type (NMC/state council/nursing council/pharmacy council/AERB RSO/BLS/ACLS/…), number, issuer, valid_from/to, verified_source, verified_by, document_ref, status |
| `q_privileges` | actor_id, procedure_code/scope, granted_by (MS), committee_meeting_id, valid_to, restrictions, status |
| `q_licences` (statutory register) | id, kind (CEA registration, fire NOC, AERB licence per device, PCPNDT per machine/site, BMW authorisation, blood bank licence Form 28-C, drug licence 20/21/20-B/21-B, NDPS, lift, DG set (SPCB consent to operate + CPCB noise), boiler, PNG/LPG, medical gas (PESO), water/air consent (SPCB CTO), shops & establishments, PF/ESI, trade licence, signage, FSSAI kitchen, weights & measures (if retail), MTP approved place, HFR, NABH/NABL certificates, insurance policies (fire/PL/professional indemnity), AMC contracts (BME)), holder, authority, number, issued, expires, renewal_lead_days, dependent_operation_rule, custodian_actor, verifier_actor, document_ref, status |
| `q_inspections` | id, authority, visited_at, attended_by, persona grant id, directions[] (→ tasks), compliance report doc |
| `q_audit_plans`, `q_audit_rounds`, `q_audit_findings` | plan (year, type, scope, auditor firm/internal), round (sample seed, sample ids, auditor, window), finding (standard ref, severity, response, capa id) |
| `q_drills`, `q_drill_participants` | type, unit, announced, started/ended, response metrics json, participants (badge scans), debrief doc, capa |
| `q_trainings`, `q_training_attendance`, `q_competencies` | module (code, mandatory-for roles, validity months, nabh_ref), attendance (actor, at, method, score), competency (actor, skill, assessed_by, valid_to) |
| `q_indicator_set` | metric_id (FK to `kpi_metric_versions`), indicator_set (nabh_5e/6e, nabl, kayakalp, internal), chapter/std ref, numerator/denominator event refs, frequency, benchmark, **validation_rule**, owner_role |
| `q_indicator_values` | metric_id, version, period, value, numerator, denominator, completeness %, validation_status (auto_ok / anomaly / manually_validated / rejected), validated_by, anomaly_explanation (agent, provenance) |
| `q_nabh_crosswalk` | edition, chapter, standard, objective_element, evidence_type (event/table/document/register/interview/observation), evidence_query_ref, core/commitment/achievement flag, self_assessment_score, last_assessed |
| `q_evidence_packs` | id, purpose (assessment/inspection/audit/committee), scope, generated_at, generated_by (automation), items[] (query refs + hashes), export_recorded_event_id, watermark |
| `q_dsr_register`, `q_consent_notice_versions`, `q_breaches`, `q_dpias`, `q_processor_agreements` | DPDP program: requests with TAT, notice versions per language, breaches with CERT-In/DPB refs, DPIAs per agentic phase (`dpia.completed`), vendor DPAs with expiry (on licence watchman) |
| `q_registers_view` | not a table: a registry of statutory registers (name, statute, backing table/view, custodian, retention) so "show me the register" is one click |
| `q_governance_acts` | acts under emergency/incapacity authority: authority_ref, act event_id, ratified (bool/at/by), reversed? |

**Retention (recommended defaults, published as the E-19 map):** incidents/RCA 10 y (sentinel indefinite); HAI registers 5 y statutory, keep 10; exposures = employment + 30 y (occupational-health norm; Factories Act analogy); committee minutes permanent; SOP versions permanent (superseded retained); credentials employment + 10 y; licences permanent; training 5 y after exit; drills 5 y; audit findings 8 y (books analogy); DPDP DSR register 3 y after closure; breach records 8 y; BMW 5 y (doc 08); MLC-linked anything indefinite; legal-hold overrides all.

**DPDP classes:** incident descriptions and exposures = *sensitive* (health + employee) → sealed-text class; anonymous reports carry **no** envelope actor and no IP/device fingerprint (see §5 F-6); ICC/POSH records = sealed, ICC-members-only; HAI cases = patient health data; staff training/credentials = employee data (doc 11 notice covers).

**FHIR shapes:** `AdverseEvent` (incident with patient), `DetectedIssue` (near-miss/med error), `Consent` (consent audit), `Practitioner`/`PractitionerRole`/`PractitionerQualification` (credentials/privileges), `DocumentReference` (SOPs), `Measure`/`MeasureReport` (indicators), `AuditEvent` is *not* materialised — the event log is the audit.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion · ruling ref**. Grouped by theme; 150 rows.

### A. Identity & wrong-patient
- **A-1** Nurse reports "wrong patient given injection in bed 7" but scans bed 7's *current* occupant who was admitted after the event → incident form asks "patient at time of event" via the bed's occupancy history (`resource_status_history`) with time picker; assertion: incident.patient_id resolves via occupancy at `occurred_at`, not now.
- **A-2** Wristband scan mismatch at transfusion bedside triggers `band.pair_mismatch`/hard stop → auto-incident (near-miss, category wrong-patient) created **without** requiring the nurse to fill a form; assertion: exactly one incident per source event id (idempotent on `source_event_id`).
- **A-3** Two patients with same name on one ward; HAI case attached to the wrong one by ICN → adjudication screen shows UHID + photo + bed history and requires UHID re-scan for confirm; assertion: `hai.case_confirmed` payload carries UHID checked flag.
- **A-4** Patient merge after an incident (`patient.merged`) → incident follows the surviving id; unmerge (wrong merge) → incident goes back to original; assertion: fixture merge/unmerge keeps `q_incidents.patient_id` consistent with the patients module's mapping.
- **A-5** Incident about an *unregistered* person (visitor fall in lobby) → `patient_id` null, `person_kind = visitor`, goodwill path noted (§11.14 deferred); assertion: form accepts null patient with kind.
- **A-6** Staff member as patient in an incident → sealed-class propagation (D-25): committee agenda shows alias; assertion: committee pack renders alias for staff-as-patient rows.

### B. Timing, concurrency, race
- **B-1** Two people report the same fall within minutes (nurse + attendant via WhatsApp) → dedupe suggestion on triage (same patient ± 2 h, same category), QM links as duplicates, one master; assertion: `incident.linked_duplicate` (NEW) event; counts use master only.
- **B-2** CAPA verifier verifies before the CAPA task is `task.completed` → transition rejected; assertion: guard in definition.
- **B-3** Committee meeting minutes signed by chair while secretary edits → optimistic version on minutes doc; second signer must sign the same version hash; assertion: signature carries doc version hash.
- **B-4** Device-day denominator recomputed after a late `device.usage_stopped` backfill (occurred yesterday, recorded today) → indicator value for last month re-materialises with `revised` flag and prior value retained; assertion: `q_indicator_values` keeps history, `indicator.revised` (NEW).
- **B-5** Outbreak declared while surge mode already active → both flags coexist; cohort-mode bed rules take precedence for isolation; assertion: bed assignment rule set union tested.
- **B-6** Licence renewed (new expiry) on the same day the lapse rule would fire at midnight → watchman reads current row at fire time; assertion: no `licence.lapsed` if `expires > now`.
- **B-7** Two triagers open the same incident → claim discipline (P5 pooled queue): first claim wins, second sees "claimed by"; assertion: `task.accepted` uniqueness.
- **B-8** SOP v3 published at 14:00; nurse acknowledged v2 at 13:59 → v2 ack does not satisfy v3; v3 assignment created; assertion: acks are per version.
- **B-9** Mortality review auto-created from `patient.deceased` before the death certificate is finalised (MCCD pending) → review waits in `awaiting_records` state up to 7 d; assertion: state exists, SLA counts from record completion.

### C. Partial failure & downtime
- **C-1** Server down; nurse pricks finger on needle at 02:10 → paper exposure form + PEP kit from `store` with paper seal log; first dose given from kit; backfill next morning with `occurred_at` = 02:10, `recorded_at` = 09:00; first-dose-minutes computed from the paper time; assertion: KPI "PEP in window" uses `occurred_at`.
- **C-2** Downtime declared; incidents reported on paper forms (pre-printed with QR of form serial) → backfill screen scans form serial; duplicate-serial rejected; assertion: `paper_form_serial` unique.
- **C-3** Agent runtime halted (global halt) → incident intake, triage, RCA all work by hand; Classifier draft absent renders "no draft (agents halted)" not blank (copilot law 6 four-state render); assertion: UI fixture.
- **C-4** Evidence Pack Compiler crashes mid-pack → partial pack never saved as complete; pack has `complete=false` and lists missing queries; assertion: atomic pack manifest.
- **C-5** WhatsApp anonymous-report link down → QR on posters also resolves to a LAN kiosk URL and a paper drop-box exists; drop-box entries are keyed by the QM as `channel = paper_anonymous`; assertion: channel enum.
- **C-6** Backup restore drill fails (weekly automated) → result ingested as an **audit finding severity critical** with owner SMS, not merely a log line; assertion: failed drill → `audit.finding_recorded` + escalation.
- **C-7** Committee meeting held during downtime → attendance by paper sign-in, scanned in later; quorum calc uses backfilled attendance; assertion: `q_meetings.quorum_met` recomputed on backfill.
- **C-8** Read-model gap: nursing eMAR not yet live (Phase sequencing) → medication-error indicator shows "denominator unavailable — eMAR not live" (honesty clause C-20), never 0 errors; assertion: indicator validation status `denominator_unavailable`.

### D. Money (billing, refunds, payer, packages, TPA)
- **D-1** Incident causes extra treatment (fall → CT + extended stay) → CAPA may include "waive charges" → charge waiver is a *discount with category = incident-goodwill*, approval-gated (§7), linked to incident id; assertion: `discount.applied.reason_ref = incident_id`; Fraud Sentinel whitelists linked waivers.
- **D-2** TPA denies claim citing HAI as "hospital negligence" → HAI case links to claim dispute (doc 20), HICC sees denial trend; assertion: `hai_case.claim_dispute_id` nullable link.
- **D-3** NABH assessor fee, licence fees, fines (SPCB, fire) → expense sanction via approvals (§8), expense lines tagged to compliance cost centre; assertion: cost-centre tag on `q_licences.fee_expense_ref`.
- **D-4** Staff paid "incident bonus"/"zero-incident bonus" proposal → **forbidden** (drives under-reporting; law 11, doc 11 G4); assertion: incentive rule enum has no incident-count basis; owner ruling O-2.
- **D-5** Refund of PEP drugs cost to staff? → staff exposure care is hospital cost centre `occupational_health`, never billed to staff; assertion: exposure orders route to cost centre, not patient bill (leakage principle satisfied by named cost centre).
- **D-6** PMJAY audit demands incident register for a beneficiary → scoped persona export with watermark, `export.recorded`; assertion: E-28 flow.
- **D-7** Goodwill payment to visitor injured in lobby → payment voucher approval-gated, linked incident, PL insurance claim task; assertion: link table.
- **D-8** Fine for late BMW annual return → incident category `compliance_lapse`, CAPA on licence officer, appears in owner digest; assertion: auto-incident from `licence.lapsed`.

### E. Consent, legal, MLC, minors, unconscious
- **E-1** Sentinel event on an MLC patient → legal hold auto-offered; all related records frozen; single-spokesperson rule banner; assertion: `legal_hold.applied` links incident; purge jobs skip.
- **E-2** Open disclosure to family of an unconscious patient with no guardian on record → disclosure task assigned to MS with "identify surrogate" sub-task; assertion: disclosure cannot be marked done without a recipient identity (or documented reason).
- **E-3** Minor (POCSO context) incident → sealed channel rules (D-31) force communications away from default guardian if flagged; assertion: fixture.
- **E-4** Consent audit finds surgery consent signed *after* `surgery.started` → finding severity major; per-surgeon pattern to credentials committee; assertion: query `consent.recorded.occurred_at > surgery.started.occurred_at`.
- **E-5** DNR patient coded and resuscitated (order not visible) → incident category `advance_directive_breach`, RCA mandatory; assertion: auto-flag when `code.activated(type=blue)` on a patient with `dnr.recorded` active.
- **E-6** Police demand incident RCA in a negligence complaint → RCA is quality-privileged: release via document-release workflow with owner/MS + counsel decision; assertion: RCA export requires `document.release_logged` with approver.
- **E-7** Patient files consumer complaint; counsel asks for "everything" → evidence pack purpose = `legal`, pack includes event trail with `occurred_at/recorded_at` both, hash-sealed; assertion: pack hash reproducible.
- **E-8** Restraint used without physician order within 1 h → nursing event + auto-incident; assertion: rule on `restraint.applied` (doc 06) without order.
- **E-9** Treatment refusal recorded then patient deteriorates → not an incident by default; mortality review flags refusal documentation completeness; assertion: mortality review checklist item.

### F. Anonymity, no-blame culture, gaming of the reporting system
- **F-1** Anonymous report contains the reporter's name in free text → the classifier's scrubber flags identity-shaped strings and QM sees a "may de-anonymise" warning before assigning review; assertion: scrubber fixture; the text is stored as submitted (no silent edits) but rendering to HOD masks flagged spans.
- **F-2** HOD demands "who reported this?" → no actor on envelope, no IP/device logged for the anonymous channel (design: anonymous endpoint runs without session; rate-limited by token bucket not by identity); assertion: DB has no column; access log for the endpoint stores only a coarse timestamp.
- **F-3** Abuse of anonymous channel for harassment (false report naming a colleague) → triage can mark `malicious_suspected`; report still counted as received, not as incident; POSH/HR route if it names a person for non-safety reasons; assertion: state exists, no reporter hunt.
- **F-4** Under-reporting ward (zero incidents in 90 d with 30 beds) → **negative-space signal**: Digest line "no incidents reported from Ward X in 90 days — statistically improbable"; assertion: silence detector query.
- **F-5** Surge of near-miss reports after a "good catch" campaign → reporting-rate KPI rises; harm-rate KPI unchanged; digest explains, never ranks; assertion: two separate metric ids.
- **F-6** Manager tries to raise a KPI that penalises incidents per nurse → formula registry rejects incident-count-per-person as a punitive basis (doc 11 G4 rule); assertion: registry lint.
- **F-7** Reporter fears retaliation and asks for status of an anonymous report → status lookup by report receipt code (random, printed/shown once); assertion: lookup returns state only, no reviewer notes.
- **F-8** Just-culture classification "reckless" by MS → triggers HR route with owner visibility, evented; the RCA remains blameless in wording; assertion: `incident.classified.culpability` only settable by MS/owner.
- **F-9** Whistleblower report on financial fraud comes through the incident channel → category `integrity`, routed to owner only (not HOD), Fraud Sentinel notified; assertion: routing rule by category; owner ruling O-4 (whistleblower policy).

### G. Staff absence, overload, handover
- **G-1** QM on leave; incidents pile up → triage pool includes Quality exec + MS deputy; SLA breach escalates to MS then owner digest; assertion: ladder resolves to on-duty role holder (S10 §12).
- **G-2** ICN post vacant (single incumbent) → succession chain: senior ICU nurse trained as ICN-link; HAI adjudication SLA relaxed to 72 h with `deviation` flag published (E-35 pattern); assertion: `roster.deviation_published` covers ICN role.
- **G-3** Committee cannot make quorum twice → `committee.quorum_failed` twice → owner digest + MS action; statutory committees (ICC) cannot be skipped: escalation to owner with legal note; assertion: repeat-failure rule.
- **G-4** CAPA owner resigns (`exit.completed`) → open CAPAs auto-return to HOD pool with note; assertion: exit hook reassigns.
- **G-5** RCA facilitator is a named actor in the incident → SoD blocks assignment; assertion: `sod.violation_blocked`.
- **G-6** Night shift: sentinel event, MS unreachable → ladder → MS deputy → duty manager + owner SMS (C-11 dead-end); assertion: fixture with role resolution returning nobody.
- **G-7** Training expiry en masse (BLS 2-y validity for 40 nurses same month) → watchman batches into one training-scheduling task per department, not 40 alerts (alarm fatigue, law 7); assertion: batching rule.
- **G-8** Auditor for hand-hygiene round is from the audited ward → sampler excludes own unit; assertion: sampler constraint.

### H. Equipment failure & sterilisation
- **H-1** Autoclave BI (biological indicator) positive → CSSD emits `sterilisation.bi_failed` (doc 15) → auto-incident + **recall workflow**: all sets from loads since last negative BI, cases where they were used, patient notification decision by HICC; assertion: recall list query joins load → set → case.
- **H-2** Ventilator failure causing harm → incident links BME ticket and asset id; BME AMC/PM history attached to RCA automatically; assertion: RCA timeline includes `device.*` and BME events for the asset.
- **H-3** Portable X-ray AERB licence expired but device in use → licence watchman blocks `study.acquired` for that device via radiology interface (doc 01 O-7 analogue); assertion: licence-dependent-operation rule.
- **H-4** Fire alarm panel faulty during drill → drill debrief records equipment fault → FMS CAPA; assertion: drill → capa link.
- **H-5** Hand-rub dispensers empty at 3 stations during audit → audit finding of type `supply`; auto material request to housekeeping (doc 08); assertion: finding can spawn `material.requested`.
- **H-6** Environmental sample (OT swab) positive (doc 08 owns sample) → HICC agenda item + OT closure decision task; assertion: `environment_sample.positive` (doc 08 NEW) subscribed.
- **H-7** Water TDS/microbiology out of range (dialysis water) → incident category `utility`, dialysis unit notified (doc 04/21); assertion: subscription.

### I. Data quality, late-arriving, backdated
- **I-1** Micro culture result arrives 5 days after discharge and meets CLABSI criteria → HAI case created retrospectively; denominators for that month re-materialise; SSI/CLABSI post-discharge surveillance counts; assertion: B-4 machinery.
- **I-2** Indicator numerator > denominator (more falls than patient-days due to unit mapping bug) → validation rule fails → value withheld, anomaly task to Quality exec; assertion: `validation_status = anomaly`, digest shows "withheld".
- **I-3** Backdated incident (occurred 3 weeks ago, reported today) → allowed; `late_report_days` computed; monthly stats by `occurred_at`; reporting-timeliness KPI by `recorded_at − occurred_at`; assertion: both aggregations exist.
- **I-4** Occurred_at in the future (typo) → rejected at form; assertion: validation.
- **I-5** Device-days feed from ICU missing a day (data_gap.flagged) → indicator marks completeness < 100 %, shows "based on 29/30 days"; assertion: completeness column.
- **I-6** Someone edits an incident description after RCA signed → immutable after `rca.signed`; corrections as addenda (`correction.entered_in_error` pattern); assertion: update rejected, addendum event.
- **I-7** Credential number typo fails NMC lookup → status `verification_failed`, not `blocked`, with 7-d grace for re-entry unless it is a new joiner (no grace); assertion: state distinction.
- **I-8** Indicator definition version changes mid-year (formula v2) → both series retained; charts show a version boundary marker; NABH submission cites version; assertion: `kpi_metric_versions` semver link.
- **I-9** HH audit entered with 0 opportunities → rejected (division by zero, meaningless audit); assertion: min opportunities 10 (WHO recommends ≥ 200/quarter/unit for stability; configurable).

### J. Fraud, leakage, gaming (auditor's and fraudster's walk)
- **J-1** Hand-hygiene audits always 100 % from one observer → integrity check: observer-level compliance variance vs peers; flag to ICN as diagnostic; assertion: Fraud-Sentinel-style diagnostic query.
- **J-2** SOP acknowledgements clicked in bulk in 30 s by a ward clerk for the whole ward (shared login) → ack requires own session + optional 2-question quiz for critical SOPs; ack timing clustering flagged; assertion: acks from one session for >1 actor impossible; clustering diagnostic.
- **J-3** Drill attendance padded → attendance by badge QR scan at the drill site within the drill window; manual additions flagged `manual`; assertion: source column.
- **J-4** Committee minutes back-dated to satisfy assessor → `committee.minuted` occurred_at cannot precede meeting scheduled_at − 1 d and recorded_at is immutable; assessor pack shows both; assertion: constraint.
- **J-5** Licence document forged/uploaded with wrong dates → verifier ≠ updater SoD; renewal ack number captured; sampled external verification task quarterly; assertion: SoD + sampling.
- **J-6** Incident closed without CAPA verification by editing status → status is engine-mirrored; no direct write path; assertion: lint (module never writes `status` directly).
- **J-7** Reporting rate gamed by trivial near-misses to "look safe" → harm-weighted indicator alongside raw rate; digest shows both; assertion: two metrics.
- **J-8** Privileging granted to a surgeon without committee (MS alone) → allowed only as *temporary privilege* ≤ 90 d (locum), evented, digest-surfaced, must be ratified; assertion: `temp_role.granted` reuse with scope = privilege.
- **J-9** Evidence pack tampered after export → pack manifest hash + `export.recorded`; re-generation reproducible from event ids; assertion: hash equality test.
- **J-10** Someone deletes an embarrassing incident → no delete path; `incident.voided` (NEW) requires QM + MS with reason, counts as voided (still visible in audit view); assertion: soft-void only.

### K. Privacy, sealed records, VIP, staff-as-patient
- **K-1** Exposure record (staff HIV PEP) → sealed to ICN/staff-health/MS; HR never sees; digest shows counts only; assertion: permission fixture.
- **K-2** POSH ICC complaint → ICC-members-only table access; owner sees only that a case exists and statutory timelines (90 d inquiry, POSH §11(4)); assertion: owner persona cannot read ICC content.
- **K-3** VIP patient incident → alias on all committee packs, RCA uses `[PT-1]` tokens even internally; assertion: pack renderer honours seal.
- **K-4** Incident Classifier (LLM) receives description → tokenised/de-identified via the copilot scrubber (copilot §2.2); assertion: request-body leak fixtures with in-text names.
- **K-5** Assessor persona requests patient list for tracer → tracer sample generated by automation (random n), exported with watermark and purpose; assessor sees only sampled records for grant duration; assertion: E-20 grant expiry revokes.
- **K-6** DSR: patient asks for erasure of an incident that names them → erasure bounded by retention law; response document generated citing incident retention + legal hold if any; assertion: DSR refusal template with statute.
- **K-7** Staff asks to see their own hand-hygiene observations → per-individual observations are *not* stored by name (aggregate per cadre/unit) — corporate norm is anonymous observation; assertion: `q_hh_audits` has no observed-actor column (only observer).

### L. Language, literacy, accessibility
- **L-1** Housekeeping staff reports a spill/near-miss in Hindi voice note via WhatsApp → stored as audio + transcript (where lawful; consent in staff notice), channel = whatsapp; classifier works on transcript; assertion: media attachment path.
- **L-2** Bhojpuri-speaking attendant complains of a fall at the front desk → grievance form in Hindi with pictograms; staff enters on behalf, `reported_on_behalf_by`; assertion: field.
- **L-3** SOP acknowledgement for a Hindi-only ward attendant → SOP must have a Hindi version or a Hindi summary card before acks are assigned to Hindi-preference staff; assertion: assignment blocked without language variant (configurable per SOP criticality).
- **L-4** Visually impaired staff member → incident form accessible (ARIA, keyboard); drill evacuation manifest includes assistance needs; assertion: a11y test in golden suite.
- **L-5** Open disclosure to a family who reads neither Hindi nor English (Bengali/Odia migrant labour) → disclosure record notes interpreter used (name/relationship), one of the 22 scheduled languages chosen; assertion: field `interpreter`.

### M. Scale (100/day → 2,000/day, 10 → 610 beds)
- **M-1** 610 beds → ~150–300 incidents/month; triage queue paginates and sorts by severity then age; assertion: perf budget <300 ms list.
- **M-2** Device-day materialisation across 45 ICU beds + wards → nightly job; on-demand recompute for one unit ≤ 5 s; assertion: perf test.
- **M-3** 1,500 staff × 60 SOPs → 90k acks; assignment by role not by name; bulk publish creates assignments lazily on next login; assertion: no 90k-row insert at publish.
- **M-4** 40 committees at scale → committee calendar view, agenda-feeder rules per committee type; assertion: cadence engine generic.
- **M-5** Multiple sites (`site_id`, Plan 13 DD3) → every register and indicator is site-scoped; NABH assessment is per site; assertion: site filter in all queries.
- **M-6** NABH 6th edition switch → `q_nabh_crosswalk` import for edition 6; no code change; assertion: crosswalk import test with both editions loaded.

### N. Integration failures (device/vendor/ABDM)
- **N-1** NMC NMR lookup API down → verification queued, manual verification with screenshot attach allowed, marked `manual`; assertion: fallback path.
- **N-2** WHONET/antibiogram export from micro (doc 02/Plan 20 micro) malformed → antibiogram job fails loudly to ICN; last good antibiogram shown with date; assertion: staleness label.
- **N-3** CERT-In portal/email unreachable during breach → checklist accepts "attempted at" with evidence, retry task every 30 min until filed; 6-h clock visible; assertion: clock UI + retry.
- **N-4** ABDM HFR/HPR registry shows practitioner deregistered → credential status `external_flag`, MS review task; assertion: subscription to registry sync (E-32).
- **N-5** CBWTF vendor manifest not received (doc 08) → BMW compliance indicator degraded; HICC agenda; assertion: subscription to doc-08 event.
- **N-6** HR SaaS attendance feed missing → training attendance by badge scan is independent; drill participation independent; assertion: no HR dependency in evidence tables (D-41).
- **N-7** LLM provider outage → classifier/RCA drafter show "draft unavailable", human proceeds; no queueing of PHI at provider; assertion: fail-open lint.

### O. Governance, owner-as-role, continuity
- **O-1** Owner unreachable during a ransomware event; CERT-In 6-h clock running → two-key emergency activation (duty manager + MS) authorises breach declaration and CERT-In filing; acts queued for ratification; assertion: `governance.emergency_activated` precedes `breach.notified` in the trail and `authority_ref` set.
- **O-2** Owner incapacitated; NABH assessment in 2 weeks → incapacity protocol: deputy pair signs assessment paperwork under time-boxed authority; the legal instrument reference is attached; assertion: `incapacity.declared` active for signer acts.
- **O-3** Only one full admin exists (runbook O1 open) → any two-key definition in this module renders "second key unavailable — single-approver mode, logged" rather than silently letting one person do both; digest reports every such act; assertion: single-approver mode flag + event `governance.single_approver_used` (NEW). This is the honesty requirement for the pre-O1 window.
- **O-4** Continuity-kit unseal by two people during a real outage → `continuity_kit.unsealed` with both identities; reseal task; assertion: event + reseal.
- **O-5** Stranger drill: outsider ships trivial patch to training env → drill record with time-to-first-deploy; failure = critical finding; assertion: drill type exists.
- **O-6** Workflow Tuner proposes a change to the incident definition SLA → Class A (patient-safety) two-key owner + MS; assertion: change class resolves A.
- **O-7** Deputy pair exercises authority beyond scope (e.g., approves vendor bank change) → scope enum on the instrument; out-of-scope acts blocked; assertion: scope check.
- **O-8** Emergency activation attempted with both keys from the same person's two sessions → distinct actor ids required, second factor each; assertion: rejection.
- **O-9** Ratification queue ignored for 30 d → escalates to external named party (counsel) by digest; assertion: ladder.

### P. Committees, documents, training, credentialing
- **P-1** DTC approves a formulary change → minutes action item creates the formulary change request (Class per doc 16); one workstream (roadmap §3); assertion: action → cross-module request via interface.
- **P-2** SOP linked to a workflow definition is superseded → definition owner gets task "review definition v against SOP v"; SOP-Change Impact Summariser drafts the diff; assertion: link-triggered task.
- **P-3** Doctor's NMC registration expires; he has 3 OTs booked → hard block on new bookings, existing within 7 d flagged to MS for temporary privilege; assertion: §11.12 rule + temp path.
- **P-4** Foreign-qualified doctor without FMGE/NMC registration proposed for privileges → block; assertion: rule.
- **P-5** Nurse's competency (IV cannulation) unassessed → nursing worklist filters out tasks needing that competency (doc 07 owns the filter; this module owns the record); assertion: interface `competencies.for(actor)`.
- **P-6** Mandatory training (fire, BLS, HIC, POSH awareness, DPDP, BMW handling for waste staff) overdue → not a block on duty (safety of staffing) but a digest line and department task; BMW handler training *is* a statutory condition (BMW Rules r.4(l)) — overdue > 30 d blocks BMW handover assignment; assertion: per-module block policy.
- **P-7** Committee member conflict of interest (DTC member is a pharma consultant) → declaration field per member, annual; assertion: field + reminder.
- **P-8** ICC annual report due to District Officer (POSH §21) → licence-register-style due item; assertion: compliance calendar item.
- **P-9** Controlled form printed from a superseded version at a ward → printed controlled forms carry version QR; scanning at intake flags obsolete version; assertion: QR includes doc version.
- **P-10** Assessor asks "show me a nurse's training file" → one click: attendance, competencies, credentials, drill participation, SOP acks, immunisation (Hep B titre) — all from tables, watermark export; assertion: evidence pack template `staff_file`.

### Q. Infection control specifics
- **Q-1** MDRO (CRE) isolated in ward → auto `isolation.flagged` suggestion to treating doctor (T1 nudge; doctor sets the flag — clinical cap); contact-precaution PPE cost centre; assertion: nudge event, no auto-flag.
- **Q-2** Two CRE in same hall within 7 d → Cluster Detector flags; ICN triage; assertion: threshold rule fixture.
- **Q-3** Surgeon-specific SSI rate spikes → SSI register per surgeon visible to MS and credentials committee only (privileged), never on public dashboards; assertion: permission.
- **Q-4** SSI surveillance after discharge — patient never returns → Recall automation sends day-30 WhatsApp micro-survey (wound questions) in patient's language; positive answers create ICN call task; assertion: survey template + task.
- **Q-5** Hand-hygiene observation with the observer known to staff (Hawthorne) → sampler randomises timing; unannounced; corporate norm ≥ 200 opportunities/unit/quarter; assertion: sampler.
- **Q-6** Needle-stick from unknown source (sharps bin) → source unknown = high-risk protocol; HBV vaccination status lookup from staff immunisation register; assertion: protocol branch.
- **Q-7** TB exposure of staff (open case unmasked 3 days) → exposure record for each staff on roster in that unit (roster interface), screening tasks; assertion: bulk exposure creation from roster.
- **Q-8** Sterilisation monitoring: chemical indicator fail on a set at OT table → set quarantined (doc 15), incident near-miss, load traced; assertion: subscription.
- **Q-9** Antibiogram shows resistance trend → DTC agenda auto-item; antibiotic policy SOP review task; assertion: agenda feeder rule.
- **Q-10** Immunisation register: new nurse without Hep B titre → occupational-health task; not blocked from duty except in dialysis/OT (configurable); assertion: policy table.
- **Q-11** BMW Form I accident (spill/needle injury of waste handler) → doc 08 raises; this module ensures the 24-h SPCB report is on the external_report checklist; assertion: external report type exists.

### R. Indicators & NABH
- **R-1** NABH mandatory indicator with no source event yet (e.g., "time for initial assessment in IPD" before IPD module) → indicator listed as `not_yet_measurable` with the plan number that will feed it; never a fabricated number; assertion: status enum.
- **R-2** Assessor asks for indicator definition change history → definition page from `kpi_metric_versions`; assertion: doc 11 link.
- **R-3** Manual indicator (patient satisfaction from paper) mixed with event-derived → source tag; manual entries need validator ≠ enterer; assertion: SoD.
- **R-4** Benchmark comparison (NABH benchmarking data) → benchmark values stored per indicator/period, source noted; assertion: table.
- **R-5** Indicator anomaly: falls doubled last month → Anomaly Explainer (T0) drafts "explanation candidates" from events (new ward opened, denominator change, reporting campaign) — a narrative over facts with citations; QM decides; assertion: claims cite event query ids (copilot §2.4 pattern).
- **R-6** Self-assessment toolkit scoring (objective elements) → per OE score with evidence refs; readiness % = scored core OEs; assertion: readiness query = S10 card-37 KPI.

### S. Inspection day
- **S-1** Drug inspector walks in unannounced → inspection-visit workflow starts from the command palette; scoped persona issued for 4 h; on-the-spot certified prints of licences and registers with QR; directions recorded as tasks; assertion: E-20 flow end-to-end fixture.
- **S-2** Fire officer asks for last 4 quarterly drills per floor → drill register query per floor; assertion: one click.
- **S-3** PCPNDT authority asks for Form F register + machine list + sonologist credentials → cross-module pack (doc 01/18 + credentials); assertion: pack template `pcpndt`.
- **S-4** NABH assessor tracer: pick a random inpatient and follow → tracer pack pulls encounter timeline with consent, assessments, medication, HAI status, incidents, handovers; sealed rows hidden unless treating-team; assertion: pack template `tracer`.
- **S-5** Assessor asks "how do you know staff read the policy?" → ack report by SOP/version/department with overdue list; assertion: report.
- **S-6** Labour inspector asks CLRA registers → HR-evidence bridge (E-34) pack; assertion: template.

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 09:40 — NABH assessment day 1, ransomware alert, owner in the air.** 09:40 monitoring flags encrypted files on a file share; IT declares `security_incident.declared`. Owner is on a flight. Duty manager + MS trigger two-key emergency governance (`governance.emergency_activated`, 72 h). Downtime declared floor-wide with second-person confirmation (D-28). Assessors are in the conference room. **System:** breach checklist opens with CERT-In 6-h clock (deadline 15:40), DPB and patient-notification decision items, legal-hold offer, evidence-preservation task (disk images). **Humans:** IT isolates; restore from last night's pgBackRest full + WAL to the clean spare (stage-1 posture: single server → rebuild on fresh VM from immutable offsite copy if primary is compromised); QM tells assessors the truth and shows the paper A1 kit and the downtime SOP — which *is* evidence for IMS/FMS. **Agents:** halted globally by IT (`agent.global_halt`, evented) until the environment is trusted. **Paper:** incident forms, HAI registers, drills continue on paper. **Backfill:** after restore, downtime windows entered; the breach RCA opens; CERT-In filing evented with reference number at 14:55. **Audit trail:** emergency activation → downtime → restore drill record → breach.notified → ratification by owner on landing (each act listed). NABH sees an organisation that ran its playbook.

**6.2 Wednesday 02:15 — needle-stick, ICN asleep, server up, pharmacy closed.** Night nurse reports via ward tablet (`exposure.reported`); protocol task fires: PEP kit `store` on the ICU floor → seal-check by duty nurse-in-charge, first dose at 02:34 (`pep.first_dose_given`, 19 min). Source patient known; consent for serology recorded by duty RMO; order placed to lab. ICN sees it at 07:00, adds follow-up schedule (Recall automation). Digest at 08:00: "1 exposure, PEP in window." If the server were down: paper form, kit paper seal log, backfill at 08:00 with `occurred_at` 02:15 — the KPI still reads 19 min.

**6.3 Friday — three CRE isolates in ICU hall B in 6 days, ICU full, media call.** Cluster Detector fires `outbreak.suspected` at the third isolate; ICN triage 08:30; ICO + MS co-sign `outbreak.declared` at 11:00. Hall B flips to cohort mode (§11.15), admissions to hall B restricted (bed board rule), enhanced-cleaning tasks pushed to housekeeping with ICN verification, staff cohorting via roster interface, screening swabs ordered for hall B patients, PPE to infection-control cost centre, DHO/IDSP notification task. Daily HICC huddle instances auto-created. Media call → single-spokesperson rule banner on the incident; spokesperson = MS. Two incubation periods with no new case → `outbreak.ended`, outbreak report drafted (RCA Drafter builds the timeline from events; ICO edits; signed), CAPAs (line-care bundle retraining, chlorhexidine bathing SOP v2 → acks). Audit trail: every isolation flag was set by a doctor (T1 nudge, not auto), every cleaning verified, every admission restriction evented.

**6.4 Tuesday 14:00 — wrong-site surgery in the mini-OT (sentinel).** `count.mismatch`? No — the site error surfaces at sign-out: surgeon notices. OT sister raises incident from the OT tablet with `sentinel = true` → `sentinel_event.declared`; owner + MS paged; legal hold offered; open-disclosure task (O-3 ruling) to MS within 24 h; RCA facilitator (QM) opens with 30-d SLA; RCA Drafter compiles the evented timeline (`ot.signin_completed`, `ot.timeout_completed` — the timeout was completed 40 s after knife-to-skin, which the timeline shows); human factors reviewed; classification "system" (checklist timing enforced only by honour); CAPA: OT module change request — `surgery.started` blocked until `ot.timeout_completed` (Class A, owner + MS two-key, or single-approver mode logged pre-O1). Committee: Quality & Patient Safety extraordinary meeting. Insurance/indemnity notification task. Audit trail proves what the humans did and what the machine allowed.

**6.5 Thursday — fire NOC expired 40 days ago; nobody noticed; fire officer at the gate.** This should not happen with the watchman, so the walkthrough is the *watchman failing*: the licence row had a wrong expiry year (typo). Inspection-visit workflow starts; persona issued; officer records direction "produce renewed NOC within 15 days" → task to licence officer; incident `compliance_lapse` opened; RCA finds the SoD gap (updater = verifier during the pre-O1 single-admin window — logged as single-approver acts), CAPA: quarterly sampled external verification of licence dates (J-5). Digest to owner that morning shows the visit and the direction. Fine, if any, via expense sanction linked to the incident.

**6.6 Saturday — NABH mock assessment by a consultant; server down for a planned upgrade; deputy owner in charge.** Planned maintenance pre-declared (D-13); downtime kit; evidence packs were generated Friday night (Evidence Pack Compiler runs after the weekly indicator materialisation) and printed with QR + watermark; the consultant works from the pack and the paper registers; ward tracers use printed handover sheets; the deputy pair holds Class-B authority (incapacity not declared — owner is merely on leave, so *no* incapacity: the deputy acts under pre-approved Class-B bands, D-15). Monday: packs regenerated post-upgrade and hash-compared against Friday's — a difference triggers a data-integrity finding.

**6.7 Month-end — indicator submission and the number that cannot be true.** CAUTI rate shows 0 for a month with 600 catheter-days. Validation rule: zero numerator with denominator above threshold and prior 6-month mean > 0 → anomaly. Anomaly Explainer drafts: "urine culture ordering fell 70 % in ward 3 after the lab interface change on the 4th (event query Q-1); 2 fever episodes with catheters had no culture (Q-2)." QM investigates; finds the micro order set broken in the LIMS upgrade; incident raised (near-miss, category diagnostic-process), CAPA to lab; indicator submitted with validation note, not silently as zero. The assessor reads the note and nods.

---

## 7. Compliance, audit & statutory surfaces

### 7.1 NABH chapter → evidence crosswalk (5th ed. chapters retained in 6th ed.; objective-element level lives in `q_nabh_crosswalk` as data, imported per edition)

| Chapter | What the assessor asks | Evidence in the system (event/table/register) |
|---|---|---|
| **AAC** Access, Assessment & Continuity | registration, initial assessment timeliness, lab/imaging QA, transfer/discharge summaries, referral | `patient.registered`, `visit.opened`, `vitals.recorded`, initial-assessment events (IPD plan), `result.verified` TAT, `qc.passed/failed`, NABL evidence (doc 02), `patient.transferred`, discharge summary events, indicator "time to initial assessment", "TAT lab/imaging" |
| **COP** Care of Patients | emergency, triage, ICU, OT, anaesthesia, transfusion, restraints, end-of-life, vulnerable patients, pain, nutrition, rehab, obstetrics, paediatrics | `er.triaged`, ICU registers (doc 06), WHO checklist events, `transfusion.*`, restraint register, `dnr.recorded`, vulnerable-patient flags, Code Blue register, drills, mortality reviews (`q_meetings` mortality) |
| **MOM** Management of Medication | formulary, DTC, prescribing audit, high-alert/LASA, storage, NDPS, ADR, medication errors, reconciliation | formulary versions (doc 16), DTC minutes, prescription-audit rounds, `adr.reported` → PvPI, `q_med_errors`, `medication.reconciled`, narcotics two-key events, `batch.expiring` |
| **PRE** Patient Rights & Education | rights display, consent, privacy, grievance, feedback, education, costs disclosed | `consent.recorded` + consent audit, sealed-class fixtures, `grievance.raised/resolved`, feedback micro-survey (D-38), tariff display evidence (doc 20), disclosure records |
| **HIC** Hospital Infection Control | HICC, surveillance, HAI rates, hand hygiene, isolation, BMW, sterilisation, occupational exposure, antibiogram, outbreak | all of §3.2–3.4, `q_hh_audits`, `q_hai_cases`, `q_device_days`, doc 08 BMW chain, doc 15 sterilisation loads/BI, `q_exposures`, antibiogram, immunisation register |
| **PSQ** Patient Safety & Quality Improvement | quality programme, indicators, incident/sentinel system, RCA, IPSG, audits, benchmarking, patient-safety culture | `q_indicator_*`, `q_incidents`, `q_rcas`, `q_capas`, IPSG audits, clinical audits, `q_meetings` Q&PS |
| **ROM** Responsibilities of Management | governance structure, committees, resource allocation, laws & licences, ethics, leadership review, risk management | `q_committees` (management control review E-17), `q_licences`, governance events (D-10), risk register (NEW `q_risks` — recommend fold into audit plan table), ethics committee |
| **FMS** Facility Management & Safety | fire, electrical, water, gases, hazardous materials, equipment, drills, security, disaster | `q_drills`, BME (doc 19), doc 08 environment/pest/water, PESO/medical-gas licences, security events, `disaster.declared` drills, `utility.threshold_breached` |
| **HRM** Human Resource Management | credentialing, privileging, orientation, training, appraisal, occupational health, discipline, grievance, POSH | `q_credentials`, `q_privileges`, `q_trainings`, `q_competencies`, immunisation register, doc 11 review evidence, ICC register |
| **IMS** Information Management System | record policy, confidentiality, retention, access, audit trail, coding, data quality, downtime | event log itself, `break_glass.used` reviews, `export.recorded`, retention map (E-19), `downtime.declared/ended`, MRD audits (doc 17), DPDP program |

### 7.2 NABH quality indicators — computed from events (illustrative set; full list is data)
Time for initial assessment (IPD/ED) · lab & imaging TAT · lab/imaging report errors/amendments (`report.amended`) · critical-result communication time (`result.critical_flagged` → `result.acknowledged`) · medication errors per 1,000 patient-days · ADRs · transfusion reactions per units issued · wastage of blood units · surgical-site infection %, VAP/CLABSI/CAUTI per 1,000 device-days · hand-hygiene compliance % · return to OT (unplanned) · re-scheduling of surgeries · ICU readmission ≤ 48 h · unplanned readmission ≤ 7 d (`readmission.flagged`) · falls per 1,000 patient-days · pressure injuries · restraint use · Code Blue response time · mortality (crude; expected where scoring exists) · patient satisfaction/NPS · OPD wait time · bed occupancy, ALOS · incidents reported per 1,000 patient-days (reporting rate, positive signal) · sentinel events · staff turnover, absenteeism · needle-stick per 100 staff-years · employee satisfaction · equipment downtime, PM compliance. **Each is a `kpi_metric_versions` row with `indicator_set = nabh`, a validation rule, and a "not yet measurable" state until its feeding plan ships (R-1).**

### 7.3 Statutory registers hosted or mirrored here (as tables)
Incident register · sentinel-event register · HAI register · needle-stick/occupational-exposure register · immunisation register (staff) · medication-error register · ADR register (PvPI; pharmacy owns capture, quality owns register view) · outbreak register · committee minutes book (per committee, statutory for ICC and HICC) · licence & registration register · inspection register · training register · credentialing/privileging register · drill register · complaint/grievance register (CEA state rules; front office captures) · DSR register (DPDP) · breach register · DPIA register · processor-agreement register · legal-hold register · break-glass review register · internal-audit findings register · control-testing calendar. BMW Form I/IV, Form F, MTP, blood-bank, narcotics, MLC, birth/death, AERB registers stay with their owning modules and are *listed* in `q_registers_view` with one-click open.

### 7.4 Statutes cited and what each demands of the module
NABH HCO standards 5th/6th ed. (crosswalk) · Clinical Establishments (Registration & Regulation) Act 2010 + state rules (registration display, minimum standards, grievance, tariff display) · DPDP Act 2023 §§4–13 (notice, consent, DSR, DPO/grievance officer, breach notification to DPB and principals) · CERT-In Directions 2022 (6-h reporting, 180-d logs) · BMW Rules 2016 (authorisation, Form I 24 h, Form IV annual, training/immunisation of handlers) · POSH Act 2013 (ICC, 90-d inquiry, annual report) · PCPNDT (registration per machine, Form F) · AERB (licences per device, RSO) · Drugs & Cosmetics Act (licences, Schedule H1 register, ADR via PvPI) · NDPS (two-key, registers) · MTP Act (approved place) · Transplantation of Human Organs Act (brain-death committee — deferred) · NBTC/Drugs & Cosmetics Part XII-B (blood bank licence, haemovigilance) · IDSP/state notifiable-disease rules · Fire Services Act/NBC (NOC, drills) · Factories/Shops & Establishments · CLRA · Companies Act §138 (internal audit) · Consumer Protection Act 2019 (record preservation for defence) · IMC/NMC Professional Conduct regulations (record retention 3 y minimum; recommended longer above).

### 7.5 What an inspector demands in one click
Evidence pack templates: `nabh_chapter(ch)`, `tracer(patient)`, `staff_file(actor)`, `licences_all`, `drills(year)`, `committee(id, year)`, `hai_quarter`, `incident_summary(period)`, `pcpndt`, `bmw`, `aerb`, `dpdp_program`, `cea_registration`. Each pack = query refs + hashes + watermark + `export.recorded` + persona grant if external.

---

## 8. Staff KPI & KRA

All KPIs: event-derived, diagnostic, load-normalised (S10 §2). None feeds pay. Metric ids proposed for the formula registry (doc 11).

**Quality Manager (card 37).** `q.incident_triage_tat` (median `incident.classified − incident.reported`, load = incidents/week) · `q.rca_closure_days` (sentinel and non-sentinel separately) · `q.capa_on_time_%` · `q.indicator_validation_timeliness` (values validated by day 7 of month) · `q.audit_calendar_adherence_%` · `q.committee_cadence_adherence_%` (meetings held / scheduled) · `q.sop_review_overdue_count` · `q.readiness_%` (core OEs scored ≥ target) · `q.dsr_tat_compliance_%`. KRA: permanently inspection-ready; incident loop closed; DPO duties. Gaming: closing incidents without CAPA verification — impossible by definition; classifying everything as near-miss — harm-weighted metric alongside. Diagnostic reading: high triage TAT with rising load → staffing conversation, not blame.

**ICN (card 38).** `hic.surveillance_completeness_%` (units with device-day data / units with devices) · `hic.hai_adjudication_tat` · `hic.hh_opportunities_observed` (vs ≥200/unit/quarter target, load = units) · `hic.hh_compliance_%` (unit-level, never individual) · `hic.bundle_audit_coverage` · `hic.pep_first_dose_in_window_%` (target 100 %) · `hic.cluster_investigation_start_h` (<24 h) · `hic.isolation_audit_findings_per_100_beds`. KRA: infections found, traced, prevented — provably. Gaming: J-1 observer-variance diagnostic.

**MS (card 39).** `ms.privileging_tat_days` (<7) · `ms.overdue_committee_cycles` (0) · `ms.sentinel_signoff_days` · `ms.disclosure_within_24h_%` · `ms.class_a_cosign_tat_h`. KRA: clinical authority exercised and recorded.

**Quality exec (Q1).** `q.audit_rounds_completed_%` · `q.sample_integrity` (sampler-seeded vs manual) · `q.pack_generation_success_%`.

**Licence officer (Q5).** `lic.renewals_filed_before_T-30_%` · `lic.lapses_count` (target 0) · `lic.inspection_directions_closed_on_time_%`.

**Document controller (Q4).** `doc.ack_rate_by_due_%` (per SOP criticality) · `doc.review_overdue` · `doc.superseded_prints_detected` (P-9 scans).

**Every department head (for their area).** `dept.capa_on_time_%` · `dept.incident_reporting_rate_per_1000_pd` (positive signal; shown with hospital median) · `dept.harm_rate_per_1000_pd` · `dept.sop_ack_%` · `dept.training_currency_%`. **Rule:** reporting rate is displayed as a *health* indicator with the explicit legend "higher is generally better"; harm rate is displayed separately; neither is ranked.

**Owner's 8 a.m. digest (this department):** open sentinel events (count, age) · incidents by severity last 24 h with any breach · anomalies withheld this month · outbreak/cluster status · licences expiring ≤ 30 d and any lapsed · credentials blocked/expiring · committees overdue · CAPAs overdue > 7 d · single-approver acts logged yesterday (pre-O1 honesty line) · silence signals (units with zero reports 60 d) · DSRs nearing TAT · last backup-restore drill result.

---

## 9. AI agents & the copilot — where inference earns its place

Rule applied (law 6): if a rule can do it, an automation does it. Six inference agents proposed; seven automations.

| Name | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open | Kill scope | Provenance | Eval/guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Licence & Credential Expiry Watchman** | automation (extends §16 Expiry Watchman) | T1 | daily: `q_licences`, `q_credentials`, `q_trainings`, DPAs, AMC (BME) | `licence.expiring/lapsed`, `credential.expiring/blocked`, batched department tasks; dependent-operation blocks via interfaces | none (rule) | manual calendar | per automation | n/a | fixture: every lead-day fires once; lapse blocks only listed ops | employee/licence data (low) | 22a |
| **Evidence Pack Compiler** | automation | T1 | on demand / weekly / pre-committee; pack template + scope | pack manifest with query refs, hashes, watermark, PDF/CSV | QM reviews before external release | manual queries | per automation | pack hash | reproducibility test | health data (packs sealed-aware) | 22a |
| **Indicator Data-Validation Checker** | automation | T0 | monthly materialisation | `indicator.validated / anomaly_flagged` | Quality exec | manual validation | per automation | n/a | rules: numerator ≤ denominator, completeness ≥ 90 %, z-score vs 6-m, zero-with-denominator | aggregate | 22a |
| **HAI Cluster Detector** | automation | T0 | micro `result.verified`, unit, organism, window | `outbreak.suspected` | ICN | ICN eyeballs the micro list | per automation | n/a | threshold fixtures (≥2 MDRO same unit 7 d; ≥3 same organism 14 d) | health data | 22b |
| **Audit Round Sampler** | automation | T0 | audit plan cadence | random seeded samples (files, units, times), excludes own-unit auditors | none | manual sample | per automation | seed logged | reproducible sample from seed | minimal | 22a |
| **Committee Agenda Feeder** | automation | T0 | cadence | agenda items from flagged events, overdue CAPAs, indicator exceptions, SOP reviews | chair approves | manual agenda | per automation | n/a | fixture per committee type | aggregate | 22c |
| **Protocol-Adherence Evaluator** (roadmap note 12) | automation | T2-capped (deviation *review tasks*) | machine-readable protocol rules in Expertise store × patient-context events | deviation tasks to named clinical reviewer | reviewer | sampling audits | per automation | rule version | rule unit tests; deviation ≠ correction | health data | with clinical modules + 22d; gated on knowledge sourcing |
| **Indicator Anomaly Explainer** | agent | T0 | `indicator.anomaly_flagged` + candidate-cause queries (denominator changes, module deploys, ward openings, reporting campaigns, order-set changes) as a *fact sheet* with line ids | typed claims citing query ids: "candidate explanations", never a corrected number | QM decides validation status | anomaly shown without explanation | per agent | model id, prompt v, hashes | citation guard (uncited claims dropped, copilot §2.4); entailment fixtures; no PHI (aggregates only) | aggregate (L0) | 22a-inference (post-12a gates) |
| **Incident Classifier** | agent | T2 | new incident text (scrubbed/tokenised per copilot §2.2), taxonomy, harm scale | draft: category, harm level, severity, sentinel? suggestion, duplicate candidates, IPSG tag | QM/triage confirms (draft ≠ classification) | manual triage form | per agent | stamps on `incident.classified.draft_ref` | eval set of ≥ 300 hand-labelled incidents; sentinel recall ≥ 0.95 required; over-triage acceptable | sensitive (tokenised) | 22b-inference |
| **RCA Drafter** | agent | T2 | incident + evented timeline (deterministic assembly: all events ± 24 h for patient/unit/actors, tokenised), RCA method template | draft timeline narrative + candidate contributing factors + questions for interviews; never a root cause verdict | facilitator edits; MS/QM signs; automation-bias instrumentation (D-36) applies | facilitator writes RCA | per agent | provenance on `rca.signed` (draft vs signed diff retained) | citation guard; fixture: fabricated event ids dropped; "no blame language" lint on draft | sensitive | 22b-inference |
| **SOP-Change Impact Summariser** | agent | T2 | old vs new SOP version diff + linked workflow definitions + linked training modules + roles assigned | draft: what changed, which definitions/steps may conflict, which roles need re-ack, suggested quiz questions | document controller; definition owner acts | manual review | per agent | stamps on `sop.published` | fixture: hallucinated definition ids dropped | low (no PHI) | 22c-inference |
| **Committee Minutes Drafter** | agent | T2 | agenda + typed decisions/notes during meeting (no audio by default; audio only with ruling O-8) | draft minutes in the committee template | chair + secretary sign | secretary types | per agent | stamps | fixture: decisions in draft ⊆ typed decisions | sealed for ICC (ICC never uses it — hard exclusion) | 22c-inference |
| **Care-Audit Mismatch (inherited C-20)** | agent | T0 | notes vs orders vs charges | mismatch flags | QM/HOD | round checklists | per agent | stamps | — | health | IPD cluster |
| **Digest Writer (inherited)** | agent | T0 | this module's digest queries | owner digest lines (§8) | — | queries | inherited | inherited | inherited | aggregate | 12a |

**Presentation lanes.** *Hand-built screens:* incident intake (3 fields to submit, everything else optional — speed beats completeness at intake), triage board, RCA workspace with timeline, HAI adjudication with device history, outbreak line-list, licence register, committee meeting view, SOP reader with ack, evidence pack viewer, inspection-visit console. *Schema-generated worklists:* CAPA tasks, acknowledgement queues, audit rounds, drill schedules, renewal queues, ratification queue — all P5 tasks rendered by the generic worklist. *Conversational copilot (Ops Copilot, post-registry, asker's permissions):* "what's our transfusion-reaction protocol?" → governed SOP with version cited (roadmap note 8, never RAG over PDFs); "which licences expire this quarter?"; "show CAUTI trend for hall B with the definition"; "draft the HICC agenda". Clinical roles last (copilot D1 ruling stands). **Journey Feed contributions:** per patient — incidents involving them (treating team only), HAI status, isolation, disclosure record; per staff — my acks due, my trainings, my credentials expiring, my CAPAs; per unit — open incidents, HH audit last result, outbreak flag.

**Prompt inputs, concretely (Incident Classifier):** `{taxonomy_v: "3.1", harm_scale: [...], text: "<scrubbed description>", location_kind: "ward", time_of_day_band, source_event_name?: "band.pair_mismatch", recent_similar: [{id_token, category}]}` → `{category_code, harm_level, severity, sentinel_suggested: bool, duplicate_of?: id_token, ipsg_tags: [...], rationale_citations: [line ids]}`. Anything not in the enum is dropped; rationale is displayed but never stored as the classification.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **Report in 20 seconds:** QR on every ward wall/tablet → form with location pre-filled from the QR (registry resource), patient via wristband scan, 3 mandatory fields (what, when, harm?), voice-to-text in Hindi/English (where lawful), photo attach; receipt code shown. Target: median intake < 60 s; anonymous path zero-login.
- **Auto-raised incidents** from hard-stop events (A-2, E-5, H-1) — no human re-typing; target ≥ 40 % of incidents auto-seeded at scale.
- **One-beep evidence:** every register print carries a QR to its live query; assessor scans → live view under persona.
- **TAT clocks:** sentinel 1 h/24 h/30 d; PEP 2 h; CERT-In 6 h; DSR statutory; renewal T-30 — visible as clocks on the worklists, alerts only on the four patient/legal-critical ones (law 7).
- **Keyboard-first RCA workspace:** timeline on the left from events, factors on the right; fishbone as structured fields, not drawing.
- **Committee packs generated the night before**, printed with QR + watermark, attendance by badge scan, actions as tasks before the meeting ends.
- **Acknowledgement nudges** batched weekly per person, not per SOP; critical SOPs get a 2-question check.
- **Licence wall:** one screen, traffic light per licence, dependent-operation rule displayed, renewal file attach.
- **Evidence pack < 60 s** for any template; reproducible by hash.
- **Measured targets:** incident triage median < 1 working day; RCA closure median < 21 d; HH ≥ 200 opportunities/unit/quarter; PEP in window 100 %; licence lapses 0; readiness ≥ 90 % core OEs before application; DSR TAT compliance 100 %; ack rate ≥ 95 % within 14 d for critical SOPs.

---

## 11. Integrations, devices & dependencies

- **Events consumed:** the full list in §3.1 trigger sources, plus `device.usage_started/stopped`, `result.verified` (micro), `surgery.completed`, `implant.recorded`, `patient.discharged/deceased`, `isolation.flagged`, `sterilisation.*` (doc 15), `environment_sample.*`, `bmw.*` (doc 08), `roster.*`, `exit.completed`, `workflow.definition.updated`, `break_glass.used`, `export.recorded`, `access_review.flagged`, `downtime.*`, `disaster.*`, `code.activated`, `dpia.completed`, `drill`… from DR automation, `agent.heartbeat_missed`.
- **Interfaces called:** `patients.get`, `resources.tree/board/history` (Plan 13), `roster.onDuty(unit, at)`, `kpi.registry.compute(metric, period)`, `documents.*` (Expertise store), `approvals.request`, `tasks.create`, `notifications.send`, `formulary.changeRequest`, `bme.asset(id)`, `cssd.loadsSince(bi_fail)`.
- **External:** NMC NMR / state medical council / nursing council lookups (web, manual fallback); ABDM HPR/HFR; NABH portal (self-assessment upload = manual, packs generated); CERT-In (email/portal), DPB (portal when live), SPCB portals (BMW annual return), PvPI (ADR reporting form, XML where available), IDSP; WHONET export from micro; HR SaaS (roster feed only); WhatsApp for micro-surveys and anonymous link. No devices of its own; badge QR scanners (existing USB scanners) for attendance.
- **Edge-service rule:** none needed; everything is core.
- **Dependencies on plans:** 12a (harness, provenance, playbook governance) for all inference; 13 (registry) for location; Plan 20-series roster (on-duty picture, S10 D-16) for succession/witness/roster-based exposures; doc 11 KPI formula registry for indicators; 16 pharmacy (med errors), 17 LIMS + micro (HAI, antibiogram), 15 mini-OT/CSSD (sterilisation, SSI), IPD cluster (device-days at ward level, falls, pressure injuries, restraint), 19 BMW/housekeeping, 07 nursing (eMAR, scales), 19-support BME (FMS), 20 front office (grievance/feedback), 14 ED (MLC), 18 blood bank (transfusion committee data). The module ships *before* many feeders with R-1 "not yet measurable" honesty.

---

## 12. Buy vs build, hardware & rough INR budget

- **Build (module `quality`):** everything in §3–§4; it is mostly configuration over kernel machinery. Estimated 5 phase docs.
- **Buy/licence:** NABH standards + self-assessment toolkit (NABH fees: application/assessment ~₹3–6 L for a 100–300 bed hospital incl. pre-assessment; annual ~₹1 L; consultant optional ₹3–8 L) · notifiable-disease and HAI-definition content (part of the §9 licensed clinical content) · nothing else — no QMS SaaS (they would duplicate the Expertise store and split the audit trail).
- **External services:** §138 internal auditor firm (₹2–5 L/yr at scale), DPO advisory/counsel for DPIA (₹1–3 L per DPIA), fire/electrical/lift/DG AMC vendors (BME budget), external stock audit (doc 09), stranger-drill contractor (D-12; ₹0.5–1 L/yr retainer).
- **Hardware:** none dedicated; QR posters (₹10 k), 2 badge-scan kiosks for drills/training (₹40 k), printer for watermarked packs (existing). Optional on-prem inference server is a §13 line (₹3–6 L) shared with all agents, decided by the DPIA (D-44).
- **Rough total, first year at 100–300 beds:** ₹8–15 L excluding staff and shared inference.

---

## 13. Owner rulings needed

- **O-1 No-blame / just-culture policy and anonymous reporting.** Recommend: adopt a written just-culture policy (system / at-risk / reckless), anonymous channel with no envelope actor and no device fingerprint, only MS/owner may set culpability, reckless routes to HR by evented human decision. Why: reporting rate is the asset; legal exposure of "no-blame" wording needs the owner's signature.
- **O-2 KPI wall.** Recommend RULING that no incentive, appraisal score or ranking may use incident counts per person or per unit (reporting rate may be shown as a positive health signal only). Why: money/policy; doc 11 G4 already recommends.
- **O-3 Open disclosure policy for sentinel/serious harm.** Recommend: disclosure to patient/family within 24 h of MS confirmation, by MS/treating consultant, documented; counsel-reviewed script; indemnity insurer notified in parallel. Why: legal exposure; NABH PRE expects a policy.
- **O-4 Whistleblower/integrity channel routing.** Recommend: integrity-category reports go to owner only, with a named external alternate (counsel) for reports about the owner. Why: policy; Fraud Sentinel link.
- **O-5 NABH edition and application timing.** Recommend: target the current edition at application; apply after 6 months of live registers on this system (mirrors doc 02 O-10), pre-assessment at readiness ≥ 90 % core OEs. Why: money; assessors want records.
- **O-6 Statutory signatories.** Recommend: owner = occupier/signatory for CEA, BMW, fire, PCPNDT, blood bank, AERB (employer), CERT-In/DPB; MS = alternate under the D-10 instrument; QM = DPO day one. Why: legal exposure sits with named persons.
- **O-7 Committee chairs and quorum defaults.** Recommend: HICC chair = ICO (microbiologist), DTC chair = senior physician (not pharmacist; pharmacist secretary), Q&PS = MS, mortality = MS, transfusion = blood-bank officer, grievance = owner delegate, ICC = senior woman employee + external NGO member, safety = operations head; quorum = 50 % incl. chair; monthly cadence except ICC (quarterly + ad hoc) and control-review (quarterly). Why: policy; NABH asks for named chairs.
- **O-8 Meeting audio recording for minutes drafting.** Recommend: **no** audio by default; typed decisions only; revisit after 12 months. Why: DPDP/employee data and culture.
- **O-9 Internal auditor appointment and concurrent-audit scope.** Recommend: appoint the §138 firm before the Payouts pack goes live; concurrent audit on cash, discounts, refunds, payouts, stock monthly; control-testing calendar quarterly. Why: money.
- **O-10 Licence dependent-operation blocks.** Recommend: hard blocks for PCPNDT (USG), AERB (each device), blood-bank licence (issue), drug licence (retail sale), BMW authorisation (handover), MTP approved place; soft (digest) for the rest; filed-renewal acknowledgement lifts a block for 90 d. Why: criminal liability vs continuity.
- **O-11 Incapacity deputy pair and the legal instrument.** Recommend: name the pair (MS + a family/trusted director), execute the delegation instrument with counsel, 30-d renewable authority, external weekly digest to counsel. Why: owner-owned.
- **O-12 Single-approver honesty mode (pre-O1).** Recommend: enable single-approver mode with `governance.single_approver_used` events and a daily digest line until runbook O1 closes; hard requirement that Class-A definitions in this module are re-ratified by two keys within 30 d of O1 closing. Why: makes the current state truthful rather than theatrical (Plan 13 §4A-3).
- **O-13 Retention numbers** in §4 (esp. exposures employment + 30 y; incidents 10 y; minutes permanent). Why: policy + storage.
- **O-14 Hand-hygiene observation anonymity** (unit/cadre aggregate, never named individuals). Recommend: yes. Why: culture and DPDP employee data.
- **O-15 Post-discharge SSI micro-survey via WhatsApp.** Recommend: yes, templates only, patient language, opt-out honoured. Why: patient contact policy.

---

## 14. Plan sketch — how this becomes phase documents

Series numbering collides across documents 01–20 (several claim Plan 20–22). This document keeps its own number as the family name — **Plan 22 — Quality, NABH & Governance pack** — and expects the series-level reconciliation to renumber. Sequencing: after 12a harness (for inference lanes), after 13 (registry), can start **in parallel with Track A/B** because the non-inference core has no feeder dependency beyond kernel + registry; it is the roadmap's Phase-2 fast-follow.

- **22a — Registers, incidents, licences, evidence (core; no inference).** T1 schema (`q_incidents`, taxonomy, `q_rcas`, `q_capas`, `q_licences`, `q_inspections`, `q_registers_view`, `q_indicator_set/values`, `q_nabh_crosswalk`, `q_evidence_packs`) · T2 incident workflow definition (Class A) + auto-raise subscriptions (idempotent on source event) · T3 anonymous channel (no-session endpoint, receipt codes, scrubber) · T4 licence register + Expiry Watchman extension + dependent-operation interface · T5 indicator set over doc-11 registry + validation checker + "not yet measurable" state · T6 evidence packs + inspection-visit workflow + external personas (E-20) · T7 digest lines + silence detector · T8 golden suite: rows A, B, C, F, I, J, O, S. Gate: none beyond 12a-independent; single-approver mode (O-12) if O1 open.
- **22b — Infection control.** HAI cases, device-days materialisation (ICU interface first, wards as IPD lands), HH/bundle/isolation audits + sampler, outbreak workflow, exposure/PEP workflow with `store` kits, immunisation register, antibiogram ingest, sterilisation-monitoring audit + BI-fail recall trigger (needs 15/CSSD), SSI post-discharge survey via Recall. Gate: 17 LIMS micro results (or manual entry mode), 06 ICU device events. Rows Q, H, N-2.
- **22c — Committees, documents, training, credentialing, drills.** Committee entity + cadence + agenda feeder + minutes + actions-as-tasks; Expertise store human face (shared `documents` with 12a playbooks — **decide table sharing at authoring**), acks + language variants + version QR; training/competency/attendance by badge scan; credentialing/privileging workflow with NMC/HPR lookups and temp privileges; drills. Gate: roster module for succession/witness (S10 D-16) — can ship with manual roster stub. Rows G, P, L, J-2..J-4.
- **22d — Internal audit, clinical audits, protocol adherence, DPDP program.** Audit plans/rounds/findings, control-testing calendar (SoD/gate tests as automated assertions in prod, evented `audit.control_tested`), prescription/medical-record/consent/IPSG audit instruments, break-glass review queue, access reviews, export reviews, DSR register + notice versions + breach workflow with CERT-In/DPB checklists, DPIA register, processor agreements on the watchman. Protocol-Adherence Evaluator only when machine-readable protocols exist (note 12). Rows E, K, D-6.
- **22e — Inference lane (post-12a gates, DPIA for this pack).** Indicator Anomaly Explainer (aggregate-only; earliest), Incident Classifier, RCA Drafter, SOP-Change Impact Summariser, Committee Minutes Drafter; eval sets built from 22a's first 6 months of hand-triaged incidents. Gate: DPIA L1 revision + provider DPA + eval fixtures + shadow mode (copilot §2.6).
- **22-G — Governance (own phase, after IPD cluster, after O1 — RULED Plan 13 §4A-3).** Master-data change control across rooms/doctors/departments/formulary/tariff *and* this module's licence/credential masters in one shape; emergency-governance and incapacity workflows exercised end-to-end with two real actors; continuity-kit escrow + first stranger drill; re-ratification of Class-A definitions activated under single-approver mode.

**What must be true before authoring 22a:** 12a harness shape settled (provenance, kill switch) even if inference off; doc-11 KPI registry table shape frozen (or 22a ships a stub and migrates); Plan 13 deployed (locations); owner rulings O-1, O-2, O-6, O-10, O-12 (the rest can trail).

**Negative-space question answered:** *the absence of incidents is the signal.* A unit, shift or cadre with zero reports over a window in which the hospital median predicts several; a month with zero HAI on non-zero device-days; an SOP with 100 % acks in one minute; a committee with no open actions; a licence register with no "expiring" rows for a year; a break-glass log with zero entries in an ED — each is a digest line, because in this domain silence is the most likely symptom of a broken sensor or a frightened staff.

**Staff edge-case interview questions (for QM, ICN, MS, licence officer, a ward sister, a housekeeping supervisor):**
1. When did you last *not* report something, and why? What would have made you report it?
2. What happens at 2 a.m. after a needle-stick today, minute by minute?
3. Which register do you keep that nobody has ever asked to see? Which one has been asked for and you couldn't find?
4. Describe the last time an assessor/inspector asked for something and how long it took to produce.
5. Which SOP do staff follow differently from what is written? Why?
6. How do you currently learn that a licence is expiring? Who has been fined and for what?
7. What would make you *distrust* a HAI rate on a dashboard?
8. Which committee decisions never got done, and how would you know?
9. How do you verify a new doctor's registration today? A locum's?
10. What is the one incident you fear most in this building, and what is the paper path for it?
11. When the owner is unreachable, who decides, and how do you know they decided?
12. Which drills are real and which are for the file?
13. What would a nurse need to see to believe reporting is safe?
14. What do you currently tell a family after a serious error, and who says it?

---

## 15. Open questions & risks

1. **NABH 6th edition objective-element list**: the crosswalk must be authored from the actual standards document (licensed/purchased from NABH) — this document maps chapters only; OE-level mapping is data work with the QM, and the edition in force at application time is unknown.
2. **Shared `documents` table with 12a playbooks** (roadmap note 8 says one store): whether the kernel owns it or `quality` owns it and 12a references it must be decided at 22c authoring; recommend kernel.
3. **Anonymous channel legal posture**: an endpoint that deliberately keeps no access identity conflicts with CERT-In's 180-day log retention direction if logs are read as covering application endpoints; recommend coarse logs (timestamp, route) without IP, with counsel opinion in the DPIA.
4. **Device-day denominators outside ICU** depend on nursing documentation of catheter/line days (doc 07); until eMAR/device charting is live, CAUTI/CLABSI outside ICU are "not yet measurable" — a visible NABH gap for an assessment before the IPD cluster.
5. **HAI case definitions**: CDC/NHSN definitions are the corporate norm in India but are not "licensed content" in the §9 sense; ICMR/NCDC HAI surveillance network definitions exist — pick one, version it in the Expertise store, and keep the `criteria_version` on every case.
6. **Culpability data** ("reckless") is employee sensitive data with disciplinary consequences: DPDP notice for staff (doc 11) must cover it; retention and access are unsettled.
7. **Single-site vs multi-site accreditation** when `site_id` gains a second value: NABH accredits per facility; registers are site-scoped by design but committee structures may be shared — undecided.
8. **Automated control tests in production** (SoD block "actually blocks") require synthetic actors in prod under the ops-mode framework; the safety of running them against live data needs a design note in 22d.
9. **Inference for incident text** touches the most sensitive free text in the hospital (staff naming staff); the DPIA for 22e should consider on-prem inference specifically for this pack even if cloud is accepted elsewhere (D-44).
10. **Risk register** (ROM) is not designed here beyond a fold into audit plans; a proper enterprise-risk register may deserve its own table in 22d.
11. **The first year is a one-admin hospital** (runbook O1): everything two-key in this document is honest only with O-12's single-approver mode; the risk that it becomes permanent is real and is the reason 22-G is gated on O1 rather than on convenience.
