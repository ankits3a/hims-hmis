# 10 — Doctors on Duty (JR/SR/RMO, Consultants on Rounds, On-Call, Handover, Escalation, Clinical Reporting) — Brainstorm & Planning

Date: 2026-08-27 · Status: **Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED**

**Executive summary.** This module is the hospital's answer to one question, asked ten thousand times a day: *"who is the doctor for this patient, right now, and did they act in time?"* It owns on-duty assignment and coverage for doctors (resident → SR → RMO → consultant → on-call), the bed-to-doctor resolution the whole fabric escalates through, doctor handover at shift end, rounds as a workflow, order verification/countersignature rules, the resident→SR→consultant escalation ladder with acknowledgement timers, duty reporting (census, critical events, deaths, MLC, incidents), the death-declaration and MCCD certification chain, MLC intimation tasks, inter-specialty consult requests with SLA, cross-cover for consultant leave, and the per-doctor KPI exhaust. It is **not** the HR/payroll system (bought; attendance and pay stay there), **not** the nursing eMAR/handover (Plan IPD-nursing owns that), **not** the OT list, ICU telemetry or MRD file room, and **not** a clinical decision engine — agents here cap at T2 (drafts) forever. Its three hardest problems: **(1) resolution truth** — the on-duty picture must be right at 03:00 when a consultant's phone is off and the SR has swapped shifts on WhatsApp without telling anyone; **(2) escalation without alarm fatigue** — a ladder that climbs on silence, yet does not page ten people for one potassium; **(3) documentation timeliness and attribution** — notes, countersigns, discharge summaries and death certificates signed by the right grade within the window, provably, without turning residents into typists (S10 §12.21 documentation-time budgets).

---

## 1. Frame — what exists, what is locked, what this document adds

**Spec anchors (locked, inherited, not re-litigated).**
- §4 module framework; §10.2 every SLA-bearing lifecycle is a workflow definition, versioned data, owner activates (§10.4); §10.3 SLA structure everywhere, alerts selective; §10.5 envelope with `occurred_at` ≠ `recorded_at`.
- §11.12 People & tasks (S6): HR/biometric system owns attendance & payroll; HMIS consumes the **live on-duty picture**; **escalation ladders resolve to the on-duty holder of a role, never a named person**; doctor on-call schedules per specialty drive ER admission routing, round-robin within the day's roster; credentials & privileging registry with hard block on expiry; handover as a workflow state with per-patient checklist gate.
- S10 §12.15 (v1.1): **roster system-of-record = HMIS** — rosters authored, validated, published in the HMIS; HR keeps payroll/attendance. S10 §12.5 statutory roster compliance; §12.4 surge mode + locum pool with `temp_role.granted/.expired`; §12.9 attribution-dispute workflow; §12.13 `overload.flagged`; §12.16 succession chains; §12.24 doctor adoption program (dictation-to-draft, scribe option, off-site countersigns, live accrual dashboard); §12.21 documentation-time budgets.
- §11.19-E fix 7: **roster substrate ships in Phase 1** (duty assignment, on-call chains, publication gates are foundation-scope); the *full* roster module (optimization, deep statutory validation) is Phase-2 fast-follow. Built reality today (`apps/core/src/kernel/workflow/roles.ts`): `usersHoldingRole()` is **static** — "until the roster substrate lands, escalation resolves to everyone currently holding the role". That is the seam this module fills.
- Plan 13: OPD doctor availability (`opd_doctors`, `opd_doctor_schedules`, `opd_doctor_leaves`) **stays in OPD until the roster module** — the seam is named, not moved. This document is that roster module's brainstorm.
- §11.2 IPD journey: rounds → orders stay loop; discharge cascade step 5 "summary drafted by AI (T2), doctor edits and signs"; E6 death on ward; ICU admission needs intensivist/duty-ICU-doctor approval.
- §11.4 map 5 cross-consultation & doctor change: specialist worklist → bedside → fee posts + payout share accrues; doctor change requires a written clinical handover note; attribution splits at handover; patient-initiated changes record consent.
- §11.5: doctor planned-leave cascade (book blocks, auto-notify, rebooking, call tasks); critical result after patient left → mandatory contact protocol.
- §11.13: 5-minute acknowledgement timer on critical clinical alerts before auto-climb; only the active-alert list interrupts; rest batches to shift digests.
- §11.19-B (pass 5): **verbal orders** — nurse records with read-back → doctor countersigns within window → uncountersigned escalates (`verbal_order.recorded/.countersigned`).
- §11.19-C fix 17 attribution verification gate; §11.19-D fix 27 **signature-class clinical acts need a second factor** (countersigns, verifies, report signing); fix 35 doctor adoption program; §11.19-E fix 4 sealed-class treating-team carve-out; fix 8 entered-in-error grammar; fix 13 **death-to-release cascade with 24×7 certification chain** (duty doctor certifies; on-call signer chain for certificates); fix 15 approval urgency classes with interrupting channel and act-first-review-after.
- §11.18 sweep: late-entry rule (dual-stamped, flagged; true backdating impossible); no shared accounts + PIN switching (identifies, does not sign).
- §16: clinical actions cap T2–T3; automations preferred over inference; provenance stamps; fail-open; Coverage Resolver (T3 automation, IPD phase), Discharge Summary Drafter (T2 agent, IPD phase), SLA Chaser (T1). Clinical copilot §2: Context Lens packs `ipd-ward`, `icu` are declared stubs landing with their modules; narrate-never-originate; tokenization boundary.
- Roadmap deferred notes 9 (pure-function allocators — coverage resolver must be `(snapshot, proposal) → plan`), 10 (watchers not dashboards), 14 (abstention/action budgets), 15 (reservations as governed state machines), 16 (clinical facts carry verification state).

**Scope boundaries / neighbouring owners.**

| Concern | Owner | This module's relation |
|---|---|---|
| Attendance punches, leave balances, payroll | HR SaaS (bought) | consumes punch feed for activity-attendance reconciliation (S10 §12.7) |
| Roster authoring/validation/publication (all staff) | **`roster` (kernel-adjacent, this doc §14 Plan 20)** | doctor rosters are one role family on it |
| On-duty assignment, coverage, bed→doctor resolution, escalation ladder resolution, doctor handover, rounds, consults, duty reports, death/MLC certification chain | **`duty-doctors` (this doc, Plan 21)** | owns tables in §4 |
| Nursing handover, eMAR, vitals, danger flags | IPD nursing module | emits `vitals.danger_flagged`, `handover.completed(nursing)`; we consume |
| Orders, prescriptions, formulary safety | formulary (built) + order modules | we own *who may sign what* (verification rules), not the order |
| Fee splits, accrual ledger, payouts | billing + partners (built) / Payouts pack | we emit attribution facts; money stays there |
| Credentials/privileging registry | HR-evidence bridge + MS worklist (S10 card 39) | hard gate consumed at assignment time |
| Death register, birth register, MRD file | MRD module | we own *certification chain*; MRD owns the register row and file |
| MLC register | ED module (`mlc.registered`) | we own the duty doctor's intimation tasks |
| Incident register | Quality/NABH pack | duty report links incidents; never duplicates |

**What this document adds:** the workflow definitions (§3), the tables (§4), 100+ edge rows (§5), seven chaos walkthroughs (§6), the KPI exhaust per grade (§8), five agents/automations (§9), and the plan split (§14).

---

## 2. Actors, roles & role cards

**Human roles (S10 card numbers where they exist; NEW cards proposed).**

| Role | S10 card | Grade code | Notes |
|---|---|---|---|
| Junior Resident (JR / PG trainee / house officer) | **NEW card 40** | `JR` | first-line ward doctor; writes progress notes, executes rounds orders; cannot sign discharge summaries, death certificates, narcotics, high-risk orders without countersign |
| Senior Resident (SR / DNB senior / registrar) | **NEW card 41** | `SR` | supervises JRs, first escalation rung, may sign routine orders, co-signs JR notes, declares death (certification by consultant chain per policy) |
| Duty Medical Officer / RMO | card 9 | `RMO` | non-PG floor doctor covering wards/nights; same signing class as SR unless privileging says otherwise |
| Consultant (primary / admitting) | cards 8, 11, 12, 13, 14 | `CONS` | owns the patient; final sign on summaries, MCCD, high-risk orders; rounds |
| Consultant on-call (specialty) | same cards | `CONS_ONCALL` | resolved from roster per specialty per day; ER admission routing; cross-cover |
| Visiting / locum consultant | cards 8/12 | `CONS_VISIT` | `temp_role.granted` with expiry; privileges from credential registry; fee-split class per §7 |
| Intensivist / duty ICU doctor | card 11 | `ICU_DOC` | ICU admission approver; top of ICU ladder |
| ER physician | card 10 | `ER_DOC` | consumes on-call resolution for admissions; MLC origin |
| Medical Superintendent | card 39 | `MS` | attribution disputes, privileging, MLC oversight, mortality committee, ladder terminus |
| Department head / unit head | (per specialty consultant) | `HOD` | ladder rung above consultant when the consultant is unreachable; approves cross-cover |
| Duty Manager | card in §9 ops | `DM` | non-clinical terminus for coverage gaps (S10 §12.16 succession chain) |
| Ward in-charge / staff nurse | cards 20, 23 | — | originates nurse-calls, verbal orders, read-back |
| MRD officer | (§9 MRD) | — | receives death/birth certificate chain output, Form 2 filing |
| Scribe / medical transcriptionist | **NEW card 42 (optional post)** | `SCRIBE` | S10 §12.24 scribe option; drafts under a doctor's session, never signs |

**Agent/automation actors (all first-class actors, RBAC, kill switch; details §9).** Round List Generator (T0 automation) · Deterioration Alert router (T1 automation over `vitals.danger_flagged`/`result.critical_flagged`) · Pending-Results Chaser (T1 automation) · Consult-Request Router (automation, T3 for assignment only — non-clinical act) · Coverage Resolver (T3 automation, already rostered in §16) · Handover-Sheet Drafter (T2 agent) · Discharge Summary Drafter (T2 agent, §16) · Duty-Report Compiler (T2 agent) · Note-Timeliness Watcher (T0 automation).

**Shifts (corporate-standard default, configurable).** Residents/RMO: three shifts 08–14 / 14–20 / 20–08 (night 12 h) or two 12-h shifts; consultants: rounds window 08:00–11:00 + evening round 17:00–19:00 + on-call 24 h by specialty rota; SR one per 30–40 beds per shift, JR one per 15–20 beds day / 30 beds night, RMO one per floor night (defaults for the roster validator; S10 §13 says statutory ratio changes override).

**Bundling (S10 §10 extension).** Night may bundle: ward JR ← RMO on the same floor; SR ← RMO for floors without PG programme. **Must stay distinct:** ICU duty doctor vs ward RMO (competency/privilege-gated); Code Blue team leader vs the only floor RMO (a code must not empty the floor — roster validator warns, DM accepts explicitly); death-declaring doctor vs MCCD-certifying consultant may be the same person, but **the MLC-declaring doctor vs the police-intimation task owner may not be a JR** (policy default).

**SoD hard pairs added to S10 §11 (proposed).** Verbal-order giver / verbal-order countersigner must be the *same* doctor or their grade-superior (a JR cannot countersign an SR's verbal order) · resident note author / co-signing consultant never the same user · procedure operator / supervising consultant in a logbook entry never the same user · attribution-dispute party / disposition approver (already S10 §12.9).

---

## 3. Core flows as workflow definitions

All are `workflow_definitions` (versioned data). Roles are role keys resolved through the on-duty picture (§3.1). Every transition emits; NEW event names are marked.

### 3.1 On-duty assignment & bed→doctor resolution (P5 task-and-track + P7 overlay)

Not a per-patient workflow — a **read model + assignment lifecycle**. `duty_assignments` (§4) are workflow instances:

```
published(roster) → checked_in → active → handing_over → handed_over → closed
                       │            ├─ absent_no_show (SLA: 15 min past shift start, no check-in + no punch)
                       │            ├─ left_early (mid-shift departure, §11.12 exception)
                       └─ swapped (swap approved by SR/HOD before start; evented)
```

- **Resolution function** `resolveDoctor(bed_or_patient, need, at)` returns an ordered list: `primary_consultant` (from admission attribution, `doctor.changed` history) → `covering_consultant` (cross-cover if primary on leave — `doctor_leave.scheduled`) → `unit SR on duty` → `ward JR on duty` → `floor RMO` → `specialty consultant on-call` → `HOD` → `MS`. Filter: credential/privilege valid, not `absent_no_show`, not past post-night rest cut-off, not on `overload.flagged` hard cap (warn only). Pure function over a state snapshot (deferred note 9) so "who covers if Dr X calls in sick" is a what-if call.
- Events: `roster.published` (consumed) · `duty.checked_in` NEW · `duty.no_show_flagged` NEW · `duty.swapped` NEW · `duty.left_early` NEW · `oncall.assigned` (existing) · `coverage.gap_flagged` NEW · `coverage.resolved` NEW · `doctor.changed` (existing) · `doctor_leave.scheduled` (existing) · `cover.assigned` NEW (consultant cross-cover).
- SLA: gap detected at T-2 h before shift → `coverage.gap_flagged` → Coverage Resolver proposes → DM approves (T3) → unresolved at T-0 → HOD + DM interrupting channel; no rung is empty by S10 §12.16.

### 3.2 Escalation ladder (P7 notify-remind-escalate; generic over nurse-call, danger vitals, critical results, task SLAs)

```
raised → notified(rung 1: ward JR) ─5 min─→ notified(rung 2: unit SR) ─5 min─→ notified(rung 3: consultant/cover)
      ─10 min─→ notified(rung 4: HOD / ICU_DOC for ICU) ─10 min─→ DM + MS (interrupting channel)
  any rung: acknowledged → attending → resolved(note) | delegated(to named on-duty doctor, evented)
```

- Acknowledgement = one-tap in app (or PBX DTMF acknowledgement via IVR call-back — §11 integration), stamps `escalation.acknowledged` NEW; **"attending" ≠ acknowledged**; resolution requires a note or an order (auto-closes on `order.placed` with `causation_id` = escalation, or a progress-note event).
- Severity classes (config): **S1 critical** (danger vitals, critical results, Code Blue) — 5-min rungs, interrupting channel (push + PBX ring), skips straight to SR if JR not checked-in; **S2 urgent** (nurse-call "please review", new admission review) — 15/15/30; **S3 routine** (pending countersign, note overdue) — batched to shift digest, ladder in hours. Only S1 and ER-routed S2 interrupt at go-live (§10.3 rule).
- Silence at the top: after MS rung, `escalation.unanswered_flagged` NEW → DM opens an incident automatically (never silent). Events: `escalation.triggered` (existing) · `escalation.acknowledged` NEW · `escalation.delegated` NEW · `escalation.resolved` NEW · `escalation.unanswered_flagged` NEW.

### 3.3 Doctor handover (P5; per-shift, per-unit; mirrors nursing handover §11.12)

```
due(T-30 min) → drafted(sheet: per patient — status, pending results, tasks, watch-list, code status)
   → outgoing_confirmed → incoming_acknowledged(per patient, all-or-escalate) → completed
   ├─ incomplete_at_shift_end (SLA 20 min post shift) → escalate SR → HOD
   └─ forced (outgoing left early / no-show) → incoming acknowledges from sheet + SR co-ack
```

- Per-patient acknowledgement is the gate; a patient not acknowledged by anyone at T+20 is a `handover.patient_unacknowledged` NEW → rung 2 immediately (the "orphan patient" is the scenario the fabric exists to kill).
- Sheet contents (structured, not prose): identity (bed, UHID, alias if sealed), diagnosis, day-of-stay, code status (DNR flag from `dnr.recorded`), pending results (from Chaser), open tasks, escalations open, "if-then" plans (free text, scrubbed), consultant instructions, discharge-plan status. I-PASS/SBAR ordering configurable. Handover-Sheet Drafter (T2) pre-fills; outgoing edits and confirms.
- Events: `handover.drafted` NEW · `handover.confirmed` NEW · `handover.acknowledged` NEW (per patient) · `handover.completed` (existing, kind=doctor) · `handover.patient_unacknowledged` NEW · `handover.forced` NEW.

### 3.4 Rounds (P1 stay-loop sub-workflow, per unit per round-type per day)

```
list_generated(T0, 06:30) → started(consultant/SR taps "start", location = ward)
  → per patient: seen(round note draft opened) → orders_written → note_signed | note_pending_cosign
  → completed(all patients seen or explicitly deferred with reason) → co-sign_window(consultant cosigns resident notes ≤ 4 h default)
  ├─ deferred_patient(reason: in OT / imaging / LAMA in progress) → re-queued to next round
  └─ not_started_by(SLA 11:00 for morning consultant round) → HOD digest (S3, non-interrupting)
```

- Round types: consultant morning round, evening round, SR/RMO night round, teaching round (flag `teaching=true`, attendance list of JRs for logbook), ICU multidisciplinary round, pre-discharge round.
- Orders written on rounds carry `round_id` in payload (attribution of who was present); "orders written by JR during consultant round" auto-mark `supervised_by = consultant` when the consultant's `started` event is open and location-matched.
- Discharge intent captured on rounds ("fit for discharge tomorrow" → pre-discharge task cascade, feeds discharge-by-11am KPI).
- Events: `round.list_generated` NEW · `round.started` NEW · `round.patient_seen` NEW · `round.patient_deferred` NEW · `round.completed` NEW · `note.drafted` NEW · `note.signed` NEW · `note.cosigned` NEW · `note.overdue_flagged` NEW · `discharge.intent_recorded` NEW.

### 3.5 Order verification & countersignature (overlay rule set on order modules; P2/P3)

Not a workflow of its own — a **verification-rule table** (§4 `signing_rules`) evaluated at `order.placed`/`prescription.issued`, plus one lifecycle for verbal orders:

```
verbal_order.recorded(nurse, read-back documented, giver = named doctor on duty)
  → active(administrable per policy) → countersigned(giver or grade-superior, ≤ 4 h default; ≤ 1 h narcotics/high-alert)
  ├─ overdue → escalate giver → SR → consultant (S3 batch; S1 if high-alert)
  └─ repudiated(doctor says "I never gave that") → incident + order suspended + MS review
```

- Signing classes (default matrix, configurable per privilege): routine orders — JR may sign; **narcotics (NDPS / Schedule X) and Schedule H1 outside formulary restrictions — SR/consultant only, second factor (fix 27)**; high-alert (KCl concentrate, insulin infusions, heparin, chemo, thrombolytics, restraint orders, DNR) — consultant sign or SR sign + consultant countersign ≤ 1 h; blood transfusion order — SR+; ICU titration ranges — ICU_DOC; discharge summary — resident drafts, consultant signs; MCCD — registered medical practitioner who attended (consultant chain); MLC opinion — SR+ with MS visibility.
- Events: `verbal_order.recorded/.countersigned` (existing) · `verbal_order.repudiated` NEW · `order.countersign_required` NEW · `order.countersigned` NEW · `signing_rule.blocked` NEW.

### 3.6 Inter-specialty consult / referral request (P2 order-to-result, `order_type: consult`)

```
requested(requesting doctor, urgency: stat|urgent|routine, question) → routed(automation → specialty on-call/ named consultant if patient's choice)
  → acknowledged(SLA: stat 30 min, urgent 4 h, routine 24 h) → seen(bedside) → opinion_signed → completed (fee posts; §11.4 map 5)
  ├─ declined(reason; re-route) · redirected(to other specialty) · not_acknowledged → ladder: specialty on-call → HOD → MS
  └─ converted_to_takeover (doctor.changed with handover note; attribution split)
```

Events: `consult.requested/.completed` (existing) · `consult.routed` NEW · `consult.acknowledged` NEW · `consult.declined` NEW · `consult.redirected` NEW · `referral.issued` (existing, for outward).

### 3.7 Duty report at shift end (P5; per unit per shift)

```
compiling(auto: census, admissions, discharges, transfers, deaths, MLCs, codes, incidents, escalations open/breached, pending countersigns)
  → drafted(Duty-Report Compiler T2 adds narrative for critical events) → submitted_by(resident/RMO) → reviewed_by(SR/consultant on-call, ≤ 2 h)
  → filed (feeds owner 8 a.m. digest, MS morning report, mortality list)
```

Events: `census.recorded` (existing) · `duty_report.submitted` NEW · `duty_report.reviewed` NEW · `duty_report.overdue_flagged` NEW.

### 3.8 Death declaration & certification chain (P1 terminal; extends §11.2 E6 and fix 13)

```
death_suspected(nurse/Code Blue outcome) → declared(doctor on duty: time of death, examined, resuscitation status; patient.deceased)
  → cause_drafted(resident, MCCD Form 4 fields: immediate / antecedent / underlying, interval, manner)
  → certified(consultant or on-call signer chain, second factor; ≤ 2 h day / ≤ 4 h night default — last-rites timing is the target)
  → mlc_check(auto: MLC flag, unnatural/suspicious/within-24h-of-admission-unexplained/medico-legal on admission → police intimation task; body hold; no MCCD release until police clearance where applicable)
  → released_to_mrd(Form 4 to MRD → Form 2 to Registrar within 21 days; body release via double-verify §11.14)
  ├─ brought_dead (ER, separate register; brought_dead.recorded) — outside this chain except intimation
  └─ mortality_review_scheduled(auto for every death; MS committee)
```

Events: `patient.deceased` (existing) · `death.declared` NEW · `mccd.drafted` NEW · `mccd.certified` NEW · `mccd.amended` NEW · `police.intimated` NEW · `mortality_review.scheduled` NEW · `mortality_review.completed` NEW · `body.released` (existing).

### 3.9 Night duty, rest & hours (validator rules on the roster; not a workflow)

Rules as definition data: max 12 h scheduled + 1 h handover; post-night rest ≥ 12 h before next assignment (no morning OPD/OT after a night, hard block; override = HOD + evented); ≤ 1 night in 3 for PG residents; one weekly off (NMC PGMER 2023 "reasonable working hours, one weekly off" — exact hour caps are institutional policy, cite as O-3); women residents' night provisions per state Shops & Establishments/Factories analogues (S10 §12.17). Violations block publication (`roster.blocked`) unless surge mode.

---

## 4. Data model sketch

Module `duty-doctors` (owns), plus `roster` substrate (kernel-adjacent, Plan 20). Column sketches only.

**roster (Plan 20, all staff — doctors are a role family on it)**
- `roster_periods` (id, unit_id→resources, role_family, from, to, version, status draft|validated|published|blocked, published_by, site_id)
- `roster_slots` (id, period_id, user_id, role_key, grade, shift_code, starts_at, ends_at, location_resource_id, is_oncall bool, specialty, swap_of_slot_id?, source manual|import|resolver)
- `roster_validation_findings` (slot/period, rule_id, severity block|warn, accepted_by?, reason)
- `attendance_punches_mirror` (user_id, punched_at, direction, source HR SaaS, imported_at) — read-only mirror for reconciliation
- `oncall_chains` (specialty, date, ordered user_ids[], rotation_pointer) — round-robin per §11.12

**duty-doctors (Plan 21)**
- `duty_assignments` (id, roster_slot_id, user_id, grade, unit_resource_id, workflow_instance_id, checked_in_at, checked_out_at, state, handover_id?, covering_for_user_id?)
- `patient_doctor_links` (id, encounter_id, role primary_consultant|covering_consultant|resident_of_record|consult_specialist, user_id, from, to, cause_event_id, attribution_share_pct?, consent_ref?) — the "who is the doctor for this bed" history; billing reads attribution from here via declared interface
- `consultant_covers` (id, absent_user_id, cover_user_id, from, to, specialties[], approved_by, leave_event_id)
- `escalations` (id, workflow_instance_id, source_event_id, severity, patient_id?, encounter_id?, current_rung, rung_history JSONB[{role,user_ids,notified_at,acked_by,acked_at}], resolved_by, resolution_kind note|order|delegated|false_alarm, resolved_at)
- `handovers` (id, unit_resource_id, shift_from, shift_to, outgoing_user_id, incoming_user_id, sheet_version, state, drafted_by actor, provenance stamp)
- `handover_items` (handover_id, encounter_id, status_line, pending_results JSONB, tasks JSONB, if_then text, code_status, acknowledged_by, acknowledged_at, flags[])
- `rounds` (id, unit_resource_id, type, lead_user_id, participants[], started_at, completed_at, teaching bool, state)
- `round_visits` (round_id, encounter_id, seen_at, seen_by, deferred_reason?, note_id?, orders_event_ids[])
- `clinical_notes` (id, encounter_id, kind progress|round|admission|procedure|consult_opinion|death|handover, author_user_id, author_grade, status draft|signed|cosign_pending|cosigned|amended, signed_at, cosigned_by, cosigned_at, body FHIR `Composition`/`DocumentReference` JSONB, occurred_at, recorded_at, late_entry bool, draft_provenance JSONB, dictation_audio_ref?, scribe_user_id?)
- `signing_rules` (id, order_class, min_grade, requires_cosign_by_grade?, cosign_window_min, second_factor bool, privilege_key?, version, active)
- `verbal_orders` (id, encounter_id, nurse_user_id, giver_user_id, read_back_text, recorded_at, order_ref, countersigned_by, countersigned_at, state)
- `consult_requests` (id, encounter_id, requesting_user_id, specialty, named_consultant?, urgency, question, routed_to_user_id, acked_at, seen_at, opinion_note_id, state, fee_event_id)
- `procedure_attributions` (id, encounter_id, procedure_code, operator_user_id, supervisor_user_id, role performed|assisted|observed, supervision_level, logbook_export_status, cosigned_at) — DNB/NBEMS e-logbook feed
- `duty_reports` (id, unit_resource_id, shift, submitted_by, reviewed_by, census JSONB, events JSONB (deaths, MLC, codes, incidents refs), narrative text, state, provenance)
- `death_declarations` (id, encounter_id, declared_by, declared_at, resuscitation bool, witness_nurse_id, mlc_flag, police_station?, intimation_task_id?)
- `mccd_certificates` (id, death_declaration_id, form 4|4A, cause_1a/1b/1c/2, intervals, manner, certified_by, certified_at, second_factor_ref, version, amended_from?, mrd_handoff_at, registrar_form2_filed_at) — **statutory register as a table**
- `mortality_reviews` (death_declaration_id, scheduled_for, committee, outcome, preventability class, actions)
- `doctor_hours_ledger` (user_id, date, scheduled_min, worked_min (from punches ∩ assignments), night bool, rest_violation bool) — derived, for fatigue KPIs
- `kpi_formulas` — lives in S10's KPI formula registry (Plan-level, not here); this module registers metric ids.

**Registry kinds (Plan 13):** units/wards/beds already; add **`duty_station`** kind (a nursing-station/doctors'-room a duty assignment is anchored to — tablets, PBX extension) — proposed, not ruled.

**FHIR shapes:** `PractitionerRole` (assignment), `Composition` (notes, summaries, death note), `ServiceRequest` (consult), `Task` (escalation), `Flag` (DNR/code status), `Provenance` on every signed document.

**Retention:** clinical notes follow record retention (IPD ~10 y, MLC indefinite, §11.14); `mccd_certificates` permanent; rosters/assignments 8 y (labour + NABH); escalations 5 y; dictation audio 90 days after signed note unless legal hold (O-6).

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → assertion → ruling ref**.

### A. Identity, wrong patient, wrong bed
- **A1** Nurse-call raised from bed 12 but patient moved to bed 14 an hour ago (transfer evented, board lagging on tablet) → escalation binds to `encounter_id`, never bed number; resolution uses current bed → test: transfer then call, JR sees new bed on worklist.
- **A2** Two patients same name same ward (Ram Kumar ×2) → round list shows UHID last-4 + age + bed + photo; note-open requires wristband scan or explicit "no band — reason" → assertion: note without scan carries `identity_confirmed=false` flag surfaced to co-signer.
- **A3** Resident writes progress note into the wrong encounter → entered-in-error grammar (fix 8): reversing event + linked corrected note; original stays visible struck-through; both encounters' timelines show trail → test: no hard delete row exists.
- **A4** Sealed/VIP record (fix 4 carve-out) → treating team on duty sees full handover line; the unit's *other* doctors see alias line; carve-out access evented → test: off-duty consultant of the same unit gets alias only.
- **A5** Staff-as-patient admitted to own ward → assignment resolver excludes the patient's own user from any doctor link; handover sheet masks per confidential policy → test: `patient_doctor_links.user_id ≠ patient.user_id`.
- **A6** Unknown patient (ER, unconscious, no name) escalated to ward → links by UHID-temporary; once merged (`patient.merged`) links re-point; duplicate ladder threads dedupe → test: merge closes one thread, keeps the other.
- **A7** Newborn on mother's bill (§11.4 map 2) → separate encounter, separate doctor link (paediatrician on-call), rounds list shows baby as own row under mother's bed → test: paediatric escalation routes to paediatric ladder, not obstetric.

### B. Timing, concurrency, race
- **B1** Escalation acknowledged simultaneously by JR and SR (both tapped within 1 s) → single-winner transition; second gets "already acknowledged by Dr X"; both taps evented → test: exactly one `escalation.acknowledged`.
- **B2** Ladder auto-climbs at T+5:00 while JR's acknowledgement arrives at T+5:01 over poor Wi-Fi with client time T+4:58 → server time is truth; the climb stands, JR ack recorded as rung-1 late-ack; SR is notified it is already handled → test: no double attendance.
- **B3** Shift swap agreed on WhatsApp at 19:50 for 20:00 shift; not entered → at 20:15 the rostered JR is `no_show`; the actual JR checks in as "unrostered check-in" → system creates `duty.swapped` pending SR approval, coverage continues; report to HOD → test: escalations route to the checked-in doctor immediately.
- **B4** Consultant starts morning round on two wards at once (tablet left open) → one active round per lead; starting a second auto-pauses the first with `paused` → test: `round.started` on ward B emits `round.paused` on ward A.
- **B5** Verbal order given at 02:10, nurse records at 02:40 after administering (emergency) → `occurred_at` 02:10, `recorded_at` 02:40, late-entry flag; countersign window counts from `occurred_at` → test: window math uses occurred_at.
- **B6** Handover in progress when a Code Blue fires → handover instance suspends; outgoing and incoming both remain on ladder; after code, resume from where left → test: no patient loses acknowledgement state.
- **B7** Roster republished mid-shift (v2) → in-flight assignments finish on v1 (§10.2); only future slots take v2 → test: active `duty_assignments` retain `roster_slot_id` of v1.
- **B8** Two consult requests to cardiology, one stat, one routine, same on-call → stat jumps queue; routine keeps its 24-h clock → test: worklist ordering by urgency then age.
- **B9** Clock drift on ward tablet (§11.18 sweep 1) → all timestamps server-side; client shows "clock differs by 7 min" banner → test: `clock.drift_flagged`.
- **B10** Midnight boundary: night JR's shift 20:00–08:00 spans two roster days → assignment keyed to shift, not date; census at 00:00 attributes to the night shift → test: census report shows one night shift, not two half-shifts.

### C. Partial failure & downtime
- **C1** Server down 01:00–03:00 (floor-scoped or whole) → paper path: printed 22:00 handover sheet + printed on-call list per floor (auto-printed at 20:00 daily, QR'd); PBX ladder from printed list; escalations logged on paper form; backfill on restore with `occurred_at` claims, late-entry flags; SLA breaches during downtime tagged `downtime=true` and excluded from KPI numerators → test: KPI query excludes downtime window.
- **C2** Notification gateway (WhatsApp/push) down but app up → ladder falls to PBX ring (fallback ladder §11.5); ack via app still possible → test: `notification.failed` triggers PBX rung without waiting 5 min.
- **C3** PBX down → app push + SMS; if both fail, ward nurse gets manual-notify task ("call Dr X on mobile") on her worklist with the number → test: manual-notify task created ≤ 60 s.
- **C4** HR SaaS attendance feed down 3 days → activity-attendance reconciliation pauses, flagged; assignments unaffected (HMIS is roster SoR) → test: no `activity_attendance.mismatch` emitted during feed outage.
- **C5** Inference provider down → Handover-Sheet Drafter and Discharge Drafter degrade to deterministic assembled sheet (fact list, no narrative); doctors proceed → test: handover completes with `drafted_by=system_assembly`.
- **C6** Doctor's phone dead; tablet only → check-in from ward tablet with PIN; escalations render on the ward station screen with audible chime → test: ack from station terminal identifies the doctor via PIN switch but a *sign* still needs second factor.
- **C7** Power + network loss on one floor (floor-scoped degradation) → floor's duty doctor list frozen with staleness banner elsewhere; that floor runs paper → test: other floors' ladders unaffected.
- **C8** Backfill of a death declared during downtime → `death.declared` with `occurred_at` from paper, `recorded_at` now; MCCD window counts from occurred_at; certification cannot pre-date declaration → test: validator rejects `certified_at < declared_at`.

### D. Money — attribution, fee splits, payers
- **D1** Consult requested by JR without consultant's knowledge; specialist sees patient; fee posts to bed → allowed (care first) but the primary consultant is notified in digest; payer=TPA cases flag "consult not in pre-auth" for TPA desk → test: `consult.completed` → `charge.posted` + TPA task when payer tag TPA.
- **D2** Consultant cross-cover for 5 days: who gets the fee split? → default: cover consultant earns visit fees for rounds actually performed (`round.patient_seen` by cover); admission/procedure attribution stays with primary unless `doctor.changed` → **O-1**.
- **D3** Patient's family demands change of consultant → `doctor.changed` with consent record, handover note mandatory; attribution split at the timestamp; the previous consultant's accrual freezes → test: accrual ledger shows two attribution windows.
- **D4** Locum consultant (temp_role) signs discharge summaries → fee-split class per partners master; if none configured, accrual goes to "unattributed hold" cost line and Leakage Auditor flags → test: no silent zero.
- **D5** Same specialist repeats consult same day (free per §11.4 map 5 default) → second `consult.completed` posts zero-charge line with rule reason → test: golden fixture.
- **D6** Resident performs a chargeable bedside procedure (ICD, central line) under supervision → charge attributes operator=JR, supervisor=consultant; payout share per policy to consultant; JR's logbook entry created → test: `procedure_attributions` row + `charge.posted` linkage.
- **D7** PMJAY package patient: extra consults not in package → posts to package overrun pathway (`package.overrun_projected`), not to patient cash → test: payer routing.
- **D8** MCCD certified but bill unsettled; family disputes → certificate release never gated on payment (legal; MCCD is patient's right) — body release follows §11.14 double-verify and E6 sensitive settlement; **no payment gate on certificate** → test: `mccd.certified` reachable with outstanding balance.
- **D9** Consultant claims round visit fees for a day the round never started (no `round.started`) → billing accepts only visits with `round.patient_seen` or a signed note; else charge blocked with reason → test: fee without evidence blocked.
- **D10** Two consultants both claim primary attribution after a takeover dispute → `attribution.disputed` → MS disposition (S10 §12.9); accruals held pending → test: payout batch excludes disputed rows.

### E. Consent, legal, MLC, minors, unconscious
- **E1** Death within 24 h of admission with unclear cause → auto MLC prompt (policy default: unexplained death <24 h of admission, all ER deaths, all post-operative deaths in doubt, poisoning, burns, trauma, suicide, custodial, suspected foul play) → police intimation task with ledger of attempts; body hold flag; MCCD marked "for post-mortem — cause pending" variant → test: MCCD release blocked until `police.intimated` + clearance recorded.
- **E2** Police demand records from duty doctor at 02:00 → single-spokesperson rule (§11.14); records-request workflow; duty doctor gives only the MLC intimation, logged → test: `document.release_logged`.
- **E3** Minor patient deteriorates, parents absent, needs emergency procedure → two-doctor consent variant (§11.3) — SR + consultant on-call sign; evented; guardian contact task opens → test: consent record kind=two_doctor_emergency.
- **E4** Unconscious adult, family refuses ICU transfer → refusal documented per-intervention (§11.14), counselling by consultant, remains admitted; ladder marks "refusal on file" so repeated escalations do not re-page for the same refused intervention → test: dedupe key includes refused intervention.
- **E5** DNR on file; nurse triggers Code Blue by reflex → code team paged but chart banner shows DNR; team leader records "code stood down — DNR"; incident not raised (policy) → test: `code.activated` + `dnr.recorded` visible in code sheet.
- **E6** Brought dead at ER (Black) → not this chain; `brought_dead.recorded`, MLC by default, Form 4A not applicable (institution did not treat) — certificate is the police/post-mortem path → test: no `mccd.certified` for brought-dead.
- **E7** Assault victim, MLC on admission; resident documents injuries → MLC template with body-map, wound descriptors; opinion signed SR+; copy for police only via release workflow → test: MLC note cannot be signed by JR.
- **E8** POCSO case on paediatric ward → sealed-class + mandatory reporting task (POCSO §19) to the MS with statutory clock; ward digest masks → test: reporting task exists with deadline.
- **E9** Telephone advice by consultant to resident recorded as "verbal order" — Telemedicine Practice Guidelines 2020 do not govern doctor-to-doctor advice; policy: doctor-to-doctor phone advice is documented by the resident as "discussed with Dr X at HH:MM, advised …" (a note, not a verbal order); only nurse-recorded doctor orders are verbal orders → test: note kind=discussion, no countersign clock; consultant sees it in digest and may endorse.
- **E10** Death certificate cause worded by JR ("cardiac arrest") → MCCD validator rejects mechanism-only causes (WHO/ORGI guidance: cardiac arrest, respiratory failure alone not acceptable as underlying cause) → test: draft blocked with hint.
- **E11** Body release requested before MCCD certified (last rites before sunset) → chain SLA target night ≤ 4 h; if the certifying consultant unreachable, on-call signer chain (fix 13) → test: escalation reaches second signer at T+60 min.
- **E12** Organ-donation/brain-death (Transplantation of Human Organs Act) → deferred protocol (§11.14) — this module only provides the brain-death committee's declaration event slot `brain_death.declared` NEW with four-doctor panel roles → test: panel composition validator.

### F. Staff absence, overload, handover
- **F1** SR no-show at night, only JR + RMO on floor → coverage gap → Coverage Resolver proposes RMO as acting SR (if privileged) or pulls SR from adjacent floor; DM approves; ladder rung 2 re-resolved → test: escalation at 23:00 reaches a live rung 2.
- **F2** Consultant unreachable 30 min for S1 → ladder passes to HOD then MS; `consultant.unreachable_flagged` NEW; next morning MS digest lists it; 3 in 30 days → governance review → test: counter per consultant.
- **F3** Consultant on foreign trip without `doctor_leave.scheduled` → first unanswered escalation triggers cover suggestion; DM assigns cover retroactively; leave event created "late" with flag → test: `cover.assigned` with `late=true`.
- **F4** Mid-shift resident collapses/leaves (family emergency) → `duty.left_early`; open escalations re-route; handover forced from last sheet; incoming/SR co-acknowledges → test: no escalation left on departed user.
- **F5** JR covering 45 beds at night (ratio breach) → `overload.flagged`; SLA breaches tagged with load context; KPIs show load; DM sees gap → test: fairness rule in KPI output.
- **F6** Handover sheet confirmed but incoming ignores 3 patients → T+20 `handover.patient_unacknowledged` ×3 → rung 2 → test: three events, one ladder thread (dedupe by handover).
- **F7** Resident strike / mass leave (PG association) → surge mode: consultants take first-line, bundling widened, elective shed; ladder definition swaps to "consultant-first" version, owner-activated → test: definition versioning works under surge flag.
- **F8** Post-night JR rostered for morning OT assist → validator blocks publish; HOD override evented with reason → test: `roster.blocked` then override event.
- **F9** Doctor logs in from home to countersign (off-site access fix 35) → second factor; IP/device logged; countersign counts in window → test: signature-class act from off-site produces `note.cosigned` with device fingerprint.
- **F10** Teaching round with 8 JRs; attendance for logbook → participants scanned via badge/PIN on tablet; those absent not credited → test: logbook export lists only scanned.
- **F11** Two SRs both believe the other covers ward 3B → resolver shows exactly one rung-2 holder per unit; the roster validator refuses ambiguity (two SRs on same unit, neither primary) → test: `roster.blocked` reason=ambiguous_coverage.
- **F12** Consultant takes 1-day leave; OPD cascade (§11.5) handles OPD; **IPD patients need a named cover** → leave event without cover for a consultant with active inpatients is blocked until cover chosen or HOD auto-assigns → test: `doctor_leave.scheduled` requires `cover.assigned` when active inpatients > 0.

### G. Equipment / device failure
- **G1** Ward tablet stolen/lost → device revoke; sessions killed; no PHI at rest beyond cache TTL → test: token revoke propagates ≤ 60 s.
- **G2** Pager/PBX extension mis-mapped to wrong doctor → the ladder's PBX rung calls resolved user's *registered* number, not extension table; mis-map reported by ack failure → test: unanswered PBX + app ack from a different user = flag.
- **G3** Dictation mic failure → typed fallback; template quick-notes → test: note saved without audio ref.
- **G4** Barcode scanner down at station → manual UHID entry with reason; identity flag on note → test: flag surfaced in co-sign view.
- **G5** Monitor telemetry gap (`data_gap.flagged`) while on rounds → round list shows "no telemetry 20 min" so the doctor checks bedside → test: flag rendered in list.

### H. Data quality, late-arriving, backdated
- **H1** Progress note written at 14:00 for 08:00 round → allowed, dual-stamp, `late_entry.flagged`; timeliness KPI counts as late → test: KPI uses recorded_at − occurred_at.
- **H2** Note edited after signing → amendment creates new version, original immutable; co-signer re-notified → test: version chain.
- **H3** Consultant co-signs 40 resident notes in 30 s (rubber-stamp) → allowed, but Fraud Sentinel diagnostic "cosign clustering" (S10 §12.11) → test: anomaly report row, no block.
- **H4** Lab result verified after patient discharged → Pending-Results Chaser routes to the discharging consultant + Recall Agent contact protocol (§11.5) → test: task exists even though encounter closed.
- **H5** Death time recorded 23:58 vs declared 00:05 (which date?) → time of death = declared examination time by policy; the form shows both; MCCD uses declared → test: date consistency validator.
- **H6** MCCD amended after MRD filing (cause revised post-histopath) → `mccd.amended` new version; MRD notified; Form 2 correction task → test: version 2 linked; version 1 retained.
- **H7** Handover sheet lists "pending CT" but CT was cancelled → sheet items link to live order state; stale item shows "cancelled" at ack time → test: render from order read model, not copied text.
- **H8** Roster imported from HR SaaS CSV with a doctor who has resigned (`exit.completed`) → import validator drops with finding → test: `roster_validation_findings` row.
- **H9** Resident types `[PT-1]`-like text in a note (token spoofing) → scrubber escapes before any inference call (copilot §2.2) → test: fixture.

### I. Fraud, leakage, gaming
- **I1** JR acknowledges every escalation instantly then attends 40 min later → KPI pairs ack time with *resolution* time and nurse-confirmed "doctor arrived" tap; ack-without-arrival pattern → diagnostic → test: metric `ack_to_arrival` exists.
- **I2** Consultant marks all patients "seen" at 07:00 from car (location mismatch) → round visits carry device location/Wi-Fi AP; off-site "seen" flagged (not blocked) → test: `round.patient_seen` with `onsite=false` flag.
- **I3** Fee for consult never performed → `consult.completed` needs opinion note signed; no note, no fee → test: charge blocked.
- **I4** Resident writes a procedure logbook entry for a procedure done by someone else → operator must be attached to the procedure event (OT/ward procedure record) by the supervisor; self-attested entries flagged "unverified" for NBEMS export → test: export marks unverified.
- **I5** Ghost duty: doctor rostered and paid but never on site → activity-attendance reconciliation (S10 §12.7): zero events by that user during assignment + punch present → mismatch report → test: T0 row.
- **I6** Attribution steering: admitting SR routes every admission to one consultant regardless of roster round-robin → `oncall.assigned` deviations from round-robin counted; outward-referral/attribution pattern report (S10 §12.10) → test: deviation ratio metric.
- **I7** Countersign of narcotics order by the same user via two devices → SoD: giver ≠ counter-signer unless grade rule allows; same user detected → block → test: `sod.violation_blocked`.
- **I8** Duty report omits a death to avoid mortality review → report compiler is automatic from `patient.deceased`; cannot be removed, only annotated → test: report always includes all deaths in the unit-shift.

### J. Privacy, sealed records, VIP, staff-as-patient
- **J1** Handover WhatsApp group (shadow channel) → module provides in-app handover; policy forbids PHI on WhatsApp; DPIA note; Fraud Sentinel cannot see WhatsApp — mitigation is making the in-app path faster (fix 35) → test: n/a (policy) — record as risk §15.
- **J2** Duty report to owner digest lists deaths → digest carries counts + bed/UHID-masked lines; owner has hospital-wide scope by role, but sealed-class rows render as "1 sealed" → test: digest fixture.
- **J3** Consultant asks Ops Copilot "who is in bed 14" while off-duty → permission = user ∩ agent; off-duty consultant of another unit gets refusal → test: copilot permission fixture.
- **J4** Dictation audio contains third-party names → audio retained 90 d then purged; transcript scrubbed before any model call → **O-6**.
- **J5** DPDP data-principal asks for "all notes about me" → export includes notes; excludes internal escalation chat between doctors? → default: escalation records are part of the medical record (they document care) — include → **O-7**.

### K. Language, literacy, accessibility
- **K1** Bhojpuri-only attendant asked to consent for a procedure at 03:00 → vernacular consent form + thumb + witness (pass 5); resident records interpreter (staff) name → test: consent record has interpreter field.
- **K2** Death communicated to family who cannot read → counselling record; MCCD copy explained; WhatsApp neutral notice only → test: `briefing.recorded` kind=death_counselling.
- **K3** Consultant prefers Hindi dictation → dictation-to-draft supports Hindi/Hinglish; medical terms stay English → test: language field on note.
- **K4** Colour-blind resident on ladder severity colours → severity also by icon/text → UX check.

### L. Scale — 10 beds today → 610 beds
- **L1** 10 beds, 1 RMO, consultants visiting: ladder rung 1 = RMO, rung 2 = consultant directly (no SR) → definitions per unit size; validator warns if a rung role has no holders at that unit → test: ladder collapse config.
- **L2** 610 beds: ~200 escalations/night; ladder threads deduped per patient+problem; SR worklist sorted by severity+age; push storms rate-limited (action budgets, note 14) → test: 200 concurrent escalations resolve ≤ 2 s each.
- **L3** 45 ICU beds across 3 halls: ICU ladder separate (ICU JR → ICU SR → intensivist) → unit-type ladders.
- **L4** Round list generation for 600 patients at 06:30 → automation runs per unit, ≤ 30 s total, idempotent → perf test at T6-equivalent.
- **L5** Multi-site later (`site_id` in envelope) → rosters and ladders are site-scoped from day one → test: cross-site resolution impossible.

### M. Integration failures
- **M1** HR SaaS roster import duplicates slots → idempotency key (user, start, unit) → test: re-import no dupes.
- **M2** PBX click-to-call API missing → fall back to displaying number + manual dial; ack still in-app → test: no dependency on PBX API for ack.
- **M3** NBEMS e-logbook has no API (likely; it is a portal) → export CSV/PDF per resident per month with supervisor signatures; no live integration claimed → test: export fixture.
- **M4** ABDM care-context push of discharge summary fails → summary still signed and printed; push retried by gateway → test: signing not gated on ABDM.
- **M5** Biometric punch feed timezone wrong (UTC vs IST) → reconciliation shows 5.5 h offsets → validator detects systematic offset and alerts admin instead of flagging 200 doctors → test: offset detector.

### N. Rounds, notes, discharge, consults (flow-specific)
- **N1** Patient in OT during round → `round.patient_deferred(reason=in_ot)`; re-queued to evening round → test: not counted as unseen.
- **N2** Consultant round completed but 3 orders written by JR after consultant left → orders after `round.completed` are not `supervised_by` consultant; co-sign queue → test: attribution timing.
- **N3** Discharge summary drafted by T2 from notes that include an unsigned resident note → drafter uses only signed facts; unsigned lines shown as "unsigned — not included" → test: provenance excludes drafts.
- **N4** Discharge by 11 a.m. target vs consultant who rounds at 18:00 → KPI reads "fit-declared → out" (already §11.2) plus "discharge intent recorded previous day" share; evening-rounders' patients tagged → diagnostic, not punitive.
- **N5** Consult declined ("not my specialty") → redirect with reason; requester notified; SLA clock continues from original request (patient's clock, not the department's) → test: SLA breach attributed to the routing, not to the second specialist.
- **N6** Stat consult at 03:00 to a specialty with no on-call (e.g., nephrology at 10-bed stage) → resolver returns "no holder" → ladder to consultant on-call (general) + refer-out offer per ICU-full analogue → test: `coverage.gap_flagged(specialty)`.
- **N7** Resident note co-sign window lapses because consultant on leave → cover consultant inherits co-sign queue → test: queue re-points on `cover.assigned`.
- **N8** Progress note required daily but patient is a 45-day long-stay → note frequency policy per class (daily acute; alternate-day rehab) — definition data → test: overdue only per policy.
- **N9** Two consultants co-managing (surgery + medicine) → dual primary links with roles; escalation for medical issue goes to the medical team by problem tag → test: problem-tagged routing.
- **N10** Discharge intent recorded but nursing shows pending IV antibiotics till 14:00 → intent-with-condition; 11 a.m. KPI excludes clinically-timed discharges when the condition is an order → test: exclusion reason recorded.
- **N11** Patient LAMA at night; resident must counsel and sign form → LAMA E5 flow; JR may witness, SR+ signs counselling → test: signing rule.
- **N12** Verbal order for a narcotic at night → allowed only if giver is SR+; countersign ≤ 1 h; NDPS register entry by nurse with witness → test: JR verbal narcotic blocked at record time with reason.
- **N13** Nurse read-back mistyped dose (10× error) → formulary safety check runs on the verbal-order record as on any prescription; hard warning blocks record; nurse re-confirms with doctor → test: safety engine invoked on verbal path.
- **N14** Consultant "co-signs" by phone: "put my name" → impossible; co-sign requires their session + second factor; resident may record "discussed with" note → test: no proxy signing API.
- **N15** Round note dictated in corridor, patient names of neighbours captured → scrubber; draft shows redaction marks → test: fixture.
- **N16** Discharge summary drafter cites a lab line that was later amended (`report.amended`) → draft invalidated; re-draft prompted; signed summary unaffected unless doctor amends → test: cache invalidation on amendment.
- **N17** Post-night resident asked to certify a death at 08:30 (still on shift end) → allowed (still on duty); if after hand-off, redirected to on-duty → test: signer must hold active assignment or consultant role.
- **N18** Death of a PMJAY patient → MCCD chain identical; package closure via billing → test: payer-agnostic chain.
- **N19** Nurse escalates "patient wants to speak to doctor" (non-clinical) → severity S3, worklist not push → test: no interrupt.
- **N20** Duplicate escalation for same patient same problem from two nurses → dedupe by (encounter, problem tag, 30-min window) → test: one thread, two source events.

### O. Auditor/inspector walks in
- **O1** NABH assessor: "show me last night's handover for ward 2" → `handovers` + items with acknowledgements, printable → test: report renders from tables, not logs.
- **O2** State CEA inspector asks who was the doctor on duty on 12 March 02:00 in ICU → `duty_assignments` history by unit + time → test: point-in-time query.
- **O3** Police ask for MLC intimation proof → `police.intimated` with attempts, station, diary number field → test: form fields present.
- **O4** Registrar of Births & Deaths asks why Form 2 filed late → `mccd_certificates.registrar_form2_filed_at` vs `declared_at` → test: 21-day KPI.
- **O5** NMC/NBEMS inspection wants resident duty hours → `doctor_hours_ledger` export → test: monthly export.

(Count: 107 rows.)

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 02:00 — server down, SR absent, two deteriorations.**
01:55 primary DB unresponsive; `downtime.declared` cannot be written — DM declares via runbook, floors switch to paper. 20:00's auto-printed on-call sheets are at each station with PBX extensions and mobiles. 02:10 ward 3 nurse finds SpO2 78% in bed 9; PBX rings JR (rung 1 from paper); JR busy on ward 4; nurse rings SR — SR not answering (later found asleep, phone silent); nurse rings consultant on-call directly from paper list; consultant advises, arrives 02:40. 02:15 second patient in ward 5 hypotensive; RMO attends. Paper escalation forms filled (time raised, who called, who answered). 03:05 system restored. Backfill: nurse enters both escalations with `occurred_at` from paper, `recorded_at` now, `downtime=true`; the SR no-answer is entered as an unacknowledged rung; the system emits `escalation.unanswered_flagged` retroactively, which opens the incident. Agents: Deterioration router idle (no events in window); SLA Chaser resumes and does NOT re-page for backfilled resolved threads (backfill gate). Audit shows: paper form scans attached, two late-entry flags, SR's silence, consultant's response time 25 min — recorded, load-context "SR effectively absent". Morning: MS digest lists SR no-answer; roster team checks S10 §12.5 rest rules — SR was on second consecutive night (validator had warned; DM had accepted). Owner 8 a.m. digest: "1 downtime 70 min, 2 S1 escalations, 1 unanswered rung, 0 deaths".

**6.2 Mass casualty (bus crash, 22 casualties) at 19:40 during doctor handover.**
`disaster.declared` by ER head. All in-progress handovers suspend; outgoing shift's `checked_out` is blocked (surge rule: "no doctor leaves until DM releases"); staff-recall broadcast pages off-duty SRs (S10 §12.4). Ladder definition flips to the surge version (consultant-first for ER; wards keep normal). Coverage Resolver proposes ward coverage for the SRs pulled to ER; DM approves in one tap. 20:30–23:00 ward escalations route to RMOs; the ladder's S1 timer widened to 10 min in surge (definition data). All casualties auto-MLC; two deaths in ER — brought-dead register for one, death-in-ER for the other: declared by ER physician, MCCD deferred pending post-mortem (police case). 23:40 disaster ended; suspended handovers resume; every patient re-acknowledged; the system produces a surge report: who covered what, minutes per rung, unacknowledged threads (none). Paper path: DIS-tag sheets. Agents: Handover Drafter re-drafts sheets after surge with the intervening events; Duty-Report Compiler marks the shift "surge". Audit: `disaster.declared/.ended`, definition version swap events, 14 `cover.assigned`, two `death.declared`, two `police.intimated`.

**6.3 Consultant unreachable with a bleeding post-op patient, night, TPA patient, family filming.**
23:10 nurse escalates S1 (drain 400 ml/h). JR acks at 1 min, attends, escalates to SR at 5 min; SR attends, calls primary surgeon — no answer (phone off). System climbs to rung 3 at 10 min: primary and cover (none scheduled) → rung 4 HOD surgery at 15 min (interrupting channel: push + PBX to home landline). HOD answers, directs re-exploration, comes in; anesthetist on-call paged via Code path; OT emergency slot. Meanwhile family films the corridor; Code Violet not needed; single-spokesperson rule — DM speaks. TPA: emergency re-exploration not in pre-auth → TPA desk task at 08:00; care never waits. 00:30 patient in OT. Morning: `consultant.unreachable_flagged` for the surgeon; the MS sees the 15-minute gap; the surgeon's leave was not scheduled; retroactive `cover.assigned` with `late=true`; governance conversation, not auto-penalty. Paper: none needed. Agents: Deterioration router (T1) had already flagged tachycardia trend at 22:40 (nudge to JR worklist, non-interrupting) — visible in the audit as "early signal 30 min before nurse call".

**6.4 Death at 05:40 on a Friday, family wants the body by 09:00, consultant in OPD at 09:00, MLC ambiguity.**
Night RMO declares death at 05:44 (`death.declared`, resuscitation attempted 20 min, nurse witness). Resident drafts MCCD cause; validator rejects "cardiorespiratory arrest" as underlying; resident fixes (sepsis ← perforation peritonitis ← duodenal ulcer). Patient admitted 30 h ago — the <24 h rule does not fire; but admission was post-RTA 3 days ago at another hospital → resident marks "history of trauma" → MLC check flags "possible medico-legal — confirm"; SR confirms not MLC (ulcer perforation unrelated) with reason; MS sees the decision in the morning digest. Certification: primary consultant asleep; chain SLA night 4 h; system pages primary at 06:00 (S2, not S1), no answer; 07:00 climbs to on-call signer (fix 13); on-call signs from home with second factor at 07:20 after reading the resident's draft and the notes. MRD receives Form 4 at 07:21; body release double-verify 08:30; Form 2 task with 21-day clock. Mortality review auto-scheduled. Owner digest: "1 death, certified in 1 h 36 m, no MLC, review scheduled". If the on-call signer had also been silent: DM + MS interrupting at 08:00 — an empty chair is impossible by S10 §12.16.

**6.5 Handover collapse: WhatsApp-swapped shifts, resident strike rumour, tablets dead.**
19:30 three JRs swapped shifts among themselves on WhatsApp; two tablets on ward 6 out of charge; 20:00 rostered JR A does not check in (`duty.no_show_flagged` 20:15); JR B (actually present) checks in from the station PC as unrostered — system creates `duty.swapped` pending, keeps B as rung 1 immediately. Handover due 20:00 — outgoing JR C confirmed the sheet at 19:50 to A; system re-routes acknowledgement to B; B acknowledges 28 patients, misses 2 (in OT and imaging — deferred with reason). 21:00 rumour of a strike: DM sets surge-ready state (no definition swap yet). Agents: Handover Drafter pre-filled; Pending-Results Chaser lists 6 pending reports; nothing interrupts. Audit: the swap is visible and approvable by SR next morning; no patient unacknowledged; the two deferred were re-queued to the night round and seen at 23:30.

**6.6 Fraud + VIP + MLC in one hour.**
15:00 VIP (sealed) admitted under alias; 15:20 assault victim MLC admitted to same ward; 15:40 a visiting consultant's assistant tries to record "consult completed" for the VIP without a bedside visit to earn the fee. System: consult completion needs a signed opinion note by the consultant's own session (I3/N14) — blocked; attempt evented under the assistant's identity. The VIP's handover line shows alias to non-treating doctors; treating JR sees full facts (carve-out evented). The MLC patient's injuries documented by SR with body-map; police intimation task done 16:10 with diary number; press call → spokesperson. 16:30 the same assistant tries "doctor.changed" to make the visiting consultant primary — requires consent record + handover note; blocked. Fraud Sentinel: two blocked attribution attempts by one user in 1 h → anomaly row to the MS (clinical class reviewer). Audit: everything attributable; nothing silently succeeded.

**6.7 Power and network loss on the ICU floor at 03:00, ventilated patients, rounds due at 07:00.**
Floor-scoped degradation: ICU hall screens freeze with staleness banner elsewhere; bedside monitors on UPS; ICU ladder switches to PBX/analog phones on paper list; ICU JR/SR physically present (ratio holds). Paper hourly charts. 05:10 restored; nurses backfill charts (late-entry flags); Round List Generator at 06:30 marks ICU beds "telemetry gap 03:00–05:10" so the intensivist's round starts with the gap patients; the intensivist's round notes cite the paper chart scans. Device-day billing reconciles from paper + telemetry (§11.15). Audit: `interface.down/.restored`, `data_gap.flagged` ×12, no escalations lost (paper form count = backfilled count — the reconciliation check is a test).

---

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | Register (table) | Who signs | Retention |
|---|---|---|---|---|
| Death certification (institutional) | Registration of Births and Deaths Act 1969 §10(3); MCCD **Form 4** (institutional) / 4A (non-institutional); Form 2 death report to Registrar ≤ 21 days | `mccd_certificates`, `death_declarations` | RMP who attended (consultant chain) | permanent |
| MLC intimation & opinion | CrPC §174 / BNSS 2023 §194 (unnatural death), IPC/BNS reporting duties; state MLC rules | `death_declarations.mlc_flag`, ED `mlc_register`, `police.intimated` events | SR+ opinion; MS oversight | indefinite (§11.14) |
| POCSO mandatory reporting | POCSO Act 2012 §19 | reporting task + sealed note | MS/designated officer | indefinite |
| Narcotics / psychotropics prescribing & verbal orders | NDPS Act 1985 + Rules; Drugs & Cosmetics Rules Schedule H/H1/X (H1 register) | `signing_rules`, `verbal_orders`, pharmacy H1/NDPS registers | SR+/consultant, second factor | H1 register 3 y; NDPS per rules |
| Resident duty hours & rest | NMC PGMER 2023 (reasonable working hours, weekly off); NBEMS DNB rules; state Shops & Establishments for non-PG RMOs | `doctor_hours_ledger`, `roster_validation_findings` | HOD override evented | 8 y |
| DNB/NBEMS e-logbook | NBEMS logbook guidelines | `procedure_attributions` export | supervisor co-sign | course duration + 3 y |
| Verbal orders, read-back, countersign | NABH 5th ed. COP/MOM (medication orders, verbal orders), IMS (records) | `verbal_orders` | giver/grade-superior | with record |
| Progress notes, handover, rounds | NABH COP (continuity of care, handover), IMS; Clinical Establishments Act minimum standards (records) | `clinical_notes`, `handovers`, `rounds` | author + co-signer | IPD ~10 y |
| Telephone advice | Telemedicine Practice Guidelines 2020 apply to RMP–patient; doctor-to-doctor advice is documented as discussion (policy) | `clinical_notes.kind=discussion` | resident | with record |
| Mortality review | NABH PSQ/ROM (mortality & morbidity review) | `mortality_reviews` | MS committee | 10 y |
| Credential/privilege | NABH HRM (credentialing & privileging) | HR-evidence bridge registry (consumed) | MS | employment + 5 y |
| DPDP Act 2023 | data classes: clinical notes (health data, sensitive); duty rosters (employee personal data); escalation records (health + employee); dictation audio (health + voice biometric-adjacent) | DPIA rows | DPO (card 37) | per class |
| Professional conduct | IMC (Professional Conduct, Etiquette and Ethics) Regulations 2002 (records within 72 h on request; certificates) | records-request workflow (existing) | MRD | — |

**What NABH asks to see:** evidence that every inpatient has a daily documented physician review; handover documentation at every shift; verbal orders countersigned within policy; who was on duty (roster + attendance); credential/privilege currency of the signer; mortality review minutes; MLC procedures; time-to-response for critical alerts. All of these are table queries here, not binders.

**What a CEA/police/registrar inspector demands:** duty roster for a date/time; death register entries with certifier registration numbers; MLC intimation proof; Form 2 filing dates.

**Consent forms touched:** two-doctor emergency consent; treatment refusal; LAMA; consent to change of consultant; DNR (consultant-confirmed).

---

## 8. Staff KPI & KRA

All metrics: event-derived, load-normalised (denominator + census shown), diagnostic only (S10 §2). Metric ids for the KPI formula registry; formulas in pseudo-SQL over events.

**JR (card 40)** — KRA: first-line medical presence on the ward; every escalation acknowledged and every note timely.
1. `jr.esc_ack_p50/p90` = median/p90 (`escalation.acknowledged.at` − `escalation.triggered.at`) where rung=1 and user; load: escalations/shift, beds covered. Gaming: I1 → paired with `jr.ack_to_arrival` (nurse "doctor arrived" tap or first order/note).
2. `jr.note_timeliness` = share of required progress notes signed within policy window; late-entry flagged separately.
3. `jr.verbal_order_rate` = verbal orders given / total orders (should trend down with mobile ordering).
4. `jr.cosign_pending_age` = age of oldest note awaiting co-sign (diagnostic on the consultant too).
5. `jr.handover_completeness` = items with all mandatory fields / items.
6. `jr.hours_worked`, `jr.rest_violations` (fatigue; from ledger) — protective metric.
7. `jr.logbook_entries_verified` share.

**SR (card 41)** — KRA: the unit's medical decisions between consultant touches; supervision of JRs.
1. `sr.rung2_ack_p90`; 2. `sr.escalation_resolution_time`; 3. `sr.jr_note_cosign_within_window` (SR co-signs where policy delegates); 4. `sr.handover_acknowledged_100` (per patient, all-or-escalate); 5. `sr.night_round_completion`; 6. `sr.consult_ack_within_sla` (when SR is specialty first-responder); 7. `sr.duty_report_on_time`; 8. `sr.deaths_certified_within_target` (chain participation); 9. `sr.mlc_documentation_completeness`.

**RMO (card 9, extended)** — existing KPIs (escalation ack 5-min class, verbal-order countersign, rounds completion) + `rmo.no_silent_nights` = shifts with zero unanswered rungs / shifts.

**Consultant (cards 8/11/12/13/14, extended)** — KRA: owns the patient; rounds daily; signs what only a consultant may sign; reachable when on call.
1. `cons.round_started_by_11` share (load: inpatients, OT list that day); 2. `cons.note_cosign_within_4h`; 3. `cons.discharge_intent_day_before` share and `cons.fit_to_out_under_3h` (existing cascade metric); 4. `cons.reachability` = on-call escalations acknowledged within class / escalations to them; `cons.unreachable_flags_30d`; 5. `cons.summary_sign_time` (draft ready → signed); 6. `cons.mccd_cert_time` (declared → certified) when in chain; 7. `cons.mortality_review_participation`; 8. `cons.consult_ack_within_sla` as specialist; 9. `cons.teaching_rounds_per_month` (PG units); 10. `cons.attribution_disputes_open`.
Gaming: I2 (off-site seen) flagged; H3 (rubber-stamp co-sign) clustering; D9 (fee without evidence) blocked structurally.

**MS (card 39, extended)** — `ms.unanswered_rung_dispositions_tat`, `ms.mortality_review_cadence`, `ms.privileging_tat` (existing).

**Ward in-charge (card 23)** — `ward.handover_doctor_completion`, `ward.escalations_false_alarm_rate` (nurse-side quality, diagnostic).

**KRAs by grade** (bundle): JR — notes, first response, execution of rounds orders, logbook; SR — supervision, rung-2, handover integrity, duty report, consults first-response, MLC documentation; RMO — floor continuity nights, verbal-order countersign, death declaration; Consultant — ownership, rounds, signatures (summary, MCCD, high-risk), reachability, teaching, mortality review; HOD — coverage approvals, ladder rung 4, roster sign-off; MS — governance.

**Owner's 8 a.m. digest (department slice):** census by unit; admissions/discharges/deaths overnight; S1 escalations count, p90 ack, unanswered rungs (named rung, not named person unless repeated); coverage gaps and how resolved; handovers incomplete at T+20; notes overdue count; countersigns overdue (narcotics separately); consults breaching SLA; deaths certified within target (y/n each, masked); MLCs intimated; discharge-by-11 share; doctor hours violations; attribution disputes open. Weekly: reachability per consultant (load-shown), mortality review closure, logbook verification rate.

---

## 9. AI agents & the copilot — where inference earns its place

Rule: deterministic automation first; inference only where text must be produced. Clinical cap T2. All under the 12a harness (identity, kill switch, heartbeat, mode/backfill gates, provenance, action budgets — deferred note 14).

| # | Name | Kind | Tier | Trigger / inputs | Output | Human sign-off | Fail-open path | Kill scope | Provenance | Eval/guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Round List Generator** | automation | T0 | 06:30 + on demand; census, links, pending results, overnight escalations, danger flags, discharge intents | ordered per-unit list (sick-first, then new, then discharge-ready) | none (a list) | doctor opens bed board | per unit | n/a | idempotent; ordering rule tested | health data, in-system | Plan 21 |
| 2 | **Deterioration Alert Router** | automation | T1 | `vitals.danger_flagged`, `result.critical_flagged`, `alarm.escalated`, NEWS2/qSOFA thresholds computed deterministically from charted vitals | S1/S2 escalation instance via §3.2; nudge on worklist for trend crossings | doctor decides | nurse calls ladder manually | per unit type | n/a | no model; thresholds as definition data; alarm-fatigue metric watched | health | Plan 21 (thresholds with nursing module) |
| 3 | **Pending-Results Chaser** | automation | T1 | orders with no result past expected TAT; results published but not `result.acknowledged` within 2 h | worklist items to resident of record; handover sheet section | doctor acknowledges | handover sheet lists manually | per unit | n/a | dedupe; batch to digest unless critical | health | Plan 21 |
| 4 | **Consult-Request Router** | automation | T3 (assignment is non-clinical) | `consult.requested`; on-call chain, named-consultant preference, load | `consult.routed` to holder; re-route on decline | requester may override | requester picks manually | hospital | n/a | round-robin fairness test; I6 deviation metric | health + staff | Plan 21 |
| 5 | **Coverage Resolver** | automation | T3 | `coverage.gap_flagged`, roster snapshot, privileges, rest rules | proposed cover plan (pure function) | DM approves | DM assigns manually | hospital | n/a | never violates rest/privilege rules (fixtures) | staff | Plan 20 |
| 6 | **Handover-Sheet Drafter** | agent (LLM) | T2 | at T-30 min; fact sheet from Context Lens `ipd-ward` pack (tokenised): status lines, pending results, tasks, if-then from prior sheets | structured sheet with narrative status lines citing fact ids | outgoing confirms, incoming acks | deterministic assembly (no narrative) | per unit | model id, prompt v, input/output hash on `handover.drafted` | narrate-never-originate; uncited claims dropped; adversarial fixtures (instruction-shaped note text) | health (tokenised out) | Plan 21 phase B (post-12a gates) |
| 7 | **Discharge Summary Drafter** | agent | T2 | fit-declared; signed notes, orders, results, meds | draft summary | consultant edits + signs | resident types from template | hospital | as §16 | §16 rules; N3/N16 fixtures | health | IPD cluster (existing roster) |
| 8 | **Duty-Report Compiler** | automation + agent | T0 tables / T2 narrative | shift end; census, events | filled report + narrative for critical events | submitter edits, reviewer signs | report from tables only | per unit | stamped | I8: deaths list is table-derived, model cannot omit | health + staff | Plan 21 |
| 9 | **Note-Timeliness Watcher** | automation | T0/T1 | policy windows vs `note.signed` | overdue flags to worklists; digest | none | — | hospital | n/a | never interrupts | staff | Plan 21 |
| 10 | **Dictation-to-Draft** (shared with adoption program) | agent (ASR + LLM structuring) | T2 | doctor's voice (on-device/in-boundary ASR where lawful), template | structured note draft | author signs | typing | per user | stamped + audio ref | scrubber; O-6 audio retention | health + voice | Plan 21 phase B |

**Presentation lanes.** *Lane 1 hand-built:* the doctor mobile worklist (escalations, my patients, countersign queue, handover ack, round mode) and the MCCD form — safety-critical, keyboard/touch tuned. *Lane 2 schema-generated worklists:* consult queue, duty reports, coverage gaps, roster validation findings, mortality review list, logbook export — generated from workflow definitions. *Lane 3 conversational copilot:* clinical roles last (copilot D1 ruling stands) — when it arrives, "what's pending on my patients?", "who covers ortho tonight?", "draft my duty report" under user ∩ agent permissions; never an order path.

**Journey Feed contributions:** per patient — `round.patient_seen`, `note.signed/cosigned`, `escalation.*`, `consult.*`, `handover.acknowledged`, `death.declared`, `mccd.certified`; per doctor — assignment, cover, reachability events.

**Prompt inputs (concrete) — Handover-Sheet Drafter:** pack `ipd-ward` v1; allowlist: bed/alias token, age band, diagnosis (coded), day-of-stay, last 24 h vitals summary (deterministic min/max), active orders (coded), pending orders with expected time, last 3 signed note headlines (scrubbed), open escalations (severity, state), code status, prior sheet's if-then (scrubbed). Output schema: per patient {status_line (≤ 200 chars, cited), watch_items[], pending[], if_then[]}; `insufficient_evidence` state allowed per patient.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-tap acknowledge** from push notification (deep link with action) — target ≤ 3 s from ring to ack; PBX IVR "press 1 to acknowledge" as the no-smartphone path.
- **Mobile worklist** ordered by severity then age; large touch targets; offline read cache of my patients (no writes offline except drafts).
- **Wristband scan opens the note** with bed/UHID/day pre-filled; QR on printed handover sheet re-opens the sheet.
- **Round mode:** swipe patient-to-patient; orders and note in one screen; "same as yesterday + changes" pattern for progress notes; problem-list-driven templates.
- **Dictation with structured draft** (Hindi/English); scribe session for senior consultants (S10 §12.24).
- **Countersign queue** batched with diffs highlighted (what the resident wrote vs template) so a consultant reviews, not rubber-stamps; second factor once per session window (config, e.g., 15 min) for signature-class acts.
- **TAT clocks visible**: escalation age, note-overdue age, consult SLA, MCCD chain clock on the unit board.
- **Printed daily on-call sheet at 20:00 and 08:00** (QR verified) — the downtime and PBX artefact.
- **Targets:** S1 ack p90 ≤ 5 min; handover 100% acknowledged by T+20; notes signed ≤ 4 h of round; verbal-order countersign ≤ 4 h (≤ 1 h narcotics); consult ack stat ≤ 30 min; MCCD ≤ 2 h day / 4 h night; discharge intent day-before ≥ 70%; roster published ≥ 7 days ahead; zero unresolved coverage gaps at shift start; escalation resolution API ≤ 100 ms interactive (§15).
- **Auditability:** every rung evented with resolved user list; every signature with second-factor ref, device; every draft with provenance; point-in-time "who was on duty" query.

---

## 11. Integrations, devices & dependencies

- **HR SaaS** (e.g., greytHR, Keka, Darwinbox): attendance punch export (CSV/API) → mirror table; leave approvals → `doctor_leave.scheduled` import; employee master sync. Edge-service rule: import jobs are worker jobs with idempotency keys; never write back to HR.
- **IP-PBX** (Grandstream/Yeastar class, bought §9): click-to-call via AMI/REST where available; IVR ack ("press 1") posts to the alerts API via a small edge adapter; DTMF ack maps to user by extension + PIN. Fallback: numbers displayed.
- **Push/WhatsApp/SMS** via the existing notifications gateway (Plan 10 channels); staff numbers verified.
- **Ward tablets + PIN switching** (existing UX law); optional Bluetooth barcode; wristband printers (IPD).
- **Biometric attendance devices** stay HR's; the HMIS never integrates them directly.
- **ABDM**: discharge summary/death record as care-context via existing gateway; nothing new here.
- **NBEMS logbook**: export only (M3). **Registrar (CRS portal)**: Form 2 manual filing with our PDF; no API assumed.
- **Protocols:** FHIR for documents; internal events; no HL7 in this module (telemetry stays ICU's).
- **Dependencies:** Plan 13 registry (units/beds; `duty_station` kind) · Plan 20 roster substrate (this doc) · IPD nursing module (danger flags, nursing handover, eMAR) · formulary safety engine (verbal-order path) · order modules 16–18 (countersign hooks; consult as order type) · ED module (MLC register, brought-dead) · MRD module (death register, Form 2) · 12a harness (agents) · HR-evidence bridge (credentials). Events consumed: `roster.published`, `patient.admitted/.transferred/.discharged/.deceased`, `vitals.danger_flagged`, `result.critical_flagged/.published`, `order.placed`, `prescription.issued`, `verbal_order.recorded`, `doctor_leave.scheduled`, `doctor.changed`, `credential.blocked`, `disaster.declared/.ended`, `downtime.declared/.ended`, `dnr.recorded`, `mlc.registered`, `code.activated`, `exit.completed`, `temp_role.granted/.expired`.

---

## 12. Buy vs build, hardware & rough INR budget

**Build:** roster substrate (Plan 20) — no Indian SaaS gives publication gates tied to our RBAC/ladders; duty-doctors module (Plan 21) — core. **Buy:** HR/payroll SaaS (₹40–100/employee/month → ₹6–15 L/yr at 1,200 staff); PBX (already budgeted §13); ASR for dictation (per-minute API or on-prem Whisper-class model on the stage-3 server; ₹0.5–2 L/yr API or GPU line ₹2–4 L one-time — inference locus decision governs); LLM inference under DPA (12a budget). **Do not build:** attendance devices, e-logbook portal, CRS filing.

**Hardware (this module's marginal ask):** doctor mobile devices are BYOD with MDM-lite (app-level PIN, remote revoke) — ₹0 capex, or 30 hospital phones at ₹12–15k = ₹4–5 L at 610 beds; ward station tablets already in IPD budget; on-call sheet printers exist. **Rough total:** ₹8–20 L/yr recurring (HR SaaS + ASR/LLM) + ≤ ₹5 L capex.

---

## 13. Owner rulings needed

- **O-1 Cross-cover fee attribution.** Default: cover consultant earns round-visit fees for visits actually performed; admission/procedure attribution stays with primary unless `doctor.changed`. Why: matches corporate practice, evidence-based, no dispute machinery needed for the common case.
- **O-2 Signing matrix for narcotics/high-alert.** Default: SR+ with second factor; JR blocked; consultant countersign ≤ 1 h for high-alert. Why: NDPS/H1 exposure; aligns NABH MOM.
- **O-3 Resident hours policy numbers.** Default: ≤ 12 h shift + 1 h handover, ≥ 12 h post-night rest, ≤ 1 night in 3, one weekly off; validator blocks, HOD override evented. Why: NMC PGMER 2023 leaves numbers institutional; corporate teaching hospitals use this band.
- **O-4 Escalation timers and interrupt list.** Default: S1 5/5/10/10 min, interrupt only S1 and ER-routed S2 at go-live. Why: §10.3 alarm-fatigue law.
- **O-5 MCCD certifier chain.** Default: primary consultant → specialty on-call → RMO/SR with consultant telephone concurrence documented → MS; night target 4 h. Why: last-rites timing is the design target (fix 13); legal requirement is an RMP who attended.
- **O-6 Dictation audio retention.** Default: 90 days after signed note, then purge; legal hold overrides; audio never leaves the inference boundary unencrypted. Why: DPDP data minimisation vs dispute evidence.
- **O-7 Escalation records as part of the medical record for DPDP exports.** Default: include (they document care). Why: defensibility.
- **O-8 Visiting/locum consultant grant duration and privileges.** Default: `temp_role` ≤ 90 days, privileges from credential registry only, no narcotics signing unless privileged. Why: S10 §12.4 locum pool.
- **O-9 WhatsApp handover prohibition.** Default: policy bans PHI on WhatsApp once in-app handover is live; DPIA records it. Why: DPDP exposure; the in-app path must be faster (fix 35).
- **O-10 Consultant reachability consequence.** Default: 3 unreachable flags / 30 days → MS conversation; never automatic. Why: S10 non-punitive rule; governance stays human.

---

## 14. Plan sketch

**Plan 20 — Duty roster & on-duty substrate (kernel-adjacent; fulfils §11.19-E fix 7).** Tasks: T1 tables (`roster_periods/slots/findings`, `oncall_chains`, punch mirror) · T2 validation gates (coverage, SoD, witness, rest/statutes, bundling matrix) as definition data · T3 publication workflow + events · T4 `resolveDoctor`/`usersOnDutyForRole` replacing the static seam in `kernel/workflow/roles.ts` (feature-flagged; fallback to static when no roster published) · T5 HR SaaS import job + activity-attendance report · T6 OPD availability migration (`opd_doctor_*` → roster; Plan 13 named seam) · T7 Coverage Resolver (pure function) + DM approval · T8 printed on-call sheets. Gate: Plan 13 shipped; HR SaaS chosen. Must be true before authoring: owner confirms O-3, HR SaaS export format sampled.

**Plan 21 — Doctors on duty: escalation, handover, rounds, verification, consults, reporting.** Tasks: T1 tables §4 + workflow definitions §3.2–3.7 · T2 escalation ladder engine over Plan 08.5 alerts (ack/delegate/resolve API, PBX IVR adapter, dedupe) · T3 doctor handover · T4 rounds + notes + co-sign + signing rules + verbal-order lifecycle hooks into order modules · T5 consults as order type + router · T6 duty report compiler · T7 automations 1–5, 9 · T8 mobile worklist (Lane 1) + Lane-2 worklists · T9 KPI metric registration · T10 paper kit (forms, backfill screens, downtime tests) · T11 perf/scale test (L2/L4). Gate: Plan 20 + IPD nursing module (danger flags) at least in flight; ladder definitions owner-activated (§10.4).

**Plan 21b — Death, MCCD, MLC & mortality review (could fold into MRD/ED plans).** Tasks: declaration + certification chain, MCCD validator, MLC checks and intimation tasks, Form 2 clock, mortality review scheduling, body-release interlock. Gate: MRD module table ownership agreed; electronic-register legality opinion (E-21) covers MCCD.

**Plan 21c — Inference phase (post-12a gates):** Handover-Sheet Drafter, Duty-Report narrative, Dictation-to-Draft; `ipd-ward` Lens pack.

**Sequencing:** 13 → 20 (alongside Track A 14/15) → 21 with IPD cluster (a) → 21b with ED/MRD → 21c after 12a gates. Roster substrate earlier is defensible because the mini-OT (15) already needs anesthetist on-call resolution (§11.16-A staffing line).

**Negative-space question — what absence is a signal here?** A ward with *zero* escalations on a night shift while census and acuity are normal (nurses not calling, or the ladder unreachable); a consultant with active inpatients and zero `round.patient_seen` for 24 h; a death with no mortality review scheduled; a shift with no `duty.checked_in` on a published slot; a consult routed but never acknowledged; a resident with zero notes in a 12-h shift; a night with no verbal orders on a 40-bed ward (they happened, but were not recorded). Each is a T0 watcher row.

**Staff edge-case interview questions (for HOD medicine, SR, RMO, matron):**
1. When the consultant does not pick up at night, what do you actually do, and how long before you call someone else?
2. How are shift swaps agreed today, and who knows about them?
3. What does your handover sheet look like right now — show me last night's.
4. Which orders do nurses take verbally most often, and when are they countersigned?
5. Who declares death at 03:00 here, and who signs the certificate by morning? How often is the family waiting?
6. When was the last time a patient had no doctor "assigned" after a transfer?
7. Which consults take longest to be answered, and why?
8. How do JRs log procedures for DNB — who verifies?
9. After a night, when is the next duty? Who checks?
10. What do you report at morning meeting, and from where do you get the numbers?
11. How do you handle a police constable at the ward at night?
12. What do you do when the tablet or Wi-Fi is dead on the ward?
13. Which escalations are "false alarms" and would you want them to still ring you?
14. How do visiting consultants sign anything today?

---

## 15. Open questions & risks

- **Roster ownership wording drift:** §11.12 (HMIS consumes the on-duty picture from HR) vs S10 §12.15 (HMIS is roster SoR). This document follows S10 v1.1 (later, explicit); the brief's phrasing "consumed from HR SaaS" is read as attendance/leave consumption. Confirm at Plan 20 authoring.
- **Kernel seam:** `usersHoldingRole` static resolution is what every existing ladder uses; replacing it with roster-resolution must be flag-gated with a fallback, and every existing escalation test re-run against both modes.
- **PBX IVR acknowledgement** depends on vendor capability (§19 PBX vendor undecided); until then, ack is app-only and PBX is notify-only.
- **NMC duty-hour numbers** are not fixed in statute; institutional policy (O-3) must be defensible to NMC/NBEMS inspectors.
- **Electronic MCCD**: whether an electronically signed Form 4 is accepted by the local Registrar without wet signature — covered by the E-21 electronic-register legality opinion; until then, print + sign + scan is the path.
- **Inference locus / DPIA** gates every T2 agent here; phase 21c cannot start before 12a gates; the deterministic assembly must be good enough on its own.
- **WhatsApp shadow channel** will persist as long as the in-app path is slower; the risk is behavioural, mitigated by speed levers (§10) and policy (O-9), not by software alone.
- **Alarm fatigue calibration** needs 90 days of ramp baselines before the Workflow Tuner is allowed to propose timer changes; until then, timers are owner-set.
- **Dual-primary consultants and problem-tagged routing (N9)** need a problem-list model that the clinical-records spec (deferred note 16) has not yet fixed.
- **Fee-split legal review** (referral payee classes, §11.19-C fix 1) applies to visiting consultants' consult fees — confirm class (a) treatment before Plan 21 posts consult fees for visiting RMPs.
