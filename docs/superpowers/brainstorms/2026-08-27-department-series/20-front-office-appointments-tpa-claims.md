# 20 — Front Office, Appointments & Call Centre, OPD Flow at Scale, TPA/Claims Desk, Feedback & Grievance — Brainstorm & Planning

- **Date:** 2026-08-27
- **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED
- **Series:** Department Brainstorm & Planning Series (authoring brief `_AUTHORING-BRIEF.md`)
- **Ground truth read:** spec v4.8 §4–§10, §11.1, §11.2, §11.4, §11.5, §11.11, §11.13, §11.14, §11.19-C/D/E, §14–§17 · S10 §1–§3, §9A, §10–§11 · copilot design §0, §2 · roadmap stage-2 acceleration + deferred notes 1–17 · Plan 07 design D1–D9 · Plan 08 design D1–D10 · Plan 13 §1

**Executive summary.** This document covers the *front of the house* — the desks, phones, screens and paperwork that stand between a patient and a doctor, and between the hospital and the people who pay for care on the patient's behalf. It is five neighbouring capabilities that share one floor and one supervisor: (1) the appointment book and call centre, (2) OPD flow orchestration at 2,000 visits/day (registration counters, kiosks, queue displays, desk-to-desk handoff), (3) the TPA/insurance desk and claims lifecycle from empanelment to settlement, (4) feedback and grievance, and (5) certificates and medico-legal document issuance. It is NOT the OPD encounter engine (Plan 07, shipped), NOT the billing counter (Plan 08, shipped), NOT the notifications gateway (Plan 10), NOT IPD admission/bed board (IPD cluster), and NOT a phone system or a CRM marketing suite (bought, §9). Its three hardest problems: **(a) keeping a 2,000/day queue honest** — appointment-priority discipline, doctor delays, overbooking and no-shows interacting live without the front-office supervisor "walking the queue"; **(b) the claims desk as a money-and-law machine** — pre-auth clocks, proportionate deductions, non-payables and short-payments where every rupee lost is either a leak or a write-off that must be attributed; **(c) identity at speed** — 12–16 registration counters plus kiosks plus WhatsApp pre-registration must produce *fewer* duplicate UHIDs than two clerks do today, while VIP/staff/sealed-class patients stay aliased on every public surface.

---

## 1. Frame — what exists, what is locked, what this document adds

### 1.1 What exists (shipped, Phase 1)
- **Patients module** (Plan 05): UHID, phone-first search (<300 ms CI-enforced), photos, QR (signed), allergies, guardians with authority scope (D-31), merge/unmerge with approval gate (`merge.ts`), confidential flag + alias (`alias_required`), ABHA address/number/verification status/link token (D-30), `intended_payer`, `referral_source`, `deceased_at`, preferred language.
- **OPD module** (Plan 07): `opd_visit` workflow definition (registered → waiting → in_consultation → completed/awaiting_results/abandoned, SLAs 20/45/60/240 min, waiting is an *active* alert with escalation front_office_supervisor@15 → duty_manager@30); pure `orderQueue` implementing §11.1 discipline (classes 0 danger · 1 re-entry · 2 due appointments · 3 walk-in FIFO · 4 future appointments; E-32 perk interleave); per-doctor-per-day tokens; `callNext/skipCalled` single-winner; visit type `classifyVisit` (new/revisit/renewal, 7-day default, 15/21/30 extension capped per doctor per month, §11.19-C fix 14); vitals with age-band danger ranges; consult note + versioned e-Rx + allergy hard warning; masters (departments, rooms — *moving to the Plan 13 registry*, doctors, weekly schedules, leaves `doctor_leave.scheduled`); `slotsForDate` pure; appointments with partial unique `(doctor_id, slot_start)` arbiter; reschedule atomic; `needs_rebooking` status on leave; realtime WebSocket `/ws` with topic permissions; 19 events.
- **Billing** (Plan 08): pay-before-consult guard (`fee_unsettled`), fee branch new/renewal (revisit free), receipts/allocations/credit notes/refund vouchers (approval-gated, bank-transfer above threshold, refund-to-payer identity), cashier sessions + variance approval (SoD structural), cash law C-2 thresholds, degraded tender mode, tender recon by statement upload, daily close + orphan scan. **Explicitly not built:** corporate/TPA contract billing, dunning beyond the dues worklist, e-invoicing.
- **Notifications** (Plan 10): WhatsApp/SMS outbound queue, template registry, quiet hours, fallback ladder, DPDP transactional/promotional split, **public read-only surface** (E-1: queue position, document verification) split out to land separately.
- **Memberships/partners** (Plan 09): perk flag, accrual ledger, referrer payee classes (C-1).
- **Kernel:** events outbox, workflow engine (`workflow_instances`), approvals, RBAC actor fabric incl. agent grants, scheduler/worker, ops modes (commissioning/downtime), global search/command palette, user admin.
- **Formulary + prescribing safety** (Plan 16a). **Resource registry** (Plan 13, in flight: `resources`, `resource_status_history`, kinds incl. room/bed/device).

### 1.2 Locked decisions this document inherits (not re-litigated)
| # | Locked decision | Source |
|---|---|---|
| L1 | Queue discipline: appointment-priority; walk-in beats *future* appointment never a due one; late keeps priority; danger vitals and same-day re-entry outrank all; perk = bounded interleave | §11.1, §11.19-D fix 32, Plan 07 D2 |
| L2 | Public displays and audio announce **tokens only, never names**; confidential/VIP/staff-as-patient aliased on all public surfaces | §11.5, §14 |
| L3 | Follow-up window 7 days default; doctor extends 15/21/30; extensions capped per doctor per month, evented | §11.1, §11.19-C fix 14 |
| L4 | Same-day re-entry after tests: same visit, no new fee, priority class | §11.1 outcome B |
| L5 | E2 doctor unavailable mid-queue → bulk queue transfer (consent) or refund, one approval | §11.1 |
| L6 | Doctor planned-leave cascade: book blocks, auto-notify + one-tap rebooking, unresolved → call tasks | §11.5 |
| L7 | Pay-before-consult; relaxes to pay-before-exit only under declared rails-down mode; E3 emergency = treatment first, no payment gate | §11.1, §11.19-E fix 24 |
| L8 | Duplicate merge/unmerge with side-by-side timeline review and approval gate; wrong merge = patient-safety emergency, must be splittable; false-attach detection + photo prompt | §11.5, §11.19-C fix 18 |
| L9 | Voice between desks = bought IP-PBX; HMIS shows directory and does handoffs, never becomes a phone system; PBX must have API/paging integration and heartbeat | §9, §11.19-E fix 23 |
| L10 | Notification fallback ladder WhatsApp → SMS → IVR → manual-notify flag; quiet hours 9 p.m.–8 a.m. (urgent recalls exempt); promotional strictly opt-in | §11.5, §11.13 |
| L11 | Payer switch mid-stay only after documented counselling + signed consent; invoice lines attributed by payer period | §11.4 map 3 |
| L12 | Pre-auth sanction is a first-class object (amount, class, LOS, procedure scope) with deviation triggers — **lands with the IPD phase**, before the full TPA desk | §11.19-D fix 6 |
| L13 | Insurer-share/patient-share split first-class; room-rent-cap proportionate deduction computed and shown; IRDAI non-payables list as configuration; co-pay handling | §11.19-D fix 5 |
| L14 | Discharge cascade has "awaiting payer final approval" state; clock pauses attributably on the payer | §11.19-D fix 9 |
| L15 | Payer settlements decompose gross-allowed / disallowed / TDS-194J / GST-TDS / net; ageing on net-of-TDS; credit-stop at 60 days; write-offs only via approvals ladder | §11.11, §11.19-D fix 2 |
| L16 | Insurance identity fraud: photo verification at cashless intake; mismatch → payer-switch + incident + insurer notification | §11.14 |
| L17 | External-access personas for TPA desk auditors: read-only, time-boxed, sealed-class excluded, evented | §11.19-E fix 20 |
| L18 | Live grievance workflow: any staff raises → management task with TAT → documented resolution → attendant-acknowledged closure; complaint register self-feeds NABH; single-spokesperson rule | §11.14 |
| L19 | Patient-satisfaction capture starts Phase 1 as a post-visit WhatsApp micro-survey | §11.19-D fix 38 |
| L20 | Patient navigation for low-literacy/unaccompanied is a designed path; navigation duty on front-office roles day one; dedicated navigator at scale | §11.19-D fix 34, S10 mech. 22 |
| L21 | ABDM: ABHA address + verification + link tokens; care-context link-suppression for sealed class; Aadhaar never a registration precondition ("ABHA nullable, never blocking a visit") | §6, §11.19-E fix 30 |
| L22 | Agents payer-blind and VIP-blind in prioritisation; wait-time-by-payer-class equity report monthly | §11.19-D fix 37 |
| L23 | MLC documents restricted legal documents; release only against logged requisition; DPDP DSR register; retention OPD ~5y / IPD ~10y / MLC indefinite; legal-hold | §11.4 map 12, §11.14 |
| L24 | Rollout order: TPA/PMJAY/claims desk is roadmap step 6 (after IPD, PACS); CRM/feedback/IVR step 9 — but L19 pulls the micro-survey forward and L12 pulls pre-auth forward | §17 |
| L25 | Every SLA-bearing lifecycle is a workflow definition; owner activates; Class A/B/C change classes | §10.2, §11.19-D fix 15 |

### 1.3 What this document adds (scope) and neighbours (who owns which table)
| Capability | This module owns | Neighbour owns |
|---|---|---|
| Appointment book v2 (overbooking, waitlist, confirmations, reminders, delay declarations, leave cascade execution) | `appointment_policies`, `appointment_waitlist`, `doctor_delays`, `appointment_confirmations` | `opd_appointments`, `opd_schedules`, `opd_leaves` stay in OPD (Plan 07); this module calls OPD's declared interface |
| Call centre | `calls`, `callback_tasks` (as P5 tasks), `ivr_menus` config, PBX CDR import | PBX (bought) owns telephony; Plan 10 owns WhatsApp bot transport |
| Queue displays & audio | `display_endpoints` (registry kind `display`), announcement queue, TTS cache | OPD owns queue entries; Plan 13 owns rooms |
| Multi-counter registration, kiosk, pre-registration | `preregistrations`, `kiosk_sessions`, `counter_assignments`, `duplicate_candidates` | Patients owns `patients`, merge; Plan 10 public surface serves the pre-reg link |
| Desk-to-desk handoff | `handoffs` (the §9 cross-cutting module — proposed to live here) | — |
| TPA/claims desk | `payers`, `empanelments`, `payer_tariff_maps`, `policies`, `preauths` (extends the IPD-phase object), `preauth_queries`, `claims`, `claim_documents`, `claim_queries`, `settlements`, `settlement_lines`, `non_payables`, `shortfall_writeoffs`, `pmjay_cases` | Billing owns invoices/credit notes/receipts; IPD owns admission/bed class/discharge cascade; MRD owns record release |
| Feedback & grievance | `feedback_responses`, `nps_touchpoints`, `grievances`, `grievance_register` (statutory), `review_routings` | Quality/NABH pack owns incident reporting and indicator dashboards |
| Certificates & medico-legal docs | `certificates`, `certificate_templates`, `mlc_document_issues` (register) | MRD owns records-release workflow and custody; ER owns `mlc.registered` |

Scope boundary rule: this module **never writes** `opd_encounters`, `opd_queue_entries`, `invoices`, `patients` — it calls their interfaces and consumes their events.

---

## 2. Actors, roles & role cards

### 2.1 Human roles (S10 card numbers where they exist)
| Role | S10 | Shift | Stations | Notes |
|---|---|---|---|---|
| Registration Clerk | #1 | 3 shifts, 06:30–22:00 OPD + night skeleton at ER desk | UHID desk, revisit counter, kiosk assist | HC 2 → 12–16; A3 exception-handler post |
| Front-Office Supervisor | #2 | one per shift | Queue dashboard, displays, handoffs, delay declarations, E2 transfers, grievance first response | Escalation rung 1 for OPD wait breaches |
| Cashier | #3 | per counter | — (Plan 08) | Interacts: fee quote, TPA co-pay collection |
| Billing Supervisor | #4 | day + on-call | Short-payment write-off approvals, credit control | Approver for claims write-offs below owner threshold |
| TPA / Insurance Desk Executive | #5 | 08:00–20:00 two shifts; **on-call night for ER cashless intimation** | Pre-auth, queries, discharge clearance, claim dossier, settlement recon | HC 0 → 6–8; split at scale: *pre-auth cell* (IPD-facing) vs *claims cell* (post-discharge) |
| Admission / Bed-Board Clerk | #6 | — | Consumes pre-auth status; payer branch | IPD cluster |
| MRD Officer | #7 | day | Certificates, MLC document release, DSR | Custodian of `mlc_document_issues` |
| Vitals-Desk Assistant | #35 | per OPD floor | — (Plan 07) | Receives handoffs |
| Quality Manager / DPO | #37 | day | Grievance officer, NABH patient-rights, DPDP grievance | Owns `grievance_register` QA |
| Duty Manager | S10 §9 | 24×7 | Escalation rung 2; downtime declare | Bundles FO supervisor + billing supervisor at night |
| **Call-Centre Agent** (NEW card, proposed) | — | 07:00–21:00 rotating; overflow to IVR + WhatsApp bot after hours | Inbound booking/enquiry/complaint intake; outbound callbacks, reminders, no-show recall, critical-result contact attempts (on task) | HC 2 → 8–10; KPI in §8 |
| **Patient Navigator** (NEW card, proposed; L20) | — | OPD hours | Floor walking, low-literacy escort, kiosk assist, wheelchair/stretcher call | HC 1 (dual-hatted clerk) → 4–6 |
| **Insurance Counsellor** (NEW card, proposed; split of #5 at scale) | — | day | Pre-admission estimate, room-rent-cap warning, co-pay/non-payables counselling, payer-switch counselling (L11) | Signs the counselling record; SoD: never the same person who files the claim for that episode's write-off |
| **Claims Auditor** (NEW card, proposed) | — | day | Pre-submission dossier QA; short-payment appeal decisions; PMJAY audit responses | SoD vs claims filer |
| Doctor / Consultant | S10 §4 | — | Delay declaration (self or via PA), leave scheduling, certificate signing, follow-up window extension | `doctor.changed`, `doctor_leave.scheduled` |
| Security / Gate | S10 #33 | 24×7 | Code Violet at counters; VIP escort; MLC police liaison desk | — |

### 2.2 Agent / automation actors (§16 taxonomy; full spec in §9)
| Actor | Kind | Tier | Ships with |
|---|---|---|---|
| Recall & Follow-up (no-show ladder, rebooking calls, abandoned visits) | automation | T1 | 12b (OPD scope) → extended here |
| SLA Chaser (wait breaches, pre-auth clocks, grievance TAT) | automation | T1 | exists (08.5 + Plan 10) |
| Appointment Optimiser | agent (with a deterministic core) | T2 | Plan 20 |
| Wait-Time Predictor | automation (regression over own events) | T0 | Plan 20 |
| No-Show Recall (extension of Recall) | automation | T1 | Plan 20 |
| Duplicate Sentinel (registration-time candidate scoring) | automation | T1 | Plan 20 |
| Claims Drafter | agent | T2 | Plan 21 (§16 says "TPA phase") |
| Pre-auth Query Responder | agent | T2 | Plan 21 |
| Feedback Triage | agent | T2 | Plan 22 |
| Call Summariser (PBX recording → structured call log) | agent | T2 | Plan 20b, DPIA-gated |
| Fraud Sentinel (ghost patients, duplicate-UHID gaming, claim-pattern anomalies) | automation → agent 2nd stage | T0 | 12b + extension |
| Leakage Auditor (non-payables billed to insurer, uncollected co-pay) | automation | T0 | 12a + extension |

### 2.3 SoD hard pairs (proposed additions to S10 §11)
- Claims filer / short-payment write-off approver for the same claim.
- Insurance counsellor who signs a payer-switch consent / approver of the resulting self-pay discount.
- Merge requester / merge approver (already structural via approvals engine; stated).
- Grievance subject (staff named in complaint) / grievance resolver.
- Certificate drafter (clerk/MRD) / certificate signer (doctor) — the signer must hold a treating relationship or a designated medical-officer role.
- Call-centre agent who logs a callback / the same agent closing a critical-result contact task without a documented contact.

---

## 3. Core flows as workflow definitions

Every lifecycle below is a workflow definition (L25); module tables mirror engine state and never own it. SLAs are proposed corporate-standard defaults (configurable, Class B).

### 3.1 `appointment_v2` (P1 overlay + P7) — extends Plan 07's appointment row, does not replace it
```
requested ──(slot arbiter wins)──▶ booked ──(T-24h reminder answered / reply "1")──▶ confirmed ──(check-in)──▶ checked_in ──▶ (OPD encounter takes over)
   │                                 │  └──(no reply by T-3h; policy)──▶ unconfirmed ──(auto-release if overbooked)──▶ released → waitlist offer
   │                                 ├──(doctor_leave.scheduled / delay > threshold)──▶ needs_rebooking ──(one-tap / call)──▶ booked'
   │                                 ├──(patient cancels)──▶ cancelled
   └──(no slot)──▶ waitlisted ──(slot frees)──▶ offered ──(accept within TTL)──▶ booked   │ (offer expires)──▶ waitlisted
booked ──(slot_start + no_show_grace, not checked in)──▶ no_show ──(recall ladder: WhatsApp → call task → close)──▶ recalled | lapsed
```
- Roles: book/reschedule/cancel — `front_office`, `call_centre`, `patient` (public surface, signed token), `doctor_pa`; declare delay — `doctor`, `doctor_pa`, `front_office_supervisor`; release unconfirmed — system (policy) or supervisor.
- SLA per state: `requested` 30 s (system) · `booked` until T-24h reminder · `unconfirmed` 3 h before slot then release · `needs_rebooking` **4 business hours** to resolution, escalation call_centre_lead → front_office_supervisor (L6: unresolved → call tasks) · `offered` TTL 30 min (walk-in day) / 4 h (future) · `no_show` recall within 24 h, second attempt 72 h, close at 7 days.
- Events: reuse `appointment.booked/.rescheduled/.cancelled/.no_show`, `doctor_leave.scheduled`, `reminder.due`, `notification.*`, `patient.recall_initiated`, `task.*`. NEW: `appointment.confirmed`, `appointment.unconfirmed_released`, `appointment.waitlisted`, `waitlist.offered`, `waitlist.offer_expired`, `doctor.delay_declared`, `doctor.delay_cleared`, `overbooking.applied`, `appointment.recalled`.
- **Overbooking policy (default):** per-doctor-per-session `overbook_pct` (default 15% of slots, cap 25%) applied only to slots at the tail of the session and only when the doctor's trailing 8-week no-show rate for that weekday ≥ 12%; overbooked slots are marked so the queue engine seats them as class 2 only if arrival ≤ slot_start + 10 min, otherwise class 3 — L1 is preserved because an overbooked appointment is still a real appointment. Every application evented (`overbooking.applied`) and visible in the digest.
- **Doctor delay declaration:** `doctor.delay_declared {minutes, reason}` shifts *every* unchecked-in appointment's `appointmentAt` by `minutes` for queue-class computation only (the slot row is untouched), pushes a WhatsApp "Dr X running ~40 min late; your position is preserved" to booked-not-checked-in patients, and opens the walk-in gap-fill window (class 3 advances against class 4 — the locked rule). Delay > 90 min or doctor absent → supervisor E2 transfer/refund path.
- **Doctor on leave (L6, `doctor_leave.scheduled`):** Plan 07 already sets `needs_rebooking`. This module executes the cascade: batch WhatsApp with **one-tap rebooking** into (a) same doctor's next available, (b) same-department covering doctor (department `cover_map` config), (c) refund; no reply in 4 h → callback task to the call centre; every rung evented; unresolved at T-2h → supervisor list.

### 3.2 `call` (P5 task-and-track over a bought PBX)
```
ringing ──(agent answers)──▶ in_call ──(disposition)──▶ closed
   └──(abandoned > 20 s)──▶ abandoned ──(auto callback task within 30 min in hours)──▶ callback_open ──▶ callback_done | callback_failed (3 attempts)
in_call ──(needs desk)──▶ transferred (PBX) · (needs action later)──▶ callback_open
IVR after hours: menu → self-serve (queue position, report-ready status, directions) | leave callback | emergency → ER extension
```
- Call disposition is a **typed enum** (booking / reschedule / enquiry / complaint / report-status / billing / TPA / wrong-number / spam); free text is a note, never state (deferred note 2 rule).
- Events NEW: `call.logged {direction, disposition, patient_id?, duration, recording_ref?}`, `call.abandoned`, `callback.requested`, `callback.completed`, `callback.failed`. Callbacks are Plan 04 tasks (`task.*`), not a second task system.
- SLA: abandoned-callback 30 min (hours) / next-morning 09:30 (after hours); complaint intake → `grievance.raised` same call.
- WhatsApp bot handoff: the bot (Plan 10 inbound adapter, deferred note 2) resolves *structured* intents (book/reschedule/cancel/queue position/report status) via the same APIs as the agent screen; anything else → `callback.requested` with transcript attached as **untrusted content** (deferred note 13).

### 3.3 `registration_session` (P1 entry; wraps Plan 05/07 calls at multi-counter scale)
```
arrived ──(kiosk/QR/phone/ABHA scan)──▶ identified ──(existing)──▶ visit_opened (OPD) ──▶ routed_to_billing
   │                                        └──(new; dup score < threshold)──▶ registering ──(photo + demographics + consent)──▶ registered ──▶ visit_opened
   │                                        └──(dup score ≥ threshold)──▶ dup_review ──(clerk picks existing / supervisor confirms new)──▶ …
   └──(kiosk stuck / assisted)──▶ navigator_assist (navigation.assisted)
```
- Counters are registry resources (Plan 13 NEW kind `counter`) with `open/closed/paused` status; a **single hospital-wide "next" ticket** for registration (separate from doctor tokens) with display per counter bank; kiosks pre-fill and print a *pre-registration slip* whose QR the counter scans (one beep, §7).
- SLA: identified→visit_opened < 60 s existing (§11.1), < 3 min new; dup_review < 2 min, escalation to supervisor.
- Events: reuse `patient.registered/.updated/.checked_in`, `visit.opened`, `abha.linked`, `navigation.assisted`, `qr.signature_failed`. NEW: `preregistration.submitted`, `preregistration.consumed`, `kiosk.session_started/.abandoned`, `duplicate.suspected {score, candidates[]}`, `duplicate.dismissed {reason}`, `counter.opened/.closed`.

### 3.4 `merge_request` (Patients owns the merge; this module owns the *queue*)
`suspected → reviewed (side-by-side timeline) → approved (approvals engine) → merged (`patient.merged`) → [unmerge path: `patient.unmerged`]`. SLA: suspected→reviewed 24 h; **a suspected duplicate on a patient with an open encounter today is reviewed within 30 min** (wrong-patient risk is live). Roles: review — `registration_supervisor`/`mrd`; approve — never the requester (SoD).

### 3.5 `opd_flow_handoff` (desk-to-desk, the §9 cross-cutting module)
```
sent ──(target desk acknowledges)──▶ accepted ──(done)──▶ completed
  └──(no ack in SLA)──▶ escalated (supervisor)          └──(target refuses w/ reason)──▶ bounced → sent (another desk)
```
A handoff = `{from_desk, to_desk (registry resource), patient_id, encounter_id, note, expected_action}`; it rides the encounter's `correlation_id` so the Journey Feed shows it. SLA: ack 5 min (vitals/billing), 15 min (pharmacy/lab reception). Events NEW: `handoff.sent`, `handoff.accepted`, `handoff.completed`, `handoff.bounced`. Cross-consult same day: `consult.requested` (exists) → handoff to specialist queue as class 1 (re-entry) in the target doctor's session, fee per §11.4 map 5 (first consult chargeable, same-day repeat free, configurable).

### 3.6 `preauth` (P6 overlay; extends the IPD-phase sanction object L12)
```
draft ──(desk submits to TPA portal/email/NHCX)──▶ submitted ──▶ approved | queried | denied
queried ──(response within TAT)──▶ submitted' (query cycle counter++)
approved ──(deviation trigger: class/LOS/procedure/amount)──▶ enhancement_requested ──▶ enhanced | enhancement_denied
approved ──(discharge fit declared)──▶ final_bill_sent ──▶ clearance_received | clearance_queried ──▶ … ──▶ closed
denied ──(counselling + signed consent)──▶ payer_switched (payer.switched) | appealed ──▶ approved | closed_denied
approved ──(validity lapses / no admission within 7–15 days)──▶ expired
```
- Clocks (proposed defaults; IRDAI Master Circular on Health Insurance 2024 sets insurer-side 1 h cashless authorisation and 3 h final discharge authorisation — these are the *insurer's* clocks; ours measure our own turnaround and their breaches separately): desk submits within **60 min** of intimation (planned) / **2 h** of ER admission; query answered within **2 h** in hours, 4 h nights (`pre-auth query responder` T2 drafts); enhancement requested when **projected bill ≥ 80% of sanctioned** (S10 OKR: 90% enhancements before limit); final bill sent within **60 min** of fit-declared + no-pending-charges gate; clearance TAT breach by insurer > 3 h → escalation to TPA relationship manager + attendant counselling on wait.
- Roles: draft/submit/query — `tpa_desk`; deviation acknowledge — `tpa_desk`, `admission_clerk`; payer switch — `insurance_counsellor` + patient signature; appeal — `claims_auditor`.
- Events: reuse `preauth.denied`, `preauth.deviation_flagged`, `payer.switched`, `approval.*`, `sla.breached`. NEW: `preauth.requested`, `preauth.submitted`, `preauth.queried`, `preauth.query_answered`, `preauth.approved`, `preauth.enhancement_requested`, `preauth.enhanced`, `preauth.expired`, `preauth.appealed`, `discharge_clearance.requested`, `discharge_clearance.received`, `discharge_clearance.queried`.

### 3.7 `claim` (P6 charge-to-cash, insurer leg)
```
assembling ──(dossier complete; QA pass)──▶ ready ──(submitted; ack ref)──▶ submitted ──▶ acknowledged
acknowledged ──▶ queried ──(answered ≤ TAT)──▶ acknowledged' (cycle++) | rejected ──▶ appealed ──▶ acknowledged'' | closed_rejected
acknowledged ──(settlement advice received)──▶ settled_full | settled_short ──(review)──▶ appealed | shortfall_to_patient | shortfall_written_off (approval)
any ──(insurer deadline passed, e.g. 30 days post-discharge for reimbursement)──▶ time_barred (incident)
```
- SLA: assembling → ready **48 h** post-discharge (cashless) / **7 days** (reimbursement dossier for the patient); query answered 3 business days; settlement expected **30 days** from acknowledgement (contract-driven); ageing buckets 0–30/31–60/61–90/90+ on **net-of-TDS** (L15); dunning ladder per §11.11 (15/30/45/credit-stop 60).
- Roles: assemble — `tpa_desk` + Claims Drafter (T2); QA — `claims_auditor`; submit — `tpa_desk`; write-off — approvals ladder (billing supervisor ≤ ₹10k, finance head ≤ ₹50k, owner above; **cumulative per payer per month evaluated — §11.19-C fix 12 anti-structuring**).
- Events: reuse `settlement.recorded`, `writeoff.recorded`, `credit.limit_breached`, `credit.stopped`, `statement.issued/.disputed`, `document.release_logged`. NEW: `claim.assembled`, `claim.qa_passed`, `claim.submitted`, `claim.acknowledged`, `claim.queried`, `claim.query_answered`, `claim.rejected`, `claim.appealed`, `claim.settled`, `claim.short_paid`, `claim.time_barred`, `shortfall.assigned_to_patient`, `nhcx.bundle_sent` (later).

### 3.8 `pmjay_case` (portal-driven; the TMS is the system of record for the scheme — we mirror)
`eligibility_checked (BIS) → registered_in_tms → preauth_pending → preauth_approved | rejected → treatment (package code) → discharge_uploaded (docs + photos + discharge summary) → claim_submitted → claim_approved | queried | rejected → paid`. SLA: TMS pre-auth upload within 24 h of admission (scheme rule: pre-auth within 24 h for emergency); discharge upload within 24 h; claim within scheme window. **Audits:** SHA desk/field audits become an `inspection.visit_logged` workflow; audit findings are tasks with a named owner. Photo/biometric evidence rules (patient photo at admission, discharge photo) captured as claim_documents with `occurred_at`. Events NEW: `pmjay.eligibility_checked`, `pmjay.registered`, `pmjay.preauth_uploaded`, `pmjay.discharge_uploaded`, `pmjay.audit_flagged`.

### 3.9 `grievance` (P5 + P7; L18)
```
raised ──(acknowledged ≤ 30 min in hours)──▶ acknowledged ──(assigned owner)──▶ investigating ──(resolution documented)──▶ resolved ──(complainant acknowledges / 48 h no dispute)──▶ closed
   │ (severity major/critical) ──▶ escalated (medical superintendent / owner) ──▶ investigating
   │ (DPDP data grievance) ──▶ dpdp_track (grievance officer; statutory response)
   │ (medico-legal / media) ──▶ legal_track (single spokesperson)
resolved ──(complainant disputes)──▶ reopened ──▶ investigating
```
- Ladder (proposed): L0 desk-level fix (supervisor, same visit) · L1 department head 24 h · L2 quality manager 72 h · L3 medical superintendent/owner 7 days; NABH patient-rights complaints tagged by category (billing, behaviour, delay, clinical, privacy, facilities, discrimination). Events: reuse `grievance.raised/.resolved`, `incident.reported`. NEW: `grievance.acknowledged`, `grievance.assigned`, `grievance.escalated`, `grievance.reopened`, `grievance.closed`.

### 3.10 `feedback_touchpoint` (P7)
`due (event-triggered) → sent (Plan 10) → responded | no_response (one nudge) → triaged (score bands; detractor → grievance draft T2) → routed (Google review invite for promoters — only after transactional consent; never for detractors, never incentivised)`. Events NEW: `feedback.requested`, `feedback.received {touchpoint, score, verbatim_ref}`, `nps.recorded`, `review.invited`, `review.declined`.

### 3.11 `certificate` (P2-like document lifecycle)
`requested (patient/clerk) → drafted (template + encounter facts) → signed (doctor, second factor for medical-legal classes) → issued (QR, serial from `document_series`) → verified (public surface scans) | revoked (reason; superseded certificate linked)`. Classes: fitness, sick-leave (with dates and "not to exceed" cap per doctor policy), medical certificate for employment/insurance, disability (committee path — out of scope here), age estimation (MLC — legal track), injury report (MLC — MRD custody, requisition-gated, L23), birth/death (MRD module). Events NEW: `certificate.requested`, `certificate.drafted`, `certificate.signed`, `certificate.issued`, `certificate.revoked`, `certificate.verified`; MLC issuance reuses `document.release_logged` with `class: mlc`.

---

## 4. Data model sketch

Columns at sketch level; every table carries `id (ULID)`, `site_id`, `created_at/by`, `updated_at/by`; state columns mirror `workflow_instances` and are never the source of truth.

**Appointments & call centre**
- `appointment_policies` (doctor_id | department_id, slot_minutes, overbook_pct, overbook_cap_pct, no_show_grace_min, confirm_required_bool, confirm_deadline_hours, reminder_ladder_json, cover_map_json, valid_from/to, change_class) — versioned config.
- `appointment_confirmations` (appointment_id, channel, requested_at, responded_at, response enum, token) — one row per attempt.
- `appointment_waitlist` (patient_id, doctor_id | department_id, earliest/latest date, priority reason enum, offered_appointment_id?, offer_expires_at, status).
- `doctor_delays` (doctor_id, session_date, declared_at, minutes, reason enum, declared_by, cleared_at).
- `calls` (direction, pbx_call_id, from_number_hash + last4, to_extension, agent_user_id?, started_at, answered_at?, ended_at, disposition enum, patient_id?, encounter_id?, recording_ref?, transcript_ref?, consent_recorded_bool, notes). Phone numbers stored hashed + masked for the log; full number only via patient master.
- `pbx_cdr_imports` (batch, rows, matched, unmatched) — daily reconciliation of PBX call detail records vs `calls` (the phone system's orphan report).
- `ivr_menus` config (versioned) — prompts per language (hi/en/+regional), keys → actions.

**Registration at scale**
- `preregistrations` (token, channel kiosk|whatsapp|web, patient_id?, demographics_json, phone_hash, abha_address?, language, consent_json, dup_candidates_json, created_at, consumed_at?, consumed_by_counter?). TTL 48 h; purged after (DPDP minimisation).
- `duplicate_candidates` (patient_id_a, patient_id_b, score, features_json, status suspected|dismissed|merged, reviewed_by, review_note) — the Duplicate Sentinel's output and the merge queue's input.
- `counter_assignments` (counter_resource_id, user_id, opened_at, closed_at, ticket_range) — counters are Plan 13 resources (NEW kind `counter`; NEW kind `kiosk`; NEW kind `display`).
- `registration_tickets` (service_date, ticket_no, issued_at, called_at?, counter_id?, served_at?, kind new|revisit|assisted|tpa|priority) — single-winner allocation like OPD tokens.
- `handoffs` (from_resource_id, to_resource_id, patient_id, encounter_id, note, expected_action enum, status, acked_by, acked_at, completed_at).
- `display_endpoints` (resource_id, kind counter|doctor_bank|pharmacy|lab, room_ids[], languages[], audio_bool, last_heartbeat_at) + `announcements` (display_id, token_no, room, language, tts_ref, queued_at, played_at) — the **only** patient identifier on this table is `token_no` (L2 structural, lint-tested: no `patient_id` column).

**TPA / claims**
- `payers` (kind tpa|insurer|pmjay|cghs|echs|esic|corporate|railways|state_scheme, name, gstin?, pan?, contact_json, credit_limit_paise, credit_status ok|warn|stopped, portal_kind manual|email|portal|nhcx, tds_section_default).
- `empanelments` (payer_id, valid_from/to, agreement_ref (document), tariff_map_id, room_rent_cap_rule_json, non_payables_list_version, discount_on_bill_pct?, package_rates_json_ref, mou_document_ref, renewal_task_lead_days) — expiry watched by Expiry Watchman.
- `payer_tariff_maps` (empanelment_id, service_id | package_code, payer_rate_paise, valid_from/to) — an *adjustment-rule source* into Plan 06's engine (locked mechanism: "TPA/corporate contract rates, same mechanism", §7).
- `non_payables` (list_version, item_code/service_id/category, rule enum non_payable|conditionally_payable|payable, source IRDAI-list|payer-specific, note) — configuration, versioned (L13).
- `policies` (patient_id, payer_id, policy_no, member_id, insured_name, relationship, sum_insured_paise, room_rent_cap_rule_json, co_pay_pct?, waiting_period_flags, valid_from/to, card_image_ref, verified_at, verified_by) — never the source for eligibility; the pre-auth response is.
- `preauths` (encounter_id, policy_id, payer_id, kind planned|emergency, intimated_at, submitted_at, sanctioned_paise, sanctioned_class, sanctioned_los_days, procedure_scope_json, icd_codes[], procedure_codes[], validity_until, status mirror, deviation_flags_json, portal_ref, query_cycles int) — extends the IPD-phase object.
- `preauth_queries` (preauth_id, received_at, question_text (untrusted content), answered_at, answer_ref, draft_provenance_json, answered_by).
- `claims` (encounter_id, preauth_id?, payer_id, kind cashless|reimbursement_assist, claimed_paise, insurer_share_paise, patient_share_paise, non_payable_paise, submitted_at, ack_ref, expected_settlement_by, status mirror, aging_bucket derived, dossier_checklist_version).
- `claim_documents` (claim_id, doc_type enum (final bill, itemised bill, discharge summary, investigation reports, implant stickers, pre-auth letter, ID proof, claim form Part A/B, MLC/FIR where applicable), source_ref, page_count, hash, included_bool, missing_reason?).
- `claim_queries` (claim_id, received_at, question, answered_at, answer_ref, provenance).
- `settlements` (payer_id, advice_ref, received_on, bank_utr, gross_allowed_paise, disallowed_paise, tds_194j_paise, gst_tds_paise, net_received_paise, unmatched_paise) + `settlement_lines` (settlement_id, claim_id, allowed_paise, disallowed_paise, disallow_reason_code, reason_text) — the D-2 decomposition, first-class.
- `shortfall_dispositions` (claim_id, amount_paise, disposition appeal|to_patient|write_off, approval_id?, reason_class, note) — write-off emits `writeoff.recorded`.
- `pmjay_cases` (encounter_id, beneficiary_id, card_ref, package_code, tms_case_id, preauth_uploaded_at, discharge_uploaded_at, claim_submitted_at, status mirror, audit_flags_json).
- `payer_credit_ledger` — read model: invoices with `intended_payer` ≠ self, allocations from settlements, ageing on net-of-TDS.

**Feedback & grievance**
- `nps_touchpoints` config (touchpoint enum registration|consult|pharmacy|lab|billing|ipd_discharge|er|call_centre, trigger_event, delay_minutes, template_id, sampling_pct).
- `feedback_responses` (touchpoint, encounter_id, patient_id (or alias for sealed), score 0–10, verbatim (untrusted), channel, received_at, triage_band, routed_to).
- `grievances` (source walk-in|call|whatsapp|feedback|staff|portal|letter, category enum (NABH patient-rights categories), severity, patient_id?, encounter_id?, raised_by, subject_staff_ids[] (sealed to resolver+quality), owner_user_id, acknowledged_at, resolved_at, closed_at, resolution_text, complainant_ack enum, tat_breach_bool).
- `grievance_register` — statutory/NABH register view *as a table*: serial, date, category, summary (non-identifying), outcome, days-to-close; append-only, printable in prescribed format (E-21).
- `review_routings` (feedback_id, target google|internal, invited_at, consent_ref).

**Certificates & MLC documents**
- `certificate_templates` (kind, version, body_template, required_fields[], signer_role, second_factor_bool, max_days_sick_leave?).
- `certificates` (kind, patient_id, encounter_id, template_version, serial (document_series `CERT`), facts_json, drafted_by, signed_by, signed_at, issued_at, qr_payload_signed, revoked_at?, revoke_reason?, supersedes_id?).
- `mlc_document_issues` (mlc_id, document_kind injury_report|age_estimation|wound_certificate|copy_of_record, requisition_ref (police letter no./court order), requested_by (name, designation, ID), released_by, released_at, copies, acknowledgment_signature_ref) — the L23 register.

**Registry resource kinds needed (Plan 13):** `counter`, `kiosk`, `display`, `desk` (vitals/pharmacy/lab reception as handoff targets), `phone_extension` (PBX directory mirror; not a resource state machine, a directory). Rooms already move in Plan 13.

**FHIR shapes:** `Appointment`, `Schedule`/`Slot` (Plan 07 already exports FHIR — extend), `Coverage` (policies), `Claim`/`ClaimResponse`/`CoverageEligibilityRequest` (NHCX profiles per ABDM NHCX v1 IG), `Communication` (queries), `DocumentReference` (certificates, claim_documents), `QuestionnaireResponse` (feedback).

**Retention:** calls metadata 3 y, recordings 90 days unless attached to a grievance/MLC (then follows the case); preregistrations 48 h; claims dossiers 8 y (books of account) and per insurer MoU; grievance register 3 y minimum (NABH), 5 y recommended; certificates as clinical records (OPD 5 y); MLC document issues indefinite (L23); feedback verbatims 2 y then anonymised aggregates.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → assertion → ruling ref**. Theme codes: ID identity · TM timing/concurrency · PF partial failure/downtime · MO money/TPA · CL consent/legal/MLC · ST staff · EQ equipment · DQ data quality · FR fraud/gaming · PV privacy/VIP · LA language/accessibility · SC scale · IN integration.

### Identity & wrong-patient
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| ID-1 | Two "Ram Kumar", same village, same phone (shared family phone), different DOB → Duplicate Sentinel scores on phone+name+DOB+gender+photo-age band; phone match alone never auto-attaches; clerk sees side-by-side with photos → test: family-phone fixture yields `duplicate.suspected` not auto-select. |
| ID-2 | Kiosk pre-registration by an attendant for the patient, attendant's own phone entered → pre-reg captures `relationship_to_patient`; counter confirms with the patient present; photo taken of the patient, not the attendant → test: pre-reg with `relationship ≠ self` forces photo step. |
| ID-3 | Existing patient arrives with a new phone number → search by name+DOB+photo; clerk updates phone with `patient.updated` reason `phone_changed`; the old number is kept as history for callback matching → assert prior appointment reminders route to the new number from next `reminder.due`. |
| ID-4 | Wrong patient checked in at a busy counter; discovered at vitals (photo mismatch) → vitals desk uses "not this patient" → entered-in-error grammar (E-8): `visit.abandoned {reason: wrong_patient}`, reversing event, correct visit opened, token re-issued with same seq; fee moves via credit note + fresh invoice, no cash movement if same amount → assert one reversing event, invoice immutability held. |
| ID-5 | Merge approved, then the ward discovers two real people were merged (one has a penicillin allergy) → `patient.unmerged` restores both timelines from event history; every derived surface (allergy list, appointments, claims) re-resolves by patient_id; open claim rows re-pointed with an audit note → assert unmerge round-trip leaves zero orphan rows across all module tables (lint test lists every FK). |
| ID-6 | Patient has ABHA but shows a screenshot QR from a relative's app → ABHA scan performs verification (ABDM M1 auth mode) and matches demographics; a mismatch shows "ABHA belongs to someone else" and continues Aadhaar-free → assert visit opens without ABHA and `abha.linked` is not emitted. |
| ID-7 | Unknown/unconscious patient wheeled through OPD entrance → E3 ER button; UNK-registration per §11.4 map 8; auto-MLC; no OPD token → assert no `visit.opened` of type opd; `er.arrived` emitted. |
| ID-8 | Twins (adult, identical) registered separately; one's insurance card used by the other → photo verification at cashless intake (L16) is the only defence; TPA desk compares policy card photo/DOB → assert cashless intake without a `verified_at` on the policy row is refused. |
| ID-9 | Patient insists on registering a nickname ("Guddu") → legal name required for certificates/claims; `preferred_name` stored separately; public audio uses token only anyway → assert certificate render uses legal name. |
| ID-10 | Same UHID used by the whole family to "save time" (one card, five people) → visit-type and clinical history become wrong; the Duplicate Sentinel's inverse — **one-UHID-many-people** — flags age/gender inconsistencies across encounters (e.g., paediatric weight one week, pregnancy next) → assert `duplicate.suspected {kind: shared_uhid}`. |

### Timing, concurrency, race
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| TM-1 | Two call-centre agents book the last 10:20 slot for two callers simultaneously → OPD's partial unique index arbitrates; loser gets `slot_taken`, screen offers waitlist or next slot → assert exactly one `appointment.booked`. |
| TM-2 | Waitlist offer sent to two patients for one freed slot (policy allows 2 offers) → first accept wins by the same arbiter; second gets "slot filled, you remain #1 on waitlist" → assert `waitlist.offer_expired` for the loser with reason `filled`. |
| TM-3 | Doctor declares 45-min delay after 6 patients already checked in; walk-ins start filling → class 3 advances only against class 4 (future) entries; on-time-checked-in class 2 keep order → queue-engine fixture: no checked-in appointment loses rank after `doctor.delay_declared`. |
| TM-4 | Patient checks in at kiosk at 09:58 for a 10:00 slot, kiosk clock skewed by 3 min → all timestamps server-side; kiosk never sends `occurred_at` for check-in → assert server time used. |
| TM-5 | Overbooked 12:40 slot; both patients arrive on time → both class 2; order by `appointmentAt` then seq; the second waits at most one consult; supervisor dashboard shows overbook realised → assert `overbooking.applied` row links both appointments. |
| TM-6 | Reminder T-24h sent at 21:30 → quiet hours (L10) defer to 08:00; if the slot is 08:30 next day the reminder is sent at 08:00 with confirm deadline waived → assert `reminder.due` rescheduled, no `appointment.unconfirmed_released` for waived rows. |
| TM-7 | Doctor leave scheduled at 23:00 for tomorrow's 60 appointments → cascade batches at 08:00 (quiet hours) except patients travelling > 100 km (address distance band) who get the message at 23:05 as *urgent* → assert two batches, urgency flag on the first. |
| TM-8 | Pre-auth query arrives 02:15 for an ER admission → night on-call TPA desk gets interrupting alert (E-15 urgency class) only if the query blocks treatment/OT; otherwise 08:00 digest → assert alert class by query type. |
| TM-9 | Two TPA desk users answer the same query → single-winner transition `queried → submitted'`; loser sees the sent answer → assert one `preauth.query_answered`. |
| TM-10 | Settlement advice arrives before the claim is marked submitted (desk forgot) → settlement line matches by claim number; state machine allows `assembling → settled_*` via a documented "late-marked" transition, `sla.breached` on submission recorded truthfully → assert breach recorded, money reconciled. |
| TM-11 | Patient arrives 3 hours late for an appointment; walk-in queue is 40 deep → L1: late keeps priority (class 2 due) — the locked rule stands even if unpopular; supervisor sees a "late-priority seated ahead of N walk-ins" counter for the equity report → assert queue order and the counter. |
| TM-12 | Follow-up revisit on day 7 at 23:50 vs day 8 at 00:10 → IST day index rule (Plan 07 D3) decides; no grace → assert boundary fixture both sides. |

### Partial failure & downtime
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| PF-1 | Core down at 09:30 with 300 people in the hall → duty manager declares downtime; counters issue serially-numbered paper tokens from sealed kits per department; displays show "manual calling in progress" static card; doctors call by paper token → backfill screen re-creates visits with true `occurred_at`; reconciliation proves every paper serial → assert backfill events carry `recorded_at > occurred_at` and the serial range closes. |
| PF-2 | Displays/TTS box loses WebSocket but core is up → display falls back to 15-s polling (Plan 07's refetch rule); audio queue continues from last seq; heartbeat miss > 60 s shows a banner at the supervisor desk → assert `agent.heartbeat_missed`-style event for display endpoints. |
| PF-3 | PBX down (power or SIP trunk) → call centre agents switch to mobile fallback numbers published on the website/IVR; `calls` logged manually with `degraded: true`; CDR reconciliation skips the window with a declared gap → assert gap declaration event and no false "unmatched" tasks. |
| PF-4 | WhatsApp Business API rate-limited during leave-cascade batch → fallback ladder to SMS; rate-limit shedding raises an alert (fix 30), never silent drops → assert `notification.failed` + escalation, retries bounded. |
| PF-5 | TPA portal down at discharge → discharge clearance requested via email with portal-down note; cascade clock pauses on the payer only with evidence (`discharge_clearance.requested {channel: email, portal_down: true}`) → assert pause is attributable. |
| PF-6 | Kiosk printer jams → kiosk shows the pre-reg QR on screen and sends it by WhatsApp; counter can also search by phone → assert three paths to consume one pre-reg. |
| PF-7 | Public queue-position surface (E-1 relay) stale by 10 min → page shows "as of HH:MM" and the relay's last push time; never fabricates progress → assert freshness stamp rendered. |
| PF-8 | Payment rails down (rails_down.declared) → pay-before-consult relaxes to pay-before-exit (L7); queue engine accepts `waiting` without settled fee under the declared mode; exit desk collects; recovery reconciles → assert the guard consults the mode flag. |
| PF-9 | Partial deploy: appointment_v2 module up, OPD down → handoffs and bookings fail-closed with a clear error; call centre can still log callbacks (no OPD dependency) → assert module manifest dependencies and error codes. |
| PF-10 | NHCX/ABDM gateway certificate expired → claims fall back to portal/email channel; Expiry Watchman warns 30 days prior → assert channel fallback config and the expiry task. |

### Money, TPA, packages, refunds
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| MO-1 | Patient books a room class above the policy's room-rent cap → counsellor screen computes proportionate deduction (all associated charges scaled by cap/actual per policy wording); patient signs the warning (§11.4 map 4) before upgrade → assert `bed.class_changed` refused without the consent artefact when payer ≠ self. |
| MO-2 | Non-payables (gloves, admission kit, registration fee, telephone) billed to the insurer → the engine splits lines by `non_payables` list into patient-share at invoice time; patient share collected at discharge, not discovered at settlement → assert claim's `insurer_share + patient_share + non_payable = invoice net`. |
| MO-3 | Pre-auth sanctioned ₹80k, projected bill hits ₹64k on day 2 → `preauth.deviation_flagged {kind: amount_80pct}` → enhancement task with pre-filled request (T2 draft) → assert enhancement requested before the sanctioned amount is reached (S10 OKR). |
| MO-4 | Enhancement denied on day 4; balance ₹1.2L → L11 counselling + signed consent → `payer.switched` from switch moment; deposit ladder starts; earlier lines stay insurer-attributed → assert invoice lines carry payer period and no retroactive re-attribution. |
| MO-5 | Insurer short-pays ₹18,400 citing "reasonable and customary" → `claim.short_paid`; disposition workflow: appeal (with dossier evidence) or to-patient (only if the MoU/consent permits — many TPAs forbid balance billing beyond disallowed categories) or write-off via ladder → assert write-off requires approval and emits `writeoff.recorded` with reason code. |
| MO-6 | Cashless patient also holds a membership card with 10% discount → best-single-benefit (§7): payer tariff map wins as the contract rate; membership benefit applies only to patient-share lines if the plan allows → assert contest record shows the winning rule per line. |
| MO-7 | Reimbursement patient wants itemised bill + claim form Part B filled → Claims Drafter assembles the dossier for the patient (assist mode), hospital seal + doctor signature tasks; no insurer submission by us → assert `claims.kind = reimbursement_assist` never enters `submitted` state. |
| MO-8 | Corporate employee's dependant not on the corporate list → payer branch refuses cashless; self-pay with "corporate reimbursement letter" printed; referral source captured → assert intended_payer=self and the letter document issued. |
| MO-9 | Settlement UTR ₹4,52,300 against 7 claims, one claim number missing in advice → 6 matched, ₹ residual as `unmatched_paise` orphan-credit state (E-25) with investigation task → assert no auto-allocation of the residual. |
| MO-10 | TDS 194J 10% deducted; ageing computed on gross shows false overdue → L15: ageing on net-of-TDS; TDS receivable to Tally map; 26AS quarterly task → assert dunning ladder does not fire on the TDS portion. |
| MO-11 | Payer crosses 60-day ageing → `credit.stopped`; new cashless admissions from that payer need management override, evented and digest-surfaced (§11.14) → assert admission desk refusal path + override event. |
| MO-12 | OPD consult under corporate credit (no cash) → pay-before-consult guard accepts a **credit-extended** invoice (Plan 08 D2 step 3) tagged to the corporate payer; monthly consolidated statement → assert guard passes with `credit_extended = true`. |
| MO-13 | Patient paid consult fee, doctor went on emergency leave, refuses transfer → E1/E2 refund via approval; one approval covers the bulk queue (L5) → assert one `approval.granted` referenced by N vouchers. |
| MO-14 | PMJAY package selected does not cover an implant used → scheme rules: no balance billing to beneficiary; the gap terminates on a named cost centre (charity/PMJAY-variance) as a logged decision → assert leakage principle: gap has a cost-centre event. |
| MO-15 | Doctor fee rule: cross-consult same day by second specialist → chargeable first consult; repeat by same specialist same day free (map 5, configurable); fee-split accrues per specialist on payment → assert accrual ledger rows by consultant. |
| MO-16 | Revisit window extended to 30 days by a doctor 14 times this month (cap 10) → `extension_cap_reached`, pattern report (fix 14) → assert refusal and management report row. |
| MO-17 | Refund for a no-show pre-paid online booking (future: patient self-booking with UPI) → auto-credit-note is still approval-gated; below a configured micro-refund threshold the approval is a **standing approval** (batch) reviewed daily → assert vouchers reference the standing approval id; SoD holds. |
| MO-18 | ESIC referral patient (referral letter with validity) → payer kind esic; treatment scope limited to the referral; beyond scope → counselling and self-pay consent → assert scope check on order entry against `policies.scope_json`. |
| MO-19 | CGHS beneficiary card expired mid-treatment → CGHS rules allow continuation for emergency; planned procedures need fresh permission letter; desk task with clock → assert `policies.valid_to` drives a deviation flag, not a block on care. |
| MO-20 | Claim submitted after the insurer's 30-day window because the discharge summary was unsigned → `claim.time_barred` + incident + attribution to the signer's queue delay (not the desk) → assert causation chain from `sla.breached` on discharge summary to the time-barred event. |

### Consent, legal, MLC, minors, unconscious
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| CL-1 | 15-year-old comes alone for a fever → guardian consent per DPDP §9 for data processing at registration is normally a guardian act; corporate-standard: register with `guardian_pending`, treat (Clinical Establishments duty of care), guardian contact task; sensitive-context flags (D-31) if abuse suspected → assert visit opens; guardian task created. |
| CL-2 | Assault victim walks into OPD → doctor marks MLC from the consult screen → `mlc.registered`, police intimation record, injury report as restricted document (L23); the OPD visit continues → assert MLC documents excluded from ordinary print/WhatsApp. |
| CL-3 | Police officer at MRD counter asks for an injury report verbally → release only against written requisition logged in `mlc_document_issues` with officer ID; copy watermarked; `document.release_logged` → assert refusal path without requisition ref. |
| CL-4 | Patient requests deletion of all records (DPDP DSR) after a TPA claim was filed → erasure bounded by retention law and the claim's 8-year books requirement; response documents why; marketing consent withdrawn immediately → assert `dsr.fulfilled` with partial-erasure reason codes. |
| CL-5 | Sick-leave certificate requested for 15 days after a 1-day OPD visit → template cap per policy (default max 3 days OPD without review; longer needs a review visit or IPD); doctor may override with reason, evented → assert cap enforcement and override reason. |
| CL-6 | Employer phones to "verify" a certificate → public verification surface confirms only serial/date/validity (no diagnosis); anything more needs patient consent → assert verification response contains no diagnosis field. |
| CL-7 | TPA desk auditor from insurer asks for the full file of 20 patients → external-access persona (L17): time-boxed, read-only, sealed-class excluded, `export.recorded` with purpose → assert persona cannot open a sealed record. |
| CL-8 | Recording of call-centre calls → consent notice on IVR ("this call may be recorded"); recordings encrypted, 90-day retention; grievance/MLC attach extends → assert retention job respects attached flags. |
| CL-9 | Grievance names a doctor by behaviour → subject staff sealed to resolver + quality; POSH-type allegations route to ICC channel, not the ordinary ladder → assert category `harassment` bypasses department-head rung. |
| CL-10 | Unconscious patient's insurance card found in wallet → cashless intimation can begin (emergency pre-auth within 24 h) but policy verification and consent for claim submission happen when a lawful representative is present → assert `preauth.requested {consent_pending: true}` and claim cannot leave `assembling` without consent ref. |
| CL-11 | Patient records their own consult on a phone; hospital's own display camera (queue analytics) → no cameras in consult rooms; hall cameras are CCTV (security), never linked to patient identity; DPIA entry → assert no `patient_id` on any camera/analytics table. |
| CL-12 | Telemedicine follow-up requested by phone → out of scope here (CRM teleconsult, §11.5) but the call disposition `teleconsult_request` creates a task for the doctor's PA; Telemedicine Practice Guidelines 2020 identity + consent rules apply there → assert disposition exists and routes. |

### Staff absence, overload, handover
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| ST-1 | Morning: 3 of 8 registration clerks absent → counters as resources: supervisor closes counters, ticket display re-routes; `overload.flagged` when tickets-per-open-counter exceeds threshold; Coverage Resolver (T3) proposes pulling the admission clerk (bundling matrix allows) → assert flag + proposal task. |
| ST-2 | Doctor's PA declares the delay, not the doctor → allowed role `doctor_pa` scoped to that doctor; the declaration names the declarer → assert scope check refuses a PA of another doctor. |
| ST-3 | TPA desk executive resigns with 40 open queries → queries are workflow instances with role-resolved owners, not personal inboxes; supervisor reassigns in bulk; notice-period heightened access review (E-29) → assert reassignment event per instance. |
| ST-4 | Night: single duty manager bundles FO supervisor + billing supervisor → SoD: cannot approve a refund they requested; the approvals engine blocks (`sod.violation_blocked`) and routes to the on-call finance head → assert block. |
| ST-5 | Shift handover at the call centre with 12 open callbacks → callbacks are tasks; handover flag lists open tasks; nothing lives in a personal notebook → assert task list = open callbacks. |
| ST-6 | Consultant swaps a colleague to cover his OPD for one day (verbal) → `doctor.changed` requires a system record; queue transfers with consent per E2; fee attribution to the covering doctor → assert accrual to the covering doctor on payment. |
| ST-7 | Registration clerk's documentation-time budget exceeded by a new mandatory field (e.g., occupation) → `doc_budget.exceeded` at definition change; owner sees it → assert budget computation includes registration steps. |
| ST-8 | Insurance counsellor and claims filer are the same person on a skeleton day → allowed for filing; the write-off approval for that episode routes elsewhere (SoD pair) → assert approval routing excludes the counsellor. |

### Equipment failure
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| EQ-1 | Token display TV in a doctor bank dies → announcements continue on audio + WhatsApp queue-called ping; navigator informed; registry marks display `out_of_service`; biomedical task → assert `resource_status_history` row + task. |
| EQ-2 | TTS audio mispronounces Hindi numbers ("one-zero-three") → pre-rendered numeral audio clips per language (0–999) concatenated deterministically, not live TTS; test harness plays 1,000 tokens → assert clip mapping exists for every token in range. |
| EQ-3 | Kiosk touchscreen fails; queue forms → kiosk heartbeat missed → counters open an extra "assisted" ticket kind; navigator dispatched → assert ticket kind `assisted` count in supervisor view. |
| EQ-4 | Barcode scanner at counter unplugged → keyboard-first fallback: UHID/phone typed; perf budget still < 300 ms → assert flow completes without scanner. |
| EQ-5 | Certificate printer prints without QR (toner) → the QR is part of the PDF; a reprint is `document.reprinted`-style event with copy number; verification surface shows copy count → assert reprint count increments. |
| EQ-6 | PBX paging leg (E-23) fails during Code Violet at counters → code activation also pushes app + WhatsApp to security; PBX heartbeat miss visible → assert code has two legs. |

### Data quality, late-arriving, backdated
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| DQ-1 | Settlement advice PDF lists claim numbers with typos → matching by claim no. then by (patient name + discharge date + amount) with confidence; below threshold → manual match task; never fuzzy auto-post → assert threshold config and task creation. |
| DQ-2 | Pre-auth approval letter received by WhatsApp photo from the patient before the TPA email → recorded as `preauth.approved {evidence: patient_photo, provisional: true}`; official letter supersedes → assert provisional flag and supersession link. |
| DQ-3 | Doctor's leave entered after appointments already sent reminders → cascade re-sends with "change of plan" template; reminder history retained → assert both notification rows exist. |
| DQ-4 | Downtime backfill: 40 paper registrations typed in the wrong order → `occurred_at` from the paper form; queue/visit-type classification recomputed on `occurred_at` → assert visit types match a same-order oracle. |
| DQ-5 | Policy number entered with O vs 0 → payer-specific format validators (regex per payer) warn; the pre-auth response is the source of truth → assert validator config per payer. |
| DQ-6 | Feedback score entered by a staff member on the patient's behalf (kiosk at exit) → channel `assisted` recorded; assisted scores excluded from NPS headline, shown separately → assert NPS formula filters channel. |
| DQ-7 | Grievance closed without complainant acknowledgement (unreachable) → closure requires either ack or two documented contact attempts + 48 h → assert state machine guard. |
| DQ-8 | Empanelment agreement renewed but tariff map not updated → invoices continue on old map; Expiry Watchman flags `tariff_map` older than agreement; owner digest line → assert flag at renewal. |
| DQ-9 | Call log's patient link wrong (agent picked the wrong Ram) → entered-in-error on the call row; no clinical effect; callback task re-pointed → assert reversing row not edit. |

### Fraud, leakage, gaming
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| FR-1 | Clerk registers "ghost patients" to hit a camp/referral target → Fraud Sentinel: registrations without clinical events within 30 days, clustered by creator → report to designated reviewer with disposition SLA (E-18) → assert report row and disposition workflow. |
| FR-2 | Clerk attaches walk-ins to an existing UHID to make them "revisits" (free) → fix 18: demographic-mismatch sampling + photo prompt on attach; revisit rate per clerk vs department baseline → assert `attribution.unverified_flagged`-style diagnostic for revisit spikes. |
| FR-3 | Doctor extends follow-up windows to divert fees → cap + pattern report (MO-16). |
| FR-4 | TPA desk colludes with a patient to upgrade room after pre-auth and hide the deduction → proportionate-deduction is computed by the engine and shown on the attendant's running bill; consent artefact mandatory → assert running bill line "insurer deduction (room cap)". |
| FR-5 | Non-payables quietly moved into "package" to bill the insurer → package composition is configuration under change control (Class A for money rules); Leakage Auditor compares package contents vs non-payables list → assert audit row. |
| FR-6 | Fake pre-auth approval letter (edited PDF) → approvals record portal ref/email message-id; a letter without a verifiable reference is `provisional` and cannot unlock cashless discharge → assert clearance requires non-provisional approval. |
| FR-7 | Patient brings a stolen insurance card (photo mismatch) → L16: mismatch → payer-switch machinery + incident + insurer notification → assert three events. |
| FR-8 | Call-centre agent "books" VIP appointments for relatives and holds slots → slot holds have TTL; holds per agent per day capped and reported; Appointment Optimiser reports hold-without-checkin patterns → assert cap and report. |
| FR-9 | Staff member reviews their own grievance about themselves → SoD pair; approvals engine blocks → assert `sod.violation_blocked`. |
| FR-10 | Google review routing used to suppress detractors ("review gating") → routing rule: promoters invited, detractors routed to grievance; **the invite is offered to everyone who consents, never conditioned on score** (Google policy + fairness); the fixture asserts invites are score-blind and only the *follow-up path* differs. **Owner ruling O-9.** |
| FR-11 | Duplicate refund for the same no-show booking through two channels → refund guard against received amount per invoice (Plan 08 guard 1) + Fraud Sentinel duplicate-instrument check → assert second voucher refused. |
| FR-12 | Doctor marks patients "seen" to close queue fast (consultations of 20 s) → consultation duration distribution per doctor is a diagnostic, never punitive; care-audit notes-vs-orders (fix 20) → assert KPI shows load context. |
| FR-13 | Certificates issued without an encounter ("for a friend") → certificate requires an encounter with the signer as treating doctor or a designated MO exam encounter; serial gaps audited → assert refusal without encounter_id. |
| FR-14 | Cashier at TPA co-pay counter pockets cash by recording "insurer will pay" → co-pay computed by engine from policy + non-payables; deviation from computed patient share needs approval; day-book shows co-pay collected vs computed → assert variance line. |

### Privacy, sealed records, VIP, staff-as-patient
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| PV-1 | Chief Minister's relative registers → confidential flag; alias on displays/audio/WhatsApp; no clinical priority (L22); security escort task; access-vs-care-relationship report (E-29) active → assert public payloads contain alias only; queue rank unchanged. |
| PV-2 | Nurse from ICU registers for a gynae OPD → staff-as-patient confidential by default; colleagues' access flagged; HR never sees clinical fact; sick-leave certificate goes to HR *without diagnosis* by default → assert certificate variant without diagnosis for staff. |
| PV-3 | Sealed-class (HIV/MTP) patient's claim → claims dossier carries only what the insurer legally requires; sealed facts release only with explicit consent (HIV Act 2017 §8–9 confidentiality); TPA auditor persona excluded → assert dossier assembly refuses sealed documents without consent ref. |
| PV-4 | WhatsApp queue-called ping to a shared family phone reveals a psychiatric OPD → message text is department-neutral for sealed classes ("your token 42 is called at Room 7") — D-25 sealed-class propagation → assert template variant selection. |
| PV-5 | Call-centre agent looks up a celebrity's file with no call → access without a call/callback link on a confidential record → E-29 flag + review → assert report row. |
| PV-6 | Feedback verbatim contains another patient's name → scrubber (copilot §2.2 in-text) before any inference; raw verbatim access restricted to quality → assert scrubbed payload fixture. |
| PV-7 | Grievance register printed for NABH → non-identifying summary columns only → assert print template has no patient name. |
| PV-8 | Bulk export of "today's OPD list" by a marketing intern → E-28 export governance: approval + purpose + watermark + `export.recorded` → assert refusal without approval. |

### Language, literacy, accessibility
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| LA-1 | Bhojpuri-only elderly patient, no phone, cannot read the token → navigator (L20) escorts; audio token call in Hindi (numbers are shared); printed slip has large numerals + room pictogram; `navigation.assisted` → assert slip template and event. |
| LA-2 | IVR caller presses nothing (rotary/confused) → timeout → live agent in hours, callback capture after hours → assert IVR default branch. |
| LA-3 | Deaf patient → visual display + WhatsApp ping + navigator; audio-only calling would strand them: queue entry carries `needs_visual_call` flag from registration → assert display highlights flagged tokens. |
| LA-4 | Wheelchair user; counters at standing height → at least one low counter and one kiosk at wheelchair height (Rights of Persons with Disabilities Act 2016 accessibility) → §12 hardware line. |
| LA-5 | Consent forms for claims/payer-switch in English only → layered vernacular notice (D-42) and Hindi templates day one; regional language pack config → assert template exists in patient's language or falls back with a logged `language_fallback`. |
| LA-6 | Patient cannot sign (illiterate) → thumb impression + witness name, captured as an image on the consent artefact → assert consent artefact accepts `mark_with_witness`. |
| LA-7 | Audio calling in a mixed hall drowns tokens → per-display zone volume + a "called" chime distinct per doctor bank; repeat once after 60 s; then skip logic (Plan 07 `max_skips_before_left`) → assert announcement replay count = 2. |

### Scale (100/day → 2,000/day)
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| SC-1 | 08:00–10:00 peak: 900 arrivals in 2 h across 12 counters → target 60 s revisit / 3 min new ⇒ ~10 counters saturated; kiosks + pre-registration must absorb ≥ 40% (S10 A3 60–70%) → load test: 2,000 visits in a simulated day, p95 counter transaction < 4 s server side. |
| SC-2 | WebSocket fan-out to 60 displays + 200 staff screens + realtime tail → Plan 07's tail is per-process; multi-process (fix 32) and a display-only topic that pushes token deltas, not full queues → assert push payload size bound. |
| SC-3 | Audio announcement contention: 25 doctor banks calling simultaneously → each display endpoint has its own announcement queue; global serialisation only per zone → assert no cross-zone blocking. |
| SC-4 | Doctor tokens per session reach 250 → token numbers stay per-doctor-per-day (Plan 07); display shows "now serving / your token / est. wait" from the predictor → assert predictor degrades to "n ahead" when no model. |
| SC-5 | 2,000 WhatsApp transactional messages/hour at peak (queue pings) → Plan 10 queue throughput; Meta tier limits monitored; pings for positions > 10 batched ("you are #12, ~35 min") → assert per-patient ping rate cap. |
| SC-6 | 8 TPA desk staff, 120 active cashless IPD cases, 40 pre-auth queries/day → worklist by clock urgency (Lane 2 schema-generated), not by inbox; SLA breach rate visible per cell → assert worklist ordering = time-to-breach asc. |
| SC-7 | Call volume 1,500/day → PBX ACD queue stats imported; abandonment rate KPI; IVR self-serve deflection target 35% → assert CDR import daily and KPI derivation. |
| SC-8 | Search under load: 2,000 lookups/hour → Plan 05 perf gate is per query; add a p95 under concurrent load test (50 concurrent) < 300 ms → CI gate extension proposed. |
| SC-9 | Multiple OPD floors (§11.19-A building) → counters, displays, desks scoped by floor in the registry; floor-scoped degradation (fix 35) → assert floor attribute on every front-office resource. |

### Integration failures (device / vendor / ABDM)
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| IN-1 | ABDM gateway returns 5xx during ABHA verification → registration continues Aadhaar-free (L21); link retried later as a task; never blocks → assert visit opens; retry task exists. |
| IN-2 | NHCX claim bundle rejected for FHIR validation → bundle validated locally against the IG before send; rejection stored with error list; fallback to portal channel → assert local validator runs and fallback path. |
| IN-3 | PBX CDR export format changes after vendor firmware update → import fails closed with a parse error task; calls continue logging manually → assert schema-version check. |
| IN-4 | Insurer email query lands in a personal mailbox → shared TPA mailbox is the only configured ingestion; personal mailboxes are policy-prohibited; the desk forwards and the ingestion stamps `received_at` from the original header → assert header time used. |
| IN-5 | WhatsApp bot misparses "cancel my appointment tomorrow" (two appointments) → bot never acts on ambiguity: replies with a numbered choice; unresolved → callback → assert no `appointment.cancelled` on ambiguous input fixture. |
| IN-6 | Google Business Profile review link changes → config value with validation ping; never hard-coded → assert config validation task. |
| IN-7 | PMJAY TMS portal has no API (screen-based) → we mirror status manually with mandatory `tms_case_id` and screenshots as evidence documents; reconciliation task weekly against TMS export → assert evidence document required for state moves. |
| IN-8 | Kiosk ABHA QR scan offline → kiosk parses the QR's demographic payload for pre-fill only; verification deferred → assert `abha_verification_status = unverified` on pre-fill. |
| IN-9 | E-1 public relay breached/leaked token → tokens are signed, short-lived, PHI-free (position + room only); rotation on revocation (E-22) → assert token payload schema. |

**Row count: 118.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

### 6.1 Monday 08:40 — server down, 350 people in the hall, 14 doctors mid-session
- 08:40 core unreachable; screens freeze; displays show last state. 08:42 duty manager declares downtime (paper form, PBX broadcast; the standby's watchdog — not the dead box — sends the "primary down" alert to owner). Sealed kits opened at 6 counters: paper tokens per department from reserved serial ranges; a whiteboard per doctor bank; navigator and supervisor walk the banks. Doctors continue with paper tokens; vitals on slips; prescriptions on paper pads with pre-printed serials. Cash taken on paper receipts (reserved RCP range); TPA desk uses phone/email with the insurer, logs on paper. Agents: all paused (downtime gate, fix 27); no digests fire. 09:35 standby promoted per runbook; 09:40 backfill screens open: paper tokens re-entered with `occurred_at` from slips; queue engine recomputes classes on `occurred_at`; visits re-opened; paper receipts entered under a downtime cashier session reconciled by a *second* person (fix 15). Reconciliation report: every paper serial (tokens, receipts, Rx pads) accounted; a missing receipt serial becomes an incident. Audit trail: `downtime.declared/.ended`, every backfilled event with `recorded_at − occurred_at` visible, the second-person reconciliation approval, `sla.breached` rows for waits recorded honestly but alerting suppressed under the mode.

### 6.2 Dengue-season surge — 2,600 walk-ins on a 2,000 design day, three doctors on leave
- 07:30 arrivals at 2× baseline; ticket-per-open-counter breaches → `overload.flagged`; supervisor opens two reserve counters and the kiosk bank goes to "assisted" mode with two navigators; `surge.activated` for Medicine OPD relaxes wait SLAs per surge definition (alerts to record-only except danger vitals). Appointment Optimiser (T2) drafts a rebalancing: move afternoon slots of two covering doctors earlier, cap walk-in acceptance per doctor at 3.5 min/patient × remaining session, suggest opening a fever-clinic room from the registry; supervisor accepts the draft in one action (each accepted item becomes evented config). Recall automation pauses non-urgent reminders (mode-aware). Doctor leave cascade for the three absentees ran at 08:00: 140 patients got one-tap rebooking; 31 unresolved became callback tasks; the call centre clears them by 10:30. Wait-Time Predictor shows 95-min estimates on displays and the public link — patients leave and come back instead of crowding. Audit: surge window bounded by two events; every relaxed SLA breach still recorded; equity report shows walk-ins vs appointments seated per rule.

### 6.3 Cashless discharge Friday 17:00 — TPA portal down, patient's train at 21:00, pre-auth 92% consumed
- 14:00 fit-declared; enhancement was requested at 80% on Thursday (automation) but unanswered. 17:00 portal down: desk emails final bill + discharge summary to the insurer's alternate address, records `discharge_clearance.requested {portal_down}`; cascade clock pauses on payer. 17:30 Pre-auth Query Responder drafts the reply to a query that arrived by email ("justify LOS day 4"), citing the sheet lines (vitals trend, culture result); TPA executive edits and sends. 18:45 insurer approves enhanced amount by email; letter recorded as non-provisional (message-id). 19:00 co-pay + non-payables computed by the engine (₹6,140) collected; deposit refund voucher via approval; patient leaves 19:20. If the insurer had not answered by 19:30: counsellor offers the L11 self-pay conversion for the balance with signed consent, or a documented "discharge on undertaking" (owner ruling O-4) — either is evented. Audit: clock pauses attributed to payer, query answer provenance-stamped, co-pay computation trail on the running bill.

### 6.4 VIP + MLC + insurance-fraud attempt in the same hour
- 11:05 a politician's mother arrives (confidential flag set at registration; alias "P-4471" on displays; security escort task; no queue priority). 11:20 an assault victim arrives via OPD; doctor marks MLC; police intimation record; injury report locked to MRD custody. 11:35 at the TPA counter a man presents an insurance card whose photo does not match; the desk's photo-verification step (L16) flags it; incident raised; payer branch switches to self-pay; insurer notified through the configured channel; security informed without confrontation. Meanwhile a clerk tries to open the VIP's record "to check the address" — the access-vs-care-relationship report flags it within the hour; supervisor reviews. Agents: Fraud Sentinel logs the identity mismatch pattern; Digest Writer gets one line each. Audit: three independent trails — confidential-access events, `mlc.registered` + custody log, `incident.reported` + `payer.switched` — none of which required a human to remember to write anything.

### 6.5 Claims quarter-end — settlement advice for 214 claims arrives as one PDF with 31 short-payments and a wrong UTR
- Advice imported; 183 auto-matched by claim number; 31 short-paid lines carry reason codes; 5 unmatched (typos) → manual match tasks; the UTR in the advice does not exist in the bank statement (three-way check, D-1) → orphan-credit investigation task. Claims Drafter drafts 31 appeal packs where the reason code is contestable (per a deterministic rule table: "R&C rate" → appeal with tariff map evidence; "non-payable" → to-patient only if the consent artefact permits; else write-off request). Claims Auditor decides each; write-offs > ₹10k batch to the finance head; cumulative per-payer monthly write-off crosses the owner threshold → owner approval. Ageing recomputed net of TDS; the payer's 60-day bucket empties; `credit.stopped` lifts automatically with an event. Audit: settlement decomposition rows, disposition per line, approval chain, TDS receivable posting to Tally map.

### 6.6 Call-centre and PBX failure during a critical-result recall campaign
- 15:00 lab flags 6 critical results for patients who have left (§11.5 mandatory contact protocol); recall tasks route to the call centre. 15:10 SIP trunk drops; PBX heartbeat missed; the alert shows on the supervisor screen and the duty manager's phone. Agents switch to the mobile fallback pool (numbers on file, published to staff); each call logged manually with `degraded: true`; WhatsApp critical-result template (urgent — ignores quiet hours) goes out in parallel; two patients unreachable after 3 attempts → escalation to the ordering doctor and the ER charge nurse per ladder. 17:30 trunk restored; CDR reconciliation declares the 15:10–17:30 gap. Audit: each critical-result task shows attempts, channels, and the documented contact that closed it; the two unreachable cases show the escalation rung reached and the next-morning callback.

### 6.7 (bonus) Kiosk fleet compromised by a USB-borne malware on a Monday
- Kiosk heartbeats show unexpected processes; security incident declared (CERT-In 6-hour clock); kiosks powered off; pre-registration continues on WhatsApp; counters absorb; access review checks whether kiosk credentials touched anything beyond the pre-reg API (they cannot — per-device tokens scoped to `preregistration.submit`). Audit: `security_incident.declared`, device tokens revoked and rotated, the DPDP breach assessment documented.

---

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | System form | Who signs / owns | Retention |
|---|---|---|---|---|
| Complaint / grievance register | NABH 6th ed. PRE (patient rights & education) chapter; Clinical Establishments (Registration and Regulation) Act 2010 + state rules (display of rights, grievance mechanism) | `grievance_register` table, prescribed-format print (E-21) | Quality manager; grievance officer named | ≥ 3 y (5 y recommended) |
| DPDP grievance/DSR register | DPDP Act 2023 §§11–14 (rights), §13 grievance redressal, §9 minors, §8 breach duties; Rules 2025 timelines | `dsr` register (exists per §11.14) + grievance `dpdp_track` | DPO (quality manager dual-hat) | Per DPDP rules; legal-hold aware |
| MLC document issue register | CrPC/BNSS provisions on medico-legal evidence; court production (BSA 2023 §63 electronic records) | `mlc_document_issues` | MRD officer; custodian certificate for court copies | Indefinite (L23) |
| Certificates register | Clinical Establishments Act; IMC/NMC Professional Conduct Regulations (certificates must be truthful; register of certificates recommended); MCI Regulation 1.3.3 | `certificates` + `document_series CERT` | Signing doctor; second factor for medico-legal classes | As clinical record (OPD 5 y) |
| Insurance/TPA claims files | IRDAI (Health Insurance) Regulations 2016 + Master Circular 2024 (cashless TATs, non-payables Annexure); Companies Act books 8 y; Income-tax Act §194J/§40A(3)/§269ST | `claims`, `claim_documents`, `settlements` | TPA desk; billing supervisor | 8 y |
| PMJAY case records & audits | NHA AB-PMJAY guidelines (pre-auth TAT, discharge photo, anti-fraud framework, SHA audits) | `pmjay_cases`, `inspection.visit_logged` | TPA desk (PMJAY cell); MS for medical audits | Scheme-defined; ≥ 5 y |
| CGHS/ECHS/ESIC referrals | CGHS empanelment MoA, ECHS MoA, ESIC referral rules | `policies.scope_json`, empanelment agreements | TPA desk | MoA term + 8 y |
| ABDM/ABHA linkage | ABDM HIP/HIU consent manager rules; HFR/HPR | ABHA fields (exists), care-context link log | Registration; DPO | Consent artefacts per ABDM |
| Call recording consent | DPDP notice; TRAI/DoT telecom norms on recording notice | IVR notice; `calls.consent_recorded` | Call-centre lead | 90 d / case-linked |
| Accessibility | RPwD Act 2016 §§40–46 (accessible premises, information) | Low counter, kiosk height, visual calling | Ops manager | — |
| Display of rights & tariff | Clinical Establishments Act (display of rates, rights); NABH | Public display module shows tariff QR, rights card in hi/en | FO supervisor | — |
| Promotional messaging | DPDP consent; TRAI TCCCPR 2018 (DLT registration, templates) | Plan 10 registry | Marketing (later) | — |

**DPDP data classes touched:** identity (name, phone, photo, ABHA), financial (policy numbers, co-pay, bank refund details), health (diagnosis on claims/certificates), sealed classes (HIV/MTP/PCPNDT/psychiatric — carved to treating team only), staff data (grievance subjects), minors (guardian consent), biometric-adjacent (photo verification — a photo is not biometric processing unless matched algorithmically; Duplicate Sentinel uses age-band/face presence only, **never face matching** without a DPIA — owner ruling O-10).

**What NABH asks to see:** complaint register with TATs and closures; patient-rights display; feedback analysis with actions; waiting-time indicator (OPD wait is an NABH quality indicator); MLC register; consent forms (payer switch, room upgrade); certificate authenticity control. **What an insurer/TPA auditor demands:** itemised bill vs case sheet consistency, implant stickers, pre-auth deviations explained, non-payables not charged, discharge summary signed. **What a DPDP inspector demands:** notices, consent artefacts, DSR register with response times, breach log, DPO designation, processor contracts (PBX cloud recording vendor, WhatsApp BSP).

---

## 8. Staff KPI & KRA

All KPIs: event-derived, load-normalised, diagnostic (S10 §2). Formula ids proposed for the KPI formula registry (deferred note 5).

**Registration Clerk** (S10 #1, extended)
| KPI id | Formula | Load context | SLA link | Diagnostic reading |
|---|---|---|---|---|
| fo.reg.median_time | median(`visit.opened.at − registration_tickets.called_at`) per clerk per shift | tickets served, new:revisit mix | §11.1 < 60 s / 3 min | High with high new-share = staffing, not clerk |
| fo.reg.dup_rate | merged pairs where creator = clerk ÷ registrations | volume | S10 < 0.5% | Spikes after roster of new joiners = training |
| fo.reg.dup_dismiss_precision | dismissed candidates later merged ÷ dismissed | candidates shown | — | Low precision = threshold too low, not clerk fault |
| fo.reg.completeness | required demographic fields filled ÷ required | assisted share | — | — |
| fo.reg.prereg_consumption | visits opened from pre-reg ÷ visits | kiosk uptime | — | Adoption metric for A3 |
| fo.reg.navigation_assists | `navigation.assisted` per 100 visits | language mix | — | Higher = good service, not inefficiency |
Gaming: attaching walk-ins to existing UHIDs lowers dup_rate and median time → paired with FR-2 sampling. KRA: every arrival identified once, registered once, routed right.

**Front-Office Supervisor** (S10 #2)
| KPI id | Formula |
|---|---|
| fo.sup.wait_sla | 1 − `sla.breached(state=waiting)` ÷ visits, by floor |
| fo.sup.e2_resolution | median(`visit.transferred` or refund − `doctor.delay_declared`/absence) |
| fo.sup.overload_response | median(counter.opened − overload.flagged) |
| fo.sup.display_uptime | heartbeat coverage of display endpoints |
| fo.sup.grievance_first_response | median(grievance.acknowledged − grievance.raised) for FO categories |
| fo.sup.equity | walk-in vs appointment seated per rule violations (should be 0; any nonzero is a bug report) |
KRA: front-of-house keeps moving; every escalation answered; displays and kiosks healthy.

**Call-Centre Agent** (NEW)
| KPI id | Formula |
|---|---|
| cc.answer_rate | answered ÷ offered (PBX ACD import) |
| cc.abandon_callback_tat | median(callback.completed − call.abandoned) |
| cc.booking_conversion | `appointment.booked` with call causation ÷ booking-intent calls |
| cc.recall_contact_rate | recall tasks closed with documented contact ÷ recall tasks |
| cc.first_call_resolution | calls with no callback within 48 h same intent ÷ calls |
| cc.wrong_link_rate | call rows corrected (entered-in-error) ÷ calls |
Load: calls offered per agent-hour, IVR deflection. Gaming: closing recall tasks without contact → SoD (a contact needs a disposition + channel evidence). KRA: every call answered or called back; every recall attempted and documented.

**Patient Navigator** (NEW): assists per shift; time-to-assist after kiosk abandonment; wheelchair/stretcher call TAT; grievances in "delay/behaviour" category on assisted floors. KRA: no patient lost in the building.

**TPA / Insurance Desk Executive** (S10 #5, extended)
| KPI id | Formula |
|---|---|
| tpa.preauth_submit_tat | median(preauth.submitted − intimated_at) by kind |
| tpa.query_tat | median(preauth.query_answered − preauth.queried) |
| tpa.enhancement_before_limit | enhancements requested at < 100% consumed ÷ enhancements |
| tpa.clearance_hospital_leg | median(final_bill_sent − fit_declared) — the hospital's part only |
| tpa.clearance_payer_leg | median(clearance_received − final_bill_sent) — reported per payer, not per staff |
| tpa.first_pass_acceptance | claims settled without query ÷ claims submitted |
| tpa.dossier_completeness | claims passing QA first time ÷ claims |
| tpa.short_payment_recovery | appealed amounts recovered ÷ short-paid |
| tpa.time_barred | count (should be 0; each is an incident) |
Load: active cashless census, queries/day, payers' portal availability. Gaming: submitting incomplete pre-auths early to hit submit_tat → query_tat and first_pass move together; the pair is read jointly. KRA: no patient blindsided by payer outcomes; no claim dies of paperwork.

**Claims Auditor** (NEW): QA rejection rate (dossier), appeal win rate, write-off rate by reason, audit findings closed on time. **Insurance Counsellor** (NEW): counselling-before-switch compliance (100%), room-cap warning acknowledgement rate, post-discharge "surprise bill" grievances per 100 cashless discharges (the true outcome metric).

**MRD Officer** (S10 #7): certificate issue TAT (request → issued; target same day OPD), MLC release compliance (100% with requisition), DSR statutory TAT, certificate verification hits vs revocations.

**Quality Manager / Grievance Officer** (S10 #37): grievance TAT per rung, reopen rate, NPS by touchpoint (trend, not target-chased), detractor follow-up rate (100%), NABH indicator readiness.

**Doctors (front-office-relevant slice):** on-time session start (first `queue.called` − schedule start), delay declarations vs undeclared delays (silent lateness = worst), extension-cap usage, certificate turnaround. Diagnostic only; load = session size.

**Owner's 8 a.m. digest lines for this department:** OPD count by new/revisit/renewal; wait-SLA % by floor; median registration time; kiosk/pre-reg share; no-show % and recall closure; call answer rate + abandoned callbacks pending; pre-auth queries pending > 2 h; clearance breaches by payer; claims ageing 60+ (net of TDS) with top 3 payers; short-payments awaiting disposition; write-offs yesterday; grievances open past TAT; NPS 7-day trend; any confidential-record access flag; any `overbooking.applied` totals; any `credit.stopped`.

---

## 9. AI agents & the copilot — where inference earns its place

Rule applied throughout (law 6): a deterministic automation wherever a rule suffices; inference only for text drafting and non-rule ranking. All actors: first-class RBAC identity, API-only, fail-open, kill switch, provenance, action budgets (note 14), mode-aware (fix 27).

| Name | Kind / tier | Trigger & inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval / guardrail | DPIA class | Phase |
|---|---|---|---|---|---|---|---|---|---|---|
| **Wait-Time Predictor** | automation, T0 | every 60 s per doctor session: own events (calls made, consult durations trailing 30, queue depth by class, delay declared) | estimated minutes per waiting entry; display + public link | none (informational) | display shows "n ahead" | per-floor | formula version id | backtest MAE < 10 min on last 30 days; never shows < 0 or hides class order | none (aggregate) | Plan 20 |
| **No-Show Recall** (Recall & Follow-up extension) | automation, T1 | `appointment.no_show`, `visit.abandoned`; language, consent, quiet hours | WhatsApp recall with one-tap rebook → call task after N hours | none; call agent acts | supervisor list | agent | template version | ladder fixture; never messages sealed-class with department text | identity | 12b→20 |
| **Duplicate Sentinel** | automation, T1 | `patient.registered` intent (pre-insert) + nightly sweep; phone/name/DOB/gender/photo-presence | candidate list with score; nudge on counter; `duplicate.suspected` | clerk chooses; supervisor confirms new on high score | plain search | agent | rule version | precision/recall on labelled merges; no face matching (O-10) | identity | 20 |
| **Appointment Optimiser** | agent (deterministic core + LLM explanation), T2 | daily 06:00 and on `doctor_leave.scheduled`/`doctor.delay_declared`/`overload.flagged`: schedules, no-show rates, policy bands, registry rooms | *draft* changes: overbook % per session within band, rebalancing proposals, cover suggestions; each item a Class-B config change | FO supervisor accepts item-by-item (Class B within owner bands) | supervisor edits schedules manually | agent | model id + prompt version + input hash on each drafted item | shadow mode 30 days; never proposes outside bands; equity check (payer-blind); accepted-vs-rejected calibration record (note 17) | none (aggregate) | 20 (after 90 days baselines) |
| **Call Summariser** | agent, T2 | call ended with recording + consent; transcript (untrusted content) | structured disposition + note draft; intents | agent confirms disposition | agent types disposition | agent | stamps | leak scrubber on transcript; never creates state | identity + possibly health (voice) — DPIA L1 | 20b |
| **Pre-auth Query Responder** | agent, T2 | `preauth.queried` / `claim.queried`; query text (untrusted), permission-filtered fact sheet (copilot §2: encounter facts, vitals trend, orders, LOS rationale lines), tariff map, policy terms | draft reply citing fact-sheet line ids; "insufficient evidence" state routes a task to the treating doctor naming the missing fact | TPA executive edits & sends; clinical justification lines require treating-doctor countersign if they assert new clinical claims | executive writes reply | agent | stamps in `preauth_queries.draft_provenance_json` and in the sent letter footer | citation guard (uncited claims dropped); adversarial fixtures (instruction-shaped queries); never states a diagnosis absent from the sheet | health, tokenised | 21 |
| **Claims Drafter** (§16 roster) | agent, T2 | fit-declared + no-pending-charges gate; discharge summary signed; invoice; policy; non-payables; empanelment checklist | dossier checklist evaluation (deterministic) + drafted claim form narrative fields + cover letter; missing-document task list | Claims Auditor QA; TPA executive submits | manual checklist (Lane 2 worklist) | agent | stamps on `claim.assembled` | dossier completeness fixture; first-pass acceptance tracked as outcome (note 6); no financial figure originates from the model — all amounts are engine outputs copied by reference | health + financial, tokenised | 21 |
| **Short-Payment Disposition Rule Table** | automation, T1 | `claim.short_paid` reason codes | recommended disposition per rule table; appeal pack assembled by Drafter on request | Claims Auditor decides | manual | — | table version | — | financial | 21 |
| **Feedback Triage** | agent, T2 | `feedback.received` verbatim (scrubbed), score, touchpoint | category, severity, draft grievance (for detractors), draft thank-you (promoters, template only) | quality manager / FO supervisor accepts draft grievance | scores-only routing by band | agent | stamps | scrub fixtures; category accuracy vs human labels; never contacts the patient itself | identity + possibly health (verbatim) | 22 |
| **Grievance SLA Chaser** | automation (existing SLA Chaser), T1 | grievance states | nudges per rung | — | — | — | — | — | — | 22 |
| **Fraud Sentinel extensions** | automation, T0 | registration/claim/call patterns (FR-1, FR-2, FR-8, FR-14, identity mismatch) | reports with designated reviewer + disposition SLA (E-18) | reviewer | — | class | rule version | false-positive rate reviewed quarterly | identity/financial | 12b→20/21 |
| **Leakage Auditor extensions** | automation, T0 | non-payables billed to insurer; uncollected co-pay; packages vs non-payables | daily lines | billing supervisor | — | class | — | — | financial | 12a→21 |

**Presentation lanes (deferred note 3):**
- Lane 1 hand-built keyboard-first: registration counter, appointment book grid, TPA co-pay counter, certificate issue screen, queue supervisor board, display/kiosk UIs.
- Lane 2 schema-generated worklists: pre-auth cell worklist (by time-to-breach), claims QA worklist, settlement match tasks, callbacks, grievance queues, merge review queue, empanelment renewals.
- Lane 3 conversational copilot (staff, non-clinical roles first — the clinical-roles-last ruling stands): "reschedule Dr Mehta's Thursday to Dr Rao with consent messages" → tool calls under the supervisor's permissions with propose→confirm; "show me claims of Star Health over 45 days" → read tool; "draft reply to query on UHID …" → Pre-auth Query Responder invocation.
- **Journey Feed contributions:** appointment lifecycle, check-in, handoffs, pre-auth status ("insurer approved ₹80,000, class: twin sharing"), enhancement requests, clearance waits (attributed to payer), claim status post-discharge, grievance raised/closed, certificates issued — all as events with RBAC scope; the attendant's WhatsApp running-bill line "insurer approved / pending" is the same feed filtered.

**Prompt inputs, concretely (Pre-auth Query Responder):** system playbook v(n) from the Expertise store; the query text delimited as untrusted; the fact sheet lines `[L1..Ln]` (admission reason, ICD code, procedure code, LOS so far, sanctioned amount/class/LOS, itemised charges by category from the engine, vitals/lab trend lines the treating doctor marked relevant, prior queries + answers); the payer's known query taxonomy; output schema `{answer_paragraphs[] with citations, missing_evidence[], confidence}`.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

| Lever | Mechanism | Target |
|---|---|---|
| One-beep context | Signed QR on UHID card, pre-reg slip, appointment confirmation, certificate, claim cover sheet; USB scanner at every desk | scan → full context < 300 ms |
| Kiosk + WhatsApp pre-registration | Demographics + language + consent captured before arrival; counter only verifies + photo | 40% of new registrations pre-filled by month 6; 60–70% at A3 |
| Revisit fast lane | Phone/QR → visit opened in one keystroke (Plan 07 + Plan 08 fee quote) | < 60 s |
| Appointment grid keyboard flow | `/` search doctor, arrow to slot, Enter book, `r` reschedule, `w` waitlist | booking < 20 s |
| Doctor delay one-tap | PA/doctor app: "running 30 late" → cascade | declaration < 10 s; silent lateness → 0 |
| Queue displays | Token + room, bilingual, pre-rendered numeral audio, chime per bank, `needs_visual_call` highlight | announcement latency < 2 s from `queue.called` |
| Wait-time estimates | Predictor on displays + public link | MAE < 10 min |
| Handoff button | "Send to vitals/billing/lab reception" with note; ack SLA | ack < 5 min |
| Cross-consult same day | class-1 re-entry seating, fee rule automatic | no second registration |
| TPA worklists by clock | time-to-breach ordering; enhancement auto-draft at 80% | pre-auth median < 4 h; enhancements before limit > 90% |
| Co-pay computed, not negotiated | engine splits insurer/patient/non-payable at invoice time; shown on running bill daily | "surprise bill" grievances → 0 |
| Dossier checklist as data | per payer checklist version; missing docs = tasks | first-pass acceptance > 85% |
| Settlement import | advice parser + three-way match | 85% auto-matched |
| Certificates from templates | facts pre-filled from encounter; doctor signs with second factor; QR verify | same-day issue |
| Grievance from any screen | one hotkey on every workspace; category picker; auto-ack WhatsApp | ack < 30 min |
| Feedback micro-survey | 2 questions, 1 tap each, language-aware, 2 h after touchpoint | response rate > 25% |
| TAT clocks visible | every worklist row shows time-to-breach; breaches recorded always | — |
| Printing | every doc QR'd; reprint counted; watermarked identity | — |
| Voice | call recording with notice; dictation for grievance notes (T2 draft) | — |
| Perf budgets | search < 300 ms; interactive < 100 ms; display push < 2 s; 2,000-visit day load test in CI nightly | — |

---

## 11. Integrations, devices & dependencies

| Item | Protocol / interface | Notes (Indian market examples) |
|---|---|---|
| IP-PBX / EPABX with ACD + IVR + API | SIP; CDR export (CSV/REST); paging API; webhook on call events; recording storage | Buy (§9, E-23): e.g., Matrix ETERNITY/ COSEC, Grandstream UCM6xxx, Yeastar P-series, or cloud (Exotel/Knowlarity/Ozonetel) for the call centre with SIP to on-prem. Must support paging + REST for the code system's second leg + heartbeat. |
| WhatsApp Business API (BSP) | Plan 10 adapter; inbound (note 2) | Gupshup/Karix/Infobip class BSP; DLT for SMS |
| Queue displays | Android TV boxes / signage players running a kiosk browser to the display topic; audio via HDMI/line-out to zone amps | Registry kind `display`; per-device token |
| Audio | pre-rendered numeral clips per language; zone amplifiers; chime per bank | no live TTS dependency |
| Kiosks | Android/Windows kiosk with 2D scanner + thermal printer + camera; per-device mTLS token scoped to pre-reg API | e.g., Elo/ Newland/ locally built; height per RPwD |
| Counter peripherals | USB 2D barcode scanner (Zebra DS2208 / Honeywell), webcam for photo, thermal printer for slips, signature pad optional | keyboard-wedge mode |
| ABDM | ABHA verification (M1), care-context linking (M2), HIE-CM consent; HFR/HPR | via the single gateway module |
| NHCX | FHIR R4 claim bundles per NHCX IG (CoverageEligibilityRequest, Claim/pre-auth, ClaimResponse, Communication) | later; local validator first |
| TPA portals | screen-based (Medi Assist, MDIndia, Paramount, Vidal, Health India, insurer portals) — no stable APIs; email ingestion from a shared mailbox | evidence documents mandatory |
| PMJAY TMS/BIS | portal; exports for reconciliation | screen-based; mirror tables |
| Google Business Profile | review link config only | no API dependency |
| Edge-service rule | kiosks and display boxes are edge clients speaking only the gateway's authenticated APIs; PBX CDR import is a scheduled pull; nothing inbound to the core except through the gateway | §3, E-1 |

Dependencies on other plans: 13 registry (counters, kiosks, displays, desks) · 10 notifications + public surface (queue position, confirmations, one-tap rebooking links) · 12a/12b agent runtime · IPD cluster (pre-auth sanction object, bed class, discharge cascade states) · Payouts pack (fee-split accrual statements for cross-consults) · Quality/NABH pack (incident reporting, indicator dashboards, Expertise store) · MRD module (records release, birth/death certificates) · Plan 06 engine (payer tariff maps as adjustment source) · Plan 08 (co-pay collection, credit-extended invoices, settlement allocation). Events consumed: all P1 OPD events, `invoice.issued`, `payment.received`, `credit_note.issued`, `patient.admitted/.discharged`, `bed.class_changed`, `discharge` cascade events, `result.critical_flagged`, `report.signed`, `mlc.registered`, `roster.published`, `downtime.*`, `surge.*`, `rails_down.*`.

---

## 12. Buy vs build, hardware & rough INR budget

| Item | Buy/Build | Rough INR (2026) |
|---|---|---|
| IP-PBX 100–200 extensions + ACD/IVR licences + 12 agent headsets + recording storage | Buy | ₹4–8 L on-prem; or cloud call-centre ₹15–30k/month + on-prem PBX ₹2–3 L |
| SIP trunks / PRI, toll-free number, DLT registration | Buy | ₹10–25k/month |
| Queue displays: 40 × 43" commercial panels + Android players + mounts | Buy | ₹40–50k each → ₹16–20 L |
| Audio: zone amplifiers + speakers for 6 floors | Buy | ₹3–5 L |
| Kiosks: 10 self-registration kiosks (scanner, printer, camera, one wheelchair-height) | Buy | ₹1.2–1.8 L each → ₹12–18 L |
| Counter peripherals for 16 counters (scanner, webcam, thermal printer) | Buy | ₹15–20k each → ₹2.5–3.5 L |
| Signature pads (TPA/consent desks) ×6 | Buy | ₹60–90k |
| WhatsApp conversations (transactional) at 2,000 visits/day (~4 msgs/visit) | Opex | ₹1.5–3 L/month at current utility rates |
| Call-recording cloud storage (encrypted) | Opex | ₹5–10k/month |
| Public relay/DMZ box (E-1) | Buy/opex | ₹5–15k/yr (already in §13) |
| NHCX/ABDM certification effort | Build (plan) + external auditor | ₹2–4 L one-time |
| Feedback/grievance, appointments v2, TPA desk, certificates | **Build** (owns tables + workflows) | plan effort, not capex |
| CRM marketing suite | Defer/buy later (§17 step 9) | — |
| Tally connector for settlements/TDS | Build export (exists pattern) | — |
**Total capex order of magnitude: ₹45–65 L phased with floor commissioning; opex ₹2–4 L/month at full scale.**

---

## 13. Owner rulings needed

| # | Ruling | Recommended default & why |
|---|---|---|
| O-1 | Overbooking policy: allowed at all, and bands | Allow, 15% default / 25% cap, only when trailing no-show ≥ 12%; Class B within band; corporate norm; evented and digest-visible |
| O-2 | Appointment confirmation: release unconfirmed slots? | Yes for overbooked sessions only; never release an unconfirmed on-time patient's slot on non-overbooked days (L1 spirit) |
| O-3 | No-show fee / prepaid booking for self-booked appointments | No fee in year 1; prepaid optional with auto-refund on cancel ≥ 2 h; micro-refund standing approval (MO-17) |
| O-4 | Discharge when payer clearance is late: "discharge on undertaking" allowed? | Allowed above a deposit/undertaking threshold set by finance, counsellor-signed, evented; prevents holding patients hostage to insurer TATs |
| O-5 | Short-payment write-off ladder thresholds | ≤ ₹10k billing supervisor · ≤ ₹50k finance head · above owner; cumulative per payer per month evaluated |
| O-6 | Balance-billing disallowed amounts to patients | Only where the consent artefact and MoU permit; default = appeal first, then patient, then write-off |
| O-7 | Call recording | Record all with IVR notice; 90-day retention; case-linked extension |
| O-8 | Google review invitations | Enabled, score-blind invite, no incentives; **legal/brand exposure is the owner's** |
| O-9 | Review-gating prohibition (FR-10) | Adopt as policy; rule fixture enforces |
| O-10 | Face matching for duplicate detection | Prohibited until a DPIA rules otherwise; photo used for human comparison only |
| O-11 | Sick-leave certificate cap without review | 3 days OPD; override with reason |
| O-12 | Staff-as-patient certificates to HR without diagnosis | Default yes (diagnosis only on the staff member's explicit request) |
| O-13 | Empanelment strategy: which TPAs/insurers/schemes to onboard first | Recommend: top 5 by local market share + PMJAY + CGHS/ECHS/ESIC as commissioning dictates; procurement/legal item |
| O-14 | PBX on-prem vs cloud call centre | On-prem PBX (downtime channel, §11.4) + cloud ACD/IVR for the call centre bridged by SIP |
| O-15 | Navigator post timing | Dual-hat day one; dedicated at > 600 OPD/day |
| O-16 | NPS publication | Internal only until 6 months of baseline |
| O-17 | Credit-stop override authority for cashless admissions | Duty manager + billing supervisor two-key; owner informed real-time (§11.13) |

---

## 14. Plan sketch — how this becomes phase documents

Roadmap consistency: 14–19 are taken; propose **20, 20b, 21, 21b, 22**. Sequencing gates: 20 after 13 (registry kinds) and Plan 10's public surface; 21 after the IPD cluster's pre-auth object (L12) and PACS is *not* required (§17 order is advisory — owner may pull 21 forward for cashless OPD/day-care mini-OT claims: the mini-OT's ortho/gynae day-care cases are cashless-heavy, so a **21-lite (OPD/day-care cashless)** could ride with Plan 15 — flag for owner); 22 with the Quality/NABH pack or standalone after 10.

**Plan 20 — Front Office at Scale (appointments v2, call centre, displays, kiosks, handoff, certificates)**
1. Registry kinds `counter/kiosk/display/desk`; counter assignments; registration tickets (single-winner). 2. Appointment policies + confirmations + waitlist + delay declarations + overbooking (pure `allocateOverbook(state, policy)`); leave cascade executor. 3. Handoff module. 4. Display endpoints + announcement queue + numeral audio pack (hi/en) + `needs_visual_call`. 5. Kiosk + WhatsApp pre-registration (public surface) + Duplicate Sentinel (rules) + merge queue. 6. Call centre: PBX adapter (CDR import, click-to-call, webhook), calls table, callback tasks, IVR menu config; WhatsApp bot intents (Plan 10 inbound adapter). 7. Wait-Time Predictor (T0) + No-Show Recall extension. 8. Certificates (templates, serial, sign, QR verify, revoke) + MLC document issue register (with MRD interface). 9. Load test: 2,000-visit day. 10. Workflow definitions: `appointment_v2`, `call`, `registration_session`, `handoff`, `certificate`, `merge_request` — owner activation. Gate before authoring: Plan 13 deployed; PBX purchased and API verified; display/kiosk hardware pilot (2 units) measured.
**Plan 20b** — Appointment Optimiser (T2) after 90 days baselines; Call Summariser after DPIA L1.

**Plan 21 — TPA, Insurance & Claims Desk**
1. Payers, empanelments, tariff maps as adjustment source (Plan 06 engine), non-payables list, policies. 2. Pre-auth workflow (extends IPD object): queries, enhancements, expiry, deviation triggers, clocks. 3. Insurer/patient share split at invoice time; co-pay counter flow; room-cap proportionate deduction with consent artefact (with IPD). 4. Discharge clearance states (with cascade) + hospital-leg/payer-leg clocks. 5. Claims workflow + dossier checklist per payer + Claims Drafter (T2) + Claims Auditor QA + Pre-auth Query Responder (T2). 6. Settlement import + decomposition + three-way match + shortfall disposition + write-off ladder + ageing net-of-TDS + credit control (dunning ladder, credit-stop). 7. PMJAY/CGHS/ECHS/ESIC variants (scheme rules as config; TMS mirror; audit workflow). 8. External auditor persona. 9. Tally voucher map for settlements/TDS. Gate: IPD admission + bed class + discharge cascade live; empanelment agreements on file (O-13); CA config for TDS/GST.
**Plan 21b** — NHCX: FHIR bundles, local validator, gateway certification, ABDM M2 care-context on discharge.

**Plan 22 — Feedback, NPS & Grievance**
1. Touchpoint config + micro-survey (Plan 10 templates, L19 — could be pulled into 20 if trivial). 2. Grievance workflow + ladder + register + NABH categories + DPDP track + legal track. 3. Feedback Triage (T2) + review routing (O-8/O-9). 4. Dashboards via KPI formula registry. Gate: Quality manager designated; grievance officer named; templates approved by WhatsApp BSP.

**Negative-space question — "what absence is a signal here?"**
- An appointment session with **zero delay declarations** and a median first-call 40 min after schedule start = silent lateness.
- A doctor with **zero no-shows** = clerks converting no-shows to cancellations (or attaching walk-ins).
- A payer with **zero queries** = queries landing in a personal mailbox.
- A cashless discharge with **zero patient share** = non-payables billed to the insurer.
- A week with **zero grievances** at 2,000 OPD/day = the hotkey is hidden or staff are afraid to raise.
- A confidential record with **zero access events** during its visit = the alias flow is being bypassed on paper.
- A kiosk with **zero abandoned sessions** = the abandonment heartbeat is broken.
- A settlement month with **zero unmatched paise** = someone force-matched.

**Staff edge-case interview questions (department head / FO supervisor / TPA lead)**
1. When a doctor is 45 minutes late, what do you tell the first walk-in vs the first appointment, and who decides?
2. How many "same phone, different person" registrations do you see per day; what do you do today?
3. What happens when the patient paid, saw the doctor, and the doctor says "come tomorrow, no charge" — how is tomorrow's visit typed?
4. Which insurers send queries by WhatsApp to a staff member's personal number; how are those tracked?
5. Show me the last five short-payments and what happened to each.
6. When a patient's card photo doesn't match, what exactly happens at the counter (words used, who is called)?
7. What is the most common reason a claim is time-barred here?
8. How do you find out that a display TV is dead?
9. What does the night duty manager do when a TPA query arrives at 2 a.m.?
10. Which certificates do employers most often try to verify, and how?
11. When a complaint is about a doctor, who is allowed to read it?
12. How do you handle a patient who refuses to give a phone number at all?
13. Which forms are patients asked to sign that they cannot read; who explains them?
14. What is the most common reason a pre-auth enhancement is requested too late?
15. How do you currently know a family is using one UHID for several people?

---

## 15. Open questions & risks

1. **Pre-auth object ownership split** between the IPD phase (L12) and Plan 21: the table must be authored once; recommend the IPD plan creates `preauths` with the sanction fields and Plan 21 extends (queries, enhancements, clocks) — the two plans need a shared schema sketch before either is authored.
2. **IRDAI Master Circular 2024 TATs** (1 h cashless, 3 h final authorisation) are insurer obligations; whether hospitals can rely on them contractually varies by MoU — counsel review of empanelment agreements needed (joins the partner-agreement review already running).
3. **Balance billing of disallowed amounts** is contested under many MoUs; O-6 needs counsel input per payer class.
4. **WhatsApp bot inbound** depends on Plan 10's inbound adapter (deferred note 2) which is post-go-live; Plan 20's call centre must not assume it.
5. **PBX API quality** varies wildly by vendor; the procurement mandate (E-23) must be verified by a spike before Plan 20 is authored (paging leg, CDR webhook, click-to-call).
6. **Numeral audio for regional languages** beyond hi/en (Bhojpuri/Maithili/Punjabi etc.) — decide the language pack at commissioning per catchment.
7. **NHCX readiness** in the local insurer ecosystem is uneven; Plan 21b timing should follow measured insurer participation, not the ABDM calendar.
8. **PMJAY portal has no API**; the mirror-with-evidence approach carries reconciliation effort — staffing assumption in the PMJAY cell must include it.
9. **Duplicate Sentinel thresholds** need labelled data from the existing merges; commissioning-period merges should be labelled as they happen (a Plan 05 follow-up: add `review_note` reasons as enum).
10. **Face matching** (O-10) is the single biggest accuracy lever for duplicates at scale and the single biggest DPDP exposure; the DPIA should evaluate it explicitly rather than by silence.
11. **Overbooking + late-keeps-priority** (L1) can produce visibly long walk-in waits on overbooked days; the equity report will show it — the owner may need to revisit L1's "no grace expiry" for *overbooked* slots only (not proposed here; flagged).
12. **Grievance register legality** in electronic form under the state Clinical Establishments rules — E-21 counsel check applies.
13. **Scale of WhatsApp opex** at 2,000/day is a real line item; pings for positions > 10 should be batched (SC-5) or the in-hall display relied upon.
