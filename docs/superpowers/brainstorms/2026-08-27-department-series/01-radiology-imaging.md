# 01 — Radiology & Imaging — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED · **Series:** Department Brainstorm & Planning (overnight run) · **Roadmap home:** Plan 18 (Track A, after 17 LIMS)

**Executive summary.** Radiology is the hospital's second order-to-result pipeline (P2) after the lab, with three things the lab does not have: a bulk-storage edge (PACS: Orthanc + OHIF, spec §5/§3), two statutes that can shut the department (PCPNDT Act 1994 with the Form-F cannot-close rule; AERB under the Atomic Energy (Radiation Protection) Rules 2004), and a signed *narrative* document as the product rather than a number. This document covers X-ray (fixed + portable), USG (incl. obstetric), CT, MRI (in-house or outsourced), mammography, and the interventional/emergency edges; it defines the boundary to cardiology echo, cath lab, and radiation oncology (LINAC/R&V/TPS is bought; the HMIS orchestrates and keeps the AERB registers — spec §11.19-A, locked). It is NOT a PACS (Orthanc is), NOT a viewer (OHIF is), NOT a radiation-therapy planning system, NOT an ultrasound machine's own software, and NOT a scheduling calendar bolted on — scheduling is a view over P2 states (§10.1). Hardest three problems: **(1) PCPNDT made structural without making obstetric follow-up scans impossible at 02:00 when the sonologist is on the phone**; **(2) the report as a versioned, signed, amendable, AI-pre-drafted document whose provenance survives a courtroom**; **(3) PACS physics — storage growth, DR, and image release under DPDP — on a solo-maintained modular monolith with a single VM today and 610 beds in a year.**

---

## 1. Frame — what exists, what is locked, what this document adds

**Locked (inherited, not re-litigated):**
- §11.7 flow: order → schedule (walk-in X-ray vs slotted CT/MRI/USG) → prep auto-WhatsApp → check-in → safety gates → acquisition to PACS → radiologist worklist → draft (T2) → signed → publish with the lab's critical-findings protocol. Hard gates: contrast consent + creatinine; pregnancy check before X-ray/CT on women of reproductive age; **Form F gates every applicable USG** (widened by §11.19-C-6 to any USG on a woman of reproductive age, any department, portable included). Teleradiology designed-in but dormant; modality-down = offline on schedule board + rebooking cascade.
- §11.6 (shared with imaging by §11.7's "same protocol"): amended reports versioned never overwritten; critical value acknowledgment with read-back; departed-patient mandatory contact protocol (§11.5); report re-delivery on amendment (§11.19-E-22 `report.superseded`).
- §11.19-C-5: PCPNDT records are a **sealed event class**; access evented. §11.19-E-20/21: inspector personas, statutory-format certified prints, electronic-register legality per act (§19 gate). §11.19-D-27: report signing needs a second factor. §11.19-D-36: AI draft = unsigned working paper; signed doc is the doctor's own; draft trail is QA material.
- §11.19-A: cath lab reports to PACS with a per-procedure radiation-dose log; **RT: buy R&V/TPS, HMIS orchestrates; AERB registers (brachy source movement, TLD reads, machine QA with QA-fail = blocked) live in the HMIS; RSO + medical physicist in the credential registry.** §11.19-C-36: tiered imaging retention, incremental object-storage offsite, staggered backup windows.
- §16: Radiology Report Drafter is a T2 agent shipping "with PACS"; clinical cap T2–T3 forever; provenance stamps; fail-open; kill switch.
- Roadmap Plan 18: order → schedule → perform → report; doctor-wise report templates as editable documents; **PACS stays deferred; PCPNDT machinery in scope, not optional**. Pre-mini-OT gate (§19 v4.8): PCPNDT registration (machine + sonologists) on file before any USG. Plan 15 (mini-OT) instantiates Form F first; this module inherits that table, does not duplicate it.
- Plan 13: resources are `floor|ward|hall|room|bed|theatre|store|bench|analyzer|device`; kinds are closed; statuses declared on the manifest seam. Modalities are `device` resources inside `room` resources.
- S10 cards 15 (Radiologist) and 18 (Imaging Technician); succession chain for the single 24×7 radiologist (S10 §12.16); chaperone gate on USG for female patients (§11.19-E-3).

**Scope boundaries (who owns what table):**

| Concern | Owner | Interface used by radiology |
|---|---|---|
| Patient master, ABHA, guardian, sealed/VIP flags, language | `patients` | `patients.get`, sealed-class checks |
| Encounter spine, order envelope (`order.placed`, `order_type: imaging`) | kernel orders (shared P2 envelope, proposed Plan 17 lays it for lab; 18 reuses) | radiology owns the *imaging-specific* tables hanging off the order |
| Charges, invoices, pre-auth sanction object, packages | billing / TPA | `charge.posted` from `study.acquired`; `preauth.*` consumed |
| Contrast media, films, CDs, gel, needles | pharmacy/stores (P3) | `material.issued` → `material.consumed` terminates on the study's bill |
| Workflow instances, SLA, escalation | kernel workflow engine | definitions below are data |
| Modality rooms, machines, portables, viewers | Plan 13 registry (`room`, `device`) | status: available / in_use / down / qa_blocked / decommissioned |
| Echo, TMT, Holter | cardiology (future service-line) | *uses* radiology's report-document machinery via declared interface; echo DICOM lands in the same Orthanc; cardiologist signs |
| Cath lab procedure record, consignment | cath lab module | radiology owns dose register rows that cath lab *emits* |
| Radiation oncology (referral, planning handoff, fractions) | RT module (bought R&V + thin HMIS orchestration) | radiology module owns the **hospital-wide radiation-safety registers** (AERB) which RT/cath lab write to via interface |
| Incident register, ADR register | quality pack / pharmacovigilance | contrast reaction → `adr.reported` + `incident.reported` |
| Notifications (prep, report-ready, critical contact) | Plan 10 gateway | templates in patient language |

**What this document adds:** the imaging-specific workflow definitions (eight), the data model incl. statutory registers as tables, the PCPNDT and AERB machinery as first-class, the PACS/Orthanc topology with MWL, teleradiology as a send-out, the 120-row edge catalogue, chaos walkthroughs, KPIs, agent placements, and a split of Plan 18 into 18a/18b/18c.

---

## 2. Actors, roles & role cards

| # | Role (S10 card if exists) | Stations | Shift | Notes |
|---|---|---|---|---|
| 15 | **Radiologist** (S10 #15) | worklist, sign, critical comms, PCPNDT accountability, protocolling | 24×7 single incumbent day one → 6–8 | Succession chain published (S10 §12.16). Sub-roles: *sonologist* (PCPNDT-registered, may be the same person), *interventional radiologist* (later) |
| 18 | **Imaging Technician / Radiographer** (S10 #18) | console, MWL, gates, PACS push, portable rounds, dose entry | 24×7 in shifts; CT/X-ray night skeleton | Must hold AERB-recognised qualification (diploma/BSc MIT); TLD badge holder |
| NEW-R1 | **Radiology Receptionist / Scheduler** | order intake, slotting, prep instructions, TPA pre-auth chase, film/CD desk, image-release desk | day; bundles into front office at night (S10 §10) | Proposed card; day-one may be the OPD front office with a radiology worklist |
| NEW-R2 | **Radiology Nurse** | IV access, contrast administration under radiologist, reaction kit, post-contrast observation, sedation monitoring (MRI paediatrics) | day + on-call night | Chaperone-eligible female nurse rostered per §11.19-E-3 |
| NEW-R3 | **Radiation Safety Officer (RSO)** | AERB licences (eLORA), TLD badge programme, QA calendar, dose-register review, room surveys | designated person, part-time day one (radiologist or senior radiographer with AERB RSO approval) → dedicated with CT/cath/RT | Credential registry entry; joins compliance calendar |
| NEW-R4 | **Medical Physicist** | RT QA, dosimetry, brachy source custody (RT floor only) | with RT commissioning | Credential registry; AERB-mandated for RT |
| NEW-R5 | **PACS Administrator / Imaging IT** | Orthanc health, storage tiers, MWL, DICOM node config, viewer, DR drills | day; on-call | Day one = the owner's ops contractor; a named human with vendor-access logging |
| NEW-R6 | **Teleradiology Partner (external persona)** | reads assigned studies, returns signed report | night/overflow, dormant until activated | Read-only scoped persona, time-boxed grants (§11.19-E-20); DPDP processor agreement |
| NEW-R7 | **Resident / Trainee Radiologist** | preliminary reads (ED nights), protocolling under supervision | when DNB/MD programme exists | Prelim reads always labelled UNVERIFIED and superseded by a consultant signature |
| — | Transport attendant (S10 ops) | ward→CT trolley, portable escort | P5 tasks | |
| — | Ward nurse / ICU nurse | portable requests, pregnancy/contrast pre-checks on ward, critical read-back | | |
| — | Ordering doctor (OPD/ED/IPD) | order, indication, pre-auth justification, acknowledges criticals | | |
| — | Billing supervisor / TPA desk | pre-auth, package application, credit | | |
| — | Duty manager | night escalation apex; modality-down rebooking authority | | |
| — | Quality manager / DPO (S10 #37) | PCPNDT monthly return sign-off, image-release DSR, inspections | | |

**Agent / automation actors (§9 details):** Radiology Report Drafter (agent, T2) · Prep & Recall Reminder (automation, T1 — Recall & Follow-up scope) · Critical-Finding Chaser (automation, T1 — SLA Chaser scope) · Unread-Study Watchman (automation, T1) · Form-F Gatekeeper (deterministic rule in the workflow, not an agent) · PCPNDT Return Compiler (automation, T2 draft of the monthly Form-F consolidation) · Dose & Badge Watchman (automation, T1 — Expiry Watchman scope) · Order Appropriateness Nudger (deterministic rule set, T1) · Slot Optimiser (agent, T3, later) · Storage Forecaster (automation, T0) · Protocol Suggester (agent, T2, later).

**SoD hard pairs (add to S10 §11):** sonologist who performed the scan ≠ person who signs the Form-F *verification* for the monthly return (quality manager/PCPNDT-in-charge) · report signer ≠ Drafter (structural) · resident prelim ≠ final signer for the same study (final must be a consultant) · RSO ≠ the radiographer whose badge read is being disputed · PACS admin ≠ approver of image deletion/purge · image-release desk ≠ DSR approver.

**Bundling (night):** receptionist ← ED registration desk · radiology nurse ← ED nurse (contrast in ED CT is the ED nurse under radiologist phone order — evented) · RSO duties sleep · radiologist ← teleradiology partner only when activated by the owner (O-1).

---

## 3. Core flows as workflow definitions

All definitions are versioned data (§10.2). SLAs are *recorded* from day one; active alerts only on the patient-facing ones marked ⚠ (§10.3).

### WF-IMG-01 Imaging order-to-result (P2 + P6 overlay + P7)

```
ordered ──(billing branch: OPD prepay | IPD post-to-bed | ER accrue | TPA preauth_pending)──► authorised
authorised ──schedule (walk-in X-ray auto-slot | CT/MRI/USG slotted)──► scheduled
scheduled ──check-in scan (QR/UHID)──► checked_in ──gates pass──► ready_for_acquisition
  ├─ no_show (P7 recall ladder) ─► rescheduled | cancelled
  ├─ unfit / gate_failed (reason-coded) ─► rescheduled | cancelled
ready_for_acquisition ──tech opens MWL item──► in_acquisition ──PACS receives study (study.acquired)──► acquired
acquired ──worklist──► awaiting_read ──radiologist opens──► reading
  ├─ prelim_read (resident/ED) ─► [UNVERIFIED published to ordering doctor] ─► reading
  ├─ sent_out (teleradiology) ─► external_read ─► ingest ─► reading (countersign) or signed
reading ──draft (human or Drafter T2)──► drafted ──sign (2FA)──► signed ──publish──► published
published ──critical? ──► critical_open ──ack + read-back──► acknowledged
published ──amend──► amended (new version; report.superseded re-delivery)
any ──cancel (reason)──► cancelled
```

| State | Allowed transition roles | SLA (record; ⚠ = active alert) | Escalation ladder |
|---|---|---|---|
| ordered→authorised | billing/TPA desk, system (IPD/ER auto) | OPD 15 min; TPA pre-auth 4 h ⚠ for IPD | TPA desk → billing supervisor → duty manager |
| scheduled | receptionist, system | X-ray walk-in 20 min wait ⚠; USG same-day; CT ≤24 h; MRI ≤48 h (in-house) | receptionist → radiology head |
| checked_in→ready | tech, nurse | gates ≤10 min (contrast: creatinine result present) | tech → radiologist |
| in_acquisition→acquired | tech (MWL), PACS (system) | acquisition-to-PACS ≤15 min | tech → PACS admin (`interface.down` if >30 min hospital-wide) |
| awaiting_read | radiologist, resident, telerad | ED/stat 60 min ⚠; IPD 4 h; OPD 24 h; screening mammo 48 h | radiologist → succession chain → duty manager |
| drafted→signed | consultant radiologist only (2FA) | draft age >24 h flagged | Unread-Study Watchman |
| published→acknowledged (critical) | ordering doctor / ward nurse read-back; departed patient → contact protocol | 60 min ⚠ (red), 24 h (orange) | radiologist → ward in-charge → duty manager → MS |
| amended | signer + reason code | re-delivery within 30 min | — |

Events: `order.placed{order_type:imaging}` · `preauth.requested/.granted/.denied` (billing) · `study.scheduled` · `patient.checked_in` · **NEW `imaging.gate_evaluated`** {gate, outcome, evidence} · **NEW `study.acquisition_started`** · `study.acquired` · **NEW `study.prelim_read`** · **NEW `study.sent_out`** / **NEW `study.external_reported`** · `report.drafted` (with provenance if agent) · `report.signed` · `result.published` · `result.critical_flagged` · `result.acknowledged` · `report.amended` · `report.superseded` · `order.cancelled` · `charge.posted` · `sla.breached`.

**Corporate variants:** (a) *Direct walk-in with outside prescription* — order created by receptionist with referral attribution (feeds commission ledger per §11.6 lockeds; external-RMP payout stays OFF per §11.19-C-1); (b) *Health-check package* — orders pre-generated from the package definition, each study `package.applied`; (c) *ED bypass* — trauma/stroke orders skip billing branch (ER accrues) and scheduling (auto-slot "now"); (d) *IPD portable* — order spawns a P5 task (WF-IMG-06); (e) *Second-opinion / outside films* — a study without an order: `imaging.outside_study_imported` (NEW) with source facility, then read as a consult.

### WF-IMG-02 Safety gates (sub-workflow evaluated at checked_in → ready)

Gates are declared rules on the *study type*, not code: `pregnancy_screen` (female, age 10–55, ionising modality or pelvic MRI with gadolinium) · `contrast_consent` · `renal_function` (eGFR ≥30 else radiologist override; creatinine validity: OPD 30 days, IPD/ICU/diabetic/CKD 7 days — configurable) · `metformin_hold` advisory · `prior_contrast_reaction` (allergy list on patient master) · `mri_safety_questionnaire` (implants, pacemaker, aneurysm clips, cochlear, metallic FB, claustrophobia/sedation) · `form_f` (WF-IMG-03) · `chaperone_present` (§11.19-E-3) · `mlc_check` (trauma) · `identity_two_factor` (name + UHID/DOB spoken back; wristband scan on IPD) · `laterality_confirm` (side marked on order vs patient statement) · `sedation_consent` (paeds MRI) · `pacemaker/MRI-conditional device card`. Every evaluation emits `imaging.gate_evaluated`; an override is `approval.requested` to the radiologist (or auto-waived in the emergency gate profile, §11.19-C-7, loudly logged).

### WF-IMG-03 PCPNDT Form F (statutory; sealed class)

```
applicable_detected (order on female 10–55, any USG, any dept, any machine) ─► form_f_open
form_f_open ──sonologist completes Part A–G + patient declaration (+ referral slip)──► form_f_complete
form_f_complete ──sonologist signs (2FA)──► form_f.recorded ──► scan may close
scan close attempted without form_f.recorded ─► REFUSED (workflow engine, no override)
monthly: register_compiled (by 5th) ─► verified (PCPNDT in-charge, SoD) ─► filed (statutory_return.filed)
```
Rules: form serial is per registered machine per year, gap-free; the machine used must be a PCPNDT-registered `device` resource; the sonologist must be a registered person for *that* facility registration; the report template for obstetric USG has **no foetal-sex field and lexical lockouts** on free text (male/female/boy/girl/ladka/ladki/beta/beti + Devanagari) — a hit blocks signing, not just warns; the *patient declaration* ("I do not want to know the sex") is captured with signature/thumb + witness where illiterate; Form F preserved ≥2 years (Rule 9(8)) — we keep with the record, and indefinitely while any proceeding is pending (`legal_hold.applied`). Non-pregnant applicable scans (e.g., pelvic USG for fibroids) still require Form F's applicability decision recorded (`not_pregnant_declared`), which is the recommended corporate default under Rule 9's "every pregnant woman" scope plus the §11.19-C-6 widening.

### WF-IMG-04 Contrast administration & reaction (P3 + incident)

`contrast_planned` → `consent_recorded` → `renal_gate_passed` → `administered` (agent, volume, lot, route, injector) → `observation` (15–30 min, vitals) → `released` | `reaction_flagged` → severity (mild/moderate/severe/anaphylaxis) → `adr.reported` + `incident.reported` + allergy written to patient master (`allergy.recorded`) → `resolved`. Contrast vial is a P3 issue that terminates on the bill or on a wastage cost centre (multi-dose vial remainder). Reaction kit = registry `device`-adjacent checklist with a recurring task (§11.7).

### WF-IMG-05 Critical / unexpected findings (P7)

Categories (corporate default, ACR-style): **Red** (tension pneumothorax, ectopic with free fluid, ICH, aortic dissection, PE, bowel perforation, misplaced line/tube, testicular/ovarian torsion) → phone within 60 min, read-back name + time logged · **Orange** (new mass suspicious for malignancy, unexpected fracture) → within 24 h, documented channel · **Yellow** (incidental, follow-up advised) → in report + Recall ladder at the follow-up date. Departed OPD patient → §11.5 contact protocol (call tasks, WhatsApp in patient language, escalation to ordering doctor and to the patient's registered kin only per consent scope). `result.critical_flagged` → `result.acknowledged` closes; unclosed at SLA → `escalation.triggered`.

### WF-IMG-06 Portable X-ray / bedside USG on wards and ICU (P5 over P2)

Order → `task.created{type:portable_imaging}` → tech accepts → travels with machine (registry `device` status `in_use`, location = ward resource) → **bedside identity gate: wristband scan + pregnancy/MLC flags on the tablet** → exposure with area-clearance (staff step back; pregnant staff flagged) → DR plate/CR cassette → PACS push from ward Wi-Fi or on return (cassette ID ↔ patient binding captured at bedside, not at the reader) → `study.acquired` → normal read path. SLA: ICU stat 30 min ⚠, ward routine 2 h. Portable dose logged to the dose register.

### WF-IMG-07 Emergency clocks (ED overlay; derived, not entered)

`stroke.suspected` (NEW; from triage) → door-to-CT ≤25 min → `study.acquired` → CT read ≤45 min door → `result.published` (prelim allowed) → thrombolysis decision (ED owns). `trauma.activated` (NEW, ED) → eFAST at bedside ≤10 min, CT within 30 min of activation. Clocks auto-derive from `er.arrived`/`er.triaged` and imaging events, shown on the ED board and radiology worklist as a countdown; breaches recorded, alerted ⚠ (patient-facing). Same mechanics as §11.19-A door-to-balloon.

### WF-IMG-08 Modality QA, AERB and radiation safety (QC-lockout class)

`qa_due` (calendar: daily tech checks, periodic physicist QA, AERB 2-yearly) → `qa_performed` → `qa.passed` | `qa.failed` → device status `qa_blocked` (no MWL item can be started on it; emergency override by RSO+radiologist evented) → `service_completed` → re-QA. Licence lifecycle on the compliance calendar (`license.expiring`); TLD badge cycle (issue → wear → return → read → `badge.read_recorded` NEW → dose limit check → `dose.limit_warning` NEW at 3/4 of annual limit; investigation task above). Room survey after any structural change.

### WF-IMG-09 Image/report release to patient or third party (DPDP)

`release.requested` (patient/guardian/lawyer/insurer/police) → identity + authority verified (guardian scope per §11.19-D-31; MLC → police requisition path; sealed class → DPO) → format chosen (WhatsApp PDF report already auto; film print; CD/USB DICOM; DICOMweb share link time-boxed; ABDM care-context) → charges if any → `document.release_logged` (existing) with purpose and recipient → delivered. DSR export via §12 portability.

### WF-IMG-10 Teleradiology send-out (dormant; P2 send-out mirror of lab §11.6)

`study.sent_out` (de-identification level per DPA: partner sees images + clinical history + age/sex; name/UHID tokenised unless the partner is a treating consultant under contract) → partner SLA clock → `study.external_reported` → ingest (PDF + structured fields) → either auto-publish as signed by the external radiologist (registered, credential on file) or in-house countersign → normal publish. Failure to return in SLA → fallback to in-house succession chain.

---

## 4. Data model sketch

Module folder `radiology` (own schema; manifest declares menu, permissions `radiology.order/.schedule/.acquire/.read/.sign/.amend/.release/.pcpndt.*/.aerb.*`, subscriptions, and `resourceKinds` claiming statuses for `device{modality}` — kinds themselves are closed per Plan 13 DD4).

| Table | Key columns (sketch) |
|---|---|
| `imaging_orders` | id, order_id (kernel envelope), encounter_id, patient_id, study_type_id, laterality, priority (routine/urgent/stat/stroke/trauma), indication (free text + ICD hint), clinical_question, ordering_doctor_id, referral_source_id, payer_tag, preauth_id?, package_line_id?, pregnancy_status_declared, contrast_planned, workflow_instance_id, created/updated_by |
| `imaging_study_types` | code, name, modality, body_part, default_protocol, duration_min, prep_template_id, gates[] (rule ids), tariff_service_id, ionising bool, contrast_option, pcpndt_applicable_rule, chaperone_required, appropriateness_hints |
| `imaging_studies` | id, order_id, modality_device_id (registry), room_id, tech_id, scheduled_at, checked_in_at, acquisition_started_at, acquired_at, study_instance_uid, accession_number (= MWL key), series_count, image_count, size_bytes, dose_summary (CTDIvol/DLP or DAP), repeat_count, reject_reason, occurred_at/recorded_at |
| `imaging_reports` | id, study_id, **version**, status (prelim/draft/signed/amended/superseded), template_id, structured_json (FHIR `DiagnosticReport` + `Observation`s), narrative_text, impression, critical_category, signer_id, signed_at (2FA proof), amendment_reason, supersedes_id, **draft_provenance** {model_id, prompt_version, input_hash, output_hash, edit_distance}, external_reporter_id? |
| `report_templates` | id, doctor_id? (doctor-wise, editable documents), study_type_id, body (sectioned, placeholders), version, lockout_lexicon_set (PCPNDT), active |
| `imaging_safety_screenings` | study_id, gate_code, outcome, evidence (creatinine value+date, LMP, pregnancy test id, MRI questionnaire json, consent doc id), evaluated_by, override_approval_id |
| `contrast_administrations` | study_id, agent, concentration, volume_ml, lot/batch (from pharmacy issue), route, injector, administered_by, supervising_radiologist, observation_end, reaction_id? |
| `contrast_reactions` | id, severity, symptoms, treatment, adr_report_id, incident_id, allergy_record_id |
| `critical_findings` | report_id, category, communicated_to, channel, read_back_text, communicated_at, acknowledged_by, contact_attempts[] |
| **`pcpndt_form_f`** (sealed class; shared with Plan 15) | serial (machine_reg, year, seq — gap-free), study_id, patient_id, machine_registration_id, sonologist_registration_id, sections A–G, declaration_doc_id, referral_slip_doc_id, indication_code (Rule 9 list), gestation_weeks, result_summary, signed_at, verified_for_return_at |
| **`pcpndt_registrations`** | facility registration no., validity, machines[] (device_id, make, model, serial, Form-B ref, seal status), persons[] (sonologist, qualification, council reg, training cert), display board evidence |
| **`pcpndt_returns`** | month, form_f_count, machine-wise counts, compiled_by, verified_by, filed_at, acknowledgement_doc |
| **`pcpndt_inspections`** | visit date, authority, findings, directions → tasks, closure |
| **`aerb_licences`** | equipment (device_id), eLORA ref, licence no., type approval, layout approval, validity, RSO id, decommission record |
| **`tld_badge_reads`** | staff_id, badge_no, period, Hp(10)/Hp(0.07), cumulative YTD, 5-yr rolling, limit_flag, investigation_task_id |
| **`radiation_dose_register`** | study_id/procedure_id (cath lab, RT fraction ref), patient_id, modality, CTDIvol, DLP, DAP, fluoro_time, cumulative per patient, DRL comparison |
| `modality_qa_logs` | device_id, qa_type, performed_by, result, values json, next_due, block_applied |
| `imaging_sendouts` | study_id, partner_id, deid_level, sent_at, sla_due, returned_at, report_doc_id, cost |
| `image_releases` | study_id(s), requester, authority proof, format, charge_line_id, released_by, release_logged_event_id |
| `imaging_outside_studies` | patient_id, source facility, media, imported study uid, read_as_consult |
| `imaging_prep_templates` | study_type, language variants, fasting hours, meds hold, arrive-before |
| `film_cd_stock` | via pharmacy/stores P3; radiology only references issue ids |

**Registry resources (Plan 13):** `room` — X-ray room 1/2, CT suite, MRI suite (with zone III/IV flag), USG rooms, mammo room, reporting room · `device` — each modality (status vocabulary declared by radiology manifest: `available|in_use|down|qa_blocked|maintenance|decommissioned`), portable X-ray units, portable USG, CR reader, dry printer, CD robot, contrast injector, reaction crash cart (checklist device), diagnostic workstations · `store` — contrast/film sub-store. Occupant of a modality `device` = the study in acquisition (DD6 polymorphic occupant).

**FHIR shapes:** `ServiceRequest` (order), `ImagingStudy` (study; references Orthanc study UID, not pixels), `DiagnosticReport` + `Observation` (structured findings, e.g., BI-RADS, TI-RADS, LI-RADS, foetal biometry), `Procedure` (contrast admin), `AllergyIntolerance` (contrast reaction), `Consent`, `DocumentReference` (PDF, Form F scan).

**Retention (recommended defaults, O-9):** reports and structured data = record retention (OPD 5 y, IPD 10 y, MLC indefinite; §11.14) · images: Tier 1 online 18 months on NVMe/SSD; Tier 2 nearline 5 years on HDD/object store; Tier 3 cold offsite ≥10 y for CT/MRI/mammo and MLC; USG cine 3 y unless obstetric anomaly or MLC; paediatric until age 25 · Form F ≥2 y statutory, we keep with record · TLD/dose registers 30 y after cessation of employment (corporate practice under AERB guidance) · AI draft trail 2 y (QA material, §11.19-D-36) · teleradiology payloads purged at partner on ack (DPA).

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.**

### A. Identity & wrong-patient / wrong-side

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| A1 | Two "Ram Kumar, 45" in the CT waiting area; tech calls the token, the other one enters | Check-in scan of QR/UHID at the console populates MWL; console shows photo (if captured) + DOB read-back; tech confirms two identifiers before "start" | MWL item cannot transition to `in_acquisition` without `identity_two_factor` gate event; fixture with two same-name patients asserts the wrong UHID is refused | — |
| A2 | Study pushed to PACS under wrong accession (tech picked wrong MWL row) | Reconciliation queue: PACS study with mismatched patient demographics vs MWL flagged `study.unmatched` (NEW); relink is an entered-in-error correction (§11.19-E-8) with reversing event; report cannot be opened on an unmatched study | Assert unmatched study never appears on the radiologist worklist; relink emits `correction.entered_in_error` + new `study.acquired` | — |
| A3 | Left knee ordered, right knee imaged | Laterality on order, on MWL, on gate; report template pre-fills laterality from order and the signer must confirm if the DICOM `Laterality` tag differs | Mutant: remove laterality compare → fixture with DICOM tag R vs order L must block sign | — |
| A4 | Unconscious ED "Unknown Male 1" gets CT; identified next day | Temporary UHID with alias; study and report follow the merge (§11.5 merge with side-by-side review); ABHA linking deferred | After `patient.merged`, study lists under survivor; original alias preserved in audit | — |
| A5 | Portable film taken on bed 12, cassette read at reader tagged to bed 13 patient | Cassette/DR-plate ID bound to patient at bedside by wristband scan (WF-IMG-06); reader cannot bind manually without supervisor override | Assert `study.acquired` payload carries bedside binding event id | — |
| A6 | Patient merged wrongly; CT of A now on B's record | Unmerge splits studies by original accession; report re-attached; any published report to B is superseded with notice | Fixture: merge→unmerge restores study ownership exactly | — |
| A7 | Duplicate UHID patient has prior films under the other UHID; radiologist lacks priors | Search priors across candidate duplicates flagged by registration's duplicate-check; "possible priors under UHID X" banner | Assert banner appears when duplicate candidate exists | — |
| A8 | Films/CD handed to the wrong family at the counter | Release requires UHID QR scan + receiver ID; `document.release_logged` carries receiver identity | Assert release refused without scan | — |
| A9 | Patient ID on films: dry-printed film lacks UHID | Print layer burns UHID, name, DOB, study date, hospital, accession, and QR onto every film/PDF page | Golden print fixture checks the header block | — |
| A10 | Newborn USG cranium, mother's UHID used | Newborn gets own UHID at birth (§11.17 pairing); order refused on mother's encounter for neonatal study types | Assert study-type age band vs patient age mismatch blocks order without override | — |

### B. Timing, concurrency, race

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| B1 | Two receptionists book the last MRI slot simultaneously | Slot is a registry occupancy on the `device`+time; second booking fails `already_occupied` (Plan 13 A2 semantics extended to time-slots) | Concurrent-insert test proves lock is load-bearing (mutant removes lock) | — |
| B2 | Radiologist opens study; teleradiology partner also assigned it (activation overlap) | Study claim is exclusive (`reading` state holds reader id); second opener sees read-only + "being read by X" | Assert second `claim` throws | — |
| B3 | Report signed at 23:59:58, amendment at 00:00:05 next day | Versions ordered by `occurred_at`; TAT computed on first signature; daily digest counts amendment on day 2 | Fixture across IST midnight | — |
| B4 | Two techs push same study twice (retry after network blip) | Orthanc de-dupes by SOP Instance UID; `study.acquired` idempotent on StudyInstanceUID | Replay push → exactly one event | — |
| B5 | PACS receives images *before* check-in (ED trauma straight to CT) | Study with valid MWL accession but pre-checked-in: auto-check-in with `emergency_profile` and loud log; without accession → unmatched queue (A2) | Assert state jumps recorded with gate auto-waive events | — |
| B6 | Order cancelled while patient is on the table | Cancel from `in_acquisition` requires tech confirmation; if images already acquired, cancel is refused and becomes "study performed, order cancelled — bill decision" task | Assert cancellation after `study.acquired` routes to billing task | — |
| B7 | Creatinine result arrives 2 min after the gate refused contrast | Gate re-evaluates on `result.verified` for that patient; tech sees green | Event-driven re-eval test | — |
| B8 | Stroke clock: `er.arrived` missing because registration lagged | Clock starts at earliest of `er.arrived`, `er.triaged`, or the imaging order timestamp, and flags "start time inferred" | Assert derived start + flag | — |
| B9 | Amendment while WhatsApp PDF of v1 is queued but not sent | Gateway supersede: v1 message cancelled if undelivered; else v2 sent with banner | Assert `notification.failed`/cancel path | — |
| B10 | Same study reported twice by two radiologists (night handover confusion) | Second sign refused if a signed version exists — only `amend` path | Assert conflict error | — |

### C. Partial failure & downtime

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| C1 | Core HMIS down; CT must run | Modality still acquires (DICOM to Orthanc is edge-local); paper requisition with UHID sticker; Orthanc keeps studies; on recovery, unmatched-study reconciliation (A2) + backfill with `occurred_at` from DICOM `StudyDate/Time` | Backfill fixture: `occurred_at` ≠ `recorded_at`; agents do not fire on backfilled events (§11.19-C-28) | — |
| C2 | Orthanc down; core up | Modality-side local buffer (console retains studies); tech marks `study.acquisition_completed_offline` (NEW) on the tablet; radiologist reads on console; report entered against order; images pushed later and matched by accession | Assert report may be signed with `images_pending` flag and the flag clears on `study.acquired` | — |
| C3 | OHIF viewer unreachable but Orthanc fine | Fallback: Orthanc Explorer 2 or console read; `interface.down{viewer}` | Heartbeat test | — |
| C4 | Network loss between ward Wi-Fi and core during portable round | Tablet queues bedside bindings offline (SQLite), syncs later; cassette labels printed pre-round | Offline queue replay test | — |
| C5 | Power cut mid-CT scan; partial series | Partial study flagged `incomplete`; repeat exposure recorded with reason `power_failure`, dose counted twice in register, no second charge | Assert one charge line, two dose rows | — |
| C6 | MWL server (Orthanc worklist plugin) stale — modality shows yesterday's list | Worklist file regenerated on every scheduling event and every 60 s; console shows "as of" | Staleness test: schedule → worklist file contains entry within 60 s | — |
| C7 | Report signed but publish fails (gateway down) | `report.signed` persists; publish retried by worker; doctor screen shows signed report immediately (in-app never depends on gateway) | Assert in-app visibility independent of `notification.sent` | — |
| C8 | Downtime declared; Form F on paper | Paper Form F with pre-printed serial from a reserved block; backfill entry records paper serial; scan cannot close in the system until backfilled | Assert reserved serial block allocated on `downtime.declared` and reconciled on `downtime.ended` | — |
| C9 | Backup NAS full; Orthanc keeps writing to primary | Storage Forecaster T0 warns at 70/85/95%; at 95% Orthanc write path alarms to PACS admin + owner; never silently drops | Alert thresholds test | — |
| C10 | Teleradiology partner portal down at 02:00 | Fallback to in-house succession chain; `study.sent_out` auto-cancelled after timeout; SLA clock continues | Timeout test | O-1 |

### D. Money — billing, refunds, payer switches, packages, TPA

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| D1 | OPD patient pays for CT, then found unfit (creatinine high) — reschedule vs refund | Reason-coded reschedule keeps the paid charge attached to the order; refund only on cancel via credit note + refund voucher (§7) | Assert no refund event on reschedule | — |
| D2 | Contrast CT ordered, contrast not given (gate failed) — billed as plain | Charge posts from `study.acquired` payload (contrast_given=false) → tariff item swaps; the contrast vial issue, if opened, terminates on wastage cost centre | Golden fixture: plain vs contrast line; leakage triangle clean | — |
| D3 | TPA IPD patient: MRI needs pre-auth; TPA denies at 22:00 | `preauth.denied` → doctor decides: proceed self-pay (payer switch machinery `payer.switched` for the line) or defer; study never blocked for emergency class | Assert emergency priority ignores pre-auth state; routine waits in `preauth_pending` | — |
| D4 | Health-check package includes USG abdomen; patient also gets a CT the doctor added | Package line consumed for USG (`package.allowance_consumed`); CT billed outside package at applicable tariff; overrun projection shown | Fixture with package + extra | — |
| D5 | Report-blocked-until-paid (legacy harvest rule for lab) applied to imaging | Print/WhatsApp of OPD report gated on payment; in-app doctor view and critical communication are NEVER gated | Assert critical path bypasses pay-gate | O-2 |
| D6 | Repeat film due to tech error | Repeat recorded with reason; no charge; counts to repeat-rate KPI; film/plate consumption to a QA cost centre | Assert single charge | — |
| D7 | Outsourced MRI (partner centre) — who bills? | Two modes: (a) hospital bills patient, partner invoices hospital (P4) — `sendout` with cost; (b) referral out with attribution only. Mode per partner contract | Assert mode (a) produces supplier-invoice linkage; (b) produces referral only | O-3 |
| D8 | Cash > ₹2L episode aggregation on a big MRI+CT package | §11.19-C-2 269ST layer applies; PAN capture | Golden case | — |
| D9 | Discount given "because film repeated" by receptionist | Discount requires reason code + cap; repeat is free by rule, so discount attempt on a zero-charge repeat is refused | Assert no discount on repeat | — |
| D10 | PMJAY patient: CT under package code; pre-auth via TMS | Payer tag PMJAY; package mapping table; charges posted at package rate; documents bundle (report + images) exported for claim | Assert claim bundle contains signed report and study reference | — |
| D11 | CD/film charge | Configurable: first CD free with report? Corporate default: report PDF free; CD ₹100–200; film ₹150–300/sheet; MLC copies for police free | Tariff fixtures | O-4 |
| D12 | Refund of a study whose images exist | Refund on cancel only if `study.acquired` absent; else credit note requires billing-supervisor approval with reason (goodwill) | Approval fixture | — |

### E. Consent, legal, MLC, minors, unconscious, pregnancy

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| E1 | 16-year-old girl, pelvic USG, mother present | Guardian consent (DPDP §9, §11.19-D-31) + Form F (age ≥10 applicable) + chaperone; sensitive-context flag if abuse suspected routes away from guardian channel | Assert guardian authority scope checked | — |
| E2 | Unconscious trauma; contrast CT needed; no kin | Emergency two-doctor consent profile (§11.19-C-7); creatinine gate auto-waived with loud log if no result in 30 min and radiologist accepts risk | Assert waiver event carries both doctors | — |
| E3 | MLC assault: X-ray skull | `mlc.registered` flag propagates to study; report carries MLC number; images legal-hold; release only via police requisition path; radiologist may be summoned — report format court-ready | Assert legal hold applied on MLC study | — |
| E4 | Pregnancy screen: patient says not pregnant, later found 8 weeks | Screening records declaration + LMP; optional urine hCG for CT abdomen/pelvis as configurable policy; dose estimate to foetus recorded post hoc; incident, counselling task | Assert declaration evidence stored; post-hoc dose task creatable | O-5 |
| E5 | Patient refuses contrast after consent | Refusal documented (`refusal.recorded`), plain study proceeds if clinically acceptable, else reschedule | Fixture | — |
| E6 | Sex-determination request, offered money | Any staff one-tap `pcpndt.solicitation_reported` (NEW) → incident + PCPNDT in-charge; the report template lockout stands regardless | Assert lexical lockout blocks sign on "it's a boy" | — |
| E7 | Court order to produce films of a deceased patient | Legal-hold + release to court via MRD workflow; certified print with hash; `document.release_logged` | Fixture | — |
| E8 | POCSO case USG | Sealed channel rules; guardian may be the accused — sensitive-context override routes to CWC/police channel | Assert default guardian notification suppressed | — |
| E9 | Patient wants report withheld from spouse (VIP/HIV context) | Consent scope per recipient; report delivery only to patient's own verified number; family_hold | Assert family_hold respected | — |
| E10 | Foreign national / no ID for PCPNDT declaration | Form F accepts passport; illiterate → thumb + witness; fields mandatory | Validation test | — |
| E11 | Radiologist asked to change a signed MLC report by a treating doctor | Only amendment with reason; original version preserved; both versions in legal-hold | Assert immutability | — |
| E12 | Telemedicine: outside doctor requests report via WhatsApp | Release only to patient/authorised persons; doctor gets via patient share or DSR; Telemedicine Guidelines 2020 identity rules | Assert unauthorised share refused | — |

### F. Staff absence, overload, handover

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| F1 | Sole radiologist unreachable at 03:00, stroke CT acquired | Succession chain (S10 §12.16): ED physician prelim read (UNVERIFIED) + teleradiology activation if the owner has pre-authorised standby (O-1); `escalation.triggered` to duty manager at 15 min | Assert prelim path available without radiologist login | O-1 |
| F2 | Night tech alone: CT + portable request + X-ray walk-in | Worklist priority order stroke > trauma > ICU portable > ED > IPD > OPD; `overload.flagged` when queue depth > threshold; duty manager may call second tech | Priority sort test | — |
| F3 | Shift handover: 14 unread studies | Handover screen lists unread + open criticals + pending Form F; `handover.recorded` (reuse nursing event if exists, else NEW) | Assert unread list at handover equals worklist count | — |
| F4 | Sonologist on leave; only non-registered radiologist available | Obstetric USG on that machine is refused for that person (PCPNDT gate on person registration); OPD rebooking cascade | Assert person-registration gate | — |
| F5 | Radiologist signs 200 reports in 20 minutes (batch-sign) | Time-in-draft instrumentation (§11.19-D-36) flags; QA sample; not punitive | Anomaly report row exists | — |
| F6 | Tech's TLD badge lost | `badge.lost` (NEW) → estimated dose task for RSO; replacement issued; AERB notification if required | Fixture | — |

### G. Equipment failure

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| G1 | CT tube fails Monday 09:00 with 22 booked | Device → `down`; rebooking cascade (§11.7): patients notified in language, offered slot on other modality/partner, one-tap reschedule; ED stroke pathway diverts to partner CT with ambulance task | Assert cascade generates notifications + tasks for all 22 | — |
| G2 | Daily QA fails on mammography (phantom) | `qa_blocked`; MWL refuses; screening bookings shift | Assert MWL exclusion of blocked device | — |
| G3 | MRI quench / helium alert | Device `down` + safety incident; zone IV lockout task; vendor call task with AMC SLA | Fixture | — |
| G4 | Contrast injector fault mid-injection | Manual push documented; volume actually delivered recorded; incident if extravasation | Assert delivered ≠ planned recorded | — |
| G5 | Dry printer out of film at night | Film stock is P3 with par level; report PDF + WhatsApp is the primary; film printed next day; `stock.below_reorder` | Assert publish not blocked by print | — |
| G6 | PACS disk failure (RAID degraded) | Monitoring → PACS admin; Orthanc read-only mode if needed; nightly NAS sync verified by restore drill | Drill evidence event | — |
| G7 | USG probe damaged (image quality) | Tech flags device `maintenance`; studies done on it in last N hours flagged for QA review | Fixture | — |

### H. Data quality, late-arriving, backdated

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| H1 | DICOM patient name spelled differently from HMIS | Matching on accession (MWL) primary; name mismatch only warns; without MWL, fuzzy match → human queue, never auto-link (Plan 09 I3 precedent) | Assert no auto-link on fuzzy | — |
| H2 | Modality clock 40 min off | `StudyTime` vs `study.acquired` recorded drift logged; NTP check task; TAT uses HMIS time, dose register keeps DICOM time with drift note | Drift detection test | — |
| H3 | Report dictated on paper during downtime, typed next day | `occurred_at` = signing on paper time, `recorded_at` = entry; scan of signed paper attached; report marked "transcribed from paper, original attached" | Backfill fixture | — |
| H4 | Old films from 2019 brought for comparison | `imaging_outside_studies` import (scanned or DICOM CD via Orthanc import) tagged external, never counted in TAT/KPI | Assert KPI exclusion | — |
| H5 | Creatinine from outside lab on paper | Manual entry with source=external, image of report attached; gate accepts with "external" flag visible to radiologist | Fixture | — |
| H6 | Structured field (BI-RADS) missing on signed mammo report | Template makes category mandatory before sign for screening types | Validation test | — |
| H7 | Height/weight absent for paediatric CT dose protocol | Gate nudges tech to enter; dose register stores with body-size band | Fixture | — |
| H8 | Form F filled after scan closed (paper backlog) | Impossible in-system (cannot-close); backfilled downtime Form F carries paper serial + downtime id | Assert refusal | — |

### I. Fraud, leakage, gaming

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| I1 | Study done, never billed (ED rush) | Leakage Auditor triangle: `study.acquired` without `charge.posted` in 24 h → variance row | Triangle fixture | — |
| I2 | Contrast vials issued 30, administered 22 | P3 issued-vs-consumed vs multi-dose wastage; excess → variance | Fixture | — |
| I3 | Receptionist "cash-only" outside-referral USG not entered, done off-book | Every exposure/scan creates a DICOM study; Orthanc studies without HMIS order = unmatched queue → Leakage Auditor; USG machine count vs Form F count vs orders reconciled monthly | Assert unmatched-study count in digest | — |
| I4 | Doctor self-referral gaming on CT orders | Referral pattern report (S10 §12.10) with ordering-rate normalised by case mix; diagnostic | Report exists | — |
| I5 | Radiologist reports outside studies for cash using hospital PACS | Outside-study import requires order/consult encounter and charge; import without encounter refused | Assert | — |
| I6 | Form F serials skipped to hide scans | Serial gap-free per machine-year; a gap is an anomaly with a disposition workflow (reviewer: MS, §11.19-E-18) | Gap detection test | — |
| I7 | TAT KPI gamed by signing "no significant abnormality" fast then amending | Amendment rate paired KPI; amendments within 24 h of sign flagged; edit-distance on Drafter drafts | KPI gaming check exists | — |
| I8 | Film/CD stock walking out | P3 par + issue against study id; CDs without a release log → variance | Fixture | — |
| I9 | Repeat exposures hidden as new studies to bill twice | Same patient + same study type + same day → duplicate-charge rule; second is repeat unless doctor re-orders with reason | Assert duplicate blocked | — |
| I10 | Teleradiology partner bills for studies not returned | `sendout` reconciliation: partner invoice lines must match `study.external_reported` | Three-way match | — |

### J. Privacy, sealed records, VIP, staff-as-patient

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| J1 | Staff nurse's own pelvic USG | Confidential record (§14); alias on worklist display and modality display; Form F still real name (statutory) but sealed | Assert worklist shows alias; Form F row sealed class | — |
| J2 | VIP CT: 40 staff open the images | Access-vs-care-relationship report (§11.19-E-29); OHIF access evented per study open; sealed VIP requires treating-team membership | Assert `image.viewed` (NEW) evented with actor; unauthorised open refused | — |
| J3 | Images shared to a personal WhatsApp by a tech (screenshot) | Cannot be technically prevented; watermark overlays (identity of viewer) on every viewer render; export governance (§11.19-E-28); policy + training | Assert watermark present in viewer render | — |
| J4 | Patient DSR: "give me all my images" | DICOM export (CD/USB or DICOMweb link) via WF-IMG-09; statutory TAT; logged | Fixture | — |
| J5 | Teleradiology sees names | DPA + tokenisation level per partner (WF-IMG-10); DICOM header de-identification (PatientName→token, keep age/sex, accession as link) | De-id test on header | — |
| J6 | ABDM care-context for a sealed PCPNDT study | Link-suppression attribute (§11.19-E-30) honoured; obstetric USG report shared only with explicit consent | Assert suppression | — |
| J7 | Public display announces "Sunita — USG pregnancy" | Displays announce tokens only (§11.5) | UI test | — |

### K. Language, literacy, accessibility

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| K1 | Bhojpuri-speaking patient; fasting prep for CT abdomen | Prep template in Hindi text + IVR/voice note option; pictorial fasting card printed with QR; navigation duty (S10 §12.22) | Template language fallback test (Bhojpuri → Hindi) | — |
| K2 | Illiterate patient's Form F declaration | Thumb impression + witness name; read-out script in Hindi; recorded who read it | Validation | — |
| K3 | Deaf patient in MRI (needs breath-hold instructions) | Pre-scan flag "communication needs"; visual cue cards; longer slot | Slot duration rule | — |
| K4 | Report in English; patient wants Hindi summary | Patient-facing summary lane (T2 draft, plain language, "not a medical report" banner) in patient language — later phase | Assert banner + provenance | O-6 |
| K5 | Wheelchair/stretcher patient at MRI with zone screening | Transport task includes ferromagnetic check of trolley; MRI-safe wheelchair resource | Task template test | — |

### L. Scale (100/day → 2,000/day)

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| L1 | 300 studies/day, 60 GB/day into Orthanc on the single VM | PACS on its own volume day one; object-storage plugin / tiering at stage 2; Storage Forecaster projects 90-day fill | Forecast test | O-9 |
| L2 | Worklist of 400 unread across 6 radiologists | Sub-specialty/ modality routing rules; claim-based assignment; load-normalised KPIs | Routing fixture | — |
| L3 | Ten modalities pushing simultaneously | Orthanc concurrency + PostgreSQL index plugin; DICOM C-STORE queue never touches core DB | Perf budget test (edge) | — |
| L4 | Second site / satellite USG centre | `site_id` on every table from day one (Plan 13 DD3); PCPNDT registration is per site | Assert site scoping | — |
| L5 | Cross-site teleradiology inside the group | Same send-out mechanics, no DPA needed intra-entity but access still evented | Fixture | — |

### M. Integration failures (device / vendor / ABDM)

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| M1 | USG machine has no DICOM (older portable) | Study record without images (tech attaches photos/prints via tablet camera → PDF in DocumentReference); Form F still gated | Assert study can complete without DICOM but flagged `no_pacs_images` | — |
| M2 | Modality cannot query MWL (no licence for worklist) | Manual entry at console with barcode of accession from printed requisition; reconciliation by accession text | Fixture | — |
| M3 | Orthanc rejects study (bad transfer syntax) | Edge logs + `interface.error` (NEW) to PACS admin; tech notified at console within 5 min | Alert test | — |
| M4 | Dose report SR not sent by CT | Manual dose entry field mandatory before study close for ionising modalities when SR absent | Validation | — |
| M5 | Vendor remote support session into CT console | `vendor_access.logged` (§11.19-E-2); time-boxed; no PHI export | Fixture | — |
| M6 | ABDM care-context push fails | Retry ladder; never blocks publish | Assert publish independent | — |
| M7 | Teleradiology returns PDF only, no structured fields | Structured extractor (T2) drafts fields; countersign required | Assert extracted fields carry provenance | — |
| M8 | LINAC R&V vendor cannot export fraction events | Data-export mandate governs selection (§11.19-A); fallback = manual per-fraction entry task by RT tech with daily reconciliation | Fixture | O-10 |
| M9 | Echo machine pushes to Orthanc; no radiology order | Cardiology-owned order type; Orthanc routing by modality/AE title to cardiology worklist; not radiology's unread list | Routing test | — |

### N. PCPNDT-specific

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| N1 | Obstetric follow-up growth scan (3rd visit): does she need a new Form F? | Yes — Rule 9: every scan on a pregnant woman gets its own Form F; system pre-fills from the previous one (A–D sections) to make it 60 seconds | Assert pre-fill + new serial | — |
| N2 | Emergency USG for suspected ectopic at 02:00, sonologist on phone, ED doctor scans | Form F cannot-close stands; ED doctor must be a registered person on the facility's PCPNDT registration or the scan is refused — corporate practice: register all doctors who may scan; emergency does NOT waive PCPNDT | Assert no emergency bypass exists for form_f gate | RULED by spec (§11.16-A) — extend only |
| N3 | Portable USG taken to ICU for a pregnant patient | Portable is a registered machine (§11.19-C-6); Form F applies | Assert portable device registration check | — |
| N4 | Machine sold/relocated | Device decommission requires Form for transfer to Appropriate Authority; registry status `decommissioned`; serial block closed | Fixture | — |
| N5 | Inspection: AA demands last 3 months' Form F, register, machine list, sonologist certificates | Inspection persona (§11.19-E-20) with certified-format prints; `inspection.visit_logged`; directions → tasks | Print fixture per prescribed format | — |
| N6 | Monthly return not filed by the 5th | Compliance calendar `statutory_return.due` escalates to quality manager, then owner | Ladder test | — |
| N7 | Registration certificate expiry (5-yearly renewal) | `license.expiring` at 90/60/30 days; at expiry: all USG on that registration blocked except when the owner records a filed-renewal acknowledgement | Assert block on expiry | O-7 |
| N8 | Referring doctor's slip missing (self-walk-in pregnant woman) | Form F allows self-referral with indication; the sonologist records indication; flagged for PCPNDT in-charge review | Fixture | — |
| N9 | Sex mentioned in a *non-obstetric* report ("male foetus" in a CT trauma of a pregnant woman) | Lexical lockout applies to all report templates when patient is pregnant-flagged | Assert | — |
| N10 | Register in electronic form — legal? | §19 E-21 electronic-register legality per act; until counsel confirms, print-and-bind monthly with hash footer | Print+hash fixture | §19 gate |

### O. Radiation safety (AERB)

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| O1 | Tech's quarterly TLD read exceeds investigation level | `dose.limit_warning`; RSO investigation task; duty reassignment suggestion (non-punitive) | Ladder test | — |
| O2 | Pregnant radiographer declares pregnancy | Roster gate: no fluoroscopy/portable duty; foetal dose limit tracked | Roster validation test | — |
| O3 | CT installed before eLORA licence issued | Device cannot leave `commissioning` status without licence record; MWL refuses | Assert | — |
| O4 | Cumulative patient dose (young patient, 6 CTs in a year) | Dose register cumulative per patient surfaces to radiologist at protocolling; nudge, not block | Assert nudge event | — |
| O5 | Room shielding survey overdue after renovation | Compliance calendar task; RSO sign-off | Fixture | — |
| O6 | RT: brachy source movement | `source.moved` (NEW) with two-person custody (physicist + RSO); AERB register row | SoD test | — |
| O7 | RT: LINAC daily QA fails | Machine `qa_blocked` in registry; fractions for the day rescheduled; missed-fraction recall | Assert block | — |

### P. Clinical safety gates (contrast, pregnancy, MRI)

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| P1 | eGFR 28, urgent CT angiogram for PE | Gate refuses → radiologist override with reason (benefit>risk), hydration plan task, nephrology alert; override evented | Assert override approval object | — |
| P2 | Prior contrast reaction on allergy list | Hard warning; premedication protocol task 12 h/2 h; or non-contrast alternative; radiologist decides | Assert warning fires from patient master allergy | — |
| P3 | Metformin user, contrast given | Advisory to hold 48 h post; discharge instruction in language | Template test | — |
| P4 | Gadolinium with eGFR <30 | Block unless override; group II agents preferred flag | Assert | — |
| P5 | MRI: patient with unknown implant | Questionnaire mandatory; unknown → X-ray screen or refuse; zone entry log | Validation | — |
| P6 | Paediatric MRI under sedation | Anaesthetist presence gate, monitoring, recovery bay (mini-OT/registry bed) | Gate test | — |
| P7 | Extravasation of 80 ml contrast | Incident + plastic surgery consult task + follow-up call at 24 h | Ladder | — |
| P8 | Breastfeeding mother, iodinated contrast | Advisory (no interruption needed per current guidance) captured as counselling | Template | — |
| P9 | Woman of reproductive age, "10-day rule" for pelvic X-ray | Pregnancy screen with LMP; policy configurable | Rule fixture | O-5 |
| P10 | Wrong protocol (non-contrast when contrast was needed) — rescan | Repeat with reason `protocol_error`, no charge, dose double-counted, QA row | Assert | — |

**Row count: 120.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Bus crash, 18 casualties, 21:40 Saturday.** `disaster.declared` by ED. 21:42 the imaging worklist flips to disaster profile: all OPD bookings for tonight auto-shift with WhatsApp; X-ray + CT become ED-only; MWL entries created from ED temp UHIDs ("Unknown-M-03") as triage happens. Tech 1 runs CT, tech 2 portable in ED bays; the emergency gate profile auto-waives pregnancy/creatinine with loud logs (E2), identity stays (wristband at ED registration). Radiologist reads on the ED workstation; residents/ED doctors post prelims (UNVERIFIED) so surgeons move; every prelim later superseded by a signed version — the trail shows who acted on which version. Orthanc absorbs 18 whole-body CTs (~10 GB) in an hour; Storage Forecaster is silent (headroom). MLC flags on all 18 propagate; police copies queued at MRD. Paper: pre-printed trauma requisition pads with sticker UHIDs; cassettes labelled at bedside. Backfill: at 03:00 unmatched-study queue shows 3 studies pushed before check-in — receptionist matches by accession sticker; `occurred_at` from DICOM. Audit: `disaster.declared` → per-study gate waivers → prelims → signatures → MLC holds, all correlated by encounter.

**6.2 Core server down 10:30 Monday, CT and USG queue of 40.** Downtime declared (kit). Modalities keep acquiring (edge-local); receptionist works the printed day-list and issues reserved Form-F paper serials (C8) for obstetric scans; sonologist fills paper Form F. Radiologist reads at the console / Orthanc Explorer; dictates; signed paper reports go to patients with a "system copy follows" stamp. 12:10 core back: worker replays; tech enters 40 studies from the day-list with `occurred_at`; Form Fs backfilled with paper serials; reports transcribed with paper originals scanned (H3). Agents stay quiet on backfilled events (§11.19-C-28). The next-day digest shows 40 backfills, 0 gaps in Form-F serials, 2 reports still awaiting transcription.

**6.3 Sole radiologist no-show, 08:00 Tuesday; 60 studies unread; stroke arrives 09:10.** Succession chain fires at 08:15 (`bench.gap_flagged` + escalation): duty manager calls the chain; teleradiology standby activated if pre-authorised (O-1) — `study.sent_out` for all CT/MRI; X-rays wait for the afternoon locum. 09:10 stroke: door-to-CT 18 min; ED physician prelim (UNVERIFIED) at 09:35; telerad final at 09:52; thrombolysis decision at 09:55 — the clock report shows every stamp. Paper: none needed. Audit: `escalation.triggered` ×3, `temp_role.granted` for the locum, `study.external_reported` ×31, no unsigned prelim left by 18:00 (Unread-Study Watchman closes the loop).

**6.4 CT tube dies 09:00 Monday with 22 booked (incl. 3 TPA pre-authorised).** Device `down` (G1); cascade: 22 WhatsApps in each patient's language with one-tap reschedule; 5 divert to partner CT (D7 mode a) with transport tasks; TPA pre-auths carry over (pre-auth object references the order, not the machine); 2 IPD patients rescheduled to tomorrow with ward notified; 1 ED patient ambulanced to partner with an escort task. Vendor AMC call logged with SLA. Revenue impact appears in the 8 a.m. digest tomorrow. Audit: `resource.status_changed` → 22 `appointment.rescheduled`/`study.sent_out` → vendor task.

**6.5 Power + network loss, 14:00, portable round on ICU.** UPS holds core 20 min; ward Wi-Fi dead. Tech's tablet has the round list cached; bedside bindings queue offline (C4); portable X-ray runs on battery; DR plates hold images. Generator up 14:12; sync replays 6 bindings; PACS receives 6 studies matched by cassette-binding ids. One ICU patient was pregnant (flag cached on tablet) — the gate fired offline, evidence synced. Audit shows `occurred_at` 14:03–14:10, `recorded_at` 14:14.

**6.6 VIP + MLC + fraud attempt, same hour.** 16:00 a state minister's relative (VIP) gets an MRI — alias on worklist, treating-team-only image access, 3 unauthorised opens refused and evented (J2). 16:20 an assault MLC X-ray — legal hold, police copy path. 16:40 a receptionist tries to register a cash USG for a pregnant walk-in "without entry" — the USG machine's DICOM push creates an unmatched study (I3) and the Form-F serial the sonologist must use is system-issued only; the sonologist refuses to scan without an order; the attempt surfaces as an unmatched-study + solicitation report to the MS. Audit: three separate correlation ids; the anomaly disposition workflow closes each with a reviewer.

**6.7 PCPNDT inspection walks in unannounced, 11:00.** Inspection persona granted for 4 hours (§11.19-E-20); certified prints of Form F for the requested months with hash footer, machine list with registration certificates, sonologist certificates from the credential registry, the display-board photo evidence, and the last 6 monthly returns with acknowledgements. Two directions issued → tasks with closure SLA. `inspection.visit_logged`. Nothing is compiled by hand.

**6.8 Ransomware on the PACS admin's laptop reaches a mapped share.** Orthanc's storage is not a mapped share (design); nightly NAS sync is pull-based; weekly offsite immutable. Security incident declared; CERT-In 6 h + DPDP Board notification path (§11.19-C-4); PACS isolated, restore drill runbook executed; images acquired during isolation buffered at modalities. Audit: `security_incident.declared`, restore evidence.

---

## 7. Compliance, audit & statutory surfaces

| Statute / standard | What it demands | Where it lives here |
|---|---|---|
| **PCPNDT Act 1994 + Rules 1996 (as amended)** | Registration of facility, every USG machine, every sonologist; Form F per scan on a pregnant woman; register; monthly return by the 5th; records ≥2 y; no sex disclosure; display board; sale/transfer only to registered; seal/seizure powers of the AA | `pcpndt_registrations`, `pcpndt_form_f` (sealed class), `pcpndt_returns`, `pcpndt_inspections`; cannot-close gate; lexical lockouts; certified prints |
| **Atomic Energy (Radiation Protection) Rules 2004; AERB safety codes for diagnostic X-ray (AERB/RF-MED/SC-3), RT, and eLORA** | Licence per equipment, layout approval, RSO, TLD monitoring, dose limits (20 mSv/y avg over 5 y; 30 mSv single), periodic QA, decommissioning, incident reporting | `aerb_licences`, `tld_badge_reads`, `radiation_dose_register`, `modality_qa_logs`; compliance calendar |
| **Clinical Establishments Act / state rules** | Registered establishment; displayed tariffs; records | tariff auto-publication (§11.19-B) |
| **DPDP Act 2023** | Notice/consent, purpose limitation, DSR rights, breach notification, processor agreements (teleradiology, PACS vendor, cloud) | consent artefacts, `image_releases`, tokenisation on send-out, DPIA per agent, access evented |
| **MTP Act** (boundary) | Gestation evidence via USG feeds the mini-OT MTP register | study reference only; MTP register owned by Plan 15 |
| **MLC / CrPC / BNSS** | Preservation, chain of custody, court production | legal hold, certified prints, release log |
| **POCSO, Telemedicine Guidelines 2020, Transplantation Act (donor imaging)** | Sealed-channel, identity rules, donor workup evidence | flags + consent scope |
| **NABH (5th ed.) AAC/COP/MOM/IMS chapters** | TAT monitoring, critical results, imaging safety programme, QA, equipment calibration, privacy, consent, incident reporting, radiation safety training | KPI registry, `critical_findings`, QA logs, credential registry |
| **Drugs & Cosmetics Act** | Contrast media batch traceability, ADR (PvPI) | pharmacy batch on `contrast_administrations`; `adr.reported` |
| **BMW Rules 2016** | Films/fixer (CR era), contrast sharps | Plan 19 chain |
| **GST** | Diagnostic services exemption boundary (health-care services exempt; CD/film sale taxable?) | tariff engine; CA confirmation (§19) |

**Registers as first-class tables:** Form F register · USG machine register · sonologist register · monthly return register · inspection register · AERB licence register · TLD badge register · patient dose register · QA register · contrast/ADR register · critical-findings communication register · image-release register · outside-films register · teleradiology send-out register · repeat/reject register.

**Who signs:** report — consultant radiologist (2FA); Form F — sonologist who scanned; monthly return — PCPNDT in-charge (SoD from scanner); AERB submissions — RSO + licensee (owner); consent — patient/guardian + witness; release — release desk + verified receiver.

**What NABH asks to see:** TAT by modality with breaches and actions; critical-result log with read-back; repeat-rate; QA/calibration records; radiation safety programme (badges, training, signage, pregnancy policy); consent forms; privacy/chaperone; incident register incl. contrast reactions; equipment AMC. **What the PCPNDT AA demands:** N5. **What the AERB inspector demands:** licences, RSO approval, TLD records, QA reports, room survey, dose registers, signage, decommissioned-equipment records.

**DPDP data classes:** Class S (sealed): PCPNDT Form F, POCSO, HIV-context, VIP/staff aliases · Class C (clinical PHI): images, reports, dose · Class F (financial) · Class O (operational: TAT, roster) · Class A (AI draft trail — QA material).

---

## 8. Staff KPI & KRA

All event-derived, load-normalised, diagnostic never punitive (S10 §2). Target home = KPI formula registry (metric id + formula + semver).

**Radiologist (card 15)** — `rad.tat.p50/p90 by modality+priority` = `report.signed.occurred_at − study.acquired.occurred_at`, normalised by studies/shift and case mix (CT/MRI weight 3, X-ray 1) · `rad.critical.comms_compliance` = criticals with `result.acknowledged` within category SLA ÷ criticals flagged · `rad.amend.rate` = `report.amended` ÷ `report.signed` (30-day window; amendments within 24 h separately) · `rad.unread.eod` = studies in `awaiting_read` at 20:00 · `rad.prelim.discrepancy` = major discrepancy between prelim and final (structured field) ÷ prelims countersigned · `rad.draft.edit_distance` (the *agent's* KPI, shown on the agent card, never the doctor's) · `rad.formf.completeness` = Form F signed before close ÷ applicable scans (must be 100% structurally; any <100% is a downtime backfill count) · `rad.peer_review.sampled` (RADPEER-style monthly sample). **KRA:** every study read; every critical provably communicated; PCPNDT accountability; protocolling; teaching prelim-readers. **Gaming vectors:** fast-sign-then-amend (paired amend KPI), cherry-picking easy studies (case-mix normalisation + claim-order audit), marking non-critical to avoid comms burden (QA sample of "no critical" reports with critical keywords).

**Imaging Technician (card 18)** — `tech.acq_to_pacs_lag.p90` = `study.acquired − study.acquisition_started` · `tech.repeat_rate` = repeats ÷ exposures, by reason · `tech.gate_compliance` = studies with all gates evaluated before `in_acquisition` ÷ studies (must be 100%; overrides counted separately) · `tech.modality_utilisation` = in_use minutes ÷ available minutes per device · `tech.portable_sla` = ICU portable within 30 min · `tech.dose_index_vs_DRL` = studies above DRL ÷ ionising studies · `tech.unmatched_studies` = per shift · `tech.badge_return_on_time`. **KRA:** right study, right patient, right gate, first time; PACS integrity; dose entry. **Gaming:** hiding repeats as new studies (I9 rule), skipping gate by "override" (override count per tech is a diagnostic).

**Receptionist/Scheduler (NEW-R1)** — `sched.wait.walkin_xray.p90` (patient-facing ⚠) · `sched.slot_fill_rate` · `sched.no_show_rate` (normalised by prep-reminder delivery) · `sched.preauth_lead_time` · `sched.reschedule_cascade_closure` (G1) · `sched.release_desk_tat` · `sched.prep_reminder_delivery`. **KRA:** no idle modality while a queue exists; every patient prepped; every pre-auth chased. **Gaming:** overbooking to inflate fill (paired wait KPI).

**Radiology Nurse (NEW-R2)** — `nurse.contrast.observation_compliance` · `nurse.reaction_documentation` (100%) · `nurse.kit_check_task_closure` · `nurse.chaperone_present_rate`. **KRA:** safe contrast, safe sedation, chaperone.

**RSO (NEW-R3)** — `rso.badge_read_timeliness` · `rso.licence_currency` (0 expired) · `rso.qa_on_time` · `rso.investigations_closed_sla` · `rso.training_coverage`. **KRA:** the department is legally allowed to switch on every machine every day.

**PACS Admin (NEW-R5)** — `pacs.uptime` · `pacs.interface_down_minutes` · `pacs.storage_headroom_days` · `pacs.restore_drill_pass` · `pacs.unmatched_backlog`.

**Teleradiology partner (persona)** — `telerad.sla_compliance` · `telerad.discrepancy_rate` on QA sample · `telerad.invoice_match_rate`.

**Owner's 8 a.m. digest (radiology block):** studies yesterday by modality vs 7-day avg · TAT p90 by modality with breaches · unread at 08:00 · criticals flagged/closed/open · Form F: applicable vs recorded (must be equal; backfills count) · unmatched studies · modality downtime minutes · repeat rate · contrast reactions · revenue by modality and payer, with leakage variance · storage headroom days · licence/badge items due in 30 days · teleradiology send-outs and cost.

---

## 9. AI agents & the copilot — where inference earns its place

| Name | Type · Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval / guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|
| **Radiology Report Drafter** (§16 roster) | agent · **T2** | `study.acquired` + radiologist opens; inputs: tokenised order indication, study type, structured priors (previous impression lines), template sections, *optionally* tech notes; **no pixel analysis in v1** (text-side drafter; image-AI is a separate bought product later, O-8) | Draft narrative in the doctor's template + structured fields pre-filled from order; typed claims cite fact-sheet lines (copilot §2.4) | Consultant signs (2FA); edit distance recorded | Blank template; dictation/scribe path (S10 §12.24) | per-agent; global halt | model id, prompt version, input/output hash in `report.drafted` and in signed doc | PCPNDT lexicon applied to draft; citation guard; adversarial fixtures (instruction-shaped indications); shadow mode after DPIA | C (tokenised) | 18b (PACS phase) |
| Structured Report Extractor | agent · T2 | teleradiology PDF / outside report | structured fields draft | countersign | manual entry | per-agent | yes | fixture PDFs | C | 18b |
| Protocol Suggester | agent · T2 | order indication + priors + allergy + eGFR | suggested protocol (contrast y/n, phases) | radiologist protocols | default protocol per study type | per-agent | yes | rules-first; model only for free-text indications | C | later |
| Slot Optimiser | agent · T3 | queue, device status, no-show history, prep state | proposed slot moves | receptionist approves batch | manual slotting | per-agent | n/a | fairness: payer-blind, VIP-blind (§11.19-D-37) | O | later |
| Patient-language summary | agent · T2 | signed report (tokenised) | plain-language Hindi summary with banner | radiologist approves release | none (report PDF only) | per-agent | yes | no new medical claims (entailment fixtures) | C | later, O-6 |
| Prep & Recall Reminder | automation · T1 | `study.scheduled`, no-show, follow-up advised (yellow) | WhatsApp/SMS ladder in language | none | receptionist call list | harness | n/a | template-only | C-min | 18a |
| Critical-Finding Chaser | automation · T1 | `result.critical_flagged` without ack | nudges + ladder (§11.5) | none | phone tree printed | harness | n/a | — | C | 18a |
| Unread-Study Watchman | automation · T1 | `awaiting_read` age > SLA | worklist nudge, succession escalation | none | handover sheet | harness | n/a | — | O | 18a |
| PCPNDT Return Compiler | automation · T2 (draft doc) | month end | consolidated return draft + gap report | PCPNDT in-charge verifies & files | manual compile from register | harness | n/a | gap-free serial check | S | 18a |
| Dose & Badge Watchman | automation · T1 | badge reads, licence dates, QA due | tasks + warnings | RSO | calendar on paper | harness | n/a | — | O | 18c |
| Order Appropriateness Nudger | rules · T1 | order placed | "duplicate CT within 30 d", "MRI before X-ray for LBP", cumulative dose | ordering doctor may proceed | none | harness | n/a | rule registry versioned | C | 18a |
| Storage Forecaster | automation · T0 | Orthanc metrics | headroom days, tier moves proposed | PACS admin | df -h | harness | n/a | — | O | 18b |
| Form-F Gatekeeper, Wrong-Side Guard, Lexical Lockout | **deterministic workflow rules, not agents** | — | refuse transition | — | — | not killable (statutory) | — | — | — | 18a |

**Prompt inputs made concrete (Drafter):** `{study_type, laterality, indication_text(scrubbed), clinical_question, age_band, sex, prior_impressions[≤3, line-ids], allergy_flags, contrast_given, template_sections[], structured_fields_required[], tech_notes(scrubbed)}` → output `{sections: {name, text, cited_line_ids[]}, structured: {field, value, cited}}`; anything uncited is dropped by the renderer; lockout lexicon runs on output; no image data.

**Three presentation lanes:** Lane 1 hand-built: tech console companion (MWL + gates, tablet), radiologist reading worklist + report editor (keyboard-first, template hotkeys, dictation), reception scheduling board, release desk. Lane 2 schema-generated: QA logs, badge reads, licence register, inspection tasks, send-out register, outside-films import, contrast kit checks, repeat/reject log. Lane 3 conversational (after ops-role pilots, clinical last): "show me unread CTs older than 2 h", "reschedule tomorrow's MRI list to Thursday" (propose→confirm), "draft the PCPNDT return for July".

**Journey Feed contributions:** `study.scheduled` (with prep sent), `study.acquired` (thumbnail link, OHIF deep link under RBAC), `report.signed`/`result.published` (impression line), `result.critical_flagged`→`acknowledged`, `report.amended` (banner), `form_f.recorded` (sealed — visible as "statutory form recorded" only to authorised roles), contrast reaction, image release.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context:** QR on requisition/appointment slip → console MWL row selected, gates displayed; wristband on wards; accession barcode on cassettes.
- **DICOM Modality Worklist from day one of PACS (18b):** kills demographic retyping at consoles (the #1 wrong-patient vector); until then, printed accession barcodes + console barcode entry.
- **Template hotkeys + doctor-wise templates:** normal templates by study type, sectioned; "normal study" macro; structured pick-lists (BI-RADS, TI-RADS, LI-RADS, foetal biometry auto-computed GA/EFW); dictation-to-text lane (S10 §12.24) with on-prem/whisper-class STT if the DPIA allows.
- **TAT clocks on the worklist** (colour by SLA state; stroke/trauma countdowns); ED board mirrors.
- **Prep automation:** fasting/meds hold/arrive-before in patient language with IVR fallback; reduces unfit-at-desk reschedules.
- **Gate evidence auto-pulled:** creatinine from LIMS, LMP/pregnancy from OPD vitals, allergies from master, implants from patient master — tech confirms rather than collects.
- **Tablet at bedside for portables**, offline-capable; printed requisition pads for downtime.
- **Print as design surface:** report PDF with header block, QR verify link, signature/degree block, amendment banner; film print layer identical.
- **Keyboard-first scheduling board** with device columns and drag-to-reschedule (propose→confirm).
- **Measured targets (recommended):** walk-in X-ray wait p90 ≤20 min; acquisition-to-PACS p90 ≤15 min; ED CT TAT p90 ≤60 min; OPD routine ≤24 h; door-to-CT ≤25 min; unread at 08:00 = 0 stat; repeat rate <3%; gate evaluation 100%; Form F structural 100%; report amendment <2%; critical comms 100% within SLA; unmatched-study backlog 0 at day end; PACS uptime 99.9%; restore drill monthly pass.

---

## 11. Integrations, devices & dependencies

| Device / vendor | Protocol | Edge-service rule |
|---|---|---|
| DR/CR X-ray (e.g., Siemens Multix, GE Definium, Allengers, Skanray, Carestream CR) | DICOM C-STORE → Orthanc; MWL C-FIND; MPPS optional; RDSR for dose | Orthanc is the edge; core stores references |
| CT (GE/Siemens/Philips 16–128 slice) | DICOM, MWL, RDSR (dose SR) | as above; dose SR parsed by a small Orthanc Python/Lua hook → `dose.recorded` (NEW) |
| MRI (in-house or partner) | DICOM; partner via DICOMweb/STOW or CD | send-out register |
| USG (Samsung, GE Voluson, Mindray, Philips; portables) | DICOM (most), some none (M1) | MWL where supported; PCPNDT machine register must match AE titles |
| Mammography + tomosynthesis | DICOM, needs 5 MP monitors | |
| Contrast injector (Medrad/Ulrich) | often none; manual entry; some CAN/DICOM | manual |
| Diagnostic monitors (Barco/EIZO), dry printers (Fuji/Agfa/Carestream), CD robot (Epson/Rimage) | print via DICOM print or PDF | |
| **Orthanc** | plugins: PostgreSQL index, DICOMweb, worklist (MWL), OHIF, object storage (S3) for tiering, authorization plugin bridged to HMIS RBAC (per-study access tokens, evented as `image.viewed`), Python for hooks | own container + volume; heartbeats (§11.18) |
| **OHIF** | embedded viewer, DICOMweb to Orthanc, HMIS-issued short-lived tokens; watermark overlay with viewer identity | |
| Teleradiology partners (Teleradiology Solutions, 5C Network, Synapsica, others) | DICOMweb/STOW push or their gateway; report return API/PDF | send-out register; DPA |
| LIMS (Plan 17) | internal event: `result.verified` (creatinine, hCG) | |
| LINAC R&V/TPS (Varian ARIA / Elekta MOSAIQ) | HL7 v2 ORU/SIU or vendor API for fraction events; DICOM RT objects to PACS (RT-STRUCT/PLAN/DOSE) | export mandate governs selection; HMIS keeps AERB registers and billing |
| Cath lab (Plan cath-lab) | DICOM XA to Orthanc; dose via RDSR | dose register rows |
| ABDM | FHIR `DiagnosticReport` + `ImagingStudy` care-context (later) | link suppression for sealed |
| NHCX/TPA | pre-auth object (billing) | |

**Dependencies:** Plan 13 registry (rooms/devices) · Plan 14 procurement (contrast, films, AMC) · Plan 15 (Form F table shared; chaperone) · Plan 16 pharmacy (contrast issue/batch) · Plan 17 LIMS (creatinine gate, shared P2 order envelope) · Plan 10 gateway (prep, results, criticals) · Plan 12a runtime (Drafter) · Plan 11b hybrid deployment (PACS storage on-prem) · quality pack (incident/ADR) · MRD (release, legal hold) · ED module (clocks) · TPA phase (pre-auth).

**Events consumed:** `order.placed{imaging}`, `patient.checked_in`, `result.verified`, `allergy.recorded`, `preauth.*`, `payment.received`, `mlc.registered`, `disaster.declared`, `downtime.declared/.ended`, `resource.status_changed`, `roster.published`, `er.arrived/.triaged`, `stroke.suspected`(NEW, ED), `trauma.activated`(NEW, ED), `patient.merged/.unmerged`, `legal_hold.applied`.

---

## 12. Buy vs build, hardware & rough INR budget

**Buy:** Orthanc (free, support contract optional ~₹1–2L/y from an Indian integrator) · OHIF (free) · modalities (capex outside this budget: DR X-ray ₹35–60L, 16-slice CT ₹2.5–4 cr, 64+ ₹4–8 cr, 1.5T MRI ₹6–10 cr, mammo ₹80L–1.5 cr, USG ₹15–60L) · dictation/STT engine (on-prem whisper-class, or under DPA) · image-AI products later (chest X-ray triage, stroke ASPECTS/LVO — bought, T1/T2 nudges only; O-8) · teleradiology service (₹150–400/CT-MRI read night rates, market) · TLD service (AERB-accredited labs, ~₹300–500/badge/quarter) · AMC/CMC.

**Build:** the radiology module (orders, scheduling view, gates, worklist, report editor + templates, versions, criticals, PCPNDT/AERB registers, send-out, release, dose parse, Orthanc RBAC bridge, MWL generator).

| Item | Rough INR |
|---|---|
| PACS server tier at stage 2 (2×3.84 TB NVMe cache + 8-bay 12–16 TB HDD nearline, or NAS expansion) | ₹2–3L (already in §13 line) → +₹3–5L at 300 studies/day |
| Offsite object storage (incremental, ~6 TB/y compressed) | ₹1–1.5/GB-month cloud ≈ ₹8–15k/month growing; or second NAS at another building ₹2–3L |
| Diagnostic monitors: 2×3 MP (₹3–5L each), 1×5 MP mammo (₹8–12L), clinical review monitors 2 MP ×6 (₹40–60k each) | ₹18–30L at scale; day one 1×3 MP ≈ ₹4L |
| Dry film printer (if films retained) + CD robot | ₹8–15L + ₹3–6L |
| Tablets for portable rounds ×3, barcode scanners ×4, label printers ×2 | ₹1–1.5L |
| Reaction crash cart + monitor per contrast room | ₹1.5–2.5L each |
| Modality UPS (CT needs its own), MRI-safe accessories | vendor-scoped |
| Storage growth: ~150 MB avg/study blended; 100/day today ≈ 15 GB/day ≈ 5.5 TB/y raw (≈2 TB compressed); 300/day at scale ≈ 16 TB/y raw (≈6 TB compressed) | drives the tiering plan (O-9) |

---

## 13. Owner rulings needed

- **O-1 Teleradiology standby.** Recommend: sign a dormant DPA-backed contract now with a named partner, activation by duty manager under a pre-authorised trigger (radiologist unreachable 15 min for stat, or backlog > N), cost visible per activation. Why: the single-incumbent 24×7 post is the department's bus factor.
- **O-2 Report-blocked-until-paid for imaging.** Recommend: yes for OPD self-pay *delivery* (print/WhatsApp), never for in-app doctor view, IPD, ED, or criticals. Why: matches the legacy harvest rule for lab and protects safety.
- **O-3 Outsourced MRI mode.** Recommend: mode (a) hospital bills, partner invoices (P4) — keeps the patient journey and report in our record. Why: attribution and leakage control.
- **O-4 Film/CD policy and prices.** Recommend: film-free default (report PDF + OHIF share link + CD on request ₹150), films only on demand at ₹250/sheet; MLC/police copies free. Why: cost, storage, DPDP-friendly.
- **O-5 Pregnancy screening policy.** Recommend: declaration + LMP for all ionising studies on females 10–55; urine hCG mandatory for CT abdomen/pelvis and fluoroscopy where LMP >4 weeks or uncertain; "10-day rule" not enforced beyond that. Why: corporate norm, workable at 02:00.
- **O-6 Patient-language plain summaries.** Recommend: defer until the Drafter has 90 days of edit-distance data; then T2 with radiologist approval. Why: liability and DPDP.
- **O-7 PCPNDT registration expiry behaviour.** Recommend: hard block on USG after expiry unless a filed-renewal acknowledgement is recorded. Why: criminal liability under the Act sits with the owner.
- **O-8 Image-AI products.** Recommend: none in 18a/18b; evaluate chest X-ray triage and stroke tools only as T1 nudges after PACS is stable; bought, never built. Why: clinical cap, cost, evidence.
- **O-9 Retention tiers and offsite spend.** Recommend the §4 schedule; offsite incremental object storage from PACS day one. Why: §11.19-C-36 already requires it; the spend is small early and impossible to retrofit late.
- **O-10 Radiation oncology integration scope.** Recommend: the HMIS owns AERB registers hospital-wide (radiology module, 18c) so cath lab and RT write to one place; RT orchestration (referral, fractions, billing) is its own plan at LINAC commissioning; vendor selection carries the data-export mandate. Why: one register for one inspector.
- **O-11 Resident/ED preliminary reads.** Recommend: allowed, always labelled UNVERIFIED, superseded within the SLA, discrepancy tracked; ED physician prelims allowed for trauma/stroke only. Why: door-to-needle beats waiting.
- **O-12 Interventional radiology.** Recommend: out of scope for 18; rides the cath-lab/OT-variant mechanics when an IR suite exists.
- **O-13 Who is PCPNDT in-charge and RSO day one.** Recommend: the 24×7 radiologist as sonologist-in-charge + a senior radiographer as RSO (AERB approval), quality manager verifies returns. Why: SoD with two humans available.

---

## 14. Plan sketch — how this becomes phase documents

**Plan 18a — Radiology core (no PACS).** Sections: module scaffold + manifest + permissions; study-type master + doctor-wise templates (editable documents, versions, lexicon lockouts); imaging orders on the shared P2 envelope (from 17); scheduling view over device resources (Plan 13) with walk-in vs slotted; safety-gate rule set + screenings table; PCPNDT: registrations, Form F (shared with 15), cannot-close, serials, monthly return compiler, certified prints; report lifecycle (prelim/draft/signed/amended/superseded), 2FA sign, publish via Plan 10, criticals + contact protocol; portable P5 flow with tablet; contrast administration + reaction; billing charge posting incl. contrast swap, packages, pre-auth consumption; outside-study register; release desk (WF-IMG-09); KPIs registered; Prep/Recall, Critical Chaser, Unread Watchman, Nudger automations; downtime kit (paper pads, reserved Form-F serials). Gates before authoring: 17's order envelope shipped; Plan 15's Form F table shape frozen; PCPNDT registration documents on file (§19); templates collected from the radiologist.

**Plan 18b — PACS: Orthanc + OHIF + MWL + Drafter.** Orthanc compose service with PostgreSQL index, DICOMweb, worklist plugin (file generated from schedule), authorization bridge to HMIS tokens, `image.viewed` events, dose SR hook, unmatched-study reconciliation, tiered storage + offsite incremental + restore drill, diagnostic monitor procurement, teleradiology send-out adapter (dormant), Structured Extractor, **Radiology Report Drafter** under 12a runtime (DPIA addendum, shadow mode, provenance). Gates: 11b hybrid/on-prem storage decision, DPIA signed, O-1/O-9 ruled.

**Plan 18c — Radiation safety & AERB registers (hospital-wide).** Licences/eLORA, RSO/physicist credentials, TLD programme, dose register + DRL comparison, QA lockout, compliance calendar entries, inspection persona prints; interfaces for cath lab and RT. Gate: RSO named (O-13).

**Plan 2x — Radiation oncology orchestration** (at LINAC commissioning; after vendor selection): referral → planning handoff → fraction events → billing → summary; brachy source custody; consumes 18c.

**Sequencing:** 18a after 17 (envelope) and in parallel with 19; 18b after 11b storage and 12a; 18c can ship with 18a's tail if the RSO is named. The mini-OT (15) instantiates Form F first; 18a must adopt, not fork, that table.

**Negative-space question:** *An applicable USG with no Form F is impossible by construction — so the absence that signals is a DICOM study in Orthanc with no HMIS order (off-book scan), a modality with zero studies on a rostered day (broken or idle), a radiologist shift with zero `image.viewed` events (reading outside the system or not at all), a stroke case with no imaging event in 25 minutes, and a badge period with no read (badge not worn).* Each of these is a T0 report row.

**Staff edge-case interview (radiologist / senior radiographer / receptionist):**
1. Last time you scanned a patient without a requisition — why, and what happened to the bill?
2. How do you handle the pregnant patient at 2 a.m. when the sonologist is at home?
3. What do you do when the CT console shows a different name from the slip?
4. How many Form Fs per month, and who compiles the return today; when was the last inspection and what did they ask?
5. When did you last repeat a film, and how was it recorded?
6. What happens to contrast vials opened and not used?
7. How do ward nurses request portables today, and how do you know which bed?
8. How do you communicate a critical finding when the OPD patient has left?
9. Which reports get amended most, and why?
10. Where are the TLD badges, who sends them, and when did a reading come back high?
11. Which outside MRI centre do you use, and how does their report reach the doctor?
12. What do patients ask for at the counter — films, CDs, WhatsApp — and what do you charge?
13. What breaks first when the network goes down?
14. Which doctor's report style is most different from the others (template harvesting)?

---

## 15. Open questions & risks

1. **Shared P2 order envelope** — whether Plan 17 lays a kernel-level `orders` table or lab-private tables determines whether 18a reuses or builds; must be settled in 17's phase doc.
2. **Form F table ownership** — Plan 15 creates it first; radiology must import the schema unchanged; a `pcpndt` sub-module owned by neither is the cleaner answer (proposed: kernel-adjacent statutory module `pcpndt` claimed by 15, extended by 18a).
3. **Electronic register legality** (§19 E-21) for PCPNDT and AERB registers — counsel opinion pending; print-and-bind fallback designed.
4. **Orthanc authorization bridge** — per-study tokens vs role-scoped; effort unknown until spiked (~1 week).
5. **Dictation/STT locus** — DPIA implication if cloud; on-prem STT GPU cost (₹1.5–3L) not budgeted.
6. **Dose SR availability** on the owner's actual modalities — unknown until models are named (§19).
7. **Teleradiology de-identification** vs the partner's need to phone criticals to the ward — token map resolution path must be designed with the DPA.
8. **Echo boundary in practice** — cardiologist may want the same report editor; the interface must be declared before cardiology's plan.
9. **Storage numbers** are estimates; measure real study sizes in the first PACS month before buying tier-2 hardware.
10. **Scale of Form F at 2,000 OPD/day** — obstetric USG volume could exceed 100/day; the 60-second pre-fill path is a hard UX requirement, not a nicety.
11. **PCPNDT registration per site** if a satellite USG centre opens — the Act's facility scope must be confirmed with the AA.
12. **Resident programme timing** (DNB) decides whether O-11 matters in 18a or later.
