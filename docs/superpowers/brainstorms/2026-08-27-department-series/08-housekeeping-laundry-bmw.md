# 08 — Housekeeping, Laundry/Linen, Bio-Medical Waste, Bed Turnover, Pest Control & Facility Hygiene — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED · **Roadmap home:** Track B, **Plan 19** (housekeeping + laundry + BMW), after Plan 13 (resource registry).

**Executive summary.** This module is the hospital's *hygiene fabric*: every cleaning act, every linen movement, every kilogram of waste, every bed that comes back into service — captured as tasks over the resource registry, so that "is this bed safe to put a patient in?" and "where did Tuesday's 42 kg of yellow-bag waste go?" are one query each, not a supervisor's memory. It is built almost entirely on things already locked: P3 (linen is request-to-issue), P5 (task-and-track), the Plan 13 registry (beds/rooms/floors with `cleaning` as the release state), the §11.19-A BMW manifest chain, §11.4 map 9 (isolation + deep-clean, bed blocked until verified), and the T4 **Turnover Dispatcher** named in §16. It is **NOT**: a bed board (IPD-module rules over the registry), a maintenance/biomedical CMMS (document 19), a CSSD module (§11.10, Plan 15-era), an HR/attendance system (bought — it *consumes* contractor attendance), a procurement system (Plan 14 owns chemicals/consumables purchase), or a document-management system for SOPs (Expertise store, Quality pack). It is also the **conversational-surface pilot cohort** (roadmap deferred note 3): Lane-2 schema-generated worklists + Lane-3 conversation, no hand-built dashboards.

The three hardest problems: **(1) the turnover clock is a capacity clock** — every minute a discharged bed sits `cleaning` unverified is a bed the admission desk cannot sell, yet a bed verified too fast is an infection event; the dispatcher must be aggressive and the verifier must be un-hurryable. **(2) BMW is a chain-of-custody problem with criminal exposure** — the BMW Rules 2016 (as amended 2018/2019) make the *occupier* (the hospital) liable from generation to CBWTF handover, with barcode labels, daily weighing, 48-hour storage, and a Form-IV annual return; a gap in the chain is not a reporting error, it is an SPCB notice. **(3) the workforce is outsourced, semi-literate in English, phone-first, and rotates** — the system must be usable by a GDA with a ₹8,000 Android phone and Hindi/Bhojpuri, must prove work happened without becoming surveillance theatre, and must compute contractor SLA penalties from events the contractor cannot game.

---

## 1. Frame — what exists, what is locked, what this document adds

**Locked decisions inherited (not re-litigated):**

| # | Source | Decision |
|---|---|---|
| L1 | §10.1 P3, P5 | Linen/CSSD are request-to-issue (P3); housekeeping/transport/maintenance are task-and-track (P5: assign → accept → do → verify). |
| L2 | §10.2, brief law 2 | Every SLA-bearing lifecycle is a versioned **workflow definition**; modules mirror engine state, never own it. |
| L3 | §11.2 discharge step 8 | Bed released → housekeeping task → cleaned → **verified** → bed board available. |
| L4 | §11.4 map 9 | Isolation flag → discharge → **deep-clean task with supervisor verification, bed blocked until verified**; PPE to infection-control cost center; HAI/NABH registers self-feed. |
| L5 | §11.10 | Linen: par stock per ward by category; **bundle counts** at dirty pickup and clean delivery; **per-piece tagging deferred**; infected linen separate stream; monthly loss variance per ward. |
| L6 | §11.10 | Expired stock → witnessed destruction with certificate, **BMW-compliant**. |
| L7 | §11.12 | Support services = **pooled queues with claim discipline**; escalation resolves to on-duty role holder, never a named person; mid-shift departure returns tasks to pool. |
| L8 | §11.15, §11.16 | Terminal cleaning as verified task (ICU); OT fumigation/validation cycles + microbiological surveillance on schedule — **failure blocks the theatre until re-validated**; theatre environment is a telemetry domain. |
| L9 | §11.18 (v4.6), Plan 13 | Floor → ward/hall → room → bed lives in the **kernel resource registry**; bed/room kinds carry `available / occupied / cleaning / blocked / retired`, `onRelease = cleaning`. Bed-board rules (gender, isolation, census) are IPD rules over the registry. |
| L10 | §11.19-A | BMW chain: segregation at source → **weigh + barcode manifest per bag category** → signed vendor handoff → auto-fills statutory annual return; `bmw.manifest_recorded` exists. Dialysis RO water quality is utility telemetry (`water_quality.recorded`). |
| L11 | §11.14 | Grievance workflow (`grievance.raised/.resolved`), needle-stick → PEP clock, incident register. |
| L12 | §16 | **Turnover Dispatcher = T4 automation** (bed-turnover dispatch and re-dispatch), ships with IPD; automations are deterministic under the agent harness. |
| L13 | §11.19-C/D | CLRA principal-employer registers for outsourced pools via the HR-evidence bridge; contractor licences on the compliance calendar; signed QR tokens (a photographed static QR fails). |
| L14 | Roadmap Plan 19 | "Task fabric over the registry; linen cycle; CPCB colour-coded segregation, daily weighing, manifest chain to the CBWTF vendor, annual returns." Track B = conversational-surface pilot. Owner action already open: **CBWTF contract + SPCB authorisation details**. |
| L15 | S10 cards 32, 38, 31, 33, 34 | Housekeeping Supervisor (+pool), Infection Control Nurse (BMW segregation audits, isolation compliance), Duty Manager, Biomedical Engineer, Security Supervisor. KPIs diagnostic, never punitive, load-normalised. |

**What this document adds:** the turnover sub-state machine *inside* the registry's `cleaning` status; the generic P5 task fabric (proposed kernel component, first consumer = housekeeping); area classes and checklist templates with frequency/audit; the BMW register set as tables; linen bundle cycle tables; pest/fumigation/environment-sampling registers; QR scan-to-complete and scan-to-complain; contractor SLA computation; the Turnover Dispatcher's rules; three T1 automations and one T2 router; ~100 edge rows.

**Scope boundaries / who owns what table:**

| Concern | Owner | This module's relation |
|---|---|---|
| `resources`, `resource_status_history` | kernel (Plan 13) | references bed/room/floor ids; calls `resources.setStatus` via declared interface only |
| Bed board, admission, discharge cascade, isolation flag | IPD module (later) | consumes `resource.released`, `isolation.flagged`, `patient.deceased`, `patient.discharged` |
| `tasks` (P5 generic) | **proposed kernel component, delivered by Plan 19** | housekeeping is the first consumer; transport/maintenance/nursing reuse |
| Chemicals, bags, PPE stock; purchase | Plan 14 stores/procurement | consumes via P3 issue to `HK` cost centre; MSDS document refs stored here, items there |
| Contractor attendance, wages | bought HR/biometric SaaS | consumed via `roster.synced` / HR-evidence bridge; SLA computed here |
| Maintenance tickets, AMC, lifts, AC, fire | document 19 (biomedical/maintenance) | HK raises tickets via the same `tasks` fabric with `kind = maintenance` |
| Incident, grievance, HAI registers | quality pack | HK emits `incident.reported`, `grievance.raised`; ICN reads HK audits |
| CSSD sets, scope reprocessing | Plan 15 / CSSD | out of scope; only "OT turnover cleaning" is here |
| Mortuary register, body release | §11.14, mortuary module | mortuary *cleaning* tasks here; register there |

---

## 2. Actors, roles & role cards

| Role | S10 card | Shift / bundling | Touchpoints |
|---|---|---|---|
| **Housekeeping Supervisor** | #32 | 3 shifts; night bundles with Duty Manager if pool < 3 | pool queue oversight, verification of deep-clean/terminal cleans, spot audits, contractor SLA sign-off |
| **Housekeeping Attendant / GDA (pool)** | #32 pool | outsourced (CLRA); 3 shifts; night skeleton | claims tasks, scans QR to start/complete, photos, spill response, BMW bag sealing at ward |
| **Ward Nurse In-charge** (verifier) | S10 nursing #21-ish | per ward | verifies routine bed turnover (not deep clean), raises ad-hoc HK tasks, tags linen counts |
| **Infection Control Nurse** | #38 | day; on-call | terminal-clean protocol owner, environment sampling, BMW segregation audits, spill kit audits |
| **BMW Officer / Waste Handler (NEW card #40 proposed)** | — | day + evening; night = ward staff seal only | weighing, barcode labelling, storage room custody, CBWTF handover signature, Form IV, accident reporting |
| **Linen Room In-charge (NEW card #41 proposed)** | — | day (06:00–20:00 two persons); night: ward par only | bundle counts in/out, par replenishment, condemnation, vendor challans, loss variance |
| **Laundry vendor / in-house laundry operator** | external | — | receives dirty bundles, returns clean; signs counts |
| **CBWTF vendor driver** | external | daily pickup window | signs manifest, scans bag barcodes on pickup |
| **Pest control vendor technician** | external | scheduled | scans area QR per treated zone, logs chemicals used |
| **Contractor site supervisor** | external | per shift | attendance sync, disputes SLA computations, no HMIS write beyond acknowledging |
| **Duty Manager** | #31 | 24×7 | escalation terminus below owner; declares floor-scoped downtime |
| **Biomedical Engineer** | #33 | day | HK-raised maintenance tickets (AC, lifts, RO, fumigator) |
| **Security Supervisor** | #34 | 24×7 | BMW storage room access, night spill escort, visitor QR complaints at gate |
| **Quality Manager / NABH coordinator** | 9A | day | audit schedules, KPI reads, SOP versions |
| **Medical Superintendent / Occupier signatory** | — | — | signs Form IV annual return, Form I accident report, SPCB correspondence (owner or MS — ruling O-3) |
| **Patient / attendant / visitor** | — | — | scans toilet/room QR to rate or complain (no login) |

**Agents & automations (all under the 12a harness; details §9):** Turnover Dispatcher (T4 automation) · BMW Manifest Gap Watchman (T1 automation) · Checklist-Miss Nudger (T1 automation) · Patient-Complaint Router (T2 agent — classifies free text, drafts a task; human confirms) · SLA Chaser (existing, consumes `sla.breached`) · Leakage Auditor (existing; linen loss + chemical consumption triangles) · Digest Writer (existing; consumes this module's KPI events).

**SoD hard pairs (RBAC-enforced, extend S10 §11):** task doer / task verifier (never same user, even if supervisor cleaned) · BMW bag sealer / storage-room weigher for the *same* bag is allowed (one person at night) but **weigher / CBWTF handover signatory must differ from the vendor's scan** (two-party handover) · contractor site supervisor / SLA penalty approver · linen custodian (linen room) / linen cycle counter · spot-audit auditor / attendant audited (auditor never audits own claimed tasks) · pest vendor / pest log verifier.

---

## 3. Core flows as workflow definitions

All definitions below are **proposed drafts** for owner activation (§10.4). Each is a workflow definition version 1; the module mirrors state onto its own tables and never owns it.

### 3.1 Bed / room turnover (P5, the capacity clock)

The registry says `cleaning`; the workflow instance says *where inside cleaning*. Registry status changes **only** at the two ends (`resource.released` → `cleaning`; verified → `available`).

```
resource.released (bed)            [IPD emits; trigger]
      │
      ▼
 DIRTY ──dispatch──▶ ASSIGNED ──accept──▶ IN_PROGRESS ──complete(scan+photo)──▶ CLEANED
   │                    │                     │                                    │
   │ (no claim 5m)      │ (no accept 5m)      │ (no complete: class SLA)           │ verify (nurse i/c or supervisor)
   ▼                    ▼                     ▼                                    ▼
 RE-DISPATCH  ◀──────── RE-DISPATCH ◀──────── ESCALATE ──▶ supervisor ──▶ duty mgr    INSPECTED ──pass──▶ READY ──▶ registry: available
                                                                                       │ fail
                                                                                       ▼
                                                                                 REWORK → IN_PROGRESS (counter++)
```

| State | Allowed roles (transition out) | SLA (routine / deep-clean / terminal) | Escalation ladder |
|---|---|---|---|
| DIRTY | Turnover Dispatcher (auto) or supervisor (manual dispatch); any pool member may **claim** | claim ≤ 5 min | 5 m → re-dispatch to next eligible; 10 m → supervisor; 20 m → duty manager (`task.escalated`) |
| ASSIGNED | assignee accept / decline (with reason) | accept ≤ 5 min | same as above |
| IN_PROGRESS | assignee complete; supervisor reassign | routine 30 m · deep-clean (isolation/soiled) 60 m · terminal (death/isolation/outbreak) 90 m · OT between-case 20 m · OT terminal 45 m | breach → supervisor; +15 m → duty manager; bed board shows "delayed" |
| CLEANED | nurse in-charge (routine) / supervisor (deep) / **ICN or supervisor** (terminal) verify | verify ≤ 10 min | 10 m → nudge verifier role; 20 m → supervisor may verify routine himself only if not the cleaner (SoD) |
| INSPECTED→READY | system | — | `task.verified` → `resources.setStatus(available)` → `resource.status_changed` |
| REWORK | assignee | 15 m | 2nd rework → supervisor must attend in person |

**Variants (corporate-standard):** *Transfer-out* (ward→ICU) releases the ward bed identically. *Death on ward* → terminal clean + linen to infected stream + mattress cover change mandatory item. *Isolation discharge* → deep or terminal per ICN's isolation class (contact/droplet/airborne), UV/fogging item added, bed stays `blocked` (not `cleaning`) until ICN verifies (map 9's "bed blocked until verified"). *Pre-admission touch-up* when a bed was ready > 24 h: dust-down task, no re-verify, does not change registry status. *Room (private) turnover* = bed turnover + bathroom + AC filter item + attendant couch linen. *OT between-case* = theatre kind, SLA 20 m, verify by OT in-charge, no registry status change until sign-out (theatre kind vocab declared by Plan 15, not here).

**Events:** consumed `resource.released` · `patient.discharged` · `patient.deceased` · `patient.transferred` · `isolation.flagged` · `bed.assigned` (to detect a bed assigned while not READY — a hard alarm). Emitted: `task.created` · `task.assigned` · `task.accepted` · `task.completed` · `task.verified` · `task.escalated` (all existing) · **NEW** `turnover.dispatched` (payload: bed id, class, rule fired, candidates considered) · **NEW** `turnover.redispatched` (reason: no_claim / declined / mid_shift_departure / verifier_fail) · **NEW** `turnover.rework_ordered` · **NEW** `turnover.ready` (bed, minutes dirty→ready; the KPI source).

### 3.2 Scheduled cleaning rounds & checklists (P5 recurring)

Area classes (proposed, configurable): **A — critical** (OT, ICU halls, NICU, labour room, dialysis, cath lab, CSSD) · **B — clinical** (wards, ER, OPD consult rooms, labs, blood bank, pharmacy) · **C — public** (OPD waiting, lobby, corridors, lifts, toilets, attendant mess/waiting) · **D — support** (stores, offices, mortuary, BMW room, laundry, gas room) · **E — external** (compound, parking approach, drains).

| Class | Frequency (default) | Checklist template | Verifier | Audit |
|---|---|---|---|---|
| A | between cases + end-of-list terminal + weekly deep + fumigation schedule | OT/ICU template (high-touch, floors, walls to 2 m, vents, sluice, scrub sinks) | OT/ICU in-charge daily; ICN weekly | ICN monthly swab schedule; NABH HIC |
| B | 2× daily + spot | ward template (beds, lockers, rails, IV stands, nurses station, dirty utility, sluice) | nurse in-charge | supervisor weekly spot; quality monthly |
| C toilets | **hourly 07:00–22:00, 2-hourly night**; scan-to-complete | toilet template (WC, basin, floor, bin, soap, tissue, odour, water) | supervisor random | patient QR rating |
| C others | 3× daily | public template | supervisor | — |
| D | daily; BMW room after every pickup | support template | dept in-charge | ICN monthly for BMW room |
| E | daily | external template | supervisor | — |

Each scheduled run is a `tasks` row created by the scheduler (`kernel/worker/scheduler.ts`, `every`/`dailyIst`) with `due_at`; **missing** = no `task.completed` by `due_at + grace`. States: SCHEDULED → CLAIMED → DONE(scan) → (sampled) VERIFIED / MISSED / SKIPPED(reason: area occupied/OT in use/closed). SLA per class: grace 15 m (A/C toilets), 60 m (B), 120 m (D/E). Ladder: MISSED → nudge pool (T1 Checklist-Miss Nudger) → 2nd miss same area same day → supervisor → 3 misses/week → quality manager reads it in the digest (diagnostic).

Events: **NEW** `checklist.completed` (template id/version, items ticked, items failed, photo refs, scanned QR id, duration) · **NEW** `checklist.missed` · **NEW** `checklist.skipped` · **NEW** `area.inspected` (auditor, score, findings, photos) · **NEW** `area.audit_failed`.

### 3.3 Spill response (P5 urgent; blood/body fluid · mercury · cytotoxic · chemical)

REPORTED (any staff, one tap from any screen, or visitor QR) → DISPATCHED (nearest on-duty attendant with spill-kit competency; cytotoxic → trained handler only, ICN notified) → CONTAINED (cordon, PPE) → CLEARED (kit used → BMW yellow/cytotoxic bag sealed; mercury → sealed container, **never** in BMW bags — hazardous waste stream under Hazardous & Other Wastes Rules 2016) → VERIFIED (supervisor; ICN for cytotoxic/mercury) → incident register if exposure or patient fall. SLA: dispatch ≤ 3 m, contained ≤ 10 m, cleared ≤ 30 m. Events: **NEW** `spill.reported` (class, location resource, reporter) · **NEW** `spill.cleared` · existing `incident.reported` · `exposure.reported`.

### 3.4 Bio-medical waste chain (P3-shaped custody; statutory)

```
GENERATED (segregated at source into colour bag)  ──seal+label──▶ SEALED (barcode label printed at ward, category, ward, date-time, sealer)
   ──collected on round──▶ IN_TRANSIT (trolley, closed) ──arrive──▶ RECEIVED_AT_STORE (scan) ──weigh──▶ WEIGHED (kg, scale id, weigher)
   ──manifest for the day──▶ MANIFESTED ──CBWTF driver scans each bag + signs──▶ HANDED_OVER ──vendor uploads/treatment cert──▶ TREATED
   exceptions: 48h breach → STORAGE_BREACH ; missing bag on pickup → GAP ; bag opened/leak → INCIDENT ; category mismatch found at store → RE_SEGREGATED (logged, never silently fixed)
```

Categories (BMW Rules 2016 Schedule I, as amended 2018): **Yellow** (a–h: human anatomical, animal, soiled, expired/discarded medicines incl. **cytotoxic (yellow, separate labelled container)**, chemical waste, chemical liquid, discarded linen contaminated, microbiology/lab waste pre-treated) · **Red** (contaminated recyclable plastics: tubing, catheters, IV sets, gloves) · **White (translucent, puncture-proof)** (sharps incl. needles, scalpels, metal) · **Blue** (glassware, metallic implants) — cardboard box/puncture-proof. Per rule 8 & Schedule I: **no storage beyond 48 hours**; bar-code labelling mandatory; **daily weighing per category**; pre-treatment (autoclave/chemical) of lab/microbiology and blood bags before yellow disposal; **deep burial applies only where no CBWTF within 75 km — not applicable here**; liquid waste to ETP with discharge per Schedule II norms; mercury to authorised hazardous-waste recycler; general waste (SWM Rules 2016) never in BMW colours. Occupier duties: authorisation (Form II → Form III), annual return **Form IV by 30 June**, accident report **Form I within 24 h**, records for **5 years**, display of segregation charts, annual training and immunisation (Hep B, tetanus) of handlers.

| State | Role | SLA | Escalation |
|---|---|---|---|
| SEALED | ward staff / HK attendant (label printer or pre-printed serialised labels) | bag ≤ 3/4 full or ≤ 24 h open for yellow anatomical (config) | — |
| IN_TRANSIT → RECEIVED | HK waste round (2×/day, extra on demand) | collection round ≤ 12 h from seal | 12 h → supervisor; 24 h → BMW officer |
| WEIGHED | BMW officer / night: security-escorted attendant | same day as receipt | end-of-day unweighed → gap watchman |
| MANIFESTED → HANDED_OVER | BMW officer + CBWTF driver (two-party scan) | daily pickup window; **hard 48 h from seal** | 36 h → BMW officer + duty manager; 44 h → MS; 48 h → `bmw.storage_limit_breached` + Form-I-style internal incident |
| TREATED | vendor certificate (monthly) | monthly | missing cert → compliance calendar task |

Events: existing `bmw.manifest_recorded` · **NEW** `bmw.bag_sealed` · `bmw.bag_received` · `bmw.bag_weighed` · `bmw.handed_over` (manifest id, bag ids, vendor signatory, vehicle) · `bmw.gap_flagged` (bag sealed but not on any manifest / weighed but not handed / handed but not weighed) · `bmw.storage_limit_breached` · `bmw.mis_segregation_found` · `bmw.accident_reported` (Form I) · `bmw.return_filed` (Form IV) · `bmw.treatment_certificate_recorded`.

### 3.5 Linen cycle (P3 request-to-issue, bundle-level)

Ward par (by category: bedsheet, drawsheet, pillow cover, blanket, patient gown, towel, OT gown/drape sets, scrub suits, curtains) → **dirty pickup**: ward staff + linen attendant count bundle by category → `linen.bundle_dispatched` (counts, ward, infected flag → yellow bag route, sealed, no counting at ward for infected — counted post-wash) → laundry (in-house or vendor challan) → **clean delivery** count → `linen.bundle_received` → ward par restored; shortfall → `material.requested` (linen issue from linen store) → monthly reconciliation: (par + issued − returned − condemned − in-process) = variance → `linen.variance_flagged` → approval-gated write-off → cost centre. Condemnation (torn/stained beyond use): witnessed, `linen.condemned`, reuse as rags or BMW yellow if contaminated. Isolation/infected linen: separate red-lined trolley, hot-wash 71 °C ≥ 25 min or chemical per CDC/NABH HIC, never mixed. Patient-owned items: not tracked except lost-and-found register. Events: **NEW** `linen.bundle_dispatched` · `linen.bundle_received` · `linen.variance_flagged` · `linen.condemned` · `linen.par_breached` · existing `material.requested/issued/returned`.

### 3.6 Pest control, fumigation & environmental surveillance (P5 recurring + registers)

- **Pest control:** vendor schedule (default: general pest fortnightly, rodent bait-station check weekly, fogging monthly, anti-termite annual, kitchen/mess weekly); technician scans area QR → `pest.visit_recorded` (chemical, batch, concentration, areas); staff/visitor sighting → `pest.sighting_reported` → ad-hoc vendor task with 24 h SLA; ICU/OT/NICU sightings → ICN + incident.
- **OT/critical-area fumigation/fogging** (H2O2 fogger or per ICN SOP; formaldehyde discouraged): triggers = weekly schedule, post-infected-case, post-construction, post-surveillance-fail; workflow: BOOKED (theatre blocked on OT board — Plan 15 consumes) → FOGGED (device id, dwell) → AIRED → **SWABBED** → RELEASED only when `environment_sample.resulted = pass` (§11.16 lock). Events: **NEW** `fumigation.completed` · `environment_sample.collected` · `environment_sample.resulted` (pass/fail, CFU, site).
- **Water:** overhead tank cleaning 6-monthly (task + photo + certificate), potable water microbiological test monthly, dialysis RO conductivity/endotoxin per §11.19-A telemetry (`water_quality.recorded` consumed; failure → dialysis board block is *dialysis-module* logic; HK owns the tank/plant cleaning task).
- **AC/HVAC filter cleaning, lift sanitisation, fire-exit clearance rounds:** HK checklist items; failures raise `tasks(kind=maintenance)` to document 19's queue.

### 3.7 Patient/visitor QR feedback & complaint (P7 → P5)

Signed QR on every toilet/room/ward door (L13: signed payload, rotates on reissue). Scan opens a no-login page (Hindi/English, icons) → rate 1–5 + optional category chips (dirty / no water / smell / no soap / pest / other) + optional photo → `rating.received` / `hk.complaint_raised` → Patient-Complaint Router drafts a task → routine: auto-created in pool as class-C urgent (T3 behind rule — see §9) → supervisor sees; grievance-class text (rudeness, harassment) → §11.14 grievance workflow, never a HK task. Rate limiting per QR per device; abuse pattern → Fraud Sentinel diagnostic.

### 3.8 Contractor manpower & SLA (bought attendance, computed penalties)

`roster.synced` from HR/biometric brings the contractor roster; HK's Lane-2 worklist shows *deployed vs contracted* per shift per floor. Nightly automation computes: manpower shortfall (contracted − present), turnover SLA hit rate, checklist completion, audit score → `sla_penalty.computed` (draft) → contractor site supervisor acknowledges/disputes within 48 h → operations approves → Tally export line (credit against invoice). CLRA: Form XIII register data via HR-evidence bridge (L13). Events: **NEW** `contractor.shift_reconciled` · `sla_penalty.computed` · `sla_penalty.disputed` · `sla_penalty.approved`.

---

## 4. Data model sketch

**Kernel component proposed: `tasks` (P5 generic — the "task fabric").** `id` ULID · `kind` (turnover | scheduled_clean | spill | bmw_round | linen_pickup | pest | fumigation | maintenance | transport | adhoc) · `subkind` · `resource_id` → `resources` · `patient_id?` · `encounter_id?` · `pool_role` (which on-duty role may claim) · `priority` · `workflow_instance_id` (the state lives there) · `claimed_by?` · `due_at` · `sla_class` · `template_id?` · `origin` (event id / user / agent / qr) · `site_id` · audit columns. `task_claims` (history of claim/decline with reasons). `task_evidence` (task id, type photo|scan|note|signature, storage ref, hash, captured_at, device id, lat/long?). Housekeeping owns the module tables below; transport/maintenance later reuse `tasks`.

**Module `housekeeping` tables:**
- `hk_areas` — resource_id (any registry kind or a HK-only `area` row: toilets, corridors, lifts as **`room` kind children under a floor**; no new registry kind needed — attributes jsonb carries `area_class`, `qr_token`) · class A–E · frequency profile · verifier role · active checklist template version.
- `hk_checklist_templates` (id, name, version, area_class, items jsonb [item id, label hi/en, mandatory, evidence_required photo|none, chemical_ref], approved_by, effective_from) — **versioned like workflow definitions**; runs pin the version.
- `hk_checklist_runs` (task_id, template_version, items_result jsonb, scanned_qr, started_at, completed_at, duration_s, skipped_reason).
- `hk_turnovers` (bed resource id, released_at, dispatched_at, claimed_at, started_at, cleaned_at, verified_at, class routine|deep|terminal|ot, rework_count, verifier_id, cleaner_id, minutes_to_ready) — mirror table for KPIs; source of truth is events.
- `hk_audits` (area, auditor, template, score, findings jsonb, photos, at) · `hk_audit_findings` (finding → corrective task id).
- `hk_spills` (class, location, reporter, dispatched/contained/cleared timestamps, kit id, exposure incident id?).
- `hk_chemicals` (item ref → Plan 14 item master, dilution ratio, contact time, MSDS document ref, hazard class, approved_by ICN, effective) · `hk_chemical_issues` (mirror of P3 issue to HK cost centre by floor) — for consumption-per-sqm variance.
- `hk_qr_tokens` (resource id, signed token, issued, revoked, reason).
- `hk_ratings` (qr token, score, categories, photo ref, device hash, at, task id?) · complaints route to `tasks` + `grievances`.

**BMW statutory registers as tables (5-year retention minimum; recommend 10):**
- `bmw_bags` (id = barcode, category yellow|red|white|blue|cytotoxic|chem_liquid|mercury_hw, source resource id (ward), sealed_by, sealed_at, received_at, weighed_at, weight_kg, scale_id, manifest_id?, handed_over_at, anomaly?)
- `bmw_manifests` (id, date, vendor id, vehicle no, driver name/id, bags[] by category with kg totals, hospital signatory, vendor signatory (scan/e-sign), pickup_at, treatment_cert_ref?) — **is** the manifest chain of §11.19-A.
- `bmw_daily_register` (date, category, kg generated, kg handed, bags count, beds occupied that day → kg/bed-day) — derivable; kept as the auditor-facing register (Form IV source).
- `bmw_annual_returns` (year, Form IV payload, filed_at, filed_by, acknowledgment ref), `bmw_accidents` (Form I: date, nature, persons, action, filed within 24 h flag), `bmw_authorisation` (Form III number, validity, SPCB, conditions), `bmw_training_register` (handler, date, topic, immunisation status Hep B/TT with dates), `bmw_vendor_certificates` (CBWTF monthly treatment/disposal certs).
- `hazardous_waste_register` (mercury, batteries, e-waste, used oil — Hazardous & Other Wastes Rules 2016 / E-Waste Rules 2022: Form 3/4 style, manifest to authorised recycler).

**Linen:** `linen_categories` · `linen_par_levels` (ward resource id, category, par qty, effective) · `linen_bundles` (direction dirty|clean, ward, counts jsonb, infected flag, counted_by ward/linen staff, vendor challan no, at) · `linen_stock_ledger` (linen store; event-mirror) · `linen_condemnations` (witnessed) · `linen_variances` (month, ward, category, expected, counted, loss %, approved write-off).

**Pest/env:** `pest_schedule` (area, service type, frequency, vendor) · `pest_visits` · `pest_sightings` · `fumigation_log` (area, agent, device, dwell, done_by, released_at, sample id) · `environment_samples` (site, type air|surface|water, collected, resulted, CFU, pass/fail, lab ref) · `water_tank_cleaning_log`.

**Contractor:** `contractor_contracts` (vendor, contracted manpower by shift/floor, SLA schedule jsonb, penalty schedule jsonb, CLRA licence no/validity, PSARA n/a) · `contractor_shifts` (from roster sync: present vs contracted) · `sla_penalties` (period, metric, computed, disputed, approved, tally ref).

**Registry needs (Plan 13):** no new kinds — toilets/corridors/lifts/BMW room/linen room/mortuary are `room` (or `store` for BMW/linen rooms) under a `floor`. Attributes: `area_class`, `isolation_capable`, `qr_token_id`. **Terminal-clean "block" uses the bed's `blocked` status** (already in vocab), `cleaning` for routine. **Retention:** BMW registers 5 y statutory (recommend 10); turnover/checklist evidence photos 2 y (NABH cycle ≈ 3 y assessment — recommend 3 y); ratings 1 y; events per §11.18 lock 10.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.**

### A. Identity, wrong-bed, wrong-area
| ID | Scenario → behaviour → assertion |
|---|---|
| A1 | Attendant scans bed 12's QR while actually cleaning bed 14 (adjacent, both dirty) → completion binds to the scanned resource; supervisor spot audit samples 10% of routine turnovers; a second `task.completed` for bed 14 with no scan is refused ("scan the bed") → *test: complete without matching scan → 422; evidence.scanned_qr = task.resource_id enforced.* |
| A2 | Two beds in the same room share one door QR (private room with attendant couch) → QR is per **resource**, printed on the bed frame + a room QR for room-level checklist; room QR cannot complete a bed turnover → *test: room token on bed task → refused.* |
| A3 | Bed physically moved to another ward (surge) without registry update → dispatcher routes to the old floor's pool; the attendant reports "bed not here" (decline reason `not_found`) → task flagged `registry_mismatch`, `registry.drift_flagged` (exists) to admin → *test: decline reason not_found emits drift flag.* |
| A4 | Photographed QR (attendant keeps a photo of bed QRs to scan from the break room) → signed QR + **server checks device location? No** — instead: scan must be followed by a photo whose EXIF/capture time is within the task window and captured in-app (no gallery upload); clustering of scan intervals (< 2 min between beds on different floors) → Fraud Sentinel diagnostic (S10 integrity rule) → *test: gallery upload path disabled; scan-time clustering rule fires in fixture.* |
| A5 | Patient still in bed when `resource.released` arrives (discharge billed, patient waiting for transport) → attendant marks decline `occupied`; task parks 30 m, re-dispatches; bed board shows "released, patient present" → *test: decline=occupied → state DIRTY_HELD, no SLA breach counted during hold.* |
| A6 | Wrong-patient discharge reversed by IPD (`discharge` corrected) while bed is IN_PROGRESS → IPD emits re-admission/`bed.assigned` on a `cleaning` bed → **hard alarm** `bed.assigned_while_cleaning` (NEW), task auto-cancelled with reason, nurse notified → *test: registry refuses assign on `cleaning` unless IPD passes override flag; override evented.* |
| A7 | Terminal-clean bed `blocked` for isolation; ER surge; duty manager wants it anyway → only ICN may downgrade to `cleaning`; evented with authoriser (§11.14 management-override style) → *test: non-ICN downgrade → 403; ICN → `isolation.clean_downgraded` NEW.* |
| A8 | Same attendant claims 6 beds at once to "book" them → claim cap default 2 concurrent per person (config); 3rd claim refused → *test: claim limit.* |
| A9 | Attendant's phone belongs to another attendant (shared device) → §11.18 lock 6: no shared accounts; PIN/badge switch on shared tablets; each scan carries actor id; two actors on one device inside 60 s flagged → *test: switch-user path; actor id on evidence.* |
| A10 | Mortuary body-holding bay cleaning while body release pending → bay is a `room` resource; cleaning task never blocks `body.released`; cleaning after release only → *test: mortuary task trigger = body.released.* |

### B. Timing, concurrency, race
| ID | Scenario → behaviour → assertion |
|---|---|
| B1 | Two attendants claim the same DIRTY task within 200 ms → DB-level claim (row lock / conditional update on `claimed_by IS NULL`); second gets "already claimed" → *test: concurrent claim, exactly one `task.assigned`; mutant removing the WHERE clause must fail.* |
| B2 | Nurse verifies at 10:00:01, attendant marks rework-needed at 10:00:00 (offline queue flush) → workflow engine orders by `recorded_at`; the earlier `occurred_at` is dual-stamped and flagged late-entry; verification stands unless verifier retracts → *test: late-entry flag on out-of-order evidence.* |
| B3 | Bed released twice (IPD retry) → idempotency key on task creation `(resource_id, release event id)`; one task → *test: duplicate event → no second task.* |
| B4 | Discharge cascade releases 14 beds at 11:55 (noon checkout) on a Sunday with pool of 3 → dispatcher ranks by demand: waitlisted class first (`bed.waitlisted` consumed), then ER-pending, then ward order; SLA clocks still run; `overload.flagged` (exists) to duty manager → *test: ordering fixture; overload flag when open tasks > pool × 2.* |
| B5 | Scheduled toilet round due at 13:00, attendant completes at 12:20 (early) → counts for the 12:00 slot only if 12:00 was open; else "early" is recorded but 13:00 remains due → *test: early completion doesn't satisfy a future slot.* |
| B6 | Shift change at 14:00 mid-turnover → task returns to pool after `mid-shift departure` (L7) only if outgoing didn't hand over; else in-app handover (`handover.completed`) transfers claim → *test: roster sync marks outgoing off-duty → open tasks re-pooled with `turnover.redispatched(reason=shift_end)`.* |
| B7 | CBWTF truck arrives at 06:30, BMW officer's shift starts 08:00 → night: security + designated attendant hold "handover" permission for that window (roster-resolved); two-party scan still required → *test: role holder outside shift → 403; within → ok.* |
| B8 | Clock drift on the weighing-scale edge PC → `clock.drift_flagged` (exists); weights carry server `recorded_at`; `occurred_at` from device only if drift < 5 min → *test: drifted device timestamp replaced + flagged.* |
| B9 | 48-h storage: bag sealed Friday 20:00 in a ward, collected Saturday 08:00, pickup Sunday off (vendor holiday) → watchman predicts breach at Friday 20:00 + 48 h = Sunday 20:00 → alert Saturday 12:00 (T-32 h) to BMW officer to call extra pickup → *test: breach forecast uses seal time not receipt time.* |
| B10 | Linen dirty bundle counted at ward 10:05 and at laundry 10:50 differ by 3 sheets → variance tagged on the bundle at receipt; not on monthly only → *test: receipt count ≠ dispatch → `linen.variance_flagged(scope=bundle)`.* |

### C. Partial failure & downtime
| ID | Scenario → behaviour → assertion |
|---|---|
| C1 | Core server down (floor-scoped downtime declared) → **paper turnover slip** (pre-printed, QR of bed) at nurse station; nurse writes released/clean/verified times; on restore, supervisor backfills via Lane-2 form with `occurred_at` per slip; bed board during downtime = whiteboard → *test: backfill form accepts occurred_at < recorded_at, emits `late_entry.flagged`.* |
| C2 | WiFi dead on floor 3 only → attendant app queues scans offline (PWA, IndexedDB), flushes with idempotency keys (§11.18 lock 10) → *test: replay of queued evidence dedupes.* |
| C3 | Label printer at ward out of ribbon → pre-printed serialised label roll fallback (barcodes pre-registered as "unassigned"); sealer scans label + ward QR to bind → *test: unassigned barcode bound at seal; a bag with no barcode cannot be received at store (hard stop) — instead store prints one and logs `bmw.label_applied_late`.* |
| C4 | Weighing scale broken → manual weight entry with `scale_id = MANUAL`, second-person confirm, flagged in daily register; biomedical ticket auto-raised → *test: manual weight requires witness; Form IV shows manual-weighed share.* |
| C5 | Agent harness down (dispatcher offline) → fail-open: tasks still created by the event consumer in DIRTY; pool members see and claim manually; supervisor can "dispatch" manually → *test: harness stopped → claims still succeed; no human path awaits the agent (lint).* |
| C6 | Global agent halt mid-shift → same as C5; digest notes halt period → *test: global halt flag → no `turnover.dispatched` by agent actor.* |
| C7 | Power + network loss (generator delay) → PBX/phone path; BMW room padlock physical; on restore, backfill; storage-limit clock is legal time and does not pause → *test: breach computed on wall-clock regardless of downtime.* |
| C8 | Photo storage (object store) unreachable → completion accepted with `evidence_pending`, photo retried; verification of terminal cleans **requires** the photo, routine does not → *test: terminal verify blocked while evidence_pending.* |
| C9 | Roster sync from HR SaaS stale > 4 h → pool = last known + any user who logs in and self-declares on-duty (evented, supervisor confirms) → *test: stale roster → self-declare path opens.* |
| C10 | Vendor's CBWTF portal (some SPCBs mandate vendor-side barcode upload) down → our manifest is the record; a reconciliation task compares vendor upload later → *test: unmatched vendor upload → `bmw.gap_flagged(kind=vendor_mismatch)`.* |

### D. Money — cost centres, contractor, vendor, patient bill
| ID | Scenario → behaviour → assertion |
|---|---|
| D1 | Private room extra deep-clean because patient's attendant soiled the bathroom repeatedly → **no patient charge by default** (corporate norm: hygiene is in room rent); optional "room damage" charge only via billing supervisor with photo evidence → *test: HK cannot post `charge.posted`; only billing role with reason.* |
| D2 | Linen loss: patient leaves with hospital blanket → recorded as ward variance, not a patient charge, unless ward flags "taken by patient" with attendant pass id → billing may add "linen recovery" at tariff → *test: leakage principle: every condemned/lost piece lands on HK-linen cost centre or a bill.* |
| D3 | Chemical consumption 3× on floor 2 vs floor 5 per sqm → Leakage Auditor triangle (issued vs checklist runs vs sqm) → diagnostic report to supervisor, never auto-penalty → *test: variance report row.* |
| D4 | Contractor claims 24 attendants present; biometric shows 19; HMIS task claims show 17 distinct actors → penalty computed on biometric (contract term), task-actor count shown as diagnostic; dispute window 48 h → *test: penalty basis = roster.synced not task claims; dispute state.* |
| D5 | SLA penalty exceeds invoice → capped per contract (default 10% of monthly invoice), rest carried as negotiation item → *test: cap applied, carry-over row.* |
| D6 | CBWTF charges per bed (typical ₹4–10/bed/day) vs per kg → contract term in `contractor_contracts`; monthly 3-way check (our kg, vendor invoice kg, manifests) → Plan 14 invoice match → *test: kg mismatch > 5% → task.* |
| D7 | BMW cost allocation per department (owner wants kg per OT vs per ward) → source resource on every bag → cost centre by floor/department → *test: manifest totals by source resource.* |
| D8 | Laundry vendor bills per kg, we count pieces → weigh dirty bundles at dispatch (scale in linen room) and store both → *test: bundle has count + kg.* |
| D9 | TPA/PMJAY patient in isolation: PPE and deep-clean costs → infection-control cost centre (L4), not patient bill; package unaffected → *test: PPE issue terminates on IC cost centre.* |
| D10 | GST on housekeeping contractor (18%) and RCM considerations for manpower supply; TDS 194C → Tally-side; HMIS exports penalty credit note reference only → *test: export line carries contract id.* |
| D11 | Expired-drug destruction via CBWTF (L6) requires pharmacy witness + certificate → bag category yellow(d); certificate ref back-linked to `batch.destroyed` → *test: destroyed batch without certificate ref within 30 d → expiry watchman flag.* |

### E. Consent, legal, MLC, minors, unconscious
| ID | Scenario → behaviour → assertion |
|---|---|
| E1 | MLC death on ward: police may want the bed/scene undisturbed → IPD/ER sets `hold_scene` on the bed (blocked, reason MLC); no turnover task created until released by MS/police; evented → *test: blocked(reason=mlc_hold) suppresses dispatch.* |
| E2 | Amputated limb / placenta (§11.17) / foetus (MTP, §11.16-A) → yellow(a) anatomical; **religious return-to-family requests** for body parts: allowed per hospital policy with consent form + gate pass; else CBWTF → *test: anatomical bag either has manifest or a `anatomical.released_to_family` NEW record; never neither.* |
| E3 | Cytotoxic waste from day-care chemo → cytotoxic-labelled yellow; handler must be trained (register); untrained claimer refused → *test: competency gate.* |
| E4 | Needle-stick to attendant while handling white bag → `exposure.reported` → PEP clock (§11.14) + Form I if it is a BMW "accident" (spillage/exposure) → *test: exposure of BMW handler auto-drafts Form I.* |
| E5 | Visitor photographs a patient through the QR complaint photo → photo stored under complaint, access restricted to supervisor; 30-day auto-purge unless linked to incident; DPDP notice on the QR page → *test: retention job purges; access role.* |
| E6 | Minor attendant (child) reports complaint via QR → no identity collected anyway; page collects no personal data except optional phone → *test: page has no mandatory PII.* |
| E7 | Unconscious ICU patient's bed-space "personal effects" found during terminal clean → lost-and-found register entry with two-person witness; security custody → *test: `property.found` NEW with witness.* |
| E8 | Sealed/VIP record: bed turnover task must not reveal patient identity to the pool → tasks carry resource id only; no patient name in HK surfaces ever (design rule) → *test: HK worklist payload has no patient fields; sealed fixture.* |
| E9 | Mercury spill (broken BP apparatus/thermometer) → hazardous waste stream, not BMW; sealed container register; Hazardous Waste Rules manifest to authorised recycler; hospital mercury-free policy recommended (ruling O-7) → *test: mercury class routes to HW register.* |
| E10 | Radioactive waste (nuclear medicine, later) → AERB, not BMW → out of scope; class refused in this module → *test: category enum has no radioactive.* |

### F. Staff absence, overload, handover
| ID | Scenario → behaviour → assertion |
|---|---|
| F1 | Night pool of 2 for 300 beds; 5 discharges at 02:00 → dispatcher serialises by priority; supervisor (bundled with duty manager) notified at open tasks > pool × 2; ER admission desk sees ETA per bed → *test: ETA derived from median TAT × queue position.* |
| F2 | Supervisor absent, no verifier for terminal clean → verifier role ladder: ICN → matron/nursing supervisor → duty manager (never the cleaner) → *test: ladder resolves to on-duty holder.* |
| F3 | Attendant declines 3 tasks in a row → auto-flag to supervisor (diagnostic), not auto-penalty → *test: decline streak counter.* |
| F4 | Contractor sends 8 new untrained workers on day 1 of the month → competency flags on user (BMW handler, cytotoxic, spill kit, isolation) gate task kinds; untrained can only do class C/E → *test: task kind × competency matrix.* |
| F5 | Handover: outgoing attendant mid-terminal-clean → in-app handover with checklist of items done; incoming continues; both actors on evidence → *test: two cleaners on one task, verify still SoD vs both.* |
| F6 | Diwali/Holi: 40% contractor absence → surge mode (§11.14) tightens SLAs? No — **relaxes** turnover SLA to 45 m and suppresses non-critical scheduled rounds (class D/E), evented → *test: surge flag changes SLA class table version used by new instances only.* |
| F7 | Strike by outsourced pool → A1 downtime mode for HK: paper slips, nurses/GDA from other pools; contractor SLA "force majeure" clause flagged → *test: pool role emptiness → duty manager alert.* |
| F8 | Supervisor verifies 40 beds in 12 minutes → integrity check (S10): verification interval clustering → diagnostic to quality manager → *test: clustering rule fixture.* |

### G. Equipment & consumable failure
| ID | Scenario → behaviour → assertion |
|---|---|
| G1 | Fogger under repair; OT weekly fumigation due → task cannot complete; theatre stays released? **No** — fumigation is scheduled, not release-gating unless surveillance failed; biomedical ticket linked; overdue > 7 d → ICN decides (evented) → *test: overdue fumigation flag, no auto-block.* |
| G2 | Environmental swab fails in OT-2 → theatre `blocked` (Plan 15 consumes `environment_sample.resulted(fail)`); re-fumigate → re-swab → pass → release → *test: fail → block event emitted; pass → release.* |
| G3 | Autoclave for lab pre-treatment down → lab waste held in yellow with "untreated" flag; CBWTF informed (some accept untreated with premium) → *test: untreated flag on bag; manifest shows it.* |
| G4 | Spill kit expired/consumed → kit register with par; usage decrements; expiry watchman flags → *test: kit par breach task.* |
| G5 | Chemical dilution: attendant uses neat hypochlorite → dilution card per chemical shown on the task (Hindi, pictorial); consumption variance flags floors using 2× → *test: chemical ref on checklist item.* |
| G6 | Lift out of order → linen/BMW trolley routes change; maintenance ticket; transport SLAs relaxed for that floor (config) → *test: floor-scoped SLA modifier on `interface.down`-style lift event (from doc 19).* |
| G7 | RO plant for dialysis fails water quality → dialysis module blocks; HK gets tank/plant cleaning task at priority; ICN notified → *test: consume `water_quality.recorded(fail)` → task.* |
| G8 | UV/HEPA in isolation room inop → terminal clean can complete but ICN verify shows equipment fault; bed stays `blocked` until doc 19 clears → *test: verification requires equipment-ok item for isolation rooms.* |

### H. Data quality, late-arriving, backdated
| ID | Scenario → behaviour → assertion |
|---|---|
| H1 | Supervisor backfills yesterday's toilet rounds "all done" at 23:59 → allowed, dual-stamped, **late-entry rate is a KPI on the supervisor's card** and flagged in audit sampling → *test: bulk backfill > 20 items → `late_entry.flagged` each + digest line.* |
| H2 | Bag weighed 0.0 kg / 85 kg (typo) → range check per category (yellow bag 0.2–15 kg) → confirm or reject → *test: out-of-range requires witness confirm.* |
| H3 | Manifest signed but 2 bags scanned twice, 1 missed → manifest bag list unique; missed bag = gap (not silently "handed") → *test: duplicate scan idempotent; unscanned bag remains WEIGHED → watchman.* |
| H4 | Checklist template edited mid-day → runs pin template version; new runs use new version; report by version → *test: run.template_version immutable.* |
| H5 | Bed registered with wrong `area_class` (ICU bed as class B) → ICN review of registry attributes monthly (task); terminal SLA derived from class → *test: class change re-derives future SLAs only.* |
| H6 | Time zone: vendor certificate dates in DD/MM vs MM/DD → import validation; all times IST stored UTC → *test: parser fixture.* |
| H7 | Occupancy for kg/bed-day missing on a day (IPD not yet live — Plan 19 ships before IPD) → denominator = registry `occupied` bed count snapshots at 23:59 (registry status history) or manual census entry until IPD → *test: KPI marks denominator source.* |
| H8 | Linen par set to 0 by mistake → replenishment automation refuses zero par for active wards; drift flag → *test: validation.* |

### I. Fraud, leakage, gaming
| ID | Scenario → behaviour → assertion |
|---|---|
| I1 | Attendant scans QR and completes without cleaning (ghost cleaning) → random supervisor spot audits (≥ 5% daily, weighted to low-duration completions); patient ratings correlate; durations < 20% of median flagged → *test: duration outlier rule; audit sampling weight.* |
| I2 | Contractor inflates manpower by badge-sharing → biometric is HR's problem; HMIS diagnostic: distinct task actors vs claimed presence → shown on contractor reconciliation → *test: reconciliation row.* |
| I3 | Red-bag plastics diverted for resale (recyclable value) → daily kg per category vs expected ratio (red typically 20–30% of total); sudden drop → watchman diagnostic; storage room access log (security card) → *test: ratio anomaly rule.* |
| I4 | Vendor manifests kg lower than ours (bills per kg? or dumping) → 3-way monthly; > 5% → task to BMW officer → *test: D6.* |
| I5 | Linen theft via laundry vendor (returns fewer) → bundle-level variance at receipt (B10) + monthly par audit; vendor scorecard → *test: vendor fill-rate KPI.* |
| I6 | Supervisor verifies own cleaned bed → SoD hard block → *test: `sod.violation_blocked`.* |
| I7 | Fake QR complaints to sabotage a colleague → per-device rate limit (3/h), duplicate-text detection, complaints are diagnostic → *test: rate limit.* |
| I8 | Pest vendor logs visits without visiting → area QR scan required per zone; scan clustering; CCTV cross-check is security's → *test: visit needs ≥ N zone scans.* |
| I9 | Chemical pilferage (phenyl, hypochlorite) → P3 issue to floor + consumption triangle → *test: D3.* |
| I10 | Contractor site supervisor edits attendance in HMIS → no write permission; only acknowledge/dispute → *test: 403.* |

### J. Privacy, sealed records, VIP, staff-as-patient
| ID | Scenario → behaviour → assertion |
|---|---|
| J1 | VIP in private suite: turnover task shows only "Suite 7, deep" — no name, no diagnosis (E8) → *test: payload allowlist.* |
| J2 | Staff nurse admitted with TB (airborne isolation) → isolation class flows to terminal-clean protocol; diagnosis never in task; ICN sees isolation class only → *test: task carries isolation class enum, not diagnosis.* |
| J3 | Photos of cleaned rooms accidentally capture a patient in the next bed → in-app camera with guidance; photos are internal evidence, RBAC to supervisor/ICN/quality; never exported without approval (§11.19-D export governance) → *test: export path requires approval.* |
| J4 | QR feedback page collects phone for callback → optional, consent text, purpose-limited, purged 90 d → *test: purge job.* |
| J5 | Attendant location tracking (GPS) → **not collected** (design decision; scan events suffice); DPIA staff-profiling coverage for scan/time data → *test: no geolocation permission requested by app.* |
| J6 | Copilot (Lane 3) asked "which patient was in bed 12 yesterday?" by a HK supervisor → tool catalog under user ∩ agent permissions → refused; audit event → *test: permission denial evented.* |

### K. Language, literacy, accessibility
| ID | Scenario → behaviour → assertion |
|---|---|
| K1 | Attendant reads Hindi only; checklist items pictorial + Hindi + English; voice read-out (TTS, on-device) for items → *test: template requires hi label for activation.* |
| K2 | Bhojpuri-speaking attendant of a patient scans toilet QR → icons + 5-star + Hindi text; no typing needed → *test: page usable with zero text entry.* |
| K3 | Visually impaired visitor → QR page WCAG basics (large targets, contrast); braille signage is facility-side → *test: axe check in CI.* |
| K4 | Attendant cannot read the bag label category → colour-coded label with pictogram; app shows colour on scan → *test: label template.* |
| K5 | Numbers: attendant enters linen count 1000 instead of 100 → range check vs par × 3 → *test: soft warn/hard stop.* |
| K6 | Voice notes for complaints (patient) → stored as audio, transcribed on-device or not at all in Phase; text goes through the scrubber before any inference (copilot §2.2) → *test: audio not sent to provider.* |

### L. Scale: 10 beds/100 OPD → 610 beds/2,000 OPD
| ID | Scenario → behaviour → assertion |
|---|---|
| L1 | 610 beds × ~1.2 turnovers/day (avg LOS ~4 d → ~150 discharges/day) + 45 ICU → ~200 turnover instances/day, ~2,500 scheduled runs/day, ~400 BMW bags/day → `tasks` partitioned monthly like events; worklist queries indexed by (pool_role, state, floor) → *test: perf budget: pool worklist < 300 ms at 10k open/closed rows.* |
| L2 | Toilets: 610 beds → ~250 toilets × 15 slots/day = 3,750 runs → scheduler job creates in batch at 00:05 IST; skipping creation for closed areas → *test: batch create idempotent by (area, slot date).* |
| L3 | Dispatcher fan-out: 20 releases in one minute → single job per tick, ranks all DIRTY; no per-event agent invocation → *test: one `turnover.dispatched` per task, one run per tick.* |
| L4 | Photos: 3,000/day × 300 KB → object storage (MinIO on the VM, later NAS); 3-y retention ≈ 1 TB → budget §12 → *test: storage path config.* |
| L5 | Multiple sites later (`site_id` default main, DD3) → all tables carry `site_id`; Form IV per authorisation (site) → *test: site column present.* |
| L6 | 10-bed day one: one attendant, supervisor = owner's admin; everything above must run with pool of 1 and no contractor → *test: pool size 1 fixture; contractor tables optional.* |

### M. Integration failures (device / vendor / HR / ABDM n/a)
| ID | Scenario → behaviour → assertion |
|---|---|
| M1 | Bluetooth weighing scale drops mid-weigh → manual (C4) → *test.* |
| M2 | HR SaaS roster API changes schema → adapter validates; on failure keeps last roster + alert (`interface.down`) → *test: schema mismatch → interface.down.* |
| M3 | Vendor (CBWTF) refuses e-signature, signs paper → paper manifest photographed, stored as evidence; manifest state HANDED_OVER with `signature_mode=paper` → *test: mode enum.* |
| M4 | SPCB portal (state-specific) format for Form IV changes → Form IV stored as our JSON; export template versioned; filing is manual upload with acknowledgment ref → *test: export version.* |
| M5 | Nurse-call/ward tablet "call housekeeping" button (bought hardware) → lands as ad-hoc task in pool (§11.18) via MQTT/HTTP edge → *test: edge submit with idempotency key.* |
| M6 | Tally export of penalty credit rejected → export queue retry + finance task → *test: export failure task.* |
| M7 | Pest vendor uses own app → we accept scan-only; their report PDF attached monthly; our log is authoritative → *test: attachment path.* |
| M8 | IPD not yet live (Plan 19 precedes IPD) → turnover triggered by **manual "bed released" action** on a Lane-2 form or by mini-OT recovery-bay release (Plan 15 emits `resource.released`) → *test: manual release path emits same event.* |

### N. Isolation, outbreak, OT, mortuary specifics
| ID | Scenario → behaviour → assertion |
|---|---|
| N1 | Hall cohort mode (ICU outbreak, §11.15) → every bed in hall flips to terminal class on release; hall-level terminal clean task after last discharge; ICN releases hall → *test: cohort flag → class terminal.* |
| N2 | Airborne isolation (TB, measles) room: post-discharge **air-clearance wait** (e.g., 60–120 min per ACH before entry) → task has `earliest_start_at`; dispatcher won't dispatch before → *test: earliest_start honoured.* |
| N3 | C. difficile / spore-formers → sporicidal chemical mandated on checklist (chlorine 1,000 ppm) — chemical ref gate → *test: template variant per isolation class.* |
| N4 | OT emergency case at 02:00 in a theatre not on the list → between-case clean task auto from `surgery.completed`; SLA 20 m → *test: consume surgery.completed.* |
| N5 | OT construction dust (new theatre commissioning) → commissioning fumigation + 3 consecutive passing swabs before first use (NABH corporate norm) → *test: theatre initial release rule.* |
| N6 | Death in mortuary cold chamber leak → spill class blood/body fluid + chamber cleaning + biomedical ticket → *test: composite task creation.* |
| N7 | Fire drill / actual fire code → all HK tasks paused floor-scoped; evacuation manifest is bed board's; post-event soot/water cleaning surge tasks → *test: code.activated pauses SLA clocks on that floor.* |
| N8 | Attendants' mess/waiting hall: food waste = SWM Rules general/wet waste, not BMW; pest risk → kitchen-grade weekly pest → *test: category general routes to SWM register (simple count), not BMW.* |
| N9 | Construction debris during expansion → C&D Waste Rules 2016, contractor's responsibility; recorded as note only → *test: none (out of scope, documented).* |

**Row count: 105.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday noon discharge wave with a contractor no-show (day 200, 180 beds).** 11:30 — 22 fit-declared patients, 15 bills settled by 12:10; IPD emits 15 `resource.released` in 12 minutes. Pool on duty: contracted 9, present 5 (`roster.synced` shows the gap; `contractor.shift_reconciled` draft opens). Dispatcher ranks: 3 beds have `bed.waitlisted` demand (2 general male, 1 private) and the ER has 2 boarding — those go first; two attendants get 2 claims each; overload flag at 12:15 (open 15 > 5 × 2). Supervisor pulls 2 GDA from transport pool (cross-pool claim allowed for routine class only). 12:40 — first 4 beds READY (median 28 m). Nurse in-charge of ward 3 doesn't verify for 14 min (in medication round) → verifier nudge → supervisor verifies (not cleaner) at 12:56. 13:30 — 12 of 15 READY; 3 private rooms at 55 m (SLA 30 m breached, `sla.breached` recorded; no alert since HK turnover is not in the active-alert set at go-live — it appears in the 8 a.m. digest). Contractor penalty: 4 attendants × shift-rate + turnover SLA hit rate 80% vs contracted 90% → computed, disputed next day ("traffic jam"), approved at 50%. Audit trail: every claim, re-dispatch reason, verifier identity, the cross-pool authorisation and the penalty math from events. Paper path: none needed.

**6.2 Server down 20:00–23:30, floor-scoped downtime declared.** Discharges paused anyway (billing down) but 2 ICU-to-ward transfers and 1 death happen. Nurses use pre-printed turnover slips (bed QR printed on slip) — times written by hand; terminal clean of the death bed done, ICN verifies on paper and signs. BMW: evening round bags sealed with pre-printed serialised labels; weighing scale logs locally (SQLite on the edge PC) with device time. 23:45 restore: supervisor backfills 3 turnovers via Lane-2 form (occurred_at from slips; `late_entry.flagged` ×3); scale flushes 27 weights with idempotency keys; two bags weighed twice (double-scan) dedupe. Bed board: the 3 beds were on the whiteboard; registry now `available`. The audit shows `downtime.declared` … `downtime.ended`, three late entries with the supervisor as recorder and nurses as claimed actors, and the ICN's paper signature photographed as evidence on the terminal clean. Agents: dispatcher was idle (nothing to dispatch); watchman's midnight run sees 27 weighed bags, all on tomorrow's manifest draft.

**6.3 CBWTF truck doesn't come for 3 days (vehicle seized in a road-tax drive).** Day 1 pickup missed → watchman flags at 20:00 "no manifest handed today; 41 bags aging". Day 2 08:00 BMW officer calls vendor; T-32 h forecast alerts fire for Friday's bags. MS is asked (ladder) at T-4 h. Storage room at capacity — overflow into a locked, labelled secondary room (registered as a `store` resource, evented `bmw.storage_overflow` NEW). 48 h passes for 18 bags → `bmw.storage_limit_breached` ×18 → internal incident + Form-I-style note (a storage breach is not a Form I "accident", but the SPCB may ask; we keep the record and the vendor correspondence). Day 3 vendor's substitute truck arrives; manifest of 117 bags handed; vendor letter attached. Form IV will show the breach days honestly. Owner digest shows the streak. Fallback the ruling should pre-authorise (O-2): a second CBWTF or a deep-freezer for anatomical waste.

**6.4 ICU hall outbreak (CRE cluster, 3 patients) on a Saturday.** ICN flips hall B to cohort (`isolation.flagged` at hall grain, §11.15). Every release in hall B becomes terminal; sporicidal template variant applies; earliest-start delays where airborne is suspected (not here). Attendants with isolation competency: 2 on duty → supervisor requests Coverage Resolver (existing T3) for a competency-matched extra from the contractor; duty manager approves. Environmental sampling ordered (`environment_sample.collected` ×12); results Monday. Hall-level terminal clean after the last discharge Tuesday → ICN verifies with photos → hall `available`. BMW: hall B bags tagged `outbreak` in attributes for kg tracking; PPE to IC cost centre. Digest: kg/bed-day spikes for hall B; the Digest Writer narrates from events only. Paper: none. Audit: the hall flag, each terminal verification with ICN identity, sample results, the release.

**6.5 A visitor's QR complaint turns into a Code Violet.** 15:10 — QR complaint "toilet dirty, staff abused me" with photo. Patient-Complaint Router (T2) classifies: hygiene (routine task) + **grievance-class text** → proposes two actions; supervisor confirms the toilet task (auto-dispatched) and the grievance routes to §11.14 (`grievance.raised`) — HK never handles the abuse claim. 15:25 — the attendant confronting the visitor at the toilet; nurse triggers Code Violet from the tablet; security converges; HK task auto-parked (`code.activated` pauses floor clocks). Later: the grievance resolution links the toilet task, the rating, the code event. Fraud angle: the same device had sent 3 complaints in the hour → rate-limited fourth is dropped and logged. Audit: everything correlates on the complaint id.

**6.6 Weighing scale + label printer + WiFi all fail on the same night, and it is the last day of the financial-year return.** 29 June: Form IV due 30 June. Night: scale dead → manual weights with witness; printer dead → pre-printed labels; WiFi dead → app queues. 06:00 flush; BMW officer runs "Form IV preview" — the automation shows 11 days in the year with manual weights, 2 storage breaches (6.3), category totals, authorisation number, CBWTF treatment certificates (2 missing months → the watchman had flagged them; vendor sends PDFs by 11:00). MS signs the return in HMIS (`bmw.return_filed`), PDF uploaded to the SPCB portal manually, acknowledgment ref recorded. What an inspector sees later: the register, the manifests with vendor signatures, the manual-weight share honestly labelled, the training register with Hep B dates.

**6.7 Mass-casualty (bus crash, 30 patients) at 21:00 with 3 attendants on night skeleton.** `disaster.declared` → HK surge rules: all scheduled class C/D/E rounds suspended (`checklist.skipped(reason=disaster)`), ER floor gets both attendants, spill kits pre-positioned, red/white bag volumes spike (sharps 5×) — extra collection round triggered by seal-count threshold (> 20 sealed bags on a floor). Blood spill tasks ×6 via one-tap; dispatch ≤ 3 m mostly met, two breached and recorded. Beds: 12 ward beds released by early discharge of stable patients (IPD) → routine turnovers with relaxed 45 m SLA under disaster mode. Morning: 3 mortuary cleanings after body releases (MLC holds respected — E1). Backfill: the ER floor's paper spill log (kept because tablets were busy) entered by the supervisor at 06:00, dual-stamped. Audit: `disaster.declared/ended` brackets every relaxed SLA; the digest shows the relaxations explicitly.

---

## 7. Compliance, audit & statutory surfaces

| Statute / standard | What it demands | Where it lives here |
|---|---|---|
| **Bio-Medical Waste Management Rules 2016** (amended 2018, 2019) | Occupier authorisation (Form II/III); segregation per Schedule I colours; bar-coding of bags; **48-h storage cap**; daily weighing and records; handover to CBWTF with manifest; **Form IV annual return by 30 June**; **Form I accident report within 24 h**; records 5 y; training + Hep B/TT immunisation of handlers; display of BMW data on website (rule 4(o)); liquid waste norms Schedule II; no deep burial where CBWTF is within 75 km | `bmw_*` tables (§4); events §3.4; training register; website-export job (rule 4(o): monthly data publication) |
| Hazardous & Other Wastes (M&TM) Rules 2016 · E-Waste Rules 2022 · Batteries Rules 2022 | mercury, chemicals, e-waste, batteries via authorised recyclers with manifests | `hazardous_waste_register` |
| Solid Waste Management Rules 2016 | general/wet/dry waste segregated, never in BMW colours | general-waste counts (light) |
| **NABH 5th/6th ed.** — HIC (hospital infection control: HIC 5/6 housekeeping, laundry, BMW; surveillance), FMS (facility safety: pest control, water quality, hazardous materials/MSDS, spill), ROM/PSQ (indicators: BMW segregation compliance, HAI rates) | SOPs, cleaning schedules and records, environmental surveillance, MSDS availability, spill management, pest control records, water testing | checklist templates + runs, audits, `environment_samples`, `pest_visits`, `hk_chemicals.msds_ref`, `hk_spills` |
| Clinical Establishments Act (state rules) | BMW authorisation as a registration condition; hygiene standards | `bmw_authorisation` on compliance calendar |
| **CLRA 1970** (+ state rules), Minimum Wages, EPF/ESI | principal-employer registers (Form XIII etc.), contractor licence | HR-evidence bridge (L13); `contractor_contracts.licence` on compliance calendar |
| Factories Act n/a; **Occupational safety** (needle-stick, chemical exposure) | PEP protocol, MSDS, PPE | §11.14 machinery; chemical register |
| **DPDP Act 2023** | visitor QR page: minimal data, notice, purpose, purge; staff scan/time data: purpose-limited, DPIA staff-profiling coverage; photos: internal evidence class | data classes: **C1 operational (tasks, weights) · C2 staff-personal (actor timings) · C3 visitor-personal (optional phone, photos) · C4 patient-adjacent (isolation class enums only, never diagnosis)** |
| Water: IS 10500 potable; dialysis water AAMI/ISO 23500 | periodic testing | `environment_samples(type=water)`, telemetry link |
| Fire (NBC 2016, state fire NOC) | exit clearance, housekeeping storage rules (no combustibles in shafts) | checklist items; NOC on compliance calendar (doc 19) |

**What an SPCB inspector asks for:** authorisation certificate; last 12 months' daily category-wise kg; manifests with CBWTF signatures; bar-code system evidence; storage room photos/temperature; training & immunisation register; Form IV copy with acknowledgment; accident reports; segregation charts displayed; CBWTF agreement. **All are one Lane-2 "inspector pack" export** (approval-gated per export governance).

**What NABH assessors ask:** cleaning SOPs and frequency, evidence of completion (runs), supervisor audit scores, environmental surveillance results and corrective actions, spill logs, MSDS at point of use, pest control contract + logs, water testing, linen handling SOP + infected linen process, BMW audit findings by ICN, HK staff training records, patient feedback on hygiene.

**Who signs:** Form IV / Form I — occupier signatory (owner or MS, **O-3**); terminal clean verification — ICN/supervisor; manifests — BMW officer + vendor; SLA penalties — operations head; condemnations — linen in-charge + witness; write-offs — approvals engine per value.

**Retention:** BMW registers 5 y statutory, recommend 10; checklist runs/evidence 3 y; environmental samples 5 y; pest logs 3 y; ratings 1 y; contractor SLA 8 y (financial); events per §11.18.

---

## 8. Staff KPI & KRA

All formulas are event-derived, load-normalised, diagnostic. Target home: KPI formula registry (deferred note 5); until then this section is the draft.

**Housekeeping Supervisor (#32)**
| KPI (id) | Formula | Load norm | SLA link | Diagnostic reading |
|---|---|---|---|---|
| hk.turnover_median_min | median(`turnover.ready.minutes_dirty_to_ready`) per shift, by class | per releases/shift and pool present | 30/60/90 | high with low pool → staffing; high with full pool → process/verifier lag (split by segment) |
| hk.turnover_sla_hit | count(ready ≤ class SLA)/count(ready) | same | yes | read with median |
| hk.verify_lag_min | median(verified_at − cleaned_at) | per verifier load | 10 m | lag on nurses' side → nursing conversation, not HK |
| hk.checklist_completion | completed/(scheduled − skipped_valid) per class | per rounds/attendant | grace | class-C toilets < 95% → ask why (pool, area count) |
| hk.audit_score | mean(`area.inspected.score`) | per area class | — | trend, not rank |
| hk.rework_rate | rework/ready | — | — | quality signal |
| hk.late_entry_rate | late-flagged runs/runs | — | — | high → downtime or backfilling habit |
| hk.spot_audit_coverage | audits/completed turnovers (target ≥ 5%) | — | — | supervisor's own diligence |

KRA: beds and areas provably clean and on time; verification integrity; contractor reconciliation; spill readiness. **Gaming vectors:** verifying own work (SoD blocks); batch-verifying (clustering flag); skipping with fake reasons (skip-reason audit sample); marking early (B5).

**Attendant / GDA pool (diagnostic only, never individual ranking published)**: tasks completed per hour on duty · median duration by class vs pool median · decline rate · audit pass rate on own tasks · rating on areas claimed. Read as a training signal; S10 law: informs conversations.

**BMW Officer (new #40)**: bmw.chain_completeness = bags handed/bags sealed (rolling 7 d, target 100% within 48 h) · bmw.storage_breaches (count, target 0) · bmw.weigh_same_day = weighed same day/received · bmw.kg_per_bed_day by category (benchmark yellow+red ≈ 0.3–0.5 kg/bed-day for Indian tertiary; a jump = diagnostic) · bmw.mis_segregation_findings per ICN audit (per 100 bags) · bmw.certificate_currency (months with vendor cert/months) · bmw.form_filed_on_time. KRA: unbroken custody, on-time statutory filings, trained/immunised handlers. Gaming: sealing bags late to reset the 48-h clock → sealed_at is device/server time; ward round scan of open bags counts; weight rounding → range checks.

**Linen In-charge (new #41)**: linen.loss_pct = (par + issued − returned − condemned − in-process)/par per month per ward (target < 2%/month) · linen.par_breach_hours per ward · linen.bundle_variance_rate · linen.infected_stream_compliance (ICN audit) · linen.vendor_turnaround_h. KRA: every ward at par every morning; losses visible and explained. Gaming: adjusting par down to hide loss → par changes evented and approved.

**Infection Control Nurse (#38, extended)**: terminal-clean verification within SLA · environmental sample pass rate · BMW segregation audit findings/100 bags · spill-kit audit currency · isolation-competency coverage of pool per shift.

**Contractor (vendor scorecard, not a person)**: manpower fill rate · turnover SLA hit · checklist completion · audit score · penalty ₹/month · attrition (new faces/month).

**Owner's 8 a.m. digest (Digest Writer, from events):** yesterday's turnover median and SLA hit by class with pool present; beds currently `cleaning` > 60 min (list); BMW: kg by category, bags aging > 24 h, any breach, days to Form IV; linen loss month-to-date; checklist completion by class; audit score trend; open spills/pest sightings in critical areas; patient hygiene rating (7-d mean, worst 3 areas); contractor fill rate and pending disputes; late-entry count. Absence lines (negative space): "no BMW manifest recorded yesterday", "no toilet rounds logged on floor 4 after 22:00", "zero ratings from ward 2 QR for 14 days (QR damaged?)".

---

## 9. AI agents & the copilot — where inference earns its place

Rule applied: deterministic wherever a rule is safer/cheaper/more auditable (§16). Only one candidate needs inference.

### 9.1 Turnover Dispatcher — automation, **T4** (spec-named; ships with IPD per §16, but Plan 19 ships it in T3 shadow-then-T4 for recovery bays and manual releases, since IPD comes later — see §14)

**Trigger:** `resource.released` (bed/room) · `isolation.flagged` change on a released bed · `task.declined` · no-claim/no-accept timers · `roster.synced` (departure) · `bed.waitlisted` / `bed.assigned` demand changes. Runs as one scheduler tick every 30 s plus event-driven wake.

**Deterministic rules (v1, all config, all evented in `turnover.dispatched.rule_trace`):**
1. Class: routine by default; `deep` if isolation contact/droplet or `soiled` flag from nurse; `terminal` if `patient.deceased`, airborne isolation, outbreak cohort, or ICN override; `ot_between_case` / `ot_terminal` for theatre kind (Plan 15).
2. Earliest start: airborne → release + configured air-clearance minutes; MLC hold → never until unblocked.
3. Priority score = demand (waitlisted same class +50, ER boarding +40, planned admission today +30) + age of DIRTY (×1/min) + class weight (ICU +20) − floor already saturated penalty.
4. Candidate pool = on-duty holders of `hk_attendant` on that floor (then adjacent floors, then any) ∩ competency for class ∩ concurrent claims < cap ∩ not the discharged patient's own nurse (n/a) ; sort by (fewest open tasks, nearest last-scanned location, longest idle).
5. Assign top candidate (ASSIGNED) with 5-m accept timer; **re-dispatch** on decline/no-accept/departure/verifier-fail-with-no-rework-claim: next candidate, never the same one twice for the same task within 30 m; after 2 re-dispatches → supervisor notified; after 3 → duty manager.
6. Never dispatch during a floor-scoped code/disaster pause; never dispatch terminal to non-competent; never touch registry status except through `task.verified → resources.setStatus(available)` (that call is the module's, not the dispatcher's).
7. Load shedding: if open DIRTY > pool × 2 → `overload.flagged`; suspend class C/E scheduled rounds' auto-dispatch (they still exist, unclaimed) — evented.

**Human sign-off:** none for dispatch (T4 operational); supervisor may override any assignment. **Fail-open:** tasks exist regardless; manual claim/dispatch. **Kill switch:** per-agent; on kill, worklist shows unassigned DIRTY. **Provenance:** rule version + inputs hash on every `turnover.dispatched`. **Eval:** replay of 30 days' releases (shadow-mode note 7) comparing median TAT vs manual; guardrail asserts no assignment violates rules 4/6. **DPIA:** C1/C2 (staff timing) — no patient data enters. **Ships:** Plan 19 (T3 shadow → T4 after 2 weeks clean shadow; owner promotes tier).

### 9.2 BMW Manifest Gap Watchman — automation, T1
Trigger: hourly + 20:00 daily. Inputs: `bmw_bags` states/timestamps, manifests, vendor certs. Output: nudges to BMW officer role: bags sealed > 12 h uncollected; received not weighed by EOD; weighed not on manifest; manifest not handed by pickup window; **48-h forecast** (T-32/T-8/T-4 h ladder to officer → duty manager → MS); vendor certificate missing > 45 d after month-end; Form IV T-30/T-7 days; authorisation expiry 90/30 d; handler immunisation due. Sign-off: none (nudges). Fail-open: officer's Lane-2 worklist shows the same queries. Kill: per-agent. Eval: fixture days with each gap type. DPIA C1. Ships: Plan 19.

### 9.3 Checklist-Miss Nudger — automation, T1
Trigger: `due_at + grace` passes without completion/skip. Output: nudge to pool role on that floor (in-app, not WhatsApp — deferred note 2 cost rule); second miss → supervisor; pattern (same area 3×/week) → digest line. Selective alerting: only class A and class-C toilets nudge in real time at go-live; B/D/E recorded only (§10.3). Fail-open: worklist shows overdue. Ships: Plan 19.

### 9.4 Patient-Complaint Router — **agent, T2** (inference on de-identified free text)
Trigger: `hk.complaint_raised` with free text/voice-transcript. Inputs: text after the §2.2-style scrubber (names/phones stripped; QR → area only), category chips, area class. Output: **draft** classification {hygiene routine / hygiene urgent / maintenance (doc 19) / grievance-class (§11.14) / pest / nursing (not HK) / noise} + proposed task kind + priority, with cited phrases. Sign-off: **supervisor confirms** (propose→confirm; for hygiene routine the confirmation may be a one-tap default after 30 days of ≥ 95% agreement — promotion to T3 requires owner approval). Grievance-class **always** requires human confirmation and never becomes a HK task. Fail-open: without the agent, every complaint lands as an unclassified task in the supervisor queue. Kill: per-agent. Provenance: model id, prompt version, input/output hash on the draft event. Eval: labelled set of 300 Hindi/Hinglish/English complaints; adversarial fixtures (instruction-shaped text, PII in text). DPIA: C3 visitor text — tokenised; DPIA L1 revision covers this class. Ships: Plan 19 in shadow; active after 12a's Class-1 gates.

### 9.5 Not agents (rejected candidates, with reasons)
"Predictive turnover" (which beds will release) — IPD's fit-declared event already tells us; a rule suffices. "Vision check of cleaning photos" — cost and false-confidence risk; spot audits + ratings are cheaper and auditable; revisit when photo volume justifies. "Chemical dosing optimiser" — variance report is enough.

### 9.6 Presentation lanes for this department (Track B pilot)
- **Lane 1 (hand-built):** none by ruling — except the **attendant mobile PWA** (scan → checklist → photo → done), which is the department's high-frequency surface and must be hand-tuned for a ₹8k phone: 3 taps per task, offline queue, big targets, Hindi first. (Recommend counting this as the one Lane-1 exception; **O-8**.)
- **Lane 2 (schema-generated):** supervisor worklist (open tasks by floor/state/age), verifier queue, BMW officer register + manifest builder, linen bundle forms, pest/fumigation logs, contractor reconciliation, inspector pack, audit forms — all from tool-catalog schemas.
- **Lane 3 (conversation):** "which beds are dirty > 40 min on floor 3?", "mark suite 7 terminal, ICN says airborne" (propose→confirm), "how many kg red bag last week vs previous?", "show me Friday's manifest", "who verified bed 12 yesterday?" — each resolves to catalogued tools under user ∩ agent permissions.
- **Journey Feed contributions:** per encounter: `bed released → turnover ready (min)`, `isolation terminal clean verified by ICN`, `spill cleared near patient`; per resource (bed) timeline: releases, cleans, audits, ratings. Patient identity never on HK surfaces; the feed shows HK events inside the patient's journey to clinical roles.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

| Lever | Mechanism | Target |
|---|---|---|
| One-scan start/complete | signed QR on every bed/room/toilet/bag; scan = context + timer | task open-to-start ≤ 3 taps; scan < 1 s |
| Pre-printed serialised bag labels | no printer dependency at wards; bind at seal | 0 unlabelled bags at store |
| Bluetooth scale → app | weight captured on scan, no typing | weigh + record < 10 s/bag |
| Colour + pictogram checklists, Hindi TTS | literacy-proof | template activation requires hi labels |
| Photos in-app only | evidence + anti-gaming | terminal cleans 100% photo |
| TAT clocks on bed board | admission desk sees ETA per bed | median routine turnover < 30 m (S10 says < 45 m at 610 beds) |
| Verifier queue on ward tablet | one-tap verify with SoD | verify lag < 10 m |
| Pool worklist perf | indexed (pool_role,state,floor); partitioned tasks | < 300 ms |
| Nightly SLA/penalty computation | deterministic job with trace | disputes resolvable from events |
| Inspector pack export | one action, approval-gated | < 5 min to produce |
| Form IV auto-draft | from daily register | filed ≤ 30 June with acknowledgment |
| Voice notes for complaints (patient), never dictation into records | on-device; scrubbed | no audio to provider |
| Print surfaces | bed slips, bag labels, manifests, segregation charts (Hindi/English) — QR on all | — |

---

## 11. Integrations, devices & dependencies

| Item | Examples (Indian market) | Protocol / rule |
|---|---|---|
| Android phones for attendants | any ₹8–12k device; PWA | HTTPS; offline queue; no app-store dependency |
| Ward tablets (existing plan) | — | verify queue |
| Bluetooth/USB weighing scale (30–150 kg platform) | Essae, Phoenix, Baijnath with RS-232/BLE | **edge-service rule**: a tiny Node edge (like lab edge, §5) on the BMW room PC buffers to SQLite; submits with idempotency keys |
| Label printer (thermal, 2-inch) | TSC, Zebra ZD; or pre-printed rolls from a label vendor | ZPL/TSPL via edge or print server |
| QR labels (durable, autoclave-safe for OT) | polyester labels | signed payload per L13 |
| Nurse-call "housekeeping" button | bought hardware | MQTT/HTTP → task |
| Fogger / UV devices | Indian OEMs; no integration | manual log; device as registry `device` for AMC (doc 19) |
| HR/biometric SaaS | greytHR, Keka, ESSL biometric | roster sync adapter (exists as design in §11.12) |
| CBWTF vendor | state-authorised operator; some SPCB portals (e.g., Gujarat/Maharashtra) mandate barcode data upload | our manifest is source; export CSV per SPCB format |
| SPCB portal | manual upload | Form IV export |
| Laundry vendor | local; challan-based | counts/kg on bundle |
| Pest vendor | Pest Control India, Rentokil-PCI, local | zone QR scans |
| Water testing lab | NABL lab | result entry (Plan 17 later can accept via LIMS) |
| Tally | credit-note export | existing export mechanism |

**Dependencies:** Plan 13 (registry, `cleaning`/`blocked` vocab) — hard gate · Plan 14 (chemical/bag item master and P3 issue) — soft (HK can start with a stub cost centre) · Plan 15 (theatre kind, `surgery.completed`, recovery-bay release) — consumer · Plan 10 notifications (in-app + escalation) · Plan 08.5 scheduler/worker · Plan 12a harness (for the automations' identity/kill switch) — **automations can ship under the harness the moment 12a lands; until then they run as plain scheduler jobs with the same rule code** (documented exception) · IPD (later) supplies `resource.released` at volume · doc 19 maintenance queue shares `tasks`.

**Events consumed:** resource.released · resource.status_changed · bed.assigned · bed.waitlisted · patient.discharged · patient.deceased · patient.transferred · isolation.flagged · surgery.completed · body.released · code.activated · disaster.declared/ended · surge.activated · downtime.declared/ended · roster.synced · handover.completed · water_quality.recorded · batch.destroyed · exposure.reported · grievance.raised · interface.down.

---

## 12. Buy vs build, hardware & rough INR budget

**Build (in the monolith):** `tasks` kernel component; housekeeping module (turnover, checklists, audits, spills, QR feedback); BMW registers + manifest; linen bundle cycle; pest/fumigation/environment logs; contractor reconciliation; three automations + one agent. **Buy:** HR/biometric attendance (existing decision); laundry service (vendor, day one); CBWTF service (statutory); pest control service; label printing rolls; chemicals (with MSDS from supplier); optional per-piece RFID linen (deferred, L5).

| Item | Qty (day one → 610 beds) | INR |
|---|---|---|
| Attendant Android phones | 4 → 120 | ₹40k → ₹12L |
| Platform weighing scale with BLE/RS-232 | 1 → 3 | ₹15k → ₹60k |
| BMW room mini-PC edge | 1 → 2 | ₹25k → ₹50k |
| Thermal label printers | 2 → 25 | ₹16k → ₹2L |
| Pre-printed serialised labels (per year) | ~50k → 600k | ₹15k → ₹2L |
| Durable QR labels (beds/rooms/toilets) | 100 → 3,000 | ₹5k → ₹1.5L |
| Colour-coded bins/trolleys, spill kits | per floor | ₹1L → ₹15L |
| Fogger units (H2O2) | 1 → 4 | ₹1.5L → ₹6L |
| Object storage for photos (3 y) | 100 GB → 1 TB (NAS/MinIO) | shared with §12 infra |
| CBWTF service | ₹5–8/bed/day | ₹15k → ₹1.5L per month |
| Housekeeping contractor | pool 6–8 → 90–120 @ ₹16–20k/month | ₹1.3L → ₹22L per month |
| Laundry vendor | ₹25–40/kg | ₹20k → ₹4L per month |
| Pest control AMC | — | ₹6k → ₹40k per month |
| Build effort | Plan 19 ≈ 3 phase docs (see §14) | agent tokens per method |

---

## 13. Owner rulings needed

| # | Question | Recommended default & why |
|---|---|---|
| O-1 | Housekeeping in-house vs outsourced at day one? | **Outsourced (CLRA-compliant vendor) with HMIS-computed SLA penalties**; corporate norm; system designed pool-agnostic either way. |
| O-2 | CBWTF vendor + fallback for pickup failure | Sign the primary (already an open owner action); **pre-authorise a secondary CBWTF or a dedicated deep-freezer for anatomical waste** as the 48-h contingency; both recorded in `bmw_authorisation` attributes. |
| O-3 | Occupier signatory for Form IV / Form I | **Medical Superintendent** signs; owner is informed via digest; delegation recorded. |
| O-4 | Turnover SLA defaults (routine 30 / deep 60 / terminal 90 / OT 20 m) and which are active-alert at go-live | Adopt defaults; **record-only at go-live** (§10.3), promote routine turnover to active alert after 60 days of baseline. |
| O-5 | Laundry: vendor day one, in-house plant at ~300 beds? | Vendor now; revisit at 200 beds with measured ₹/kg vs capex (~₹60–90L plant). |
| O-6 | Per-piece linen RFID | Defer (spec L5); revisit if loss % > 3% for 3 months. |
| O-7 | Mercury-free hospital policy | **Adopt** (digital BP/thermometers); removes a hazardous-waste stream and a spill class. |
| O-8 | Attendant PWA as the one hand-built (Lane-1) surface in Track B | **Allow** — it is high-frequency/low-diversity, exactly Lane 1's definition; everything else Lane 2/3. |
| O-9 | Patient/visitor QR feedback: anonymous 5-star + chips only, or optional phone for callback? | Anonymous by default; optional phone with consent, purged 90 d. |
| O-10 | Contractor SLA penalty schedule and cap | Fill-rate shortfall at contracted shift rate ×1.2; SLA hit < 90% → 2% of invoice per 5 points; audit score < 80 → 1%; **cap 10%**; disputes 48 h. |
| O-11 | Turnover Dispatcher tier at Plan 19 ship | T3 shadow 2 weeks → T4 (owner promotes on the eval report). |
| O-12 | Anatomical waste return-to-family policy | Permit with consent form + gate pass + register entry (religious practice is common); else CBWTF. |
| O-13 | `tasks` as a kernel component (vs housekeeping-private table) | Kernel — transport/maintenance/nursing are named P5 consumers; one table avoids Plan 13's seven-copies trap. |
| O-14 | Retention: photos 3 y, BMW registers 10 y (statutory 5) | Adopt. |

---

## 14. Plan sketch — how this becomes phase documents

**Plan 19 splits into three phase documents (proposed; sequencing after Plan 13 T7 deploy):**

**19a — Task fabric + turnover (kernel `tasks`, housekeeping module core).** T1 `tasks`/`task_claims`/`task_evidence` schema + manifest + permission census update (README parity test, like Plan 13) · T2 P5 workflow definitions v1 (turnover routine/deep/terminal; scheduled round; spill) as versioned data + activation via approvals · T3 turnover consumer of `resource.released`/manual release form; `resources.setStatus(available)` on verify; SoD pairs · T4 attendant PWA (scan/checklist/photo/offline queue) + verifier queue (Lane 2) · T5 Turnover Dispatcher rules under scheduler (harness if 12a is live) with rule-trace event · T6 checklist templates, area classes, scheduled run generator, Checklist-Miss Nudger · T7 KPI events + digest lines · golden suite: 30+ assertions from §5 A/B/C/F rows; mutants on claim lock, SoD, onRelease. **Gate:** Plan 13 deployed; `bed`/`room` vocab present; at least the mini-OT recovery bays or manual release path exist.

**19b — BMW chain + registers.** T1 `bmw_*` + hazardous register schema · T2 bag seal/receive/weigh/manifest/handover workflow + edge scale service + label binding · T3 Form IV/Form I drafts, training/immunisation register, authorisation on compliance calendar, rule 4(o) publication export · T4 BMW Gap Watchman · T5 inspector pack export (approval-gated) · T6 vendor certificate + kg 3-way monthly with Plan 14 invoice match (stub if 14 not live). **Gate:** CBWTF contract + SPCB authorisation details in hand (owner action); scale + label hardware bought.

**19c — Linen, pest/fumigation/environment, contractor SLA, QR feedback + Complaint Router.** T1 linen tables + bundle forms + par/variance job · T2 pest/fumigation/environment logs; `environment_sample.resulted` → theatre block hook (Plan 15 consumes) · T3 contractor contract/roster reconciliation + penalty computation + dispute + Tally export line · T4 signed QR feedback page + rate limiting + Complaint Router in shadow · T5 audits/spot-audit sampling + KPI registry entries. **Gate:** HR roster sync adapter live; 12a for the router's inference lane (shadow can precede).

**What must be true before authoring:** Plan 13 CLOSE read (registry API shape, `resource.released` payload); measured census pins (manifests count, permission census, SPA routes, deploy seeds) re-measured at kickoff; owner rulings O-1, O-2, O-3, O-13 (the rest have defaults that can ship).

**Negative-space question — what absence is a signal here?** No `bmw.manifest_recorded` on a working day (pickup failed or nobody weighed) · a bed in `cleaning` with no task (consumer bug or manual status set) · a floor with zero toilet runs after 22:00 (night skeleton collapsed) · a ward with zero linen dispatches for 3 days (par being hoarded or counts skipped) · zero QR ratings from an area for 14 days (QR torn/replaced by a photo) · zero declines and zero re-dispatches for a month (attendants not using the app; supervisor completing on their behalf) · no environmental samples for an OT for 35 days · no spills reported for a month in a 300-bed hospital (under-reporting) · a contractor with a 100% fill rate for 90 days (attendance feed frozen).

**Staff edge-case interview questions (housekeeping supervisor, ICN, BMW handler, linen room):**
1. When the discharge wave hits at noon, what do you actually do first, and who tells you a bed is empty today?
2. How do you know a bed is "verified" today, and who has ever put a patient in a bed before it was cleaned?
3. What happens to a bag that is sealed at 22:00 on a Saturday?
4. Has the CBWTF truck ever not come? For how long? What did you do with the waste?
5. How do you weigh today, and who writes the register? Have you ever estimated?
6. Which wards mis-segregate most, and what do you do when you find a sharp in a yellow bag?
7. How many sheets do you lose a month and where do you think they go?
8. How is infected linen handled at 03:00 with one attendant?
9. Who cleans an OT after an HIV/HBV-positive case and what is different?
10. What chemicals do attendants actually use, and how do they measure dilution?
11. When a visitor complains about a toilet, who hears it and how long until it is cleaned?
12. What does the contractor's supervisor do when the count is short — who signs the attendance?
13. Has anyone had a needle-stick handling waste? What happened in the first hour?
14. What does the SPCB inspector ask for, and what took longest to find last time?
15. What would you refuse to do on a phone app because your hands are gloved/wet?

---

## 15. Open questions & risks

1. **`tasks` kernel vs module** (O-13) changes 19a's file list and the manifest/census pins; must be ruled before authoring.
2. **12a timing:** the automations need the harness for identity/kill switch; shipping them as scheduler jobs first is workable but creates a migration step; confirm whether 12a lands before 19a.
3. **IPD absence at Plan 19:** turnover volume is tiny until IPD; the dispatcher's eval (shadow vs manual) needs the mini-OT recovery bays and the manual release path — the T4 promotion may realistically wait for IPD, per §16's own placement.
4. **State-specific SPCB formats** (Form IV layout, barcode data upload mandates) are unknown until the authorisation details arrive; the export template is versioned to absorb this.
5. **Contractor contract terms** may not match the proposed penalty schedule; the computation is data-driven from `contractor_contracts.sla_schedule`, but the negotiated wording must exist before 19c's T3.
6. **Rule 4(o) website publication of BMW data** — confirm whether the hospital website exists and who publishes; the export job is trivial, the process is not.
7. **Photo evidence volume and DPDP:** staff appear in photos; the DPIA staff-profiling section must cover evidence photos and scan-time data before go-live of 19a.
8. **Theatre kind vocabulary** (Plan 15) must include a `blocked` reason for surveillance failure so 19c's hook has a target; coordinate at Plan 15 authoring.
9. **Water quality for dialysis** is telemetry in the dialysis module; here only the cleaning tasks — confirm the module boundary when the dialysis floor is specced.
10. **Voice-note complaints:** on-device transcription quality in Hindi/Bhojpuri is unproven; ship chips + stars first, voice as an experiment.
