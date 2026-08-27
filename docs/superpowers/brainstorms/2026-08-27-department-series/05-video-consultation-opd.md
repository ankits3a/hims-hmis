# 05 — Video Consultation OPD / Teleconsultation & Remote Follow-up — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED.
**Series:** Department Brainstorm & Planning (2026-08-27) · **Author:** planning agent, from spec v4.8 + S10 + copilot design + roadmap + Plan 13.

**Executive summary.** Teleconsultation is *the OPD encounter spine run over a video link* — a fourth encounter `type` (`teleconsult`) on `opd_encounters`, with the same doctor, the same prescription record, the same billing counter, the same accrual ledger and the same follow-up window machinery that already serve the walk-in OPD. It is NOT a separate product, NOT a patient app, NOT a video platform we build, NOT tele-ICU or teleradiology (those are §11.15/§11.7 telemetry and reporting boundaries with their own modules), and NOT a way around the Telemedicine Practice Guidelines 2020 (TPG). What it adds: a *pre-paid, identity-verified, consent-recorded, prescribing-restricted* variant of the consult, a remote follow-up *programme* for post-discharge patients, and the home-side of the loop (home lab collection, pharmacy delivery hand-off, home vitals). The three hardest problems: **(1) legality of what leaves the screen** — TPG's first-consult vs follow-up rules and its List O/A/B/Prohibited drug classes have to be enforced *deterministically at prescription issue time*, not left to the doctor's memory; **(2) identity and consent over a camera** — the patient, the caregiver, the minor's adult and the doctor's own registration number all have to be provably who they claim, under DPDP, with recording as the exception not the rule; **(3) money and no-shows at a distance** — pay-before-consult through a payment link, refund ladders for dropped calls and doctor no-shows, fee splits for a doctor sitting at home, and TPA/international non-coverage — all landing on an append-only bill.

---

## 1. Frame — what exists, what is locked, what this document adds

**Exists (built, Phase 1):** `opd_encounters` with `type` as an open text enum — `'opd'` now, `'ipd' | 'er' | 'teleconsult'` reserved (schema header, `kernel/db/schema/opd.ts`); status mirrors a `workflow_instances` row (spec §10.2) · visit-type auto-detection new/revisit/renewal with the 7-day follow-up window and doctor extensions 15/21/30, extension caps per doctor per month (§11.1, §11.19-C-14) · `opd_prescriptions` with formulary-first safety checks and reason-coded overrides (Plan 16a; copilot design law "checks at issue time inside the transaction") · billing counter: invoices append-only, tenders incl. UPI with UTR capture + T+1 reconciliation, credit notes, approval-gated refund vouchers (§7, Plan 08) · Plan 10 notifications gateway (WhatsApp/SMS templates, quiet hours 21:00–08:00 IST, deceased suppression, language preference) — **note: Plan 10 is a *messaging* gateway; there is no online payment gateway integration in the repo today** · Plan 09 accrual ledger (fee splits, referral commissions accruing on `payment.received`, reversing on refund) · global search, RBAC actor fabric with agents as actors, sealed/restricted record classes (11h) · operating modes / downtime kit (11c).

**Locked decisions inherited (not re-litigated):**
- §6: every interaction is an `encounter`; teleconsult is named there. One patient master; language preference per patient; intended-payer and referral attribution on every visit.
- §11.1: pay-before-consult; follow-up window rules; the outcomes A–D; E1 paid-but-left refund is approval-gated.
- §11.8 / Plan 16a: prescribing is never blocked by formulary coverage; hard stops for allergy/contraindication; NDPS/Schedule X/H1 discipline; pharmacy may substitute generics.
- §11.13: template registry; transactional messages always flow, promotional opt-in; quiet hours.
- §14: confidential records for staff-as-patient and VIP; break-glass loudly logged; all external traffic through the single gateway module.
- §16: tiers; clinical actions cap at T2–T3; automations preferred over agents; text tokenised before leaving; **audio is a named exception still awaiting the owner's spec §19 amendment** (Plan 11h DD11 — voice search inert). Any transcript-to-note agent in this document inherits that open ruling.
- §11.7: teleradiology "designed-in but dormant"; §11.15: tele-ICU is the intensivist phone view over telemetry — both out of scope here.
- Roadmap: "teleconsult flow (CRM)" is a noted-for-later item under §11.5; deferred-note 3 (three presentation lanes); Plan 13 registry kinds are a closed set of ten.
- S10 §2: KPIs event-derived, diagnostic, load-normalised; §12.24 doctor adoption program includes designed off-site access.

**Scope boundaries / neighbouring owners.** `patients` owns identity, ABHA, language, allergies, the sealed flag. `opd` owns encounters, prescriptions, doctor schedules (until the roster module). `billing` owns invoices/receipts/refunds. `partners`/`membership` own accrual and instruments. `notify` owns channels. Pharmacy (Plan 16) owns dispensing and the delivery hand-off (doc 03); LIMS (Plan 17) owns home-collection orders; this module owns **the tele session, consent, identity checks, the TPG prescribing-class rule, the tele register, the remote follow-up programme, and home-vitals intake**. It owns no doctor-availability tables; tele slots are OPD schedule rows with a `mode`.

**What this document adds:** the `teleconsult` workflow definition; the TPG compliance surface as tables; the payment-link flow; the vendor decision; the remote follow-up programme as a P7 subscription over discharge events; the edge catalogue; KPIs for two new role cards; the agent placements; a proposed **Plan 21 — Teleconsultation** (number reasoning in §14).

## 2. Actors, roles & role cards

| # | Role (S10 card / NEW) | Touchpoints | Shift/bundling | Notes |
|---|---|---|---|---|
| 8 | OPD Consultant (S10 card 8) | joins tele queue, verifies identity on camera, consults, prescribes under TPG class rule, converts to in-person | own schedule; tele slots may be from home | fee-split per §7; registration number displayed on every tele artefact |
| NEW-T1 | **Tele Coordinator** (front-office family; reports to Front-Office Supervisor, card 2) | books, sends payment link, confirms payment, pre-checks camera/ID, runs the virtual waiting room, handles drops/reschedules/refund requests | day 08:00–20:00; night bundles into duty manager (no tele after 21:00 except programme escalations) | day-one 1 person doubling as OPD registration clerk; scale 6–8 |
| NEW-T2 | **Tele Nurse / Navigator** (nursing family; reports to Matron) | intake vitals capture (patient-reported), home-device reading check, post-discharge programme calls, caregiver coaching, red-flag triage to ER advice | day; bundles with OPD vitals-desk nurse | S10 §12.22 navigation duty extended remotely |
| 1 | Registration Clerk (card 1) | creates UHID for first-time tele patients from phone + photo ID | — | duplicate check phone-first as §11.1 |
| 3–4 | Cashier / Billing Supervisor | reconcile payment-link settlements vs invoices; refund approvals (SoD: cashier never approves own refund) | — | T+1 recon already exists for UPI |
| — | Pharmacist (Plan 16) | receives e-Rx with QR; dispenses or hands to delivery; refuses Prohibited-List/Schedule X from tele | — | doc 03 owns delivery |
| — | Phlebotomist / home-collection vendor | receives home-collection order link | — | Plan 17 owns |
| 37 | Quality Manager / DPO | DPIA for video vendor, consent template owner, recording retention policy, grievance | — | |
| 39 | Medical Superintendent | approves tele-eligible specialty list, first-consult policy per specialty, records the RMP verification | — | second key for clinical definitions |
| — | Duty Manager | night escalations from the follow-up programme; Code Violet remote variant (harassment) | — | |
| — | Interpreter (external, on-call) | joins as third participant on request | — | bought service |
| Agent | Recall & Follow-up automation (T1, §16) | no-show recall, review-date reminders — extended with tele rows | — | 12b |
| Agent | SLA Chaser (T1) | waiting-room wait breaches, doctor-late nudges | — | existing |
| Agent | **Tele Eligibility Gate** (automation, T0/rule) | first-vs-follow-up, minor, emergency-keyword, specialty whitelist — deterministic | — | NEW, this plan |
| Agent | **TPG Prescribing-Class Check** (automation, rule, inside the Rx transaction) | List O/A/B/Prohibited by consult mode and consult class | — | NEW, this plan |
| Agent | **Pre-consult Intake Summariser** (agent, T2) | structured intake + uploaded reports → briefing lines with citations | — | post-12a, Lens pack `tele-consult` |
| Agent | **Follow-up Scheduler** (automation, T1) | proposes follow-up slot from `consultation.completed` + programme rules | — | NEW |
| Agent | **Session Quality Sentinel** (automation, T0) | vendor webhook stats → drop detection → refund-ladder trigger | — | NEW |
| Agent | Fraud Sentinel (T0) | narcotic-seeking pattern, doctor-shopping across tele, refund abuse | — | 12b extension |

**SoD hard pairs (added):** tele coordinator who marks a session "dropped — hospital fault" ≠ refund approver · doctor ≠ person who records the patient's consent on the patient's behalf · recording-access requester ≠ recording-access approver · interpreter never sees the record beyond the session.

## 3. Core flows as workflow definitions

### 3.1 `teleconsult_visit` (P1 patient journey; new definition, versioned data, owner activates per §10.4)

```
requested ──pay link sent──▶ payment_pending ──payment.received──▶ scheduled
   │                              │ (expiry 30 min / T-2h)              │
   │                              └──▶ lapsed (auto, no charge)          │ T-15 min: intake link
   ▼                                                                     ▼
 rejected (ineligible)                                              pre_consult (intake/consent/ID pre-check)
                                                                         │ patient joins
                                                                         ▼
                                       ┌──────────────── waiting_room ◀──┘
                                       │ doctor joins  │ doctor absent > SLA → doctor_no_show → refund_pending
                                       ▼               │ patient absent > SLA → patient_no_show
                                  identity_verify      │
                                       │ ok            │ fail → aborted_identity (no fee? see O-4)
                                       ▼
                                  in_consult ──drop──▶ reconnecting (≤10 min) ──▶ in_consult
                                       │                      └── timeout ──▶ dropped → refund_pending | rescheduled
                                       ├── emergency detected ──▶ converted_emergency (advice + ER task, fee per O-5)
                                       ├── needs in-person ──▶ converted_in_person (OPD appointment booked, fee credit rule O-6)
                                       ▼
                                  completed (Rx issued? orders? follow-up stamped) ──▶ closed_out (documents delivered)
```

| State | Allowed transition roles | SLA | Escalation ladder |
|---|---|---|---|
| requested → payment_pending | tele coordinator, patient (self-serve link), system | eligibility gate < 5 s; link sent < 2 min | none (automation) |
| payment_pending → scheduled | system on `payment.received`; coordinator on counter tender | link expiry 30 min (same-day) / 2 h before slot | reminder at 15 min; lapse silently |
| scheduled → pre_consult | system at T-15 min | — | Recall automation if intake not opened by T-5 |
| pre_consult → waiting_room | patient join | — | — |
| waiting_room → identity_verify | doctor join | doctor late > 10 min = `sla.breached` | coordinator nudge at 5 → duty manager at 15 → doctor_no_show at 20 (configurable) |
| identity_verify → in_consult | doctor confirms | < 2 min | — |
| in_consult → reconnecting → in_consult | system (vendor webhook) | 10 min reconnect window | coordinator calls patient on phone at 2 min |
| in_consult → completed | doctor | consult ≤ 20 min target (diagnostic only) | none |
| completed → closed_out | system when Rx PDF + orders delivered | < 5 min | notify failed → coordinator task |
| any → refund_pending | system/coordinator with reason code | 24 h to voucher | billing supervisor |

**Events** (existing reused: `appointment.booked/.rescheduled/.cancelled/.no_show`, `visit.opened`, `consultation.started/.completed`, `prescription.issued`, `order.placed`, `payment.received/.refunded`, `credit_note.issued`, `consent.recorded`, `referral.issued`, `sla.breached`, `notification.*`, `commission.accrued/.reversed`, `patient.recall_initiated`). **NEW:** `tele.eligibility_checked` (payload: class first|follow_up, mode video|audio|text, verdict) · `tele.payment_link_issued` · `tele.payment_link_lapsed` · `tele.session_created` (vendor, room ref) · `tele.participant_joined` / `tele.participant_left` (role, device, network class) · `tele.identity_verified` (method, by whom, caregiver relation) · `tele.identity_failed` · `tele.session_dropped` (fault: patient|hospital|vendor|unknown) · `tele.session_reconnected` · `tele.converted` (to: in_person|emergency) · `tele.mode_downgraded` (video→audio→phone) · `tele.recording_started/.stopped/.accessed/.purged` · `tele.rx_class_blocked` (drug, list, reason) · `home_vitals.recorded` (source: self|device|nurse) · `tele.abuse_flagged`.

### 3.2 `tele_prescription_issue` (overlay on Plan 16a's issue transaction, not a separate lifecycle)
At `prescription.issued` inside the same transaction: for each line resolve salt → TPG class (List O / A / B / Prohibited / unclassified) → allowed if (mode, consult class) permits; Prohibited always hard-stop for `type='teleconsult'`; List B only when a prior in-person `opd_encounters` row for this patient with the same doctor/department exists within 6 months (TPG follow-up definition) and the drug appears on that consult's Rx; List A allowed on video first consult; audio/text first consult allows List O only. Unclassified → warning + reason (never block; copilot law 1 — but Prohibited/Schedule X/NDPS stays a block because it is statute, not coverage).

### 3.3 `remote_followup_programme` (P7 notify-remind-escalate over P1; per-programme definition)
Enrolment on `patient.discharged` (IPD, later) or `consultation.completed` with a programme tag (e.g., post-op day-care from §11.16-A, CHF, diabetes titration, post-natal). Schedule of touchpoints: day-1 nurse call → day-3 vitals check-in → day-7 tele review → day-30 close. Each touchpoint is a task (P5) or a tele visit (3.1). Red-flag answer → escalation ladder (tele nurse → RMO on duty → consultant) with the §11.13 5-minute ack timer only on the red-flag class. Missed touchpoint = clinical recall, not no-show (§11.16-A rule inherited). `readmission.flagged` closes the loop for the KPI.

### 3.4 `tele_second_opinion` (variant of 3.1)
Document-heavy: reports uploaded → radiologist/specialist reads asynchronously → written opinion signed → optional 15-min video. No prescription by default (advisory); if the patient is inside India and the RMP chooses to prescribe, 3.2 applies as a first consult.

### 3.5 Corporate-standard variants covered
Doctor-initiated follow-up call (explicit consent required, TPG) · caregiver-initiated consult for an elderly parent (caregiver identity + relation captured) · health-worker-assisted consult at a satellite camp/clinic (worker identity, patient present) · in-person conversion mid-call · multi-specialty referral inside the call (`referral.issued`, second tele slot booked) · family member abroad joining as attendant (consent of patient).

## 4. Data model sketch

Module folder `tele` (owns tables below; reads OPD via declared interfaces `opd.getEncounter`, `opd.issuePrescription` hook, `billing.createInvoice`, `patients.get`).

| Table | Key columns (sketch) |
|---|---|
| `tele_sessions` | id, encounter_id (FK opd_encounters, type must be teleconsult), vendor, vendor_room_ref, mode (video/audio/text/phone), scheduled_at, doctor_join_url_hash, patient_join_token_id, started_at, ended_at, drop_count, last_fault, network_class_pt/dr, recording_flag, created_by/at |
| `tele_participants` | session_id, role (patient/doctor/caregiver/interpreter/observer), display_name_shown, joined_at, left_at, device_class, ip_country (for foreign-patient rule) |
| `tele_identity_checks` | session_id, subject (patient/caregiver/adult_for_minor), method (photo-id-on-camera / UHID-photo match / ABHA / OTP-to-registered-phone), result, checked_by, checked_at, relation_to_patient, note |
| `tele_consents` | encounter_id, kind (teleconsult / recording / caregiver-proxy / data-share-abroad), basis (implied-patient-initiated / explicit), captured_via (OTP, tick-in-link, verbal-on-record, paper), text_version, captured_at, revoked_at |
| `tele_eligibility_checks` | encounter_id, consult_class (first/follow_up), reference_encounter_id (the in-person consult within 6 months), mode, specialty_whitelisted, minor_flag, emergency_flag, verdict, reasons jsonb |
| `tele_rx_class_rules` (config, governed Class B) | salt_id, tpg_list (O/A/B/prohibited), source_version, effective_from |
| `tele_rx_class_events` | prescription_id, line_no, tpg_list, verdict, override_reason (only for unclassified) — the statutory evidence |
| `tele_register` (**statutory register, first-class**) | one row per consult: date, patient UHID (alias if sealed), RMP name + registration no. + council, mode, consult class, consent basis, identity method, Rx issued Y/N, conversion Y/N, fee — TPG "maintain log/record of telemedicine interaction" |
| `tele_payment_links` | encounter_id, gateway, link_ref, amount, currency, issued_at, expires_at, status (issued/paid/lapsed/refunded), gateway_txn_ref, utr |
| `tele_refund_cases` | session_id, cause code (doctor_no_show / hospital_drop / vendor_drop / patient_drop / patient_no_show / identity_fail / emergency_conversion), policy_outcome (full/partial/credit/none), refund_voucher_id, decided_by |
| `home_vitals` | patient_id, encounter_id?, taken_at (patient-stated), recorded_at, kind (BP/SpO2/glucose/weight/temp/HR), value, unit, source (self-typed / photo-of-device / Bluetooth later / nurse-call), device_model?, plausibility_flag |
| `tele_documents` | encounter_id, kind (report_upload / photo / rx_pdf / opinion_pdf), storage_ref, hash, uploaded_by, virus_scan, retention_class |
| `tele_recordings` | session_id, vendor_ref, storage_ref (India region), started/stopped, consent_id, retention_until, legal_hold, access_log via `tele.recording_accessed` |
| `followup_programmes` (config) + `followup_enrolments` + `followup_touchpoints` | programme id/version, trigger event, schedule jsonb, red-flag questionnaire version; enrolment per patient/episode; touchpoint rows with task_id or encounter_id, outcome |
| `tele_abuse_reports` | session_id, reported_by, category, action (warned/terminated/blocklisted), incident_id link |

**Registry (Plan 13):** no new kind. A physical "tele cabin" on the OPD floor is a `room`; a hospital-owned webcam/BP kit lent to a programme patient is a `device` (lend/return as P3 request-to-issue). Virtual rooms are vendor artefacts, not resources.

**FHIR shapes:** `Encounter.class = VR` (virtual), `Consent`, `Observation` (home vitals, `Observation.device`), `MedicationRequest` (existing Rx document), `DocumentReference` (uploads, opinion). ABDM: teleconsult care-context notification later, same as OPD.

**Retention (recommended defaults):** encounter/Rx/register — OPD rule ~5 y (§11.14; TPG points to IMC record norms) · recordings — **0 days by default (not recorded)**; when recorded, 90 days then purge unless legal hold · payment-link artefacts — 8 y (GST/IT) · identity-check photos — not stored; only method+result (DPDP minimisation) · uploads — with the encounter.

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref**.

### A. Identity & wrong-patient
- **A1** Caller books for "Ramesh Kumar" — three UHIDs with that name and the same village → phone-first match, then photo shown to coordinator on the intake link ("is this you?"), mismatch → new UHID candidate queued to Plan 05 merge review → *test:* same phone, two UHIDs → booking blocked until one chosen; event `tele.identity_failed` never fires silently.
- **A2** Patient's daughter joins from her phone for her mother (75, in another room) → caregiver identity + relation captured; patient must appear on camera at least once; doctor confirms → *test:* session with no patient-face-confirmed flag cannot reach `completed`.
- **A3** Minor (14) alone on camera → TPG: consult only with an adult present; state `identity_verify` fails with reason `minor_without_adult`; rebook offered; no fee (O-4) → *test:* DOB < 18 and no adult participant → transition to in_consult refused.
- **A4** Two patients share one phone (husband/wife) → payment link carries encounter id, not phone; join token is per encounter; the other spouse's encounter cannot be entered with this token → *test:* token from encounter X rejected on encounter Y.
- **A5** Patient's video shows a different person than the UHID photo (proxy consult for a relative to get medicines) → doctor marks identity failed; encounter aborted; Fraud Sentinel counts per phone → *test:* abort reason code required; Rx issue impossible after `tele.identity_failed`.
- **A6** Doctor's own identity: the RMP on the call is a junior, not the booked consultant → join links are per user, doctor-side join needs HMIS login; display name and registration no. rendered from the actor, not typed → *test:* session participant role=doctor must equal encounter.doctor_id.
- **A7** UHID created from a WhatsApp booking with a misspelt name in Devanagari → 11h search must find it; coordinator corrects via patients amend flow, not by creating another → *test:* registration from tele path emits `patient.registered` with source=tele.
- **A8** Sealed/VIP patient consults by video → alias on coordinator screens, participant display name is the alias, register row uses alias id → *test:* sealed patient never appears by real name in `tele_participants.display_name_shown` or the register export.
- **A9** Staff member consults their own colleague-doctor by tele → staff-as-patient confidential class (§14) applies; break-glass rules unchanged → *test:* another staff cannot open the encounter without break-glass event.
- **A10** Patient merged (Plan 05) between booking and consult → session resolves the survivor id; loser id join token still valid → *test:* join token bound to encounter id survives `patient.merged`.

### B. Timing, concurrency, race
- **B1** Two coordinators book the same doctor's last tele slot for two patients → slot lock at `appointment.booked` (existing OPD appointment uniqueness) → *test:* concurrent bookings, exactly one wins.
- **B2** Payment arrives 1 s after link expiry → gateway webhook with a lapsed link: auto-issue receipt, move to `scheduled` if slot still free, else refund voucher auto-created (no approval below threshold, O-2) → *test:* late-payment fixture yields either scheduled or refund_pending, never orphan money.
- **B3** Gateway webhook duplicates (Razorpay retries) → idempotency on `gateway_txn_ref` (billing `idempotency_keys` exists) → *test:* 3 identical webhooks → 1 receipt.
- **B4** Doctor joins before the patient, leaves, patient joins → waiting_room re-notifies doctor; doctor-late SLA restarts from patient join, not doctor's first join → *test:* SLA clock anchor is `tele.participant_joined(role=patient)`.
- **B5** Consult overruns into the next patient's slot; doctor's physical OPD queue also has patients → tele queue is a separate `opd_queue_sessions` row (mode tele); display shows "doctor on video" in the physical queue; no interleaving without the doctor's explicit call → *test:* physical queue's `called` transition blocked while a tele session is `in_consult` for the same doctor unless override.
- **B6** Slot at IST midnight boundary / follow-up window ending exactly at day 7 23:59 → `classifyVisit` reused verbatim; tele does not re-implement → *test:* golden visit-type fixtures pass with `type=teleconsult`.
- **B7** 6-month TPG follow-up boundary: in-person on 27 Feb, tele on 27 Aug (leap-year-free) → boundary inclusive per policy; config value; → *test:* day-183 vs day-184 fixtures produce follow_up vs first.
- **B8** Patient reconnects after 9 min 59 s vs 10 min 01 s → reconnect window from config; vendor `participant_left` timestamp is authoritative, `recorded_at` may lag → *test:* uses `occurred_at`.
- **B9** Doctor completes the consult while the vendor still reports the room open → `completed` is a doctor act; vendor room closed by system; stale `participant_joined` after completion ignored and logged → *test:* post-completion webhooks do not reopen state.
- **B10** Rx issue and payment refund race: doctor issues Rx while coordinator approves a "dropped call" refund → refund voucher creation checks encounter state; a completed consult with Rx cannot be refunded as "dropped"; must go through E1-style approval → *test:* refund cause `hospital_drop` rejected when `prescription.issued` exists.

### C. Partial failure & downtime
- **C1** Video vendor outage at 10:00 with 14 booked consults → Session Quality Sentinel flips `tele.mode_downgraded` for the department; coordinator gets a worklist "call via phone"; phone consult is TPG-legal (audio) but Rx class limits tighten to List O for first consults; the doctor sees the tighter rule → *test:* mode=audio + first consult → List A line blocked with message.
- **C2** Core HMIS down mid-consult (video still up, vendor is external) → doctor keeps talking; paper Rx per downtime kit (11c) with TPG-required registration no. pre-printed; backfill with `occurred_at` → *test:* backfilled `prescription.issued` with occurred_at < recorded_at passes the TPG class check retroactively and flags violations for MS review rather than rejecting.
- **C3** WhatsApp template rejected/paused by Meta → payment link falls back to SMS (Plan 10 ladder); link short-domain must fit 160 chars → *test:* template failure produces SMS send within 60 s.
- **C4** Gateway (payments) down → coordinator takes a counter UPI/Cash tender for a relative present in hospital, or marks "pay after — approval" (credit exception via approvals engine) → *test:* consult can be scheduled with an approval id in lieu of payment.
- **C5** Patient's phone dies mid-consult → reconnect window; coordinator calls the alternate number captured at intake → *test:* alternate number field mandatory at intake.
- **C6** PDF renderer down → Rx delivered as text summary + "PDF to follow"; Rx status remains issued; document delivery task → *test:* `closed_out` waits, `completed` does not.
- **C7** Doctor's home internet fails; hospital LAN fine → doctor's session flagged `hospital_fault` if the doctor was the dropper (doctor ≈ hospital for refund policy) → *test:* fault attribution from webhook `left_reason=network` on doctor participant → cause `hospital_drop`.
- **C8** Worker/scheduler dead → reminders and link expiry do not fire; heartbeats (08.5) alert; coordinator's manual "resend link"/"lapse" buttons always work → *test:* manual path exists for every automation state change.

### D. Money — billing, refunds, payer switches, packages, TPA
- **D1** Tele fee ≠ walk-in fee (usually lower) → tariff line `CONSULT_TELE_<dept>` with new/revisit/renewal branch; revisit within window free if policy says so (recommend: same window rules as OPD) → *test:* golden billing rows for tele new/revisit.
- **D2** Refund ladder (recommended default, O-2): doctor no-show → 100% auto (below ₹2,000 no approval); hospital/vendor drop before 5 min of consult → 100%; drop after ≥10 min with Rx/advice given → 0% (consult delivered) with free reschedule; patient no-show → 0%, one free reschedule within 7 days; patient drop → reschedule, no refund → *test:* policy table fixtures.
- **D3** Refund goes to a different UPI ID than the payer → §7 rule: refunds go to whoever paid; gateway refund to source instrument only → *test:* refund voucher for a link payment carries method=gateway_reverse, never cash.
- **D4** Patient pays twice (link + counter) → duplicate payment detected; auto credit note + refund of the second → *test:* two receipts on one invoice → variance flagged in daily close.
- **D5** Membership card (Plan 09) with free consults — does tele consume the counter? Recommend yes, same counter, and perk priority applies to the tele queue → *test:* `membership.benefit_consumed` on tele invoice.
- **D6** TPA patient wants cashless tele → TPAs do not cover; intended_payer forced to `self` for tele with a message; corporate tie-ups may cover (partner agreement flag) → *test:* intended_payer=tpa on teleconsult rejected unless agreement.tele_covered.
- **D7** PMJAY beneficiary → not covered for tele; self-pay warning; no PMJAY claim generated → *test:* no claim draft for type=teleconsult.
- **D8** Fee split for a doctor consulting from home vs from hospital cabin → split % is per doctor agreement; a `location` attribute on the accrual subject allows a different split (owner policy O-7) → *test:* accrual amount differs by session location when configured.
- **D9** Referral commission from an external RMP who forwards the patient to tele → attribution captured at booking (`referral_source=external_rmp`), accrues on payment → *test:* same as OPD accrual path with type=teleconsult.
- **D10** International patient pays in USD via card → currency and FX on the receipt; GST: healthcare by a clinical establishment is exempt (Notification 12/2017 entry 74) regardless of recipient location; FEMA: FIRC/e-FIRC obtained from AD bank; receipts stored → *test:* invoice currency USD, INR equivalent at gateway rate, GST 0.
- **D11** Convenience/platform fee added to the tele bill → taxable at 18% (not healthcare) — recommend **no** platform fee (keeps invoice exempt-only) → O-8.
- **D12** Discount at counter for a tele consult → same discount governance; coordinator has no discount permission → *test:* `discount.applied` on tele requires billing role.
- **D13** Coupon `TELE10` → coupon engine reused; category = tele consults → *test:* coupon redemption on tele line.
- **D14** Doctor converts to in-person the same day → tele fee credited against the OPD fee (recommend full credit within 24 h) → `credit_note.issued` + `payer`-neutral → *test:* OPD invoice line shows adjustment rule `tele_conversion_credit`.
- **D15** Chargeback raised at the gateway 20 days later → gateway dispute webhook → billing task; invoice stays; a credit note only on loss → *test:* dispute event does not mutate the invoice.
- **D16** Refund-abuse: same patient, 4 "dropped call" refunds in a month → Fraud Sentinel diagnostic → billing supervisor review; 3rd claim needs approval regardless of amount → *test:* threshold rule from config.

### E. Consent, legal, MLC, minors, unconscious, TPG
- **E1** Patient-initiated booking → implied consent recorded as basis=implied with the booking artefact hash; doctor-initiated follow-up → explicit consent via OTP tick before the call → *test:* doctor-initiated session cannot start without `consent.recorded(kind=teleconsult, basis=explicit)`.
- **E2** Recording: default OFF; if a department policy turns it on, both parties see a banner and explicit consent is captured per session; refusal → consult proceeds unrecorded → *test:* recording start impossible without consent id.
- **E3** Patient asks for a recording copy (DPDP access right) → DSR flow (§11.14), delivered within statutory TAT → *test:* `dsr.requested` links the recording id.
- **E4** Doctor detects chest pain/stroke signs → TPG: no telemedicine in emergencies; doctor advises nearest ER, HMIS creates an ER pre-arrival note (`ambulance.prearrival_notified` if our ambulance) and closes as `converted_emergency`; fee per O-5 (recommend 100% refund) → *test:* conversion reason emergency → refund case auto-opened.
- **E5** Psychiatry tele follow-up: patient expresses suicidal ideation → red-flag protocol: doctor keeps line, coordinator calls the emergency contact captured at intake (consent at intake), incident register entry; no auto-message to family without the protocol's consent basis → *test:* red-flag task carries the intake emergency contact and the consent flag.
- **E6** MLC-type disclosure on video (assault, poisoning) → TPG says avoid; doctor documents, advises in-person/ER; no MLC register from tele (MLC requires physical examination) → *test:* MLC flag on a teleconsult is refused with guidance.
- **E7** Patient in a foreign country wants treatment (not opinion) → recommend advisory/second-opinion only; prescriptions marked "valid in India only"; foreign jurisdiction licensure risk documented → O-9 → *test:* `ip_country ≠ IN` + Rx attempt → warning + register flag.
- **E8** Cross-state patient (Bihar patient, UP-registered RMP) → NMC Act 2019 §34 national register: permitted; register shows council + no.; nothing else changes → *test:* no state check in eligibility gate.
- **E9** Doctor whose council registration lapsed/expired → Expiry Watchman on credentials (S10 §12.8); tele join blocked → *test:* expired registration → doctor cannot open tele session.
- **E10** Pregnancy in a minor disclosed on video → POCSO intimation obligations apply to the RMP regardless of medium; flagged workflow to MS; no PCPNDT-relevant activity possible remotely → *test:* age<18 + pregnancy dx code → POCSO task created.
- **E11** Unconscious/incapacitated patient shown by relative → not a teleconsult; advise ER; abort with reason → *test:* abort reason `patient_incapacitated` refunds 100%.
- **E12** Prescribing Prohibited List (Schedule X, NDPS narcotics/psychotropics e.g. alprazolam? — note alprazolam is Schedule H1 not X; the block set is the TPG Prohibited List as configured) → hard stop, no override; `tele.rx_class_blocked` → *test:* mutant removing the block dies.
- **E13** List B drug (e.g., a chronic antihypertensive continuation) on a *first* video consult → blocked with "requires prior in-person consult within 6 months"; doctor may still prescribe List A alternatives → *test:* List B on first → blocked; on follow-up with matching in-person Rx → allowed.
- **E14** Follow-up for a *different* condition than the in-person consult → TPG treats as first consult; doctor must tick "same condition" (defaults from ICD match) → *test:* ICD mismatch defaults consult_class=first.
- **E15** Audio-only consult (video failed) and doctor wants to prescribe List A → TPG permits List A on video first consult; for audio first consult recommend List O only (conservative reading) → configurable, MS-approved → *test:* mode transitions re-run the class rule at issue time.
- **E16** Health worker at a camp assists → TPG allows; worker's identity recorded; consent explicit by patient → *test:* participant role=health_worker requires staff/actor id.
- **E17** Patient wants the consult in Bhojpuri; doctor Hindi-only → interpreter join or reroute to Bhojpuri-speaking doctor (language tag on `opd_doctors`, proposed); consent text in patient's language → *test:* consent template language = patient preference.
- **E18** Doctor uses a personal WhatsApp video instead of the platform → register row cannot be created; policy: not a hospital consult, no Rx from HMIS; MS policy; Fraud/compliance diagnostic when an Rx is issued on a teleconsult with no `tele_sessions` row → *test:* Rx issue on teleconsult without session → blocked.
- **E19** AI must not "counsel or prescribe" (TPG) → summariser output is a briefing with citations; no patient-facing AI advice; a chatbot on the intake link only collects → *test:* no inference call on the patient-facing path.
- **E20** Consent revoked mid-call for recording → recording stops, earlier part retained with the original consent unless patient asks purge → `tele.recording_stopped(reason=revoked)`.

### F. Staff absence, overload, handover
- **F1** Doctor no-show 20 min → auto refund or bulk transfer to another available tele doctor of the same department (E2 mechanics, consent by WhatsApp yes/no) → *test:* bulk transfer creates new sessions with new tokens.
- **F2** Doctor on planned leave with 30 tele bookings → §11.5 leave cascade reuses `createLeave` → affected appointments → rebooking → *test:* tele appointments included in `affectedAppointmentIds`.
- **F3** Coordinator absent at 08:00, links not sent → automation sends links; human only handles exceptions → *test:* link issuance is a scheduler job, not a screen action.
- **F4** Single doctor runs physical OPD + tele → configurable "tele blocks" in schedule; walk-in queue shows "video slot until 11:30" → *test:* schedule row mode=tele excludes physical tokens.
- **F5** Programme nurse overloaded (200 enrolled) → `overload.flagged`; touchpoints reprioritised by red-flag risk, never silently dropped; unmet touchpoints appear as a count in the digest → *test:* missed touchpoint → `task.escalated`.
- **F6** Handover between coordinators mid-day → waiting-room worklist is stateful; the handover flag shows sessions in `reconnecting` → *test:* worklist filter by state.
- **F7** Interpreter no-show → consult proceeds with a family interpreter, documented as such (quality caveat) → *test:* interpreter role absent + language mismatch → note required.

### G. Equipment / device failure
- **G1** Patient's camera off, mic on → doctor may downgrade to audio (`tele.mode_downgraded`), class rule tightens → *test:* covered in E15.
- **G2** Doctor's webcam fails in the hospital tele cabin → cabin is a registry `room` with a `device`; status `out_of_service`; sessions rerouted to the doctor's laptop → *test:* resource status change does not cancel sessions.
- **G3** Home BP monitor reads 250/160 (cuff error) → plausibility flag; nurse callback before doctor alarm; danger flag only after nurse confirms → *test:* self-entered values never fire `vitals.danger_flagged` directly; they fire `home_vitals.recorded` with plausibility.
- **G4** Bluetooth glucometer (later) sends stale readings with device clock 3 days behind → `taken_at` vs `recorded_at`; reject readings older than 24 h from auto-ingest without nurse confirmation.
- **G5** Screen-share of a report is unreadable → patient uploads photo; OCR is not clinical truth; doctor reads → *test:* uploads virus-scanned, size-limited, hashed.
- **G6** Speaker echo/feedback in shared cabin → not a system issue; checklist in the cabin; skip.
- **G7** Vendor SDK update breaks the doctor's old browser → pre-join device test page with pass/fail; failure routes to phone consult → *test:* pre-join check result stored on the participant row.

### H. Data quality, late-arriving, backdated
- **H1** Patient uploads reports after the consult ended → attach to the same encounter within 24 h; doctor gets a "new document" worklist item; addendum note allowed, Rx amendment = new version → *test:* Rx versioning reused (`version` column exists).
- **H2** Home vitals typed as "120" for SpO2 → range validation per kind; unit confusion (mmol vs mg/dL glucose) → unit mandatory; out-of-range prompts re-entry.
- **H3** Backfilled paper consult from downtime with the TPG class check failing (a List B drug on what was recorded as a first consult) → do not block backfill; flag to MS review register → *test:* backfill path sets `verdict=review`.
- **H4** Wrong doctor recorded (junior signed in on senior's laptop) → attribution dispute workflow (S10 §12.9) → `attribution.disputed`.
- **H5** Register export for the council/inspector must be reproducible for a date range even after patient merges → register rows store UHID at the time + survivor pointer.
- **H6** Vendor webhooks arrive out of order (`left` before `joined`) → order by vendor timestamp; participant row upserts idempotently.

### I. Fraud, leakage, gaming
- **I1** Doctor-shopping for benzodiazepines/tramadol across 3 tele doctors in a week → Fraud Sentinel diagnostic on salt-class × patient × 30 d; Prohibited List already blocked; H1 drugs allowed on follow-up only → MS review.
- **I2** Doctor marks every consult "follow-up" to unlock List B → follow-up needs a machine-verifiable reference encounter; the tick alone is insufficient → *test:* follow_up without reference_encounter_id impossible.
- **I3** Doctor extends follow-up windows to make tele revisits free (fee diversion) → §11.19-C-14 cap and pattern report already exist; tele extensions counted in the same cap.
- **I4** Coordinator marks patient-fault drops as hospital-fault for a friend → SoD: refund approver ≠ marker; cause code cross-checked against vendor webhook fault → Sentinel diagnostic on coordinator × cause distribution.
- **I5** Doctor consults "off-platform" and bills nothing (leakage) → register vs schedule variance: tele slot blocks with zero sessions → outward-referral/leakage pattern report (T0).
- **I6** Ghost patients booked to pad a visiting doctor's numbers for fee split → payment must be from a real instrument; same-UPI-payer across many UHIDs → Sentinel.
- **I7** Coupon abuse via new UHIDs per consult → duplicate-UHID gaming check (S10 §12.18) + phone reuse.
- **I8** Forged e-Rx PDF edited to add a narcotic → QR verifies against server; pharmacy scans QR before dispensing (doc 03); PDF text is not truth → *test:* verify endpoint returns the issued lines; mismatch visible.
- **I9** Screenshot of another patient's Rx reused → QR is per prescription with patient alias/UHID; pharmacy sees patient photo (if not sealed) on scan.
- **I10** Doctor from home records consults on a personal device → policy + consent banner; cannot be technically prevented; documented in the tele SOP; incident path.

### J. Privacy, sealed records, VIP, staff-as-patient
- **J1** Psychiatry/sexual-health/HIV consults → department-level confidentiality class (sealed by default, configurable); WhatsApp messages carry no diagnosis text ("your consult documents are ready" + link with OTP) → *test:* template for sealed class has no clinical content.
- **J2** Patient joins from an office with colleagues; sensitive content → doctor's "are you in a private place?" prompt is a checklist item; documented.
- **J3** Family member insists on joining a VIP's call → VIP flag: only participants the patient approves on camera; observer role logged.
- **J4** Recording stored at vendor outside India → contract requires India-region storage; export blocked; DPDP §16 transfer analysis in DPIA → *test:* vendor config region=IN pinned in config test.
- **J5** Interpreter is a local person who knows the patient → patient may refuse; interpreter pool with conflict flags; a "no interpreter" choice always offered.
- **J6** Doctor's home address/phone must never reach the patient → vendor rooms mask; callbacks via PBX/hospital number masking (buy: cloud telephony number masking) → *test:* patient-facing payload contains no doctor personal phone.
- **J7** Search audit: coordinator searching VIP names → 11h search audit table already covers.

### K. Language, literacy, accessibility
- **K1** Bhojpuri-only patient, cannot read the link → IVR/voice call "press 1 to confirm"; nurse phone-assisted intake; consent captured verbally on record (audio snippet retained with the consent row, minimal) → *test:* consent kind=verbal stores a 20-second clip max, or a nurse attestation if recording disabled.
- **K2** Hearing-impaired patient → chat lane in-call + option to bring a signing relative; captions later.
- **K3** Elderly can't operate the join link → "we will call you" mode: coordinator dials via PBX and bridges the doctor (audio consult, List O/A limits apply).
- **K4** Intake questionnaire in Hindi with voice-note answers → voice stays unprocessed by inference until the audio ruling; nurse transcribes if needed.
- **K5** Rx print in Hindi transliteration plus English generic names → existing print surface; TPG requires RMP name/reg no. on it.

### L. Scale (100/day → 2,000/day)
- **L1** 5% of 2,000 = 100 tele consults/day, peaks 20/h across 10 doctors → vendor concurrency licence sized 40 concurrent rooms; queue per doctor.
- **L2** Programme enrolments 300/day post-discharge at 610 beds → touchpoint generation is a scheduler job (08.5 pattern) with batch inserts; nurse worklist paginated by risk.
- **L3** Payment-link volume → webhook processing under the worker; backlog alert at 5 min age.
- **L4** Vendor minutes budget → monthly usage in the digest; cap alerts.
- **L5** Doctor count 80–120 → per-doctor tele enablement flag and specialty whitelist governed config; not per-doctor code.

### M. Integration failures (vendor / gateway / ABDM / pharmacy / lab)
- **M1** Vendor webhook signature invalid → drop + alert; sessions still closable manually by doctor.
- **M2** Gateway settlement file missing at T+1 → existing recon marks unmatched; coordinator not involved.
- **M3** Pharmacy delivery hand-off (doc 03) rejects an Rx because a line is Schedule H without the QR verification → the Rx QR verify endpoint is the contract; failure → pharmacist task, patient told.
- **M4** Home-collection vendor (Plan 17) cannot serve the pincode → order stays `placed` with `fulfilment=unserviceable`; patient offered walk-in slot; result re-entry loop as §11.1 B.
- **M5** ABDA/ABHA link requested during tele → ABHA OTP flow via patients module; failure never blocks the consult (§6).
- **M6** WhatsApp number differs from registered phone → link sent to the number the patient booked from, only if verified by OTP; else registered phone.
- **M7** Vendor deprecates SDK (Twilio Video precedent, sunset Dec 2024) → adapter interface `TeleProvider` with a second implementation kept green in CI (Jitsi self-host) → exit path measured, not assumed.

**Row count: 100+ (A10 · B10 · C8 · D16 · E20 · F7 · G7 · H6 · I10 · J7 · K5 · L5 · M7 = 118).**

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 09:30 — video vendor region outage, 22 consults booked till 13:00.** 09:31 Session Quality Sentinel sees 4 `room_create` failures in 2 min → `tele.mode_downgraded(dept=all, to=phone)` + coordinator banner. 09:33 coordinator worklist re-sorts by slot; WhatsApp template "your doctor will call you on this number" goes out (transactional). Doctors' queue shows a phone icon and the tightened Rx rule (audio: List O for first consults, List A/B still fine for verified follow-ups). 09:40 first phone consults via PBX click-to-call (number masking); `tele_sessions.mode=phone`. Two first-consult patients needing List A drugs are offered a video retry at 12:00 or walk-in credit (D14). 11:10 vendor recovers; new sessions revert to video; ongoing phone sessions finish as phone. Paper path: none needed (core is up). Backfill: none. Audit shows one `tele.mode_downgraded`, 22 sessions with mode and fault code, 2 conversions, 0 refunds, vendor SLA credit claim exported from the sentinel's table.

**6.2 Core server down 15:00–15:50, three consults in progress.** Video rooms survive (vendor). Doctors continue; the Rx cannot be issued. Downtime kit (11c) paper Rx pad carries name/registration no./council as TPG needs; doctor photographs and WhatsApps a signed image from the hospital number to the patient (TPG-acceptable signed-image prescription). 15:55 core back: coordinator backfills `consultation.completed` and the Rx with `occurred_at=15:20`; the TPG class check runs in review mode (H3). One backfilled line is a List B drug on a first consult → MS review queue; the doctor writes the justification. Audit: `downtime.declared/.ended`, three backfilled encounters with `recorded_at` > `occurred_at`, one `tele_rx_class_events.verdict=review` resolved by MS.

**6.3 Tuesday — the only tele-enabled cardiologist no-shows, 11 patients waiting.** 10:05 doctor-late SLA at 5 min → coordinator nudge; 10:15 duty manager; 10:20 `doctor_no_show` fires for all 11: refund case cause `doctor_no_show`, policy 100% auto below ₹2,000 → 11 refund vouchers to source instrument, no approval (O-2); patients get "refunded + first-priority rebooking link". 10:25 duty manager offers the physician-of-day tele slots for 4 who accept; E2 bulk transfer. Doctor turns up at 10:40 (traffic) → 3 patients still online accept; new sessions, new invoices (the old ones are refunded — no reuse). Digest next morning: doctor-late count, 11 refunds ₹X, 7 rebooked. KPI reads load context (traffic incident noted by duty manager as a free-text flag).

**6.4 A minor, a VIP and a narcotic request in the same hour.** 11:00 a 16-year-old joins alone → identity_verify fails, `minor_without_adult`; rebook with mother; no fee. 11:20 sealed VIP joins under alias; participant list shows alias; coordinator's search audit logs; doctor's screen shows the real name (treating-team carve-out). Family member tries to join from a second link → observer request needs patient's on-camera OK; refused. 11:45 a patient with a plausible old MRI asks for tramadol + alprazolam "as before" → no reference in-person encounter in 6 months → first consult → H1 drugs blocked by the List B rule; tramadol on the configured Prohibited/NDPS class → hard block; `tele.rx_class_blocked` ×2; Fraud Sentinel counts phone number against two other tele attempts this week → MS diagnostic. Doctor advises in-person visit with records. Audit: three encounters, three distinct outcome codes, zero Rx lines on the third.

**6.5 Power + network loss at the doctor's home, mid-programme review for a post-CABG patient with SpO2 88 self-reported.** Doctor drops (hospital-fault by policy). Reconnect window; coordinator phones the patient within 2 min; the red-flag rule (SpO2 < 90 on a programme patient) has already created an escalation task to the RMO on duty with the 5-min ack timer; RMO calls the patient: advises ER now, ambulance pre-arrival notified. Session closes `converted_emergency`; refund 100% (O-5). Audit: `home_vitals.recorded(plausibility=ok)`, `task.escalated`, RMO ack in 3 min, `ambulance.prearrival_notified`, `tele.session_dropped(fault=hospital)`.

**6.6 Female doctor harassed on a video call.** Doctor taps "end & report" (one-touch, like Code Violet): session terminated, recording of the last 2 min retained only if the recording flag was on — else the vendor's session metadata + doctor's statement; `tele.abuse_flagged`; patient's tele access blocklisted pending MS/ICC review; incident register (POSH ICC channel per S10 §12.17 for staff protection); police complaint task offered to the doctor; fee not refunded (policy). Digest to owner in real time (abuse class). Audit: one incident, one blocklist entry with reviewer and expiry.

**6.7 WhatsApp template bans + gateway webhook silence on the same morning.** Links go by SMS (C3); payments still happen but webhooks stop → after 5 min without any webhook while links are being paid, the sentinel flips to *polling* the gateway's order-status API (deterministic) and marks receipts; coordinator sees "payment status: polling". T+1 recon catches anything missed. Paper path: counter tender for anyone who can send a relative. Audit shows source=poll on those receipts.

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / body | What the system holds | Who signs |
|---|---|---|---|
| Teleconsult log/record | **TPG 2020** (Appendix 5 to IMC Professional Conduct Regulations 2002; NMC 2023 RMP regs held in abeyance so TPG 2020 stays operative) §3.7 records, §3.2 identity, §3.3 consent, §3.4 first/follow-up, §3.7.4 drug lists | `tele_register` + `tele_identity_checks` + `tele_consents` + `tele_rx_class_events` | RMP (registration no. on every artefact); MS approves specialty whitelist |
| Prescription validity | D&C Act 1940 + Rules (Schedule H/H1/X); NDPS Act; TPG Prohibited List; **signature**: TPG accepts digital signature or signed image; IT Act 2000 recognises eSign/DSC | Rx PDF with RMP name, reg no., council, date, QR verify URL, signature block; Schedule H1 register from dispense (Plan 16) | RMP; recommended: server-side PKI signing bound to the doctor's login + TOTP (already exists) day one; Aadhaar eSign via a licensed ASP later (O-3) |
| Consent | DPDP Act 2023 §§5–7 (notice, consent, purpose), TPG §3.3 | `tele_consents`, template registry with versions in Hindi/English | patient / lawful guardian |
| Recording | DPDP; IT Act §43A/SPDI; vendor DPA (§11.19-E-2) | `tele_recordings`, access log, retention policy, legal hold | DPO owns policy |
| Minors | TPG §3.2 (adult present); POCSO where triggered; MTP Act not applicable remotely | identity check subject=adult_for_minor | RMP |
| Emergency exclusion | TPG §3.4.2 | conversion outcome + advice text | RMP |
| Cross-border | NMC Act 2019 §34 (all-India practice); foreign jurisdictions' licensure; FEMA (FIRC); GST Notification 12/2017 entry 74 (exempt healthcare) | `ip_country`, currency, FIRC ref on receipt | CA config; owner ruling O-9 |
| Payments | GST/TDS; 269ST irrelevant (digital); gateway KYC | payment links, gateway refs, recon | billing supervisor |
| Clinical Establishments Act | facility registration covers tele as OPD service | register entry | — |
| NABH | AAC/COP tele-health standards: identification, consent, records, emergency guidance, complaints | the same tables; grievance workflow (§11.14) | quality manager |
| CERT-In | breach of recordings → 6-h report | security incident flow | — |
| DPDP data classes | Class: **sensitive health + biometric-adjacent (video)**; identity photos not retained; interpreter as processor; vendor as processor | DPIA revision item | DPO |

**What an inspector asks for:** the register for a date range with RMP registration numbers; proof of consent per consult; evidence that Prohibited-List drugs cannot be prescribed (show `tele.rx_class_blocked` events and the rule config version); the recording policy and access log; the emergency-advice script; complaints. All are tables, exported with QR-stamped PDFs.

## 8. Staff KPI & KRA

All event-derived, load-normalised, diagnostic only (S10 §2). Formula ids proposed for the KPI registry (`tele.*`).

**OPD Consultant (card 8, tele extension)**
- `tele.doctor_punctuality` = sessions where doctor joined ≤ 5 min after patient / tele sessions · load: sessions/day · SLA-linked · reading: late pattern by weekday → schedule fit, not blame.
- `tele.consult_duration_p50` from `consultation.started/.completed` · by specialty.
- `tele.rx_class_block_rate` = `tele.rx_class_blocked` / Rx issued · reading: high = doctor unaware of TPG lists → training; not a penalty.
- `tele.conversion_rate` = converted_in_person / completed · reading: very high → specialty not suited to tele; very low with high readmit → under-conversion.
- `tele.followup_closure` = completed follow-ups within window / advised.
- `tele.override_reason_completeness` (inherits Plan 16a).
- Gaming: marking consults follow-up (needs reference encounter — structural); shortening consults (duration floor alarm as diagnostic).
- **KRA:** every tele consult identity-verified, TPG-classed, decided, documented; conversions honest.

**Tele Coordinator (NEW-T1)**
- `tele.link_to_payment_p50` (link issued → payment) · `tele.lapse_rate` · `tele.waiting_room_wait_p90` · `tele.drop_recovery_rate` (reconnected / dropped) · `tele.refund_case_tat` · `tele.rebooking_rate_after_no_show` · `tele.intake_completion_rate`.
- Load: bookings/day, concurrent sessions. Gaming: fault mislabelling → webhook cross-check (I4).
- **KRA:** every booked consult reaches a terminal state with money reconciled the same day.

**Tele Nurse / Navigator (NEW-T2)**
- `prog.touchpoint_ontime` · `prog.redflag_ack_time` (5-min class) · `prog.readmission_30d` (diagnostic, risk-adjusted by programme) · `prog.enrolment_coverage` = enrolled / eligible discharges · `home_vitals.plausibility_reject_rate`.
- **KRA:** no programme patient deteriorates unheard.

**Billing supervisor:** `tele.unmatched_gateway_settlements_T1`, `tele.refund_auto_vs_manual`.

**Owner 8 a.m. digest lines:** tele consults yesterday (new/follow-up), revenue, refunds by cause, doctor-late count, drop rate by vendor, conversions to in-person/emergency, Rx class blocks, programme red-flags and acks, abuse incidents, vendor minutes vs budget.

## 9. AI agents & the copilot

| Candidate | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval/guardrail | DPIA class | Phase |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tele Eligibility Gate | automation | rule (T0-style, blocks by policy not judgment) | booking request: DOB, prior encounters, specialty, mode, free-text reason keyword list | verdict + reasons | none (rule); MS owns config | coordinator override with reason (evented) | per-automation | config version in event | fixture book per TPG clause | none (no inference) | Plan 21 |
| TPG Rx Class Check | automation | rule inside Rx transaction | Rx lines, salt→list map, consult class, mode | allow/block/warn per line | doctor (unclassified only) | never bypassable for Prohibited; backfill review mode | global halt does NOT disable (it is a statute rule, not an agent) | rule version | mutant: removing block must fail tests | none | Plan 21 |
| Follow-up Scheduler | automation | T1 | `consultation.completed` with follow_up_days, programme rules, doctor tele schedule | proposed slot + WhatsApp yes/no | patient confirms (propose→confirm) | coordinator books manually | per-automation | — | slot never overbooks | none | Plan 21 |
| No-show / lapse Recall | automation (extends Recall & Follow-up) | T1 | `appointment.no_show`, `tele.payment_link_lapsed` | recall ladder (WhatsApp → SMS → call task) | none | coordinator call list | existing | — | quiet hours honoured | none | 12b/21 |
| Session Quality Sentinel | automation | T0→T1 | vendor webhooks, gateway webhooks | downgrade flags, refund cases, vendor SLA report | billing supervisor for refunds above threshold | manual downgrade button | per-automation | — | false-positive rate on drop detection | none | Plan 21 |
| **Pre-consult Intake Summariser** | agent | **T2** | intake questionnaire (structured), uploaded report text (OCR'd, scrubbed), home vitals, Lens fact sheet (`tele-consult` pack) | 5–8 cited briefing lines: complaint, duration, red flags present/absent, meds listed by patient, uploads summarised | doctor reads; never patient-facing | deterministic card (Lens Phase A) | per-agent; global halt | model id, prompt version, input/output hash in event + not in the signed Rx | citation-drop renderer, adversarial fixtures (instruction-shaped complaint text), name-leak scrubber | health data, tokenised text only; no audio/video ever | post-12a, Lens Phase B gates |
| Consult-note drafter from transcript | agent | T2 | audio → transcript | note draft | doctor | doctor types | per-agent | as above | — | **blocked by the audio inference-locus ruling (11h DD11)**; listed, not scheduled | later |
| Fraud Sentinel tele pack | automation | T0 | Rx class blocks × phone × 30 d; refund causes × coordinator; payer-instrument reuse | diagnostics to MS / billing supervisor | reviewer disposition (S10 §12.27) | — | existing | — | — | none | 12b |
| Programme red-flag router | automation | T1 | questionnaire answers, home vitals thresholds (programme-versioned) | escalation task with ack timer | RMO acts | nurse phone list | per-automation | — | threshold fixtures | none | Plan 21 |

**Presentation lanes.** Lane 1 (hand-built): doctor's tele queue with join button, in-call side panel (snapshot card, Rx pad, orders, chat, screen-share of reports, "convert"/"emergency"/"end & report" buttons); coordinator waiting-room board. Lane 2 (schema-generated): refund cases, identity failures, programme touchpoints, abuse reports, vendor SLA — worklists from tool schemas. Lane 3 (conversation): coordinator asks "who is still unpaid for 11:00?" → tool call under PermissionGuard; clinical roles last (deferred-note 3 rollout). **Journey Feed contributions:** `tele.*` events render as "video consult with Dr X — verified, completed, Rx issued (List A), follow-up 7 d"; programme touchpoints as timeline dots; red-flags as the only interrupting item.

**Prompt inputs, concrete (summariser):** `{pack: tele-consult v1, lines: [L1 age-band/sex, L2 complaint text (scrubbed), L3 duration, L4 patient-listed meds → formulary matches, L5..Ln uploaded report OCR text (scrubbed, ≤ 4 k tokens), Lm home vitals with plausibility, Lx allergies "none recorded"/list, Ly last in-person consult summary lines]}` → typed claims `summary|observation|alert-restatement` with citations; no free advice; no drug suggestions (TPG: AI does not prescribe).

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One link does everything:** booking confirmation, payment, intake, consent, join — a single tokenised URL (Plan 10 public read surface pattern), OTP-guarded, expiring; measured target: booking→paid ≤ 10 min p50.
- **Pre-join device test** (camera/mic/bandwidth) with a phone fallback — cuts drop rate; target drop < 5%.
- **Doctor queue with join button** and the snapshot card already open (Lens Phase A); target doctor prep < 30 s.
- **Rx pad identical to OPD** (keyboard-first, formulary autocomplete) with the TPG class shown inline per line before issue; target zero Prohibited attempts reaching pharmacy.
- **QR on the Rx PDF and the receipt**; pharmacy/lab scan-in; verify endpoint public-read with alias.
- **TAT clocks:** waiting-room wait, doctor-late, reconnect window, closed-out delivery — all `sla.breached`, only waiting-room wait actively alerts (§10.3).
- **Mid-consult chat + file drop** (vendor feature) stored as `tele_documents`, never as clinical truth without the doctor's note.
- **Screen-share reports from the EMR** (doctor shares the result viewer) — patient sees the actual document.
- **PBX click-to-call with number masking** for phone fallback and callbacks.
- **Printing:** patients can walk in to any counter with the QR to print the Rx.
- **Voice:** none on the patient path until the audio ruling.
- **Auditability:** every state transition an event; register self-writes; the signed Rx embeds the class-check result id.
- **Perf:** in-call side panel loads under the §15 budgets (<300 ms patient search, <100 ms interactive).

## 11. Integrations, devices & dependencies

| Item | Choice / protocol | Note |
|---|---|---|
| Video SaaS | WebRTC SaaS via a `TeleProvider` adapter: **100ms** (Bengaluru; India region), **Dyte** (Indian; now Cloudflare), **LiveKit Cloud** (India region available) / LiveKit self-host, **Daily.co**, **Zoom Video SDK**, **Agora**; **Jitsi** self-host as the exit-path implementation. Twilio Video sunset (Dec 2024) is the cautionary precedent for the adapter. | HIPAA-style BAA/DPA, India data region for recordings, webhook signing, SDK for browser only (no app) |
| Payment gateway | **Razorpay / PhonePe PG / Cashfree** payment links + UPI intent; webhook + order-status polling; settlement file into billing recon (existing T+1) | NEW integration, not Plan 10; PCI scope stays at gateway |
| Messaging | Plan 10 gateway (WhatsApp Cloud API / SMS) templates: `tele_link`, `tele_reminder`, `tele_docs_ready`, `tele_refund` | quiet hours; sealed class templates |
| Telephony fallback | PBX (bought, §9) with click-to-call and number masking; or cloud telephony (Exotel/Knowlarity) | |
| e-sign | Day one server-side PKI + TOTP act; later Aadhaar eSign via licensed ASP (eMudhra/NSDL) or DSC Class 3 | O-3 |
| Home devices | Phase A: typed + photo; Phase B: Bluetooth BP/SpO2/glucometer via a patient web page (Web Bluetooth on Android Chrome) or vendor app export; Omron/Dr Trust/Accu-Chek; readings as FHIR Observation | edge-service rule not triggered (no protocol boundary in the hospital) |
| Interpreter | on-call service joins by link | bought |
| Pharmacy delivery | doc 03 / Plan 16 hand-off via `prescription.issued` + QR verify | |
| Home collection | Plan 17 order with `fulfilment=home_collection` | |
| ABDM | care-context notification later, same as OPD | |
| Events consumed | `appointment.*`, `payment.received/.refunded`, `consultation.*`, `prescription.issued`, `order.placed`, `result.published`, `patient.discharged`, `patient.deceased` (suppress programme), `doctor_leave.scheduled`, `downtime.declared/.ended` | |
| Depends on plans | 07 (encounters, done), 08 (billing, done), 09 (accrual, done), 10 (messaging, done), 12a (runtime, for the summariser), 16 (pharmacy hand-off), 17 (home collection), the E-1 topology decision (public link surface exposure) | |

## 12. Buy vs build, hardware & rough INR budget

**Buy:** video SaaS (₹1.5–4 L/yr at 100 consults/day; ~₹0.30–0.60/participant-minute), payment gateway (1.5–2% MDR; UPI often 0), telephony masking (₹20–40 k/yr), interpreter service (per session), eSign ASP (₹5–15 per signature or ₹30–60 k/yr). **Build:** the `tele` module (workflow, register, class rule, links, programme) — ~ one phase. **Hardware:** two OPD tele cabins (acoustic panel, 1080p webcam, headset, LED light, 24" monitor): ₹35–50 k each; doctor home kit allowance: ₹8–12 k; programme loan devices (BP monitor ₹2.5 k, pulse-ox ₹1.2 k, glucometer ₹1 k) × 50 = ₹2.5 L; bandwidth: dedicated 100 Mbps line at hospital ₹1–1.5 L/yr. **Year-1 total ≈ ₹8–12 L** excluding gateway MDR.

## 13. Owner rulings needed

- **O-1 Vendor & residency.** Default: 100ms or LiveKit Cloud (India region), recordings off; DPA signed; Jitsi kept as exit implementation. Why: Indian entity + region, browser-only SDK, adapter protects against sunset.
- **O-2 Refund policy table (D2).** Default as written; auto-refund below ₹2,000 without approval for doctor no-show/hospital fault. Why: refund friction is the top tele complaint; the approval engine still gates above threshold.
- **O-3 Signature method.** Default: server-side signing bound to login + TOTP day one (TPG-acceptable), Aadhaar eSign later. Why: cost and doctor friction; legal review requested.
- **O-4 Identity-failure fee.** Default: no fee (full auto refund) for minor-without-adult / identity mismatch. Why: legal posture > ₹.
- **O-5 Emergency conversion fee.** Default: 100% refund, ER pre-arrival note. Why: TPG exclusion, patient goodwill.
- **O-6 In-person conversion credit.** Default: full tele fee credited to an OPD visit within 24 h. Why: prevents double charging and encourages honest conversion.
- **O-7 Fee split for home-based tele.** Default: same split as hospital-based; a `location` attribute exists for a different % if negotiated. Money — owner's.
- **O-8 Platform/convenience fee.** Default: none (keeps the invoice GST-exempt only).
- **O-9 International patients.** Default: second-opinion/advisory service only; prescriptions for non-residents marked India-only; treatment consults only for Indian residents abroad temporarily, on legal advice. Legal exposure — owner's.
- **O-10 Specialty whitelist & first-consult policy.** Default: dermatology, psychiatry, general medicine, diabetes/endocrine, paediatrics (with adult), gynaecology follow-ups, ortho post-op, cardiology follow-ups; first video consults allowed everywhere except where the MS excludes. MS to confirm.
- **O-11 Recording policy.** Default: OFF; departments may request ON with explicit consent and 90-day retention.
- **O-12 Post-discharge programme as a paid or free service.** Default: free nurse touchpoints for 30 days post day-care/IPD, tele doctor review paid at follow-up rate (or free within window). Money — owner's.
- **O-13 Audio inference-locus amendment** (already routed by 11h) — the consult-note drafter waits on it.

## 14. Plan sketch

**Proposed Plan 21 — Teleconsultation & Remote Follow-up** (20 is reserved in case the series assigns it to an earlier neighbour; numbers 14–19 are taken by the stage-2 tracks). Dependencies: 13 done; 16 (pharmacy hand-off) and 17 (home collection) are *soft* — hand-offs ship as events consumed later; 12a for the summariser only. **Slot:** after 16 pharmacy in Track A, or in Track B parallel after 19 since it touches no physical operations — recommend **Track B after 19**.

- **21-T1 Schema + module:** `tele` folder, tables §4, manifest, permissions (`tele.book`, `tele.consult`, `tele.refund_case`, `tele.register.read`, `tele.recording.access`), `type='teleconsult'` fixtures on `opd_encounters`.
- **21-T2 Workflow definition `teleconsult_visit`** + SLAs + ladder; encounters.ts extension for tele states; queue session mode.
- **21-T3 Payment links:** gateway adapter, webhook + polling, receipt/tender integration, recon file, refund reverse-to-source, policy table.
- **21-T4 TeleProvider adapter + sessions:** create/join tokens, webhooks, participants, drop/reconnect, downgrade, abuse one-touch; Jitsi second implementation in CI.
- **21-T5 Eligibility gate + consent + identity:** intake link (public surface), consent templates, identity check UI, minor/caregiver logic, register self-write.
- **21-T6 TPG Rx class rule** inside Plan 16a's issue transaction; salt→list config (Class B governed); backfill review mode; Rx PDF with reg no./QR/signature block; verify endpoint.
- **21-T7 Doctor & coordinator screens** (Lane 1) + schema worklists (Lane 2).
- **21-T8 Follow-up programme:** definitions, enrolment on discharge/consult, touchpoints, red-flag router, home vitals intake.
- **21-T9 Automations:** scheduler, recall extension, quality sentinel, Fraud Sentinel pack; digest lines; KPI registry entries.
- **21-T10 Compliance pack:** register export, DPIA revision, consent forms Hindi/English, SOP, NABH evidence map; gate report.
- **Later 21b:** Bluetooth devices, Aadhaar eSign, summariser activation (Lens pack `tele-consult`), interpreter integration, international billing.

**Must be true before authoring:** vendor DPA draft and region confirmed; gateway merchant account; MS's specialty whitelist; the TPG salt→list mapping sourced (licensed content line per §9 v4.6 or DTC-authored); E-1 topology decided (public link exposure); counsel view on O-3/O-9.

**Negative-space question:** *what absence is a signal here?* — a tele slot block with no session (off-platform consult, leakage); a completed consult with no Rx, no order, no follow-up and no conversion (undocumented outcome); a programme enrolment with zero touchpoints in 7 days (nurse overload or dead enrolment); a paid link with no join within 24 h (patient lost); a doctor with zero `tele.rx_class_blocked` ever across hundreds of consults (rule not reaching them — check config); a sealed-class department with zero sealed encounters (misconfiguration).

**Staff edge-case interview questions (department head / senior consultant / front office):**
1. Which specialties will you refuse to see first-time on video, and why?
2. How often do patients ask a relative to "attend for them" today, and what do you do?
3. Which drugs do you routinely continue that would fall under List B, and how do you know the last in-person date?
4. When a patient can't pay online, who at home can — and how long do you hold the slot?
5. What do you do when a call drops mid-sentence: call back yourself, or should the desk?
6. Have you been harassed or recorded without consent on a call? What should the button do?
7. Which reports do patients typically hold on paper that you need to see clearly?
8. How many minutes is a fair tele consult in your specialty, and where does it overrun?
9. What would make you convert to in-person — and should the patient pay twice?
10. Which post-discharge patients bounce back within 30 days and what call on day 3 would have caught it?
11. Do you consult from home now, on what device, and what personal number do patients have?
12. How do you want your registration number and signature to appear on the e-Rx?
13. What language mismatch happens most, and who translates today?

## 15. Open questions & risks

- **Source of the TPG List O/A/B mapping per salt** — TPG annexures name categories and examples, not a complete salt list; needs a DTC-curated table (Class B governed) and periodic review; risk of over- or under-blocking. Mitigation: unclassified = warn, Prohibited/NDPS/Schedule X = block.
- **NMC RMP Regulations 2023** were held in abeyance; if reinstated with different tele rules, the class-rule config must be re-issued — config, not code, but a legal watch item.
- **Public link surface exposure** waits on the E-1 topology decision (Plan 10's relay half); until then the intake/join link serves from the single VM.
- **Audio/video inference** — any transcript-to-note or ambient scribe is blocked by the standing inference-locus law pending the §19 amendment; the summariser is text-only.
- **Gateway vs counter reconciliation** — link payments are a third tender source; the daily close and cashier-session model treat them as non-cashier receipts; needs a billing decision that cashier session variance excludes gateway receipts.
- **Foreign-patient legality** (O-9) cannot be settled here.
- **Vendor lock-in / sunset** — mitigated by the adapter and a CI-green second implementation; cost of keeping Jitsi green is real.
- **Doctor at home = hospital fault** for drop policy is a policy choice that may be contested by visiting consultants; fee-split negotiations may want the location attribute (O-7).
- **Programme red-flag thresholds** need clinical sign-off per programme (MS second key); until then programmes ship with nurse-call-only touchpoints.
- **Resource registry**: no new kind requested; if the owner wants virtual rooms as resources for utilisation views, that is an eleventh kind and a kernel edit (Plan 13 DD4) — recommend against.
