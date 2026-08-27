# 15 — Operation Theatres, Anaesthesia, Recovery/PACU, CSSD & the Mini-OT Day-Care Unit — Brainstorm & Planning

Date: 2026-08-27 · Status: **Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED** · Series: Department Brainstorm & Planning (doc 15 of the 2026-08-27 series) · Author: planning agent, against spec v4.8, S10 v1.3, copilot design 2026-08-25, roadmap 2026-08-11 (as amended 2026-08-26), Plan 13.

**Executive summary.** This document plans the surgical spine of the hospital: the OT list and its gates, the WHO checklist as workflow states, the anaesthesia and operative records, PACU/recovery scoring, the instrument-set sterility lifecycle (CSSD), consignment implants, and the day-care journey — first at one-theatre scale (**Plan 15, the mini-OT beside the OPD floor: gynae + ortho day-care, two recovery bays, an adjacent autoclave, MTP and PCPNDT machinery**), then unchanged in law at nine-theatre scale (the major suite lands with the IPD cluster, §17 item 4b). It is NOT: a blood-bank module (it consumes one), a PACS, an equipment-AMC module (it consumes biomedical task events), an IPD admission module (overnight conversion crosses a documented boundary until IPD ships), or an anaesthesia-machine driver (edge services own devices). **Three hardest problems:** (1) making "no wheel-in past an open gate" true in software without ever stranding a bleeding patient — gates that are hard for elective cases and *overridable-with-evidence* for emergencies, in the same definition; (2) proving sterility per instrument set per case with a BI-per-load recall that reaches into a list already running — traceability that is one query, not a binder; (3) the money composition of a surgical case — theatre minutes, two fees, scanned consumables, consignment implants at min(tariff, MRP, ceiling), packages with overrun projection and TPA pre-auth deviations — reconciled per case so the leakage triangle closes at the granularity where leakage actually happens.

---

## 1. Frame — what exists, what is locked, what this document adds

**Built (Phase 1):** kernel (events outbox, workflow engine + versioned definitions, approvals, RBAC actor fabric incl. agent identities, scheduler/worker, ops modes/downtime kit), patients (guardianship model per §11.19-D-31 is Phase 1), tariff/GST + PricingContext, OPD encounters (the consult's procedure-advice branch is where a day-care booking will originate), billing counter, notifications gateway, memberships/coupons/accrual, formulary + prescribing safety, global search, user admin. **Plan 13 resource registry in flight** (T1 shipped: `resources` + `resource_status_history`; ten kinds `floor|ward|hall|room|bed|theatre|store|bench|analyzer|device`).

**Locked decisions inherited (not re-litigated here):**
- §11.9 — booking request → per-theatre board → **hard pre-op gates** (PAC + ASA, consents, site marking, NPO, blood confirmed, ICU bed if planned) → **WHO checklist as workflow states** (Sign-in → Time-out → Sign-out) → **count mismatch = hard stop + X-ray + auto incident** → timestamps wheel-in/induction/incision/closure/wheel-out → implants scanned by batch/serial → **specimen auto-creates histopath order** → PACU scoring-to-threshold → turnover task + CSSD cycle. Exceptions: on-day cancellation reason-coded with billing reversal; implant unavailable → evented postpone; lost specimen = grave incident; anaesthesia complication → ICU + incident.
- §11.16 — 9 theatres day one (6 elective + 3 ED emergency in permanent insert mode); OT list published previous evening synchronises wards/CSSD/blood bank/stores/diet/housekeeping; pre-op holding re-verification; valuables two-staff sealed custody; OT environment as telemetry domain with **out-of-range = theatre blocked**; fumigation/microbiological surveillance failure blocks; anaesthesia workstations export data (procurement mandate) and pre-fill the record, anaesthetist validates; kits reconciled used-vs-returned per case; loaner implants 3-way matched; narcotic per-case kits with witnessed wastage; frozen-section stat loop; **loaner sets CSSD-sterilised with BI, no exceptions**; IUSS tracked; **time-out halt = near-miss register entry**; retained-foreign-body never-event path; return-to-OT flag; case-overrun cascade with NPO extension + re-review; power/AHU failure rule; intra-op death → MLC check + theatre held; SSI register per case; night activation via roster-resolved on-call.
- §11.16-A — mini-OT owner facts (one theatre, gynae + ortho day-care, two recovery bays, adjacent autoclave, ortho consignment implants); case-selection criteria = Class-B definition data; mini-OT list previous evening; gates incl. **escort verified** and **payment/deposit clearance**; implant scan-on-use = consignment event (charge + sticker + vendor liability), min(tariff, MRP, ceiling), §31(7) six-month clock per lot, 3-way match; recovery bay scoring-to-threshold; same-day discharge = map 11's lighter cascade; **missed follow-up = recall task**; MTP register `termination.recorded` sealed class, **approved-place certificate is a §19 gate**; PCPNDT Form-F gate on any USG on a woman of reproductive age, **registration is a §19 gate**; MLC check for ortho trauma; CSSD-lite runs §11.10's set cycle with **BI per load, BI fail = whole load auto-recalled**; autoclave down/no valid set = postpone; **overnight conversion = `daycare.converted_to_admission` + documented handoff to the incumbent system under E-11's boundary map**; new events named.
- §11.10 CSSD: dirty → decontamination → checklist assembly → sterilisation batch → sterile store → issue; `cssd.load_sterilized / cssd.bi_failed / cssd.set_recalled`. CSSD sterile store is a stock location.
- §11.19-A cath-lab consignment pattern generalised by Plan 14 (consignment ledger); §11.19-C-3 regulated-price rule; §11.19-C-5 sealed statutory class (MTP/PCPNDT/HIV); §11.19-C-6 Form-F widened; §11.19-D-7 ownership dimension on stock locations; §11.19-E-4 treating-team carve-out; §11.19-E-9 blood-refusal directive satisfies the blood-reserve gate.
- Plan 13 rulings (2026-08-26): **instrument sets are NOT a registry kind** — a CSSD table with FK to the autoclave `device`; `class` is a nullable code on bed/room, tariff link keyed by class code lands with IPD; master-data change control is its own later phase; containment (bed under theatre) is legal.
- S10 cards 12 Surgeon, 13 Anaesthetist, 22 OT Nurse, 28 CSSD Technician, 37 Quality Manager, 38 Infection Control Nurse, 39 Medical Superintendent; SoD: scrub vs circulating during counts; narcotic issuer vs witness.
- §16: clinical actions cap at T2–T3; automation over inference when a rule suffices; fail-open; provenance stamps.
- Copilot design §2.3: `ot-briefing` pack is a declared stub landing with its module; **the mini-OT briefing is the second real pack and is what freezes the pack contract**.

**What this document adds:** the workflow definitions with states/SLAs/ladders at row level; the data model (incl. statutory registers as tables); the money composition of a case; 100+ edge rows; chaos walkthroughs; KPI formulas; the agent/automation roster for OT; the Plan 15 → Plan 2x split.

**Scope boundaries (who owns which table):** `patients` (registration) · `encounters` incl. the new `daycare` type (OPD module owns OPD encounters; the day-care encounter is proposed to live in the OT module's schema, see §4 — **O-2**) · `resources` (kernel registry: theatre, recovery beds, autoclave device, consignment store) · consignment ledger & item master (Plan 14 procurement) · charges/invoices (billing) · blood units & cross-match (blood-bank module, future; until then a manual-path register the OT module records against) · histopath orders (LIMS Plan 17; until then `order.placed order_type=procedure_specimen` with the manual chain) · Form-F register (shared with radiology Plan 18; **first live instantiation is here**) · incidents (quality pack; until built, `incident.reported` event + OT-owned near-miss register table) · biomedical AMC/calibration (future; consumed as tasks).

---

## 2. Actors, roles & role cards

| Role | S10 card | Station / shift | Notes |
|---|---|---|---|
| Surgeon (operating consultant) | 12 | Submits booking, owns list slot, signs op-note, time-out lead | Visiting panel; fee-split §7; attribution per case |
| Anaesthetist | 13 | PAC clinic (days ahead), pre-op holding review, induction, intra-op record, PACU handover | Roster-resolved on-call for mini-OT; co-owner of WHO states |
| OT in-charge / OT sister | **new card 40 (proposed)** | Sequences the list, publishes, re-sequences, owns theatre blocks/clears, staffs tables | Reports to OT head/MS; day shift + on-call |
| OT nurse (scrub / circulating) | 22 | Counts (two-person, SoD-distinct), kit scan-out, implant scan, specimen labelling | Per-table pair; scrub ≠ circulating during counts (hard) |
| Anaesthesia technician | **new card 41 (proposed)** | Machine check-out, drug tray, monitor connection, narcotic kit custody (with witness) | Never the narcotic witness for their own issue |
| CSSD technician | 28 | Decontam → assembly → load → BI read → release → issue; recall execution | Mini-OT: one duty per list day; major suite: 24×7 |
| Recovery / PACU nurse | **new card 42 (proposed)** | Aldrete/PADSS scoring, post-op orders, discharge readiness, escort verification | Day-care: two bays, one nurse; may bundle with circulating nurse only when no case is running (roster rule) |
| Pre-op / day-care coordinator | **new card 43 (proposed)** — may bundle with OPD desk at day one | Readiness chasing (PAC, consent, deposit, escort, NPO call), check-in, family status display | The "pre-op readiness chaser" T1 automation absorbs most of the chasing |
| Pathologist (frozen section) | S10 diagnostics | Minutes-scale stat loop | Consumed, not owned |
| Blood bank technician | S10 diagnostics | Reserve/cross-match/issue | Consumed |
| Porter / patient transport | S10 ops | Ward→holding→theatre→PACU→ward tasks (P5) | Consumed |
| Housekeeping (OT turnover) | S10 ops | Between-case clean, terminal clean, fumigation task | Plan 19 fabric |
| Biomedical engineer | S10 ops (future AMC module) | Diathermy/laparoscopy tower/C-arm/anaesthesia workstation checks; PM calendar | Consumed via tasks |
| Infection Control Nurse | 38 | SSI surveillance (30/90-day), microbiological surveillance, fumigation validation | Owns SSI register reads |
| Quality Manager | 37 | Near-miss register, count-mismatch incidents, never-events, NABH OT indicators | |
| Medical Superintendent | 39 | MLC oversight, death-on-table review, privileging (who may operate what), attribution disputes | Two-key on clinical definitions |
| RMO (gynae) — second opinion for MTP > 12 wks | S10 doctors | MTP Act s.3(2)(b): two RMP opinions for 12–20 wks (24 wks for specified categories, 2021 amendment) | Opinion count is MTP configuration |
| Vendor representative (implant/loaner) | external, logged | Presence `vendor_rep.logged`; never touches records | Visitor pass |
| Observer / trainee | external/internal, logged | Attribution: never the operating surgeon of record | Photography consent scope |
| Duty manager | S10 | Night bundling authority; disaster switch co-signer | |

**Agents & automations (all first-class actors, §16 guardrails):** Pre-op Readiness Chaser (automation, T1) · Instrument-Set Expiry & BI Watchman (automation, T1 — an Expiry Watchman scope) · Turnover Dispatcher link (automation, T4 for housekeeping tasks only) · OT List Optimiser (agent, T2 draft) · Op-Note Drafter (agent, T2) · Anaesthesia Record Pre-filler (automation from device feed, T2-validated) · Overrun Cascade (automation, T1/T3) · SSI Cluster Flagger (automation, T0) · OT Leakage Auditor scope (automation, T0) · Consignment Ageing Watch (automation, T1, Plan 14's) · Digest Writer OT section (agent, T0). Details in §9.

**Shifts & bundling (mini-OT day one):** one list day = OT sister + circulating nurse + roster-resolved anaesthetist + CSSD duty + recovery nurse (may be the circulating nurse *after* the last incision, roster validates). **SoD hard pairs (RBAC-enforced, `sod.violation_blocked`):** scrub/circulating during counts · narcotic issuer/witness · time-out lead ≠ the person recording it as the only participant (two distinct actor IDs minimum) · BI reader ≠ load releaser when the BI is positive (recall must be executed by a second actor) · implant scanner ≠ consignment reconciliation approver · cancellation reason entry ≠ refund approver.

---

## 3. Core flows as workflow definitions

All definitions are versioned data (§10.2); activation via approvals to the owner (§10.4). SLAs recorded from day one; **active alerting proposed only for**: open gate < 60 min to slot, count mismatch, BI fail, theatre blocked with a case in holding, PACU threshold not reached at 2× expected (alarm-fatigue rule §10.3).

### 3.1 WF-OT-CASE — surgical case lifecycle (P1 overlay on P2; the coordination artifact)

```
requested → (criteria check) → listed → published → readiness_open → ready
   → in_holding → signed_in → timed_out → incision → closing → signed_out
   → in_recovery → recovery_ready → discharged | converted_to_admission | transferred | deceased
side exits: cancelled_onday(reason) · postponed(reason) · pre_empted · returned_to_ot
```

| State | Entry role | SLA (mini-OT default) | Escalation ladder |
|---|---|---|---|
| requested | surgeon (OPD consult procedure-advice branch) → `daycare.booked` / `ot.booked` | criteria check synchronous; outside-criteria → `case.routed_major` NEW | — |
| listed | OT in-charge sequences; anaesthesia reviews | list published by 18:00 previous day (`ot_list.published`) | 17:00 nudge in-charge → 18:30 OT head → 19:00 MS |
| readiness_open | coordinator; gates open in parallel (see 3.2) | all gates green by T-60 min (elective), T-0 (emergency w/ override) | T-24h chaser → T-2h in-charge → T-60 surgeon+anaesthetist |
| in_holding | porter + holding nurse: identity/site/consent re-verified (`holding.verified` NEW) | < 30 min in holding | overrun cascade |
| signed_in / timed_out / signed_out | anaesthetist + circulating (sign-in), surgeon-led (time-out), circulating (sign-out) | time-out ≤ 5 min after wheel-in | `timeout.halted` → near-miss register |
| incision → closing | scrub/circulating counts; implant scans; specimen dispatch | projected duration; overrun at +25% → cascade | ward NPO notify; next-case re-review |
| in_recovery | recovery nurse scores (Aldrete ≥ 9 / PADSS ≥ 9, definition data) | scoring q15 min ×4 then q30; ready target ≤ 2 h (day-care) | 2× expected → anaesthetist; 4 h → conversion decision forced |
| recovery_ready → discharged | post-op orders acknowledged; escort verified; bill settled/deposit adjusted; follow-up booked | out < 60 min from ready | coordinator → in-charge |

Events (existing): ot.booked · pac.cleared · consent.recorded · ot.signin_completed · ot.timeout_completed · ot.signout_completed · count.mismatch_flagged · implant.recorded · specimen.dispatched · ot.cancelled_onday · recovery.scored · surgery.started · surgery.completed · ot_list.published · ot_list.resequenced · valuables.sealed/returned · timeout.halted · return_to_ot.flagged · npo.extended · theatre.blocked/cleared · daycare.booked/checked_in · escort.verified · daycare.discharge_ready/discharged/converted_to_admission · consignment.deployed · frozen_section.resulted · iuss.performed · form_f.recorded · termination.recorded · mlc.registered · incident.reported. **NEW proposed:** case.routed_major · holding.verified · gate.opened / gate.closed (typed payload gate_kind) · gate.overridden (emergency, with evidence + two actors) · case.overrun_projected · case.postponed · anaesthesia.induced · anaesthesia.event_recorded · anaesthesia.record_signed · opnote.drafted · opnote.signed · count.completed · count.reconciled · xray.retained_body_check_resulted · pacu.discharge_criteria_met · postop.orders_issued · death.on_table_recorded · observer.logged · photography.consented · theatre_env.out_of_range · theatre_env.restored · fumigation.completed · surveillance.failed · case.pre_empted · surgeon.late_flagged · frozen_section.requested.

**Corporate variants covered by the same definition:** emergency insert (states skip `listed/published`, gates evaluated with override lane); pre-emption (running list re-sequenced, `case.pre_empted` reason=emergency); two-stage/bilateral procedures (two case rows, one encounter); combined-specialty (two surgeons of record, attribution split ruled per fee-split contract); local-anaesthesia minor procedure in mini-OT (sign-in with "no anaesthetist" variant only for procedures on the LA whitelist — definition data).

### 3.2 WF-OT-GATES — pre-op readiness (parallel sub-instances; a gate is a child workflow, not a boolean)

Gate kinds (each `gate.opened → satisfied | waived | overridden`): **PAC** (anaesthetist, ASA grade, valid N days — default 30 for ASA I–II, 7 for III+, re-check if any new complaint) · **Consents** (surgical, anaesthesia, high-risk where flagged, blood/transfusion or refusal directive, photography/video, MTP Form C + opinion Form I where applicable, sterilisation consent per Government of India FP standards where applicable, guardian path per D-31, POCSO intimation flag) · **Site marking** (surgeon, side-bearing procedures only; laterality in payload must equal booking) · **NPO** (ward/coordinator confirms time-of-last-intake; recomputed if slot moves — `npo.extended`) · **Blood** (reserve confirmed or refusal directive on file or "not required" per procedure class) · **Implant availability** (consignment stock scan of the exact size/lot reserved; loaner set received + BI-passed) · **Sterile set** (a valid released set of the procedure's set-type is issued to the theatre) · **Payment/deposit** (self-pay: deposit ≥ quote%; TPA: pre-auth sanction object present; PMJAY: pre-auth; corporate: credit letter) · **Escort** (day-care: named responsible adult with phone; verified at check-in *and* at discharge) · **Statutory** (MTP: approved-place cert valid + opinions count + Form C; PCPNDT: Form-F where a USG is part of the procedure; MLC: registered or explicitly ruled-out for trauma) · **Bed/ICU** (major suite only) · **Theatre fit** (environment in range, surveillance valid, fumigation not overdue, equipment PM not overdue — auto-gate from registry status).

**Emergency override lane:** any gate except *identity* and *consent-or-two-doctor-emergency-consent* may be overridden by surgeon + anaesthetist (two distinct actors, both second-factor) with reason code; `gate.overridden` is an incident-class event surfaced in the weekly digest. A day-care unit never gets the override lane for statutory gates (MTP/PCPNDT) — they are non-overridable by definition data.

### 3.3 WF-OT-LIST — the daily list (P5 task-and-track with a calendar overlay)

`draft → sequenced → anaesthesia_reviewed → published → running → closed`. Publishing fans out `ot_list.published` → CSSD demand view (sets by set-type per case), consignment store pick list, blood-bank reserve list, ward/coordinator NPO schedule per patient (computed backwards from slot: solids 6 h / clear fluids 2 h, definition data), family display tokens, housekeeping turnover tasks pre-created. Re-sequencing (`ot_list.resequenced`) recomputes NPO per affected patient and notifies affected surgeons/wards. Late insert after publish requires in-charge + anaesthetist accept; emergency insert bypasses to `running` with `case.pre_empted` on displaced cases.

### 3.4 WF-CSSD-SET — instrument set sterility lifecycle (P3 request-to-issue, asset-level)

```
in_use → dirty(returned) → decontaminated → assembled(checklist, count, indicator placed)
   → packed(label: set_id, load?, expiry) → loaded(load_id) → sterilized(cycle log ok)
   → quarantined_pending_BI (if BI policy = hold) | released(load released) → in_sterile_store
   → issued(case_id) → opened(in theatre) → in_use
side: recalled(load BI fail / cycle fail / wet pack / expiry) → dirty ; retired ; loaner(received→…→returned)
```

| State | Role | SLA | Notes |
|---|---|---|---|
| dirty → decontaminated | CSSD tech | < 60 min from theatre return (bioburden) | pre-clean at point of use logged by circulating nurse |
| assembled | CSSD tech | instrument count vs set master; missing instrument → set incomplete, cannot pack | count mismatch here is a *different* mismatch from the OT count; both feed instrument-tracking |
| loaded/sterilized | CSSD tech | cycle log captured from autoclave (edge service or manual param entry: temp/pressure/time, Bowie-Dick daily, chemical indicator class 5 per pack) | `cssd.load_sterilized` |
| BI read | CSSD tech (reader ≠ releaser on positive) | rapid BI 1–3 h (default policy: **implant loads held until BI negative; non-implant loads released on chemical indicators + parametric, BI retrospective**, corporate standard, configurable — O-6) | `cssd.bi_failed` → auto `cssd.set_recalled` for every set in load, incl. issued/opened |
| issued | CSSD tech against list | before previous-evening list close for next day | issue requires `status=released` and `expiry > case date` |

Events: cssd.load_sterilized · cssd.bi_failed · cssd.set_recalled · loaner_set.received/returned · iuss.performed · **NEW:** cssd.set_assembled · cssd.set_issued · cssd.set_opened · cssd.set_returned · cssd.load_released · cssd.load_held · cssd.bowie_dick_recorded · cssd.set_expired · cssd.instrument_missing_flagged · cssd.set_retired · autoclave.cycle_failed · cssd.outsourced_dispatched / .received (ETO) · cssd.wet_pack_flagged.

### 3.5 WF-ANAESTHESIA-RECORD — from PAC to PACU handover

`pac_scheduled → pac_done(ASA, plan, risk flags) → machine_checked → induced → maintained (events: drugs, fluids, vitals from monitor q1–5 min, airway events, blood, positioning) → reversed/emerged → handed_over(PACU) → record_signed`. Device feed pre-fills vitals/agents (edge service; MQTT → Timescale like ICU §11.15, **never the core DB**); the record the anaesthetist signs is a snapshot with provenance; unsigned record at case close +2 h → nudge → OT head at +24 h. Narcotics: per-case kit issued under NDPS double-lock with witness and second factor (§11.8, §14); every ampoule accounted: given / wasted-witnessed / returned; running balance on the OT narcotic register table.

### 3.6 WF-PACU — recovery scoring to threshold

Aldrete (major suite/GA), PADSS or modified Aldrete + fast-track criteria (day-care) — the score set and threshold are **definition data per case class**. `admitted → scored(n) → criteria_met → handed_over(ward) | discharge_ready(day-care) → escalated(complication) | converted`. Post-op orders (analgesia, antiemetic, wound care, DVT, antibiotics per SSI bundle) issued by surgeon/anaesthetist before `criteria_met` can be accepted; unsigned orders block discharge, not care.

### 3.7 WF-OT-TURNOVER (P5) and WF-THEATRE-STATUS (registry)

Sign-out → housekeeping task auto-created (Turnover Dispatcher) → cleaned → verified (in-charge or checklist scan) → theatre `available`. Theatre resource statuses (Plan 13 manifest declaration by the OT module): `available | reserved | in_use | turnover | blocked_env | blocked_surveillance | blocked_equipment | blocked_incident | out_of_service`. Blocked states are set by automations from telemetry/surveillance/incident events and cleared only by in-charge with evidence (`theatre.cleared` carries the clearing check reference).

### 3.8 WF-IMPLANT-CASE — consignment/loaner per case (P3 + P4 hooks into Plan 14)

`reserved(size range) → picked → scanned_on_use(consignment.deployed: charge + sticker + vendor liability) → 3-way match (challan/usage/invoice) → settled` · unused opened → `return_or_charge` decision evented · explant path (revision surgery) → `implant.explanted` NEW with retained-device custody (returned to patient / sent for analysis / BMW) · recall (vendor/CDSCO) → query by UDI/lot → patient contact task via Recall agent.

---

## 4. Data model sketch (module `ot`; own schema; FHIR-shaped JSONB where clinical)

**Owned tables (sketch):**
- `ot_cases` — id, encounter_id, patient_id, theatre_resource_id, list_id, slot_seq, procedure_code(s) (SNOMED/ICD-10-PCS-style local code), laterality/site, surgeon_id, assistants[], anaesthetist_id, anaesthesia_type, case_class (elective/emergency/day-care), asa_grade, projected_min, timestamps {wheel_in, induction, incision, closure, wheel_out}, wound_class, workflow_instance_id, package_id?, payer_tag, outcome_refs (decision→outcome linkage, deferred note 6).
- `ot_lists` — date, theatre, version, published_at, published_by, status; `ot_list_items` — case, seq, planned_start, planned_min, resequence_reason.
- `ot_gates` — case_id, gate_kind, state, satisfied_by, evidence_ref (consent doc id, PAC id, deposit invoice id, escort id…), waived/overridden_by[2], reason_code.
- `consents` — encounter, type (surgical/anaesthesia/high-risk/blood/refusal-directive/photo/MTP-C/sterilisation-FP/research), language, signer (patient|guardian|two-doctor-emergency), witness, interpreter?, document_id (scanned/e-signed PDF, QR), valid_until, revoked_at. (FHIR `Consent`.)
- `pac_assessments` — FHIR `ClinicalImpression`-shaped: airway, ASA, comorbidities, meds to hold, plan, valid_until, fit/unfit/conditional.
- `who_checklist_runs` — case, phase (signin/timeout/signout), items JSONB (each: answered_by, at, value), participants[], halted?, halt_reason.
- `ot_counts` — case, round (initial/pre-closure-cavity/final), item_type, expected, counted, by_scrub, by_circulating, status, xray_ref, incident_id.
- `case_implants` — case, item_id, UDI/serial/lot/expiry, sticker_image_ref, ownership (owned/consignment/loaner), consignment_lot_id (Plan 14 FK by id, no cross-schema constraint), charge_id, explanted_at, recall_ref.
- `case_specimens` — case, label barcode, type, container/fixative, collected_at, dispatched_at, received_by (lab), histopath_order_id, frozen_section?, chain events.
- `anaesthesia_records` — case, FHIR `Procedure` + `Observation` bundle JSONB (vitals snapshot at signed time; live series stays in Timescale), drugs (FHIR `MedicationAdministration`), events, signed_by/at, provenance (device ids, prefill hash).
- `ot_narcotic_register` — append-only: case, drug, ampoule count issued, given (mg), wasted (mg, witness), returned, issuer, witness, second-factor ref, balance. (Statutory-shaped, NDPS.)
- `operative_notes` — case, structured (findings, procedure performed, implants, EBL, drains, specimens, complications, post-op plan), narrative, draft provenance (model id/prompt ver/input hash/output hash), signed_by/at, amendments (append-only).
- `pacu_scores` — case, scale, values JSONB, total, by, at; `postop_orders` — via existing prescribing + order tables (reuse; OT stores refs).
- `daycare_encounters` (or `encounters` type extension — O-2) — check-in, bay resource_id, escort {name, relation, phone, id-proof-type}, discharge criteria snapshot, conversion ref, incumbent-system handoff note id.
- `theatre_env_readings` (summary only; raw in Timescale) + `theatre_blocks` — theatre, reason, from/to, evidence, cleared_by.
- `fumigation_log`, `surveillance_samples` (site, method, result, lab ref, pass/fail) — statutory/NABH surfaces.
- `ssi_register` — case, wound class, surveillance window (30/90 d implant), assessment events, SSI classification (superficial/deep/organ-space, CDC), organism, notified_at. ICN owns writes via tasks.
- `near_miss_register`, `count_mismatch_incidents` (until quality pack ships: OT-local, migrates then).
- `mtp_register` — statutory MTP Act Form II-shaped: serial, date, patient ref (sealed class), age, gestation, opinion(s) RMP ids, indication clause (s.3(2)), method, consent form ref, outcome, follow-up; **sealed event class**, access evented, custody per Rules 2003 (admission register kept 5 years). Monthly reporting extract (Form II to CMO).
- `form_f_register` — shared table (proposed to live in a small `pcpndt` kernel-adjacent module so radiology and mini-OT share one — O-3).
- `sterilisation_consents` (FP) — GoI Standards & Quality Assurance in Sterilisation Services consent form ref, counselling, cooling-off/spousal fields as per current guideline; feeds the FP register.
- `cssd_sets` — set_id (barcode), set_type, instruments JSONB (name, qty, serial?), status, current_location, autoclave_device_id (registry FK), expiry, cycle_count, loaner?, vendor. `cssd_loads` — autoclave, cycle no., params, indicator results (Bowie-Dick, class 5, BI), released_by, held/released, outsourced? `cssd_load_sets` — load ↔ set. `cssd_recalls` — load, sets, executed_by, acknowledgements per set.
- `equipment_checks` — device resource, checklist (diathermy return-plate, laparoscopy insufflator, C-arm warm-up + dose log), by, at, pass/fail; `radiation_dose_log` (AERB) for C-arm per case: DAP/fluoro time, operator, TLD badge ref.
- `observers_log` — case, person, role (trainee/vendor rep/observer), consent scope, attribution=none.
- `ot_charge_compositions` — case, line source (theatre-min band, surgeon fee, anaesthetist fee, consumable scan, implant, package allowance) → charge ids; overrun projection snapshots.

**Registry kinds needed (Plan 13):** `theatre` (mini-OT ×1; major ×9), `bed` with class `daycare_recovery` (×2, parent = theatre or a `room` "recovery"), `device` (autoclave, anaesthesia workstation, C-arm, diathermy, laparoscopy tower — status vocab declared by OT manifest incl. `pm_overdue`), `store` (consignment store, OT sub-store, CSSD sterile store), `room` (pre-op holding, PAC clinic). **Instrument sets: not a kind (RULED)** — `cssd_sets` references the autoclave device.

**FHIR shapes:** Procedure, Consent, ClinicalImpression (PAC), Observation (PACU scores, vitals), MedicationAdministration (anaesthesia drugs), Device + DeviceUseStatement (implants, UDI), Specimen, DocumentReference (op-note PDF w/ QR).

**Retention (recommended defaults, subject to E-21 legality opinion):** OT/anaesthesia records — IPD-class 10 y (MLC: indefinite + legal-hold); MTP register — 5 y statutory minimum, sealed; Form-F — 2 y statutory minimum (PCPNDT Rules), recommend 5; CSSD load logs — 5 y (NABH traceability; implant loads for implant life); narcotic register — 2 y post last entry (NDPS Rules) recommend 5; radiation dose logs — per AERB, 5 y; SSI register — 5 y; consent documents — with the record.

**DPDP classes:** clinical (all case data) · **sealed statutory** (MTP, PCPNDT, HIV status in PAC) · financial · staff-performance-derived (KPIs — S10 D-36 protections) · biometric/none.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion · ruling ref.**

### A. Identity & wrong-patient / wrong-site

| ID | Scenario | Required behaviour | Test / assertion | Ruling |
|---|---|---|---|---|
| A1 | Two Sunita Devis on the same gynae list; porter brings the wrong one to holding | Holding verification scans wristband/QR against list item; mismatch → `holding.verified` fails, case cannot enter `signed_in`; incident auto-opened as near-miss | Fixture: scan UHID-B against case-A → transition refused, near-miss row created | — |
| A2 | Wristband missing (day-care patient came from OPD, no band printed) | Check-in prints a day-care band (UHID QR); no band → cannot `daycare.checked_in`; manual path: printed label with photo verify, `band.reprinted` reason | Check-in without band id → refused | — |
| A3 | Booking says left knee; consent says right; marking on left | Gate evaluator compares laterality across booking, consent, marking, PAC; any disagreement → gate `site_marking` cannot satisfy; surgeon must re-issue consent or re-book | Property test: laterality triple-equality invariant | — |
| A4 | Bilateral procedure booked as unilateral to fit package | Package allowance evaluates procedure codes; a second side on the op-note without booking amendment → charge posted outside package + `package.overrun_projected`; amendment requires surgeon + billing note | Op-note laterality "bilateral" vs case "L" → flag | — |
| A5 | Patient merged (duplicate UHID) after list publication | `patient.merged` consumer rewrites case patient_id, band reprint task; list item shows "identity updated — re-verify at holding" | Merge → case follows survivor id; holding requires re-verify | — |
| A6 | Unconscious ortho trauma, unknown identity (ED insert) | Temporary UHID per §11.3, MLC auto-registered, two-doctor emergency consent variant; identity reconciliation later merges | Case with temp UHID + emergency consent passes gates in override lane | — |
| A7 | Twin sisters, one is the surrogate/escort of the other | Escort record is distinct person with own phone; escort ≠ patient assertion; if escort has UHID, both linked, no data cross-view | escort_id ≠ patient_id CHECK | — |
| A8 | Time-out reveals the implant reserved is for a different patient (sticker name mismatch) | Time-out item "implant matches patient & side" fails → `timeout.halted` (near-miss = success) ; case waits or postpones | Halt reason recorded; near-miss register row | — |
| A9 | Same patient booked twice on two lists (surgeon's assistant and OPD desk) | Unique (patient, date, procedure) soft-block; duplicates require in-charge merge | Second booking → warning + merge task | — |
| A10 | Specimen labelled with the previous case's label (label roll left in theatre) | Specimen label printed only in-theatre from the open case; scanning a label whose case ≠ current open theatre case → refuse dispatch | Dispatch with foreign label → error | — |

### B. Timing, concurrency, races

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| B1 | Case 2 starts while case 1 is still `signed_out` but theatre in `turnover` | Theatre resource must be `available`; sign-in transition checks registry status atomically; concurrent attempts serialize on theatre row | Two sign-ins racing → exactly one succeeds | — |
| B2 | Overrun +40% on case 1; case 3 patient NPO since 06:00 now at 14:00 | `case.overrun_projected` at +25% → cascade: re-sequence, `npo.extended`, ward gets clear-fluids-until time, anaesthetist re-review task; at 8 h NPO → dehydration risk flag (definition data) | Overrun event triggers 3 downstream tasks within 1 min | — |
| B3 | Emergency LSCS pre-empts mini-OT? (mini-OT is day-care only) | Mini-OT criteria exclude obstetric emergencies; `case.routed_major`/ER transfer; major suite: `case.pre_empted` on displaced elective with reschedule priority | Attempt to insert LSCS into mini-OT → refused with reason | — |
| B4 | Two circulating nurses record the final count concurrently on two tablets | Count round is a single row with optimistic version; second write conflicts, must re-read | Concurrent writes → one 409 | — |
| B5 | Clocks: anaesthesia workstation clock 12 min behind server | Edge service stamps `occurred_at` from device and `recorded_at` from server; drift > 2 min → device flagged in registry (`clock_drift`) and record shows both | Drift fixture → flag + dual timestamps | — |
| B6 | List published, then surgeon adds a case at 22:00 | Late insert state; CSSD demand delta pushed; if no released set of that type exists by 06:00 → automatic `case.postponed reason=no_sterile_set` unless IUSS approved by in-charge (`iuss.performed` tracked) | Late insert w/o set → postponed at 06:00 job | — |
| B7 | PACU scoring timer fires at q15 min but nurse is with the other bay | Missed scoring is an SLA record, not a block; 2 consecutive misses → nudge; discharge requires ≥ 2 scores meeting threshold 30 min apart | Threshold with one score → not ready | — |
| B8 | Surgeon marks incision before time-out completed (tablet lag) | Timestamps are state transitions; `incision` unreachable from `signed_in` without `timed_out`; backfill allowed only via override with reason | Transition matrix test | — |
| B9 | Blood reserve auto-release at 48 h fires during a case delayed to day 3 | Reserve renewal task at 40 h to coordinator; if case still listed, auto-extend once with event; release only when case cancelled/postponed beyond window | Extension logic fixture | — |
| B10 | Midnight rollover: case wheels in 23:50, closes 00:40 — which list/day? | Case belongs to its list date; KPIs use wheel-in; billing theatre minutes span midnight without split; tariff version pinned at case start | Cross-midnight case counted once | — |
| B11 | Recovery bay 2 freed and re-assigned while previous patient still physically there (nurse forgot discharge) | Bay assignment requires previous occupant `discharged`/`converted`; registry `already_occupied` error | Assign on occupied → ResourceError | — |
| B12 | Frozen section result arrives after the surgeon has closed (delayed pathologist) | `frozen_section.resulted` after `closing` → surgeon alerted; op-note must acknowledge; TAT breach recorded against path SLA; if margin positive → return-to-OT decision workflow | Late result → acknowledgement task | — |

### C. Partial failure & downtime

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| C1 | Server down mid-case | Paper WHO checklist + count sheet + anaesthesia chart (drilled A1 kit, printed per case with list); on restore, backfill entry with `occurred_at` from paper; case cannot be closed in system without the three checklist phases backfilled | Backfill fixture: sign-in occurred_at < recorded_at, all phases present | — |
| C2 | Server down before list publication | Yesterday's draft printable at any time; PBX call-tree; publish on restore with `published_at` backfilled; CSSD works from printed demand | Print endpoint works from draft state | — |
| C3 | Autoclave edge service dead, autoclave working | Manual cycle parameter entry with printout photo; load still requires BI; `cssd.load_sterilized` actor=user with `manual_entry=true` | Load without edge feed → allowed with manual params | — |
| C4 | Monitor feed lost mid-case | Anaesthetist records vitals manually q5 min (tablet or paper); record shows gap marked "device offline"; no silent interpolation | Gap rendered as UNAVAILABLE, never blank (copilot law 6) | — |
| C5 | Network fine, WhatsApp gateway down — family status ping fails | `notification.failed`; family display in waiting area (LAN) still shows token status; retry ladder | Failed notification → display unaffected | — |
| C6 | Registry (kernel) call fails when setting theatre `in_use` | Human path never blocked by an automation; but *status* set is part of the transition transaction — DB down means downtime mode anyway; partial: registry error → transition fails loudly, in-charge uses downtime declaration | Error surfaces; no half-state | — |
| C7 | Power failure mid-laparoscopy; UPS 20 min | Theatre `blocked_env` auto after power event; open case completes on bridge power (rule §11.16); next cases held; electrical check evidence needed to clear | Block auto-set; clear requires evidence ref | — |
| C8 | Printer for specimen labels dead | Handwritten label with UHID + case id + two-person verify, `specimen.dispatched` with `label_manual=true`, incident-lite flag; lab receipt scans case QR from requisition | Manual label path evented | — |
| C9 | Agent runtime halted globally (global halt) | Readiness chaser stops; coordinator worklist shows the same open gates (worklist is deterministic query, not agent output) | Halt → worklist unchanged | — |
| C10 | Downtime declared for OPD floor only (floor-scoped) | Mini-OT is on the OPD floor: inherits floor degradation; case in progress continues on paper; check-ins queue | Floor-scope test | — |
| C11 | Backfill of a cancelled case after downtime, deposit already refunded on paper | Cancellation backfilled with reason; refund voucher backfilled against downtime cash register; SoD downtime declarer ≠ reconciler | Backfill refund links to downtime session | — |

### D. Money — billing, packages, TPA, refunds

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| D1 | Theatre time bands: case runs 95 min, tariff band 0–60/61–120 | Theatre charge from actual wheel-in→wheel-out (or incision→closure — definition choice, **O-4**), posted at sign-out via `charge.posted`; manual edit impossible, correction = credit note | Charge = f(timestamps) golden fixture | O-4 |
| D2 | Package (e.g. ₹45,000 lap chole day-care) with implant not included | Package allowance lines vs actuals; implants outside package post as separate charges with "outside package" flag surfaced to counter before discharge; `package.overrun_projected` at 80% | Overrun projection fixture | — |
| D3 | TPA pre-auth sanctioned ₹60,000; actual composition ₹78,000 | `preauth.deviation_flagged` at projection; enhancement request task (Claims Drafter later); no discharge gate on it — financial counselling task instead | Deviation event on projection cross | — |
| D4 | Cancelled on the day after kit opened and set issued | Opened-kit `return_or_charge` decision: unopened items returned to store (credit), opened consumables charged to patient only if cancellation reason is patient-attributable (NPO violated, absconded) else cost center "OT cancellation"; set goes back as dirty | Reason code → charge target matrix test | O-5 |
| D5 | Patient paid deposit ₹20,000, case postponed 2 weeks | Deposit stays as liability against encounter; no refund unless requested; refund via credit note + voucher, identity check | Deposit carried across postpone | — |
| D6 | Surgeon fee split: two surgeons of record | Fee-split rule per consultant contract; attribution captured at booking, confirmed at sign-out; dispute → `attribution.disputed` → MS | Split accrual on `payment.received` | — |
| D7 | Anaesthetist fee when case converted from LA to GA mid-way | Fee derived from anaesthesia record's final type; change evented `anaesthesia.type_changed` NEW | Charge recomputed from record | — |
| D8 | Consignment implant scanned, then explanted same case (wrong size) and second scanned | First lot: `return_or_charge` — damaged/opened → vendor liability per agreement (charge to vendor cost centre, not patient); second charged | Two deployments, one patient charge | O-7 |
| D9 | Implant MRP on sticker < tariff | min(tariff, MRP, ceiling) applies; invoice line records which won | Pricing fixture | §11.19-C-3 |
| D10 | PMJAY package: implant included but hospital used a costlier brand | Charge to patient blocked (PMJAY no-balance-billing rule); difference to cost centre "PMJAY package absorption" with approval | Absorption approval path | — |
| D11 | Payer switch mid-episode (TPA denies at discharge) | §11.4 map 3 counselling + consent; lines re-attributed by payer period; deposit ladder starts | `payer.switched` fixture | — |
| D12 | Consumables scanned out of OT sub-store but patient's case never opened (case cancelled before wheel-in) | Leakage triangle per case: issued ≠ billed → return task within 24 h or cost centre | Triangle variance row | — |
| D13 | Free camp case (charity) in mini-OT | Zero-tariff adjustment rule with reason, still full composition recorded for cost; implants still consignment-settled to hospital cost centre | Charity case has cost, no receivable | — |
| D14 | Overrun projection when second case of the day is a 50% package member | Projection uses membership benefit engine (Plan 09) once; best-single-benefit | Contest recorded | — |
| D15 | Cash > ₹2 lakh settlement for a self-pay ortho case | §269ST hard block; PAN/Form-60 above line; NEFT/UPI counselling | Cash-law layer fixture | §11.19-C-2 |
| D16 | Section 31(7) six-month clock on a consignment lot nearing expiry unused | `consignment.aging_flagged` → return-to-vendor task or deemed-supply invoice per CA | Aging job fixture | Plan 14 |

### E. Consent, legal, MLC, minors, unconscious, statutory

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| E1 | 16-year-old for MTP, accompanied by aunt | MTP Act s.3(4)(a): guardian consent required for minor; guardian entity with authority scope `consents` (D-31); POCSO mandatory reporting flag (age < 18 pregnancy) → `pocso.intimated` task to MS, sealed channel | Minor MTP without guardian consent → gate blocked; POCSO task created | — |
| E2 | Married woman's husband demands to sign her MTP consent | Only the woman's consent is required (s.3(4)(b)); husband's signature not a field; counselling note; if coerced → social-work referral | Consent form has no spouse field | — |
| E3 | MTP at 21 weeks | Two-RMP opinion rule (20–24 wks only for categories under Rules 2021); Medical Board beyond 24 wks; configuration blocks booking outside limits; opinion count check before gate | Gestation 21 wks, one opinion → blocked | — |
| E4 | Facility's MTP approved-place certificate expired | §19 gate is a config with expiry; procedure class `mtp` unbookable; digest shows 60-day warning (Expiry Watchman) | Expired cert → booking refused | RULED (§11.16-A) |
| E5 | Ortho trauma from road accident, patient says "no police" | MLC check is mandatory for RTA; `mlc.registered` before procedure (delay-only if life-threatening, evented); patient refusal doesn't waive hospital duty | Trauma without MLC decision → gate open | §11.14 |
| E6 | Unconscious patient, no relative, needs emergency surgery | Two-doctor emergency consent variant (§11.3), evented; identity temp; consent later re-taken if patient regains capacity | Emergency consent object passes gate | — |
| E7 | Patient literate only in Bhojpuri; consent form in Hindi | Consent captures language + interpreter/witness; audio-visual consent record allowed (video with consent) stored as DocumentReference; form printed in Hindi with pictorial; staff attestation of explanation | Consent without language field → invalid | — |
| E8 | Patient revokes consent in holding ("I'm scared") | `consent.revoked` NEW; case → `cancelled_onday reason=patient_withdrew`; no charge for theatre; counselling task; reschedule priority normal | Revocation → cancel path | — |
| E9 | Sterilisation (tubectomy) in day-care under FP programme | GoI sterilisation consent form (standards 2014/2020 update), age/marital eligibility checks as config, counselling checklist, FP register entry, compensation scheme fields; failure/complication reporting pathway | FP consent form type present | — |
| E10 | Photography for a teaching case | Separate photography/video consent with scope (internal/teaching/publication); images stored de-identified; observers logged | Photo without consent scope → upload refused | — |
| E11 | Death on table | `death.on_table_recorded` → MLC check (if MLC → theatre held, police intimation task, body not moved without MLC clearance), MS notified, incident opened, mortuary task, family communication script, records legal-hold | Death event → 6 tasks + legal hold | — |
| E12 | Retained sponge discovered on day-3 X-ray | Never-event: incident (sentinel), disclosure task to family, reoperation case linked `return_to_ot.flagged reason=retained_body`, counts of original case frozen and attached | Linkage assertion | — |
| E13 | Jehovah's Witness refuses blood | Blood-refusal directive satisfies blood gate with bloodless plan documented (§11.19-E-9); transfusion chain checks flag | Directive → gate satisfied | — |
| E14 | Prisoner/police-custody patient | Escort is the police officer (custody variant), MLC likely, restricted-visibility flag, no WhatsApp pings | Custody escort type | — |
| E15 | Adolescent (17) wants ortho procedure without parents knowing | Guardian consent mandatory for surgery (< 18); adolescent-confidentiality flag doesn't override surgical consent law | Minor without guardian → blocked | — |
| E16 | Form-F for a pelvic USG done in the mini-OT before MTP | Form-F gate applies (any USG on woman of reproductive age, §11.19-C-6); machine + sonologist must be registered config | Scan without Form-F → cannot close, wheel-in blocked | RULED |
| E17 | Sealed MTP record — billing counter needs to bill it | Billing sees a procedure code alias ("gynae day-care procedure") not the MTP fact; treating-team carve-out (E-4) for clinicians only; access evented | Counter view excludes indication | §11.19-C-5 |
| E18 | Court/police demands OT records | MLC document release discipline: single spokesperson, `document.release_logged`, certified copy with QR | Release event mandatory | — |
| E19 | Organ/tissue retrieval request in OT | Out of scope; refer to THOTA committee protocol (deferred §11.14) — system refuses `procedure_class=organ_retrieval` until protocol exists | Class absent | — |

### F. Staff absence, overload, handover

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| F1 | Surgeon 45 min late for first case | `surgeon.late_flagged` at slot +15 min (in-charge nudge), +30 (surgeon + OT head), list re-sequenced; first-case on-time KPI records reason attribution (surgeon/anaesthesia/patient/theatre) | Late flag + attribution | — |
| F2 | Surgeon no-show (didn't inform) | At +60 min: cancellation with reason `surgeon_no_show`, patient counselled, reschedule priority high, no patient charge; digest entry | Reason → charge target none | — |
| F3 | Roster-resolved anaesthetist unreachable at 07:00 | Coverage Resolver (T3, IPD roster) later; now: on-call ladder via roster seam → second anaesthetist → OT head; no case induces without an assigned anaesthetist actor | Sign-in requires anaesthetist_id present and on duty | — |
| F4 | Only one nurse available: scrub and circulating same person | Count requires two distinct actors; `sod.violation_blocked`; remote-video witness last resort (S10 §11) | Same actor both counts → blocked | — |
| F5 | CSSD tech on leave; OT sister runs the autoclave | Role temp-grant (`temp_role.granted`) with expiry; BI read by her, release by in-charge (SoD) | Temp role fixture | — |
| F6 | Recovery nurse doing bay 1 and bay 2 while circulating for case 3 | Roster validation refuses bundling while a case is `incision`; the overrun cascade recomputes | Bundle rule test | — |
| F7 | Handover PACU → ward (major) or → escort (day-care) | Structured handover checklist (ISBAR) with acknowledgment event; discharge summary + wound-care instructions in patient language; missed follow-up → recall task | Handover ack required for `discharged` | — |
| F8 | Night emergency in major suite; on-call team activation | Roster-resolved on-call chain; activation timer (call → arrival) recorded as KPI | Activation events | — |
| F9 | Surgeon operating beyond privileges (not credentialed for lap procedures) | Privileging table (MS, card 39) checked at booking; outside privilege → booking refused or MS approval | Privilege fixture | O-8 |
| F10 | Trainee performs under supervision | Observer/assistant logged; surgeon of record = supervising consultant; op-note names operator + supervisor; attribution to consultant | Attribution field test | — |

### G. Equipment failure

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| G1 | Diathermy return-plate alarm at incision | Equipment check item pre-incision; failure → swap device, `equipment_checks` fail row, biomedical task | Check row + task | — |
| G2 | Laparoscopy tower camera fails mid-case | Convert to open — `procedure.converted` NEW (affects package, consent must have covered conversion — checked at consent gate as "conversion consent" item) | Conversion → charge + consent flag | — |
| G3 | C-arm warm-up failure; ortho case needs imaging | Theatre `blocked_equipment` for C-arm-dependent procedures only (device-level status); case postponed or moved | Device status gating per procedure needs | — |
| G4 | C-arm used: dose log missing | AERB: dose/fluoro time per case mandatory; sign-out cannot complete for C-arm cases without dose log | Sign-out blocked | — |
| G5 | Anaesthesia workstation failed self-test | Machine-check state fails; no induction; backup machine or postpone | `machine_checked` required before `induced` | — |
| G6 | Autoclave chamber leak — cycle aborts | `autoclave.cycle_failed`; all sets in load back to `dirty`; device `out_of_service`; outsourced sterilisation path or postpone | Cycle fail → set statuses | — |
| G7 | Bowie-Dick test failed this morning | Autoclave blocked for wrapped loads until repeat pass; loads today → outsourced or IUSS (tracked) | BD fail → device status | — |
| G8 | Suction failure with bleeding | Manual suction; incident; equipment PM overdue flag if applicable — biomedical AMC dependency | Incident row | — |
| G9 | OT AHU down, humidity 75% | `theatre_env.out_of_range` → `blocked_env`; open case continues (rule); clearance needs reading in range for 30 min + in-charge | Telemetry → block | — |
| G10 | Monitor calibration overdue | Registry device `pm_overdue`; not a block (alarm fatigue); shows on theatre-fit gate as warning; 30 d overdue → block (config) | Warning vs block thresholds | — |

### H. Data quality, late-arriving, backdated

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| H1 | Anaesthetist signs record 3 days later | Allowed; unsigned SLA breaches recorded; signing after 24 h requires reason; record shows signed_at vs occurred_at | Reason mandatory after 24 h | — |
| H2 | Op-note amended after discharge | Append-only amendment with reason; original preserved; discharge summary regenerated with amendment marker | Amendment row + version | — |
| H3 | Implant sticker photo blurry; OCR failed | Manual UDI/lot entry with second-person verify; sticker image still stored | Manual entry requires verifier | — |
| H4 | Backdated BI result entered after sets already issued | BI result `occurred_at` earlier; if positive → recall covers issued/opened/used sets; used-on-patient → clinical notification task to surgeons + ICN | Recall reaches used sets | — |
| H5 | Wound class changed post-op | SSI risk index recomputed; register updated with history | History row | — |
| H6 | Surgeon writes "as discussed" in consent | Consent requires procedure code + risk template version; free text alone invalid | Validation | — |
| H7 | PAC done at another hospital (paper) | Uploaded as document; local anaesthetist "accepts" → PAC gate satisfied with source=external | External PAC accepted path | — |
| H8 | Counts recorded as "correct" but no count rows | Sign-out requires count rows with expected/counted per item type; "correct" is derived, not typed | Derived status only | — |
| H9 | NPO time typed as 08:00 for a 08:30 case (typo) | NPO gate computes; < 6 h solids → not satisfied; nurse re-enters with reason | Compute-not-trust | — |
| H10 | Duplicate `consignment.deployed` from double scan | Idempotency on (case, UDI/serial); second scan → "already deployed" | Dedup | — |
| H11 | Recovery score entered for the wrong bay | Score row keyed by case, entered from bay context; bay ≠ case's bay → warning, not block | Warning fixture | — |

### I. Fraud, leakage, gaming

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| I1 | Implant billed to patient but consignment vendor never invoiced (sold outside) | 3-way match per case; usage without vendor invoice at 30 d → `consignment.mismatch`; Leakage Auditor row | Triangle fixture | — |
| I2 | Vendor rep brings a non-sterilised loaner set "already sterile" | Loaner must pass CSSD load with BI; no `cssd.set_issued` → sterile-set gate fails | Loaner without load → gate open | RULED §11.16 |
| I3 | Surgeon takes patient to his own nursing home after booking here (steering) | `ot.cancelled_onday` reasons cluster per surgeon; Fraud Sentinel diagnostic; not punitive | Cluster report | — |
| I4 | Theatre minutes inflated by editing wheel-out | Timestamps are transitions; no edit; correction = reason + second actor + credit note | Immutability test | — |
| I5 | Narcotic ampoule "wasted" without witness | Wastage requires witness actor + second factor; balance mismatch → NDPS incident | Witness required | — |
| I6 | Consumables scanned to patient that were never used (kit padding) | Used-vs-returned reconciliation per kit; return rate per surgeon/nurse pattern → Leakage Auditor | Variance rows | — |
| I7 | Ghost case to generate fee-split accrual | Accrual only on `payment.received` for real invoice tied to a case with checklist events; Fraud Sentinel: cases without WHO events | Guard query | — |
| I8 | Discount on surgeon fee applied by the surgeon's assistant | Discount governance caps/approvals; SoD requester ≠ approver | Approval path | — |
| I9 | Cancellation reason coded "patient unfit" to avoid surgeon-late KPI | Reason requires anaesthetist co-sign for clinical reasons; attribution pattern audit | Co-sign rule | — |
| I10 | Same instrument set scanned as issued to two cases same day | Set status `issued` is exclusive; second issue refused unless returned/reprocessed | Exclusive status | — |
| I11 | Old sterile pack relabelled with new expiry | Expiry derives from load date + policy (event-related sterility / time-related); label reprint creates event; mismatch label vs load → refuse issue | Expiry derived | — |
| I12 | Package absorption used to hide implant sale | Absorption requires approval + reason; monthly absorption report to owner | Report exists | — |

### J. Privacy, sealed records, VIP, staff-as-patient

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| J1 | Staff nurse's own MTP in the mini-OT | Confidential + sealed; alias on list/display; access beyond treating team evented; HR never sees | Alias on all surfaces | — |
| J2 | VIP politician ortho day-care | VIP flag → alias token on family display, no WhatsApp ping to non-verified numbers, restricted record | Display alias | — |
| J3 | Family display shows patient name | Display shows token + status only (§14) | Snapshot test | — |
| J4 | Observer from a device company photographs the screen | Observer log + photography consent scope; policy notice; incident if reported | Log exists | — |
| J5 | Ops Copilot asked "how many MTPs last month" by a billing clerk | Sealed-class: permission-filtered answer "not visible to your role"; query itself logged | Copilot permission test | — |
| J6 | DPDP erasure request for OT records | Bounded by retention law; MLC/legal-hold override; DSR register response | DSR fixture | §11.14 |
| J7 | HIV-positive status in PAC needed by scrub team | Treating-team carve-out shows "standard precautions — sealed flag present" without diagnosis text to non-clinical roles | Carve-out render | E-4 |

### K. Language, literacy, accessibility

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| K1 | Escort cannot read discharge instructions | Pictorial + voice note (WhatsApp audio) in patient language; teach-back checkbox by nurse | Instruction doc has pictogram variant | — |
| K2 | Deaf patient consent | Sign-language interpreter/relative recorded as interpreter; video consent | Interpreter field | — |
| K3 | Family display in Hindi/English toggle | Bilingual display; tokens numeric | — | — |
| K4 | Thumb-impression consent | Witness two-person + photo; fully valid | Thumb path | — |
| K5 | Post-op call via IVR for non-smartphone escort | Recall agent uses voice channel (Plan 10 gateway) | Channel fallback | — |

### L. Scale (100/day → 2,000/day; 1 → 10 theatres)

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| L1 | 10 theatres, 40 cases/day, telemetry per second | Telemetry in Timescale, core stores summaries; board query < 300 ms | Perf budget test | — |
| L2 | CSSD 400 sets/day | Set/load tables indexed by status/location; recall query = one join | Query plan test | — |
| L3 | Emergency theatres in permanent insert mode | List definition variant `emergency_board` without publish state | Definition variant | — |
| L4 | OT list optimiser across 6 elective theatres | T2 draft only; in-charge accepts | — | — |
| L5 | 3 mini-OT-like satellite units (endoscopy, cath) reuse definitions | Same workflow definitions parameterised by unit; registry parent | Reuse test | — |

### M. Integration failures (device / vendor / ABDM / lab / blood bank)

| ID | Scenario | Required behaviour | Test | Ruling |
|---|---|---|---|---|
| M1 | Histopath is outsourced (no LIMS yet) | `specimen.dispatched` with courier + external lab; `sample.external_resulted` path; chain complete on paper + scan | External chain | — |
| M2 | Blood bank on legacy system | Manual reserve register entry with blood-bank tech sign; gate evidence = register row; boundary map (E-11) | Manual evidence accepted | — |
| M3 | ABDM care-context for a day-care encounter | Encounter type `daycare` serialises to FHIR Encounter class=AMB; sealed MTP never linked without explicit consent | Serialisation test | — |
| M4 | Consignment vendor API for stock (if any) — offline | Ledger is ours (Plan 14); vendor feed advisory only | — | — |
| M5 | Anaesthesia workstation vendor export in proprietary CSV | Edge service adapter; parametric fallback; procurement mandate for HL7/CSV export | Adapter contract | §11.16 |
| M6 | Autoclave has no data port (older Indian units) | Manual param entry path with printout photo — first-class, not exception | Manual path test | — |
| M7 | Telemetry sensor stuck (constant reading) | Flatline detector → sensor fault flag, manual log task, theatre not blocked on fault alone (fail-safe vs fail-open decision: **block if no reading > 2 h** — O-9) | Flatline fixture | O-9 |

**Row count: 111.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday, BI positive at 09:40 with the list running.** 07:00 loads 3–5 from Saturday evening released on parametric + chemical indicators (non-implant policy); 08:00 case 1 (D&C) done with set S-12 (load 4); 09:10 case 2 (arthroscopy, implant-free) opened S-31 (load 5); 09:40 CSSD tech reads rapid BI for load 4: **positive**. System: `cssd.bi_failed(load 4)` → automatic `cssd.set_recalled` for S-10…S-14 with each set's current status: S-12 *used on case 1* (patient A), S-11 *issued to case 3 (in holding)*, S-10/13/14 *in sterile store*. Humans: circulating nurse for case 3 gets a red banner "set recalled — do not open"; in-charge gets the recall worklist; ICN gets a clinical-notification task for patient A (surgeon informed, surveillance window upgraded, documented disclosure per policy). Case 3 → `case.postponed reason=set_recalled` unless a released alternative set exists (query shows S-40 same type, load 6, BI negative) → re-kit, 25 min delay, `ot_list.resequenced`. Agents: Expiry/BI Watchman already flagged that load 4's BI had not been read by 09:00 (T1 nudge at 08:30 — the near-miss). Paper: none needed. Audit: causation chain `cssd.bi_failed → cssd.set_recalled ×5 → case.postponed → ot_list.resequenced → task.created(ICN)`; digest shows "1 BI failure, 1 patient exposed, 1 case delayed 25 min". Policy question surfaced: implant-load hold vs all-load hold (O-6).

**6.2 Server down at 11:20 during a lap tubectomy.** 11:20 WebSocket dies; tablets show "offline". Circulating nurse pulls the per-case downtime pack printed with the list (pre-filled WHO sheet, count sheet, anaesthesia chart, implant sticker sheet, specimen label with pre-printed case QR). Anaesthetist charts by hand. 11:55 closure; counts on paper, both signatures. 12:10 server back; nurse backfills sign-out, counts, timestamps (occurred_at from paper). The transition matrix accepts backfill only in order (time-out before incision). Billing: theatre minutes posted from backfilled timestamps with `backfilled=true`; day-close reconciliation lists backfilled cases for in-charge review. Case 4 (scheduled 12:00) held in ward — coordinator used the PBX. Audit shows `downtime.declared(floor=OPD)` … `downtime.ended`, and each backfilled event's `recorded_at − occurred_at` gap.

**6.3 Anaesthetist no-show + surgeon late + deposit short — same morning.** 07:30 chaser had flagged case 1's deposit at 60% at T-24h; family arrives with cash ₹15,000 short. 07:45 roster-resolved anaesthetist not answering; on-call ladder escalates to second; 08:05 second accepts. 08:20 surgeon late (`surgeon.late_flagged`). In-charge re-sequences: case 2 (LA, no anaesthetist needed, deposit clear) first. Deposit: counter offers UPI; family pays 08:40; gate satisfied. Case 1 wheels in 09:30. First-case on-time attributes: surgeon (late) + payment (short) + anaesthesia (coverage) — three attributions on one case, each a separate reason row so no one KPI blames the other role. Digest: "first case 70 min late; coverage resolved in 20 min".

**6.4 Death on table in ortho trauma (MLC).** 15:10 cardiac arrest during a femur nailing on an RTA patient (MLC registered at ED). Code Blue; 15:50 declared. System: `death.on_table_recorded` → MLC branch: theatre `blocked_incident`, body stays until police intimation task acknowledged, all devices' logs frozen (anaesthesia record auto-snapshot, monitor series exported), legal hold on encounter, MS + duty manager paged, family communication script to surgeon, incident (sentinel) opened, mortuary task with body-tag double verify, narcotic kit reconciled with witness before leaving theatre. Remaining list moved to tomorrow (`case.postponed reason=theatre_held`), patients and CSSD notified. Audit: complete minute-level event trail available to the MS review and police; consent, PAC, time-out records shown with signers.

**6.5 Power + AHU failure at 13:00, one case open, two in holding, UPS 20 min.** Telemetry: pressure differential drops → `theatre_env.out_of_range` → `blocked_env`. Rule: open case completes on bridge power (surgeon informed of remaining UPS minutes on the board); two holding patients held, NPO extended, families told via display. Generator up 13:06; AHU restarts; clearance requires 30 min in-range readings + in-charge evidence. 13:50 cleared; anaesthetist re-reviews holding patients (NPO now 9 h — IV fluids ordered). Audit: block/clear evidence references the telemetry window.

**6.6 Fraud + VIP + PCPNDT inspector in one hour.** 10:00 District PCPNDT inspector walks in unannounced: demands Form-F register for the last quarter, machine registration, sonologist list. System: Form-F register export (one query), registration certificates from config with expiry, each USG with its `form_f.recorded` event; a scan without Form-F cannot exist by construction. 10:20 VIP ortho patient arrives: alias on display; the inspector's presence logged as visitor; no names on any public surface. 10:40 Leakage Auditor's morning row: implant deployed in case 27 last week has no vendor challan; store keeper claims "rep will bring it"; 3-way match holds the vendor payment; Fraud Sentinel diagnostic notes this vendor's pattern (3 cases). Owner sees all three in the 8 a.m. digest next day.

**6.7 Mass-casualty (bus accident) while the mini-OT has a gynae list.** Disaster mode declared (§11.3); mini-OT criteria exclude polytrauma but the ED requests it for two minor debridements. Duty manager approves a *temporary criteria widening* (Class-B definition, emergency activation evented `governance.emergency_activated`); elective gynae cases postponed with reason `disaster`; consignment store opens for ortho small fragments; CSSD switches to IUSS for basic sets (tracked). Post-event: every IUSS row and every override in the review pack.

---

## 7. Compliance, audit & statutory surfaces

| Statute / standard | Surface in this module | Table / register | Signer / custodian | Retention |
|---|---|---|---|---|
| MTP Act 1971 (amended 2021) + Rules/Regulations 2003/2021 | Approved place cert (§19 gate), Form C consent, Form I opinion(s), Form II monthly report, admission register | `mtp_register` (sealed) | RMP(s); custodian = head of facility; sealed | 5 y (Regs), recommend legal-hold aware |
| PCPNDT Act 1994 | Form-F per USG, machine + sonologist registration, register inspection | `form_f_register` | Sonologist; centre in-charge | 2 y min (recommend 5) |
| NDPS Act 1985 + Rules | OT narcotic register, witnessed wastage, second factor | `ot_narcotic_register` | Issuer + witness | 2 y min (recommend 5) |
| Drugs & Cosmetics Act, Medical Devices Rules 2017 | UDI/lot capture, implant recall traceability, CDSCO alerts | `case_implants` | Circulating nurse | implant life |
| AERB (Radiation Protection Rules 2004) | C-arm dose log, TLD badges, licence in config | `radiation_dose_log` | Operator | 5 y |
| BMW Rules 2016 | Sharps/anatomical waste per case incl. placenta/products of conception, explants | Plan 19 chain; OT posts `bmw.*` refs | Circulating | as per Plan 19 |
| Clinical Establishments Act + state rules | OT register, minimum standards, records | `ot_cases` extract | MS | 10 y |
| NABH (COP/MOM/HIC chapters) | WHO checklist compliance, SSI rate, count discrepancies, unplanned return-to-OT, PAC before surgery, informed-consent audit, sterilisation validation, surveillance | KPI registry + registers | QM | 5 y |
| MLC / CrPC / BNSS | MLC register link, death-on-table intimation, record release | `mlc.*` events, `document.release_logged` | MS | indefinite |
| POCSO 2012 | Mandatory reporting (minor pregnancy) | `pocso.intimated` | MS | indefinite |
| GoI FP sterilisation standards | Consent form, eligibility, FP register, compensation | `sterilisation_consents` | Surgeon + counsellor | as FP register |
| DPDP Act 2023 | Consent for processing; sealed classes; DSR; agent DPIA | access logs | DPO | per law |
| GST | Implants: HSN, MRP rule; theatre services SAC; §31(7) consignment | billing | CA | 8 y |

**What the inspector asks:** MTP: approved-place certificate, Form II last 12 months, admission register with serials, consent forms, opinion forms; PCPNDT: registration, Form-F for every scan, machine log; NABH assessor: 10 random cases end-to-end (consent → PAC → checklist → counts → implant sticker → anaesthesia record → PACU score → op-note → SSI follow-up), sterilisation validation (Bowie-Dick daily, BI per load, recall drill), surveillance results, fumigation logs, incident RCAs for count mismatch, near-miss register showing time-out halts. Every one of these is a filtered query on a table above, exportable with QR-signed PDF.

---

## 8. Staff KPI & KRA (event-derived, load-normalised, diagnostic never auto-punitive; formulas to the KPI formula registry, deferred note 5)

| Role | KPI (id) | Formula (events) | Load context | Diagnostic reading / gaming resistance |
|---|---|---|---|---|
| Surgeon | ot.first_case_on_time | wheel_in ≤ planned_start+15 for seq=1, attribution=surgeon / cases seq=1 | cases/week | Attribution split per reason row; late reason needs anaesthetist co-sign |
| Surgeon | ot.gate_compliance | cases with `gate.overridden` (non-emergency) / cases | — | Emergency overrides excluded, listed separately |
| Surgeon | ot.unplanned_return | `return_to_ot.flagged` within 30 d / cases | case-mix (procedure class) | Compared within class only |
| Surgeon | ot.ssi_rate | SSI-classified / cases under surveillance, by wound class | wound class, ASA | Surveillance completeness reported alongside; low completeness invalidates |
| Surgeon | ot.opnote_timeliness | `opnote.signed` − `surgery.completed` ≤ 24 h | cases | Drafter edit-distance is the agent's KPI, not the surgeon's |
| Anaesthetist | an.pac_before_day | `pac.cleared` date < case date / elective cases | cases | Day-of PAC allowed for emergencies, excluded |
| Anaesthetist | an.checklist_participation | sign-in + time-out participant rows containing anaesthetist / cases | — | Participant must be a distinct authenticated actor |
| Anaesthetist | an.record_completeness | records with all mandatory sections + signed ≤ 24 h / cases | cases | Device-fed vs manual shown |
| Anaesthetist | an.pacu_handover_quality | handover ack + ≥ 2 scores / cases | — | — |
| OT nurse | nurse.count_completion | cases with all count rounds by two distinct actors / cases | cases/shift | SoD-enforced; identical timestamps flagged |
| OT nurse | nurse.kit_variance | (issued − used − returned) value / issued value | cases | Per-kit; return rate patterns to Leakage Auditor |
| OT nurse | nurse.iuss_rate | `iuss.performed` / cases (↓) | list changes | Shared with CSSD |
| OT nurse | nurse.specimen_chain | specimens with dispatch+receipt ≤ 4 h / specimens | — | — |
| CSSD tech | cssd.set_tat | dirty→released median | sets/day | — |
| CSSD tech | cssd.bi_compliance | loads with BI read ≤ policy window / loads | — | 100% target; missing BI blocks release for implant loads |
| CSSD tech | cssd.recall_execution | time from `cssd.bi_failed` to all sets acknowledged | sets in load | — |
| CSSD tech | cssd.unsterile_release | issues where set expiry/status invalid (should be 0 by construction) | — | Assertion, not a metric |
| Recovery nurse | pacu.score_cadence | scores at required cadence / expected | bays occupied | — |
| Recovery nurse | pacu.discharge_lag | discharged − criteria_met median | — | Escort-wait separated as its own reason |
| Coordinator | prep.gates_green_t60 | cases all gates green at T-60 / elective cases | cases | Per-gate breakdown; chaser nudges counted |
| Coordinator | prep.same_day_cancellation | `ot.cancelled_onday` by reason / listed | — | Reason-coded; patient-attributable vs hospital-attributable split |
| OT in-charge | ot.utilisation | Σ(wheel_in→wheel_out) / available theatre minutes | theatres | Overrun and turnover reported separately |
| OT in-charge | ot.turnover_time | next wheel_in − prev wheel_out median | cases | Housekeeping vs readiness split via task events |
| OT in-charge | ot.list_publish_on_time | `ot_list.published` ≤ 18:00 | — | — |
| ICN | icn.surveillance_completeness | cases with 30/90-d assessment / cases | — | — |
| ICN | icn.env_compliance | surveillance samples pass / scheduled | theatres | Failures block — recorded |

**KRAs:** Surgeon — list runs on gates and checklists, never memory; op-note within 24 h. Anaesthetist — no induction past an open gate; every event recorded; PACU handover structured. OT nurse — nothing left inside, nothing unbilled, nothing unsterile. CSSD — every set provably sterile, every load BI'd, recall in minutes. Recovery — scored to threshold, discharged to a verified adult, instructions understood. Coordinator — green board by T-60; zero preventable same-day cancellations. In-charge — published by 18:00, utilisation honest, blocks cleared with evidence.

**Owner's 8 a.m. digest — OT section:** cases yesterday (mini-OT: n, by dept) · first-case on-time (with attribution) · same-day cancellations by reason · overruns > 25% · gate overrides (each named) · time-out halts (near-misses — celebrated) · count mismatches (0 expected) · BI failures / recalls · IUSS count · consignment mismatches / aging lots · SSI new classifications · unplanned returns · sealed-class access events count (no detail) · unsigned records > 24 h · today's list readiness at 07:00 (gates open by kind).

---

## 9. AI agents & the copilot

| Name | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill-switch scope | Provenance | Eval / guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Pre-op Readiness Chaser** | automation | T1 | `ot_list.published`; open `ot_gates` at T-24h/T-2h/T-60 | Nudges (in-app; WhatsApp to patient for NPO/escort/deposit in language) via P7 ladder | none (nudge) | Coordinator worklist is the same query | per-agent | n/a | No message to sealed-class cases via patient channel beyond neutral "appointment" wording | clinical-minimal | **Plan 15** |
| **Instrument-Set Expiry & BI Watchman** | automation | T1 | daily + on `cssd.load_sterilized`; expiry, BI unread, loaner without load | CSSD worklist rows + nudges; blocks nothing (issue rule blocks) | none | Issue-time rule | per-agent | n/a | — | none | Plan 15 |
| **Turnover Dispatcher (OT link)** | automation | T4 (ops) | `ot.signout_completed` | Housekeeping task + re-dispatch | none | In-charge creates task | per-agent | n/a | Task fabric | none | Plan 15 (task), Plan 19 (fabric) |
| **Overrun Cascade** | automation | T1→T3 | projected_end > planned +25% (from timestamps) | Re-sequence *proposal* (T3: applied on in-charge accept), NPO extension notices, re-review tasks | in-charge | manual re-sequence | per-agent | n/a | — | none | Plan 15 |
| **OT List Optimiser** | agent | T2 draft | Draft list + durations (surgeon/procedure historical medians), theatre/equipment/set availability from registry + CSSD, anaesthetist roster, blood/implant readiness | Proposed sequence with rationale per swap; never publishes | OT in-charge accepts/edits; publish is human | In-charge sequences by hand | per-agent | model id, prompt ver, input hash | Constraint checker (deterministic) validates any proposal: no proposal violates a hard constraint; shadow-score vs actual overrun | operational; tokenised patient refs | Plan 2x (major suite) — mini-OT: simple heuristic automation suffices |
| **Op-Note Drafter** | agent | T2 | Structured case data (procedure, implants, counts, EBL, specimens, timestamps, anaesthesia summary) + surgeon's dictation (Whisper via 12a choke module) | Draft operative note; every sentence cites a structured field or transcript segment | Surgeon edits + signs; edit distance is the agent's KPI | Surgeon types/dictates as today | per-agent | full stamps into `operative_notes` + event | Narrate-never-originate: no findings not in structured data/dictation; leak scrubber on dictation; citation guard | Class 1 (tokenised) | Plan 2x after 12a; optional late Plan 15 if 12a signed |
| **Anaesthesia Record Pre-filler** | automation (device feed) | T2-validated | Workstation/monitor edge feed | Pre-filled vitals/agents timeline | Anaesthetist validates & signs | Manual charting | per-device | device ids + hash | Drift/flatline detectors | clinical | Plan 2x (major); mini-OT if workstation exports |
| **Mini-OT Briefing (Lens pack `ot-briefing`)** | agent (Lens) | T2 (narration) over T0 card | Fact sheet: PAC, allergies, meds-to-hold, consents, implants reserved, NPO, prior surgeries, blood | Snapshot card (deterministic) + on-demand narration | Anaesthetist/surgeon read; nothing actioned | Card is complete product | Lens switch | per copilot spec | Four-state render; citation guard | Class 1 | Card: Plan 15; narration: post-12a |
| **SSI Cluster Flagger** | automation | T0 | SSI register + case/theatre/surgeon/set-load joins | Cluster diagnostics to ICN | ICN investigates | ICN's own report | per-agent | n/a | Rate thresholds, min denominators | clinical-aggregate | Plan 15 (simple), richer later |
| **OT Leakage Auditor scope** | automation | T0 | issued/used/returned/billed per case; consignment 3-way | Variance rows | Stores/finance | Report | shared Leakage Auditor | n/a | — | financial | Plan 15 |
| **Digest Writer — OT section** | agent | T0 | KPI registry rows above | Narrative | Owner reads | Table view | shared | stamps | numbers from registry only | aggregate | Plan 15 |
| **Recall & Follow-up (day-care scope)** | automation | T1 | `daycare.discharged` + follow-up booking; missed → recall task; implant recall notice → patient contact | Tasks + messages | Coordinator | phone list | shared | n/a | — | clinical-minimal | Plan 15 |

**Presentation lanes for OT work:** Lane 1 hand-built — **theatre board** (per-theatre timeline, gate chips, telemetry status), **case cockpit** on the theatre tablet (WHO phases, counts, implant scan, specimen, timestamps — large touch targets, one-beep QR), **CSSD bench** (scan-driven set states). Lane 2 schema-generated — PAC worklist, consent capture forms, gate evidence forms, equipment checklists, fumigation/surveillance logs, SSI follow-up worklist, consignment reconciliation, near-miss register. Lane 3 conversational — coordinator's "who is not ready for tomorrow and why?", in-charge's "move case 4 to theatre 2", CSSD "which sets from load 12 are out?" — all resolving to the same tool catalog with the asker's permissions; clinical roles last (copilot ruling D1 unrevised).

**Journey Feed contributions:** `daycare.booked` ("surgery advised — 12 Sep, Dr X"), each gate satisfied/opened (structured, patient-readable subset: "please stop eating after 02:00"), `ot.timeout_completed`, `surgery.completed` (family ping), `recovery.scored` threshold, `daycare.discharged` with instruction doc QR, follow-up due. Sealed-class cases post neutral wording only.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context:** case QR on the list printout, wristband, consent, specimen requisition, downtime pack — any scan opens the case cockpit at the right phase. Target: cockpit open < 300 ms.
- **Scan-everything in theatre:** implant sticker (barcode/GS1 UDI + photo), consumables from OT sub-store (kit barcode), instrument set (set barcode → auto-check sterility validity + expiry + BI status in one lookup), narcotic ampoules (batch). Target: implant capture < 20 s, kit reconciliation < 2 min at sign-out.
- **WHO checklist as tap-through phases with named participants (badge scan/PIN)** — no free text; halt is one large red button (near-miss = success).
- **Timestamps are buttons** (Wheel-in · Induced · Incision · Closing · Wheel-out) — billing and KPIs derive; nothing typed.
- **Gate chips on the board**, colour + reason; readiness board on the coordinator's screen and the ward tablet; T-60 red chips page.
- **Pre-filled PAC and consent** from encounter data and procedure templates (risk template version stamped); consent printable in Hindi/English with pictograms; e-sign or scan-back with QR.
- **Printed per-case downtime pack** generated with the list (drilled A1).
- **CSSD scan bench:** set label printer, one scan per state; BI reader photo capture; load release two-tap with SoD.
- **Device-fed anaesthesia record** where machines export; manual q5-min grid otherwise; voice dictation (Whisper via 12a choke module) for op-note only after 12a gates.
- **Family display + WhatsApp ping** replace the "any news?" traffic at the OT door.
- **TAT clocks:** holding wait, turnover, PACU-to-discharge, frozen-section — visible on the board, alerted selectively.
- **Measured targets (mini-OT defaults, recommended):** first-case on-time ≥ 85%; gates green at T-60 ≥ 95%; same-day cancellation (hospital-attributable) < 3%; turnover < 30 min; count completion 100%; BI compliance 100%; op-note signed ≤ 24 h ≥ 95%; PACU-ready → out < 60 min; unsigned anaesthesia records > 24 h = 0; SSI (clean) < 2%.

---

## 11. Integrations, devices & dependencies

| Item | Examples (Indian market) | Protocol / rule |
|---|---|---|
| Autoclave (steam) with cycle printout/port | Tuttnauer, Nuvo/Confident Dental, Steelco; many local units printout-only | Edge service reads RS-232/USB/CSV where available; **manual parameter path first-class**; BI readers (3M Attest) photo/manual |
| ETO / low-temp (outsourced or in-house later) | Outsourced ETO vendors in most tier-2 cities | `cssd.outsourced_dispatched/received` with vendor certificate scan; loads still tracked |
| Anaesthesia workstation + monitor | Dräger, GE, Mindray, Skanray (Indian) | HL7 v2 / vendor export → edge → MQTT → Timescale; procurement mandate: data export |
| Patient monitors (PACU) | Mindray, BPL, Skanray | Same telemetry path; PACU vitals optional day one |
| C-arm | Siemens Cios, Allengers (Indian), Skanray | Dose values manual or DICOM SR later; images to PACS (Plan 18 deferred) — mini-OT stores dose log only |
| Laparoscopy tower / diathermy | Karl Storz, Olympus, Valleylab; Indian: Nidhi Meditech | Equipment check forms; PM calendar via future AMC module |
| OT environment sensors | Local BMS/IoT (temp/RH/differential pressure), Honeywell | MQTT utility pattern; manual log task until installed |
| Label printers / scanners | Zebra/TSC; Honeywell/Zebra 2D scanners | Standard |
| Consignment vendors | Ortho implant distributors (e.g. local dealers for Depuy/Stryker/Indian makers like Sharma Ortho, GPC) | Plan 14 consignment ledger; challan capture by scan |
| Histopath | In-house lab (Plan 17) or outsourced | Order via P2; external result path |
| Blood bank | Legacy licensed operation | Manual evidence until module; boundary map |
| ABDM | Care-context per day-care encounter | FHIR Encounter/Procedure later |
| Notifications | Plan 10 gateway | WhatsApp/SMS/IVR |

**Edge-service rule:** every device speaks to an edge process (mini-PC), never to the core; core consumes events/summaries. **Dependencies:** Plan 13 (registry: theatre, beds, devices, stores) · Plan 14 (consignment ledger, item master with MRP/ceiling, OT sub-store) · Plan 09/06 (packages, PricingContext) · Plan 10 (channels) · Plan 08.5 (escalation delivery) · roster seam (Plan 03) · 12a (drafters, Lens narration) · Plan 17 (histopath) · Plan 18 (Form-F sharing; PACS) · Plan 19 (turnover/BMW fabric) · IPD cluster (admission conversion, blood bank, ICU). **Events consumed:** patient.merged · payment.received · package.* · consignment.* · roster.published · downtime.* · incident.reported · disaster.declared · sample.received/external_resulted · unit.crossmatched · task.completed (housekeeping).

---

## 12. Buy vs build, hardware & rough INR budget

**Build (module `ot` + `cssd` sub-schema):** everything in §3–§4 — workflow definitions, registers, cockpit, CSSD bench. **Buy/licence:** procedure terminology (SNOMED via NRCeS — free), risk-consent templates (own counsel-reviewed), BI/indicator consumables, telemetry sensors, label hardware, Whisper/LLM via 12a choke module. **Do not build:** PACS, AMC/CMMS (buy later), blood bank (own module later), BMS.

**Mini-OT hardware (rough, 2026):** 2 rugged tablets for theatre + recovery (₹60–80k) · 1 desktop + 2D scanner + label printer at CSSD bench (₹70k) · 2 scanners in theatre (₹15k) · family display TV + Pi (₹35k) · env sensor kit (temp/RH/ΔP) + gateway (₹40–80k) · autoclave data cable/edge mini-PC if port exists (₹25k) · BI rapid reader (if not present, ₹1.5–2.5 L) · UPS for tablets/printers (₹15k). **≈ ₹3–6 L** excluding medical equipment. Major suite (9 theatres) later: ×9 tablets/scanners, sensors per theatre, 3 CSSD benches, anaesthesia-workstation interfaces — **≈ ₹25–40 L** IT-side.

---

## 13. Owner rulings needed

- **O-1 Encounter type `daycare` ownership:** recommend the OT module owns `daycare_encounters` referencing the kernel encounter enum value (the enum was left open for this); alternative: a generic `encounters` kernel table. Default: OT-owned now, migrate when IPD lands.
- **O-2 (merged into O-1)** — kept numbered for tracking: bay `class` code `daycare_recovery` with tariff link deferred to IPD (already RULED by Plan 13 §4A-1); Plan 15 bills day-care by procedure package, not by bed class. Confirm.
- **O-3 Form-F register home:** recommend a tiny shared `pcpndt` module (register + registrations config) consumed by mini-OT now and radiology (Plan 18) later — avoids two registers.
- **O-4 Theatre-time charge basis:** recommend wheel-in→wheel-out in 30-min bands after the first 60 (corporate norm), anaesthesia time from induction→handover for the anaesthetist fee.
- **O-5 Opened-kit on same-day cancellation:** recommend charge patient only for patient-attributable reasons (NPO violation, withdrawal at holding after kit open, absconding); hospital-attributable → cost centre "OT cancellation"; both evented.
- **O-6 BI release policy:** recommend implant loads held until BI negative (rapid BI, 1–3 h); non-implant loads released on parametric + class-5 chemical indicator with retrospective BI and auto-recall. Buy a rapid BI reader.
- **O-7 Wrongly opened consignment implant liability:** per vendor agreement (counsel review in flight); recommend default "hospital cost centre unless vendor packaging defect", never the patient.
- **O-8 Privileging table go-live:** recommend a minimal privileging list per surgeon (procedure classes) approved by MS before Plan 15 activation; without it the gate is a warning only.
- **O-9 Telemetry fail-safe:** recommend block theatre if no reading for > 2 h (fault = unknown environment), warning before; manual log clears.
- **O-10 Photography/teaching policy** and observer access: recommend a written policy (consent scope enumerations) before any image capture feature ships.
- **O-11 Day-care case-selection criteria (Class B):** the procedure whitelist per dept, ASA ≤ II, age 1–70 (config), escort mandatory — owner + department heads approve before activation (already a §19 gate; the specific list needs authoring).
- **O-12 Sterilisation (FP) services:** confirm whether tubectomy/vasectomy under government FP scheme is performed; if yes, FP register + compensation fields are in Plan 15 scope.

---

## 14. Plan sketch

**Plan 15 — Mini-OT day-care (Track A, after 14):** T1 schema (cases, lists, gates, consents, PAC, checklist runs, counts, implants, specimens, anaesthesia records, op-notes, PACU scores, day-care encounters, theatre blocks, env summaries, surveillance/fumigation, SSI register, near-miss, MTP register sealed, Form-F via `pcpndt`, `cssd_*`, narcotic register, equipment checks, dose log) + registry manifest (theatre/bed/device/store statuses) · T2 workflow definitions WF-OT-CASE, WF-OT-GATES, WF-OT-LIST, WF-CSSD-SET, WF-PACU, WF-TURNOVER (+ NEW events registered in catalog) · T3 booking from OPD procedure-advice branch + criteria check + deposit quote (Plan 06/09 PricingContext) · T4 readiness: PAC, consents (with guardian/POCSO paths), gates, chaser automation, list publish fan-out, downtime pack printer · T5 theatre cockpit: WHO phases, counts + hard stop, timestamps, implant scan (Plan 14 consignment.deployed), specimen chain, narcotic kit, equipment checks, dose log · T6 CSSD bench: sets, loads, BI, release/hold, recall, issue-against-list, expiry watch, IUSS, outsourced path · T7 recovery: scoring, post-op orders, escort verify, discharge cascade (map 11), conversion event + incumbent handoff, recall follow-up · T8 money: charge composition, overrun projection, cancellation reason→charge matrix, kit reconciliation, 3-way match view, credit notes · T9 statutory: MTP register + Form C/I/II, PCPNDT Form-F gate, MLC check, sealed-class access · T10 KPIs into the formula registry + digest section; theatre board (Lane 1), Lane-2 forms, Lens `ot-briefing` card · T11 gate report: §19 mini-OT gates (MTP cert, PCPNDT reg, Class-B criteria, consignment agreements) + drills (BI recall drill, downtime drill).

**Plan 20 — Major OT suite + PACU + CSSD department** (with IPD cluster stage b): 9 theatres, emergency board mode, pre-emption, OT→ICU handover, blood-bank module link, telemetry sensors at scale, anaesthesia-workstation interfaces, OT List Optimiser (T2), Op-Note Drafter (T2, post-12a), anaesthesia pre-filler, loaner-set flows, frozen section with LIMS, fumigation/surveillance schedules, vendor-rep passes.
**Plan 21 — Biomedical equipment AMC/calibration/PM** (buy CMMS or thin module) — feeds `pm_overdue` device statuses.
**Plan 22 — Quality pack** (incident/near-miss/RCA, NABH indicators) absorbs the OT-local registers.

**Gates before authoring Plan 15:** Plan 13 T6 deployed (registry live, rooms moved) · Plan 14's consignment interface signature frozen · owner rulings O-1, O-3, O-4, O-5, O-6, O-11 · MTP/PCPNDT certificates on file (or the procedure classes ship disabled) · case-selection whitelist drafted by gynae + ortho heads · pack contract review with copilot spec (`ot-briefing` is the second pack).

**Negative-space question — what absence is a signal here?** A case with no `timeout.halted` ever across 500 cases (nobody is catching anything — checklist theatre); a surgeon with zero same-day cancellations and zero overruns (timestamps being gamed); a load with no BI row; a day with sets issued but no `cssd.set_returned` (instruments walking); a consignment lot with deployments but no invoice; an SSI register with zero entries under 90-day surveillance (surveillance not happening); a PACU with every discharge at exactly threshold-first-score (scoring by rote); no `gate.overridden` at all in emergency theatres (overrides happening off-system); an MTP register with entries but no `form_f.recorded` for the same patients (scans done unregistered).

**Staff interview questions (department heads, gynae + ortho + anaesthesia + CSSD):**
1. Which procedures do you actually do day-care today, and which have you sent home against your judgment because there was no bed?
2. What is your real NPO instruction practice — who calls the patient, and what happens when the list slips?
3. How do you decide today that a patient goes home — a score, a gut call, or the escort's availability?
4. What happens now when the autoclave BI is positive — who is told, and are used sets ever traced?
5. How do implant reps deliver — do sets arrive sterile from them, and do you re-sterilise everything?
6. Which counts do you do (sponges, needles, instruments), at which moments, and who signs?
7. When did a time-out last stop a case? What happened next?
8. How are MTP opinion forms kept today; who has the key; how is Form II filed?
9. Who does USG in the unit and is Form-F filled before or after the scan?
10. What do you do when the surgeon is late 30 minutes — who tells the family?
11. How is narcotic wastage witnessed in the theatre today?
12. Which equipment fails most often, and what is the workaround?
13. What do families ask at the OT door — what would a display need to say?
14. How many cases per month convert to overnight, and where does the patient go?

---

## 15. Open questions & risks

- **Encounter model for day-care** (O-1) touches the kernel enum; misplacing it is the "two homes for one concept" trap Plan 13 exists to avoid.
- **Plan 14 timing:** if consignment ledger slips, Plan 15 must ship implant capture against a stub ledger — decide whether the stub is acceptable or Plan 15 waits.
- **Blood-bank evidence** is manual until the module exists; the gate's evidentiary strength is a register row, and the auditor may challenge it.
- **Sealed-class + billing** interplay: aliasing MTP on invoices must survive the GST/TPA line description rules — needs CA/counsel check.
- **Legality of electronic MTP/PCPNDT/NDPS registers** (E-21 opinion) — until signed, parallel paper registers may be required; the tables must print in the statutory form layout.
- **BI reader availability** in the current autoclave arrangement (owner fact needed); without rapid BI the implant-hold policy delays cases by a day.
- **Telemetry sensors** not installed day one — manual env log tasks are honest but weak; block rule O-9 depends on it.
- **Overnight conversion into the incumbent 10-bed IPD** — the boundary map (E-11) must name who owns the record after conversion; risk of a double-billed episode.
- **Op-Note Drafter dictation** pulls Whisper/LLM through the 12a choke module; DPIA counsel sign-off timing is outside this plan's control.
- **Emergency override lane misuse** in a day-care unit: the default here is *no* override for statutory gates and a two-actor override for clinical gates — if the unit starts taking semi-emergent cases, the criteria must be widened formally, not by override.
- **Sterilisation (FP) scope** (O-12) may add a government-scheme reporting surface not otherwise planned.
