# 14 — Emergency Department, Trauma, Ambulance & Disaster Mode — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED · **Series:** Department Brainstorm & Planning (overnight, 2026-08-27) · **Author:** planning agent, from spec v4.8 §11.3/§11.4/§11.14/§11.15/§11.19-A, S10, copilot design, roadmap, Plan 13.

**Executive summary.** The ED module is the 24×7 front door that must never gate care on money, identity, or paperwork — and must still leave a courtroom-grade trail behind every patient. It owns the ER encounter (`encounter_type = ER`), five-level triage, the 24-hour observation ceiling, dispositions, the MLC register family (police intimation, injury reports, evidence custody), the brought-dead register, the ambulance fleet and trip ledger, inter-facility transfer, trauma-team activation and registry, the ED-side of the code system (Code Blue/Violet/Yellow/STEMI/stroke/sepsis clocks), and disaster (mass-casualty) mode with its post-event reconciliation. It is NOT the bed board (IPD/Plan 13 registry), NOT the mortuary module, NOT the OT module, NOT PACS/LIMS, NOT the police (it intimates; it does not investigate), and NOT a phone system (PBX is bought). Three hardest problems: **(1) identity under fire** — treating unknown/unconscious/mass-casualty patients under temporary identities and merging them later without ever mixing two people's blood groups; **(2) money without a gate** — treat-first-bill-later at scale (2,000 OPD/day → ~150–250 ED/day) without the ED becoming the hospital's leakage door or bad-debt sink; **(3) boarding** — ED patients waiting for ICU/ward beds are the single most dangerous state in an Indian corporate hospital, and the system must make that wait loud, attributable and escalating, not invisible.

---

## 1. Frame — what exists, what is locked, what this document adds

**Locked (inherited, not re-litigated):**
- §11.3 ER journey: **treatment first, money later — no payment gate anywhere**; arrival modes (walk-in / ambulance with pre-arrival / referred-in / police-brought = auto-MLC); triage colour **< 5 min = day-one active SLA** (§10.3); Red/Yellow/Green/Black; registration parallel at bedside or UNKNOWN flow (map 8); **24-hour observation ceiling** with escalation ER head → management; six dispositions, exactly one per episode; Green-to-OPD conversion with fee, patient informed first; Black → brought-dead register legally separate from hospital-death register; exception map 13 disaster mode (declare via approvals engine, DIS-tags, staff recall, surge board, OT/ICU pre-empt, all casualties auto-MLC, switch-off reconciliation).
- §11.4 maps 1 (downtime), 3 (payer switch), 8 (unknown patient), 12 (MLC in IPD + unclaimed body: MRD custody of injury reports, release only against logged requisition, re-intimation on discharge/death/abscond, 72-h police → municipal ladder).
- §11.14: code system (Code Violet, fire/evacuation manifest, Code Yellow), single-spokesperson rule for media/police, treatment refusal & DNR, needle-stick PEP clock, body-release double-verify, seasonal surge mode, DPDP rights with **MLC retention indefinite**, legal-hold flags, CERT-In 6-h.
- §11.15: Code Blue one-touch anywhere, roster-resolved team, crash-cart seal event, timed code sheet, MTP (massive transfusion), ventilated transport bundle.
- §11.19-A: tiered trauma-team activation (code class, roster-resolved), self-feeding trauma registry; cath lab **door-to-balloon clock** `stemi.diagnosed → balloon.inflated` 90 min; ED floor has 3 ED theatres + emergency radiology + trauma.
- §11.19-C/D/E: emergency OT gate profile (fix 7); escalation dead-end fallback (fix 11); downtime cash SoD (fix 15); agents mode-aware (fix 27); backfill events never trigger agent actions (fix 28); guardianship + POCSO sealed-channel override (D-31); no membership sales at ER (D-32); deceased-patient conduct, **body release never gated on payment** (D-33); equity guardrail — VIP flags affect privacy never priority (D-37); signed QR tokens (D-23); event-log hash chain + court-production workflow (D-22).
- §14 break-glass for ER staff; §16 tiers and clinical cap T2–T3; S10 cards 10 (ER Physician), 31 (Duty Manager), 34 (Security), 39 (MS: MLC oversight); S10 §11 SoD pairs; roster/witness rules.
- Roadmap: ED sits in IPD cluster stage (b) "ED (per §11.3) + OT + CSSD"; ambulance in (d) support services; trauma registry in service-line modules (8). Plan 13 registry kinds are a **closed set of ten** (floor/ward/hall/room/bed/theatre/store/bench/analyzer/device); an eleventh kind is a kernel edit + migration.
- Copilot design laws: narrate-never-originate, tokenization boundary, four-state render, care-setting packs (an `ed-triage` pack is a natural third pack after `opd-consult` and `ot-briefing`).

**What this document adds (all proposed):** the ED as a module with its own tables; a 5-level triage inside the locked 4-colour rule (levels 1–2 = Red, 3 = Yellow, 4–5 = Green, Black separate); the ED sub-lifecycles (boarding, observation unit, restraint, LAMA-from-ED, LWBS); the MLC register family as first-class tables with evidence chain of custody; the ambulance/transfer module; the ED clocks (stroke, STEMI, sepsis, trauma); the disaster module's tag/reconciliation machinery; the treat-first credit register; agents and KPIs.

**Scope boundaries / neighbours (who owns what table):** patients (patient master, UHID, merge, guardianship) · IPD (beds via Plan 13 registry, admissions, deposits, discharge cascade) · OT (emergency theatre booking; ED calls `ot.book(emergency=true)`) · ICU (Code Blue definition is kernel/ops-owned code system; ED consumes) · LIMS/radiology (orders with `priority=ER_STAT`) · pharmacy (crash cart par/seal, ED sub-store as P3 store) · billing (charges from ED events; credit register is ED-owned, write-offs are billing-owned) · MRD (injury report custody after signing, death certificates, court production) · mortuary (body custody after `brought_dead.recorded`/`patient.deceased`) · notifications (WhatsApp/SMS/PBX) · quality (incident register, NABH indicators) · security (passes, Code Violet response).

---

## 2. Actors, roles & role cards

| Role (S10 card) | ED station(s) | Shifts / bundling | Notes |
|---|---|---|---|
| ER Physician (card 10) | triage override, treatment bays, resus, disposition, MLC signatory | 24×7 rota; day-one 2–3, target 12–16 | Signs MLC + injury report; declares brought-dead; two-doctor emergency consent partner |
| **ED Triage Nurse** (NEW card 40) | triage desk | 24×7; 1 per shift day-one, 3–4 at scale | Assigns level/colour; re-triage; < 5 min SLA owner; may not downgrade Red without physician |
| **ED Staff Nurse** (extends card 20) | bays, resus, observation unit | per-bay ratio 1:4 (obs 1:6, resus 1:1) | Crash-cart seal checks, restraint monitoring, LAMA counselling witness |
| **ED In-Charge (Sister)** (extends card 23) | ED floor ops, rosters, boarding board | 1 per shift | Owns boarding escalation acknowledgment; disaster surge board operator |
| **ED Registration Clerk** (extends card: registration clerk) | bedside registration, UNK flow, DIS-tags, deposits-later | 24×7; bundles with admission clerk at night | Never blocks care; QR wristband print |
| **ED Cashier** (extends cashier card) | treat-first bill, deposits at disposition, ambulance billing | night bundles into central cashier | SoD: never approves own write-off |
| **Ambulance Coordinator / Dispatcher** (NEW card 41) | dispatch desk, pre-arrival, 108 liaison, trip closure | 24×7 at scale; day-one bundled with ED in-charge | Owns checklist compliance, GPS feed |
| **EMT / Paramedic** (NEW card 42) | vehicle | per vehicle shift | Pre-arrival packet; PCR (patient care record); equipment checklist signer |
| **Ambulance Driver** (NEW card 43) | vehicle | | Vehicle log, fuel, odometer; not a clinical actor |
| **ED Pharmacist / sub-store custodian** (extends card 25/26) | ED sub-store, crash carts | day + night on-call | P3 custodian; counted by stores staff (SoD) |
| Duty Manager (card 31) | codes, downtime, disaster declaration (with ER head), VIP/media | 24×7 | Two-key with MS when owner unreachable (D-B10) |
| Medical Superintendent (card 39) | MLC oversight, police/court document release authority, mortality review | office hours + on-call | Countersigns injury-report release to court |
| **Medico-Social Worker** (NEW card 44) | destitute/unclaimed, charity requests, family info desk in disaster | day; on-call night | Owns social-services ladder (map 8) |
| Security Supervisor (card 34) | Code Violet, evidence witness for belongings, gate, restraint assist | 24×7 | Two-staff sealed belongings inventory partner |
| MRD (existing) | injury-report custody, requisition ledger, court production | day | Release only against logged requisition |
| Quality Manager (card 37), Infection Control Nurse (card 38) | KPIs, incident RCAs, PEP clocks, mass-casualty debrief | day | |
| Cath-lab team, neurologist on-call, obstetrician on-call, paediatrician on-call, anaesthetist on-call, surgeons (trauma tiers) | roster-resolved code responders | on-call ladders | resolved by roster module; dead-end fallback fix 11 |

**Agent/automation actors (all first-class actors with RBAC, §16):** Triage-Note Drafter (T2 agent) · Pre-Arrival Prep Briefer (T2 agent) · Disposition-Delay Chaser (T1 automation) · MLC Completeness Watchman (T1 automation) · Bed-Request Escalation (T1→T3 automation) · ED Census Digest (T0 automation) · ED Clock Keeper (T1 automation: stroke/STEMI/sepsis/restraint/obs-ceiling) · 72-h Return Flagger (T0 automation) · Ambulance Readiness Watchman (Expiry Watchman extension, T1) · Trauma-Registry Abstractor (T2 agent, later). Details §9.

**SoD hard pairs added (proposed):** MLC registering doctor ≠ MLC completeness sign-off reviewer (MS/ED head) · evidence sealer ≠ evidence custodian (MRD/security) · treat-first credit grantor (ED cashier/in-charge) ≠ write-off approver · disaster declarer ≠ disaster reconciler · restraint orderer ≠ restraint reviewer at 4-h review · brought-dead declaring doctor ≠ body-release verifier. Bundling matrix: night ED registration ← admission clerk; ED cashier ← central night cashier; ambulance dispatcher ← ED in-charge (day-one only, flagged as bus-factor gap).

---

## 3. Core flows as workflow definitions

All are P1 (patient journey) unless noted; every state has an SLA, alerting `active` only where marked ★ (§10.3); everything else `record_only`.

### 3.1 ER episode (P1) — definition `er_episode` v1

```
arrived ──► triaged ──► in_treatment ──► disposition_pending ──► disposed ──► closed
   │           │  ▲            │                 │
   │           │  └─retriage───┘                 ├─► boarding (sub-instance, §3.3)
   │           │                                 ├─► observation (sub-instance, §3.4)
   ├─► left_before_triage (LWBS-pre)             └─► lama / abscond / death / brought_dead
   └─► brought_dead (Black) ──► mortuary handoff
```

| State | Entry | Allowed roles | SLA | Escalation |
|---|---|---|---|---|
| arrived | `er.arrived` (walk-in/ambulance/referred/police/disaster-tag) | reg clerk, triage nurse, EMT (pre-arrival auto-creates `expected`) | to triaged **5 min ★** | 5 min → ED in-charge; 10 min → ER physician; 15 min → duty manager |
| triaged | `er.triaged` (level 1–5, colour, vitals) | triage nurse, ER physician | to doctor first-contact: L1 0 min ★, L2 10 min ★, L3 30 min, L4 60, L5 120 | L1/L2 breach → ER physician + duty manager; L3 → in-charge |
| in_treatment | first physician contact (`consultation.started`, encounter ER) | ER physician, nurses | to disposition decision: L1/L2 4 h, L3 4 h, L4/5 2 h (median target < 4 h per S10) | in-charge → ER head |
| disposition_pending | `er.disposition_decided` (home/admit/OT/refer/LAMA/death) | ER physician | admit → bed 60 min; refer → ambulance 60 min; home → bill+meds 30 min | boarding sub-instance (§3.3) |
| disposed | bed occupied / OT wheel-in / ambulance departed / home billed | system | 24-h ceiling from `arrived` **★ hard** | breach → ER head → management (locked) |
| closed | bill closed or credit-registered + MLC complete check | cashier, system | 24 h after disposed | MLC Watchman nudges |

Variants (corporate-standard): **fast-track** (L4/L5 → nurse-practitioner-style protocol bay; Green-to-OPD conversion with fee & consent), **direct-to-resus** (pre-arrival L1 skips `arrived` wait, triage recorded retrospectively with `occurred_at`), **referred-in with bed pre-booked** (admission.requested precedes er.arrived), **police-brought** (auto `mlc.registered` on arrival), **disaster-tag** (§3.7).

Events emitted: er.arrived · er.triaged · er.retriaged · consultation.started/.completed (encounter_type ER) · er.disposition_decided · vitals.recorded · vitals.danger_flagged · break_glass.used · sla.breached · escalation.triggered · **NEW** er.lwbs_recorded (with phase: before_triage | after_triage | during_wait) · **NEW** er.fasttrack_converted_to_opd · **NEW** er.episode_closed · patient.deceased · brought_dead.recorded. Consumed: bed.assigned, ot.booked, ambulance.* , admission.requested, order.placed/result.*.

### 3.2 Triage (sub-definition of 3.1, P1) — 5-level inside the 4-colour law
Level 1 (immediate: arrest, airway, GCS < 9, SBP < 90 with shock signs) = **Red**; Level 2 (emergent: chest pain with ECG changes, stroke window, major trauma tier, sepsis screen positive, active seizure, obstetric haemorrhage) = **Red**; Level 3 (urgent, needs ≥ 2 resources) = **Yellow**; Level 4 (1 resource) = **Green**; Level 5 (none) = **Green fast-track**; **Black** = brought dead. Vitals-driven up-triage rules (adult/paed tables) are **governed definition data (Class A, two-key)**, never code. Re-triage every 30 min for Yellow in wait, on any danger vital, on nurse judgement — evented `er.retriaged` with reason. Downgrade Red → lower requires physician co-sign.

### 3.3 Boarding (P1 sub-instance + P7) — `ed_boarding` v1
`bed_requested` (admission.requested with `source=ED`) → `bed_waitlisted` (bed.waitlisted) → `bed_assigned` (bed.assigned) → `transport_dispatched` (task.created porter) → `arrived_ward` (patient.transferred). SLA: request → assigned **60 min ★** (ICU: 30 min ★); assigned → left ED 30 min. Ladder: 60 min → ED in-charge + bed manager; 2 h → duty manager (may invoke bed-class protection map 4 or override admission, evented with name §11.14); 4 h → ER head + MS; 6 h → owner SMS + digest line. Boarding hours accrue to the KPI and to the ward/ICU that was full (attribution: not the ED). NEW events: er.boarding_started · er.boarding_escalated · er.boarding_ended (reason: bed | refer_out | discharged_from_ed | death).

### 3.4 Observation unit (P1 sub-instance) — `ed_observation` v1
`observation_started` (physician order, expected < 24 h from arrival) → 4-hourly reassessment tasks (P5) → `observation_decided` (home | admit | ceiling_breach). Billing: observation is a **time-slab charge** from `er.observation_started` to decision (recommended slabs 0–6 h / 6–12 h / 12–24 h, configurable; O-4). The 24-h ceiling of §11.3 is the hard SLA; at 20 h the Clock Keeper nudges the physician; at 24 h escalation is locked. NEW: er.observation_started · er.observation_decided.

### 3.5 MLC (P5 task-and-track over a statutory register) — `mlc_case` v1
`flagged` (any staff; auto on police-brought, unknown, assault, RTA, burns, poisoning, snake/dog bite, sexual assault, fall from height, industrial injury, suspected suicide/homicide, custodial, brought dead, disaster casualty) → `registered` (MLC number from reserved series, `mlc.registered`) → `police_intimated` (NEW `mlc.police_intimated`: SHO/PS name, mode, time, receiver name/badge, acknowledgment ref; SLA **within 1 h of registration**, record-only alert, in-charge nudge at 2 h) → `injury_report_drafted` (NEW `mlc.injury_report_drafted`; Drafter T2 optional) → `injury_report_signed` (NEW `mlc.injury_report_signed`, ER physician, 2FA signature class) → `evidence_secured` (NEW `mlc.evidence_sealed` per item; two-staff) → `complete` (Watchman checks: intimation, report, wound chart, photos consented, alcohol/substance note, disposition note, re-intimation on discharge/death/abscond) → `handed_to_mrd` (custody). Re-intimation transitions on `patient.discharged`, `patient.deceased`, LAMA, abscond (map 12 locked). Sub-protocols: **sexual assault** (one-stop-centre style: female doctor/attendant present, MoHFW 2014 guideline forms, informed consent for examination separate from treatment consent, refusal of examination cannot refuse treatment; evidence kit sealed; POCSO if minor → `pocso.intimated`, sealed-channel guardian override D-31); **poisoning** (sample preservation gastric lavage/blood/urine sealed; PCC call logged); **burns** (TBSA, dying declaration facilitation task to magistrate — hospital only requests, never records the declaration itself); **snake bite** (ASV administered event with vial count and batch; anti-venom stock is oxygen-class active alert); **dog bite** (ARV/RIG schedule → recall agent); **alcohol** (clinical note of intoxication signs; breath/blood alcohol only on police requisition or clinical need — O-7).

### 3.6 Brought dead & death in ED (P1 terminal)
Black at triage → `brought_dead.recorded` (declaring doctor, time, condition of body, belongings two-staff inventory, auto-MLC) → body tag (signed QR) → mortuary task → release via §11.14 double-verify, never gated on payment (D-33). Death after treatment → `patient.deceased` (hospital death register, MRD; death certificate MCCD Form 4/4A flow), MLC re-intimation if MLC, mortuary, sensitive settlement. Charges: brought-dead = zero charges by default (O-6); death-in-ED = charges accrue normally, dunning suppressed.

### 3.7 Disaster / mass-casualty mode (kernel ops-mode + ED module) — `disaster_incident` v1
`suspected` (any ED staff raises; pre-alert from 108/police/collector) → `declared` (approvals engine, emergency class; ER head or duty manager; owner alerted real-time; `disaster.declared`; `mode.context_applied`) → `active` (DIS-tag batch registration: pre-printed signed-QR tag packs, photo + triage colour + sex + approx age only; staff-recall broadcast WhatsApp + PBX; surge bed board; OT/ICU pre-empt rules; elective OT list freeze; blood bank MTP posture; family information desk opened; single spokesperson named; all casualties auto-MLC) → `stand_down` (`disaster.ended`) → `reconciling` (every DIS-tag → full UHID registration or unknown-patient ladder; supplies issued under disaster cost centre reconciled to patients; deaths reconciled to registers; police list reconciled; `disaster.reconciled` NEW; SLA 72 h) → `closed` (debrief incident.reported; drill scoring). Tiers proposed: **Level 1** (≤ 10 casualties, ED handles with recall of 2nd shift), **Level 2** (11–30, OT/ICU pre-empt), **Level 3** (> 30 or CBRN, district authority liaison, external transfers). NEW events: disaster.tag_issued · disaster.tag_resolved · disaster.reconciled · family_desk.enquiry_logged.

### 3.8 Ambulance trip (P5 task-and-track + P6) — `ambulance_trip` v1
`requested` (ED, ward, external caller, 108 relay) → `dispatched` (vehicle + crew resolved, `ambulance.dispatched` NEW) → `enroute_to_scene` → `at_scene` → `patient_loaded` (PCR starts; pre-arrival packet → `ambulance.prearrival_notified` with ETA, level, vitals, suspected STEMI/stroke/trauma tier → ED `expected` episode auto-created) → `enroute_to_hospital` → `arrived` (`er.arrived` links trip ↔ episode) → `handed_over` (crew → triage nurse acknowledgment) → `trip_closed` (odometer, oxygen used, consumables consumed → patient bill or ambulance cost centre; `ambulance.trip_closed` NEW). Variants: **inter-facility transfer out** (§3.9), **return-home drop** (billable), **dead-body transport** (mortuary van rules), **stand-by duty** (events/camps, billable to organiser), **108/private ambulance arrival** (no trip instance; pre-arrival call logged as `ambulance.prearrival_notified` with `fleet=external`). Pre-trip **equipment checklist** per shift (oxygen cylinder pressure, suction, defib battery, drugs box seal, stretcher, PPE) as P5 task; a vehicle with a failed checklist is `unavailable` in the registry.

### 3.9 Inter-facility transfer (P1 handoff + P5)
`transfer_initiated` (`transfer.initiated` NEW; reason: bed/ICU unavailable, specialty absent, patient/family choice, payer network) → `receiving_confirmed` (name of accepting doctor/hospital, time, phone — mandatory) → `stabilised_documented` (checklist: airway, IV, vitals, transfusion status; EMTALA-style "stabilise before transfer" as NABH expectation) → `packet_prepared` (referral letter with QR, records copy, MLC copy where police involved, imaging share link) → `departed` (`transfer.completed` NEW on receiving acknowledgment or crew return). Refer-out never blocked on bill; bill follows credit register.

### 3.10 Codes & clocks in ED (kernel code system consumed; ED-specific clocks)
- **Code Blue in ED**: `code.activated(type=blue, location=ED bay)` → resus team (ED physician leads inside ED; anaesthetist/ICU nurse per roster) → crash cart seal broken (`crash_cart.opened` NEW unless ICU spec mints it first — reuse) → timed code sheet (ROSC/time of death) → replenish task + per-patient consumable charging → register + debrief.
- **STEMI**: `stemi.diagnosed` (ED ECG read; 10-min door-to-ECG target ★) → cath activation (`code.activated(type=stemi)`) → `balloon.inflated` (cath lab) 90-min clock (locked); thrombolysis branch (`thrombolysis.started` NEW, 30-min door-to-needle) where cath lab unavailable.
- **Stroke**: `stroke.suspected` NEW (FAST/BEFAST) → CT 25 min ★ → `thrombolysis.started` 60 min door-to-needle; thrombectomy referral path.
- **Sepsis**: `sepsis.screen_positive` NEW → hour-1 bundle tasks (cultures, lactate, antibiotics, fluids) with `medication.administered` closing the antibiotic timer.
- **Trauma tiers** (§11.19-A locked mechanism): Tier 1 (physiologic: SBP < 90, GCS ≤ 8, intubated, penetrating torso) → surgeon + anaesthetist + ortho + blood bank + CT + OT standby; Tier 2 (mechanism/anatomy) → ER physician + surgeon on-call; Tier 3 (consult) → specialty consult. `trauma.activated(tier)`; pagers/WhatsApp/PBX per §11.13; 5-min acknowledgment timer; acknowledgment by tapping in-app (WhatsApp only notifies, locked §8).
- **Code Violet / Yellow** per §11.14; ED is the most frequent trigger site.
- **Paediatric emergencies**: weight-based dosing — weight (or Broselow length-band) captured at triage, prescribing safety layer (copilot §1) checks mg/kg ranges from licensed content; missing weight = hard warning on any weight-based drug.
- **Obstetric emergencies**: `labor.triaged` handoff to maternity; ED never delivers unless imminent; eclampsia/PPH kits are ED sub-store items.

### 3.11 Restraint & the violent/intoxicated/absconding patient (P5 over clinical order) — `restraint_order` v1
`ordered` (physician; type physical/chemical; indication; `restraint.ordered` NEW) → `applied` (nurse, time, limb checks) → 15-min monitoring tasks → `reviewed` (physician within 1 h, then every 4 h; NEW `restraint.reviewed`) → `released` (`restraint.released` NEW). Max continuous 24 h without MS-level review. Feeds NABH restraint register. Absconding: Code Yellow if vulnerable, else `er.lwbs_recorded(phase=abscond)` + MLC re-intimation + belongings custody.

### 3.12 LAMA/DAMA from ED (E5 machinery, ED variant)
`lama_requested` → counselling (physician + nurse witness; risks explained in patient's language; interpreter noted) → `lama.recorded` NEW (form, signature/thumb + two witnesses if illiterate) → typed discharge → bill or credit register → MLC re-intimation if MLC. Minor/unconscious → guardian authority scope check (D-31); no legal guardian → MS decision evented.

### 3.13 Treat-first credit (P6 variant) — `ed_credit` v1
Every ED episode has `payer_tag` (self/TPA/PMJAY/corporate/unknown). Charges accrue normally from events. At disposition: home → counter settles; admit → deposit invoice is the IPD desk's (bed first, deposit catches up — locked); refer-out/LAMA/death/absconded/unknown/destitute → any unpaid balance moves to the **ED credit register** (`er.credit_registered` NEW: amount, reason, grantor, contactable phone/ID, promised date). Chaser ladder (Recall agent reuse): 3 / 7 / 15 days → write-off request via approvals to billing head above threshold (O-1); below threshold auto-write-off to **charity/bad-debt cost centre**, attributed. Never blocks future care; a flagged prior credit shows at next registration as an informational badge only.

---

## 4. Data model sketch

Module `ed` (+ sub-folders `ed/mlc`, `ed/ambulance`, `ed/disaster`; all mirror engine state, never own it — §10.2). Sketch columns only.

| Table | Key columns | Notes |
|---|---|---|
| `er_episodes` | id, encounter_id, patient_id (nullable until identified), arrival_mode, arrived_at, source (walk-in/ambulance/referred/police/disaster), referring_facility, ambulance_trip_id?, provisional_identity_id?, disaster_tag_id?, triage_level, colour, workflow_instance_id, disposition, disposed_at, closed_at, payer_tag, is_mlc, is_trauma, site_id | mirror of `er_episode` instance |
| `er_triage_records` | episode_id, seq, level, colour, reason_codes[], vitals_ref, weight_kg / length_band, pain score, GCS, allergies_confirmed?, nurse_id, physician_cosign_id?, occurred_at, recorded_at, drafted_by_agent? provenance | append-only; re-triage = new row |
| `provisional_identities` | id, temp_uhid (UNK-YYYY-NNNN), sex, approx_age, photo_ref, distinguishing marks, belongings_inventory_id, status (open/merged/never_identified), merged_into_patient_id, merged_at, merge_approval_id | map 8; merge via patients.merge interface |
| `belongings_inventories` | id, subject (episode/provisional), items jsonb, sealed_bag_no (signed QR), staff1, staff2, custodian, released_to, released_at | two-staff |
| `er_dispositions` | episode_id, type, decided_by, decided_at, target (bed/OT/facility), consent_variant (two-doctor), notes | one per episode |
| `ed_boarding` | episode_id, requested_at, class_requested, assigned_at, left_ed_at, escalation_rungs jsonb, attributed_unit | KPI source |
| `ed_observation_stays` | episode_id, started_at, decided_at, decision, slab_charges_posted | |
| `mlc_register` | mlc_no (reserved series, gapless), episode_id/admission_id, category, registered_at, registered_by, police_station, brought_by (name/badge/vehicle), alcohol_note, disposition_reintimations jsonb, completeness_score, status, legal_hold | **statutory register, indefinite retention** |
| `mlc_police_intimations` | mlc_no, seq, mode (phone/email/WhatsApp/physical), sent_at, receiver_name/badge, ack_ref, doc_ref, trigger (registration/discharge/death/abscond/transfer) | |
| `mlc_injury_reports` | mlc_no, version, body-chart jsonb (FHIR Observation/Condition shaped), photos refs (consent flag), signed_by, signed_at, 2FA sig ref, custody (ED/MRD), draft_provenance | restricted legal document |
| `mlc_evidence_items` | id, mlc_no, kind (clothing/bullet/sample/kit), description, sealed_by1/by2, seal_no, photo_ref | |
| `mlc_evidence_custody_log` | evidence_id, from_actor, to_actor (incl. police officer + badge), at, purpose, receipt_ref | chain of custody, append-only |
| `sexual_assault_exams` | mlc_no, consent refs, examiner, attendant present, kit seal, POCSO flag, sealed_class=true | sealed-class propagation D-25 |
| `brought_dead_register` | serial, episode_id, provisional/patient, declared_by, declared_at, brought_by, circumstances, body_tag (signed QR), mortuary_task_id, released_at | separate from hospital death register (MRD) |
| `ed_deaths` (view over patient.deceased where encounter ER) | | not a register; MRD owns the register |
| `ambulance_vehicles` | id, registry_resource_id (kind `device`, parent = ambulance bay `room` — see O-9), reg_no, type (BLS/ALS/neonatal/mortuary), fitness/insurance/PUC expiry, oxygen capacity, status | Expiry Watchman feeds |
| `ambulance_trips` | id, vehicle_id, type, requester, patient_id?/provisional?, pickup/drop geo+addr, timestamps per state, crew ids, km_start/end, oxygen_l_used, consumables jsonb, charge_basis, workflow_instance_id, external_fleet? | |
| `ambulance_checklists` | vehicle_id, shift, items jsonb (pass/fail), signed_by, at | failed → vehicle unavailable |
| `ambulance_gps_pings` | vehicle_id, ts, lat, lng, speed | TimescaleDB-class telemetry via edge, not core DB (§5 pattern) |
| `patient_care_records` | trip_id, vitals series, interventions, drugs (batch), handover_to, handover_ack_at | FHIR Encounter/Observation shaped |
| `transfers` | id, episode/admission, direction (in/out), reason, receiving_facility, accepting_doctor, confirmed_at, stabilisation_checklist jsonb, packet_docs[], departed_at, ack_at | |
| `trauma_activations` | id, episode_id, tier, activated_by, activated_at, responders jsonb (role, notified_at, ack_at, arrived_at) | |
| `trauma_registry` | episode_id, mechanism, ISS/RTS/GCS, interventions, outcome, abstracted_by (human/agent), verified_by | self-feeding from events; abstractor T2 |
| `ed_clocks` | episode_id, clock (stemi/stroke/sepsis/door_to_doctor/obs_ceiling), started_event_id, target_min, stopped_event_id?, breached | derived, materialised for KPIs |
| `restraint_orders` | episode/admission, type, indication, ordered_by, applied_at, reviews jsonb, released_at | NABH register |
| `lama_records` | episode_id, counselled_by, witness1/2, language, interpreter, form_ref, signature kind, at | |
| `ed_credit_register` | id, episode_id, amount, reason, grantor, contact snapshot, promised_at, chase_log jsonb, outcome (paid/written_off/partial), writeoff_approval_id | write-off event is billing's |
| `destitute_cases` | episode_id, flagged_by, social_worker_id, ladder_rungs jsonb, police ref, NGO/shelter ref, charity approval | map 8 ladder |
| `disaster_incidents` | id, level, declared_by, approval_id, declared_at, ended_at, casualties_count by colour, spokesperson, reconciliation_status, debrief_incident_id | |
| `disaster_tags` | tag_no (pre-printed signed QR), incident_id, colour, sex, approx_age, photo_ref, resolved_to (patient_id/provisional/brought_dead), resolved_at | every tag must resolve (locked) |
| `family_desk_enquiries` | incident_id, enquirer, contact, description of missing person, matched_tag?, outcome | |
| `police_document_requests` | id, requester (PS/court/CID), requisition doc ref, documents requested, MS approval, released_by, released_at, `document.release_logged` ref | MRD custody; single-spokesperson |
| `ed_returns_72h` | episode_id, prior_episode_id, related?, reviewed_by | NABH indicator |
| `code_activations` (kernel `ops` owned; ED reads) | | |

**Registry kinds (Plan 13):** ED floor → `floor`; triage area, family desk, decon room → `room`; treatment bays, resus bays, observation beds → `bed` (statuses: available/occupied/cleaning/blocked); 3 ED theatres → `theatre`; ED sub-store, crash carts → `store` (carts) + `device` (defib, ventilator, portable X-ray, POCT ABG = `analyzer`); ambulance bay → `room`; ambulance → `device` under the bay **(default; O-9 asks whether a `vehicle` kind is worth the kernel edit)**.

**FHIR shapes:** Encounter (class EMER, priority = triage level), Observation (vitals, GCS, pain), Condition (injuries), Procedure (interventions), Consent, DocumentReference (injury report, referral letter, PCR), Location (bays), Transport-like via ServiceRequest for transfers. **Retention:** MLC family, brought-dead, evidence custody — **indefinite**; ER encounters ≥ 10 y (treat as IPD-class); ambulance trip ledger 8 y (books); GPS pings 1 y (rolled up); restraint register 10 y; disaster incident 10 y; draft provenance per D-36 policy. **DPDP classes:** identity (UHID, ABHA), health (all clinical), sensitive-legal (MLC, sexual assault, POCSO — sealed class), biometric-like (photos of unknown patients — purpose-limited, purged on merge unless MLC), location (GPS of patient transport — purpose-limited).

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.**

### A. Identity & wrong patient
| ID | Scenario → behaviour → test → ruling |
|---|---|
| A1 | Unconscious man, no ID, brought by passers-by → UNK temp UHID in < 30 s (sex, approx age, photo), auto-MLC, care never blocked → test: `er.arrived` with `provisional_identity` and no `patient_id` passes every order/charge API. |
| A2 | Two unknown males arrive from the same RTA within 5 min → distinct provisional IDs with photos + distinguishing marks; wristbands with signed QR issued before any blood draw → assertion: sample.collected requires a scanned band (provisional or UHID), never a bay number. |
| A3 | Family arrives 3 h later and identifies UNK-0041 → `patient.merged` (provisional → real UHID) with side-by-side review; all orders/results/charges carry over; blood group already resulted under UNK is re-verified (second sample) before transfusion → test: post-merge `unit.crossmatched` demands a post-merge sample. |
| A4 | Wrong family "identifies" the wrong unconscious patient (two similar men) → merge is reversible (`patient.unmerged`, locked §11.5) and the wristband is re-issued; transfusion/allergy facts revert to provisional-only → test: unmerge restores provisional record and re-flags allergies as unverified (DD note 16). |
| A5 | Patient known to hospital but arrives unconscious; ED registers UNK; later search finds existing UHID with 3 prior visits → merge into existing, old allergies surface, no duplicate UHID survives → test: duplicate-UHID report empty after merge. |
| A6 | Same name, same village, different men, both in ED (Ramesh Kumar × 2) → alias-free bay display uses UHID last-4 + photo thumbnail; every order screen shows photo; band scan mandatory for drugs/samples → test: order from bay screen without band scan refused for high-alert items. |
| A7 | Attendant gives wrong DOB/name for a conscious but confused elderly woman → registration marks fields `unverified`; correction later is an amend event, not an overwrite; bill and MLC docs regenerate from the corrected master → test: injury report v2 references v1. |
| A8 | Minor brought by a neighbour, parents unreachable → guardianship model (D-31): treatment proceeds under emergency doctrine; two-doctor consent variant; guardian linked later → test: consent.recorded with `basis=emergency_two_doctor` accepted for minor with no guardian. |
| A9 | Disaster tag DIS-017 photographed by media → tags carry no name; public boards show tag+colour only (locked "tokens only") → test: any public-surface render of DIS tags contains no PII. |
| A10 | Staff nurse of the hospital brought after a road accident → staff-as-patient confidential flag auto (§11.5), alias on bay board, break-glass logged; MLC still registered under real identity in the sealed register → test: bay-board render shows alias, MLC register shows name with sealed-class access only. |
| A11 | Provisional patient never identified after 30 days → social-services ladder (map 8), charity-head billing as logged decision, police missing-person cross-check logged → test: provisional status `never_identified` requires ladder rungs ≥ 3 with actors. |
| A12 | Twin newborn brought from home delivery with mother; both unknown → mother provisional + baby provisional linked; pairing bands (map 2) → test: baby handover scan requires pair. |

### B. Timing, concurrency & race
| ID | Scenario |
|---|---|
| B1 | 6 patients arrive within 90 s at 2 a.m. with one triage nurse → per-patient 5-min clock runs from each `er.arrived`; breaches recorded individually but the alert dedupes into one "triage backlog: 4 waiting" thread (anti-fatigue §11.13) → test: 6 breaches → 1 escalation thread with count. |
| B2 | Pre-arrival ETA 8 min; patient actually arrives in 3 → `expected` episode transitions to `arrived` on band scan; triage `occurred_at` may precede `recorded_at` → test: clocks compute from occurred_at. |
| B3 | Two doctors simultaneously record disposition (admit vs refer) → single-winner transition; loser sees the winner's decision and must record `er.disposition_changed` with reason (NEW) → test: concurrent POSTs → exactly one `er.disposition_decided`. |
| B4 | Bed assigned by IPD at the same second ED records refer-out → reservation state machine (DD note 15) arbitrates; bed released back with TTL; refer-out stands unless physician reverses → test: no bed stays `occupied` with no admission. |
| B5 | Re-triage upgrade happens while doctor first-contact SLA of old level is mid-count → clock resets to the tighter level from `er.retriaged`; old breach (if any) stays recorded → test: two clock rows, one closed. |
| B6 | 24-h ceiling hits at 03:10 while patient is in CT → escalation still fires; the physician can "acknowledge with plan" (evented) which pauses the ladder 60 min max, never cancels → test: pause > 60 min impossible. |
| B7 | STEMI: ECG done on the ambulance at 10:02, `stemi.diagnosed` recorded at ED 10:15 with occurred_at 10:02 → door-to-balloon clock starts at door (`er.arrived`), not at ECG; first-medical-contact-to-balloon also derived → test: both clocks in `ed_clocks`. |
| B8 | Code Blue and trauma Tier 1 fire on different patients within a minute; the same anaesthetist is on both ladders → roster resolver reports conflict; second activation climbs to next responder immediately, evented `escalation.triggered(reason=responder_busy)` → test: no responder notified twice for overlapping codes without a conflict event. |
| B9 | Ambulance GPS shows arrived but crew has not scanned handover → `arrived` inferred as `provisional` only; handover ack required for trip close → test: trip cannot close without `handed_over` actor. |
| B10 | Observation ends exactly at slab boundary (6:00:00) → slab boundary rule half-open [0,6h) documented and golden-tested. |
| B11 | Patient discharged home at 23:58, returns 00:20 with same complaint → 72-h return flag; new episode links prior; not counted as LWBS → test: `ed_returns_72h` row created. |
| B12 | Duplicate `er.arrived` from a double-scanned pre-arrival QR → idempotency key (trip_id + tag) → one episode. |

### C. Partial failure & downtime
| ID | Scenario |
|---|---|
| C1 | Core server down at 01:00, 9 patients in ED → duty manager declares downtime (map 1); ED paper kit: pre-numbered triage sheets, MLC forms from reserved series, DIS-style temporary wristbands; PBX for codes; treat unconditionally → test: downtime drill produces backfill with every serial accounted. |
| C2 | Backfill of a Red patient's triage at 01:05 entered at 03:40 → `occurred_at` 01:05; KPI computes on occurred_at; backfilled events never trigger agents (fix 28) → test: MLC Watchman does not nudge for backfilled MLC created < 1 h ago. |
| C3 | Internet down, LAN up → WhatsApp trauma pages fail → ladder falls to SMS → IVR → PBX overhead page; `notification.failed` visible on the activation screen → test: activation screen shows per-responder channel status. |
| C4 | WhatsApp template rejected/rate-limited during disaster staff recall → shedding raises alert (fix 30); PBX broadcast + printed recall list from roster → test: recall broadcast report lists undelivered names. |
| C5 | Printer for wristbands dead → fallback handwritten band with serial from the kit; scan-required steps accept manual serial entry with two-person confirm and flag `manual_band=true` → test: high-alert med with manual band needs witness. |
| C6 | Label/QR signature verification fails (D-23) on an old band after key rotation → scanner shows "reissue band" task, does not block emergency meds (fail-open for humans, loud) → test: `band.signature_invalid` event + task. |
| C7 | Edge service for ambulance GPS offline → trip proceeds on manual timestamps; ETA unknown shown as "UNAVAILABLE" not blank (four-state render) → test: pre-arrival card shows UNAVAILABLE label. |
| C8 | Power failure in ED, UPS 20 min → ops-mode flag `power_degraded` (surge-mode mechanics) → ventilated patients list printed automatically at declaration; oxygen cylinder tasks → test: declaration prints active ventilated list. |
| C9 | Approvals engine unreachable when duty manager needs to declare disaster → emergency-activation precedence (E-5): declare locally with two-person attestation, event carries `approval_pending=true`, ratified later → test: disaster declared without approval id but with two attestors is valid and queued. |
| C10 | LIMS down; ED POCT ABG still works → POCT results enter via analyzer edge or manual with `source=poct_manual`; QC lockout release valve (fix 10) if QC due → test: ED order shows POCT result flagged. |
| C11 | Cath lab system down → STEMI clock still runs on ED-side events; `balloon.inflated` backfilled → test: KPI marks backfilled clocks distinctly. |
| C12 | Agent runtime halted globally mid-shift → triage notes typed manually; no screen waits on the drafter (lint-enforced fail-open) → test: triage form submits with drafter offline. |

### D. Money — billing, refunds, payers, packages, TPA
| ID | Scenario |
|---|---|
| D1 | Red patient, no attendant, ₹42,000 of ED charges, admitted to ICU → charges accrue; deposit invoice raised by IPD desk after bed; no ED step ever blocks → test: no API in ED returns a payment-required error. |
| D2 | Green patient walks out before paying ₹850 → episode closed to credit register; chase ladder; below auto-write-off threshold → charity/bad-debt cost centre, attributed → O-1. |
| D3 | Patient's TPA card produced 4 h after arrival → payer tag switch (map 3): counselling + consent; ED charges re-attributed by payer period from switch moment; pre-auth for emergency admission within 24 h per policy → test: invoice lines carry payer-period. |
| D4 | PMJAY beneficiary arrives in emergency; card verified only next morning → PMJAY emergency admission rule: treatment starts, pre-auth raised within 24 h (scheme norm), no cash collected from beneficiary → test: cash tender on PMJAY-tagged episode blocked with warning; O-3. |
| D5 | Family pays ₹5,000 "advance" in cash at ED at 2 a.m. → ED cashier session (or central night cashier bundle); receipt with QR; counts toward §269ST episode aggregate → test: aggregate warns at threshold. |
| D6 | Brought-dead patient — family asked to pay "casualty charges" → default zero charges for brought dead; any charge requires explicit reason → O-6. |
| D7 | Ambulance own-fleet trip for refer-out; family refuses to pay → trip closes; charge to credit register; never delays departure → test: `transfer.completed` independent of payment. |
| D8 | 108 ambulance brings patient — hospital must not bill ambulance → `fleet=external` trips generate no charge line → test: no `charge.posted` for external trips. |
| D9 | Crash cart opened for Code Blue; adrenaline ×6, amiodarone, ET tube used; patient dies → consumables charged to episode from `crash_cart.restocked` reconciliation (used = par − counted); death-in-ED dunning suppressed (D-33) → test: leakage triangle for cart = 0 variance. |
| D10 | Same crash cart opened, patient unknown and never identified → charges terminate on charity cost centre (leakage principle law 4) → test: every `material.consumed` has bill or cost-centre. |
| D11 | Observation 7 h billed at 6–12 h slab; family disputes → slab rule shown on bill face with start/decision timestamps and QR → test: bill line carries clock refs. |
| D12 | Green-to-OPD conversion: patient informed and consents to consultation fee instead of ED fee → `er.fasttrack_converted_to_opd` with consent; OPD tariff applies; not counted as LWBS → test: no ED visit charge and one OPD consult charge. |
| D13 | Refund of an ED deposit after refer-out → credit note + refund voucher; refund to payer with ID; above threshold bank transfer only (§7) → golden case. |
| D14 | ED doctor is a visiting consultant with fee-split → consult attribution on `consultation.completed` (ER) accrues per §7; ED procedures attributed to performing doctor → test: commission.accrued only after payment.received. |
| D15 | Package patient (e.g., maternity package) lands in ED with an unrelated complaint → charges route outside package with live "% consumed" unaffected → test: package.allowance_consumed not emitted. |
| D16 | Corporate credit patient from a credit-stopped corporate → ED treats; admission needs management override (§11.11) evented → test: override name in weekly digest. |
| D17 | Snake-bite ASV 20 vials at ₹500+ each; patient poor → charges accrue; charity approval path; state free-ASV scheme tag if applicable → O-1 / O-3. |
| D18 | Insurance identity fraud at cashless intake in ED (photo mismatch) → payer-switch + incident + insurer notification (§11.14); care continues → test: mismatch never blocks orders. |
| D19 | Two ED cashier sessions overlap at shift change during a Code → session close deferred; denomination count required before next opens → test: no orphan tenders. |
| D20 | Disaster mode: 40 casualties, supplies issued under disaster cost centre → reconciliation moves consumables to identified patients where evented; residue stays on disaster cost centre with owner visibility → test: `disaster.reconciled` payload lists unallocated ₹. |

### E. Consent, legal, MLC, minors, unconscious
| ID | Scenario |
|---|---|
| E1 | Police bring an accused with injuries → auto-MLC; escort's name/badge recorded; custodial patient flag; treatment unconditional → test: `mlc.registered` within the same transaction as `er.arrived(source=police)`. |
| E2 | Assault victim asks not to register MLC ("family matter") → MLC is mandatory by law where indicated; refusal noted; intimation still sent → test: MLC cannot be deleted, only `category_disputed` noted. |
| E3 | Police intimation acknowledged verbally, no written ack → intimation row with `ack_ref=null`, follow-up task at 24 h to obtain GD entry no. → Watchman nudges. |
| E4 | Injury report requested by a police constable without written requisition → refused; requisition logged; MS approval; release via `document.release_logged` → test: release without requisition id impossible. |
| E5 | Court summons for ED records from 3 years ago → court-production workflow (D-22): certified extract + custodian certificate, hash-chain anchor → test: extract verifies against anchor. |
| E6 | Sexual assault survivor, adult, refuses forensic examination but wants treatment → treatment consent and examination consent are separate records; refusal recorded; MLC still registered; police intimation per law (adult survivor's reluctance noted; hospital legally intimates) → test: two consent rows. |
| E7 | 14-year-old pregnant girl in ED → POCSO mandatory reporting (`pocso.intimated`), sealed channel away from default guardian if guardian is suspected (D-31) → test: notifications to guardian suppressed when `sensitive_context=pocso_guardian_suspect`. |
| E8 | Burns 70% TBSA, conscious → dying-declaration facilitation task to magistrate/police; hospital records only the request and the fitness-to-give-statement note → test: no free-text "statement" field exists. |
| E9 | Poisoning: family insists it was accidental; doctor suspects suicide → MLC category `suspected_self_harm`; samples sealed; no judgemental text on discharge summary; mental-health referral task (MHCA 2017 decriminalises attempt) → test: MLC category enum contains both. |
| E10 | Alcohol on breath, RTA driver; police ask for blood alcohol → sample only on written police requisition or clinical need (O-7); chain of custody row; clinical note of signs regardless → test: alcohol sample requires requisition ref or clinical indication code. |
| E11 | DNR patient from home hospice arrives in arrest → DNR flag must be verified (consultant-confirmed, §11.14) before withholding; otherwise resuscitate → test: unverified DNR renders as "not verified — resuscitate". |
| E12 | Jehovah's Witness refuses blood, conscious → per-intervention refusal documented; unconscious with card only → two-doctor decision evented → test: refusal.recorded per intervention. |
| E13 | Emergency OT, no attendant → two-doctor consent variant; elective gates auto-waived with loud log (fix 7) → test: `ot.signin_completed` with `consent_basis=two_doctor`. |
| E14 | Organ donation candidate (brain death) in ED → deferred protocol (§11.14) — ED flags, transplant committee module later; nothing in ED may record brain-death certification → open question §15. |
| E15 | Dog bite, child, parents refuse ARV for cost → counselling recorded; charity path; Recall agent schedules days 3/7/14/28 → test: recall series created on `medication.administered(ARV dose 0)`. |
| E16 | Mentally ill patient brought by police under MHCA §100 → MLC + psychiatric consult; restraint only under §3.11 rules; nearest-relative notification rules → test: restraint without order impossible. |
| E17 | Patient LAMA while intoxicated → capacity assessment note mandatory; if lacking capacity, cannot LAMA — becomes abscond/Code Yellow; police intimation if MLC → test: lama.recorded requires capacity=yes. |
| E18 | Photos of injuries taken on a nurse's personal phone → prohibited; device-locked capture into `mlc_injury_reports.photos` with consent flag; policy + DPDP → assertion: photo refs only from hospital capture path. |
| E19 | Foreign national tourist, no ABHA, embassy contact → nationality field, embassy notification task (MEA norms), passport copy in restricted docs → test: nationality ≠ IN triggers task. |
| E20 | Snake bite: patient dies before ASV; family alleges non-availability → stock timeline (material events) + ASV administration events produce a defensible record; anti-venom stock is active-alert class → test: `stock.below_reorder(item=ASV)` is in the active alert list. |

### F. Staff absence, overload, handover
| ID | Scenario |
|---|---|
| F1 | Night ER physician no-show; one RMO for ED and wards → roster gap → Coverage Resolver (T3) proposes; duty manager approves; ED shows "physician coverage: degraded" banner; triage nurse protocols (fast-track standing orders) stay valid → test: escalation ladders re-resolve to actual on-duty. |
| F2 | Triage nurse pulled into resus for 40 min → arrivals queue; per-patient SLA breaches recorded; digest attributes breach to `resus_concurrent=true` (load context, fairness rule) → test: KPI row carries concurrent-code flag. |
| F3 | Shift handover at 8 a.m. with 14 patients in ED → handover gate: each open episode acknowledged by incoming physician/nurse (`handover.acknowledged` — reuse IPD name); unacknowledged episode = alert at 30 min → test: 14 acks required. |
| F4 | Only one nurse eligible as narcotics witness across ED+ICU at 3 a.m. → S10 witness rule (cross-ward, remote-video last resort); roster publish would have blocked → test: roster with zero eligible witnesses does not publish. |
| F5 | On-call surgeon does not acknowledge Tier 1 page in 5 min → auto-climb to second surgeon + MS; both notified; delay attributable → test: `escalation.triggered` with rung 2 at 5:00. |
| F6 | ED in-charge on leave; deputy unfamiliar with disaster drill → drill tasks quarterly per role; readiness digest shows untrained deputy → test: bench-gap flagged (S10 mechanism). |
| F7 | Overloaded physician: 22 open episodes → `overload.flagged` (S10) to duty manager; second physician recall ladder → test: threshold configurable per level mix. |
| F8 | Ambulance crew exceeds 12-h duty → roster validation blocks dispatch assignment; exception evented → test: assignment refused with reason. |
| F9 | Verbal orders during Code → countersign queue within 24 h (RMO card) → test: unsigned verbal orders surface at handover. |
| F10 | Doctor-strike/mass leave → surge mode + management override flags; ED stays open (Clinical Establishments Act emergency duty) → policy, drill. |

### G. Equipment failure
| ID | Scenario |
|---|---|
| G1 | Defibrillator battery dead at Code Blue → device heartbeat/checklist failed shift check; biomedical critical ticket (30-min SLA); backup defib registry lookup shown on code screen → test: code screen lists nearest `available` defib. |
| G2 | Ambulance oxygen cylinder empty mid-transport → pre-trip checklist should have caught; incident; oxygen calculation in ventilated transport bundle → test: checklist item `o2_pressure ≥ threshold` required for ALS dispatch. |
| G3 | Portable X-ray in ED down → orders route to main radiology with transport bundle; TAT SLA relaxed with reason → test: order carries `modality_reroute`. |
| G4 | ECG machine prints but no digital upload → manual `stemi.diagnosed` with paper scan; clock unaffected → test: event requires no device link. |
| G5 | Crash cart seal broken, no code recorded → seal-check task finds mismatch → incident + leakage report → test: `crash_cart.opened` without `code.activated` within ±30 min flags. |
| G6 | Ventilator alarm silenced in ED bay, no telemetry → ED bays are not ICU; ventilated boarding > 2 h triggers ICU-nurse assignment rule → test: boarding of ventilated patient escalates at 2 h regardless of bed status. |
| G7 | Wristband scanner broken → keyboard entry of band serial with two-person confirm → C5. |
| G8 | Ambulance breakdown en route with patient → dispatcher reassigns second vehicle/108; trip splits into two legs; incident → test: trip supports `relay_to_trip_id`. |
| G9 | GPS device spoof/removed → vehicle `location_unknown`; dispatcher call; pattern to Fraud Sentinel (private trips) → test: pings gap > 15 min during trip flags. |

### H. Data quality, late-arriving, backdated
| ID | Scenario |
|---|---|
| H1 | Triage vitals entered 40 min late after a resus → `occurred_at` editable within episode, must be ≥ arrived_at and ≤ now; every backdate evented with reason → test: occurred_at < arrived_at rejected. |
| H2 | Doctor records disposition "admit" but patient actually went home → disposition change with reason; bed released; KPI uses final → test: `er.disposition_changed`. |
| H3 | Weight missing for a 4-year-old; adrenaline ordered → hard warning; Broselow band alternative; order allowed with override reason (clinical cap: warn, not block) → test: override reason mandatory. |
| H4 | MLC number written on paper during downtime clashes with a number later auto-issued → reserved ranges per kit (map 1); collision = reconciliation exception → test: gapless series check. |
| H5 | Referral letter from outside hospital has a different name spelling → referral captured verbatim; identity matched by phone/ABHA; both names kept → test: transfers.in stores source name. |
| H6 | Trip odometer end < start → validation error, supervisor override with reason. |
| H7 | Trauma registry ISS computed by abstractor agent from free-text notes → draft with provenance; human verify before registry counts → test: unverified rows excluded from KPI. |
| H8 | Ambulance pre-arrival says "STEMI" but ED ECG normal → pre-arrival flag stays as history; `stemi.diagnosed` never emitted; STEMI clock not started → test: pre-arrival suspicion ≠ diagnosis. |
| H9 | Patient's ABHA linked at ED by attendant's phone OTP → ABHA link needs the patient's own consent flow; attendant cannot; linkage deferred → test: abha.linked requires patient auth. |
| H10 | ICD coding of ED diagnoses done by MRD days later → coding is MRD's amend, event `diagnosis.coded` (MRD spec) — ED KPIs by triage reason codes, not ICD → note. |

### I. Fraud, leakage, gaming
| ID | Scenario |
|---|---|
| I1 | Triage nurse records `er.triaged` at arrival time to hit the 5-min KPI → integrity check: triage timestamp clustering vs vitals device timestamps and band-print time → Fraud Sentinel diagnostic → test: anomaly report row when triage_at − arrived_at < 20 s across > 30% cases. |
| I2 | ED consumables (IV sets, cannulas) used from sub-store never charged → daily orphan report per bay; leakage triangle issued vs charged vs counted per ED store → test: `charge.orphan_flagged` for `material.issued` to ED without consumption. |
| I3 | Doctor downgrades Red to Green to avoid disposition clock → downgrade requires co-sign and reason; pattern report → test: solo downgrade rejected. |
| I4 | Ambulance used for private trips; fuel claims → GPS trace vs trip ledger; km reconciliation; Fraud Sentinel → test: km without trip flags. |
| I5 | Treat-first credit granted repeatedly to the same "attendant" phone → credit register dedupes by contact; repeat > 2 in 90 days needs in-charge approval → test: third grant routes to approval. |
| I6 | Staff writes off ED bills for relatives → write-off approver ≠ grantor (SoD); relative-of-staff flag via staff-as-patient registry → collusion-dyad analytics (D-30). |
| I7 | Disaster mode declared to bypass elective OT gates or discounts → declaration through approvals, owner real-time alert, reconciliation mandatory, digest shows frequency (D-28 analogue) → test: every declaration in owner digest. |
| I8 | MLC "not registered" to spare an influential family → any staff can flag; Watchman scans ED diagnoses for MLC-indicating reason codes without MLC → T1 nudge to MS → test: RTA reason code without MLC → flag. |
| I9 | Patient impersonates PMJAY beneficiary → photo verification at cashless step (§11.14); care continues. |
| I10 | Referral kickbacks from external RMPs for ED admissions → attribution captured, payout structurally OFF for class (c) (fix 1). |
| I11 | Ambulance driver takes "tip" to bring patients to this hospital from 108 pickups → out of system, but referral-source field `108` cannot carry a payee → test: referrer class validation. |
| I12 | Crash cart restock inflated to pilfer adrenaline → par vs used vs code sheet cross-check (G5) → leakage. |

### J. Privacy, sealed records, VIP, staff-as-patient
| ID | Scenario |
|---|---|
| J1 | Politician brought after assault; press outside → VIP privacy flag (privacy only, not priority — D-37); alias on boards; single spokesperson; access logs reviewed; media query register → test: bay board alias; access-log review task created. |
| J2 | Staff peek at a celebrity's ED record → every read on flagged records is logged and surfaced next morning to MS; break-glass required outside treating team → test: `break_glass.used` count in digest. |
| J3 | Sexual assault case: WhatsApp visit summary must not go to the household phone → sealed-class propagation (D-25): neutral "collect at desk" notice or none → test: notification template class `sealed_neutral`. |
| J4 | Police ask at the desk "was X admitted?" → disclosure only via requisition/MS; desk script; logged → test: patient lookup by police role is not a permission. |
| J5 | Photographs of unknown patient shown on social media by hospital to find family → only via social-worker path with MS approval; watermark; purge on identification → O-8 policy. |
| J6 | DPDP erasure request for an MLC episode → refused with documented reason (MLC indefinite; §11.14) → test: dsr.fulfilled with `basis=legal_retention`. |
| J7 | Disaster family desk: enquirer describes a missing person; match found among Black tags → disclosure only face-to-face by designated staff, never by phone/WhatsApp → test: family_desk match outcome requires in-person actor. |
| J8 | Ambulance GPS history of a patient's home used for marketing → purpose limitation; GPS retention 1 y; no export to CRM → lint/test: no cross-module read of pings. |

### K. Language, literacy, accessibility
| ID | Scenario |
|---|---|
| K1 | Bhojpuri-only attendant, LAMA counselling → language field; interpreter (staff or phone) noted on LAMA form; two witnesses; thumb impression → test: lama.recorded with `interpreter` non-null when language ∉ {hi, en}. |
| K2 | Deaf patient in triage → pictorial pain scale; note; sign-language contact list from staff directory → UX. |
| K3 | Illiterate family signing two-doctor consent → thumb + witness rule; consent read aloud in language; audio recording optional where lawful (O-10). |
| K4 | Printed referral letter in English for a Hindi-speaking receiving PHC → bilingual header; clinical body English; QR to view → print design. |
| K5 | Visually impaired patient's discharge meds → large-print and voice note via WhatsApp (already supports audio) → notifications template. |
| K6 | Public board announces tokens; ED uses bay + tag numbers only; Hindi/English toggle → §11.5 locked. |

### L. Scale (100/day → 2,000/day; ED 10 → 250/day)
| ID | Scenario |
|---|---|
| L1 | ED census 60 concurrent at 8 p.m. → census board perf budget < 1 s render; WebSocket fan-out per ED screen; read model materialised → perf test in plan. |
| L2 | Boarding of 18 patients when ICU full → boarding board sorted by acuity × wait; single duty-manager thread with roll-up, not 18 alerts → B1 pattern. |
| L3 | 3 ED theatres running with major OT full → ED theatre booking via OT module `emergency` list; registry `theatre` status → dependency on OT plan. |
| L4 | Trauma registry at 30 activations/day → abstractor agent load; action budget config → §9. |
| L5 | 250 episodes/day × credit register → chase automation batches; owner digest shows ED credit ₹ outstanding aging. |
| L6 | Multi-site (site_id) future: ambulance fleet shared across sites → all ED tables carry site_id day one (events envelope already does). |
| L7 | 108 integration volume: dozens of pre-arrival calls/day → dispatcher worklist; phone-first capture (PBX CTI later). |

### M. Integration failures (device / vendor / ABDM / police)
| ID | Scenario |
|---|---|
| M1 | Police email bounces for intimation → intimation row `delivery_failed`; fallback physical intimation with receipt photo → Watchman. |
| M2 | ABDM care-context push fails for ER encounter → queued retry; never blocks; ABHA optional (§6). |
| M3 | Cath lab R&V vendor never sends `balloon.inflated` → manual entry by cath nurse; clock closes; vendor gap in digest → §11.19-A. |
| M4 | 108 (state EMRI) has no API → pre-arrival by phone; manual form; if a state API later exists, adapter under gateway module → §11. |
| M5 | Ambulance GPS vendor (e.g., generic AIS-140 tracker) feed stops → C7. |
| M6 | PACS down: trauma CT read on console; report later → order/result events on LIMS/radiology plan; ED shows "acquired, unreported". |
| M7 | WhatsApp Business template for staff recall not approved → SMS fallback; template registry status visible pre-drill → test: drill checklist verifies template status. |
| M8 | eSanjeevani/tele-ICU consult for stroke thrombolysis decision → teleconsult per Telemedicine Practice Guidelines 2020; consult.requested with `mode=tele`; consent → later CRM/teleconsult plan. |
| M9 | Blood bank system (in-house) unreachable for O-neg emergency issue → MTP paper issue; `unit.issued` backfilled; reconciliation per unit → §11.15 locked. |
| M10 | NHCX/TPA pre-auth API down on PMJAY emergency → 24-h window tracked as task; no cash → D4. |

### N. Clinical-protocol edge (ED-specific)
| ID | Scenario |
|---|---|
| N1 | Stroke onset unknown (wake-up stroke) → clock uses last-known-well; field mandatory on `stroke.suspected`; thrombolysis eligibility is the neurologist's — the system only displays the clock (clinical cap). |
| N2 | Sepsis screen positive in a Green patient → auto up-triage prompt (nurse confirms) → `er.retriaged(reason=sepsis_screen)`. |
| N3 | Paediatric dose calculated on stale weight from a visit 2 years ago → weight must be from this episode for weight-based ED drugs; stale weight rendered as "previous, unverified" → test. |
| N4 | Obstetric patient in ED with eclampsia; maternity floor not yet commissioned → ED manages; `labor.triaged` still emitted for registry; transfer-out path → transition boundary. |
| N5 | Anti-venom anaphylaxis → ADR register (`adr.reported`), stop, treat; vial batch captured → test: batch on `medication.administered(ASV)`. |
| N6 | Hypothermic drowning "dead" patient → Black at triage reversed to Red on physician exam → allowed, evented, brought-dead record voided with reason (never deleted) → test: register row status `voided`. |
| N7 | Psychiatric patient with suicide risk boarded 20 h in ED → suicide-watch order (nursing spec) + 1:1 sitter task; boarding escalation tightened → test: risk flag halves boarding thresholds. |
| N8 | Mass-casualty CBRN suspected → decontamination room registry status; PPE from infection-control cost centre; ED entry lock; Level 3 → drill. |
| N9 | Needle-stick to ED nurse during resus → `exposure.reported`, PEP first-dose clock 2 h ★ → §11.14 locked. |
| N10 | Violent attendant; Code Violet → security converge, police task, lockdown flag; staff-support follow-up; Medicare Service Persons Act (state Act) FIR support letter template with MS signature → test: code violet creates 3 tasks + incident. |

*(Row count: A12 + B12 + C12 + D20 + E20 + F10 + G9 + H10 + I12 + J8 + K6 + L7 + M10 + N10 = **158**.)*

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Bus overturn, 34 casualties, 22:40, Level 2 disaster.** 22:40 108 control calls; dispatcher logs `ambulance.prearrival_notified(fleet=external, count≈30)`. 22:42 ER head + duty manager declare via approvals (emergency class) → `disaster.declared`, `mode.context_applied`; owner gets real-time WhatsApp; staff-recall broadcast (WhatsApp → SMS → PBX) to second-shift ED, 2 surgeons, anaesthetist, blood bank, radiology; elective OT list for 06:00 frozen; surge bed board opens 12 extra ED trolleys (registry beds `surge`), ICU pre-empt rule lists 3 step-down candidates for intensivist. 22:50 DIS-tag packs unsealed (serials logged); triage nurse + 2 recalled nurses tag at the ramp: photo + colour + sex + approx age; Red → resus (3 bays), Yellow → bays, Green → OPD hall converted; Black (4) → brought-dead register, mortuary. All tags auto-MLC (one incident-level MLC series with per-tag sub-entries; police liaison officer named). 23:10 blood bank MTP posture; 6 O-neg uncrossmatched issued against tags (chain per unit). 23:30 family info desk opens in the lobby with the social worker; enquiries logged; disclosure of deaths only face-to-face. Agents: ED Census Digest switches to 15-min mode for duty manager; SLA Chaser suppresses per-patient triage alerts into one roll-up (fix 27: mode-aware); Triage-Note Drafter disabled by mode (no drafts during disaster); Bed-Request automation raises ward-side "prepare 10 beds" task. Paper: if the network fails, tags are paper-first anyway; a tag sheet per patient. 03:00 stand-down → `disaster.ended`; reconciliation queue: 34 tags → 27 registered to UHIDs (families), 3 provisional (unconscious), 4 brought-dead; consumables issued on the disaster cost centre reallocated by tag scans; police list matched; `disaster.reconciled` at T+52 h; debrief incident + drill score. Audit shows: declaration approval id, every tag issue/resolve, every unit issued, every recall delivery status, unallocated ₹ on the disaster centre.

**6.2 Server down 01:10–03:50 with 11 patients in ED.** Duty manager declares downtime (two-person, D-28); ED kit unsealed (serials logged on the kit sheet). Triage on paper sheets; MLC numbers from the reserved paper range; wristbands from the kit; PBX pages for a Code Blue at 02:15 (crash cart seal broken, paper code sheet). ED treats unconditionally; no cash is refused but every receipt is a serial from the downtime book (downtime cash reconciled at recovery by someone other than the declarer — fix 15). 03:50 core back; backfill screens: each paper sheet → episode with true `occurred_at`; Code Blue backfilled (agents ignore it — fix 28); MLC serials matched to the reserved range; leftover kit serials counted. Reconciliation report: 11 episodes, 1 code, 2 MLCs, ₹3,200 downtime cash, 0 unaccounted serials. Audit: `downtime.declared/.ended`, every backfilled event flagged, reconciler ≠ declarer.

**6.3 Physician no-show + trauma Tier 1 + STEMI, 03:00.** Roster shows one ER physician; night physician absent at 20:00 check (roster heartbeat) → Coverage Resolver proposed RMO-B; duty manager approved. 03:02 RTA Tier 1 arrives; `trauma.activated(tier=1)` pages surgeon/anaesthetist/ortho/blood bank/CT; surgeon-1 no ack in 5 min → auto-climb to surgeon-2 + MS. 03:09 STEMI walk-in: door-to-ECG 6 min, `stemi.diagnosed`; cath team paged; anaesthetist already in resus → conflict event; second anaesthetist paged. Only one physician: triage nurse runs fast-track standing orders; Clock Keeper shows both clocks on the wall board; duty manager physically present. Boarding: trauma patient to OT at 03:40 via emergency theatre; STEMI to cath at 03:55 (door-to-balloon 46 min later). Audit: every page's channel/ack, conflict rung, coverage approval; KPI rows carry `concurrent_codes=2`, `physician_coverage=degraded`.

**6.4 Anti-venom stock-out on a monsoon Monday.** 3 snake bites in 4 h; ASV stock hits 8 vials (par 40). `stock.below_reorder(ASV)` is an active alert → pharmacy + duty manager; emergency purchase under 40A(3) cash cap; sister-hospital borrow logged as `material.received(source=loan)`. Fourth patient at 14:00 needs 20 vials; 8 given, transfer-out to district hospital initiated (`transfer.initiated`, receiving doctor confirmed, ambulance own-fleet ALS, oxygen check). Family can't pay ₹6,000 for ASV → credit register. Audit: stock timeline, administration batches, transfer stabilisation checklist — the defensible record E20 demands.

**6.5 VIP + MLC + fraud attempt in one hour.** 19:00 a local MLA's nephew brought after a bar fight (assault → MLC); family demands "no MLC" and asks the desk to register under another name; press at the gate. System: MLC mandatory (E2), VIP privacy flag (alias on boards, D-37 no priority), single spokesperson named by duty manager, access logging heightened. 19:20 a "TPA card" is produced with a mismatched photo → insurance identity fraud path (D18): payer switch to self, incident, insurer notified; care unaffected. 19:40 attendant tries to have a staff member write off charges → write-off requires approval by a non-grantor; Fraud Sentinel logs the dyad. Audit trail: MLC register row, police intimation, access log with two break-glass reads flagged for MS review, incident, approval refusals.

**6.6 Ambulance breakdown with a ventilated transfer, power cut at ED.** 11:30 ALS ambulance carrying a ventilated refer-out breaks down 6 km out; dispatcher sees GPS stop + crew call; second vehicle dispatched with relay (`relay_to_trip_id`); oxygen remaining calculation from the transport bundle shows 48 min; receiving hospital re-confirmed. Simultaneously ED loses mains; UPS 20 min → `power_degraded` mode prints the ventilated-patient list; 2 boarded ventilated patients; biomedical critical ticket; DG set restores at 11:38. Audit: two trip legs, incident for breakdown, oxygen math on the checklist, mode events.

**6.7 Violence against staff, Code Violet, 23:30.** Death of a young patient after 6-h boarding; family assaults the ER physician. One-touch Code Violet from the bay screen → security converge, police task, lockdown flag, duty manager, owner real-time alert; incident opened; staff-support follow-up; Medicare Service Persons Act FIR support letter drafted from the incident record (T2 draft, MS signs). Next morning: mortality review task, boarding hours attributed to ICU capacity, digest shows boarding as the antecedent. Audit: boarding escalation rungs (who was notified when), code timeline, police task, incident RCA.

---

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | System form | Who signs | Retention |
|---|---|---|---|---|
| MLC register + police intimation | CrPC/BNSS duty to inform police (s. 39 CrPC → BNSS 2023 equivalents), IPC/BNS; state police manual | `mlc_register`, `mlc_police_intimations` (gapless series) | ER physician; MS oversight | indefinite (§11.14) |
| Injury report / wound certificate | Evidence rules (BSA 2023); court production | `mlc_injury_reports` (versioned, restricted) | ER physician (2FA), MS for release | indefinite |
| Evidence chain of custody | BSA; police procedure | `mlc_evidence_items` + custody log | two staff; police receipt | indefinite |
| Sexual assault examination | MoHFW Guidelines 2014; CrPC 164A/BNSS; POCSO Act 2012 (s.19 mandatory reporting, s.27 examination) | `sexual_assault_exams` (sealed), `pocso.intimated` | female doctor/attendant recorded; consent separate | indefinite |
| Brought-dead register | State CEA rules; Registration of Births & Deaths Act 1969 (MCCD) | `brought_dead_register`; MCCD via MRD | declaring doctor | permanent |
| Death in ED | RBD Act; MCCD Form 4; MLC re-intimation | MRD death register (ED writes via interface) | doctor | permanent |
| Restraint register | NABH (patient rights, COP), MHCA 2017 s.97 | `restraint_orders` | physician order; nurse monitoring | 10 y |
| LAMA/DAMA | NABH; medico-legal | `lama_records` | patient/guardian, 2 witnesses, counsellor | 10 y |
| Disaster incident & drill records | NABH FMS; District Disaster Management Plan | `disaster_incidents` + reconciliation | duty manager/ER head | 10 y |
| Ambulance | Motor Vehicles Act (fitness, insurance, PUC), AIS-125 ambulance construction code, NABH transport | vehicle expiries; checklists; trip ledger | dispatcher/EMT | 8 y ledger |
| Inter-facility transfer | CEA 2010 s.12 (emergency stabilisation duty), NABH | `transfers` + stabilisation checklist | physician | 10 y |
| Trauma registry | NABH quality; (optional) national trauma registry contribution | `trauma_registry` | abstractor + verifier | 10 y |
| Codes (Blue/Violet/Yellow) | NABH; state Medicare Service Persons & Institutions Act (e.g., Maharashtra 2010, UP 2013) | `code_activations` + incident | leader | 10 y |
| Occupational exposure | NACO PEP; NABH | `exposure.reported` | ICN | staff record |
| Notifiable diseases from ED (rabies, snake bite in some states, poisoning) | IDSP; state notifications | reporting task from reason codes (licensed list, §9) | MO | per IDSP |
| Cash & tax | §269ST, §40A(3), GST (ambulance services exemption; healthcare exemption) | billing engine config | CA | 8 y |
| DPDP 2023 | consent, purpose limitation, rights, breach | consent records, sealed classes, DSR register | DPO | per policy |

**NABH asks to see:** triage policy + compliance data; door-to-doctor; MLC procedure and register; restraint policy/register; code drill records; ambulance checklists and licences; transfer policy with stabilisation evidence; disaster plan + drills; patient-rights (LAMA counselling); consent policy; mortality review. **A police inspector demands:** MLC register entry, intimation proof, injury report (against requisition), evidence receipt. **A court demands:** certified extract with custodian certificate (D-22). **DPDP classes:** as §4.

---

## 8. Staff KPI & KRA

All event-derived, load-normalised (fairness rule), diagnostic only; metric ids target the KPI formula registry (roadmap note 5).

**ER Physician (card 10):** `ed.door_to_doctor_median` (er.arrived → consultation.started, by level; load: concurrent episodes) · `ed.disposition_median` (arrived → er.disposition_decided; by level) · `ed.ceiling_breach_rate` (sla.breached obs ceiling / episodes) · `ed.mlc_completeness` (Watchman score = intimation + signed report + re-intimations / MLCs) · `ed.return_72h_related_rate` · `ed.override_reason_rate` (prescribing alerts overridden with reason) · `ed.code_lead_documentation` (code sheets complete). KRA (S10): every ER episode reaches exactly one disposition, defensibly documented. Gaming: I3 (downgrade) needs co-sign; disposition timestamps vs bed/OT events cross-checked.

**ED Triage Nurse (new card 40):** `ed.triage_5min_compliance` (arrived → triaged ≤ 5 min; load: arrivals/15 min, concurrent code flag) · `ed.triage_accuracy` (proportion re-triaged up within 60 min by physician / triaged; and under-triage of later ICU admits) · `ed.vitals_completeness` · `ed.weight_captured_paeds` · `ed.lwbs_after_triage_rate`. KRA: no patient waits untriaged; no Red hides in Green. Gaming: I1 timestamp clustering check.

**ED Staff Nurse:** `ed.band_scan_compliance` · `ed.restraint_monitoring_on_time` · `ed.reassessment_task_on_time` (obs 4-hourly) · `ed.crash_cart_check_compliance` · `ed.handover_ack_rate`. KRA: bays run on scans and timers.

**ED In-Charge:** `ed.boarding_hours_total` and `ed.boarding_escalation_ack_time` · `ed.roster_publication_compliance` · `ed.stock_variance` (ED sub-store) · `ed.drill_participation`. KRA: the floor is staffed, stocked, and every boarder is somebody's escalation.

**Ambulance Coordinator / EMT:** `amb.dispatch_to_departure_median` (target < 5 min) · `amb.checklist_compliance` (100%) · `amb.prearrival_notified_rate` (trips with packet before arrival) · `amb.handover_ack_median` · `amb.km_reconciliation_variance` · `amb.vehicle_availability` (registry available hours / total). KRA: a ready vehicle, a ready crew, a warned ED.

**ED Registration Clerk / Cashier:** `ed.bedside_registration_median` (arrived → patient_id assigned) · `ed.unk_merge_median` · `ed.credit_register_recovery_rate` and aging · `ed.cash_variance`. KRA: identity caught up without ever gating care; treat-first money chased, not lost.

**Medico-Social Worker:** `ed.destitute_ladder_closure_days` · `ed.family_desk_enquiries_resolved` · `ed.charity_attributed_rupees`.

**Department-level (owner 8 a.m. digest lines):** ED census now / max overnight · arrivals by level · door-to-doctor median (L1/L2 vs L3–5) · LWBS % · boarding: patients now, total boarding hours yesterday, longest boarder (alias) and where the block was (ICU/ward) · 24-h ceiling breaches · MLCs registered / incomplete · brought-dead & deaths · codes (Blue/Violet/Yellow/STEMI/stroke/trauma) with clocks met/missed · ambulance trips, vehicle availability, failed checklists · ED credit ₹ registered / recovered / written off · break-glass reads on flagged records · disaster/surge/downtime declarations (frequency analytics).

---

## 9. AI agents & the copilot — where inference earns its place

| # | Name | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval / guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Triage-Note Drafter** | agent | T2 | nurse taps "draft" on triage form; inputs: tokenised complaint text, vitals, age band, sex, allergies (four-state), pre-arrival packet | structured triage note draft (chief complaint, red flags, suggested reason codes) — **never a level**; level suggestion only as `alert-restatement` of deterministic vitals rules | triage nurse edits + submits; level chosen by human | nurse types note; button absent when halted | per-agent; mode-aware (off in disaster) | model id, prompt ver, in/out hash on `er.triaged` | adversarial fixtures: instruction-shaped complaint text, name hallucination, level-suggestion leakage; shadow mode first | health (tokenised) | ED Plan 20, flag-inert until Class-1 lane gates pass |
| 2 | **Pre-Arrival Prep Briefer** | agent | T2 | `ambulance.prearrival_notified` with packet; prior-visit facts via Context Lens `ed-triage` pack | one-screen briefing (suspected STEMI/stroke/trauma, prior allergies/anticoagulants, bed/resus suggestion as observation) | ER physician reads; no action | packet renders raw | per-agent | on briefing event | citation guard; four-state | health | Plan 20b (after Lens Phase B) |
| 3 | **Disposition-Delay Chaser** | automation | T1 | workflow SLA states: in_treatment > threshold, disposition_pending with no bed/OT/ambulance progress, obs 20 h | nudges to physician/in-charge; roll-up threads; owner digest lines | none | SLA Chaser ladders (kernel) | automation flag | n/a | dedupe test; alarm-budget per shift | operational | Plan 20 (is SLA Chaser config + one ED rule set) |
| 4 | **MLC Completeness Watchman** | automation | T1 | mlc.registered, disposition/discharge/death/abscond events, ED reason codes (RTA/assault/burn/poison/bite) without MLC | completeness score; nudge at 2 h / 24 h; MS weekly list; "MLC-indicating diagnosis without MLC" flag | MS reviews | manual register review | automation flag | n/a | precision on reason-code map (curated list, Class B) | sensitive-legal (metadata only) | Plan 20 |
| 5 | **Bed-Request Escalation** | automation | T1→T3 | admission.requested(source=ED) unassigned at 60/120/240/360 min; ICU 30 min | rungs to in-charge → bed manager → duty manager → ER head/MS → owner SMS; T3: proposes bed-class protection (map 4) or step-down candidates for approval | duty manager approves T3 proposals | phone ladder | automation flag | n/a | rung timing tests; roll-up | operational | Plan 20 (T1); T3 with IPD bed board |
| 6 | **ED Census Digest** | automation | T0 | worker clock 15 min (disaster: 5 min) + 8 a.m. | census board read model; owner/duty-manager digest lines (§8) | none | screen query | automation flag | n/a | numbers reconcile to events (formula registry) | operational | Plan 20 (Digest Writer feed) |
| 7 | **ED Clock Keeper** | automation | T1 | stemi.diagnosed, stroke.suspected, sepsis.screen_positive, restraint.applied, er.observation_started, trauma.activated | wall-board clocks; nudges at 50/80/100% of target; ack timers on pages | none | wall clock + paper | automation flag | n/a | clock arithmetic golden tests incl. backfill | health metadata | Plan 20 |
| 8 | **72-h Return Flagger** | automation | T0 | er.arrived with prior episode ≤ 72 h | quality register row + relatedness prompt to physician | physician marks related/unrelated | none needed | automation flag | n/a | dedupe | health metadata | Plan 20 |
| 9 | **Ambulance Readiness Watchman** | automation (Expiry Watchman ext.) | T1 | vehicle expiries (fitness/insurance/PUC), checklist failures, drug-box expiry, O2 pressure below threshold | vehicle → `unavailable`; tasks to dispatcher/biomedical | dispatcher | paper checklist | automation flag | n/a | | operational | Plan 20a |
| 10 | **Trauma-Registry Abstractor** | agent | T2 | episode closed with trauma flag; tokenised notes, orders, outcomes | draft registry row (mechanism, scores, interventions) with citations | trauma coordinator verifies | manual abstraction | per-agent | on `trauma_registry` row | field-level accuracy eval on fixtures; abstain state | health (tokenised) | service-line trauma plan |
| 11 | **Incident/FIR Letter Drafter** | agent | T2 | Code Violet incident record | draft FIR support letter / incident narrative from event timeline | MS signs | template letter | per-agent | on document | no invention of facts beyond timeline (citation guard) | staff + legal | Quality pack |

**Deterministic beats inference here:** triage level (rules), clocks, escalations, MLC indication mapping, credit chasing, km reconciliation — all automations. Inference is confined to narration/drafting (1, 2, 10, 11), all T2, all clinical-cap compliant.

**Three presentation lanes:** Lane 1 hand-built keyboard/touch screens — triage form (tablet, large targets, one-beep band context), ED census/boarding board (wall + tablet), resus/code screen, dispatcher board, disaster tag console, MLC register screen. Lane 2 schema-generated worklists — MLC completeness queue, transfer packet checklist, restraint reviews, credit-chase queue, checklist forms, police-document-request queue, family-desk log. Lane 3 conversational copilot (clinical roles last, per ruling) — duty manager asks "who is boarding > 4 h and why", dispatcher asks "nearest available ALS", MS asks "MLCs missing intimation this week" — all via the 12a tool catalog with the asker's permissions. **Journey Feed contributions:** er.arrived/triaged/retriaged, clocks started/met, disposition, boarding rungs (with who was paged), MLC milestones (sealed-class aware), ambulance legs, transfer acceptance; agent posts are structured (a nudge is a task, a block is a refused transition).

**Concrete prompt inputs (Drafter #1):** `{age_band, sex, arrival_mode, triage_vitals{hr,bp,rr,spo2,temp,gcs,pain}, complaint_text_scrubbed, allergy_state(4-state), prearrival_packet_scrubbed?, reason_code_vocab(version)}` → output JSON `{summary, red_flag_observations[] (cited), suggested_reason_codes[] (from vocab), insufficient_evidence?}`; the level field does not exist in the output schema.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One-beep context:** signed-QR wristband from arrival (provisional or UHID); every bay tablet, order, sample, drug, transfer packet starts from a scan. Target: band issued < 60 s from arrival.
- **Triage in 5 taps:** level buttons with vitals-driven up-triage hints; device vitals (multipara monitor push, BP/SpO2 via Bluetooth/serial edge) pre-fill; weight/length band mandatory for paeds; complaint via voice-to-text (Hindi/English) with on-device scrubbing before the drafter. Target: median triage record < 2 min.
- **Pre-arrival packet → pre-created episode:** EMT tablet form; bay pre-assigned; clocks pre-armed. Target: 90% own-fleet trips with packet before arrival.
- **Clocks on the wall:** ED wall board renders active clocks (triage waits, STEMI/stroke/sepsis, boarding, obs ceiling) with colour, no names (alias/tag). Target: board latency < 2 s.
- **Order sets as data (Class B):** chest pain, stroke, sepsis, trauma, snake bite, OP poisoning, paediatric fever — one-tap sets with ER_STAT priority; sets are workflow/definition data, not code.
- **Roster-resolved one-touch codes and tiers:** ack-in-app with 5-min timers; PBX overhead as parallel channel.
- **Paper-parity printing:** triage sheet, MLC forms, injury report body chart, referral letter, PCR, LAMA form — all print with QR and the same field order as the screen (backfill speed).
- **Boarding board:** acuity × wait sort, one thread per shift, rung history visible. Target: request→assigned median < 60 min once IPD ships.
- **Credit register at the counter:** one screen, contact snapshot, promise date; no argument at 3 a.m.
- **Audit by construction:** every register is a table with append-only rows; hash-chained events; drafts stamped; sealed-class propagation. Measured targets: 100% MLCs with intimation row; 100% brought-dead with two-staff belongings; 0 charges without event.
- **Perf budgets:** census board < 1 s at 60 concurrent; band lookup < 300 ms (existing search budget); triage submit < 100 ms interactive.

---

## 11. Integrations, devices & dependencies

| Device / vendor | Protocol | Edge rule | Notes |
|---|---|---|---|
| Multipara monitors (ED bays; e.g., BPL, Mindray, Philips Efficia) | HL7 v2 ORU / vendor TCP; MQTT via edge | ED monitor edge service on mini-PC; per-second data never in core DB (§5) | vitals pre-fill; danger flags |
| 12-lead ECG (e.g., BPL Cardiart, GE MAC) | PDF/XML export, DICOM-ECG where supported | edge folder watcher → document + `stemi.diagnosed` manual | ambulance ECG transmit via 4G to ED (vendor cloud or WhatsApp image as last resort — image never auto-interpreted) |
| Defibrillators / AED | event log export (varies) | manual + checklist | crash cart device registry |
| POCT ABG/electrolytes (e.g., i-STAT, GEM) | ASTM/HL7 | LIMS analyzer edge (Plan 17), QC lockout | ED analyzer registry kind |
| Portable X-ray / CT | DICOM to Orthanc | PACS deferred; ED shows acquired/unreported | Plan 18 |
| Ambulance GPS (AIS-140 trackers; vendors like Trackmate/Onelap) | vendor API/MQTT | gateway module adapter; pings to telemetry store | O-11 |
| EMT tablet (PCR, checklist, pre-arrival) | HTTPS to core over 4G; offline-first with sync | SQLite buffer like lab edge | Android tablet + rugged case |
| PBX (bought) | SIP/CTI later | overhead paging for codes; DTMF-free | §9 locked |
| Pagers vs WhatsApp | WhatsApp Business (utility templates) + SMS + PBX; optional POCSAG pagers | Plan 10 gateway | O-12 |
| 108 / EMRI | phone today; state API if any | adapter under gateway | M4 |
| Police intimation | email/WhatsApp to PS + printed form with receipt | notifications gateway, template registry | M1 |
| ABDM/NHCX, PMJAY TMS | FHIR / scheme APIs | gateway | later plans |
| Cath lab R&V, blood bank, OT, ICU, maternity, LIMS, radiology, pharmacy, IPD bed board, MRD, mortuary, quality, security passes | module interfaces + events | | dependencies: Plan 13 (registry), 14 (procurement for ASV/emergency purchase), 16 (pharmacy sub-store, crash-cart par), 17 (POCT, ER_STAT TAT), 18 (emergency radiology), IPD cluster (beds, deposits, discharge), OT plan (emergency list), Plan 10 (channels), 12a (agent harness), roster module (on-call resolution), quality pack (incidents, drills) |

Events consumed: bed.waitlisted/assigned, patient.admitted/transferred, ot.booked, unit.issued, result.critical_flagged, medication.administered, task.*, notification.*, roster.published, approval.*, downtime.*, surge.*, code.activated, stock.below_reorder, batch.expiring, patient.merged/unmerged, consent.recorded, labor.triaged.

---

## 12. Buy vs build, hardware & rough INR budget

**Build (own tables + workflow, per law 1):** ED module (episode, triage, boarding, observation, MLC family, brought-dead, restraint, LAMA, credit register), ambulance/transfer module, disaster module, trauma registry, ED clocks/read models. **Buy/licence:** PBX (already), WhatsApp BSP (Plan 10), GPS trackers + vendor platform, EMT tablets, wristband printers/scanners, wall displays, clinical content (dose ranges, notifiable lists, Broselow tables — licensed), optional pagers, ambulance vehicles/fitment from certified body-builders (AIS-125). **Do not build:** dispatch CAD platforms, telemetry clouds, voice.

| Item | Qty (day-one → scale) | Est. ₹ |
|---|---|---|
| Triage/bay tablets (rugged Android/iPad, stands) | 4 → 16 | ₹25–40k each → ₹1–6.4 L |
| Wristband printers (Zebra ZD-class) + 2D scanners | 2 → 4 printers, 6 → 20 scanners | ₹35k + ₹6k each → ₹1.1–3.5 L |
| Wall boards (55" + mini-PC) | 2 → 5 | ₹60k each → ₹1.2–3 L |
| ED monitor edge mini-PC + network fit-out (VLAN per D-20) | 1 → 3 | ₹40k each + cabling ₹1–2 L |
| EMT tablets + 4G + mounts | 2 → 8 | ₹35k each → ₹0.7–2.8 L |
| GPS trackers + platform subscription | 2 → 8 vehicles | ₹8k + ₹3k/yr each |
| Pre-printed DIS-tag packs (signed QR, 200 tags), ED downtime kits | 1 set/quarter | ₹15–25k/yr |
| Pagers (optional POCSAG system) | 10 → 40 | ₹2–4 L system (O-12) |
| ALS ambulance (new, fitted) / BLS | 1 ALS + 1 BLS → 3 ALS + 3 BLS + 1 neonatal | ALS ₹35–55 L, BLS ₹15–25 L each (O-13) |
| Software effort | 3 plans (§14) | per phase token baselines; no licence cost |

---

## 13. Owner rulings needed

- **O-1 Treat-first credit thresholds.** Recommend: auto-write-off ≤ ₹2,000 to bad-debt cost centre (attributed, digest-visible); ₹2,001–25,000 billing-head approval; > ₹25,000 owner approval; chase ladder 3/7/15 days via Recall agent. Why: corporate hospitals run a "casualty credit" register with a small auto-write-off band; without a ceiling every night becomes a negotiation.
- **O-2 Green-to-OPD conversion fee & policy.** Recommend: allowed 08:00–20:00 when OPD runs, patient informed and consents, OPD consult tariff applies, no ED visit charge; outside OPD hours the ED fast-track tariff applies. Why: locked mechanism (§11.3) needs the fee number and hours.
- **O-3 PMJAY/state-scheme emergency posture.** Recommend: treat and raise pre-auth within 24 h; zero cash from beneficiaries; scheme-ineligible items counselled and consented before use. Why: legal/financial exposure is owner-owned.
- **O-4 Observation-unit billing model.** Recommend time slabs 0–6 / 6–12 / 12–24 h at ~40/60/80% of a general-ward day rate, nursing and consumables itemised. Why: money.
- **O-5 ED visit charge structure.** Recommend: one "ED visit" tariff by level (L1–2 / L3 / L4–5) + itemised procedures/consumables per event (leakage law 4); no bundled "casualty pack" that hides consumables. Why: money + leakage.
- **O-6 Brought-dead charges.** Recommend zero by default; ambulance/mortuary charges optional and waivable; death-in-ED charges accrue with respectful settlement (D-33). Why: money + reputation.
- **O-7 Alcohol/substance testing policy.** Recommend: clinical note of signs always; breathalyser only if clinically indicated; blood alcohol only on written police requisition or clinical indication, with chain of custody. Why: legal exposure.
- **O-8 Photo use for unknown-patient identification.** Recommend: internal + police only; social media only with MS approval, watermark, purge on identification. Why: DPDP exposure.
- **O-9 Ambulance as registry `device` vs new `vehicle` kind.** Recommend `device` under an ambulance-bay `room` now (no kernel edit); revisit if fleet > 5. Why: Plan 13's closed kind set is a governed choice.
- **O-10 Audio recording of consent/LAMA counselling.** Recommend: not day-one; revisit with counsel (DPDP purpose + consent). Why: legal.
- **O-11 GPS vendor & tracking policy.** Recommend AIS-140 tracker with API; retention 1 y; purpose limited. Why: purchase.
- **O-12 Pagers vs WhatsApp/SMS/PBX for codes.** Recommend: no pagers day-one; in-app ack + WhatsApp + SMS + PBX overhead; buy POCSAG only if measured ack times fail at scale. Why: purchase.
- **O-13 Own fleet size and 108/private tie-ups.** Recommend day-one 1 ALS + 1 BLS with a private-operator standby contract; grow with bed count. Why: capital purchase.
- **O-14 Disaster declaration authority & levels.** Recommend ER head or duty manager declare (locked), MS/owner ratify; Level thresholds 10/30 as §3.7. Why: policy.
- **O-15 Restraint policy.** Recommend the §3.11 defaults (1-h physician review, 4-hourly, 24-h MS review). Why: patient-rights policy.
- **O-16 Single spokesperson & VIP protocol.** Recommend duty manager names spokesperson per incident; VIP flag affects privacy only (D-37 locked). Why: reputation/policy.

---

## 14. Plan sketch — how this becomes phase documents

Roadmap places ED in IPD cluster stage (b); this document proposes splitting so that the ED front door can ship before the full IPD bed board, using the E-11 transition-boundary handoff for admissions (as the mini-OT does for overnight conversion).

- **Plan 20 — ED core.** T1 schema (er_episodes, triage, dispositions, provisional identities, belongings, observation, boarding mirror, restraint, lama, credit register, returns) · T2 `er_episode` + sub-definitions as workflow definitions (owner activates) · T3 triage screen (Lane 1, tablet) + census/boarding board · T4 UNK flow + merge via patients interface · T5 dispositions incl. E-11 handoff to incumbent IPD, refer-out stub, LAMA · T6 ED charges from events + credit register + Green-to-OPD · T7 ED Clock Keeper, Disposition Chaser, Bed-Request T1, Census Digest, 72-h flagger (all automations on 12a harness) · T8 Code Blue in ED (consumes kernel code system; mints `crash_cart.opened/.restocked` if ICU has not) · T9 downtime paper kit forms + backfill screens · T10 golden suite + mutants + drill script. Gates: Plan 13 live (bays as beds); Plan 10 channels; 12a harness; roster on-call resolution (interim: static on-call table).
- **Plan 20a — MLC, brought-dead & legal documents.** Register family tables (gapless series), police intimation flows + templates, injury report (versioned, restricted, 2FA sign), evidence custody, sexual assault/POCSO sealed path, brought-dead register + mortuary handoff, police-document-request queue with MS approval, court production hook (D-22), MLC Watchman. Gates: MRD custody interface; legal counsel review of forms (state police manual formats).
- **Plan 20b — Ambulance & inter-facility transfer.** Vehicles (registry device rows), checklists, trips workflow, EMT offline tablet app (PCR, pre-arrival), GPS adapter, transfer workflow + referral letter print, trip billing/cost centre, Readiness Watchman, Pre-Arrival Briefer (post Lens Phase B). Gates: O-9/O-11/O-13; gateway adapter pattern.
- **Plan 20c — Disaster mode, codes & clocks.** Disaster definition + approvals wiring + DIS-tag console + surge board + family desk + reconciliation queue; trauma tier activation + roster ladders; STEMI/stroke/sepsis clocks with cath/neuro interfaces; drill scoring. Gates: OT/ICU pre-empt rules need those modules (ship with stubs); template approvals for recall.
- **Service-line — Trauma registry** (roadmap item 8) with Abstractor agent, after 20c has ≥ 90 days of activations.

**Must be true before authoring Plan 20:** owner rulings O-1..O-6, O-14; ED floor commissioning date and bay count; police station jurisdiction + current MLC paper format; current casualty register; incumbent IPD admission handoff format; on-call roster source.

**Negative-space question — what absence is a signal here?** An arrival with no triage within 5 min; a triaged Red with no `consultation.started`; an RTA/assault/burn/poison reason code with no MLC; an MLC with no intimation row; a disposition "admit" with no `bed.assigned` in 60 min; a crash-cart seal event with no code; a code with no code sheet; a `material.issued` to ED with no consumption/charge; a trip with no handover ack; a DIS-tag with no resolution; a brought-dead with no belongings inventory; an ambulance shift with no checklist; a Yellow with no re-triage in 30 min; a restraint with no 1-h review; a 72-h return with no relatedness answer; a night with zero break-glass on a VIP admission (suspicious silence) — each is a Watchman rule, not a report.

**Staff edge-case interview questions (ED head / casualty sister / ambulance in-charge):**
1. What happens today when an unknown unconscious patient's blood group comes back and family later names him — has a wrong-patient transfusion near-miss ever occurred?
2. How are MLC numbers issued at night and what happens when the register is in the day office?
3. Which police station(s) do you intimate, by what channel, and how do you prove it?
4. How many patients board in ED on a typical Monday and where do they physically wait?
5. What do you do when a family refuses to pay for anti-venom or ARV?
6. When was the last time the crash cart was opened without a code — how did you find out?
7. How do you handle a sexual assault survivor at 2 a.m. — who examines, which forms, where is the kit?
8. Who decides refer-out when ICU is full, and how is the receiving hospital confirmed?
9. What does the ambulance crew do when oxygen runs low mid-transfer?
10. How did the last mass-casualty event go — how many patients had no name for how long?
11. How often are doctors threatened; what did security actually do last time?
12. Which VIP incident do you remember most — what leaked and how?
13. What breaks first when the LAN/server goes down at night?
14. How do you count consumables used in resus, and who bills them?
15. What does the police constable ask at the desk, and what do you show him?

---

## 15. Open questions & risks

1. **Brain death / organ donation (THOTA 1994):** §11.14 defers the committee protocol; ED needs only a flag and a hard rule that nothing in ED certifies brain death — confirm with counsel where the ED's role ends.
2. **MLC number series:** one hospital-wide gapless series (recommended, matches most state formats) vs ED-only series — confirm against the district police manual.
3. **State Act specifics:** the Medicare Service Persons Act varies by state; the FIR-support template and the "cognizable/non-bailable" language must be counsel-checked per state of operation.
4. **Ambulance GST treatment:** ambulance services by a hospital are generally exempt as part of healthcare, stand-alone ambulance services separately exempt — CA to confirm the config line.
5. **Kernel vs ED ownership of the code system:** §11.14/§11.15 imply a hospital-wide one-touch code subsystem; this document assumes kernel/ops owns `code_activations` and ED consumes — needs the ICU/kernel author's agreement before Plan 20c.
6. **`crash_cart.opened` event name:** mint here or in the ICU plan — whichever ships first; avoid two names.
7. **Roster/on-call module timing:** trauma tiers and codes need on-duty resolution; roster ships in the Phase-2 quality window — Plan 20 needs an interim static on-call table with the dead-end fallback (fix 11).
8. **LAMA event name:** IPD E5 machinery may mint `lama.recorded` first; align.
9. **Triage scale choice** (ESI-like resource-based vs CTAS-like time-based): recommended ESI-style mapped onto the locked colours; ED head to confirm; vitals tables are Class A definition data.
10. **Boarding attribution politics:** boarding hours attributed to the full unit, not the ED — the owner's digest must present it that way or the ED will be blamed for ICU capacity; risk of KPI misuse.
11. **DPIA additions:** unknown-patient photos, GPS traces, sexual-assault sealed class, drafter payloads for triage text — four new L1 lines for counsel.
12. **Disaster-mode drills before the module exists:** the paper DIS-tag pack and family-desk protocol should be drilled now (quarterly, tracked as tasks) so the module digitises a practised process, not an imagined one.
