# 19 — Support Services (Dietary/Kitchen · Biomedical Engineering & Maintenance · Mortuary · Security/Visitor · Patient Transport · Oxygen & Utilities · IT/Downtime Operations) — Brainstorm & Planning

**Date:** 2026-08-27 · **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED.
**Series:** Department Brainstorm & Planning, document 19. Sibling of Track B Plan 19 (housekeeping/laundry/BMW) — this document covers the *other* support services and proposes plans 20–25 (§14).

**Executive summary.** Support services are the hospital's plumbing: seven services that no patient sees and every patient depends on. In the fabric they are almost entirely **P5 task-and-track pools** (spec §10.1, §11.12 "pooled queues with claim discipline"), **P3 request-to-issue** (oxygen, kitchen stores, spares) and **utility telemetry** (§11.5, §11.10). None of them is a clinical module; all of them are places where money, safety and statute leak silently when they run on WhatsApp groups and diaries. This document is NOT the housekeeping/laundry/BMW plan (Plan 19, Track B), NOT the ICU telemetry plan, NOT a CMMS product spec — BME's deep asset accounting stays in a bought CMMS only if measurement says the in-fabric P5 + registry model is insufficient (it will not be, at this scale). The three hardest problems: **(1) the P5 pool engine must be built once and serve five departments** (housekeeping, transport, maintenance, security, IT) without five status columns; **(2) oxygen** — the one utility whose failure kills within minutes, where the day-one active alert (§10.3) must survive sensors not yet bought, a supplier who lies about ETA, and a DG that trips; **(3) floor-scoped degradation** (§12 v4.3) is design law but the shipped mode ledger (11c/11d) is hospital-scoped — this document specifies the gap so the IT/downtime plan can close it before a 610-bed building has one floor dark and 609 beds forced onto paper.

---

## 1. Frame — what exists, what is locked, what this document adds

**Built today (Phase 1, live in `commissioning`):** kernel workflow engine (versioned definitions, `workflow_instances`), approvals, RBAC actor fabric, scheduler/worker, events outbox, **ops module** (Plan 11c/11d: operating-mode ledger `commissioning|ramp|normal|degraded|downtime` at hospital scope with go-live gate; **interface heartbeat registry** with kinds `printer|scanner|other`, staleness floor 30 s / default 180 s, `interface.down/.restored`; **downtime kit** — per-desk reserved serial ranges for three form kinds `registration|consultation|receipt`, QR-stamped sheets, backfill through billing's own path), patients, tariff/GST, OPD, billing counter, notifications, memberships, formulary, search, user admin. **Plan 13** (in flight, T1 landed `e913845`): `resources` + `resource_status_history`, ten closed kinds `floor|ward|hall|room|bed|theatre|store|bench|analyzer|device`, kind status vocabularies declared on the manifest seam (DD4), polymorphic occupant (DD6), no containment matrix (DD7), an eleventh kind = kernel edit + migration (DD4 amendment).

**Locked decisions inherited (not re-litigated):**
- §10.1 P5 for housekeeping/transport/maintenance/nursing tasks; P3 for oxygen/consumables; §11.12 pooled queues with claim discipline, **critical-care equipment 30-minute response SLA**, AMC schedules auto-generate preventive tasks, verification on critical tasks; escalation ladders resolve to on-duty role holders; dead-end fallback = duty manager + owner SMS (§11.19-C fix 11).
- §10.3 day-one active alerts include **oxygen stock**; everything else recorded, not paged.
- §11.5 oxygen: cylinders = P3 serialized inventory; LMO/pipeline = telemetry with threshold events; manual dip-reading tasks until sensors installed. §11.10 cylinder lifecycle full → issued → in-use → empty → at-vendor-refill; manifold consumption → cost center; ventilator hours → device-days.
- §11.2 attendant passes (N QR per bed class, scan at ward entry, instant revoke, auto-expiry on discharge/death/transfer); §11.19-C fix 23 signed QR tokens; §11.14 body-release double-verify (tag + gate pass + receiver ID); §11.4 map 12 unclaimed body ladder (72 h → police → municipal), cold-storage charges post to the proper head; §11.19-D fix 33 **body release never gated on payment**.
- §11.14 code system: Code Violet, fire code with evacuation manifest, Code Yellow; §11.17 infant abduction code; §11.14 lost & found register with photo (§11.19-B). Media/police single-spokesperson rule.
- §11.4 map 1 downtime protocol; §12 floor-scoped degradation with staleness banners; §11.19-E fix 28 downtime windows need declarer + second person and appear in the owner digest; §11.19-C fix 15 downtime cash reconciled by a second person; §11.19-C fix 28 backfill-flagged events never trigger agent actions.
- §11.18 sweep: interface heartbeats for every interface, printers/scanners included (§11.19-B); NTP/clock-drift as utility telemetry; no shared accounts; late-entry dual stamp.
- §11.19-B compliance calendar: fire NOC, lifts, AERB, BMW… as `license.expiring` / `statutory_return.due/.filed` (Expiry Watchman scope).
- §11.19-A: AERB registers for radiation equipment (machine QA fail = machine blocked, QC-lockout class); RO water as utility telemetry; §11.19-E fix 33 cold-chain logging on the utility-telemetry pattern; §11.19-C fix 13 device-billing reconciliation for every powered modality.
- §11.18 residual: **dietary tray-tag verification against diet orders**; §11.15 enteral feeds are diet orders; §11.16 OT list synchronises dietary (NPO). **Canteen and parking are out of HMIS scope by decision** (§11.18) — this document touches attendant *meals* (kitchen-produced, billed) and *vehicle gate logs* (security), not the canteen business or a parking system.
- S10 role cards 29 (Dietician), 31 (Duty Manager), 33 (Biomedical Engineer), 34 (Security Supervisor + pool; server-room/NAS custody, CCTV, vendor escort, PSARA vendor), porter/GDA pool note; SoD hard pairs; §12 item 17 labour statutes.
- §16 agent tiers and roster taxonomy; Expiry Watchman already names AMC; Turnover Dispatcher is the T4 precedent for a P5 dispatcher automation.
- Roadmap: Track B Plan 19 = housekeeping/laundry/BMW; deferred notes 3 (three lanes), 5 (KPI formula registry), 10 (Command Centre = watchers), 15 (reservations as state machines).

**What this document adds:** one shared **P5 pool engine** specification reused by all five pooled services; per-service workflow definitions, data models, statutory registers; the **floor-scoped degradation** gap analysis; the **oxygen forecaster** and four automations; ~120 edge rows; plan split 20–25.

**Neighbouring ownership (who owns which table):** Plan 13 registry owns identity/location/status of every floor/room/bed/device/store; BME owns the *equipment lifecycle extension* keyed to `resources.id`. Plan 14 procurement owns vendor master, PO, GRN, AMC/CMC *contracts as documents*; BME owns the *schedule derived* from them. Plan 19 owns the housekeeping pool and BMW; this document proposes the pool engine lands in the kernel (§14) so 19 and 20–25 share it. IPD (later cluster) owns admissions, bed board, passes' bed-class counts; security owns pass *scans* and gate logs. Billing owns every charge; this document only emits charge-bearing events (attendant meals, cold-storage days, transport for non-admitted diagnostics if tariffed, damaged-equipment recovery). HR SaaS owns attendance; roster is HMIS (S10 §12.15).

---

## 2. Actors, roles & role cards

| Role (S10 card or proposed) | Service | Shifts / bundling | Notes |
|---|---|---|---|
| **29 Dietician** (S10) | Dietary | day; on-call nights (bundling matrix) | Signs therapeutic diets; nutrition assessment (NABH); A3: drafts by T2 agent, dietician signs |
| **NEW 29a Kitchen Supervisor / Production Manager** | Dietary | 3 shifts | Production list, tray tagging, FSSAI hygiene log, food sample retention, outsourced-caterer interface |
| **NEW 29b Kitchen Steward / Tray Runner (pool)** | Dietary | 3 shifts | Delivers trays; scans tray-tag at bedside; returns count |
| Ward nurse (S10 nursing cards) | Dietary/Transport/Security | — | Verifies tray vs order at bedside (§11.18 residual); raises transport requests; reports elopement |
| **33 Biomedical Engineer** (S10) | BME | day + on-call; day-one 1 → 6–8 | Owns equipment master extension, PPM/calibration, breakdown P5 tickets, condemnation, AERB liaison with RSO |
| **NEW 33a BME Technician (pool)** | BME | 3 shifts at scale | Claims tickets; first-line repair; electrical safety tests |
| **NEW 33b Maintenance Engineer (civil/electrical/HVAC/plumbing) + fitters (pool)** | Maintenance/Utilities | 3 shifts | Non-medical breakdowns; DG, HVAC, water, lifts; fire systems |
| **NEW 33c Medical Gas Technician** | Oxygen/MGPS | 3 shifts (24×7 at scale) | Manifold changeover, LMO dip readings, cylinder rotation, pipeline alarms |
| AMC/CMC vendor engineer (external actor) | BME | — | Vendor-access workflow (§11.19-E fix 2); acts on tickets via escorted/remote session; never an HMIS login beyond a scoped vendor role |
| RSO / Medical Physicist (§11.19-A, credential registry) | BME (radiation) | — | AERB QA, TLD, source movement |
| **NEW 34a Mortuary Attendant** | Mortuary | 24×7 on-call | Body receipt, tagging, slot assignment, release scan |
| MRD / Medical Superintendent (S10 39) | Mortuary | — | Death certificate (Form 4/4A MCCD), MLC release authority |
| **34 Security Supervisor (+ pool)** (S10) | Security | 3 shifts; PSARA vendor pool | Gate/ward-entry scans, code responses, CCTV custody, body-release verify, vendor escort, lost & found |
| **NEW 34b Gate Officer (pool)**, **34c CCTV Operator** | Security | 3 shifts | Vehicle log, visitor desk, camera watch, clip export under authority |
| Porter / GDA pool (S10 note; day-one 3–4 → 60–80) | Transport | 3 shifts | Claims transport tasks; wheelchair/stretcher/ventilated bundle |
| **NEW 32a Transport Dispatcher (human, day-one; automation at A3)** | Transport | day | Manual dispatch during ramp; supervises Transport Dispatcher automation later |
| **31 Duty Manager** (S10) | all | 24×7 single point | Downtime declare/recover; code authority; escalation terminus |
| **NEW 35a IT Helpdesk Engineer / System Admin** | IT | day + on-call; 1 → 4–6 | Helpdesk tickets, device inventory, printer fleet, network per floor, user device management, backup drill evidence |
| Quality Manager / DPO (S10 37) | all | — | NABH equipment records, FSSAI/fire/lift evidence, DPIA for CCTV |
| Purchase officer (S10 §7) | BME/Utilities | — | AMC renewals, spares POs, oxygen supplier contract |

**Agents/automations (§9 for detail):** Maintenance Ticket Router (automation) · PPM/Calibration Expiry Watchman (Expiry Watchman scope extension, automation) · Diet-Order Compliance Nudge (automation) · Transport Dispatcher (automation, Turnover-Dispatcher sibling) · Oxygen Forecaster (T0, statistical automation) · Kitchen Production Compiler (automation) · Support-Services Digest lines (Digest Writer) · Pass-Misuse Pattern report (Fraud Sentinel class) · Equipment Anomaly Flagger (T0, telemetry-era) · Diet Plan Drafter (T2 agent, S10 card 29 A3) · Incident/RCA Timeline Drafter (T2 agent, quality pack).

**SoD hard pairs (proposed additions to S10 §11):** breakdown ticket *closer* ≠ *verifier* for critical-class equipment · condemnation *proposer* (BME) ≠ *approver* (owner/management) ≠ *disposal witness* · body *releaser* ≠ *identity verifier* (two-person) · CCTV clip *exporter* ≠ *export approver* · attendant-meal *seller* (kitchen) ≠ cash collector (billing counter only; kitchen never handles cash) · downtime declarer ≠ downtime-cash reconciler (S10 already) · oxygen *dip reader* ≠ *reading verifier* on the weekly audit · helpdesk admin creating a user ≠ approver of that user's roles (11e already).

**Shift/bundling:** night: BME on-call resolves through the ladder (ticket → on-duty technician → on-call engineer → vendor hotline → duty manager); mortuary attendant bundles with security night pool at day-one; transport dispatcher bundles into duty manager at night; IT on-call bundles with the outside-developer retainer only for P1 outages (technical continuity kit §11.19-D fix 12).

---

## 3. Core flows as workflow definitions

All definitions are versioned data (§10.2), owner-activated (§10.4). SLAs are **corporate-standard defaults, configurable**; every breach records `sla.breached`; only the marked rows page (§10.3).

### 3.0 The shared P5 pool engine (kernel, proposed; consumed by 19–25)

```
requested ──(auto-dispatch | claim)──▶ assigned ──(accept)──▶ in_progress ──(done)──▶ completed ──(verify, if class requires)──▶ verified
    │                                     │ decline/timeout → back to requested (evented, count++)      │ reject → reopened
    └── cancelled (requester/dispatcher, reason code)                                                    └── closed (no verify needed)
```
Common attributes: `pool` (housekeeping|transport|maintenance|bme|security|it|kitchen), `priority_class` (P0 life-safety … P3 routine), `origin_ref` (encounter, resource, code activation, telemetry event), `location_resource_id` (Plan 13), `sla_per_state`, `requires_verification`, `claimant`, `witness?`. Events: `task.created/.assigned/.accepted/.completed/.verified/.escalated` (existing) + **NEW** `task.declined`, `task.reassigned`, `task.cancelled`, `task.pool_empty` (nobody on duty → dead-end fallback fix 11). Mid-shift departure: open tasks return to pool (§11.12). Pool tablets: one-tap claim, large targets, Hindi/English, photo attach.

### 3.1 Dietary — diet order lifecycle (P2-shaped order, P5 delivery)

```
ordered (doctor/nurse/dietician) ─▶ [dietician_review, if therapeutic] ─▶ active ─▶ (per meal) planned ─▶ produced ─▶ tagged ─▶ delivered ─▶ verified_at_bedside
   │ hold (NBM pre-op / procedure / nausea) ─▶ resumed          │ change (new order supersedes; old → superseded)        └ mismatch → tray.mismatch_flagged → re-issue task
   └ discontinued (discharge/death/transfer auto)
```
- Roles: order — treating doctor, nurse (standard diets), dietician (therapeutic); review — dietician (SLA 2 h day / next-morning night, not paged); production — kitchen supervisor; deliver — steward; verify — nurse or steward bedside scan (wristband + tray tag = one beep).
- Meal cutoffs (default): breakfast list closes 06:00, lunch 10:30, dinner 17:00; late orders → "late tray" task with 45-min SLA; ER/ICU/post-op orders bypass cutoff as `urgent`.
- NBM: pre-op NBM auto-generated from the OT list (§11.16) with the anaesthesia-specified time; NBM held meals are *not produced* (waste lever) and the ward sees a red NBM banner; NBM auto-lifts only on an explicit order, never by clock.
- Allergy/religious/cultural: diet order carries `restrictions[]` from patient master allergy list (§6) + `preference` (veg/non-veg/Jain/no-beef/no-pork/halal/eggless) captured at admission; kitchen sees restriction icons on the production list; a tray tag prints restriction glyphs; allergen mismatch at bedside scan = hard stop.
- Enteral feeds: same order object, `route=enteral`, feed pump = device-days (§11.15).
- Attendant meals: sold per bed as a tariff item (`charge.posted`, terminates on bill), or included by bed class (private ward attendant policy §11.18); prepaid meal coupon = membership-style countable freebie (§7 machinery, not new).
- Events: **NEW** `diet.ordered`, `diet.reviewed`, `diet.held`, `diet.resumed`, `diet.discontinued`, `tray.produced`, `tray.delivered`, `tray.verified`, `tray.mismatch_flagged`, `meal.sold`, `food_sample.retained`, `kitchen_hygiene.recorded`. Consumes: `patient.admitted/.transferred/.discharged/.deceased`, `ot.booked`, `allergy.recorded`, `order.placed (type: procedure)`.
- Outsourced kitchen variant: caterer gets a scoped vendor role that sees *only* the production list (counts per diet code, restriction glyphs, no names) and confirms production; tray tags printed hospital-side; caterer's FSSAI licence on the compliance calendar.

### 3.2 BME — breakdown ticket (P5) with downtime clock

```
reported (any staff, one-tap from device QR) ─▶ triaged (auto: class from registry device → P0/P1/P2/P3) ─▶ assigned ─▶ accepted ─▶ diagnosed ─▶ [awaiting_spare | awaiting_vendor | under_repair] ─▶ repaired ─▶ tested (electrical safety / function check) ─▶ verified (user dept) ─▶ closed
                                                                                                                                 └ condemnation_proposed ─▶ approved ─▶ disposed
```
- SLA defaults: P0 life-support/critical-care (ventilator, defibrillator, anaesthesia workstation, dialysis machine in use, infant warmer): response 30 min (locked §11.12), workaround (loaner/backup asset) 60 min — **pages**; P1 diagnostic critical (CT, analyzer, cath lab): response 2 h; P2: 8 h; P3 (cosmetic/non-clinical): 3 days. Ladder: technician → BME engineer → vendor hotline task → operations head → duty manager.
- Downtime clock: `equipment.downtime_started` at `reported`, `equipment.downtime_ended` at `verified`; registry device status `out_of_service` set/cleared in the same transaction (so OT booking §11.9 cascade and ICU bed board see it).
- Backup asset: P0 ticket auto-creates a *transport task* for the tagged backup ventilator (§11.15 "backup ventilator as tracked asset").
- Events: **NEW** `equipment.breakdown_reported`, `equipment.downtime_started/.ended`, `equipment.loaner_deployed`, `equipment.condemnation_proposed/.approved/.disposed`, `equipment.recalled`, `equipment.recall_cleared`, `electrical_safety.tested`, `ppm.due`, `ppm.completed`, `ppm.overdue`, `calibration.recorded`, `calibration.expired`, `contract.expiring` (AMC/CMC/warranty), `spare.issued` (→ `material.issued` with cost center = device). Consumes `interface.down`, `data_gap.flagged`, `rt_qa.recorded`, `device.usage_started/stopped`.

### 3.3 BME — PPM & calibration (recurring verified tasks)

`scheduled` (auto from contract/manufacturer interval) → `due` (T-14 d) → `assigned` → `done` → `verified` (certificate uploaded; calibration = certificate number, traceability, next due) → `closed`; `overdue` past due+7 d escalates; **calibration expired on a measuring device that gates a clinical value (infusion pump, BP monitor, analyzer, weighing scale for chemo BSA) → registry status `calibration_lapsed` → assignment block** (same mechanism as credential block §11.12; QC-lockout class §11.19-A). Vendor-performed PPM closes only with vendor engineer name + report scan + `vendor_access.logged`.

### 3.4 Mortuary — body custody (P1 tail, P5 tasks)

```
death_recorded (ward/ER/OT; or brought_dead) ─▶ body_prepared (ward: two-staff, tag printed = UHID QR + body tag serial, belongings inventory) ─▶ transport_task ─▶ received_at_mortuary (scan tag) ─▶ slot_assigned (registry) ─▶ [mlc_hold | postmortem_pending | awaiting_documents | embalming] ─▶ release_authorised (MRD certificate + MLC clearance if any + settlement path) ─▶ released (double-verify: tag + gate pass + receiver ID) ─▶ closed
                                                                                                       └ unclaimed ladder: contact attempts (24/48/72 h) ─▶ police intimation ─▶ municipal disposal ─▶ closed_unclaimed
```
- Roles: ward nurse + second staff (prepare); porter (transport, SLA 60 min); mortuary attendant (receive/slot); MS or authorised doctor (release authority, MCCD Form 4/4A); police (external, MLC clearance recorded as document); security (release verify).
- Slot = registry resource; cold-storage chamber temperature = utility telemetry (`coldchain.excursion` pattern). Cold-storage days post daily to the encounter's bill *only where policy says so* (default: first 24 h free, then per-day tariff; MLC/unclaimed → charity/municipal head; never a release gate).
- Events: **NEW** `body.received`, `body.tagged`, `body.slot_assigned`, `body.hold_applied` (mlc|postmortem|dispute), `body.hold_cleared`, `embalming.recorded`, `postmortem.requested`, `body.handed_to_police`, `hearse.dispatched`, `body.unclaimed_escalated`, `body.disposed_municipal`. Existing: `patient.deceased`, `brought_dead.recorded`, `mlc.registered`, `body.released`, `document.release_logged`.

### 3.5 Security & visitor

- **Pass lifecycle (existing §11.2, extended):** `issued` → `active` → (`scanned` n times) → `expired|revoked|reissued`. Extension: **visitor (non-attendant) pass** — desk issues a time-boxed QR/paper pass against a patient/bed with photo capture (optional, DPDP notice), visiting-hours window from bed-class policy; ICU lounge passes and slot bookings; vendor/contractor passes tie to `vendor_access.logged`; VIP movement = confidential-flag path (§14 aliases).
- **Gate log:** every vehicle/person entry at a gate is a `gate.entry_logged`/`gate.exit_logged` event with pass ref; ambulance arrivals link to `er.arrived`; hearse to `hearse.dispatched`; deliveries to a GRN expectation (Plan 14) so an unexpected truck is visible.
- **Codes (P5 fan-out from `code.activated`):** Code Pink (infant abduction §11.17 — NEW code type `pink` in the same catalog), Code Yellow (elopement), Code Violet, fire, bomb threat (NEW type `black`? — use `bomb`), Code Blue is ICU-owned. Activation → roster-resolved converge tasks, gate seal flag (every gate scan refuses exit with an infant/vulnerable patient until cleared), CCTV bookmark auto-created at `occurred_at ± 15 min`, police task, incident register, drill scoring.
- **CCTV incident linking:** HMIS never stores video; it stores `cctv.clip_linked` (camera id, NVR ref, time window, custodian, hash) against an incident; export requires approval + `export.recorded` (§11.19-E fix 28) with purpose; retention policy per DPDP; police requests via the MLC document-release discipline.
- **Lost & found:** `lost_item.recorded` (photo, location, finder, custody), `lost_item.claimed` (ID + signature, WhatsApp to matching patient if tagged), unclaimed 90 d → disposal register.
- **Patient abscond/dispute (E8):** security task + recovery register (existing); elopement of a *vulnerable* patient → Code Yellow (existing).

### 3.6 Patient transport (P5 pool)

```
requested (ward/OPD/radiology/OT/ER; kind: wheelchair|stretcher|bed|ventilated_bundle|walk_escort|specimen|item) ─▶ dispatched (automation or dispatcher) ─▶ accepted ─▶ at_pickup (scan wristband + origin resource) ─▶ in_transit ─▶ delivered (scan destination resource; receiving-end confirm for ventilated) ─▶ [return_leg] ─▶ closed
```
- SLA defaults: ER/ICU/ventilated 10 min pickup (pages); OT-list pickups scheduled from the published list (T-30 min, no page unless late); radiology slot-linked 20 min; routine 30 min; discharge-to-gate 30 min. Both-ends scans give **actual in-department dwell** — radiology's "patient not brought" vs "porter not called" argument ends.
- Ventilated bundle = §11.15 checklist gate before `accepted`; `transport.bundle_completed` on receiving-end confirm.
- Equipment (wheelchairs/stretchers) are registry `device` resources with a home location; a wheelchair scanned at pickup and not scanned home in 4 h = `asset.unreturned_flagged` (NEW).
- Events: reuse `task.*`; **NEW** `transport.requested`, `transport.picked_up`, `transport.delivered`, `asset.unreturned_flagged`.

### 3.7 Oxygen & utilities (P3 + telemetry)

- **LMO tank:** `lmo.level_recorded` (sensor every 5 min or manual dip task 3×/day until sensors — §11.5), thresholds: warning 40 %, **critical 25 % pages** (day-one active), emergency 15 % → duty manager + owner + supplier call task + manifold changeover task. `utility.threshold_breached` (existing) carries `utility: lmo|manifold|cylinder_bank|dg_fuel|water|hvac|ro|fridge`.
- **Cylinder bank/manifold:** cylinders serialized P3 (§11.10) with bank counts (full/empty per size D/B/jumbo); manifold bank changeover = task with count; `cylinder.status_changed` existing; supplier delivery = GRN with serials; vendor rotation ledger (cylinders at vendor vs returned).
- **Supplier SLA:** contract (Plan 14) carries refill lead-time and emergency lead-time; `supplier.eta_recorded` (NEW) on every call; breach → escalation + secondary supplier task.
- **DG/electrical:** `dg.started/.stopped` (auto from ATS signal or manual), fuel level telemetry/dip, monthly load test task, `power.outage_recorded` with duration; UPS runtime for server/ICU on telemetry.
- **Water/RO/HVAC/lifts/fire:** tank levels and RO conductivity (`water_quality.recorded` existing), HVAC/OT differential pressure (§13 sensors), lift AMC + statutory inspection on the compliance calendar (`license.expiring`), fire NOC renewal, hydrant/extinguisher monthly check tasks, **quarterly drill** tasks with `fire_drill.recorded` (NEW) and evacuation-manifest print test.
- Consumption termination (leakage principle): manifold hours → cost center per floor; ventilator hours → patient device-days (already); cylinder issued to an ambulance → ambulance cost center; cylinder issued to a ward → ward cost center with monthly variance vs bed-days.

### 3.8 IT helpdesk & downtime operations

- **Helpdesk ticket (P5 pool `it`):** `reported` → `triaged` (P0 = clinical floor cannot chart/bill; P1 = one desk down; P2 = degraded; P3 = request) → assigned → resolved → verified. P0 ladder: on-duty admin 15 min → duty manager → outside-developer retainer → owner. Ticket may *originate* from `interface.down` (printer/scanner heartbeat) automatically.
- **Hardware inventory:** terminals, tablets, printers, scanners, APs, switches as registry `device` resources (kind `device`, module `it` declares status vocab `in_service|faulty|spare|retired`) with `assigned_to_user`/`location`; `asset.assigned/.returned` (NEW); exit workflow revokes and reclaims (S10 §12.3).
- **Downtime declaration:** today hospital-scope `ops.mode.set` (11c). **Proposed extension:** `downtime_scopes` — a declared window carries `scope: hospital|floor|desk-group` + resource ids; screens on in-scope resources show the staleness banner and switch to the kit; out-of-scope floors keep working. Declaration needs declarer + second person (fix 28). Kit generation per desk stays as shipped; **NEW form kinds** proposed for support services: `diet_slip`, `transport_slip`, `maintenance_slip`, `body_receipt`, `gate_log`, `oxygen_dip_sheet` — all with reserved serials so the reconciliation proves every sheet.
- **Backfill reconciliation:** recovery = backfill screens per kind with `occurred_at` from the sheet; `backfill.reconciled` (NEW) per kit with counts (issued/used/void/missing); missing serial = incident; agents pause during recovery (fix 28).

---

## 4. Data model sketch

Module folders proposed: `dietary`, `bme` (equipment + maintenance + utilities telemetry consumers), `mortuary`, `security`, `transport` (or inside a kernel `pools` component with `transport` as a thin module), `it-ops` (extends `ops`). Each owns its tables; registry rows referenced by id.

**dietary:** `diet_codes` (code, name_en/hi, therapeutic?, kcal/protein/Na/K/fluid limits, texture, default restrictions) · `diet_orders` (patient_id, encounter_id, diet_code, route oral|enteral, restrictions[], preference, ordered_by, reviewed_by?, status mirrors workflow instance, hold_reason, valid_from/to) · `meal_plans` (order_id, meal_slot, date, produced_qty) · `trays` (id ULID, tag serial, order_id, meal_slot, bed_resource_id, printed_at, delivered_at, verified_at, verifier, mismatch_reason?) · `attendant_meals` (bed/encounter, meal, tariff item, charge event ref) · `kitchen_hygiene_log` (daily temp logs, pest control, staff medical fitness, FSSAI Schedule 4 checklist) · `food_samples` (meal, date, retained_by, retained_until (72 h), disposed_at) · `menu_cycles` (14-day cycle per diet code).

**bme:** `equipment` (resource_id FK → registry `device`, asset tag, make/model/serial, category (life-support|diagnostic|therapeutic|lab|imaging|utility|IT), criticality P0–P3, purchase_date, cost, warranty_to, amc_contract_id (Plan 14), cmc?, manufacturer_ppm_interval, calibration_required?, calibration_interval, radiation? (AERB licence no., type), consignment? , condemned_at) · `maintenance_tickets` (workflow mirror, equipment_id, reported_by, class, diagnosis, spare lines, vendor_visit refs, downtime_start/end, root_cause code) · `ppm_schedules` / `ppm_records` (checklist template versioned, done_by, certificate doc) · `calibrations` (cert no., agency, traceability NABL?, result, next_due) · `electrical_safety_tests` (IEC 62353 class, leakage values, pass/fail) · `spares` (item master lines in Plan 14 stores; issued with cost center = equipment) · `condemnations` (proposal, reason, approvals, disposal method (e-waste/BMW), buyer/scrap value → Tally) · `recalls` (manufacturer notice ref, affected serials, action, cleared) · `equipment_downtime_register` (statutory/NABH view, derived) · `aerb_registers` (source movements, TLD reads, QA records — from §11.19-A, stored here or in radiology module; this doc proposes BME owns *equipment QA*, radiology owns *dose*) · `mgps_inspections` (pipeline pressure tests, alarm panel tests, outlet checks per NFPA 99/HTM 02-01 style checklist).

**mortuary:** `bodies` (id, patient_id?, encounter_id?, brought_dead?, tag_serial (signed QR), received_at, received_by, slot_resource_id, holds[], belongings inventory ref, embalming record, release: authorised_by, doc refs (MCCD, MLC clearance, police NOC), receiver name/ID type/ID no./relation/photo?, hearse, released_at, releaser, verifier) · `mortuary_register` (statutory view — as table, append-only) · `unclaimed_body_log` (attempt timestamps, channel, outcome; police intimation; municipal handover doc) · `postmortem_log` (police requisition, hospital-to-govt mortuary transfer). Slots: registry `bed` kind under `room` "Mortuary" (see §15 Q1 on vocabulary).

**security:** `passes` (existing IPD concept — attendant; extend `kind: attendant|visitor|vendor|contractor|vip_escort|lounge`) · `pass_scans` (pass_id, gate/ward resource, result allow|deny(reason), scanner user/device) · `gate_log` (vehicle no., type, purpose, in/out, linked ref) · `code_activations` (type, activated_by, location, converge tasks, cleared_at, drill?) · `cctv_links` (incident_id, camera, window, NVR ref, hash, export approvals) · `lost_found` · `security_incidents` (register — theft, violence, trespass, VIP, media) · `visitor_hours_policy` (per ward/bed class).

**transport:** `transport_requests` (kind, patient_id?, origin/destination resource ids, priority, scheduled_for, bundle checklist ref, pickup/deliver scans, porter) · `transport_assets` = registry devices (wheelchair/stretcher) + `asset_movements`.

**utilities (in bme or a kernel `telemetry` consumer):** `utility_points` (registry device: LMO tank, manifold, DG, UPS, water tanks, RO, fridge, OT pressure), `utility_readings` (TimescaleDB for sensor streams; Postgres for manual dips), `utility_thresholds` (versioned), `cylinders` (serial, size, gas, status lifecycle, location, vendor, last_hydro_test), `gas_supplier_calls` (eta, actual), `dg_runs`, `fuel_log`, `fire_safety_log` (extinguisher checks, hydrant tests, drills, NOC docs), `lift_log`.

**it-ops (extends `ops`):** `downtime_scopes` (window id, scope kind, resource ids, declarer, second person, started/ended), `downtime_form_kinds` promoted to data, `helpdesk_tickets`, `it_assets` (registry device + `assigned_to`), `network_segments` (floor ↔ VLAN/AP/switch inventory, for the floor-degradation blast radius), `backfill_reconciliations`.

**Registry kinds needed (Plan 13):** `device` (equipment, wheelchairs, printers, sensors), `bed` (mortuary slots, proposed), `room` (kitchen, mortuary, gas control room, server room), `store` (kitchen dry store, spares store, cylinder bank), `floor`. No new kind is proposed; the mortuary-slot vocabulary rides the `bed` kind's declared statuses plus module-owned semantics (Q1).

**Retention (proposed defaults):** equipment records — life of asset + 3 y (NABH asks full history); calibration certs — 5 y; mortuary register — permanent (MLC indefinite §11.14); pass scans — 1 y; gate log — 1 y; CCTV *links* — with the incident (video itself per DPDP notice, default 30–90 d on NVR); food sample log — 1 y; kitchen hygiene — 3 y; diet orders — with the medical record (IPD ~10 y); helpdesk — 3 y; downtime windows — permanent (digest analytics).

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → test/assertion → ruling ref.** Grouped by theme; dietary D, BME B, mortuary M, security S, transport T, utilities U, IT/downtime I, cross-cutting X.

### Identity & wrong-patient
| ID | Scenario → behaviour → assertion → ruling |
|---|---|
| D1 | Two Ram Kumars in general ward, one diabetic one renal; steward swaps trays → bedside scan wristband + tray tag; mismatch = hard stop, `tray.mismatch_flagged`, re-issue task → test: scan pair (bed A wristband, tray for bed B) returns deny + event. |
| D2 | Patient transferred ICU → ward after lunch list closed; tray goes to old bed → `patient.transferred` re-homes open meal plans; production list re-prints delta → test: transfer event moves next tray's bed_resource_id; old bed shows "no active order". |
| D3 | Attendant eats patient's therapeutic tray and patient gets nothing → verification requires wristband scan, not bed scan; unverified tray past 30 min → nudge → test: tray without `tray.verified` at +30 min emits `sla.breached`. |
| M1 | Two deaths within an hour in ICU; bodies tagged with swapped UHIDs → tag printed *from the encounter* at bedside by two-staff scan (wristband → tag pairing like mother-baby §11.4 map 2); mortuary receipt re-scans wristband + tag → test: `body.received` with wristband/tag mismatch throws, no slot assigned. |
| M2 | Family identifies "wrong body" at release (facial change after 3 days cold) → release verify shows admission photo + wristband scan; disputed identity → hold, MS review, incident → test: release without matching three scans is impossible via API. |
| M3 | Brought-dead unknown (UNK) later identified → `patient.merged` carries body record; tag unchanged; register shows both ids → test: merge preserves body row, register history. |
| S1 | Attendant pass photographed and shared on WhatsApp → signed QR (§11.19-C fix 23) + per-scan nonce; second scan of same pass within 2 min at a different ward = deny + `pass.anomaly_flagged` (NEW) → test: replay at two readers within window denied. |
| S2 | Newborn leaving with a woman holding a valid attendant pass but *different* baby → Code Pink gate rule: any exit with an infant requires mother-baby band pair scan (§11.4 map 2) → test: exit scan with infant flag and no pair verification = deny. |
| T1 | Porter takes wrong patient to CT (same name, adjacent beds) → pickup scan wristband must equal `transport_requests.patient_id`; mismatch = deny, not warn → test: mismatch returns error, task stays `dispatched`. |
| T2 | Unconscious ER patient without wristband (UNK) needs CT → transport allowed on UNK band (map 8 zero-blocking) → test: UNK patient id passes the pickup scan. |
| B1 | Ticket raised on a device by scanning a QR that was re-stuck on a different machine → QR is signed to `resource_id`; ticket shows make/serial for confirmation; BME can re-map with `registry.drift_flagged` → test: fixture with swapped labels flags drift on serial mismatch at repair. |

### Timing, concurrency, race
| ID | Scenario → behaviour → assertion |
|---|---|
| D4 | Diet changed at 10:29, lunch list closes 10:30 → order change after cutoff spawns `late_tray` task rather than silently missing lunch → test: change at cutoff+1s creates late task; at cutoff−1s updates list. |
| D5 | NBM lifted by surgeon verbally, nurse serves, then anaesthetist re-imposes → NBM is an order with actor; conflicting orders within 10 min → dietician/nurse alert, last-signed wins, both evented → test: two `diet.held/.resumed` ordering preserved. |
| D6 | Two nurses "verify" the same tray on two tablets → idempotency key = tray id; second verify returns already-verified, no double event → test. |
| B2 | Two technicians claim the same P0 ticket → single-winner transition (engine semantics); loser sees "claimed by X" → test: concurrent claims yield one `task.assigned`. |
| B3 | Ventilator ticket closed at 02:10 while patient still on backup; loaner never returned → loaner deployment has its own return task; closing the parent ticket with an open loaner return is blocked → test. |
| B4 | PPM due date arrives while device is in a running OT case → PPM task cannot force `out_of_service`; it waits for `device.usage_stopped`; overdue clock still runs → test: status change refused while occupant set. |
| M4 | Release document signed by MS at 09:00, MLC clearance arrives 11:00, family arrives 10:00 → release blocked on open hold regardless of authorisation; UI shows the specific hold → test. |
| M5 | Slot capacity: 4 slots, 5th body arrives during an outbreak → registry refuses `already_occupied`; module offers overflow (hired freezer box = temporary registry device) + refer-to-govt-mortuary task; owner digest line → test: 5th assignment errors, overflow flow creates device. |
| S3 | Visiting hours end 19:00; scan at 18:59:59 vs 19:00:01 → policy resolved at scan time with server clock (NTP §11.18); grace window configurable (default 15 min) → test boundary. |
| S4 | Code Pink activated, then cleared, then re-activated within 5 min → each activation is its own instance; gate seal flag is a counter, not boolean → test: clear of first does not unseal the second. |
| T3 | OT list re-sequenced (§11.16) after porter already dispatched → `ot.list_resequenced` re-times the transport; porter tablet shows "hold/return" → test. |
| T4 | Same porter dispatched to ICU stretcher and OPD wheelchair by two dispatchers → pool engine: one active P0 task per porter; second assignment queues → test. |
| U1 | LMO sensor reports 24 % then 26 % then 24 % (slosh) → hysteresis: alert on crossing down, clear only on 5-point sustained recovery → test: flapping series emits one breach, one clear. |
| U2 | Manual dip reading entered *after* the 08:00 task SLA with `occurred_at` 07:50 → allowed as late entry (`late_entry.flagged`), SLA breach still recorded → test. |
| I1 | Downtime declared at 14:00; a nurse's tablet had a form open since 13:58 and submits at 14:03 → submit accepted (server up on other floors) but stamped in-window; recon report lists it → test. |
| I2 | Two duty managers declare overlapping floor scopes → scopes union; end requires both windows' second-person confirm → test. |

### Partial failure & downtime
| ID | Scenario → behaviour → assertion |
|---|---|
| D7 | Kitchen printer dead at 05:45 (breakfast) → `interface.down` → helpdesk P1 auto-ticket; production list also renders on the kitchen tablet + WhatsApp PDF to supervisor (fallback ladder) → test: printer down triggers ticket and alternate render event. |
| D8 | Server down over lunch → paper `diet_slip` kit serials per ward; kitchen cooks from last printed list (printed 10:30); trays tagged with handwritten serial; backfill enters verifies with `occurred_at` → test: backfill of 40 trays reconciles serial range. |
| B5 | BME ticket system down during a P0 ventilator failure → phone (PBX) to BME; paper `maintenance_slip`; the 30-min SLA is measured from the paper time at backfill; the register shows a downtime-window flag → test: backfilled ticket carries `occurred_at` < `recorded_at` and window id. |
| B6 | Vendor remote session for CT drops mid-repair → `vendor_access.logged` closes with `outcome: interrupted`; ticket returns to `awaiting_vendor` → test. |
| M6 | Mortuary fridge compressor fails at night → `coldchain.excursion` on the mortuary chamber → P0 maintenance ticket + transfer bodies task (overflow) + duty manager page → test: excursion emits ticket with class P0. |
| S5 | QR scanners on floor 6 lose network → floor-scoped degradation: readers fall back to visual check of printed validity + manual gate log kit; scans backfill → test: `downtime_scope` floor 6 flips reader UI mode. |
| S6 | PBX down and code activated → app push + SMS to roster-resolved responders (§11.13 ladder); PBX heartbeat (§11.19-E fix 23) already down → ladder skips PBX leg → test: activation with PBX `down` emits notifications on remaining channels. |
| T5 | Porter tablet battery dies mid-transport → task stays `in_transit`; destination desk can complete on its own scanner ("receive") → test: delivery by receiver role closes task. |
| U3 | Power failure; DG starts; ATS signal not wired → manual `dg.started` task appears the moment `power.outage_recorded` is logged by anyone; server on UPS shows runtime countdown banner → test. |
| U4 | Oxygen sensor gateway offline → `interface.down` for the sensor → automatic reversion to manual dip tasks 3×/day (§11.5) until restored → test: interface down creates recurring tasks; restored cancels future ones. |
| I3 | Only the *billing* desk's scanner dies → not a downtime; helpdesk P1 + manual-ID-verify fallback (§11.19-B) → test: no mode change. |
| I4 | Backfill: 12 registration serials used, 10 backfilled, 1 voided, 1 missing → `backfill.reconciled` with missing=1 → incident task; the recon cannot close with missing>0 without a duty-manager note → test. |
| I5 | Cloud VM unreachable (stage 1) for 40 min; hospital-wide downtime → declaration cannot be written *to the DB that is down* → local declaration on paper with time; recorded at recovery as the window start (`occurred_at`); Prometheus/Alertmanager alert (11c flag ⑤) is the evidence → test: window recorded with `occurred_at` earlier than first post-recovery event. |
| I6 | Agent runtime halted (global halt) during recovery → Transport Dispatcher and Ticket Router pause; pool falls back to manual claim; no task is lost (fail-open) → test: with halt flag, `task.created` still lands in pool and humans can claim. |

### Money — billing, refunds, payers, packages, TPA
| ID | Scenario → behaviour → assertion |
|---|---|
| D9 | Attendant meal sold in private ward where bed class includes one attendant meal → tariff engine: included quantity is a countable freebie per day; extras charge → test: 2nd meal charges, 1st doesn't. |
| D10 | TPA patient: therapeutic diet is part of room rent per policy; hospital tried to add "special diet ₹300/day" → diet charges only via tariff items flagged payer-billable; TPA config denies → test: charge suppressed for TPA payer class. |
| D11 | Patient discharged at 11:00, lunch tray produced at 10:45 and delivered → charge (if any) posts before the no-pending-charges gate; wasted tray recorded as waste cost center → test: `patient.discharged` discontinues order; produced-but-undelivered tray → waste event. |
| B7 | AMC vendor bills for a visit that never happened → PPM/breakdown visit requires `vendor_access.logged` + engineer name; invoice 3-way match (Plan 14) against visit events → test: invoice without matching visit event flags. |
| B8 | Equipment damaged by attendant (dropped monitor) → damage recovery charge is a tariff item with approval (owner O-4); never auto-posted → test: charge requires `approval.granted`. |
| B9 | Spare part issued to a device under warranty → spare cost center = vendor recoverable; monthly report of warranty-period spares → test: cost center resolution. |
| B10 | Condemned machine sold as scrap for cash ₹22,000 → 269ST/40A(3) cash layer applies to receipts too; scrap sale is an invoice via billing (non-patient revenue head) → test: cash > threshold blocked. |
| M7 | Family cannot pay ₹40,000 bill; body release → release never gated on payment (fix 33); settlement is a separate human-paced workflow; cold-storage charges stop at release → test: release API ignores balance. |
| M8 | Cold storage for 9 days pending police clearance (MLC) → charges post to MLC/charity head, not the family → test: hold type mlc reroutes cost center. |
| M9 | Unclaimed body disposal cost → municipal/charity head; no invoice to nobody → test. |
| T6 | OPD patient's CT transport (wheelchair + porter) — chargeable? → default: not chargeable for in-house diagnostics; ambulance is (separate module) → ruling O-5. |
| S7 | Lost-and-found cash ₹15,000 → sealed two-person custody, register; unclaimed 90 d → owner decision (O-6) → test: two-person custody event required for cash items. |
| U5 | Oxygen supplier invoices 40 jumbo cylinders; GRN scanned 36 serials → 3-way match blocks; vendor rotation ledger shows 4 unreturned empties too → test. |
| U6 | ICU ventilator hours (device-days) billed but manifold consumption implies 3× the flow → leakage triangle for gases (issued vs billed device-days vs telemetry) → test: report row generated. |
| I7 | Downtime receipts total ₹1,85,000 on paper; backfilled ₹1,80,000 → reconciliation by *second person* (fix 15) flags ₹5,000; cannot close → test. |

### Consent, legal, MLC, minors, unconscious
| ID | Scenario → behaviour → assertion |
|---|---|
| M10 | MLC death: police want body moved to government mortuary for post-mortem → `body.handed_to_police` with requisition doc scan, receiving constable ID/badge, `document.release_logged`; injury report release only against logged requisition (map 12) → test. |
| M11 | Family requests embalming for transport to Bihar → embalming certificate (required by airlines/rail) generated with doctor signature; `embalming.recorded`; charge posts → test. |
| M12 | Death of a minor, parents divorced, both claim body → release to the person named in the admission as guardian (`guardian.linked` §11.19-D); dispute → MS + legal hold, police if needed → test: release to non-guardian requires override event. |
| M13 | Suspected organ-donation case → deferred protocol (§11.14) — system records brain-death committee flag and blocks release until committee outcome; register placeholder → test. |
| M14 | Body release to a "relative" with no ID → ID type/number mandatory; "no ID" path requires second relative + police-verified letter for MLC; non-MLC with MS override evented → O-7. |
| S8 | Police ask for CCTV of a ward corridor → export needs approval + purpose + `export.recorded` + hash; patient privacy: only the window; MLC document discipline → test. |
| S9 | Minor visitor (child < 12) in ICU → policy block by ward config; exception by intensivist logged → test. |
| S10 | Psychiatric patient's family forbids a specific visitor (restraining order) → per-patient visitor blocklist on the encounter; scan of a pass issued to blocked person denied; security alerted quietly → test. |
| D12 | Patient refuses therapeutic diet (wants home food) → `refusal.recorded` (§11.14) per meal; dietician counselling task; outside food policy acknowledgement → test. |
| D13 | Unconscious patient, enteral feed prescribed, family wants "fasting on Ekadashi" → clinical order stands; counselling logged; no auto-hold from preference → test: preference cannot set `diet.held`. |
| B11 | AERB inspector demands CT QA records for 2 years → `aerb_registers` export within TAT; missing month = the gap is visible not hidden → test. |
| T7 | Ventilated transport without escort checklist signed → `accepted` blocked (bundle gate) → test. |

### Staff absence, overload, handover
| ID | Scenario → behaviour → assertion |
|---|---|
| X1 | Night: no BME on duty, on-call phone off → ladder rung timeout 10 min → next rung → duty manager + owner SMS (fix 11) → test: dead-end fallback fires. |
| X2 | Single porter on night pool with 6 P0 requests → `overload.flagged` (S10 §12.13); Transport Dispatcher orders by clinical priority and pickup proximity; nurse-escort variant offered → test. |
| X3 | Dietician on leave; therapeutic orders queue → bundling: on-call dietician; review SLA 2 h → escalation to medical director after 4 h; standard diet proceeds meanwhile → test. |
| X4 | Kitchen supervisor mid-shift departure → open production tasks return to pool; hygiene log incomplete → digest → test. |
| X5 | Security shift change while Code Yellow is active → handover gate lists open codes; incoming supervisor must acknowledge → test: `handover.completed` blocked without code ack. |
| X6 | Mortuary attendant absent; body arrives → security night pool receives (bundling); slot assignment by any pool member; MS informed → test. |
| X7 | IT admin quits; laptop with admin creds → exit workflow same-hour revoke (S10 §12.3), asset return task, continuity-kit escrow unchanged → test. |
| X8 | Gas technician alone during manifold changeover and LMO delivery simultaneously → two P0 tasks; delivery accepted by security at gate with serial scan; changeover first → test. |

### Equipment failure
| ID | Scenario → behaviour → assertion |
|---|---|
| B12 | Infusion pump recall notice from manufacturer for serial range → `equipment.recalled` freezes all matching devices (status `recalled`), creates return/patch tasks, blocks assignment; clear per serial → test: assignment of recalled device errors. |
| B13 | Defibrillator fails its daily check in ICU → check task fail → P0 ticket + swap with spare + crash-cart register line → test. |
| B14 | Electrical safety test overdue on 40 devices at once (annual) → batch scheduling with capacity limits; overdue ladder doesn't page 40 times (alarm fatigue) — one digest line → test: 40 overdue produce 1 escalation summary. |
| B15 | Central sterile autoclave (mini-OT, Plan 15) BI fail → CSSD's `cssd.bi_failed` also opens a BME ticket for the autoclave → test: subscription creates ticket. |
| B16 | Medical gas pipeline pressure drops on floor 5 → `utility.threshold_breached (manifold_pressure)` → P0 ticket + ward alert to switch to cylinders + cylinder issue tasks → test. |
| B17 | LINAC QA fails → `rt_qa.recorded fail` → registry status `blocked` (QC-lockout); BME ticket; fractions cannot be scheduled → test. |
| B18 | Wheelchair with broken brake reported by attendant via QR → P3 ticket; asset status `faulty`, removed from transport pool → test. |
| B19 | Lift stuck with patient inside → Code (lift entrapment) → maintenance P0 + security + AMC vendor + fire dept if > 30 min; register → test. |
| B20 | Equipment with no data export (legacy) fails silently — no heartbeat to see → registry attribute `interfaced: false`; PPM checklist includes function test; digest shows "blind" devices count → test. |
| U7 | DG fails to start on outage; UPS runtime 20 min → server shutdown runbook banner at 10 min; ICU hall on separate UPS; incident → test: UPS threshold emits `utility.threshold_breached (ups_runtime)`. |
| U8 | Water tank contamination (E. coli) → `water_quality.recorded fail` → dialysis RO block + kitchen alert + tanker task → test: fail blocks dialysis session board. |

### Data quality, late-arriving, backdated
| ID | Scenario → behaviour → assertion |
|---|---|
| B21 | Calibration certificate uploaded with date 6 months old, next due already past → device flips to `calibration_lapsed` immediately; not a green tick → test. |
| B22 | Vendor PPM report says "done" but device was in another building → PPM completion requires device QR scan at the device (location) → test: completion without scan is `unverified`. |
| B23 | Equipment master imported from Excel: 300 rows, 40 duplicate serials, 25 no location → import quarantine (membership import precedent) with per-row errors; nothing lands without a registry parent → test. |
| D14 | Diet order written on paper round, entered 3 h later → late entry dual-stamped → test. |
| M15 | Death time recorded 02:10 on certificate, `patient.deceased` at 02:55 → certificate uses `occurred_at`; register shows both; MCCD form pulls `occurred_at` → test. |
| S11 | Gate log vehicle number typed "DL 3C AB 1234" vs "DL3CAB1234" → normalised storage, display as typed → test. |
| U9 | Dip reading 4,900 L after yesterday's 1,200 L without a delivery GRN → plausibility check flags `reading.implausible` (NEW) → verify task → test. |
| I8 | Helpdesk ticket "system slow" with no floor → triage requires location resource; auto-fill from the reporting terminal's registry id → test. |

### Fraud, leakage, gaming
| ID | Scenario → behaviour → assertion |
|---|---|
| D15 | Kitchen produces 220 trays for 180 diet orders daily (extras sold/consumed) → production vs orders vs delivered vs attendant-meals-sold triangle; variance > 5 % → anomaly report → test. |
| D16 | Attendant-meal coupons sold by steward for cash → kitchen never takes cash; meals only against bed/coupon; steward cash = policy breach; Fraud Sentinel: meals delivered without charge event → test. |
| B24 | Technician closes P0 tickets in 25 min every time (SLA gaming) → time-to-verify by *user department* is the KPI, not time-to-close; close-time clustering anomaly → test: KPI formula uses `task.verified`. |
| B25 | Spares issued to "condemned" device repeatedly (phantom device) → spares to a device in `condemned/disposed` status blocked → test. |
| B26 | Condemnation of a working ultrasound to sell it → condemnation requires BME report + second engineer + owner approval + disposal witness + photo; PCPNDT machine condemnation additionally needs the PCPNDT authority intimation → test. |
| M16 | Mortuary attendant releases a body to a relative for a "tip" without paperwork → release impossible without three scans + authoriser event; the gate pass is generated only by the release transition → test. |
| M17 | Unclaimed body "adopted" by a medical college without process → transfer to institution requires police NOC doc + MS approval → test. |
| S12 | Security pool member issues visitor passes to touts/agents → pass issuance is desk-role only, count per patient per day capped, pattern report (same issuer, many patients) → Fraud Sentinel → test. |
| S13 | Staff-as-patient record: guard looks up a colleague's ward via scanner → confidential flag: scan returns allow/deny only, never patient name → test. |
| T8 | Porters "complete" transports without moving (both-end scans at same location within 1 min) → geo/resource sanity: origin ≠ destination scan resources; impossible timing flag → test. |
| U10 | Empty cylinders "returned to vendor" never come back full; vendor rotation ledger → cylinders at vendor > 7 d → task; monthly count → test. |
| U11 | Diesel pilferage: DG hours vs fuel consumption vs deliveries → triangle with tolerance band → test. |
| I9 | Repeated 20-minute floor downtimes on billing floor every Saturday evening (paper cash window) → downtime analytics in digest (fix 28) → test: pattern surfaces. |
| I10 | User shares tablet login on ward → no shared accounts; fast PIN switching (§11.18 #6); helpdesk device-management shows session user churn → test. |

### Privacy, sealed records, VIP, staff-as-patient
| ID | Scenario → behaviour → assertion |
|---|---|
| S14 | VIP (minister) admitted; visitor list controlled by PSO → VIP flag: passes issued only by duty manager; alias on gate displays; movement plan as security task with restricted visibility → test: pool members can't see VIP's bed. |
| S15 | Media at gate after a death → single-spokesperson rule; security incident register; no info via scanners → test. |
| D17 | Kitchen production list shows names + HIV status through a "diet code" like "PLWHA diet" → diet codes must never encode diagnosis; production list shows bed + restriction glyphs only; names optional per policy → test: no diagnosis field reaches kitchen role. |
| M18 | Journalist asks mortuary attendant about a celebrity death → mortuary register access restricted; VIP alias; no public display → test. |
| S16 | CCTV footage of a staff member as patient exported for HR → not permitted without DPO approval; purpose-bound → test. |
| I11 | Helpdesk engineer opens a patient record "to test" → not in role; break-glass is ER-only; access review flags → test. |
| X9 | DPDP data-principal request includes "delete my visitor passes and gate logs" → erasure allowed after retention floor; MLC/incident-linked entries survive with reason → test. |

### Language, literacy, accessibility
| ID | Scenario → behaviour → assertion |
|---|---|
| D18 | Bhojpuri-speaking attendant asked about food allergies at admission → allergy/preference capture in Hindi with pictograms; "unknown" is a valid state rendered honestly (copilot law 6) → test: null ≠ "none". |
| D19 | Tray tag readable by a steward who cannot read English → tag uses colour band per diet class + Hindi + glyphs; scanner confirms verbally (TTS optional) → test: tag render includes glyph set. |
| S17 | Attendant cannot read pass instructions → pass carries visiting hours as icons + Hindi; WhatsApp message in patient language preference (§6) → test. |
| M19 | Body-release documents in English for a family reading only Hindi → bilingual release form; explanation checklist logged → test. |
| T9 | Porter pool tablets: large targets, 3 buttons (claim/picked/delivered), voice prompt in Hindi → UX budget test on 7" tablet. |
| B27 | Ward nurse reports "machine kharab" via Hindi voice note → helpdesk/BME ticket accepts voice attachment; transcription is data not instruction (note 13) → test. |

### Scale (100/day → 2,000/day, 10 → 610 beds)
| ID | Scenario → behaviour → assertion |
|---|---|
| D20 | 600 inpatients × 3 meals = 1,800 trays/day; production list must compile in < 2 s; label print 600/hour → perf test with 610-bed fixture. |
| T10 | 400 transports/day, 60 porters, dispatcher automation must assign within 5 s of request → perf fixture. |
| B28 | 4,000 devices; PPM calendar month view → query < 300 ms; batch task creation nightly → perf. |
| S18 | 2,000 pass scans/hour at 18:00 visiting rush at 6 ward entries → scan API < 100 ms p95, offline-tolerant reader cache of signed keys → perf + degraded-mode test. |
| U12 | 45 ICU beds on ventilators — LMO consumption 3× today; forecaster horizon must remain ≥ 48 h at peak → forecaster test with peak fixture. |
| I12 | 610-bed building, 12 floors, 400 terminals — floor-scoped windows must not cascade to hospital scope through a shared switch failure → network segment inventory drives blast-radius; test: segment down maps to correct floors only. |
| M20 | Mortuary 12 slots; festival-week road accidents → overflow protocol + govt mortuary liaison; capacity KPI → test. |

### Integration failures (device/vendor/ABDM)
| ID | Scenario → behaviour → assertion |
|---|---|
| U13 | Oxygen sensor vendor's cloud API is the only data path (no local MQTT) → procurement mandate: local MQTT/Modbus output required (same as ICU monitors §11.15); sensors without local output not bought → O-3. |
| B29 | CMMS vendor SaaS (if bought) cannot export → buy only with export; else in-fabric (§12 buy-vs-build) → design note. |
| S19 | Access-control vendor (turnstiles) closed protocol → HMIS issues signed QR; turnstile vendor must verify via a local HTTP endpoint on the edge; else readers are HMIS tablets → O-8. |
| S20 | NVR time drift by 6 minutes → CCTV links store hospital `occurred_at` and NVR offset measured by `clock.drift_flagged` (§11.18) → test. |
| I13 | Printer heartbeat says up; paper out → heartbeat ≠ health; print job status where driver allows; else "printed?" confirm on critical docs (gate pass) → test. |
| D21 | Outsourced caterer's own app cannot read HMIS lists → caterer role in HMIS (scoped, no names); no integration to build → note. |
| T11 | Nurse-call hardware (bought, §11.18) emits "porter" button → lands as transport request via the edge adapter; if adapter down, nurse uses tablet → fail-open test. |
| X10 | ABHA/ABDM unaffected — no support-service data leaves; DPIA class: staff and visitor personal data (DPDP) only → design note. |

### Cross-cutting residue
| ID | Scenario → behaviour → assertion |
|---|---|
| X11 | Fire code on floor 3: evacuation manifest printed per ward (§11.14); transport pool flips to evacuation tasks; passes: all gates open outward, entry sealed; oxygen: zone valve closed task with confirmation → test: `code.activated (fire)` fans out to 4 pools. |
| X12 | Disaster mode (map 13): kitchen surge (extra 200 meals), BME pre-stages ventilators, security converts lobby, transport prioritises ER→OT/ICU; all via `mode.context_applied` gates → test: agents read mode. |
| X13 | Seasonal surge (§11.14): oxygen forecaster widens safety stock; supplier standing order task → test. |
| X14 | Owner's 8 a.m. digest: equipment down list, oxygen days-of-cover, tray mismatch count, open P0 tickets, unclaimed bodies, code activations, downtime windows → Digest Writer fact-sheet includes these lines → test: fact sheet fields present. |
| X15 | Any agent errors → pools still accept human claims; no human path awaits agent (lint) → existing rule, cited. |

*(Row count: D1–D21, B1–B29, M1–M20, S1–S20, T1–T11, U1–U13, I1–I13, X1–X15 = 142.)*

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**6.1 Monday 05:40 — LMO delivery no-show + DG trip.** 05:40 forecaster (T0) shows 19 h cover at 60 %... wait: the sensor reads 31 %, forecaster projects critical at 14:00, supplier ETA recorded yesterday as 06:00. 06:30 no tanker; `supplier.eta_recorded` overdue → Gas technician task "call supplier", escalation to purchase officer at 07:00. 07:10 supplier says 16:00. Forecaster re-projects with the ICU census: cover ends 13:40 — **`utility.threshold_breached (lmo, projected)`** pages the duty manager and the owner (day-one active alert). Humans: technician switches ICU-riser to manifold at 25 % rule, security accepts 30 jumbo cylinders from the standby vendor at the gate by serial scan (emergency local purchase ₹15k float… exceeded → approval on phone browser), transport pool moves cylinders as `item` transports. 11:20 grid failure; DG starts; ATS signal logged; 11:32 DG trips on overheat → `utility.threshold_breached (ups_runtime)`, P0 maintenance ticket auto-created, BME + maintenance converge; ICU on hall UPS 40 min; duty manager declares **floor-scoped degraded** for OPD floors (elective imaging stops), not for ICU. Paper: oxygen dip sheet continues 2-hourly on the kit serials. Agents: forecaster keeps projecting from manual dips (flagged manual source); Ticket Router had already assigned the DG ticket to the on-duty electrician. Recovery: DG restored 12:05; tanker 15:50; every cylinder's status chain shows vendor → gate → ward → empty; audit shows two threshold pages, one approval for the float overrun, the degraded window with declarer + second person, and the supplier SLA breach on the vendor scorecard.

**6.2 Server unreachable 13:00–14:10, whole hospital, during lunch service and two deaths.** 13:00 Alertmanager pages; duty manager declares hospital downtime on paper (`occurred_at` 13:02). Kitchen already has the 10:30 list; trays go out with handwritten serials from the `diet_slip` kit; nurses verify by reading the wristband aloud against the slip (manual-ID fallback). 13:20 death in ward 4: nurse and colleague fill `body_receipt` kit form, tag with the kit serial, porter moves body; mortuary attendant logs slot on paper. 13:40 second death in ER (brought-dead MLC): paper MLC register. Security: readers show cached signed-key validation for passes (still works offline for validity; scan logs buffer on the reader). 14:10 recovery: backfill screens per kit; the two bodies get real tags printed and re-paired to the paper serials (`body.tagged` with `occurred_at` 13:25); tray verifications backfilled by ward clerks; scan logs upload from readers. Recon: 62 diet slips issued, 58 used, 4 void, 0 missing → `backfill.reconciled`. Agents paused throughout (fix 28); Diet Nudge does not fire on backfilled trays. Audit: the window appears in the digest with duration 68 min, declarer + second person, and a "kit kinds used" breakdown.

**6.3 Ventilator failure in ICU hall 2 at 02:15 with BME on-call unreachable.** Nurse scans the ventilator's QR → ticket opens with class P0 auto-derived; Ticket Router assigns on-duty technician (none at night day-one) → on-call engineer; 10-min rung timeout with no accept → vendor hotline task + duty manager page + owner SMS (dead-end fallback). Backup ventilator transport task auto-created; porter pool claims; receiving-end confirm. 02:31 engineer accepts remotely, arrives 02:58 (response SLA breached, recorded). Device status `out_of_service` visible to OT booking. Paper path: none needed (only ICU hall's own tablets). Audit: `equipment.downtime_started` 02:15 → `verified` 06:40 by ICU in-charge, ladder timeline, the breach and its cause (on-call unreachable → roster gap `bench.gap_flagged`).

**6.4 Code Pink at 17:50 in the mother & child floor during visiting rush.** Nurse one-touch → `code.activated (pink)`; gate seal counter increments at all 4 gates; every exit scan with an infant flag denies; CCTV bookmark 17:35–18:05 auto-created on the floor cameras; security converge tasks to roster-resolved guards; police task; management alert. 17:57 band-pair mismatch alarm at the nursery door resolves it: a grandmother carrying the right baby without the mother's band. Clear by security supervisor + nursery in-charge (two roles). Drill scorer computes converge times. Audit: activation, 11 denied exit scans (with pass ids), clip link, clearance, incident register entry; no patient names on any public surface.

**6.5 Kitchen FSSAI inspection at 10:00, same morning as a mass food-poisoning complaint from ward 6.** Inspector asks: licence, medical fitness of handlers, temperature logs, pest control, water test, retained food samples for the last 72 h. HMIS: `kitchen_hygiene_log` export, `food_samples` for the 3 days with retention timestamps and custodian, licence on the compliance calendar. Complaint: grievance workflow (§11.14) opens; quality manager pulls trays delivered to ward 6 last evening (`tray.delivered` by bed), the diet codes, the production batch, and the retained sample id → sends to lab; incident register; patients' encounters get a note from the treating doctor (clinical). The outsourced caterer's role sees only the production confirmations. Audit: inspection visit logged (`inspection.visit_logged`), the tray-to-batch trace answered in one query.

**6.6 Floor 6 network switch dies at 09:30 for 3 hours while the rest runs (stage-3 on-prem).** `interface.down` for 6 printers/scanners on floor 6 within 3 minutes; helpdesk P0 auto-ticket; network-segment inventory maps the switch to floor 6 only; duty manager + IT admin declare **floor-scoped** degraded for floor 6 (two-person); screens on floor-6 resources show staleness banners; ward tablets on Wi-Fi from floor 5's AP keep working (partial); paper kits for floor 6 desks. Transport requests for floor 6 patients are raised by phone to the dispatcher who enters them. Recovery 12:40: scope ended; backfill of 14 nursing forms; reconciliation. Digest: one floor window, 190 min, root cause "switch PSU", AMC claim task.

**6.7 Unclaimed brought-dead body, 72 h, in the same week as an owner audit.** Day 0 UNK brought-dead MLC; slot assigned; police intimation recorded. Day 1: contact attempts (police missing-persons cross-check, WhatsApp to number found on the body — logged); Day 2: second attempts; Day 3: `body.unclaimed_escalated` → police 72 h rung; Day 5: municipal disposal doc uploaded, `body.disposed_municipal`; cold-storage days to the municipal/charity head. The audit walks in on Day 4 and asks for the unclaimed-body register: it is a table view with each rung's timestamp and actor; the belongings inventory has two staff signatures and a photo.

**6.8 VIP + violence + fraud in one hour.** 19:00 VIP admitted under alias; passes by duty manager only. 19:20 attendant of another patient assaults a nurse → Code Violet, police task, lockdown flag; CCTV link. 19:40 a "relative" of the VIP presents a screenshot pass → signature fails (`qr.signature_failed`), deny, security escorts; pass-misuse pattern lands in Fraud Sentinel. All three are separate incidents with separate registers; the VIP's identity appears nowhere in the Violet incident.

---

## 7. Compliance, audit & statutory surfaces

| Surface | Statute / standard | First-class table | Who signs | Retention |
|---|---|---|---|---|
| Equipment master, history cards, PPM & breakdown records, downtime register | NABH FMS chapter (equipment inventory, PPM, calibration, breakdown response), Clinical Establishments Act minimum standards | `equipment`, `ppm_records`, `maintenance_tickets`, `equipment_downtime_register` | BME engineer; user dept verifies | Life of asset + 3 y |
| Calibration certificates (NABL-traceable where required) | NABH; ISO 15189 for lab analyzers (Plan 17 shares) | `calibrations` | BME + agency | 5 y |
| Electrical safety tests | IEC 62353 / IS 13450 practice; NABH | `electrical_safety_tests` | BME technician | 5 y |
| Radiation equipment: AERB licence, QA, TLD, source movements, decommissioning | AERB (Atomic Energy (Radiation Protection) Rules 2004; e-LORA) | `aerb_registers` (with radiology/oncology) | RSO, medical physicist | Permanent for sources |
| PCPNDT machine registration & condemnation intimation | PCPNDT Act | `equipment` flag + compliance calendar | Owner / authorised | Permanent |
| Medical gas pipeline system tests, cylinder hydro-test dates | Gas Cylinder Rules 2016 (PESO), NABH MGPS checks | `mgps_inspections`, `cylinders` | Gas technician; AMC vendor | 5 y |
| Fire NOC, drills, extinguisher/hydrant checks, evacuation manifest test | State Fire Services Act, NBC 2016 Part 4, NABH FMS | `fire_safety_log`, compliance calendar | Security/maintenance; QM | NOC life; logs 3 y |
| Lift licence & periodic inspection | State Lifts Act | `lift_log`, compliance calendar | Maintenance | Licence life |
| DG set registration, emission, fuel storage | State pollution board (DG noise/emission), Petroleum Rules for diesel storage > threshold | `dg_runs`, compliance calendar | Maintenance | 3 y |
| Kitchen: FSSAI licence, Schedule 4 hygiene, handler medical fitness, food sample retention, water testing | FSS Act 2006 + FSSAI regs | `kitchen_hygiene_log`, `food_samples` | Kitchen supervisor; QM audits | 1–3 y |
| Diet/nutrition assessment coverage | NABH COP (nutrition screening) | `diet_orders` + assessment record | Dietician | With medical record |
| Mortuary register, body handover, unclaimed-body log, embalming certificates, MCCD Forms 4/4A | Registration of Births & Deaths Act 1969; CrPC 174 (police inquest for MLC/unnatural death); state mortuary rules | `mortuary_register`, `unclaimed_body_log`, `bodies` | MS/authorised doctor; police receipts | Permanent |
| Security: PSARA-licensed vendor, guard registers, visitor logs, CCTV notice + retention, incident register | PSARA 2005; DPDP 2023 (notice, purpose limitation); Code of Criminal Procedure for police requests | `passes`, `pass_scans`, `gate_log`, `cctv_links`, `security_incidents` | Security supervisor; DPO for exports | Scans 1 y; incidents 5 y |
| Code drills (Violet/Pink/Yellow/fire) | NABH FMS/HIC | `code_activations (drill=true)` | QM | 3 y |
| Downtime windows, kit serial reconciliation, backfill | NABH IMS (downtime procedure), CERT-In (6-h for cyber incidents) | `downtime_scopes`, `backfill_reconciliations` | Duty manager + second person | Permanent |
| IT asset register, access reviews, USB/managed-browser policy | DPDP, CERT-In directions 2022 (180-day log retention) | `it_assets`, access review events | IT admin; DPO | Logs 180 d min |
| Vendor access log | §11.19-E fix 2 | `vendor_access` | Escorting staff | 3 y |

**What NABH asks to see (assessor walk):** equipment list with criticality, one device's full history card (purchase → PPM → breakdowns → calibration → condemnation), the last 3 months' P0 response times, calibration currency %, the fire drill records with evacuation times, mortuary register with release documents, visitor policy and evidence of enforcement, downtime SOP and the last drill's reconciliation, kitchen hygiene logs and diet-order-to-tray verification evidence. Every one of these is a table view or a saved query, never a compiled report.

**DPDP data classes:** patient (diet restrictions → health data), deceased persons (DPDP applies to nominees), visitors/attendants (name, phone, photo, ID number → notice at pass desk, purpose = security, retention 1 y), staff (helpdesk, asset assignment), vendor personnel (access logs), CCTV imagery (notice signage; export purpose-bound). Inference: none of these leave the boundary except in the T2 drafters (§9), which are tokenised.

---

## 8. Staff KPI & KRA

All KPIs event-derived, load-normalised, diagnostic (S10 §2). Formulae are candidates for the KPI formula registry (roadmap note 5).

**Dietician (29)** — KRA: every therapeutic diet ordered, reviewed, delivered, verifiably right; nutrition screening coverage.
- Therapeutic review TAT = median(`diet.reviewed` − `diet.ordered` where therapeutic) / load: orders per dietician-shift. Target < 2 h day.
- Tray verification rate = `tray.verified` / `tray.delivered` (per ward, since it is a nursing act — dietician sees it, nurse owns it). Target > 98 %.
- Therapeutic error rate = `tray.mismatch_flagged` / therapeutic trays. Target → 0. Gaming: verifying without scanning is impossible (scan pair required).
- Nutrition screening coverage = admissions with assessment within 24 h / admissions. NABH.
- Enteral-feed order currency = active enteral orders reviewed within 48 h.
- Reading: high mismatch on one ward = tagging/production issue, not the dietician.

**Kitchen supervisor (29a)** — KRA: right count, right tag, on time, hygienic, wasteless.
- On-time service = trays `tray.delivered` within the meal window / trays. Load: trays per steward.
- Production variance = (produced − ordered − attendant meals sold) / ordered. Target < 5 %. Gaming: producing fewer and skipping beds shows as undelivered trays.
- Hygiene log completeness = daily checklist items recorded / required; sample retention 100 %.
- Late-tray SLA = late tasks completed < 45 min.
- Outsourced caterer fill rate (vendor scorecard).

**Biomedical engineer (33) + technicians** — KRA: every device working, calibrated, provably maintained; no blind critical device.
- P0 response = (`task.accepted` − `equipment.breakdown_reported`) for P0 ≤ 30 min, %. Load: P0 tickets per technician-shift.
- Workaround time = `equipment.loaner_deployed` − reported, P0.
- Downtime by class = Σ(downtime_ended − started) per criticality / device-days. Diagnostic: rising downtime on one make = procurement input.
- PPM completion = `ppm.completed` on time / `ppm.due`. Target 100 %. Gaming: completion requires device scan at location.
- Calibration currency = devices with valid calibration / devices requiring. NABH.
- Repeat-breakdown rate = same device ticketed twice in 30 d.
- Ticket verify-to-close gap = verified by user dept / closed by BME (a low ratio = closures without verification — the KPI resists close-time gaming).
- Cost per bed-day of maintenance (owner view).

**Gas technician (33c)** — KRA: never below threshold unplanned; cylinders accounted.
- Threshold breaches per month; cylinder rotation loss (at vendor > 7 d); dip-task punctuality; manifold changeover time.

**Mortuary attendant (34a)** — KRA: custody without gaps; release with documents; dignity.
- Receipt TAT (death → `body.received`); release TAT after authorisation (target < 1 h); hold-documentation completeness; unclaimed ladder adherence (each rung on time); temperature excursions acknowledged < 15 min.

**Security supervisor (34) + pool** — KRA: boundaries that hold, codes that converge.
- Scan compliance at ward entries (scans / expected entries from visiting-hour model); deny-rate reasons; code converge time (activation → first `task.accepted` by security) target < 3 min; drill completion; gate-log completeness (vehicles logged vs camera count sample); lost-found closure; body-release verifications 100 % three-scan. Gaming: scanning a colleague's pass repeatedly shows as replay anomaly.

**Porter pool / Transport dispatcher** — KRA: right patient, right place, in SLA.
- Pickup SLA by priority; dwell at destination (delivered → return requested); assets unreturned; scan integrity (both-end scans distinct); requests per porter-shift (load).

**IT helpdesk (35a)** — KRA: every desk works; every outage is scoped, declared, reconciled.
- P0 response < 15 min; interface `down` MTTR; printer fleet availability; ticket backlog age; backup restore-drill success (weekly, 11a/11b); patch compliance; downtime windows reconciled with missing=0; user offboarding same-hour revoke rate.

**Duty manager (31) (support-services slice)** — escalations reaching rung "duty manager" resolved in SLA; downtime declarations with second person 100 %; code clearances documented.

**Owner's 8 a.m. digest — support services block:** open P0 equipment tickets (device, hours down) · calibration-lapsed critical devices (count) · oxygen: LMO % + days-of-cover (forecaster) + cylinders full/empty + supplier ETA · DG runtime yesterday + fuel days · tray mismatches yesterday + production variance % · bodies in mortuary (holds by type; unclaimed rung) · code activations (type, converge time) · passes denied (replays) · transport P0 SLA % · downtime windows (scope, duration, missing serials) · licences expiring ≤ 30 d.

---

## 9. AI agents & the copilot — where inference earns its place

Rule applied: deterministic automation wherever a rule suffices (§16). Only three candidates are inference agents, all T2 drafters, none clinical-acting.

| Name | Kind | Tier | Trigger / inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance / eval | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|
| **Maintenance Ticket Router** | automation | T3 → T4 (operational) | `equipment.breakdown_reported`, `interface.down`, `utility.threshold_breached`; registry device criticality, roster on-duty, technician skills, open-load | assigns pool + class + first responder; creates loaner transport for P0 | none for assignment; BME can reassign (`task.reassigned`) | pool remains claimable; ladder runs on SLA regardless | per-agent; halts to manual claim | rules versioned; eval = mis-class rate reviewed weekly by BME | staff duty data | Plan 20 |
| **PPM/Calibration Expiry Watchman** | automation (Expiry Watchman scope) | T1 | nightly: `ppm_schedules`, `calibrations.next_due`, `contract` expiries, licences | `ppm.due`, `calibration.expired` → registry status, tasks; digest lines; 60/30/14-day ladder | none; status flip is a rule | BME can mark done manually | shared with Expiry Watchman | rule version | none | Plan 20 |
| **Diet-Order Compliance Nudge** | automation | T1 | `tray.delivered` without `tray.verified` +30 min; NBM order with a produced tray; allergy change with active order; therapeutic order unreviewed > 2 h | nudges to ward nurse worklist / dietician; never changes an order | n/a | worklist shows the same rows without the nudge | per-agent | rule version | patient health data (in-system only) | Plan 21 |
| **Transport Dispatcher** | automation (Turnover Dispatcher sibling) | T4 operational | `transport.requested`, porter on-duty + location (last scan), priorities, OT list timings | assigns porter; re-dispatches on decline/timeout; batches same-corridor pickups | dispatcher human can override | manual claim from pool; day-one human dispatcher | per-agent | rule version; eval = SLA attainment vs manual baseline | none | Plan 23 |
| **Oxygen Forecaster** | automation (statistical; no LLM) | T0 | LMO readings (sensor or dip), ICU/ward ventilator device-days, census, weather-independent 7-day consumption, supplier ETA | projected hours-to-threshold, days-of-cover, recommended order quantity; emits `utility.threshold_breached (projected)` only at the day-one active level | purchase officer orders; gas technician acts | thresholds on raw level still page without forecaster | per-agent | model = documented regression, versioned; back-test error published monthly | none | Plan 24 |
| **Kitchen Production Compiler** | automation | T3 (acts: prints lists) | cutoff clock; active diet orders; NBM; transfers | production list + tray tags; delta prints | kitchen supervisor confirms production | manual list from worklist | per-agent | rule version | health data glyphs only to kitchen role | Plan 21 |
| **Equipment Anomaly Flagger** | automation, later T0 | T0 | device telemetry where interfaced (ventilator alarms, analyzer QC drift, fridge temps), repeat-ticket counts | "device X trending to failure" digest lines; suggested pre-emptive PPM task | BME | none needed | per-agent | thresholds versioned | none | Plan 20 phase 2 / telemetry plan |
| **Pass-Misuse & Gate Anomaly report** | Fraud Sentinel class | T0 | `pass.scanned/.anomaly_flagged`, issuance per issuer, gate-log gaps | report with disposition workflow (fix 18) → security supervisor | reviewer disposition | — | Fraud Sentinel switch | rule version | visitor personal data | Plan 22 |
| **Diet Plan Drafter** | agent (LLM) | T2 (clinical cap) | dietician request; tokenised fact sheet: diagnosis codes, labs (creatinine, K, Na, HbA1c), weight/BMI, allergies, preference, current order | draft therapeutic diet plan citing fact-sheet lines (copilot §2.4 typed claims) | dietician edits + signs; draft provenance stamped | dietician writes plan | per-agent | model id/prompt version/input+output hash; eval: citation faithfulness, allergen-contradiction fixtures | health data, tokenised, DPIA L1 | post-12a, Plan 21 phase 2 |
| **Incident / RCA Timeline Drafter** | agent (LLM) | T2 | quality manager request on an incident id; event trail (equipment ticket, code activation, downtime window) | narrative timeline draft citing event ids | QM edits/signs | QM writes | per-agent | provenance; eval: uncited-claim drop rate | staff data tokenised | Quality pack |
| **Support-Services Digest lines** | Digest Writer (existing agent) | T0 | fact sheet fields in §8 | digest block | — | fact-sheet fallback | existing | existing | none | with each plan |

**Three presentation lanes for this department's work (roadmap note 3):**
- Lane 1 hand-built: pool tablet (claim/picked/delivered, three buttons, Hindi); pass scanner screen (allow/deny only); kitchen production board; oxygen panel (level, cover, cylinders, one "call supplier" button); BME P0 board.
- Lane 2 schema-generated worklists/forms: PPM checklists, calibration entry, condemnation form, hygiene log, gate log, lost & found, helpdesk tickets, mortuary register entries, cylinder receipt — all from tool-catalog schemas.
- Lane 3 conversational copilot (Ops Copilot, post-registry): "which ventilators are out of service?", "oxygen cover tonight?", "who has the CT's AMC?", "trays unverified on ward 6" — read-only over the asker's permissions; write actions only by proposing a tool call that renders as a Lane-2 form.

**Journey Feed contributions (patient timeline):** diet order/hold/tray verified · transport picked-up/delivered (dwell) · pass issued/denied for the patient's attendants (restricted) · death → mortuary custody → release (restricted) · equipment downtime affecting the patient's booked slot (OT cascade).

**Prompt inputs (concrete) for Diet Plan Drafter:** `[PT-1] age-band, sex, diagnosis codes (ICD), latest labs {creatinine, eGFR, K, Na, albumin, HbA1c, RBS}, weight/height/BMI, allergies[] (verification state), preference enum, current diet code, texture/route, fluid restriction order, fasting orders`; output schema `{summary, observations[], plan: {diet_code, kcal, protein_g, Na_mg, K_mg, fluid_ml, restrictions[]}, citations[]}`; "insufficient evidence" first-class (note 14).

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **One beep context:** device QR (signed, resource id) → ticket pre-filled with device, location, criticality, last PPM, open tickets; tray tag ↔ wristband pair scan; pass scan; body tag; cylinder serial; wheelchair tag. Every printed thing here carries a QR (§7).
- **Three-button pool tablets** with big targets, colour by priority, vibration on P0; claim-by-scan of the location QR (proves presence).
- **Keyboard-first desks:** pass desk (UHID → bed → N passes → print, 4 keystrokes), helpdesk, BME desk; F-keys for claim/close.
- **Pre-filled forms:** PPM checklist from template + last values; calibration next-due computed; NBM from OT list; diet order defaults from admission preference.
- **TAT clocks on every board:** P0 tickets (30/60 min), transports by priority, tray delivery windows, unverified trays, release TAT, unclaimed rungs, supplier ETA.
- **Worklists, not menus:** BME by class then age; kitchen by meal slot; security by gate; porters by proximity; IT by floor.
- **Print as first-class:** production list per ward with glyph legend; tray tags 2-colour band; body tag on tear-resistant stock; passes with visiting hours icons; evacuation manifest one-tap; kit forms with serials.
- **Voice (lawful):** Hindi voice note on tickets (data, never instruction); TTS confirmation at scan for low-literacy stewards; no recording of patients.
- **Offline-tolerant readers:** signed-key cache for pass validity; scan buffering with idempotency keys (§11.18 #10).
- **Measured targets:** ticket creation from QR ≤ 10 s; pass scan p95 ≤ 100 ms; production list ≤ 2 s at 600 beds; transport dispatch ≤ 5 s; forecaster run ≤ 30 s; tray verification ≤ 2 scans; body release ≤ 3 scans + 1 signature; kit backfill ≤ 60 s per form.
- **Auditability:** every state change an event with actor; every register a table; every export `export.recorded`; every override named; downtime windows in the digest; SoD pairs enforced not requested.

---

## 11. Integrations, devices & dependencies

| Need | Device / vendor examples (India) | Protocol | Edge rule |
|---|---|---|---|
| LMO tank level, manifold pressure | Tank vendors (INOX Air Products, Linde India) level transmitters; third-party 4–20 mA/Modbus gateways; ESP32/industrial IoT gateways from local integrators | Modbus RTU/TCP → MQTT (Mosquitto, §5) → TimescaleDB; threshold evaluator in worker | Sensors must expose local output (O-3); gateway on edge VLAN with mTLS (§11.19-D fix 21); heartbeat; manual dips until live |
| Cylinder serials | Barcode/QR labels (durable); handheld scanners | USB HID / tablet camera | Same scan API as stores |
| DG/ATS, UPS runtime, fuel | DG controllers (Kirloskar/Cummins panels with Modbus), UPS (APC/Emerson SNMP) | Modbus/SNMP → MQTT | Utility points are registry devices |
| Water tank/RO/fridge/OT pressure | Level sensors, conductivity meters, temperature loggers (§13 sensors line) | MQTT | Manual recurring verified tasks day one (§11.19-E fix 33) |
| Fire alarm panel | Addressable FAS (Honeywell/Siemens/Ravel) | Dry contact/Modbus → event `code.activated (fire)` optional; else manual one-touch | Never the only path; manual first |
| Access/turnstiles/CCTV | Matrix, Hikvision/CP Plus NVRs | HMIS issues signed QR; turnstile verifies via local endpoint; NVR untouched — HMIS stores links | O-8 |
| Pass/tag/tray printers | Zebra/TSC label printers; wristband printers (§13) | Network print + heartbeat (ops interfaces) | Kinds `printer` already exist |
| Nurse-call → porter button | Bought hardware (§11.18) | Dry contact/HTTP adapter | Fail-open |
| Equipment telemetry (later) | Ventilators/monitors HL7 via CMS (§11.15); analyzers QC (Plan 17) | HL7 v2/MQTT | BME consumes `data_gap.flagged`, QC fail events |
| Radiation QA | LINAC/CT vendor QA tools; RSO manual entry | Manual / CSV | `rt_qa.recorded` existing |
| AMC/CMC contracts, spares, gas supplier, caterer | Plan 14 vendor master, rate contracts, GRN | internal | BME schedules derive from contract rows |
| HR/biometric | SaaS | roster feed (HMIS is roster SoR) | Pools resolve on-duty |
| PBX paging | IP-PBX with API (§11.19-E fix 23) | SIP/API | Codes second leg |
| Tally | vouchers export | CSV | Condemnation/scrap, AMC payments |

**Dependencies:** Plan 13 (registry) hard gate for all; Plan 14 (contracts, GRN, spares, vendor master) for BME and oxygen; Plan 19 (shares the P5 pool engine — decide home in §14); IPD cluster for diet orders' encounter context, attendant passes' bed-class counts, death cascade; Plan 12a harness for automations; 11b/stage-3 for floor-scoped networks; Quality pack for incident registers; Plan 15 mini-OT for NBM from OT list and autoclave tickets. **Events consumed:** `patient.admitted/.transferred/.discharged/.deceased`, `brought_dead.recorded`, `mlc.registered`, `ot.booked`, `allergy.recorded`, `interface.down/.restored`, `utility.threshold_breached`, `data_gap.flagged`, `cssd.bi_failed`, `rt_qa.recorded`, `code.activated`, `downtime.declared/.ended`, `roster.published`, `grn.received`, `contract`/`license.expiring`, `mode.context_applied`.

---

## 12. Buy vs build, hardware & rough INR budget

**Build (in the monolith):** P5 pool engine (kernel), dietary, BME/maintenance, mortuary, security passes/logs/codes, transport, utilities threshold consumer, it-ops extensions. Rationale: they own tables + workflows, are event-bound to the patient spine, and are thin over the fabric. **Buy:** CCTV/NVR and access hardware, fire alarm system, PBX, sensors/gateways, label printers, an optional CMMS *only* if BME at 610 beds proves the in-fabric model insufficient (do not buy now), FSSAI-side lab water testing (service), HR/roster attendance. **Licensed content:** none needed here.

| Item | Rough INR |
|---|---|
| Oxygen/utility sensors + gateway (already in §13) | ₹50–80k (stage 2); + ₹1.5–2.5L at 610 beds (DG/UPS/water/fridges) |
| Durable QR labels for ~4,000 devices + cylinders + label printers ×3 | ₹1.5–2.5L |
| Pool tablets (7–8") ×15 day-one → ×80 at scale, rugged cases | ₹2–3L → ₹12–16L |
| Pass/tray/body-tag printers ×6 → ×25 | ₹1–1.5L → ₹4–6L |
| Handheld scanners at ward entries/gates ×8 → ×40 | ₹40–60k → ₹2.5–3.5L |
| Access-control/turnstile integration (optional) | ₹3–8L (vendor-dependent) |
| Mortuary overflow freezer box (portable) ×1–2 | ₹1.5–3L |
| Kitchen tablets/board ×3 | ₹40–60k |
| Software build effort (6 plans) | tokens, not ₹ — see §14 |
| Recurring: AMC data-export clauses in every equipment purchase | ₹0 if mandated at tender |

---

## 13. Owner rulings needed

- **O-1 P5 pool engine home:** kernel component shared by Plans 19–25 vs inside Plan 19. *Recommend kernel* (one engine, five pools; a second status column set would be the two-homes trap Plan 13 exists to prevent). Sequencing consequence: Plan 19's first task builds it.
- **O-2 Mortuary slot vocabulary:** reuse registry `bed` kind for cold-storage slots (recommended; no kernel edit) vs eleventh kind `slot`. Recommend `bed` under a `room` "Mortuary", occupant = body id.
- **O-3 Sensor procurement mandate:** no oxygen/utility sensor without local Modbus/MQTT output (mirrors the ICU monitor mandate). Recommend adopt.
- **O-4 Damage recovery from attendants/visitors:** charge equipment damage to the patient bill behind approval (recommended default: approval-gated, capped, never auto) vs never charge.
- **O-5 In-house transport charges:** recommend not chargeable (bundled in bed/diagnostic tariff); ambulance separate.
- **O-6 Lost & found cash/valuables unclaimed after 90 days:** recommend hand to police station with receipt (safest legal posture) vs charity head.
- **O-7 Body release without receiver ID (non-MLC):** recommend MS override only, evented, with second relative + photo; MLC never.
- **O-8 Access hardware:** HMIS-tablet readers at ward entries (recommended day one, cheap, in-fabric) vs turnstiles with vendor integration (610-bed option).
- **O-9 Cold-storage tariff:** first 24 h free, then per-day; MLC/unclaimed to charity/municipal head; never a release gate (fix 33). Recommend adopt as config.
- **O-10 Attendant-meal policy per bed class:** private/deluxe include one attendant meal per day; others sold at tariff via bill (no cash at kitchen). Recommend adopt.
- **O-11 Visiting hours default:** 16:00–19:00 general wards, 11:00–12:00 + 17:00–18:00 ICU lounge slots, 24-h stay attendant in private (existing §11.18 policy) — confirm numbers.
- **O-12 Outsourced kitchen:** run own kitchen vs caterer; if caterer, the scoped-role model (no names, glyphs only) and FSSAI licence on the calendar. Recommend caterer at day-one scale with own supervisor; revisit at 200 beds.
- **O-13 CCTV retention & notice:** 30 d default rolling, 90 d for ICU/mortuary/cash counters; signage in Hindi/English. DPO to confirm.
- **O-14 Floor-scoped degradation** as the next `ops` increment (Plan 25) before stage 3 on-prem, with the six additional kit form kinds. Recommend yes; it is design law (§12) not yet shipped.

---

## 14. Plan sketch — how this becomes phase documents

Numbering continues the roadmap (19 = housekeeping/laundry/BMW, Track B). Proposed:

- **Plan 19 (existing, Track B) — add T0:** the kernel **P5 pool engine** (O-1) — definitions, claim discipline, decline/timeout return, pool_empty fallback, pool tablet Lane-1 screen, `task.declined/.reassigned/.cancelled/.pool_empty` events, perf fixture (400 tasks/day). Gate: Plan 13 T6 deployed.
- **Plan 20 — BME & Maintenance & Utilities telemetry consumer.** T1 equipment extension table over registry `device` + import quarantine · T2 breakdown ticket definition (P0–P3, downtime clock, loaner transport) · T3 PPM/calibration/electrical-safety schedules + Expiry Watchman scope + registry status flips (`calibration_lapsed`, `recalled`, `blocked`) · T4 condemnation/recall/spares (Plan 14 seam) · T5 utility points + thresholds + `utility.threshold_breached` consumer + manual dip tasks + oxygen panel · T6 cylinders P3 (serials, vendor rotation) + supplier calls · T7 Oxygen Forecaster (T0) + digest lines · T8 Ticket Router automation (12a harness) · T9 statutory registers (AERB seam, MGPS, fire/lift/DG logs, compliance calendar rows). Gates: Plan 13, Plan 14 vendor/contract tables, 12a for automations (T7/T8 can ship rule-only under the harness later).
- **Plan 21 — Dietary/Kitchen.** T1 diet codes + orders + restrictions from patient master · T2 order workflow (hold/NBM from OT list, review SLA) · T3 production compiler + tray tags + bedside pair-scan verification · T4 attendant meals (tariff seam) + waste/variance triangle · T5 hygiene/FSSAI/food-sample registers · T6 Diet Nudge automation · T7 downtime `diet_slip` kit kind + backfill. Gates: IPD admissions live (encounters with beds), Plan 19 pool engine for steward tasks; Diet Plan Drafter (T2) after 12a + DPIA.
- **Plan 22 — Mortuary + Security/Visitor.** T1 passes extension (visitor/vendor/lounge kinds, signed QR already) + scan API + reader screen · T2 gate log + vehicle + lost & found · T3 code catalog extension (pink, fire fan-out, lift entrapment) + converge tasks + gate-seal counter + drill scoring · T4 CCTV link + export governance · T5 mortuary custody workflow + registry slots + holds + release three-scan + unclaimed ladder + registers · T6 Pass-misuse Fraud Sentinel class · T7 kit kinds `gate_log`, `body_receipt`. Gates: Plan 19 engine; IPD death cascade; PSARA vendor onboarding.
- **Plan 23 — Patient Transport.** T1 requests + kinds + both-end scans · T2 SLA classes + OT-list/radiology-slot timing consumers · T3 transport assets (registry devices) + unreturned flag · T4 ventilated bundle gate (§11.15) · T5 Transport Dispatcher automation · T6 `transport_slip` kit kind. Gates: Plan 19 engine, IPD/OT lists (mini-OT Plan 15 gives the first list).
- **Plan 24 — (folded into 20 T5–T7 unless the owner wants utilities separate).** Recommend fold.
- **Plan 25 — IT Ops & floor-scoped downtime.** T1 `downtime_scopes` + two-person declaration + scoped staleness banners + mode-context for agents · T2 kit form kinds promoted to data + six new kinds · T3 backfill reconciliation table + missing-serial incident + second-person close · T4 helpdesk pool + auto-tickets from `interface.down` · T5 IT asset register over registry devices + assignment + exit-workflow hook · T6 network-segment inventory (floor ↔ switch/AP) for blast radius · T7 digest analytics for windows. Gates: 11c/11d live (yes); stage-3 LAN fit-out for real floors; owner O-14.

**Sequencing:** 19-T0 (engine) → 20 ∥ 25 → 21 → 22 → 23 (23 can slot earlier if the mini-OT needs porters). Everything after 13 T6 deploy and 14's vendor tables.

**What must be true before authoring each:** measured registry state (kinds, statuses declared), Plan 14's contract table shape, the 12a harness contract for automations, S10 role cards for the new roles (29a/b, 33a/b/c, 34a/b/c, 35a) written into S10 v1.4, owner rulings O-1, O-2, O-3, O-14 (the rest can default).

**Negative-space question ("what absence is a signal?"):** a critical device with **no ticket and no PPM in 12 months** is not healthy, it is invisible (blind-device count); a ward with **zero tray mismatches and zero verifications** is not perfect, it is not scanning; a night with **no transport requests from ICU** means porters are being called by phone; a mortuary with **no cold-storage charges ever** means the head was never configured; an oxygen panel with **no manual dips and no sensor readings for 8 hours** is the alert (`interface.down` on the human); a quarter with **no code drills** is a NABH finding; a hospital with **no downtime windows in 6 months** on a single cloud VM has an unreported paper practice, not perfect uptime.

**Staff edge-case interview questions (department heads):**
1. BME: which five devices, if down at 2 a.m., stop a patient's care — and who do you call *today*? How long has the on-call phone been with the same person?
2. BME: how do you know a vendor engineer actually visited? What does the AMC vendor's report look like?
3. BME: which devices have never been calibrated, and which ones are you "not sure" about?
4. Gas: how do you decide when to switch to manifold, and how often has the supplier been late in the last year? What happened?
5. Gas: where do empty cylinders go, and how many are "with the vendor" right now?
6. Kitchen: how do you know which bed gets a diabetic tray? What happens when a patient moves after the list is printed?
7. Kitchen: what did the last FSSAI inspection ask for that you could not find quickly?
8. Kitchen: how are attendant meals paid for today, and who handles the cash?
9. Mortuary: walk me through the last MLC body release — every paper, every signature, every phone call.
10. Mortuary: what happened the last time cold storage was full?
11. Security: how many attendant passes exist per bed today, and how do you catch a shared one? When was the last time a stranger got to a ward?
12. Security: what did you do the last time the police asked for CCTV?
13. Transport: how does a nurse get a porter at night, and how long do patients wait for CT transport?
14. IT: the last time the system was slow or down — who decided, how did wards continue, what was never entered afterwards?
15. IT: how many printers exist, and which ones have no one responsible for paper and toner?
16. Duty manager: which escalations reach you that should not, and which never reach you that should?

---

## 15. Open questions & risks

- **Q1 Registry vocabulary for non-bed uses of `bed`:** DD4 lets a manifest claim a kind's statuses; `bed` is kernel-declared. A mortuary slot needs `available|occupied|blocked|defrosting`; whether module-owned *sub-status* on the `bodies` table suffices, or the kernel vocab must grow, is a Plan 13 close-out question (ties to §4A item 1 class column).
- **Q2 Floor-scoped scope model:** the shipped ledger is a single hospital mode sequence; scoped windows may need to coexist with the hospital mode (a floor in `degraded` while hospital is `normal`). The mode ledger's advisory-lock semantics and `MODES_REQUIRING_NOTE` need extension design, not a second table — to be measured at Plan 25 authoring.
- **Q3 Kit form kinds are a code constant** (`DOWNTIME_FORM_KINDS`); promoting to data touches lock-order semantics (derived from column value) — confirm the promotion does not break serial reservation determinism.
- **Q4 Telemetry home:** utility readings in TimescaleDB (ICU pattern) vs Postgres at stage 1 (few points, 5-min cadence). Recommend Postgres until > 50 points, with the same event contract.
- **Q5 AERB register ownership** split BME (equipment QA) vs radiology/oncology (dose) — align with document 18 (radiology) and the cancer floor design.
- **Q6 Deceased-patient DPDP nominee handling** for mortuary records and WhatsApp suppression (fix 33) — counsel input.
- **Q7 Security vendor (PSARA) staff as HMIS users** — CLRA evidence bridge (S10 §12.28) and per-guard accounts (no shared accounts) at 60–80 pool: onboarding cost and churn; consider badge-PIN switching on shared reader tablets.
- **Q8 Nurse-call and fire-panel integrations** depend on hardware not yet chosen; keep manual paths primary.
- **Risk R1:** building five pools without the shared engine (O-1 decided late) recreates status-column sprawl. **R2:** oxygen alerting relying on manual dips at 610 beds is a human-heartbeat problem — the sensor purchase must precede ICU commissioning (§13 already prices it). **R3:** alarm fatigue from BME/IT tickets — only P0 pages; verified by the SLA policy test. **R4:** CCTV/visitor data under DPDP is the department's largest privacy exposure — notice, purpose, retention configured before Plan 22 goes live. **R5:** the kitchen production list is the one place a diagnosis can leak to non-clinical staff — glyphs-not-codes is a test, not a convention.
