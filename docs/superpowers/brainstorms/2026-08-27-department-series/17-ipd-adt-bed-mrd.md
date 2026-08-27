# 17 — IPD Wards: Admission–Transfer–Discharge, Bed Management, Wristbands, Attendants, Discharge Cascade & Medical Records (MRD) — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED · **Series doc 17** (not roadmap Plan 17, which is LIMS — the plan numbers this document proposes are 20–23, §14).

**Executive summary.** This module is the inpatient spine: the P1 journey from `admission.requested` to `patient.discharged`/`patient.deceased`, the bed board as IPD rules *over* the Plan 13 registry, wristbands and attendant passes as signed-QR identity surfaces, the SLA-timed discharge cascade, and MRD — the department that assembles, codes, completes, releases and retains the record. It is **not** eMAR/vitals charting (nursing module), not ICU telemetry (§11.15), not OT (§11.16), not pharmacy indents (Plan 16), not TPA claims (Claims Drafter, TPA phase) and not the registry itself (Plan 13, shipped as T1 today). Its three hardest problems: (1) **the bed is a contended, money-bearing resource** — class drives every tariff, gender/isolation are hard constraints, "reserved" is abused, and midnight census decides who pays for the day; (2) **discharge is a multi-department clearance race** where the hospital is measured in hours (fit-declared → out < 3 h, discharge-before-11) while pharmacy returns, payer approval, family auspicious-time holds and a T2 drafted summary all have to converge attributably; (3) **the record outlives the stay** — deficiency completion by doctors who have moved on, ICD coding under NHCX pressure, lawful release to courts/police/insurers/data principals with DPDP-bounded retention, and legacy paper that must stay findable through the cutover.

---

## 1. Frame — what exists, what is locked, what this document adds

**Built (Phase 1):** kernel (events outbox, workflow engine with versioned definitions, approvals, RBAC actor fabric, scheduler/worker, ops modes/downtime kit), patients (guardian model incl. sensitive-context override), tariff/GST with PricingContext tariff pinning, OPD encounters (encounter enum left open for IPD/ER/day-care), billing counter (receipts-and-allocations ledger, credit notes, refund vouchers), notifications gateway, memberships/coupons/accrual ledger, formulary + prescribing safety, search/command palette, user admin. **Plan 13 resource registry** — `resources` + `resource_status_history` landed at `e913845` (T1); kinds `floor|ward|hall|room|bed|theatre|store|bench|analyzer|device`, one `status` column with per-kind vocabularies declared on the manifest seam (DD2/DD4), occupancy triad `occupant_ref/occupant_type/since` (DD6), read-only HTTP (`tree/board/history`, DD14), `(site_id, kind, lower(code))` uniqueness (DD13).

**Locked decisions inherited (do not re-litigate):**
- §11.2 IPD journey verbatim: sources OPD/ER/direct; admission desk payer branch; live bed board; **class drives every tariff for the stay**; deposit invoice; wristband (UHID QR); auto porter task; SLA request→bed < 30 min; deposit ≈ 3 estimated days of class charges (package-% for planned surgery), top-up 75 %, escalation 90 %, ICU burn-rate daily recalculation; **calendar-day billing, 12-noon checkout + grace**; running bill to attendant daily on WhatsApp; transfers with nurse handover checklist and rent split by days-in-class; N QR passes per bed class, security scans at ward entry, lost pass → reissue with instant revoke, discharge/death/transfer auto-expires all passes; ICU admission needs intensivist approval, no bedside attendants in ICU; 8-step discharge cascade target < 3 h; E5 LAMA, E6 death, E7 deposit exhausted (**care never stops**), E8 abscond/dispute.
- §7 tariff lock at admission; billing append-only, corrections are credit notes; refunds to whoever paid; no membership sales at admission desk or bedside (§11.19-C #32).
- §11.4 maps 2 (mother-baby pairing, baby = own UHID, hard-stop double scan), 3 (payer switch: documented counselling + signed consent, invoice lines attributed by payer period), 4 (class protection: waitlist → temporary higher class at booked tariff 48 h → refer-out; upgrade consent shows room-rent-cap proportionate-deduction warning; changes effective next noon), 6 (packages), 7 (30-day readmission flag), 8 (unknown patient), 9 (isolation, bed blocked until deep-clean verified), 12 (MLC in IPD, unclaimed body 72 h → police → municipal).
- §11.18 ward-room model; gender segregation is a **hard bed-board constraint**; pediatric parent-stay pass variant; bed-board rules are IPD-module rules over the registry.
- §11.19-C/D/E: signed QR tokens (#23); sealed-class propagation and treating-team carve-out; **pre-auth sanction as a first-class object pulled into the IPD phase** (D-6); cascade gains "awaiting payer final approval" (D-9); deceased-patient conduct — **body release never gated on payment** (D-33); **death-to-release cascade 24×7 certification chain** (E-13); **family-requested discharge hold** pauses the clock (E-14); approval urgency classes (E-15); evidence-retention map (E-19); statutory-format renders, electronic-register legality per counsel (E-21); bulk-export governance (E-28); ICD-10 capturable at order/pre-auth (E-31); cutover: old-UHID cross-reference + physical-file pointer in MRD (D-43); `correction.entered_in_error` (pass 8).
- §11.14: DPDP data-principal rights with retention-bounded erasure (**OPD ~5 y, IPD ~10 y, MLC indefinite**), legal holds, body-release double-verify, long-stay 30-day flag, management-override admissions evented and surfaced, DNR/refusal records, Code Yellow (elopement ≠ abscond).
- §16 roster: Discharge Summary Drafter T2, Turnover Dispatcher T4 (automation), Coverage Resolver T3 ship with IPD; provenance stamps; fail-open; clinical cap T2–T3.
- Plan 13 §4A rulings: **class/tariff link belongs to IPD** (item 1) — this document designs it; instrument sets are not a kind; master-data governance is its own later phase.
- Roadmap deferred note 15: **reservations are governed state machines** (available → tentatively reserved → confirmed → consumed → released, TTL on tentative holds, single-winner transition semantics, emergency pre-emption as definition data).

**Scope boundaries and table ownership.** IPD owns: admissions, bed assignments/reservations, class ledger, wristbands, passes, transfers, census snapshots, discharge cascade & clearances, discharge summaries, deaths/mortuary chain, absconds. MRD owns: file assembly/completion, deficiencies, coding, record requests/releases, retention/legal hold, physical-file movement, birth/death registration. Registry (kernel) owns bed existence/status/occupant. Billing owns charges/invoices/receipts (IPD posts charges via events). Nursing (separate future module) owns eMAR/vitals/handover checklists; this doc only consumes `handover.completed`, `medication.administered`. Housekeeping (Plan 19) owns turnover tasks. Diet/kitchen and OT own their orders. Patients owns demographics/guardians. Security scans passes via this module's verify API.

---

## 2. Actors, roles & role cards

| Role (S10 card #) | Stations in this module | Shift/bundling | Notes |
|---|---|---|---|
| Admission / Bed-Board Clerk (#6) | admission desk, bed board, deposit invoice, wristband/pass print | 24×7; night bundles with registration clerk (S10 §10) | Cannot approve own deposit waiver (SoD) |
| Duty Medical Officer / ward RMO (#9) | admission orders, fit-for-discharge co-sign when consultant remote, death declaration at night, LAMA counselling | 24×7 | Verbal-order countersign window |
| Consultant (S10 doctor cards) | admitting consultant of record, rounds (`round.recorded` NEW), fit declared, summary sign, MCCD sign | on-call roster | Fee auto-posts on round |
| Intensivist (#11-ish) | ICU admission approval, step-down decision | 24×7 | interrupting approval channel (E-15) |
| Staff Nurse ward (#20) | admit-to-ward receive scan, transfer handover, discharge nursing clearance, meds return, body care | 3 shifts | witness rules |
| Ward In-Charge (#23) | bed blocking approvals at ward grain, overload, family-hold record | day + on-call | |
| Billing/IPD billing executive (S10 front-office cards) | interim bills, final bill, refund of excess deposit, payer-period split | day, night bundled to cashier | SoD: cannot approve own write-off |
| TPA/Insurance desk (S10 #5) | pre-auth sanction object, enhancement, final approval, denial → payer switch counselling | day; night queue | |
| Housekeeping supervisor + pool (#32) | turnover/deep clean tasks, verification | 24×7 pool | Turnover Dispatcher assigns |
| Porter/transport pool | admission transport, transfers, body to mortuary | 24×7 pool | claim discipline |
| Security supervisor + pool (#34) | pass scans at ward entry, gate pass at exit, body-release triple-verify, Code Yellow/abscond search | 24×7 | |
| Duty Manager (#31) | class-protection exceptions, management-override admissions, deposit escalation at 90 %, abscond register, unclaimed-body ladder, police liaison | 24×7 | |
| MRD Officer (#7) | file assembly, deficiency chase, coding QA, release desk, retention, CRS filings | day; night queue to day (S10 §10) | SoD: releaser ≠ requester-verifier for court/police |
| **NEW card — Medical Coder** | ICD-10 (+ ICD-10-PCS/NHCX package codes) coding of every IPD episode within 7 days | day | reports to MRD Officer; 1 → 4–6 |
| **NEW card — Discharge Coordinator** | owns the cascade board per floor; chases clearances; runs discharge lounge | day 07:00–19:00, night bundled to ward in-charge | 0 → 4–6 (one per 100–150 beds) |
| **NEW card — Mortuary Attendant** | body reception, tagging, cold-storage log, release with security | 24×7 on-call at 10 beds; posted at 610 | |
| Dietician (#28), Physio, Pharmacist (#25) | clearance signers in cascade | day | |
| Quality Manager (#37), Infection Control Nurse (#38) | open-record audit, HAI/isolation, mortality review committee feed | day | |
| Patient / attendant / guardian | consent, pass holder, running-bill recipient, DSR requester | — | language preference drives all messages |

**Agent/automation actors (details §9):** Turnover Dispatcher (T4 automation), Deposit Ladder (T1 automation, the E7 ladder), Clearance Chaser (T1 automation, = SLA Chaser instance), Discharge Summary Drafter (T2 agent), Discharge-Readiness Predictor (T0 agent), Bed Demand Forecaster (T0 agent), MRD Deficiency Chaser (T1 automation), Coding Suggester (T2 agent), Census Snapshotter (T0 automation), Pass Anomaly Watch (T0 automation, feeds Fraud Sentinel), Leakage Auditor (existing; device-days/bed-days triangle).

**SoD hard pairs added (proposed):** bed-block requester / bed-block approver · deposit-waiver requester / approver · records-release verifier / releaser (court/police class) · death declarer / MCCD countersigner may be the same doctor but **body-release verifier must be security + nurse, never the declarer alone** · abscond-declaring nurse / recovery-register closer · coder / open-record auditor for the same episode.

---

## 3. Core flows as workflow definitions

All are workflow definitions (versioned data, owner-activated per §10.4). Events in the canonical catalog are unmarked; proposals are **NEW**.

### 3.1 Admission (P1 with P6 overlay)

```
requested ──(clerk/ER/OPD; admission.requested)──▶ payer_branching
payer_branching ──self-pay: deposit invoice──▶ bed_seeking
               ──TPA: preauth object created (preauth.requested NEW)──▶ bed_seeking   [care never waits on pre-auth]
               ──PMJAY/corporate: eligibility check──▶ bed_seeking
bed_seeking ──match found (bed.assigned)──▶ bed_reserved (TTL 30 min; reservation.held NEW)
            ──no match (bed.waitlisted)──▶ waitlisted ──▶ bed_seeking | referred_out | cancelled
bed_reserved ──wristband printed (wristband.issued NEW) + porter task──▶ in_transit
in_transit ──ward nurse scans band at bed (patient.admitted)──▶ admitted
           ──TTL expiry (reservation.expired NEW) ──▶ bed_seeking (bed released)
any ──cancel (admission.cancelled NEW)──▶ cancelled
```

SLA: requested→bed_reserved 30 min (day-one active alert); bed_reserved→admitted 45 min (recorded only); ICU path adds `icu_approval_pending` before `bed_reserved`, approval via interrupting channel, 15-min SLA, escalation intensivist → ICU head → medical superintendent. Ladder: clerk → front-office supervisor → duty manager. Roles: clerk/ER nurse/OPD desk may request; clerk assigns; ward nurse confirms by scan; duty manager overrides (evented, digest-surfaced §11.14).

**Bed matching rule (deterministic, in this order):** requested class → gender constraint for shared rooms/wards (hard) → isolation need (cabin preferred, §11.15 grain) → age (pediatric ward for < 14 y unless consultant overrides) → ward preference by specialty (config table) → nearest free verified-clean bed. Match returns a ranked list; clerk picks; "available" means registry status `available` AND no live reservation instance.

### 3.2 Bed reservation & blocking (roadmap note 15)

States `available → tentatively_reserved (TTL) → confirmed → occupied → released → dirty → cleaning → verified_clean → available`; side-states `blocked` (reason enum: maintenance/isolation-deep-clean/infection-cohort/VIP-hold/surgery-hold/staff-shortage) with **mandatory expiry ≤ 24 h**, renew requires ward in-charge; `reserved` for planned surgery/elective admits carries a patient and a date — a reserved bed with no patient is illegal by schema. Events: bed.blocked / bed.unblocked (**NEW**), reservation.held/.confirmed/.expired/.preempted (**NEW**). Emergency pre-emption of a tentative hold by an ER Red is definition data.

### 3.3 Stay: class ledger, transfers, census

```
admitted ──transfer requested (ward/ICU/OT/step-down)──▶ transfer_pending ──handover checklist done (handover.completed)──▶ transferred (patient.transferred)
admitted ──class change consent (bed.class_changed)──▶ admitted (class ledger row, effective next noon)
admitted ──protection clock 48 h ends (class.protection_expired)──▶ admitted (tariff = actual class from next noon)
```

Transfer SLA: request→receiving bed reserved 30 min (ICU 15); ladder ward in-charge → duty manager. Every transfer writes a `class_ledger` row (bed, class, tariff class, from, to); **room rent posts nightly from the ledger, not from the bed board.**

**Midnight census (recommended corporate default, configurable):** census snapshot at 00:00 IST; bed-day charged to the class occupied at 00:00 and the day of admission; **12-noon checkout** — discharge after 12:00 + grace (default 2 h) charges one more day; ICU device-days by start/stop, never census. Same-day admit-and-discharge = one bed-day. Transfer ICU→ward at 11:00 = ICU day charged (occupied at midnight), ward from next midnight. All three rules are `tariff_rules` config with semver.

### 3.4 Discharge cascade (P1 + P5 + P6; the module's marquee definition)

```
fit_declared (consultant/RMO; discharge.fit_declared NEW; clock starts)
 ├─▶ orders_sweep      auto: open orders flagged (order.cancelled or kept-with-reason), pharmacy stop
 ├─▶ clearances (parallel gates, each a task with 60-min SLA, silence auto-escalates):
 │     pharmacy_returns (material.returned → credit) · nursing (lines out, meds education, belongings)
 │     · billing_pending_charges (orphan check) · diet · physio · OT/lab/imaging pending results
 │     · MRD (file complete or deficiency logged) · TPA final approval (state awaiting_payer_final_approval; clock attributed to payer)
 │     · family_hold (family_hold.applied; clock attributed to family)
 ├─▶ summary_drafted (T2; draft.provenance stamped) ──▶ summary_signed (report.signed, type: discharge_summary)
 ├─▶ final_bill_issued (invoice.issued) ──▶ settled | refund_voucher | dues_approved
 ├─▶ gate_pass_issued (pass.issued type: exit) ──▶ exit_scanned (pass.scanned) → patient.discharged
 └─▶ bed_released (resource.status_changed → dirty) → Turnover Dispatcher → task.verified → available
```

Discharge types are payload `discharge_type: normal|lama|dama|absconded|referred|death|day_care` — one definition, type-conditional gates (LAMA requires signed form + counselling; referred requires transfer note + receiving-hospital confirmation; death branches into 3.5). Target fit_declared→exit < 3 h; "discharge before 11 a.m." is a *planning* KPI (fit declared on evening rounds → pre-cleared overnight), not a gate. Escalation: discharge coordinator → department clearance owner → duty manager.

### 3.5 Death-to-release (E-13)

```
death_declared (doctor; patient.deceased) → mccd_pending (Form 4 drafted from record; 24×7 signer chain) → mccd_signed
 → mlc? → police_intimated (mlc.registered/re-intimation) → postmortem_required? (body to mortuary under police custody)
 → body_tagged (body.tagged NEW; tag = signed QR) → mortuary_in (cold-storage log) → release_verified (body tag + gate pass + receiver ID triple scan; body.released)
 → bed_released (terminal clean) ; billing → respectful settlement path (dunning suppressed; release never gated on payment)
 → unclaimed ladder 72 h → police → municipal (body.unclaimed_escalated NEW)
```

SLA: declaration→MCCD 2 h (day) / 6 h (night); body to mortuary 1 h; release request→release 1 h. Death register + brought-dead register distinct (§11.3).

### 3.6 Attendant/visitor pass lifecycle

`issued (pass.issued; signed QR; N per class) → active → scanned (pass.scanned; validity + visiting hours + ward match in one beep) → revoked (pass.revoked; lost/abuse/discharge/transfer auto)`; ICU issues lounge passes only; pediatric parent-stay variant; reissue rotates the signature so the old QR fails (`qr.signature_failed`).

### 3.7 MRD record lifecycle (P5 with statutory SLAs)

```
episode_closed (patient.discharged|deceased) → assembly (digital-first; any paper scanned within 24 h; file.assembled NEW)
 → deficiency_check (rules: summary signed? consents present? op notes? MCCD? MLC forms? deficiency.flagged NEW)
 → doctor_completion (SLA 7 days; deficiency.resolved NEW) → coding (ICD-10 dx + procedure; SLA 7 days; episode.coded NEW)
 → qa_sampled (open-record/closed-record audit; record_audit.completed NEW) → archived (retention clock starts; legal_hold overrides)
 → [request path] request_received (record_request.received NEW; class: patient/guardian/court/police/insurer/internal) → verified → approved → released (document.release_logged) | refused (reason)
 → disposal_due → disposal_approved (owner) → disposed (record.disposed NEW)
```

Physical file movement: `file.checked_out / file.returned` (**NEW**) with holder, purpose, due-back; overdue → chaser.

### 3.8 Abscond / elopement

`missing_noted (nurse; 30 min unreturned) → search (Code Yellow if vulnerable; patient.missing_flagged) → absconded_declared (duty manager; discharge_type=absconded; abscond.recorded NEW) → recovery_register (dues) → MLC re-intimation if MLC`.

---

## 4. Data model sketch

**IPD module tables** (`ipd_*`, all reference `patients`, `encounters`, `resources`):
- `ipd_admissions` — id, encounter_id, patient_id, source (opd/er/direct/referred/day_care_conversion), admitting_consultant_id, department, requested_class, admission_type (elective/emergency/day_care/observation), payer_tag, preauth_id?, mlc_flag, isolation_flag, workflow_instance_id, admitted_at, expected_los_days, discharge_type?, discharged_at, tariff_version_pinned.
- `ipd_bed_classes` — code, name, tariff_service_id (link into tariff engine — this is the §4A item-1 link), attendant_policy, pass_count, nursing_ratio_indicator, ac, is_icu, deposit_days_default, sort_rank. (Registry `resources.class` holds the code; this table gives it meaning.)
- `ipd_bed_assignments` (class ledger) — admission_id, bed_resource_id, class_code, billed_class_code (protection), from_at, to_at, reason (admit/transfer/upgrade/downgrade/protection_move/preempt), consent_doc_id?, actor.
- `ipd_reservations` — bed_resource_id, admission_id?, kind (tentative/confirmed/block), reason, expires_at, workflow_instance_id, created_by, approved_by?.
- `ipd_wristbands` — admission_id, token (signed), printed_at, printer_resource_id, void_at, reason; `ipd_band_pairs` — mother_admission_id, baby_admission_id, pair_token.
- `ipd_passes` — admission_id, type (attendant/parent_stay/lounge/exit_gate/body_release/visitor_slot), token, holder_name?, holder_phone?, valid_from/to, revoked_at, reason; `ipd_pass_scans` — pass_id, scanner_resource_id, result (ok/expired/wrong_ward/revoked/sig_fail), at.
- `ipd_deposits` — admission_id, schedule_amount, paid_running (derived from receipts ledger — never stored twice), alert_75_at, alert_90_at, waiver_approval_id?.
- `ipd_preauth_sanctions` (D-6 object) — admission_id, payer_id, sanctioned_amount, class, los_days, procedure_scope, status, enhancement rows, final_approval_at, denial_reason; `ipd_payer_periods` — admission_id, payer_tag, from_at, to_at, consent_doc_id.
- `ipd_census_snapshots` — snapshot_at (00:00 IST), bed_resource_id, admission_id?, class_code, status — append-only, source of bed-days.
- `ipd_transfers` — admission_id, from_bed, to_bed, requested_at, handover_checklist_instance_id, completed_at.
- `ipd_discharges` — admission_id, fit_declared_at, type, summary_doc_id, final_invoice_id, exit_scanned_at, holds JSONB (payer/family with attributed durations); `ipd_clearances` — discharge_id, department, task_id, status, cleared_by, at, note.
- `ipd_discharge_summaries` — FHIR `Composition` (type LOINC 18842-5) JSONB + sections (admission reason, course, procedures, diagnoses ICD-10, condition at discharge, meds `MedicationRequest[]`, follow-up, warning signs, diet), language variants (en, hi), draft_provenance (model id, prompt version, input/output hash), signed_by, signed_at, patient_copy_sent_at.
- `ipd_deaths` — admission_id, declared_at, declared_by, cause lines (MCCD I(a)(b)(c), II), manner, mccd_form_no, signed_by, mlc, postmortem_required, mortuary_in_at, body_tag_token, released_at, receiver identity (name, relation, ID type/number masked), witnesses; `ipd_mortuary_register` (statutory) — body_tag, in/out, storage_slot_resource_id, cold-storage charges head, unclaimed ladder rungs.
- `ipd_lama_records` — admission_id, counselling_by, risks_explained (lang), signed doc, witness, refused_to_sign flag.
- `ipd_absconds` (recovery register) — admission_id, last_seen_at, search rungs, declared_at, dues, police intimation ref.
- `ipd_diet_orders` link table only if diet module absent at ship; else consume `diet.ordered` (**NEW**, diet module).
- `ipd_rounds` — admission_id, doctor_id, at, type (consultant/RMO/cross-consult), note_doc_id → `round.recorded` (**NEW**) drives visit fee (§11.11).

**MRD module tables (`mrd_*`):** `mrd_files` (episode, format digital/paper/hybrid, physical_location_resource_id, legacy_uhid, legacy_file_pointer), `mrd_deficiencies` (file, type, owner_doctor, due_at, resolved_at, escalation rungs), `mrd_codes` (episode, code_system ICD-10/ICD-10-PCS/NHCX-package/SNOMED, code, role principal/secondary/procedure, coder, suggested_by_agent?, suggestion_accepted bool), `mrd_requests` (class, requester identity/authority doc, consent_doc, statutory_basis, TAT due, decision, released_pages/doc ids, watermark id, fee invoice), `mrd_releases` (= `document.release_logged` payload table), `mrd_file_movements`, `mrd_retention_policies` (record_class → years, basis statute, semver), `mrd_legal_holds`, `mrd_audits` (open/closed record audit sheets, NABH element refs), `mrd_scan_batches` (legacy paper: box → file → pages, QC), `mrd_birth_registrations` / `mrd_death_registrations` (CRS Form 1/Form 2 filings: informant, filed_at, registrar ack no., certificate handed at), `mrd_certificates` (birth/death/medical/fitness/disability-referral: template version, QR verify id).

**Statutory registers as tables:** admission register, discharge register, death register (institutional), brought-dead register (ER-owned), MLC register (ER-owned, IPD appends), mortuary register, LAMA/DAMA register, abscond/recovery register, records-release register, birth register (maternity-owned, MRD files CRS), stillbirth register, unclaimed-body register.

**Registry kinds needed (Plan 13):** floor, ward, hall, room, bed (attributes: class code, ac, isolation_capable, oxygen_point, pediatric, bariatric), device (wristband printer, pass scanner, mortuary cold-storage slots as `device` or `room` — recommend `room` kind `mortuary_slot` attribute), store (MRD file room shelves as `store` with rack/shelf attributes). No new kind is proposed.

**Retention (recommended defaults, E-19 map):** IPD records 10 y from discharge (NABH/consumer-litigation norm; NMC Ethics Regulations 2002 reg 1.3.1 minimum 3 y is the floor); MLC/medico-legal, death, POCSO indefinite; minors: until age 18 + 10 y; OPD 5 y; registers: as per Clinical Establishments (state rules) — 5 y min; event log inherits books' 8-y (Income-tax/GST) as source record.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref**. Themes A–N.

### A. Identity & wrong-patient
| ID | Scenario → behaviour → test → ruling |
|---|---|
| A1 | Two Ram Kumars admitted to the same ward, one for orthopaedics one for cardiac → bed board and every worklist show UHID last-4 + photo thumbnail + DOB; wristband scan (signed token) is the only accepted identity for eMAR/transfusion/transport → test: attempt to administer against name-selected patient without scan is refused (`scan_required`). |
| A2 | Wristband unreadable (wet/torn) at 03:00 → nurse reprints from ward printer after two-factor identity check (patient states name+DOB or attendant confirms; photo match); old token voided (`wristband.reissued` NEW), scan of old fails → assertion: old token returns `sig_fail`, audit shows reissue actor. |
| A3 | Wristband placed on the wrong patient at admission (two admissions printed together) → band-at-bed confirmation scan requires the receiving nurse to match band QR to the porter task's patient AND the bed reservation; mismatch blocks `patient.admitted` → test: mismatch emits `band.mismatch_flagged` (NEW) and incident draft. |
| A4 | Newborn handed to the wrong mother for feeding → pair-scan hard stop (§11.4 map 2) → `band.pair_mismatch` + infant-abduction-code readiness → test: pair verify with non-matching tokens returns hard stop. |
| A5 | Unknown/unconscious patient admitted from ER as UNK-UHID, identified on day 3 → `patient.merged` carries admission, bed ledger, deposits, passes; wristband reprinted with real UHID; old token voided → test: post-merge bed board shows one admission, invoices reattributed, no duplicate bed-day. |
| A6 | Patient merge later found wrong (two real people) → unmerge splits admission history by bed ledger rows and event causation; flagged patient-safety emergency (§11.5) → test: unmerge restores both timelines with no orphan bed-day. |
| A7 | Attendant registers the patient under a relative's name to use a TPA policy (insurance identity fraud) → photo capture at cashless intake vs ID; mismatch → payer-switch machinery + incident + insurer notification (§11.14) → test: mismatch flag blocks pre-auth submission until resolved. |
| A8 | Staff nurse is admitted to her own ward → staff-as-patient confidential class: alias on bed board/public displays, ward nurses of her unit see only treating-team surfaces; access to her record by colleagues evented and reviewed → test: non-treating same-ward user gets `not visible to your role`. |
| A9 | Twins in NICU with identical names "Baby of Sunita" → each has own UHID, wristband token, pair band to the mother; bed board shows "Twin A/Twin B" + birth time → test: EBM feed scan for Twin A against Twin B band hard-stops. |
| A10 | Body tag scan at release matches a different deceased (two deaths same night) → triple-verify (tag + gate pass + receiver ID) refuses; incident → test: release with mismatched tag returns hard stop and `body.release_mismatch` (NEW). |

### B. Bed allocation, class, gender, isolation
| ID | Scenario → behaviour → test → ruling |
|---|---|
| B1 | Female patient, only free general bed is in a male bay → hard constraint: bed not offered; waitlist + class-protection offer of a private room at general tariff (48 h) → test: matcher never returns gender-incompatible bed; protection ledger row created with `billed_class=general`. |
| B2 | Transgender patient in shared ward → recommended default: patient-stated gender identity governs; single room offered at booked tariff if patient prefers; recorded as protection reason `dignity` → owner ruling **O-4**. |
| B3 | Requested private room full; patient accepts deluxe at private tariff; after 48 h a private frees but family declines to move → protection ends from next noon boundary; deluxe tariff from then (§11.4 map 4); consent shows insurance room-rent-cap warning → test: `class.protection_expired` fires at next 12:00 IST, class ledger flips billed_class. |
| B4 | Right class frees at 23:50; auto-move task raised; move happens at 00:30 → midnight census still shows old bed; billed class per ledger (protection) so no extra charge → test: census snapshot bed ≠ ledger class; billing uses ledger. |
| B5 | Isolation flag set mid-stay (TB suspect) in a 4-bed bay → bed board marks bay cohort or moves patient to cabin; other three patients' exposure logged for ICN; passes tightened → test: `isolation.flagged` blocks new assignment into that bay until ICN clears. |
| B6 | Two clerks assign the last ICU bed simultaneously (ER Red and post-OT) → reservation instance single-winner transition; loser sees "reserved 2 s ago by X" and enters ICU-full branch (hold + monitoring + refer-out offer, decision logged) → test: concurrent reserve → exactly one `reservation.held`. |
| B7 | ER Red needs ICU bed held tentatively for an elective post-CABG arriving in 3 h → pre-emption rule (definition data): tentative hold pre-empted, elective's surgeon notified, OT list re-sequencing suggested → test: `reservation.preempted` with cause `er_red`. |
| B8 | "Reserved" bed sits empty 2 days for a VIP's relative → reservation without patient illegal; with patient, TTL 24 h; renew needs ward in-charge; every renewal in digest; occupancy KPI counts reserved-but-empty separately → test: hold > TTL auto-expires. |
| B9 | Bed blocked "maintenance" for a week to hide low staffing → block reason enum + expiry ≤ 24 h + renewals evented; weekly digest lists blocks by ward and reason → test: block without expiry rejected. |
| B10 | Pediatric patient aged 15 requested adult ward by parents → age rule (< 14 pediatric) allows consultant override, evented; parent-stay pass variant issued → test: override without consultant role refused. |
| B11 | Bariatric patient needs a specific bed → bed attribute `bariatric`; matcher filters when admission flag set → test: matcher excludes non-bariatric beds. |
| B12 | Seasonal surge: dengue, corridor beds → surge flag authorises temporary `bed` resources under ward with class `general_surge`, expiry date; census counts them; NABH ratio indicator shows breach → test: surge beds auto-retire at surge end if empty. |
| B13 | Downgrade requested by family for money reasons on day 5 at 15:00 → effective next noon; today charged at old class; counselling record → test: ledger row from_at = next 12:00. |
| B14 | Patient moved to a higher class *by the hospital* (bay closed for fumigation) → billed class stays booked; reason `hospital_initiated`; no consent needed, but notification sent → test: no tariff change. |
| B15 | Waitlisted patient forecast "bed in ~4 h" but three discharges get family-held → forecast recomputes from cascade states; patient offered refer-out at 6 h with logged decision → test: waitlist entry has decision within SLA or breach recorded. |

### C. Timing, concurrency, census & bed-day rules
| ID | Scenario → behaviour → test → ruling |
|---|---|
| C1 | Admitted 23:58, discharged 00:40 → two calendar days by census rule? Recommended default: minimum 1 bed-day, midnight crossing within 2 h of admission charges one day (config `midnight_grace_minutes=120`) → test: fixture yields 1 day. |
| C2 | Discharge fit-declared 10:30, exit scan 14:30 because billing queue → 12-noon rule + 2 h grace: no extra day if clock delay attributed to hospital (cascade shows hospital-side breach) → charge suppressed with reason `hospital_delay` → test: extra day not posted; orphan report shows suppressed line for review. |
| C3 | Family hold applied 11:00, exit 18:00 → extra day chargeable (hold attributed to family) with prior counselling notice at hold time → test: hold consent text includes charge warning; day posts. |
| C4 | Server clock drift makes census run at 00:07 → snapshot `snapshot_at` uses scheduled boundary, `recorded_at` actual; `clock.drift_flagged` → test: bed-day attribution uses scheduled boundary. |
| C5 | Census job fails at midnight (worker down) → next run backfills from `resource_status_history` + class ledger as of 00:00 (deterministic reconstruction); flagged `census.reconstructed` (NEW) → test: reconstruction equals live snapshot in a replay fixture. |
| C6 | Transfer ICU→ward recorded at 09:00 with `occurred_at` 06:30 (late entry) → dual stamp, ICU device-days stop at 06:30 claimed, flagged for audit → test: late-entry flag present; ICU charge ends at claimed time; audit list includes it. |
| C7 | Two nurses complete the transfer handover checklist for the same patient in two wards → single-winner; second sees completed state → test: only one `handover.completed`. |
| C8 | Discharge and re-admission same day (patient collapses in the lounge) → new admission linked (`readmission.flagged`, relatedness prompt), bed-day for first stay 1 day; deposit carry-forward offered → test: 30-day readmission flag fires with same-day flag. |
| C9 | Bed released by nurse before patient physically leaves (to free board) → release requires exit gate pass scan OR discharge coordinator override with reason; premature release evented → test: release without exit scan and without override refused. |
| C10 | Housekeeping marks clean; supervisor verification pending 2 h → bed shows `cleaning` (not available); Turnover Dispatcher re-dispatches verification; SLA breach recorded → test: matcher excludes `cleaning`. |
| C11 | Patient in OT for 6 h — is the ward bed occupied? → yes: registry bed stays occupied (occupant = admission), OT theatre occupancy separate; bed-day continues → test: no double-assignment of the ward bed during surgery. |
| C12 | Day-care patient converted to overnight at 20:00 → encounter type converts (Plan 15 exception path), bed assignment from recovery-bay to ward, deposit ladder starts → test: conversion emits `admission.requested` with source `day_care_conversion`. |

### D. Partial failure, downtime, devices
| ID | Scenario → behaviour → test → ruling |
|---|---|
| D1 | Wristband printer jammed at admission → paper band from the downtime kit with serial from reserved range + handwritten UHID; scan-required actions accept `manual_id_verify` two-person path with reason; band printed at ward when printer returns → test: eMAR path accepts manual verify with witness, evented. |
| D2 | Server down mid-shift; three admissions arrive → downtime kit paper admission forms (serial), bed register board on whiteboard; recovery backfill screen creates admissions with true `occurred_at`; census reconstructs → test: reconciliation proves every serial accounted. |
| D3 | WhatsApp gateway down for running bill → fallback ladder SMS → IVR → manual-notify desk flag; bill still printable at ward → test: `notification.failed` leads to next channel attempt. |
| D4 | Pass scanner at ward entry offline → security uses phone browser verify view; if network dead, visual check of pass printed validity + register entry; scans backfilled as `manual` → test: pass scan record with source `manual_register`. |
| D5 | Discharge Drafter (LLM) timeout → summary editor opens with structured pre-fill from the record (deterministic template) — never blocks signing → test: drafter kill switch on → summary flow completes. |
| D6 | Event outbox lag: bed released but board shows occupied for 40 s → board reads workflow/registry state with WebSocket refresh; staleness indicator if last push > 30 s → test: UI shows stale badge. |
| D7 | Power + network loss in ward (UPS 30 min) → tablets cache last worklist read-only; nursing switches to paper MAR; passes visual → backfill; audit shows `downtime.declared` floor-scoped → test: floor-scoped downtime does not stop other floors' cascades. |
| D8 | Mortuary cold storage power failure → utility telemetry threshold (`utility.threshold_breached`) → maintenance critical task 30-min SLA; body transfer to alternate slot logged → test: alarm routes to duty manager. |
| D9 | Registry write fails mid-transfer (bed occupant update) → transfer and registry occupancy in one transaction; partial state impossible → test: injected failure leaves both unchanged. |

### E. Money — deposits, running bills, packages, payer switch, TPA
| ID | Scenario → behaviour → test → ruling |
|---|---|
| E1 | Family pays ₹20,000 deposit against ₹45,000 schedule and refuses more → admission proceeds (care never stops); deposit shortfall flag; ladder at 75/90 % of *paid*, not schedule; counselling record → test: admission not blocked; alert timings computed on paid amount. |
| E2 | Deposit exhausted day 4 → E7 ladder: alert → interim bill → top-up request (WhatsApp) → management escalation; **no order is blocked**; approvals path for inability to pay → test: pharmacy issue succeeds under exhausted deposit; escalation events present. |
| E3 | Cash deposit ₹2.5 L offered → 269ST/cash-limit rules (`cash_limit.blocked`) → split across days refused as structuring (Fraud Sentinel dyad); bank/UPI required → test: cash receipt above limit refused. |
| E4 | TPA pre-auth denied on day 2 → payer switch map 3: counselling + signed consent; payer periods split at switch moment; deposit ladder starts; TPA-period lines retained for dispute → test: invoice lines carry payer_period ids; no line attributed to two payers. |
| E5 | Pre-auth sanctioned ₹80k for 3 days private; ICU day 2 → `preauth.deviation_flagged` (class + LOS); enhancement request task; TPA desk SLA 4 h → test: deviation fires on class ledger change. |
| E6 | Package LSCS ₹45k; blood transfusion (exclusion) needed → live routing out of package; overrun projected and consented before accrual (map 6) → test: excluded charge posts to self-pay bucket only after `package.overrun_consented` (NEW) or emergency-flag with post-hoc counselling. |
| E7 | Consultant asks to "absorb" ₹6k of extra consumables into the package → only via logged management approval (`package.absorbed` NEW payload on approval) → test: absorption without approval id rejected. |
| E8 | Final bill shows ₹3,200 refund of excess deposit; the depositor was the employer's HR person → refund to whoever paid (§7): to employer account; above threshold bank-only → test: refund voucher payee = receipt payer. |
| E9 | Room rent posted nightly, then class change backdated by a clerk to yesterday → structurally impossible (next-noon rule; class ledger from_at ≥ now); correction only by credit note with approval → test: ledger row with past from_at rejected. |
| E10 | Interim bill requested by attendant daily for a 40-day stay → running bill is a read model; interim bill is a snapshot document (not an invoice), QR-verifiable → test: interim bill total = charges − receipts at time T. |
| E11 | PMJAY patient — package rate governs, no deposit, no attendant bill lines; opt-in mid-stay from self-pay → payer switch with PMJAY eligibility check; earlier self-pay lines refundable per scheme rules → owner ruling **O-6**. |
| E12 | Patient discharged with dues ₹12k (approved) then wants a refund of a cancelled physio session → refund inherits bill state (Plan 08 guard); nets against dues, not cash → test: refund voucher against dues bill produces ledger allocation, no cash. |
| E13 | Device-days billed for ventilator but telemetry shows none (§11.15) → orphan flag; leakage inverse flag; nightly report → test: reconciliation job emits both classes. |
| E14 | Deceased patient: family asked to "clear the bill before body release" by a ward clerk → system forbids gate: body-release pass issues regardless of settlement (D-33); dunning suppressed; estate follow-up workflow → test: body release pass issued with unpaid invoice. |
| E15 | Discount 40 % on final bill by consultant's request → role cap + reason code + approval above threshold; discount is a line adjustment, never a deleted charge → test: charge rows immutable; `discount.applied` with approval id. |
| E16 | Corporate payer at credit-stop (60 days) sends a new admission → management override evented; digest surfaces → test: admission under stopped payer requires override approval. |
| E17 | Tariff revised mid-stay → admitted patient keeps admission-date tariff (§7); new admissions today use new version → test: PricingContext pinned per admission. |
| E18 | Attendant disputes bill line "Inj. X ×3" → line-item review against event trail (`medication.administered` ×3 with band scans); dispute recorded; credit note only if event missing → test: dispute view lists source events per line. |

### F. Consent, legal, MLC, minors, unconscious, death
| ID | Scenario → behaviour → test → ruling |
|---|---|
| F1 | Unconscious patient, no attendant, needs admission and surgery → two-doctor consent variant (§11.3), admission proceeds; consent record type `emergency_two_doctor`; guardian linked later → test: consent gate accepts variant with two doctor identities. |
| F2 | 16-year-old girl admitted, pregnant → POCSO intimation mandatory (§11.17), sealed-class, guardian sensitive-context override routes messages away from default guardian number → test: running bill WhatsApp to guardian is a neutral notice; police intimation register row exists. |
| F3 | Minor's guardian is not a parent (uncle) → guardian entity with authority scope (consents/bills); ID verified; consent signed by scoped guardian → test: consent by guardian lacking `consents` scope refused. |
| F4 | LAMA at 02:00: patient wants to leave, refuses to sign → LAMA record with `refused_to_sign`, two staff witnesses, risks explained in patient language (Hindi audio script logged); typed discharge `lama`; bill settled or dues approved; MLC re-intimation if MLC → test: LAMA without counselling record refused; witness identities present. |
| F5 | DAMA vs LAMA: doctor advises against (DAMA) vs patient leaves without informing (abscond) → distinct types; abscond triggers security search 30 min, recovery register → test: types produce different register rows. |
| F6 | MLC patient (assault) discharged → discharge re-triggers police intimation record; injury report in MRD custody; release only against logged requisition → test: `mlc.intimated` (NEW, re-intimation) on discharge. |
| F7 | Death on ward at 03:15, consultant unreachable → RMO declares; MCCD Form 4 signed by on-call signer chain (E-13); family wants body by 06:00 for before-sunset rites → SLA 6 h night; release triple-verify → test: chain resolves to on-duty holder; release within SLA in fixture. |
| F8 | Death is MLC (poisoning) → body under police custody; no release without police release memo; postmortem at government mortuary; hospital MCCD not issued for cause (cause pending PM) → test: release attempt without memo doc refused. |
| F9 | Brain-death query in ICU (potential organ donor) → THOA 1994 Form 10 committee protocol (deferred register noted §11.14); this module only provides the `death_declared` variant `brain_death_certified` with committee minutes link → owner ruling **O-8** on scope timing. |
| F10 | Family disputes death cause on MCCD → MCCD is a statutory form; amendment only by the certifying doctor with `report.amended`, original retained → test: amended MCCD keeps prior version. |
| F11 | Patient with DNR order codes → Code Blue not called by definition; DNR flag on chart/eMAR; death declared normally → test: DNR flag visible on bed tile. |
| F12 | Court summons original IPD file → certified copy released under BSA 2023 s.63 certificate (electronic record), originals never leave; court production logged with custodian identity → test: request class `court` requires order document; release watermark id. |
| F13 | Police ask verbally for a patient's record → refused; written requisition (BNSS 2023 s.94) required; MLC injury report path; spokesperson rule → test: police class without requisition doc refused. |
| F14 | Insurer asks for full file for claim → release limited to the claim's episode; patient consent on file (proposal-form authorisation) verified; DPDP purpose logged → test: release scope = episode docs only. |
| F15 | Patient requests erasure (DPDP §12) of IPD record → refused for clinical retention with reasoned response document within statutory TAT; legal-hold check → test: DSR fulfilled with `erasure_refused_retention` reason. |
| F16 | Unclaimed body 72 h → ladder rungs evented; police; municipal disposal; cold-storage charges to charity head → test: rung timestamps; cost-center posting. |
| F17 | Patient in restraints/suicide watch (noted §11.5) → nursing module owns; IPD shows flag on bed tile and blocks pass issuance beyond 1 attendant → test: pass count capped. |
| F18 | Death of a patient with sealed class (HIV) → MCCD cause coded per ICD without disclosing on public copies beyond statutory need; register custody rules → test: death register row honours seal on non-statutory surfaces. |

### G. Staff absence, overload, handover
| ID | Scenario → behaviour → test → ruling |
|---|---|
| G1 | Discharge coordinator on leave → cascade tasks route to role, not person; Coverage Resolver (T3) proposes ward in-charge as holder; duty manager approves → test: no task assigned to absent user after roster sync. |
| G2 | Consultant abroad; 6 fit-for-discharge patients wait for summary sign → co-sign delegation to RMO for summary (consultant countersign within 24 h) is a recommended default; without it, breach attributed to doctor → owner ruling **O-7**. |
| G3 | Night ward with one nurse for 30 patients → overload flag (`overload.flagged`) → duty manager; cascade non-urgent clearances deferred by definition (night profile) → test: night definition version has different SLAs. |
| G4 | Shift handover unacknowledged for 3 patients → escalation; transfers blocked for those patients until ack → test: transfer transition refused while handover open. |
| G5 | Pharmacy return counter closed at night; discharge at 22:00 → returns gate accepts nurse-logged returns with photo/count, pharmacist verifies next morning; credit posts on verification → test: cascade proceeds with `pending_verify` return. |
| G6 | MRD deficiency chased to a doctor who resigned → deficiency reassigned to HOD by rule after exit event (`exit.completed`); notarised note of unavailability → test: reassignment on exit. |
| G7 | Duty manager unreachable for a 90 % deposit escalation → ladder climbs to medical superintendent then owner (real-time matrix) → test: 3 rungs in fixture. |

### H. Equipment / physical failures
| ID | Scenario → behaviour → test → ruling |
|---|---|
| H1 | Bed broken (mechanical) with patient in it → bed status `occupied` + maintenance flag; patient moved to another bed same class (hospital-initiated, no tariff change); after release bed `blocked:maintenance` with AMC task → test: move reason `hospital_initiated`. |
| H2 | Oxygen point failure in a bay → utility telemetry; affected beds flagged `no_oxygen`; matcher excludes for oxygen-needing admissions → test: attribute filter. |
| H3 | Pass scanner at ward entry misreads photographed QR → signed token verify fails (`qr.signature_failed`); Pass Anomaly Watch counts per pass → test: photocopied QR fails. |
| H4 | Lift down; body transfer to mortuary delayed 2 h → SLA breach recorded with cause `transport`; family informed → test: breach cause enum. |
| H5 | Mortuary at capacity (mass casualty) → slots as registry resources; overflow to contracted facility logged with body tag chain → test: body location always resolvable. |

### I. Data quality, late-arriving, backdated
| ID | Scenario → behaviour → test → ruling |
|---|---|
| I1 | Consultant writes discharge summary 3 days after discharge → allowed, late-entry dual stamp, deficiency closes; patient copy re-sent with "amended" notice → test: `late_entry.flagged`. |
| I2 | Wrong patient's progress note entered in error → `correction.entered_in_error`: original retained, struck through, re-entered on correct chart; never deleted → test: both records exist with linkage. |
| I3 | Operation notes missing from an OT case → deficiency rule fires from `surgery.completed` without `report.signed(type: op_note)` → test: deficiency row auto-created. |
| I4 | Admission entered with DOA yesterday because clerk forgot → `occurred_at` claimed, flagged; census reconstruct not auto-changed — billing uses recorded admission unless duty manager approves backdated bed-day → test: backdated bed-day needs approval id. |
| I5 | ICD code chosen "dengue" but lab NS1 negative, clinical dx viral fever → Coding Suggester T2 flags inconsistency; coder decides; audit sample → test: suggestion with `evidence_conflict` label. |
| I6 | Discharge type recorded `normal` for a patient who later turns out absconded (found gone at 22:00 after fit declared) → type amendment by duty manager, evented, recovery register → test: type change keeps history. |
| I7 | Duplicate death registration filed to CRS → filing idempotency on (patient, death id); registrar ack stored → test: second filing refused. |
| I8 | Legacy paper file for a patient readmitted post-cutover → old-UHID cross-ref, physical file pointer, file pull task to MRD; scanned on demand into episode → test: search by old UHID resolves. |

### J. Fraud, leakage, gaming
| ID | Scenario → behaviour → test → ruling |
|---|---|
| J1 | Ward keeps a bed "dirty" 6 h to avoid an admission before shift end → turnover TAT KPI per ward with load; Turnover Dispatcher re-dispatch; digest lists beds dirty > 2 h → test: escalation at 90 min. |
| J2 | Attendant pass sold to a visitor outside → holder name/phone on pass (optional photo); scan shows holder; repeated scans from two entries within 2 min → anomaly → test: anomaly rule fires. |
| J3 | Clerk issues extra passes as favours → pass count per class enforced; extras need ward in-charge approval, evented, digest → test: N+1 without approval refused. |
| J4 | Doctor rounds recorded twice a day to double visit fee → policy: max chargeable rounds/day per consultant per config; second flagged to orphan/over-posting report → test: cap. |
| J5 | Ghost admission (no clinical events for 24 h) to hold a TPA sanction → Fraud Sentinel rule: admission without vitals/orders in 12 h → flag → test: rule fires. |
| J6 | Nurse marks meds returned but keeps stock → return requires pharmacist verification scan; variance report by ward → test: credit posts only on verification. |
| J7 | "Discharge before 11" gamed by declaring fit at 09:00 and holding patient in lounge till 17:00 → KPI measures fit→exit and exit time both; lounge dwell reported → test: lounge dwell > 3 h flagged. |
| J8 | MRD clerk releases a celebrity's record to a journalist → VIP class restricted; release requires two-person approval for confidential class; watermark identifies releaser; `export.recorded` → test: single-person release refused for VIP class. |
| J9 | Bed-day charged for a bed the patient never occupied (clerical hold) → bed-day requires `patient.admitted` scan event before first census → test: census ignores reserved-not-admitted. |
| J10 | Consultant pressures for a "package absorption" repeatedly → absorption counts per consultant in weekly digest → test: digest line. |
| J11 | Deposit receipt issued outside cashier session at ward → receipts only inside sessions (Plan 08); ward collection impossible; UPI QR at bedside links to counter session → test: receipt without session refused. |

### K. Privacy, sealed records, VIP, staff-as-patient
| ID | Scenario → behaviour → test → ruling |
|---|---|
| K1 | Bed board on ward TV shows names → public surfaces show bed no. + initials/alias only; full names on RBAC'd terminals → test: display endpoint returns no full names. |
| K2 | Running bill to attendant lists "Tab. Tenvir" (HIV) → sealed-class propagation masks line to a neutral description per policy; full line at counter to the patient → test: WhatsApp payload masked. |
| K3 | Attendant asks the ward nurse for diagnosis → nurse surfaces show a "disclosure policy" indicator: disclose-to-list set by patient at admission (DPDP consent) → test: disclosure list stored and shown. |
| K4 | Politician admitted; 40 staff open the record → access review flag (`access_review.flagged`) on non-treating access; alias on all boards → test: non-treating access count triggers review. |
| K5 | Discharge summary PDF WhatsApp'd to wrong number (typo) → number confirmation OTP step before first document send to a new number; document links are signed short-lived tokens via the public relay (E-1) → test: expired link returns nothing. |
| K6 | Insurer portal requests bulk discharge summaries → bulk-export governance: approval, purpose, watermark, `export.recorded` → test: bulk endpoint requires approval. |

### L. Language, literacy, accessibility
| ID | Scenario → behaviour → test → ruling |
|---|---|
| L1 | Bhojpuri-speaking attendant cannot read Hindi consent → consent screen offers Hindi audio read-out + staff-assisted flow (`navigation.assisted`); interpreter/witness identity recorded → test: consent record has `assisted_by`. |
| L2 | Patient copy of discharge summary in Hindi: drug names transliterated, schedule as pictograms (morning/afternoon/night icons) → template variants; T2 drafter produces English; Hindi rendered by deterministic template for meds + reviewed translation for narrative → owner ruling **O-9** (LLM Hindi translation of narrative allowed?). |
| L3 | Illiterate patient signs LAMA with thumb impression → thumb capture image + witness; audio counselling record → test: signature type enum `thumb`. |
| L4 | Blind attendant with pass → pass holder can be verified by phone OTP at gate instead of QR → test: alt verify path. |
| L5 | Deaf patient — discharge instructions → written + video (sign-language content licensed later); flag on record → test: accessibility flag on patient master. |

### M. Scale (10 beds → 610 beds)
| ID | Scenario → behaviour → test → ruling |
|---|---|
| M1 | Bed board for 610 beds over WebSocket → per-floor subscriptions, delta pushes; perf budget board render < 300 ms, delta < 100 ms → test: perf test with 610 beds, 50 subscribers. |
| M2 | 80 discharges/day; cascade boards per floor; clearance tasks 8×80 = 640/day → pooled department queues with claim; digest shows department clearance TAT p50/p90 → test: load fixture. |
| M3 | Midnight census over 610 beds in one transaction → chunked per floor, idempotent per (snapshot_at, bed) → test: rerun produces no duplicates. |
| M4 | 45 ICU beds with approvals via interrupting channel at 03:00 → approval urgency class; act-first-review-after when intensivist bedside → test: bypass evented. |
| M5 | MRD coding 80 episodes/day → Coding Suggester pre-codes; coder accepts/edits; backlog KPI; 4–6 coders → test: suggestion acceptance rate metric. |
| M6 | Event volume: `pass.scanned` 3,000/day → partitioned events (sweep #10); board read models not event scans → test: scan verify latency < 200 ms at volume. |

### N. Integration failures — ABDM, TPA, CRS, devices
| ID | Scenario → behaviour → test → ruling |
|---|---|
| N1 | ABDM care-context link for a discharge summary fails (gateway down) → outbox retry with backoff; summary already delivered by WhatsApp; `abdm.link_failed` (NEW) task after 24 h → test: retry then task. |
| N2 | Patient has no ABHA → nullable; offer creation at discharge desk (not blocking); consent for HIP linking per ABDM consent manager → test: discharge completes with null ABHA. |
| N3 | CRS portal down for 21-day death registration deadline → filing task with statutory deadline countdown; manual filing path with ack number entry → test: deadline breach alerts MRD Officer at T-3 days. |
| N4 | NHCX claim needs ICD-10 + package code at discharge but coding SLA is 7 days → provisional coding at fit-declared (E-31 capture at order/pre-auth) by Coding Suggester + doctor confirm; final coding may amend → test: claim payload uses provisional codes flagged provisional. |
| N5 | TPA portal returns final approval by email only → TPA desk records approval manually with document; cascade state advances → test: manual approval requires attachment. |
| N6 | Wristband printer vendor driver update breaks ZPL → print service is an edge service with heartbeat; `interface.down`; paper band path → test: heartbeat miss alert. |
| N7 | Diet module not yet built when IPD ships → diet orders as generic order type with kitchen worklist print; upgrade path when diet module lands → test: order_type `diet` accepted. |
| N8 | Mother's ABDM care context must also link baby (own UHID) → two contexts; baby's ABHA via parent flow → test: two link attempts. |

**Row count: 116.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 09:00 — 14 planned discharges, TPA portal down, consultant stuck in OT.** 08:30 rounds declare 14 fit; cascade instances start. 08:45 TPA portal returns 502: six cashless patients enter `awaiting_payer_final_approval` — clock attributed to payer, not the hospital. Clearance Chaser nudges pharmacy (returns) and billing; six self-pay bills issue by 10:30. Consultant in OT till 13:00: summaries drafted by T2 sit unsigned; under O-7 default RMO co-signs and consultant countersigns by 24 h; else breach attributed to doctor. Discharge lounge takes 5 patients whose beds Turnover Dispatcher releases at 11:00; board shows "cleaning" honestly. 13:30 TPA approvals arrive by email: TPA desk records manually with attachment (N5). Audit afterwards: 14 instances with per-state durations attributed (payer 4 h 40, hospital 1 h 10, doctor 3 h). Owner digest: discharge-before-11 = 5/14 with breakdown by attributed cause — the number is diagnostic, not a stick.

**6.2 Wednesday 02:10 — server down, two admissions, one death.** Duty manager declares downtime (floor: all). ER admits a Red on paper form serial ADM-0412; whiteboard bed board; wristband handwritten on paper band serial WB-0087. 02:40 death on ward 3: RMO declares on paper; on-call MCCD signer paged via PBX; body tag from kit (serial BT-0012), mortuary register hand-written; family told release proceeds regardless of billing. 05:30 server back: backfill screens create admission (`occurred_at` 02:15, `recorded_at` 05:40), death (`patient.deceased` 02:40), body tag token minted and physically attached over paper tag; all pass scans during outage entered as `manual_register`. Reconciliation: 3 form serials consumed = 3 backfilled; census at 00:00 reconstructed from history (C5). Audit trail: `downtime.declared/ended`, every backfilled event dual-stamped and `late_entry.flagged`, body release at 07:00 with triple-verify done live.

**6.3 Friday 18:00 — bus crash, 22 casualties, disaster mode.** ER flips disaster; surge bed board; 8 need admission, 3 ICU. Tentative ICU holds for two electives pre-empted (`reservation.preempted`, surgeons notified); ward 4 converted with 6 surge beds (`general_surge`, expiry 72 h). All casualties auto-MLC; DIS-tags; wristbands print from DIS-tag with UNK-UHID. Passes: security issues 1 pass/bed max, visiting suspended by surge rule. Deposits waived by disaster definition (no payment gate); billing posts to `disaster_pending` payer tag for later attribution (state scheme/insurer/charity). Two deaths: brought-dead register (ER) vs hospital-death register kept separate; police intimation batch. Switch-off next morning: every DIS-tag resolves to full registration or unknown-patient ladder; surge beds retire when empty. Agents: forecaster suspended (surge windows excluded from baselines), Turnover Dispatcher at T4 keeps going, Drafter idle. Audit: `disaster.declared`, each pre-emption with cause, each override with authoriser.

**6.4 Sunday — VIP + MLC + fraud in one hour.** 11:00 MLA's father admitted; VIP flag → alias "Bed 512" on boards; 40 staff attempt to open the chart; 31 non-treating accesses flagged for review. 11:20 an assault victim (MLC) in the next room: police constable asks the ward clerk for "the file" — refused; requisition path shown; spokesperson rule. 11:40 an attendant of a third patient presents a photographed pass on a phone: signature verify fails (`qr.signature_failed`), security refuses, Pass Anomaly Watch logs; the original holder's pass is revoked and reissued at the desk. 11:50 the VIP's PA offers cash ₹3 L deposit: cash-limit block; UPI/NEFT. Audit shows: access review batch, refused police request with reason, one anomaly, one blocked cash receipt — all evented, none requiring the owner at the time; the owner sees the VIP access-review line in real time (break-glass class) and the rest in the 8 a.m. digest.

**6.5 Night nurse no-show, 36-bed ward, three fit-declared, one absconds.** 20:00 roster shows a coverage hole (`bench.gap_flagged`); Coverage Resolver proposes float nurse; duty manager approves. 22:15 patient in bed 17 (fit for morning discharge, dues pending) not in bed; 30-min rule → security search; not vulnerable → not Code Yellow; 23:00 duty manager declares abscond: discharge type `absconded`, passes revoked, recovery register with ₹9,400 dues, MLC? no. Bed released to dirty. Morning: attendant returns saying they went home to fetch money — duty manager can convert to `normal` with amendment history (I6) and dues settled. Audit: search rungs timestamped, type amendment with actor.

**6.6 Wristband printer + WhatsApp both down on a 30-admission day.** Print service heartbeat missed → `interface.down`; paper bands from kit with serials; eMAR accepts two-person manual verify (D1) — flagged as degraded on the ward tile; ICN informed because band-scan compliance will dip (KPI carries the degraded-window annotation so nurses are not penalised). Running bills fall to SMS then desk flag; attendants collect printed interim bills. Recovery: bands printed at ward stations; each paper serial mapped to a token; scans compliance report shows the window shaded.

**6.7 MRD: court order, insurer bulk request and a resigned surgeon's 40 unsigned op notes in one week.** Court order for a 2024 (legacy paper) file: old-UHID cross-ref → physical file pull task → scan batch → certified copy with BSA s.63 certificate, watermark, release logged; original stays. Insurer bulk request for 120 summaries: bulk-export governance, approval, purpose, watermark. Deficiencies: surgeon exited → reassigned to HOD who attests from OT records with late-entry stamps; NABH deficiency-rate KPI shows the spike with cause `staff_exit`. Audit: three release rows, one bulk export, 40 deficiency reassignments in one batch event.

---

## 7. Compliance, audit & statutory surfaces

| Statute / standard | Surface in this module |
|---|---|
| Registration of Births and Deaths Act 1969 (+ 2023 amendment; CRS portal) | Death registration Form 2 (institutional informant) within 21 days; birth Form 1 (maternity feeds, MRD files); MCCD Form 4/4A per WHO/ORGI format; certificates issued by registrar, hospital issues MCCD + discharge/death summary |
| NMC (erstwhile MCI) Code of Ethics Regulations 2002 reg 1.3 | Indoor records ≥ 3 y; records to patient/authorised attendant within 72 h of request; this module's 72-h TAT clock |
| Clinical Establishments Act 2010 + state rules | Admission/discharge/death registers in prescribed formats (E-21 certified print-and-bind where required); display of charges |
| NABH 5th/6th ed. (AAC, COP, MOM, PRE, IMS, ROM) | admission criteria documented, transfer handover, discharge summary contents (reason, findings, dx, condition, meds, follow-up, when to return), MRD deficiency audits, open/closed record review, 24-h death certification, mortality review committee feed, ALOS/bed occupancy indicators |
| DPDP Act 2023 | consent at admission (disclosure list, guardian §9), purpose-bound releases, DSR register with TAT, erasure bounded by retention, processor agreements for LLM (Class 1 lane), access logs |
| Bharatiya Sakshya Adhiniyam 2023 s.63 | electronic record certificate for court copies; QR verify view (sweep #4) |
| BNSS 2023 s.94 / MLC practice | police requisition before release; MLC register; re-intimation on discharge/death/abscond; injury reports in MRD custody |
| Transplantation of Human Organs Act 1994 | brain-death Form 10 (deferred protocol; hook only) |
| POCSO 2012, MTP Act, HIV Act 2017, PCPNDT | sealed classes propagate to bed board, bills, summaries, releases |
| BMW Rules 2016 | placenta/body-fluid disposal links; mortuary waste |
| Consumer Protection Act 2019 | 10-y retention default (litigation window), line-item bill dispute view |
| GST/Income-tax 269ST, 40A(3) | deposit cash limits; refunds; 8-y book retention inherited by event log |
| CERT-In directions | access logs 180 days minimum; cyber-incident path (§11.14) |
| ABDM (HIP/HIU, consent manager) | care-context linking of discharge summary; ABHA nullable |

**Registers (tables, §4):** admission, discharge, death (institutional), brought-dead (ER), MLC, mortuary, LAMA/DAMA, abscond/recovery, records-release, DSR, legal-hold, unclaimed-body, birth/stillbirth (maternity), CRS filing log, file-movement, deficiency, coding.

**Consent forms (templates versioned, Hindi/English, QR):** general admission consent + disclosure list · financial counselling/deposit acknowledgment · package terms · class change (with room-rent-cap warning) · payer switch · LAMA/DAMA · high-risk consent (OT-owned) · record release authorisation · ABDM linking consent · body-release acknowledgment · attendant pass terms.

**What NABH / an inspector asks:** ALOS and occupancy by ward; discharge summary completeness sample; deficiency rate and closure; time from death to certificate; records-request TAT; register printouts; transfer handover compliance; mortality review minutes; consent sampling; access logs for a VIP; retention policy document; legal-hold list. Every one is a saved query over the tables above, exportable with `export.recorded`.

**DPDP data classes:** Class 0 (operational, de-identified counts) — census, KPIs; Class 1 (tokenised clinical) — drafter/suggester payloads; Class 2 (identified PHI) — never leaves; sealed sub-class — treating-team carve-out only.

---

## 8. Staff KPI & KRA

All formulas target the KPI formula registry (metric id + formula + semver); every rate shown with load context; never auto-punitive.

**Admission clerk (#6):** `ipd.adm.request_to_bed_p90` = p90(bed.assigned − admission.requested) [load: requests/shift, occupancy %] · `ipd.adm.wristband_before_transport` = admissions with wristband.issued before task.accepted(porter)/admissions · `ipd.adm.deposit_completeness` = paid ≥ schedule at admit+2 h /self-pay admissions · `ipd.adm.pass_overissue` = passes > class N without approval (should be 0) · `ipd.adm.override_admissions` (visible, contextual). Gaming: pre-creating requests after bed found → formula uses first `admission.requested` from OPD/ER source event, not clerk entry.

**Ward nurse (#20) / in-charge (#23):** `ipd.ward.handover_ack_rate` · `ipd.ward.transfer_checklist_complete` · `ipd.ward.band_scan_compliance` (degraded windows excluded) · `ipd.ward.dirty_to_clean_p50` (with housekeeping) · `ipd.ward.abscond_rate_per_1000_bed_days` · `ipd.ward.pass_scan_exceptions` per 100 scans. KRA: right bed, right band, handed over, released honestly.

**Consultant / RMO:** `ipd.doc.fit_to_summary_signed_p50` · `ipd.doc.rounds_recorded_per_patient_day` (max 1 chargeable) · `ipd.doc.deficiency_closure_within_7d` · `ipd.doc.mccd_within_sla` · `ipd.doc.readmission_30d_related` (diagnostic, case-mix shown) · `ipd.doc.alos_vs_expected_los` (by DRG-like grouping, later). Gaming: signing empty summaries → completeness checker (required sections non-empty) counts as unsigned.

**Discharge coordinator (NEW):** `ipd.dc.fit_to_exit_p50/p90` (hospital-attributed time only) · `ipd.dc.discharge_before_11_pct` (with fit-declared-previous-evening denominator) · `ipd.dc.clearance_breaches_by_dept` · `ipd.dc.lounge_dwell_p90`. KRA: the cascade runs and every minute is attributed.

**Billing executive / TPA desk:** `ipd.bill.final_bill_tat_from_last_clearance` · `ipd.bill.orphan_charges_at_discharge` · `ipd.tpa.enhancement_lead_time` (before limit hit) · `ipd.tpa.payer_hold_hours` · `ipd.bill.refund_of_excess_within_24h`.

**Housekeeping (#32):** `hk.turnover_p50 < 45 min` · verification 100 % · isolation deep-clean compliance. **Security (#34):** pass-scan compliance at ward entry > 95 % · sig-fail rate · body-release triple-verify 100 %.

**MRD Officer / coder / deficiency:** `mrd.request_tat_72h_pct` · `mrd.deficiency_rate` = files with ≥1 deficiency/closed files · `mrd.deficiency_closure_p50_days` · `mrd.coding_backlog_days` · `mrd.coding_accuracy_audit` (sample re-code agreement) · `mrd.crs_filing_within_21d` · `mrd.file_overdue_checkouts` · `mrd.suggestion_acceptance_rate` (agent health, not staff).

**Department KPIs (owner):** ALOS (by ward, payer, case-mix), bed occupancy % (occupied/available, reserved-empty shown separately), **bed turnover interval** = Σ(available→occupied gaps)/discharges, discharge-before-11 %, 30-day readmission % (related), 48-h ICU readmission, deficiency rate, records TAT, LAMA %, mortality (gross/net > 48 h), unclaimed-body count, pass anomalies.

**Owner 8 a.m. digest lines:** census & occupancy by class (with reserved-empty and blocked counts + reasons), admissions/discharges/deaths yesterday, discharge p50 fit→exit split hospital/payer/family/doctor, deposit-exhausted list with ladder stage, overrides (admission/pass/absorption) by authoriser, deficiency backlog > 7 d by doctor (count only), CRS filings due in 3 days, records requests breaching, agent health (drafter accept-rate, kill switches).

---

## 9. AI agents & the copilot

| Name | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval/guardrail | DPIA class | Ships |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Turnover Dispatcher | automation | T4 | bed → dirty; housekeeping roster | task dispatch/re-dispatch, verification chase | none (ops) | supervisor manual assign | per-agent | n/a | dispatch fairness report | 0 | Plan 20 (w/ 19) |
| Deposit Ladder | automation | T1 | receipts ledger vs schedule; ICU burn | 75/90 % notices, interim-bill task, escalation | none | billing desk manual | per-agent | n/a | no notice during sealed/deceased states | 0 (amounts only) | Plan 20 |
| Clearance Chaser | automation (SLA Chaser instance) | T1 | cascade state timers | nudges, escalation rungs | none | coordinator board | global SLA | n/a | anti-fatigue: batch non-critical | 0 | Plan 21 |
| Census Snapshotter | automation | T0 | 00:00 IST clock | census rows, bed-day charges | none | reconstruct job | per-agent | n/a | idempotent per bed | 0 | Plan 20 |
| Discharge Summary Drafter | agent | T2 | `discharge.fit_declared`; tokenised fact sheet: dx, procedures, key results trend lines, meds reconciled, course notes; Lens contract (typed cited claims) | draft Composition sections, Hindi patient-copy narrative (O-9) | consultant edits + signs (`report.signed`) | template pre-fill editor | per-agent + global | model id, prompt ver, input/output hash into event + signed PDF | citation guard drops uncited claims; scrubber both ways; shadow mode first; QA sampling `draft.qa_sampled` | 1 | Plan 21 (post-12a Class-1 lane) |
| Discharge-Readiness Predictor | agent | T0 | daily: LOS vs expected, orders trend, vitals stability flags (deterministic features) | ranked "likely fit in 24 h" list to coordinator/consultant | none (observe) | rounds | per-agent | model id in report | payer-blind/VIP-blind rule (D-37); precision tracked | 0/1 | Plan 21 (after 90-day baselines) |
| Bed Demand Forecaster | agent | T0 | census history, OT list, ER arrivals, seasonality | next-72-h occupancy by class, waitlist ETA | none | clerk judgment | per-agent | report stamp | surge windows excluded; MAPE tracked | 0 | Plan 20+ (baselines) |
| MRD Deficiency Chaser | automation | T1 | `deficiency.flagged` timers | doctor nudges, HOD escalation at 7 d, reassignment on exit | none | MRD manual list | per-agent | n/a | batch to daily digest per doctor | 0 | Plan 22 |
| Coding Suggester | agent | T2 | closed episode: tokenised dx text, procedures, summary; licensed ICD-10 terminology tables | ranked ICD-10/procedure/NHCX package code suggestions with cited lines | coder accepts/edits (`episode.coded`) | manual coding | per-agent + global | stamped on `mrd_codes` | acceptance rate, audit re-code agreement; never auto-finalises | 1 | Plan 22 |
| Pass Anomaly Watch | automation | T0 | pass.scanned stream | anomaly report to security/Fraud Sentinel | none | — | per-agent | n/a | rule-only | 0 | Plan 20 |
| Leakage Auditor (existing) | automation | T0 | census/device-day/telemetry triangle | orphan & leakage flags | none | — | existing | n/a | existing | 0 | Plan 20 extension |

**Deterministic-first rule applied:** deficiency detection, cascade chasing, census, deposit ladders, pass anomaly are rules; only summary drafting, coding suggestion, readiness prediction and demand forecasting use inference, and none acts.

**Presentation lanes.** Lane 1 (hand-built): admission desk (keyboard-first), bed board (floor/ward, drag-to-assign with rule feedback), discharge cascade board (per floor), security scan view (phone), MRD release desk. Lane 2 (schema-generated worklists): clearance queues per department, deficiency worklist, coding worklist, mortuary register, file-movement, DSR register. Lane 3 (conversational copilot, clinical roles last): "which beds free at general female?", "why is bed 312 still dirty?", "draft the summary for 512", "what blocks discharge of 207?" — all answered from the Journey Feed read models under the asker's permissions.

**Journey Feed contributions:** admission request, bed assigned/transfer, deposit stages, class changes, passes issued/revoked, fit declared, each clearance, summary draft/sign, final bill, exit, and MRD milestones (assembled, coded, deficiency) render as structured posts; agent posts are always labelled and cite their events.

**Prompt inputs (Drafter, concrete):** fact-sheet lines with ids: L-dx (coded problems), L-proc (surgery.completed payloads), L-lab (trend triplets for abnormal analytes), L-img (signed report impressions), L-med (reconciled discharge meds: salt, dose, frequency, duration), L-course (RMO daily note summaries, scrubbed), L-vitals (admission vs discharge), L-followup (consultant's orders). Output schema: sections with claim ids citing line ids; Hindi patient-copy generated only from the signed English (never from raw notes).

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One beep context**: wristband scan opens the patient on any ward tablet; pass scan resolves in < 200 ms with green/red full-screen; body tag scan opens release checklist.
- **Bed board keyboard/drag with rule feedback**: illegal drops explain the rule (gender/isolation/class) inline; matcher returns top-5 ranked; assignment ≤ 3 keystrokes.
- **Pre-filled forms**: admission from OPD/ER encounter (payer tag, consultant, dx, referral) — zero re-typing; deposit schedule auto from class; consent packs printed as one job with QRs.
- **TAT clocks**: cascade board shows per-patient elapsed with attributed segments (hospital/payer/family/doctor) colour-coded; clearance tiles per department.
- **Evening pre-clearance**: fit-declared-tomorrow flag on evening rounds starts pharmacy/billing pre-checks at 20:00 so 11 a.m. is achievable.
- **Discharge lounge** as a registry `room` with capacity; bed released at lounge entry.
- **Printing**: wristband (thermal, ZPL), passes (card printer or thermal wristband stock), gate pass, interim/final bill, summary (English + Hindi), MCCD, certificates — all with signed QR verify view.
- **Mobile**: security phone verify, consultant phone sign-off for summaries (with 2FA), duty-manager approvals.
- **Voice**: ward-tablet dictation for progress notes (on-device/edge STT preferred; cloud only under Class-1 lane) — lawful, but deferred to the nursing module.
- **Perf budgets**: board < 300 ms initial, delta < 100 ms; scan verify < 200 ms; summary editor open < 1 s; census job < 60 s at 610 beds.
- **Accuracy**: every bed-day derives from census rows + class ledger (two independent sources reconciled nightly); every charge from an event; interim bill = ledger read model.
- **Auditability**: cascade instance = the audit; attributed holds; late-entry stamps; provenance in signed PDFs; release register with watermark ids.

---

## 11. Integrations, devices & dependencies

| Item | Detail |
|---|---|
| Wristband printers | Zebra ZD510-HC / HC100 or TSC equivalents, ZPL over LAN; per ward station (§13 ₹25–40k each); edge print service with heartbeat (`interface.down`) |
| Pass printing | thermal wristband stock or PVC card printer (Evolis/HiTi) at admission desk; visitor QR on paper acceptable |
| Scanners | USB 2D at desks; Android phones with camera for security; signed token verify API |
| Bed board displays | 43" TVs per nursing station + player (public alias view); tablets 10" per ward |
| Mortuary | cold-storage cabinets with temperature telemetry (MQTT gateway, shared with oxygen/OT sensors) |
| Nurse-call | bought hardware → tasks in ward pool (§11.18); interface via dry-contact/IP gateway |
| ABDM | HIP care-context link via ABDM gateway (M2/M3 APIs), consent manager; NHCX for claims (TPA phase) |
| CRS | crsorgi.gov.in — no public API; manual filing task with ack capture; watch for state e-registrar APIs |
| TPA portals | email/portal today; NHCX later; pre-auth object manual entry |
| Kitchen | diet orders printed/production list until diet module |
| Protocols | HL7 v2 ADT A01/A02/A03/A08 outbound feed to PACS/LIS (Orthanc, LIMS) — IPD is the ADT source for the hospital; FHIR Encounter/Composition/Bundle for ABDM |
| Edge-service rule | printers, scanners, cold-storage sensors talk to edge services; core never talks to a device |
| Depends on | Plan 13 registry (shipped), Plan 08 receipts ledger, Plan 10 notifications, Plan 11 modes/downtime, Plan 12a agent runtime (drafter/suggester), Plan 14 procurement (returns/credit), Plan 16 pharmacy (returns, indents), Plan 19 housekeeping (turnover), nursing module (eMAR/handover), OT (Plan 15 recovery bays; full OT later), diet module, TPA phase |
| Events consumed | patient.registered/merged, visit.opened, er.disposition_decided, ot.booked/surgery.completed, handover.completed, medication.administered/returned (material.returned), task.completed/verified, payment.received, preauth.*, isolation.flagged, roster.synced, downtime.declared/ended, resource.status_changed |

---

## 12. Buy vs build, hardware & rough INR budget

**Build:** everything in §3–§4 (it owns tables and workflows). **Buy:** printers/scanners/displays, nurse-call, mortuary cabinets, ABDM sandbox → production integration (build thin), ICD-10/SNOMED terminology licence (§9 v4.6 line), scanning service for legacy paper (outsourced bulk scan ₹1–2/page; ~10-bed history ≈ 20–50k pages ≈ ₹0.5–1 L), PVC card printer.

| Item | Day-one (10–60 beds) | 610-bed |
|---|---|---|
| Wristband printers | 2 × ₹35k | 25 × ₹35k ≈ ₹8.75 L |
| Wristband/pass consumables | ₹3–5/band; ₹10k/mo | ₹1.5–2 L/mo |
| Security phones/scanners | 3 × ₹15k | 30 × ₹15k |
| Ward tablets | 4 × ₹20k | 60 × ₹20k = ₹12 L |
| Bed-board TVs + players | 2 × ₹35k | 25 × ₹35k |
| Mortuary cabinet (2-body) + telemetry | ₹2.5–4 L | 6–12 body ≈ ₹8–15 L |
| PVC card printer | ₹60k | 3 × ₹60k |
| Legacy scanning | ₹0.5–1 L | — |
| Terminology licence | per §19 decision | — |
| ABDM integration effort | in-plan | — |
| **Rough total** | **≈ ₹5–8 L** | **≈ ₹35–50 L** (excluding LAN fit-out §13 flag) |

---

## 13. Owner rulings needed

- **O-1 Bed-day convention.** Recommend: calendar-day, midnight census, 12-noon checkout + 2 h grace, minimum 1 day, admission within 2 h of midnight not double-charged, hospital-attributed cascade delay never charges the extra day. Why: corporate standard, defensible in disputes, computable from census.
- **O-2 Deposit shortfall policy.** Recommend: admit regardless; ladder on paid amount; waiver above 50 % of schedule needs duty-manager approval. Why: care-never-stops is locked; money exposure needs a named approver.
- **O-3 Bed block/reserve TTLs.** Recommend: tentative 30 min, elective reservation 24 h renewable by ward in-charge, blocks ≤ 24 h renewable, all in digest. Why: closes the "reserved" abuse door without banning legitimate holds.
- **O-4 Gender segregation for transgender/non-binary patients.** Recommend: self-identified gender governs; single room at booked tariff when shared placement is contested; dignity reason code. Legal exposure (Transgender Persons Act 2019) — owner's call.
- **O-5 Discharge-before-11 as target vs policy.** Recommend: KPI target 60 % by month 6, never a gate; evening fit-declared flag drives it. Why: gates create lounge parking (J7).
- **O-6 PMJAY/scheme conversions mid-stay.** Recommend: allow with eligibility check; earlier self-pay lines non-refundable unless scheme rules require. Money + legal.
- **O-7 Summary sign delegation.** Recommend: RMO signs with consultant countersign ≤ 24 h; consultant remains author of record. Legal exposure — owner + medical director.
- **O-8 Brain-death/THOA scope.** Recommend: hook only in Plan 21; full committee protocol in the Quality/committee pack. 
- **O-9 LLM Hindi translation of the patient copy.** Recommend: meds/schedule/warning-signs from deterministic templates; narrative translated by the drafter but marked "translation — English signed copy governs", QA-sampled. Legal/policy.
- **O-10 Retention schedule.** Recommend: IPD 10 y, minors 18+10, MLC/death/POCSO indefinite, OPD 5 y; counsel confirms per state CEA rules. Legal.
- **O-11 Records-release fee & format.** Recommend: patient copies free first time (NMC 72 h), ₹ per page after; insurer/court certified copies charged per schedule; digital first. Money.
- **O-12 Rounds fee cap.** Recommend: 1 consultant visit/day chargeable per consultant, cross-consult first visit chargeable, same-day repeat free (§11.4 map 5), ICU 2/day. Money.
- **O-13 Attendant policy for ICU lounge and general wards.** Recommend: general 1 pass, pass-hours 07–21; private 2 passes, one may stay; ICU lounge 2, visiting slots 2×30 min. Policy.
- **O-14 Discharge lounge and same-day dues.** Recommend: lounge capacity = 5 % of beds; dues at discharge allowed only via Plan 08 dues approval path. Money.

---

## 14. Plan sketch

Roadmap consistency: 14 procurement → 15 mini-OT → 16 pharmacy → 17 LIMS → 18 radiology ∥ 19 housekeeping. Proposed new:

- **Plan 20 — IPD core: ADT, bed board, class ledger, wristbands, passes, census.** Sections: T1 tables + bed classes + tariff link (§4A item 1) · T2 admission/reservation/transfer workflow definitions · T3 matcher (pure function, what-if capable per note 9) + reservation TTLs · T4 bed board (Lane 1) + WebSocket deltas + public alias view · T5 wristband/pass signed tokens + print edge service + scan verify API · T6 deposit ladder + payer periods + pre-auth sanction object · T7 census snapshotter + bed-day posting + reconciliation · T8 registers + HL7 ADT outbound · T9 downtime kit forms + backfill screens · T10 KPIs into the formula registry. Gates: Plan 13 T6/T7 deployed; Plan 08 dues ruling; O-1..O-4, O-12, O-13 ruled; nursing handover checklist minimum (could be a thin definition inside Plan 20 if nursing module not yet started).
- **Plan 21 — Discharge cascade, summaries, deaths, LAMA/abscond.** Sections: cascade definition with attributed holds · clearance queues (Lane 2) · Drafter (post-12a, Class-1 gates: DPIA, evals, shadow) · final bill/refund integration · gate pass/exit · death-to-release + mortuary register + MCCD · LAMA/DAMA/abscond registers · discharge lounge · ABDM care-context link · readiness predictor (baselines gate). Gates: Plan 20 live 30 days; Plan 16 returns interface; 12a Class-1 lane; O-5, O-7, O-8, O-9, O-14.
- **Plan 22 — MRD.** Sections: file assembly + deficiency rules + chaser · coding worklist + Suggester + terminology tables · request/release desk with classes, consent, watermark, BSA certificate · retention/legal hold/disposal · physical file movement + legacy scanning + old-UHID pointers · CRS filings + certificates · open/closed record audits · DSR integration. Gates: Plan 21; terminology licence (§19); O-10, O-11.
- **Plan 23 — Command Centre watchers (IPD-era, roadmap note 10)** — census/discharge-pipeline read models + watcher automations + Bed Demand Forecaster; after 90 days of Plan 20 data.

**Must be true before authoring Plan 20:** Plan 13 `0033` deployed and `opd_rooms` gone; registry bed-kind status vocabulary agreed (available/tentatively_reserved/confirmed/occupied/dirty/cleaning/verified_clean/blocked/retired); Plan 08 dues/advance rulings final; nursing module boundary decided (who owns handover checklist tables); wristband printer model bought for print-service development.

**Negative-space question — what absence is a signal here?** An admitted patient with **no round recorded in 24 h**, no vitals in 8 h, no order in 24 h (ghost or neglected); a bed **dirty with no task**; a fit-declared patient with **no clearance activity for 60 min**; a discharge with **no summary signed in 72 h**; a death with **no MCCD in 6 h** or **no CRS filing at day 18**; a closed episode with **no ICD code at day 7**; a pass that **never scanned** (issued to no one) or a ward whose **entry scans are zero for a shift** (scanner dead or security not scanning); a payer hold with **no TPA activity for 4 h**; a record request with **no decision at 48 h**. Each becomes a watcher rule, not a dashboard.

**Staff edge-case interview questions (department head / ward in-charge / MRD):**
1. When the wanted class is full at 21:00, what do you actually do today, and who decides the tariff?
2. How many "reserved" beds exist right now and who reserved them?
3. What happens at 12:05 when a patient is packed but billing is not ready — who eats the extra day?
4. When a family asks to wait for an auspicious muhurat, do you release the bed?
5. How do you handle a body release when the bill is unpaid — what has actually happened before?
6. What is the real time from death to MCCD at night, and who signs when the consultant is unreachable?
7. Which departments are slowest to clear a discharge, and why (pharmacy returns? physio? diet?)?
8. How do attendants get extra passes today, and how are lost passes handled?
9. Who has ever asked for a record informally (police, relatives, employers) and what was given?
10. Which doctors' files are chronically incomplete and what has worked to close them?
11. How are legacy paper files indexed, and what fraction cannot be found?
12. When a patient absconds with dues, what recovery actually happens?
13. How do you segregate genders in the general ward when it is 90 % full of one gender?
14. What do ICU families demand that you cannot give (bedside stay, phone updates)?
15. How often are death registrations late to the municipality and why?

---

## 15. Open questions & risks

- **Nursing module boundary.** Handover checklist, eMAR and vitals are prerequisites for transfers and the cascade; if the nursing module is sequenced after IPD, Plan 20 must carry a minimal handover definition and later hand it over — a two-homes risk.
- **Reservation engine ownership.** Roadmap note 15 says reservations run as workflow instances; whether the generic reservation definition lives in the kernel (shared with OT) or IPD is undecided. Recommend kernel definition, IPD/OT pre-emption rules as definition data.
- **Bed-class table home.** `ipd_bed_classes` vs a kernel `resource_classes` table — Plan 13 §4A ruled the link is IPD's; if OT/lab need classes with tariffs, revisit.
- **HL7 ADT outbound** is implied by PACS/LIMS integration but no plan owns it; propose Plan 20 T8.
- **CRS/municipal filing** has no API; the 21-day statutory clock relies on a manual task — risk of late filings at scale.
- **Discharge Drafter cost/latency** under the Class-1 lane: measured provider latency variance (0.8–60 s) means the draft must be pre-generated at fit-declared, not on editor open.
- **Terminology licence timing** (ICD-10 is free from WHO; SNOMED via NRCeS free for India; NHCX package maps evolving) — Coding Suggester quality depends on the loaded tables.
- **Room-rent-cap proportionate deduction** math for insurance counselling needs each payer's policy terms — TPA-phase data; Plan 20 shows a generic warning.
- **Electronic register legality** per state CEA rules (E-21) — counsel opinion pending; print-and-bind fallback assumed.
- **Mortuary as scope** — the §9 catalog lists a mortuary register module; this document folds it into Plan 21 as a register + resource slots; if the owner wants a fuller mortuary (autopsy, embalming) it is a separate plan.
- **Day-care (Plan 15) recovery bays and IPD beds share the bed kind** — the matcher must exclude day-care-class beds from inpatient assignment unless converted; confirm with Plan 15's status vocabulary.
