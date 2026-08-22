# HMIS Platform Architecture — Design Spec

- **v4.7 2026-08-22** — two amendments marked `(v4.7)` inline in §1, §2, §3-table, §12, §13, §19: the owner's **STAGED DEPLOYMENT ruling** (cloud single-server now → hybrid after live pilot → on-prem end state) and the **death of pg-boss**, which lost by measurement in Plan 08.5 (FORK-B) and was still design law here.
- **Date:** 2026-08-10, updated 2026-08-11 (v3 — Hospital Operating Fabric + patient-journey designs folded in); **v4.6 2026-08-20** — architecture-review amendments marked `(v4.6)` inline in §9, §10.2, §11.18, §16, §17, §19 (decisions in the Phase-1 roadmap; reasoning in `plans/reports/ARCHITECTURE-REVIEW-2026-08-20.md`)
- **Status:** Approved in brainstorming sessions; **design series in progress — no implementation planning until the series and the owner's stress-test rounds complete** (see §17 status)
- **Scope:** Platform foundation + first module slice (Registration/OPD/Billing, expanded scope §7–§9) + the operating fabric (§10) and patient-journey designs (§11) that every module instantiates. Every later module still gets its own spec → plan → build cycle.

## 1. Context & Goals

A new Indian hospital is replacing crk-hmis (a fork of `hmislk/hmis` — a Java EE / JSF / PrimeFaces monolith with server-rendered UI, no India-specific features, and structural lag from per-click server round-trips). The replacement is a greenfield build; crk-hmis holds no data worth migrating.

**Vision (sharpened 2026-08-11):** an **agentic AI operating system that runs a live hospital end-to-end** — a unified intelligence layer connecting clinical decisions, administrative workflows, and operational infrastructure. Architectural consequence: agents do not replace the deterministic core; they require it. The event log, workflow engine, and permission-enforced APIs (§10, §16) are the substrate the agents stand on. Priorities within the vision: speed and accuracy, delivered through auditable flow design — no leakages, no loopholes.

**Hospital profile:**
- Today: ~100 OPD visits/day, 10 beds, ~20 concurrent users. **Licensed blood bank already operating.**
- 1-year target: 610 beds, 2,000+ OPD visits/day, ~300 concurrent users, 24×7 emergency department, 10 operation theatres, full diagnostics + pathology labs.

**Priorities (in order):** user experience; information sync between modules; medical device integration; data portability; fast recovery from server failure; cheap addition of new modules.

**Constraints:**
- Built and maintained by the owner directing AI coding agents — no dedicated developer staff. Architecture must favor boring, consolidated, heavily-documented technology.
- Hosted on local (on-premises) servers. Patient care must never depend on internet connectivity.
  **(v4.7) THIS IS THE END STATE, AND IT IS REACHED IN THREE STAGES — owner ruling 2026-08-22.** It is NOT
  superseded and it is not negotiable as a destination; what changed is that the destination is no longer
  also the starting line. **Stage 1 (now, through Phase-1 build and owner UAT): ONE cloud server (Hetzner),
  no standby.** **Stage 2 (after weeks of live use in the working hospital as a SECONDARY HMIS beside the
  incumbent): hybrid — on-prem primary, cloud standby/backup.** **Stage 3: fully on-prem, as this line says.**
  The consequence that binds every plan from 11 onward: **nothing may be built that makes stage 3 expensive.**
  No managed cloud service becomes load-bearing, no provider-specific primitive (cloud load balancer, cloud
  volume, cloud DNS, cloud secrets manager) enters the deployable, and the whole stack must stand up from
  Compose + Caddy + Postgres + pgBackRest on any capable metal. Stage 1 is a *substrate*, never an
  *architecture*. Note also what stage 2 admits: **during the secondary-HMIS pilot, real patient data is
  live on a cloud host outside India** — the DPDP posture for that window is a pre-pilot gate (§19), not a
  post-go-live one.
- India compliance stack: GST-correct billing from day one; **ABDM-ready data model from day one, actual ABDM/NHCX wiring after external approvals land** (go-live never blocks on approval timelines). NABH accreditation work already underway → Quality pack lands early (§17). TPA/PMJAY handled as payers on the standard billing model when those desks open.

## 2. Architecture Decision

**Hybrid: modular monolith core + edge services at hardware/physics boundaries.**

- The core — all administrative, clinical-record, and financial workflow — is one TypeScript application over one PostgreSQL database. ACID transactions guarantee financial and narcotics audit integrity; modules share data instantly without network calls.
- Edge services exist only where a protocol or data-physics boundary forces them: lab analyzers (serial/USB/ASTM), ICU telemetry (per-second streams that must not load the transactional DB), and DICOM imaging (bulk storage). Each edge service can crash without taking the hospital down, and the core can restart without losing edge data (edges buffer locally).
- **Rule for all future work: a new module goes in the monolith by default; it becomes a service only if hardware or data physics demands it.** No message broker, no service mesh, no per-module databases in the core.
- **One codebase, several processes (v4.3):** "monolith" means one deployable codebase and one database — not one OS process. The core runs as separate processes from the same build (API · WebSocket hub · outbox/job worker · PDF renderer), so a rendering storm can't stall the API. Coordination stays in Postgres (the **Scheduler** and the outbox) — still no broker. **(v4.7) `pg-boss` is dead** and was never installed: Plan 08.5's FORK-B killed it by measurement (pg-boss@12 is ESM-only, the unmodified jest harness cannot parse it, zero tests ran). Jobs run on the shipped `kernel/worker/scheduler.ts` — an advisory-lock loop whose correctness never rests on the lock, with each job's own conditional claim carrying it. Analytics, agents, and reports read from the standby replica (hot-standby reads), protecting the primary's <300 ms budgets.

**Rejected alternatives:**
- *Assembled open-source suite (OpenMRS + OpenELIS + Odoo + dcm4chee, Bahmni-style):* fastest to feature parity, but repeats crk-hmis's disease — multiple heavyweight stacks, fragile inter-system sync, and a UX that can only be skinned, not owned. Worst fit for a solo maintainer whose #1 priority is UX.
- *Microservices from day one:* cross-module consistency becomes a distributed-systems problem; on-prem ops burden (broker, discovery, per-service failover) lands on one person. Pays off at engineering-org scale, not here.

## 3. System Topology

```
staff & doctor devices (browser/tablet)
        │
        ▼
  Reverse proxy (Caddy, TLS)
        │
        ▼
┌──────────────────── HMIS CORE (modular monolith, NestJS) ────────────────────┐
│  registration │ opd │ billing │ pharmacy │ ipd/beds │ lab │ ...              │
│  shared kernel: patient master, event log, workflow engine, auth/RBAC,       │
│                 GST engine, approvals engine, notifications gateway          │
│  REST/JSON API + WebSocket (live queues, bed board, result notifications)    │
└──────────────┬───────────────────────────────────────────────────────────────┘
               ▼
      PostgreSQL 16 primary ──streaming replication──► standby (server 2)
               │
               └── continuous WAL archive (pgBackRest) → NAS → weekly offsite copy

EDGE SERVICES
  • Lab edge agent   — fanless mini-PC in lab; ASTM/HL7/serial/USB to analyzers;
                       SQLite local buffer; pushes to Core API
  • ICU ingest       — Mosquitto MQTT ← monitors; TimescaleDB (separate Postgres
                       instance); live fan-out to nurse stations via WebSocket;
                       only alarms + hourly summaries written to core EMR
  • Orthanc PACS     — modalities push DICOM studies; dedicated storage volume;
                       core EMR stores study references; OHIF viewer embedded
  • Utility telemetry— oxygen tank/pipeline level sensors → threshold events
                       (manual dip-reading tasks until sensors installed)

EXTERNAL (only the core's gateway module talks to the internet)
  • WhatsApp / SMS / IVR providers
  • ABDM / NHCX / PMJAY (wired when approvals land)

BOUGHT, NOT BUILT (integrated lightly — see §9)
  • IP-PBX / EPABX for desk-to-desk voice (also the server-independent
    communication channel during downtime — §11.4 map 1)
  • Tally for statutory accounting (HMIS exports vouchers)
  • HR/payroll/biometric attendance system
```

## 4. Module Framework

- **A module is a folder** containing: its database tables (own schema; no other module may touch them), API routes, UI screens, event definitions, and a **manifest** declaring menu entries, permissions introduced, and event subscriptions. Adding a module = add folder + run migrations + register manifest. No infrastructure changes.
- **Modules communicate only two ways:** calling another module's declared interface (e.g., `patients.get(id)`), or consuming events. Cross-module table access is forbidden, enforced by lint rules.
- **Event log (transactional outbox) is the spine.** Every significant fact is written to an `events` table in the same transaction as the change. Consumers: other modules, WebSocket pushes, the WhatsApp/SMS queue, future ABDM care-context notifications, analytics, and the agentic layer (§16). One mechanism supplies module sync, real-time UI, patient engagement, audit trail, and the integration surface.

## 5. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere | One language across core, edges, UI; shared types end-to-end; strongest AI-agent ecosystem |
| Core backend | NestJS | Module system maps 1:1 to the module framework; opinionated structure keeps AI-generated code consistent |
| Database | PostgreSQL 16 | ACID, built-in streaming replication, JSONB for FHIR-shaped documents, full-text search for MRD |
| DB access | Drizzle ORM | Typed, SQL-first (billing/GST reporting needs real SQL); explicit migration files (auditable) |
| Frontend | React + Vite SPA, Tailwind, shadcn/ui, TanStack Query | LAN app, no SEO; static SPA served by proxy; screens stay loaded, data streams in |
| Real-time | WebSockets from core | Live OPD queue, bed board, result notifications |
| Jobs/queues | **`kernel/worker/scheduler.ts` (v4.7)** — ~~pg-boss~~ | Postgres-backed jobs; no Redis, and now no pg-boss either: it is ESM-only and the jest harness cannot parse it (Plan 08.5 FORK-B, measured). The shipped Scheduler registers `every`/`dailyIst` jobs under `pg_try_advisory_lock`; every job's own claim is idempotent and multi-process-safe, so the lock is an efficiency, not a correctness dependency. Add Redis only if measurement demands |
| ICU telemetry | Mosquitto MQTT → TimescaleDB (separate instance) | Per-second vitals never touch the core DB; Postgres skillset reused |
| PACS | Orthanc + OHIF viewer | Solved problem; own storage volume; EMR stores references |
| Lab edge | Node/TS on fanless mini-PC, SQLite buffer | Serial/USB isolation; driver crash affects only the lab agent |
| Deployment | Docker Compose on Ubuntu LTS; Caddy; Grafana + Prometheus + Loki | Whole hospital = one `compose up` on fresh hardware — most of the DR story |

## 6. Data Spine & India Compliance

- **Patient master:** one `patients` table owned by registration; all modules reference `patient_id`, never copy demographics. UHID generated at registration. **ABHA number is a nullable field from day one** — linkable at any visit, never blocking one.
- **Allergy list lives on the patient master** (v3): captured at registration, vitals, or consult; prescribing throws a hard warning on match; adverse drug reactions feed the ADR register and PvPI reporting.
- **Language preference per patient** (v3): captured at registration; every patient-facing message (WhatsApp/SMS/IVR/print) uses it. Hindi/English day one.
- **Clinical timeline:** every interaction is an `encounter` (OPD, IPD, ER, teleconsult); orders (drugs, labs, imaging) and results hang off encounters. EMR views, MRD, discharge summaries, and ABDM care-contexts all derive from this one spine.
- **Every visit carries an intended-payer tag** (self / TPA / PMJAY / corporate) from day one.
- **Every visit and order carries referral-source and consultant attribution** — capture starts day one because it cannot be reconstructed later.
- **Clinical documents stored FHIR-shaped** (JSONB following FHIR resource structures). ABDM/NHCX wiring later serializes what already exists.
- **Billing is double-entry and append-only.** Charges accrue from module events; invoices are immutable once issued; corrections are credit notes. Shared GST engine computes CGST/SGST, service-category rates, HSN codes at invoice time.
- **Audit is structural:** event log + append-only financials + row-level `updated_by`/`updated_at` gives NABH-grade traceability without a separate audit subsystem.

## 7. Billing & Revenue Engine (Phase 1 scope)

The counter is where audit lives or dies, so Phase 1 billing is built as a **tariff + adjustment-rules engine**, not a bill-printing screen.

**Tariff & adjustments.** Every service has a base tariff. Anything that changes a price is an *adjustment rule* applied at invoice time: membership benefit, coupon code, manual discount, and (later, same mechanism) TPA/corporate contract rates. **Best-single-benefit, no stacking** — the engine picks the one winning rule, and the invoice line records which rule won and why. Discounts and coupons are price adjustments; tenders settle the invoice — the two never mix.

**Tariff versioning (v3):** tariffs are versioned; **an admitted patient keeps admission-date tariffs for the entire stay** even if rates are revised mid-stay; OPD always bills the current version.

**Tenders & cashier sessions.** One invoice may be settled by any mix of cash + UPI + card; each tender is its own row with its own reference. Cashiers operate inside a session: opening float → collections by tender mode → shift close with denomination count → day book. **Variance control (v3):** short/over at shift close requires approval and lands in a variance register; per-cashier variance patterns become an anomaly report (early AI-layer job). **UPI reconciliation (v3):** UTR captured at the counter; T+1 auto-reconciliation of gateway settlements vs postings; mismatches become tasks.

**Refunds & cancellations.** Invoices stay immutable; a refund is a credit note plus an approval-gated refund voucher. Refund method may differ from the original tender; partial refunds supported. **Refunds go to whoever paid** — ID check + signature; above a threshold, bank transfer only, never cash (v3).

**Discount governance.** Role-based caps, mandatory reason codes, approval above threshold (§8). Every discount is an audit line.

**Coupon codes.** Campaign instrument: validity window, applicable service categories, usage limits, redemption tracking.

**Memberships (privilege cards).** Tiered plans — Silver / Gold / VIP (e.g., VIP at ₹3,000/year covering 5 family members) — individual and family variants. **Plans are configuration data, not code:** price, validity, max covered members, and benefits of three kinds — *countable freebies* (decrementing counters), *category discounts*, and *perks* (priority-queue flag). Every covered member is a real patient record. Card sale is a normal invoice line. At billing time, one more adjustment-rule source. **Prepaid day-care bundles (v3 — e.g., 12 dialysis sessions) reuse the same entitlement-counter machinery.**

**Silent accrual ledger (referral commissions + doctor fee splits).** Referrer masters: external doctors, agents/field promoters, corporate tie-ups, in-house staff incentives. Commission and consultant fee-split entries **accrue on `payment.received` and reverse on refund**. Phase 1 ships capture + accrual; the Payouts pack (§17) ships statements, PAN/TDS trail, approval-gated batches, Tally export; staff incentives route to the payroll head.

**Barcoded documents.** Every printed document carries a QR (UHID + visit + document ID). Any desk with a USB scanner pulls up full context in one beep. IPD wristbands extend this at admission (§11.2).

## 8. Approvals Engine (Phase 1, v1)

One generic mechanism: request → routed to approver role → approve/reject with note → event emitted. **Approvers act only inside the HMIS** (workspace queue or phone browser) — WhatsApp/SMS only notifies. Financial controls stay behind login + RBAC + audit log and keep working when the internet is down.

- Day-one consumers: discount overrides, refunds.
- Later consumers (same engine): credit extensions, narcotics issues, package overrides and absorptions, expense sanctions, payout batches, workflow-definition activations (§10), ICU admissions (§11.2), disaster-mode declaration (§11.3).

## 9. Module Landscape & Buy-vs-Build

Classification rule: **most "missing features" are scenarios inside existing planned modules, not new modules.** A capability becomes a new module folder only when it owns its own tables and workflow; it gets bought when it's commodity infrastructure.

**New cross-cutting modules (in the monolith):** approvals engine (§8) · memberships (§7) · referral & commission management incl. doctor fee splits (§7 + Payouts pack) · desk-to-desk patient handoff ("send patient + note to X desk," audit-logged) · workflow engine (§10, shared kernel).

**Bought, not built:**
- **Voice between desks:** standard IP-PBX/EPABX (~₹1–2L for 50+ extensions). The HMIS shows the staff directory and does handoffs; it never becomes a phone system. The PBX doubles as the server-independent channel during downtime (§11.4).
- **Statutory accounting:** Tally. HMIS exports vouchers; the accountant's ledgers stay in Tally.
- **HR/payroll/biometric attendance:** commercial/SaaS. HMIS only consumes the duty roster.
- **Clinical knowledge content (v4.6):** drug & interaction database, terminology services (SNOMED CT via NRCeS, LOINC, ICD-10), dose-range references, notifiable-disease lists — **licensed, never authored**; the Phase-2 rules engine and every clinical drafter consume them. Sourcing is a §19 decision with a §13 budget line.

**Future module catalog** (each gets its own spec → plan → build cycle; sequenced in §17):
- *Clinical:* Emergency/casualty (§11.3 is its flow design) · OT management · **blood bank — already licensed and operating; the module digitizes the existing operation** (donor management, screening, cross-match, issue register) · nursing eMAR + vitals charting · session departments (dialysis, physio, daycare/chemo — §11.4 map 11) · diet/kitchen orders · MRD (ICD coding, file tracking, birth/death certificates).
- *Financial:* procurement (indent → PO → GRN → supplier invoice) · health checkup packages.
- *Operations:* OPD queue/token displays with audio calling · housekeeping/bed turnover · CSSD sterilization tracking · ambulance · visitor/gate pass (§11.2 attendant passes) · mortuary register · biomedical equipment AMC/calibration.
- *Quality & engagement:* incident reporting (NABH) · quality-indicator dashboards · feedback/grievance · camps/outreach.

## 10. Hospital Operating Fabric (design series S1)

The fabric is what makes exhaustive flow design *executable* rather than documentation: flows are data, events are the vocabulary, and both humans and agents run on the same definitions.

### 10.1 Canonical pattern set (locked; owner-validated complete for this hospital's operations)

| # | Pattern | Governs |
|---|---|---|
| P1 | Patient journey | Encounter state machines: OPD/IPD/ER, admission, transfer, discharge, death |
| P2 | Order-to-result | Labs, imaging, procedures, blood; order → fulfil → result → charge |
| P3 | Request-to-issue | Medicines, consumables, oxygen, linen, CSSD; request → approve → issue → consume → charge/cost-center → replenish |
| P4 | Procure-to-pay | Indent → PO → GRN → supplier invoice |
| P5 | Task-and-track | Housekeeping, transport, maintenance, nursing tasks; assign → accept → do → verify |
| P6 | Charge-to-cash | §7 |
| P7 | Notify-remind-escalate | Subscriptions over all patterns; reminder ladders, SLA-breach escalation |

Overlays (not separate patterns): **approvals** (§8) may gate any transition; **scheduling** is a calendar view over P1/P2/P5 states.

**Leakage principle:** every item-movement event must terminate on a patient bill or a named cost center. Leakage becomes a variance report (issued vs billed vs counted), not a mystery.

### 10.2 Workflow engine (shared-kernel component)

- Every flow is a **workflow definition**: states, transitions, allowed roles per transition, SLA per state, escalation ladder per SLA.
- Definitions are **versioned data in the DB**, not code. In-flight instances complete on the version they started on. Every change emits `workflow.definition.updated`.
- Humans and agents execute the same definitions through the same APIs.
- (v4.6) **Every SLA-bearing lifecycle is a workflow instance, never a status column.** `workflow_instances` is the uniform journey-state table of the hospital; modules mirror engine state (as `opd_encounters.status` does) and never own it. Phase-1 exception on record: billing's cashier session / refund voucher / recon (roadmap open decision — retrofit or documented exception).

### 10.3 SLA policy: structure everywhere, alerts selective

- Every state carries an SLA; every breach is **recorded** (`sla.breached`) from day one.
- **Active alerting at go-live only on:** patient-facing waits (OPD wait, ER triage < 5 min), lab TAT, oxygen stock. Coverage expands as real baselines emerge. Rationale: alarm fatigue is the documented killer of hospital alerting.

### 10.4 Fabric governance: owner approves every change

Department heads and AI agents may **draft** workflow-definition changes; **activation always passes through the approvals engine to the owner**. Full audit trail via events.

### 10.5 Event grammar

- **Names:** `entity.verb_past` — `patient.registered`, `result.verified`. Family lifecycles stay generic with type in payload (`order.placed`, `order_type: lab|imaging|procedure`).
- **Envelope:** `event_id` (ULID) · `name` · `version` · `occurred_at` / `recorded_at` (distinct — downtime backfill depends on it) · `actor` (user | agent | system) · `patient_id?` · `encounter_id?` · `correlation_id` (workflow instance) · `causation_id` · `module` · typed `payload` · `site_id`.
- Append-only; written in the same transaction as the state change. Additive payload fields keep v1; breaking changes mint v2 alongside.

### 10.6 Event catalog (v3 — ~150 events)

**P1 Patient journey:** patient.registered · patient.updated · patient.merged · patient.unmerged · abha.linked · appointment.booked · appointment.rescheduled · appointment.cancelled · appointment.no_show · visit.opened · patient.checked_in · vitals.recorded · vitals.danger_flagged · consultation.started · consultation.completed · prescription.issued · visit.transferred · referral.issued · admission.requested · bed.waitlisted · bed.assigned · bed.class_changed · class.protection_expired · patient.admitted · patient.transferred · patient.discharged · patient.deceased · readmission.flagged · allergy.recorded · patient.recall_initiated · doctor.changed · doctor_leave.scheduled
**ER:** er.arrived · er.triaged · er.retriaged · er.disposition_decided · ambulance.prearrival_notified · brought_dead.recorded · mlc.registered · disaster.declared · disaster.ended
**Birth:** birth.recorded · band.pair_verified · band.pair_mismatch · immunization.administered
**P2 Order-to-result:** order.placed · order.cancelled · sample.collected · sample.received · sample.rejected · result.entered · result.verified · result.published · result.critical_flagged · report.drafted · report.signed · consult.requested · consult.completed · ot.booked · surgery.started · surgery.completed · transfusion.ordered · unit.crossmatched · unit.issued · transfusion.started · transfusion.completed · transfusion.reaction_flagged · adr.reported
**P3 Request-to-issue:** material.requested · material.issued · material.consumed · material.returned · stock.adjusted · stock.below_reorder · batch.expiring · device.usage_started · device.usage_stopped · utility.threshold_breached
**P4 Procure-to-pay:** po.created · po.approved · grn.received · supplier_invoice.recorded
**P5 Task-and-track:** task.created · task.assigned · task.accepted · task.completed · task.verified · task.escalated
**P6 Charge-to-cash:** charge.posted · invoice.issued · payment.received · payment.refunded · credit_note.issued · discount.applied · coupon.redeemed · membership.sold · membership.benefit_consumed · cashier_session.opened · cashier_session.closed · cash_variance.recorded · commission.accrued · commission.reversed · package.applied · package.allowance_consumed · package.overrun_projected · preauth.denied · payer.switched
**P7 + kernel:** notification.sent · notification.delivered · notification.failed · reminder.due · sla.breached · escalation.triggered · approval.requested · approval.granted · approval.rejected · break_glass.used · workflow.definition.updated · downtime.declared · downtime.ended · isolation.flagged · incident.reported · document.release_logged · pass.issued · pass.scanned · pass.revoked

**S3 additions (clinical ordering):** sample.dispatched · sample.external_resulted · qc.passed · qc.failed · report.amended · study.scheduled · study.acquired · form_f.recorded · result.acknowledged · medication.administered · medication.missed · medication.refused · medication.reconciled · pac.cleared · consent.recorded · ot.signin_completed · ot.timeout_completed · ot.signout_completed · count.mismatch_flagged · implant.recorded · specimen.dispatched · ot.cancelled_onday · recovery.scored — catalog now ~150 events.

The catalog grows in design sessions S4–S8; grammar and envelope are the stable contract. **Reconciliation note (v4.3):** the canonical catalog includes every per-section addition through stress pass 6 *plus* the S10 workforce events (roster.published/.blocked, sod.violation_blocked, exit.completed, bench.gap_flagged, activity_attendance.mismatch, attribution.disputed/.resolved, overload.flagged, temp_role.granted/.expired, emergency_elevation.used) — reconciled count **~285**; per-section running counts earlier in §11 are historical snapshots.

## 11. Journey & Flow Designs (design series S2–S7)

Journeys designed desk-by-desk with the owner (S2 in the visual companion — screens preserved under `.superpowers/brainstorm/`; S3 in terminal). Every branch ends in a terminal state — the "no dangling paths" rule was checked per map. The owner will run further stress-test rounds over all of §11 before implementation planning.

### 11.1 OPD journey

**Entry:** new patient → UHID desk (phone-first duplicate check, demographics + photo, optional ABHA, QR card; SLA < 3 min) · existing patient → straight to registration (QR scan / phone search; SLA < 60 s).
**Registration:** department → doctor (live queue length + in/out status shown), token issued; system auto-detects visit type — **new / revisit / renewal**. Follow-up window: **7 days default, doctor may extend a given visit's window to 15/21/30**.
**Billing:** pay-before-consult; three-way fee branch (new/revisit/renewal); best-single-benefit adjustment; mixed tenders; QR receipt. SLA < 2 min.
**Vitals desk — mandatory for every OPD patient:** height/weight/BP/temp/SpO₂/pulse into the encounter before the doctor; danger ranges flag the doctor immediately.
**Consultation:** queue call via display + audio + WhatsApp; **queue discipline: appointment-priority** — an on-time checked-in appointment always goes next; otherwise walk-in FIFO advances; a walk-in beats a *future* appointment, never an on-time one; **late appointments retain priority over walk-ins** (no grace expiry).
**Outcomes (any combination):** A. prescription → pharmacy (Rx reaches pharmacy screen before the patient) → bill → dispense → exit · B. tests ordered → pay → sample/imaging → **same-day re-entry to the same doctor, same visit, no new fee, priority flag** · C. admission advised → §11.2 · D. referral out / advice-only → exit, review reminder scheduled.
**OPD exceptions:** E1 paid-but-left → approval-gated refund, visit closed *abandoned* · E2 doctor unavailable mid-queue → bulk queue transfer (consent) or refund, one approval · E3 emergency detected anywhere → ER button, stretcher task, **treatment first, no payment gate** · E4 pharmacy stock-out → substitute (doctor pinged) or partial dispense + auto-refund of gap; reorder event fires.

### 11.2 IPD journey

**Sources:** OPD (branch C) · ER (§11.3) · direct/referred (referral captured).
**Admission desk:** payer branch (self-pay deposit / TPA pre-auth path / PMJAY-corporate credit rules) → live bed board, **class drives every tariff for the stay** → deposit invoice → **wristband printed (UHID QR)** → auto porter task. SLA request→bed < 30 min.
**Deposit policy (corporate-standard default, configurable):** per-bed-class schedule ≈ 3 estimated days of class charges (package-% for planned surgery); top-up alert at 75%, management escalation at 90%. ICU burn-rate recalculates alerts daily.
**Room-rent rule (default, configurable):** calendar-day billing, 12-noon checkout + grace window.
**Stay loop:** rounds → orders; pharmacy indents per patient; **eMAR: wristband scan before every administration**; per-shift vitals with danger escalation; diet orders → kitchen; room rent auto-posts nightly; every consumable terminates on the bed's bill (zero unbilled leakage). **Running bill to attendant daily on WhatsApp.**
**Mid-stay:** transfers (ward⇄ward/ICU) with nurse handover checklist and rent split by days-in-class · surgery via OT (booking, pre-op checklist + consent, PACU return; OT consumables billed from the theatre).
**Attendant passes:** N QR passes per bed class printed at admission; security scans at ward entry (validity + visiting hours in one beep); lost pass → reissue with instant revoke; discharge/death/transfer auto-expires all passes.
**ICU rules:** admission requires intensivist/duty-ICU-doctor approval — no clerk-only ICU admissions; sources: ER, ward escalation, post-OT; ICU-full branch → hold with monitoring + refer-out offer, decision logged; no bedside attendants (lounge passes + visiting slots + scheduled condition updates); **device-days are chargeable start/stop events** (ventilator/day, pumps).
**Discharge cascade (SLA-timed, target fit-declared → out < 3 h):** 1 fit declared (clock starts) → 2 open orders auto-flagged, pharmacy stops → 3 unused ward meds returned, credit to bill → 4 **no-pending-charges gate** — every department one-click confirms; silence past SLA auto-escalates → 5 **discharge summary drafted by AI (T2), doctor edits and signs** → 6 final bill = charges − deposit − returns; settle or refund excess → 7 QR gate pass, security scans at exit → 8 bed released → housekeeping task → cleaned → verified → bed board available. WhatsApp: summary PDF + follow-up date + meds schedule.
**IPD exceptions:** E5 LAMA (form, settle, typed discharge) · E6 death on ward (certification, mortuary task, certificate flow, sensitive settlement) · E7 deposit exhausted (alert ladder → interim bill → top-up request → management escalation; **care never stops**) · E8 abscond/dispute (security + recovery register; line-item review against the event trail).

### 11.3 ER journey

**Prime rule: treatment first, money later — no payment gate anywhere on this map.**
**Arrival:** walk-in · ambulance (logged pre-arrival call, bay + team alerted) · referred-in (referral captured) · police-brought (auto-MLC).
**Triage:** colour in < 5 min (day-one active SLA) — **Red/Yellow/Green + Black brought-dead** (corporate 3-tier standard); registration runs parallel at bedside (or UNKNOWN flow); triage vitals feed the record from second zero.
**Paths:** Red → resus bay, team paged (PBX + app), stat orders carry ER-priority (tightened TAT SLAs), break-glass access if needed · Yellow → treatment bay, re-triage possible (evented) · Green → fast-track; **Green-to-OPD conversion allowed with fee, patient informed first** · Black → brought-dead register (legally separate from hospital-death register), MLC, mortuary.
**Observation ceiling: 24 hours** — countdown per patient; breach forces a disposition decision, escalating to ER head then management.
**Dispositions (every episode ends in exactly one):** home (meds + follow-up booking) · admit ward/ICU (bed first, deposit catches up; ICU approval rule applies) · emergency OT (two-doctor consent variant when no attendant) · refer-out (stabilize, transfer note + records, ambulance task, receiving hospital confirmed — stabilization documented) · LAMA/abscond (E5/E8 machinery) · death in ER.
**Exception map 13 — disaster/mass-casualty mode:** switch flipped by ER head/duty manager (approvals engine, loudly evented) → batch DIS-tag quick-registration (photo + colour only), staff-recall broadcast (WhatsApp + PBX), surge bed board, OT/ICU pre-empt rules; all casualties auto-MLC; **switch-off reconciliation: every DIS-tag resolves to a full registration or the unknown-patient ladder.**

### 11.4 Exception flow library (maps 1–13, all locked)

1. **System downtime protocol.** Duty manager is the single declare/recover authority (owner alerted, not required to act). Sealed per-desk kits with serially-numbered forms from reserved ranges; PBX as the server-independent channel; ER treats unconditionally; edges keep buffering; standby promotion per runbook if primary dead past RTO. Recovery = backfill screens with true `occurred_at`; reconciliation proves every paper serial and every rupee accounted for — **an outage can never become a leakage window.** Quarterly drills, tracked as tasks.
2. **Newborn & mother-baby pairing.** Baby = real patient at birth (own UHID linked to mother; twins separate). Paired wristbands; **hard-stop double-scan on every baby handover including feeding to the mother** (strict-but-safe). Baby's routine charges ride mother's bill; NICU = own admission, payer inherited. Statutory birth/stillbirth registers; birth immunizations start the vaccination-reminder relationship.
3. **Payer switch mid-stay.** Triggers: pre-auth denied, limit exhausted, corporate withdrawn, PMJAY opt-in. **Mandatory documented counseling + signed consent before any conversion — no silent switches.** Invoice lines attributed by payer period; deposit ladder from switch moment; approvals path for genuine inability to pay; full trail for the TPA dispute.
4. **Bed-class protection.** Wanted class full → waitlist with forecast → **temporary higher-class bed at booked-class tariff (48 h)** → refer-out. Auto-move task when right class frees; declining ends protection from next day boundary. Upgrades/downgrades: consent + next-noon effect; **upgrade consent must show the insurance room-rent-cap proportionate-deduction warning.**
5. **Cross-consultation & doctor change.** Specialist worklist → bedside → fee posts + payout share accrues (fee-split ledger). First consult chargeable, same-day repeat by same specialist free (configurable). Doctor change requires a written clinical handover note; billing/payout attribution splits at handover; patient-initiated changes record consent.
6. **Package overrun.** Package = inclusions + explicit exclusions + fixed price. Live charge routing in/out of package, % consumed visible to attendant from day one. **Overruns projected and consented before they accrue**; absorptions only via logged management approval; insurer-package overruns explicitly consented as self-pay. (Packages are the #1 leakage door in Indian hospitals; this closes it.)
7. **Re-admission flagging.** 30-day auto-check + relatedness prompt → quality register + review task (NABH indicator self-feeds); encounters link clinically; 15-day package-warranty routing via management approval.
8. **Unknown patient.** UNK-registration with zero treatment blocking; auto-MLC; two-staff sealed belongings inventory; later `patient.merged` with full carryover; never-identified → social-services ladder, charity-head billing as a logged decision.
9. **Isolation & deep-clean.** Doctor-set flag → bed board isolation status, room rules, tightened passes; PPE to infection-control cost center; biohazard sample flags; discharge → deep-clean task with supervisor verification, **bed blocked until verified**; HAI/NABH registers self-feed.
10. **Blood transfusion chain.** Order + consent → cross-match → **in-house licensed blood bank issues** (external sister-bank sourcing only as shortage fallback; processing charges per NBTC norms) → cold-chain transport task → **bedside two-staff + wristband + unit-barcode hard stop** → monitored transfusion → completion, or reaction branch (stop, workup, unit returns, register + auto incident report) → BMW-compliant disposal.
11. **Day-care admissions.** Treatment plan → auto session calendar + reminders; check-in → chair/bed → pre-checks → procedure → observation → same-day discharge (lighter cascade, gates intact). Per-session package rates; prepaid bundles as entitlement counters; **missed session = clinical alert with recall task, not a no-show.**
12. **MLC in IPD & unclaimed body.** MLC flag at any entry → register + police intimation record (who/when/acknowledgment); injury reports are restricted legal documents (MRD custody, release only against logged requisition); discharge/death/abscond re-triggers intimation. Unclaimed body: logged contact attempts → police (72 h) → municipal disposal; every rung evented; cold-storage charges post to the proper head.
13. **Disaster mode** — §11.3.

### 11.5 Cross-cutting rules from stress-test pass 2 (locked)

Tariff lock at admission (§7) · allergy capture + prescribing hard-warning (§6) · **public displays and audio announce tokens only, never names** · refund-to-payer with ID + bank-transfer threshold (§7) · notification fallback ladder **WhatsApp → SMS → IVR → manual-notify desk flag** · language preference per patient (§6) · staff-as-patients and VIP records confidential by default (alias on public surfaces) · sample re-collection free after rejection.

**Additional flows locked:** duplicate merge/unmerge with side-by-side timeline review and approval gate (wrong merge = patient-safety emergency, must be splittable) · sample rejection → re-collection task → OPD recall flow with documented attempts · **critical result after patient left → mandatory contact protocol** (call task with logged attempts, escalation ladder; loop closes only on documented contact) · cashier variance & UPI reconciliation (§7) · doctor planned-leave cascade (book blocks, auto-notify + one-tap rebooking, unresolved → call tasks) · oxygen: cylinders = P3 inventory; pipeline/LMO tank = telemetry with threshold events, day-one active alert; manual dip-reading tasks until sensors installed.

**Noted for later module specs:** teleconsult flow (CRM) · camp bulk-intake with attribution (CRM) · corporate credit billing cycle (TPA/corporate phase) · restraint/suicide-watch orders (nursing) · one-tap evacuation manifest (bed board) · BMW/pest-control recurring compliance tasks (quality pack).

### 11.6 Lab order-to-result (S3)

One pipeline for all order sources — OPD, ward/ICU, ER stat (priority-flagged, tighter TAT), and **walk-in outside-prescription orders** (outside doctor's referral attribution feeds the commission ledger automatically). Flow: order → billing branch (OPD/walk-in prepay · IPD posts to bed · ER accrues) → collection (OPD phlebotomy queue with **barcode tube labels printed at the chair** + right-patient scan before draw; ward rounds + stat tasks) → transport → **accessioning scan starts the TAT clock** → analysis → verification → publish (doctor screen + WhatsApp PDF in patient's language + print counter; same-day OPD results trigger the §11.1 priority re-entry loop).

**Locked rules:** **QC lockout** — an analyzer with failed daily controls has its results blocked until QC passes · **auto-verification** of normal-range results from interfaced analyzers; pathologist signs abnormal/critical/edited/manual · **critical values:** on-ward alert requires documented acknowledgment with read-back; departed patients get the §11.5 mandatory contact protocol · sample rejection → free re-collection (§11.5) · **send-outs are first-class** (dispatch manifest, chain tracking, result ingestion, separate TAT; partner selection deferred to lab-module spec) · **reflex testing** auto-adds confirmatory tests per rule with billing consent shown at order time · analyzer reruns free, evented for QC trends · **amended reports are versioned, never overwritten**, amendment reason logged.

### 11.7 Imaging order-to-result (S3)

Order → schedule (walk-in X-ray vs slotted CT/MRI/USG) → **prep instructions auto-WhatsApp** → check-in → safety gates → acquisition to PACS → radiologist worklist → report drafted (AI-draft T2 candidate) → signed → publish with the same critical-findings protocol as lab.

**Hard gates:** contrast consent + creatinine check before contrast CT (reaction kit checks as recurring tasks) · pregnancy check before X-ray/CT on women of reproductive age · **PCPNDT compliance is structural: Form F is a gate on every obstetric USG order** (hospital runs in-house OB USG), feeding the PCPNDT register; sex-determination lockouts on report templates.

**Exceptions:** patient unfit → reason-coded reschedule · contrast reaction → ADR + incident machinery · **teleradiology designed-in but dormant** (on-site radiologist 24×7 for now; overflow/night remote signing activates when needed) · modality down → offline on schedule board + auto-rebooking cascade (same mechanics as doctor leave).

### 11.8 Medications end-to-end (S3)

**Prescribing:** formulary-first; pharmacy may substitute generics unless the doctor marks "no substitution." Safety checks severity-tiered: allergy and contraindicated interactions = **hard stop**; moderate interactions/duplicate therapy = warning; **pediatric dose-range flags use the weight captured at the vitals desk**. Restricted antimicrobials require approval from a designated senior-physician role (AMS, NABH).

**Controlled & high-alert:** NDPS/Schedule X — double-lock, witnessed dispensing, second factor (§14), running ampoule balance, witnessed wastage; Schedule H1 register writes itself from dispense events. High-alert meds (insulin, heparin, concentrated KCl, chemo) take **two-nurse verification at administration**; chemo adds pharmacist compounding verification on the day-care path.

**IPD cycle:** drug order → per-patient indent or ward stock → **eMAR auto-generates dose tasks** → wristband scan per dose → given/missed/refused each evented with reason. **Medication reconciliation** at admission, transfer, and discharge (discharge WhatsApp med schedule derives from it). Patient's-own-meds path: pharmacist verifies, doctor approves, eMAR-administered unbilled. **Returns:** sealed + receipt within 7 days = full credit; never narcotics or cold-chain.

### 11.9 Procedures & OT (S3)

**Minor OPD procedures:** order → bill → procedure-room task → note + consumables charge; consent for anything invasive.

**Major surgery:** booking request (surgeon, procedure, duration, implant needs, **blood reserve** — cross-match hold with the in-house blood bank, **auto-released after 48 h unused**, post-op ICU/bed need) → per-theatre scheduling board (elective slots, emergency pre-empt per §11.3, **first-case on-time tracked** — the corporate OT KPI) → **hard pre-op gates:** PAC clearance with ASA grade · surgery + anesthesia + high-risk consents · site marking · NPO status · blood confirmed · ICU bed confirmed if planned; any gate open = no wheel-in → **WHO Surgical Safety Checklist as workflow states:** Sign-in → Time-out → Sign-out; **instrument/sponge count mismatch = hard stop: X-ray before closure + automatic incident** → intra-op record (personnel; wheel-in/induction/incision/closure/wheel-out timestamps — utilization derives free; **implants scanned by batch/serial** for traceability + charge; OT-store consumables scanned out; **specimen auto-creates the histopath order**) → PACU recovery scoring to threshold → shift out → turnover: cleaning task + CSSD set cycle (barcode-tracked sets; full CSSD module later, events defined now).

**Exceptions:** on-day cancellation (unfit, NPO violated, no ICU bed, pre-empted) → reason-coded event + reschedule priority + billing reversal · implant unavailable → postpone decision, evented · lost specimen = grave incident (the chain exists to make it near-impossible) · anesthesia complication → ICU + incident.

### 11.10 Materials & supply chain (S4)

**Store network:** every stock-holding location is a stock location — central stores (pharmacy bulk, general, surgical/OT, stationery) → sub-stores (wards, ER, OT, ICU, CSSD sterile store). Batch + expiry at every location; **UOM conversions (box→strip→tablet) defined once in the item master, never per transaction.**

**Request-to-issue:** par-level replenishment — the system **drafts indents itself** from par-minus-on-hand (T4 agent candidate; drafting, never approving); urgent requests same flow with urgency flag → value/category approval rules → **FEFO-enforced picking** (picker is told the batch) → issue scan → **receiving scan at the sub-store** (two-sided confirmation; discrepancies surface same-hour) → consumption terminates on patient bill or named cost center (§10.1) → returns evented and credited.

**Counts, variance, expiry:** perpetual inventory + rolling cycle counts as recurring verified tasks · **leakage triangle report: issued vs billed vs counted per item per location** — variances approval-gated and registered; per-location patterns → anomaly report (AI T0) · expiry ladder: `batch.expiring` at 90/60/30 days → return-to-supplier window → expired-on-shelf = variance + **witnessed destruction with certificate** (BMW-compliant); write-offs are evented losses, never quiet ones.

**Oxygen & gases:** **cylinders serialized** — full → issued → in-use → empty → at-vendor-refill (vendor rotation tracked; that's where cylinders vanish) · LMO/pipeline telemetry with day-one alerts (§11.5) · manifold consumption → cost center; ventilator hours → patient device-days.

**Linen & laundry:** par stock per ward by category; **bundle counts** at dirty pickup and clean delivery (per-piece tagging deferred); infected linen separate stream (§11.4 map 9); monthly loss variance per ward.

**CSSD:** set-based barcode tracking — dirty → decontamination → checklist assembly → sterilization batch → sterile store → issue. **Every load carries a biological-indicator result; BI fails = every set in that load auto-recalled** (batch traceability makes recall one query).

**Procure-to-pay:** aggregated indents → PO against rate contracts + approved vendor lists (**three quotes above ₹50k**, configurable, via approvals engine) → **GRN with QC at the gate** — quantity + minimum residual shelf-life (short-expiry rejected at receiving, default < 6 months / 75% rule) → **3-way match (PO/GRN/invoice)** before posting → Tally export. Vendor scorecards (fill rate, TAT, rejection rate) derive automatically.

**Exceptions:** stock-out → substitute + **emergency local purchase** (₹15k default float per store, approval-gated, retro-GRN'd — an escape valve, not a procurement bypass) · **batch recall = one-action freeze at every location** → documented return/destruction · donation stock evented in without payables · rate-contract expiry → renegotiation task · pilferage patterns → anomaly report.

**S4 events:** indent.drafted · stock.counted · stock.variance_flagged · batch.recalled · batch.destroyed · cylinder.status_changed · cssd.load_sterilized · cssd.bi_failed · cssd.set_recalled · grn.rejected · invoice.matched · local_purchase.recorded — catalog ~162.

### 11.11 Money flows (S5)

**Unifying rule: billing is a read model of care events.** Nothing is remembered onto a bill — every charge posts from an event: eMAR administration → drug charge · completed nursing-procedure task → procedure charge · **recorded IPD round visit → doctor visit fee auto-posts** · OT timestamps → theatre charges by actual duration · device start/stop → device-days · issue scans → consumables. The inverse is the audit: the **daily orphan report** — chargeable events with no corresponding charge — turns missed revenue into a queue someone clears.

**Credit control:** limits per corporate/TPA · aging buckets · dunning ladder — monthly consolidated invoice → reminders at 15/30 days → escalation call task at 45 → **credit-stop at 60** (new admissions from that payer need management override) · bad-debt write-offs only through the approvals ladder, always attributed.

**Financial rhythm:** daily — revenue close (day book by cashier × tender × department), bank/UPI reconciliation, orphan report · monthly — GSTR-1 export, **department P&L derived from the event stream**, **Tally sync verification** (posted vs exported — books can never quietly diverge) · payout cycle — statement → **7-day line-item dispute window against the event trail** → approval → NEFT bulk file → TDS certificates → **refund clawbacks net against the next statement automatically**.

**Small but real:** petty-cash imprest per department with reconciliation tasks (S4 store floats ride this) · **charity cost center**: monthly budget cap, owner approves above cap, every concession attributed · **tariff revision workflow**: draft → **impact simulation** (yesterday's invoices re-priced under the draft, revenue delta visible) → owner approval → effective date; admitted patients stay tariff-locked (§7).

**Fraud watchlist (AI T0 — reports, not actions):** duplicate refunds to one instrument · discount-pattern abuse per user · ghost patients (registrations without clinical events) · self-referral gaming in the commission ledger · cashier variance trends · chronic orphan-report offenders by department.

**S5 events:** charge.orphan_flagged · credit.limit_breached · credit.stopped · writeoff.recorded · statement.issued · statement.disputed · payout.batch_created · payout.executed · tds.certificate_issued · tariff.revision_applied · pettycash.reconciled — catalog ~173.

### 11.12 People & tasks (S6)

**Rosters:** the HR/biometric system (bought, §9) owns attendance and payroll; the HMIS consumes the **live on-duty picture** — who holds which role, where, right now. Queue assignment, task dispatch, and escalation all route through it; **escalation ladders resolve to the on-duty holder of a role, never a named person.** Doctor on-call schedules per specialty drive ER admission routing (**round-robin within the day's roster**).

**Shift handover as a workflow state:** nursing handover is a **per-patient checklist gate** at shift change — outgoing flags, incoming acknowledges; unacknowledged handovers escalate.

**Credentials & privileging (NABH):** registry of registration numbers, specialties, and per-procedure privileges with validity dates. **Expired credential or missing privilege = hard block on assignments and OT bookings** (no override below management); expiry warnings at 60/30 days.

**Nursing worklists:** one merged, time-ordered queue per nurse — eMAR doses + vitals schedules + care-plan tasks + handover flags + new orders; everything acknowledged and timed. Nurse-patient ratio per shift visible as an indicator.

**Support services:** **pooled queues with claim discipline** (housekeeping, porter/transport, maintenance, security) — any on-duty member claims, then SLA + escalation bind to them. Maintenance tickets carry priority classes (**critical care equipment: 30-minute response SLA**); AMC schedules auto-generate preventive tasks; verification on critical tasks.

**Exceptions:** uncovered shift → department head + duty manager with the gap visible · mid-shift departure → open tasks auto-return to pool, handover force-escalates · credential lapse mid-employment → block + notify ladder · equipment-down blocking a booked OT slot → §11.9 cancellation cascade.

**S6 events:** roster.synced · handover.completed · oncall.assigned · credential.expiring · credential.blocked — catalog ~178.

### 11.13 Communication matrix (S7)

**Channels:** in-app workspace · live WebSocket screens · WhatsApp · SMS · IVR · PBX voice · print. Fallback ladder and per-patient language preference locked in §11.5.

**Governance:** all templates in a **central versioned registry** (WhatsApp Business approval status tracked per template) · **DPDP split: transactional messages flow always; promotional strictly opt-in**, captured at registration, revocable · **quiet hours 9 p.m.–8 a.m.** for non-urgent patient messages (urgent recalls ignore quiet hours by design).

**Patient/attendant matrix:** welcome + UHID → token + live queue link → queue-called ping → visit summary + review reminder → report-ready PDFs → admission info → daily running bill → top-up requests → payer-switch counseling summary → discharge summary + med schedule → follow-up/vaccination/session reminders → recalls → post-discharge feedback.

**Staff matrix (role-routed, on-duty resolved):** approval requests · active-alert SLA breaches · **critical values with acknowledgment timers** · danger vitals · task dispatch/escalation · handover flags · credential expiry · stock/oxygen/utility alerts · downtime & disaster broadcasts (WhatsApp + PBX). **Anti-alarm-fatigue rule: only the active-alert list interrupts; the rest batches into shift digests.**

**Owner matrix:** real-time always — primary down, disaster declared, break-glass used, credit-stop override, refund/write-off above threshold · **daily 8 a.m. WhatsApp digest** (revenue close, OPD count, occupancy, orphan summary, variance flags, breach counts) · weekly — leakage triangle, vendor scorecards, payout summary, quality indicators.

**Escalation mechanics (uniform):** role ladders resolved to on-duty holders; **5-minute acknowledgment timer on critical clinical alerts** before auto-climb; de-duplicated threads; every rung evented. S7 added **zero new mechanisms** — assembly over the existing event/notification fabric.

### 11.14 Codes, compliance & edge scenarios (stress-test pass 3)

**Code system** (generalizes the disaster switch; all drilled quarterly): **Code Violet** — violence against staff: one-touch from any screen → security converge + police task + lockdown flag + management alert + incident and staff-support follow-up · fire code with one-tap evacuation manifest per ward · **Code Yellow** — vulnerable patient missing (dementia/psychiatric elopement ≠ abscond): search-grid tasks, gate alerts with photo, police escalation at threshold.

**Live grievance workflow:** any staff raises → management task with TAT → documented resolution → attendant-acknowledged closure; complaint register self-feeds (NABH). Media/police inquiries: **single-spokesperson rule**, same release discipline as MLC documents.

**Treatment refusal & DNR:** per-intervention refusal documented (counseling + signature) while staying admitted; DNR consultant-confirmed and flagged on chart + eMAR.

**Staff occupational exposure:** needle-stick → **PEP protocol task with first-dose clock** → source serology (consent rules) → staff health record + follow-up schedule → incident register.

**Body release double-verify:** body tag + gate pass + receiver ID scanned to match before release (same discipline as mother-baby pairing); evented with receiver identity.

**Long-stay patients:** 30-day auto-flag → periodic clinical + financial review tasks (deposit cycles, re-auth), bed-utilization visibility.

**Management-override admissions:** possible, but **evented with the authorizer's name and surfaced in the weekly digest** — no silent queue jumps.

**Seasonal surge mode:** department-level surge flag → extra-bed/floor-conversion authorization, tightened par levels, staffing alerts; same switch mechanics as disaster, gentler relaxations.

**Insurance identity fraud:** photo verification at cashless intake; mismatch → payer-switch machinery + incident + insurer notification.

**DPDP data-principal rights:** verified request → register with statutory TAT → export via §12 portability / correction via amend flows / **erasure bounded by medical-record retention law** (OPD ~5y, IPD ~10y, MLC indefinite; response documents why clinical records survive) · **legal-hold flags** freeze records against any purge.

**Cyber incident:** security-incident declaration → isolate + restore from backups + **CERT-In report within 6 hours (statutory)**; care continuity via the downtime protocol; **weekly offsite backup must be immutable/air-gapped** (§12).

**Deferred with registers noted:** organ-donation/brain-death committee protocol · visitor-injury goodwill path · ambulance dispatch detail.

**Pass-3 events:** code.activated · grievance.raised · grievance.resolved · patient.missing_flagged · refusal.recorded · dnr.recorded · exposure.reported · body.released · surge.activated · surge.ended · dsr.requested · dsr.fulfilled · legal_hold.applied · security_incident.declared — catalog ~192.

### 11.15 ICU floor deep-dive (S9 pressure test)

**Physical model:** one ICU floor → **3 halls × 15 beds (45 beds)**, a nursing station per hall, every hall isolation-capable, some beds with glass isolation cabins. Halls commission progressively with the build-out; a hall is a unit on the bed board.

**Telemetry pipeline:** bedside devices → vendor **central monitoring station per hall (buy with the monitors)** → one HL7 feed per hall → MQTT → TimescaleDB (edge, §3). **Procurement mandate: no monitor or ventilator purchase without documented HL7/serial data-export capability.** Per-hall dashboard: 15 live bed tiles (numerics every 1–2 s via WebSocket, trends from TimescaleDB, alarm banners, plus drips/vent settings/tasks context); floor-level 45-bed intensivist overview; intensivist phone view (RBAC'd). Waveforms stay on the vendor CMS. Alarm routing is hall-scoped, escalating bed-nurse → hall station → floor intensivist → duty manager; only critical classes escalate through the notification fabric; **alarm silencing is logged** (fatigue audit).

**Record split:** raw telemetry is supporting data (full resolution ~90 days, then downsampled — configurable); the **nurse-validated hourly chart is the legal record** — auto-captured vitals pre-fill, the nurse validates.

**Device-telemetry reconciliation (leakage lock):** daily cross-check of billed device-days vs observed telemetry — **billed-without-telemetry = orphan flag; telemetry-without-billing = leakage flag.**

**Isolation grains:** cabin bed (tagged, preferred by assignment rule) → **hall cohort mode** (outbreak: whole hall flips, surge-mode mechanics) → floor lockdown. All bed-board states, all evented.

**Department interlocks (existing fabric):** pharmacy crash-cart par + seal-check tasks · **POCT ABG analyzers interfaced with QC lockout like any analyzer** · portable X-ray as mobile modality · structured OT→ICU and ICU→ward handover checklists · enteral feeds as diet orders, feed pumps as device-days · terminal cleaning as verified task · backup ventilator as tracked asset · daily deposit recalc at ICU burn rate · **TPA enhancement reminder when ICU burn approaches the sanctioned limit.**

**ICU scenarios (locked):**
- **Code Blue** — one-touch anywhere: roster-resolved resus team (seed composition: duty doctor + ICU nurse + anesthetist on-call) → crash cart opened (seal event) → **timed code sheet** → outcome → replenish task + register + debrief
- **Massive Transfusion Protocol** — activation → blood bank MTP release rules incl. documented emergency O-neg uncrossmatched issue → cooler tracking → per-unit reconciliation
- **Ventilated transport bundle** (CT/OT): checklist (portable monitor, oxygen calculation, drugs, escort) + tracked transport task with receiving-end confirmation
- **Monitoring continuity:** disconnection/probe-off beyond threshold on an occupied bed → `data_gap.flagged`
- **Titration orders:** range orders ("titrate to MAP > 65"); every nurse adjustment logs via eMAR
- **Family briefing rhythm:** daily intensivist briefing, logged as counseling record
- **48-hour ICU readmission flag** after step-down → quality register

**S9/ICU events:** alarm.escalated · data_gap.flagged · crashcart.opened · crashcart.replenished · mtp.activated · transport.bundle_completed · titration.adjusted · briefing.recorded · icu.readmission_flagged — catalog ~201.

### 11.16 OT suite deep-dive (S9 pressure test #2)

**Physical model: 9 theatres operational day one** (10th commissions later) — **6 elective theatres in the main suite (OT-list governed) + 3 emergency theatres inside the ED, 24×7, in permanent emergency-insert mode** — with pre-op holding, PACU, sterile store, and CSSD linkage. Crash LSCS routes to the nearest ready emergency theatre (facility check: labor-room→ED-OT distance vs the 30-min decision-to-delivery target, §11.17).

**The OT list is the coordination artifact:** surgeon submits → OT in-charge sequences → anesthesia reviews → **published previous evening**. The list synchronizes wards (prep + per-patient NPO timing), **CSSD (sets prepared against tomorrow's list)**, blood bank (reserves), stores (implants), dietary, housekeeping. Late/emergency inserts → re-sequencing event + auto-notifications to affected surgeons and wards.

**Patient's OT day:** ward pre-op checklist (incl. **two-staff sealed valuables custody**, returned by signature) → porter → **pre-op holding station: identity + site + consent re-verified on arrival**, anesthesia final review → WHO checklist states (§11.9) → PACU → structured handover out. Family: **token-coded waiting-area status display** + surgery-completed WhatsApp ping.

**Theatre systems:** **OT environment is a telemetry domain** — temperature, humidity, positive differential pressure, air changes; sensors on the utility pattern (manual log tasks until installed); **out-of-range = theatre blocked on the board**; fumigation/validation cycles + **microbiological surveillance on schedule — failure blocks the theatre until re-validated**; gas panels and UPS/isolation power on the same alarm pattern. **Procurement data-export mandate extends to anesthesia workstations**; interfaced machines pre-fill the anesthesia record (anesthetist validates — ICU legal-record split).

**Money & leakage:** per-procedure consumable kits **reconciled used-vs-returned per case** (leakage triangle at case granularity) · **loaner implants 3-way matched per case** (vendor challan / usage / invoice) · cancelled-case opened-kit → return-or-charge decision, evented · OT narcotics per-case kits with witnessed partial-ampoule wastage · fees from actual timestamps · turnover time per theatre + first-case on-time as auto-KPIs.

**OT scenarios (locked):** frozen-section stat loop (specimen → pathologist → operating surgeon, minutes-scale TAT SLA) · **loaner sets: CSSD-sterilized with BI before use, no exceptions**; vendor rep presence logged · IUSS logged and minimized (tracked indicator) · **time-out halt = near-miss register entry** (a catch is a success) · retained-foreign-body never-event path (incident + disclosure + reoperation, counts linked) · unplanned return-to-OT flag (quality) · **case-overrun cascade**: re-sequencing + ward notifications + NPO-extension alerts with anesthesia re-review · power/AHU failure: complete open case on bridge power, hold the rest, theatre blocked pending checks · intra-op death: MLC check, theatre held for review in MLC cases · SSI surveillance register linked per case · night emergency activation via roster-resolved on-call OT team.

**OT events:** ot_list.published · ot_list.resequenced · valuables.sealed · valuables.returned · frozen_section.resulted · loaner_set.received · loaner_set.returned · vendor_rep.logged · iuss.performed · theatre.blocked · theatre.cleared · surveillance.recorded · timeout.halted · return_to_ot.flagged · npo.extended — catalog ~216.

### 11.17 Maternity floor deep-dive (S9 pressure test #3)

**Antenatal thread:** ANC visits build a **longitudinal pregnancy record** (EDD, gravida/para, risk factors, serology, Form-F-gated scans); **high-risk flags follow the patient everywhere**; planned LSCS books into the OT list; ANC packages ride the bundle machinery; **missed high-risk ANC visit = clinical recall alert**. At delivery admission the thread is the intake context.

**Labor triage & labor ward:** obstetric triage (admit / observe / home / emergency) · **pregnancy in a minor forces POCSO intimation** (register + police record, MLC mechanics) · **the partograph is a decision-forcing workflow** — action line crossed → documented augment-or-LSCS decision · **CTG machines are telemetry** (data-export mandate; abnormal traces alert) · **emergency LSCS runs a decision-to-delivery clock: `lscs.decided` → incision, 30-minute target, auto-derived KPI**, routed to the nearest ready ED emergency theatre.

**Codes:** obstetric rapid response (PPH → links into the Massive Transfusion Protocol; eclampsia; cord prolapse → crash LSCS) · **infant abduction code** — nursery lockdown, gate seal, band-check on every exit with an infant; layered on nursery access control and pair-band mismatch alarms.

**Registers:** delivery register · partograph record · APGAR 1/5 min · placenta disposal (BMW) · stillbirth vs live-birth (locked) · POCSO intimation register · **MTP-Act register — `termination.recorded`** (its own consent rules, gestation limits, reporting; the `mtp.activated` name stays with massive transfusion — collision caught at design time).

**Postnatal & NICU (15 beds):** mother+baby **dyad worklists** (rooming-in), postnatal danger-sign monitoring on the vitals fabric, pair-scan discharge · NICU = ICU-hall variant (same telemetry, dashboards, own admission, inherited payer) · **EBM barcoded to the baby, scanned before every feed** — wrong-milk is the NICU's transfusion error · kangaroo care + prematurity screening schedules as tasks · parent lounge passes.

**Money:** delivery packages with consent-before-overrun · newborn charges per §11.4 map 2 · **JSY/JSSK scheme payer tags day one**, scheme detail at TPA phase.

**Maternity events:** pregnancy.risk_flagged · labor.triaged · partograph.action_crossed · ctg.abnormal_flagged · lscs.decided · delivery.recorded · apgar.recorded · termination.recorded · pocso.intimated · ebm.verified — catalog ~226.

### 11.18 Ward-room model + final whole-hospital sweep (S9)

**Ward-room model:** generalized hierarchy **floor → ward/hall → room → bed** (ICU halls and OT theatres are instances). Bed classes (general / twin-sharing / private / deluxe / ICU / NICU) carry: tariff (locked §7), attendant policy (private: attendant stays; general: pass-hours only), pass counts (§11.2), nursing-ratio indicator, AC/non-AC attributes. **Gender-segregation assignment rule for shared and general wards** (hard constraint on the bed board); pediatric wards use a parent-stay pass variant; nurse-call buttons are bought hardware landing as tasks in the ward's pooled queue. **(v4.6)** The hierarchy is implemented as a **kernel resource registry** (roadmap Plan 13 — floor/ward/hall/room/bed, theatre, store, bench, analyzer, device) that module tables reference the way they reference `patients`; shipped after go-live, before stage 2, hard-gated before IPD. Bed-board rules (gender segregation, isolation, census, quota) are IPD-module rules over the registry, not registry logic.

**Final sweep — ten whole-hospital locks (agentic-readiness):**
1. **Time truth:** NTP discipline across servers/edges/devices; clock-drift monitoring as utility telemetry.
2. **Interface heartbeats:** every interface (analyzers, CMS feeds, CTG, PACS) heartbeats; silence = `interface.down` alert — no agent flies blind believing it can see.
3. **Master-data change control:** item/service/doctor/payer masters get workflow-definition governance — draft → owner approval → evented.
4. **Printed-document authenticity:** the QR on every report/certificate resolves to a verification view proving the document genuine and unaltered.
5. **Late-entry rule:** late documentation allowed, dual-stamped (`occurred_at` claimed vs `recorded_at`) and flagged; true backdating structurally impossible.
6. **No shared accounts, ever** + fast PIN/badge user-switching on shared ward terminals.
7. **Training environment = weekly restore-drill environment** (real-shaped data, zero production pollution).
8. **Notifiable-disease reporting (statutory):** IDSP/IHIP diagnoses auto-flag the register and create the government-reporting task with deadline.
9. **Dispensed-batch patient recall:** batch recall (§11.10) gains a patient-contact arm — dispense records → contact list → Recall Agent campaign.
10. **Event-log engineering:** monthly partitioning + retention-aligned archival (legal holds override); idempotency keys on edge-submitted events.

**Department residuals (module-spec noted):** histopath sub-tracking (grossing→blocks→slides) · dietary tray-tag verification against diet orders · blood-bank donor camps · **out of HMIS scope by decision:** canteen, parking, staff housing (Tally-side).

**Sweep events:** interface.down · interface.restored · clock.drift_flagged · masterdata.changed · document.verified · late_entry.flagged · notifiable.reported — **catalog ~232.**

### 11.19-A Building reconciliation & service lines (owner's real floor list, 2026-08-11)

**Actual floors:** reception · emergency (incl. 3 ED theatres, emergency radiology, **trauma**) · OPD · diagnostics & imaging · blood bank · central lab · physiotherapy · OT floor · mother & child · **cancer (incl. radiation oncology — LINAC + brachytherapy)** · heart floor + **cath lab** · dialysis · endoscopy · ICU floor · private ward · general ward · canteen (out of scope) · pharmacy shop · waste sorter/storage · laundry & linen · medical gas control room · material department. All map onto the pattern fabric; service-line mechanisms locked below.

**Cath lab (OT-variant):** **consignment inventory** — vendor-owned stents/balloons; scan-on-use creates charge + patient sticker + vendor liability in one event · **door-to-balloon STEMI clock**: `stemi.diagnosed` → `balloon.inflated`, 90-minute target, auto-derived · radiation-dose log per procedure · cath reports to PACS.

**Cancer floor:** **chemo regimen engine** — protocols in cycles, BSA dosing from captured height/weight, **pre-chemo lab hard gate** (counts below threshold block administration) · **tumor board** as a documented multi-doctor decision workflow · palliative narcotics on NDPS machinery. **Radiation oncology — architecture decision: buy the LINAC vendor's record-and-verify (R&V) + treatment-planning ecosystem; the HMIS orchestrates around it** — referral → planning handoff → fraction events back → per-fraction/package billing → clinical summary (same buy-and-integrate philosophy as Orthanc; the data-export mandate governs LINAC vendor selection). HMIS keeps the **AERB compliance registers**: brachy source movement, staff TLD badge reads, **machine QA with QA-fail = machine blocked** (QC-lockout class); RSO and medical physicist join the credential registry. Missed-fraction = clinical recall alert; cumulative dose ledger per treatment site.

**Dialysis floor:** **RO water quality as utility telemetry** + conductivity/endotoxin testing register · **seropositive machine segregation** (HBV/HCV dedicated machines — hard assignment rule on the session board) · session machinery per §11.4 map 11.

**Endoscopy:** **scope reprocessing traceability** — disinfection cycles with dwell times logged, **scope-to-patient linkage per procedure** (infection trace = one query).

**Trauma:** **tiered trauma-team activation** (code class, roster-resolved) · self-feeding **trauma registry** · MLC-heavy paths per §11.3/§11.14.

**Waste (BMW chain):** segregation at source → **weigh + barcode manifest per bag category** → signed vendor handoff → data auto-fills statutory BMW annual returns.

**Physiotherapy:** therapy plans as session bundles, therapist worklists — existing machinery, explicit matrix line.

**Service-line events:** consignment.deployed · stemi.diagnosed · balloon.inflated · regimen.cycle_started · chemo.gate_blocked · tumor_board.decided · water_quality.recorded · scope.reprocessed · trauma.activated · bmw.manifest_recorded · fraction.delivered · rt_qa.recorded · source.movement_recorded — **catalog ~245.**

### 11.19-B Final sweep (stress pass 5 — last-call, whole design)

**Clinical/legal:** **verbal orders** — nurse records with documented read-back → doctor countersigns within a set window → uncountersigned escalates (`verbal_order.recorded/.countersigned`) · **non-literate consent** — thumb impression + witness + vernacular forms supported natively in every consent flow · **records-request workflow** — application → verification → fee → fulfillment within statutory TAT (72 h) → release logged.

**Statutory:** **compliance calendar** — every hospital license (fire NOC, drug, blood bank, AERB, BMW, lifts, PNDT…) and recurring statutory return (PCPNDT monthly, BMW annual, TB notification…) tracked with escalating reminders (Expiry Watchman scope) and filing evidence (`license.expiring`, `statutory_return.due/.filed`) · **tariff display auto-publication** on every approved revision (Clinical Establishments compliance; public rates can never drift from billing rates) · **midnight census auto-derives** from the bed board (`census.recorded`) · **EWS/quota beds conditional** — if license/land terms oblige, bed board carries a quota class with auto-reporting (owner to confirm against license terms).

**Governing the AI itself:** **T2 draft quality = edit distance + acceptance rate** before human signing — the agent's own KPI; drift alerts (`draft.acceptance_recorded`) · **symmetric surveillance** — Fraud Sentinel and anomaly reports watch agent identities like humans; per-agent rate limits (runaway loops hit ceilings, not the log) · **model-change governance** — swapping a T3/T4 agent's model is evented + owner-approved (`model.version_changed`) · **AI disclosure** — interactive AI touchpoints disclose automation; transactional messages are hospital-branded.

**Operational residue:** printers/scanners join interface heartbeat monitoring; every barcode station has a manual-ID-verify fallback · **bundle pro-rata refunds** with approval (entitlement-counter exit rule) · lost & found register with photo + WhatsApp notification · engineering notes: optimistic locking for concurrent charting; online-prepaid appointment refund rules at CRM phase.

**Pass-5 events:** verbal_order.recorded · verbal_order.countersigned · records_request.received · records_request.fulfilled · license.expiring · statutory_return.due · statutory_return.filed · census.recorded · draft.acceptance_recorded · model.version_changed — **catalog ~265.**

**Staffing layer:** the workforce design — 34 full-depth role cards across three operating models, role-bundling and segregation-of-duties matrices, and 14 workforce mechanisms — lives in its own spec: `2026-08-11-hmis-staffing-kpi-design.md` (design series S10).

### 11.19 S9 coverage matrix (series-closing check)

Every department × the patterns it runs on × where designed — the "nothing off the fabric" proof: front office (P1/P6/P7 — §11.1, §7) · OPD (P1/P2/P6/P7 — §11.1, §11.6–11.8) · ER (P1/P2/P5 + codes — §11.3, §11.14) · IPD wards (P1/P2/P3/P5 — §11.2, §11.18) · ICU (P1–P3/P5 + telemetry — §11.15) · OT (P1–P3/P5 — §11.9, §11.16) · maternity/NICU (P1/P2 + pairing — §11.4, §11.17) · day-care (§11.4) · lab (P2/P3 — §11.6) · radiology (P2 + PCPNDT — §11.7) · blood bank (P2/P3 — §11.4 map 10) · pharmacy (P3/P4/P6 — §11.8, §11.10) · stores/procurement (P3/P4 — §11.10) · CSSD, laundry, kitchen, housekeeping, transport, biomedical, security, mortuary (P3/P5 — §11.10, §11.12, §11.14) · MRD (registers/retention/DPDP — §11.14) · billing/TPA (P6 — §7, §11.11) · admin/quality (approvals, digests, self-feeding registers) · ambulance (P5 — module spec) · HR/accounts (bought, §9). **Thin spots are all explicitly deferred with hooks in the catalog** (kitchen production, physio protocols, ambulance dispatch, organ donation, camps, teleconsult).

### 11.19-C Stress pass 6 — 48-agent adversarial swarm fixes (all folded, v4.3)

Eight attack lenses × skeptical verification against spec text; 39 findings survived, zero refuted. Every fix below is design law; where a fix amends an earlier section, this list is authoritative.

**Legal/statutory (amends §7, §11.14, §19):**
1. **Referral payee classes (critical):** referrer master splits into (a) in-house fee-splits + corporate tie-ups — full payout machinery; (b) non-RMP agents/promoters — lawful marketing spend; (c) **external registered medical practitioners — attribution captured, payout eligibility structurally OFF**; the Payouts pack refuses to batch class-(c) without a documented legal-counsel decision on file (IMC Professional Conduct Regs cl. 6.4 — cut practice). Hard pre-go-live gate in §19.
2. **Cash-law layer (critical):** per-payer-per-episode cash aggregation (deposit + interims + settlement counted together) with warning-then-hard-block at the configured **Section 269ST** threshold; PAN/Form-60 capture above the configured line; UPI/NEFT counseling prompts on large settlements; **₹10k/vendor/day cash cap** on petty/emergency purchases with auto-split to bank transfer (Section 40A(3)). Golden-suite cases added; exact thresholds = CA-confirmed configuration.
3. **Regulated-price layer (major):** item master gains MRP + DPCO/NPPA notified-ceiling attributes with effective dates (updates via master-data change control); charge rule for drugs/devices = **min(tariff, MRP, notified ceiling)** with hard block above ceiling; batch-MRP captured at GRN; NPPA revision watch on the compliance calendar. Consignment scan-on-use obeys the same rule.
4. **DPDP breach notification:** cyber-incident protocol adds Data Protection Board + affected-patient notification alongside CERT-In.
5. **Statutory-secrecy data class:** HIV Act 2017, MTP, and PCPNDT records form a **sealed event class** — restricted beyond normal RBAC, access itself evented; registers keep statutory custody rules.
6. **PCPNDT scope widened:** Form-F gate applies to **any ultrasound on a woman of reproductive age** and to portable machines, regardless of ordering department.

**Clinical safety (amends §11.9, §11.8, §11.17, §11.6):**
7. **Emergency OT gate profile:** life-critical gates stay (identity, emergency two-doctor consent); remaining gates auto-waive with loud logging — the crash case is never blocked by an elective checklist.
8. **Allergy re-screen sweep:** `allergy.recorded` triggers re-screening of active orders, pending dispenses, and queued eMAR doses; hits flag prescriber + pharmacist + nurse.
9. **Neonatal resuscitation code:** NRP code class, roster-resolved neonatal responder role, resuscitaire equipment-check chain per shift.
10. **QC lockout release valve:** pathologist may issue a documented emergency override — results flagged QC-suspect on the report face — plus reroute-to-backup/POCT path; overrides are events with mandatory next-day review.
11. **Escalation dead-end fallback:** every ladder terminates at duty manager + owner SMS if role resolution returns nobody; the roster feed itself heartbeats.

**Money/fraud (amends §7, §11.10, §11.11, S10):**
12. **Anti-structuring aggregation:** approval thresholds evaluate cumulative same-patient/same-payee/same-day amounts, not single transactions.
13. **Device-billing reconciliation generalized** from ICU devices to every powered modality (CT/X-ray/USG, analyzers, dialysis, endoscopy) — usage events vs billed studies, both directions.
14. **Follow-up window extensions:** capped per doctor per period, each extension evented, pattern report to management (fee-diversion door closed).
15. **Downtime cash SoD:** downtime receipts must be reconciled at recovery by a second person — never solely by the declaring duty manager.
16. **Non-custodian counts:** ward/sub-store cycle counts performed by stores/pharmacy staff, never the custodian in-charge; SoD pair added.
17. **Attribution verification gate:** commission accrual eligibility requires referrer verification (patient-confirmed or prescription-evidenced); unverified attributions are captured but ineligible.
18. **Duplicate-UHID gaming check:** false-attach detection (demographic-mismatch audit sampling, photo-prompt on attach) pairs the registration KPI.
19. **Pharmacy retail flow:** walk-in shop sale designed — POS flow with Schedule-H/H1 prescription gate, anonymous-or-linked customer, GST invoice, retail stock location in the store network.
20. **Read-model honesty clause:** billing-from-events cannot see care delivered without an event; mitigations — round-checklist audits + notes-vs-orders cross-check agent (T0) — and the residual limit is stated, not hidden.

**Workforce/S10 (amends S10 — see S10 v1.1):**
21. Roster system-of-record moves to HMIS (HR keeps payroll); publication gates enforceable.
22. Succession chains for single-incumbent 24×7 posts; duty-manager night succession explicit.
23. Witness eligibility defined for all two-person verifies (licensed nurse on floor, cross-ward allowed, logged remote-video witness as last resort); roster validation guarantees a witness exists.
24. Labor statutes added: women's night-shift provisions, Maternity Benefit/creche, CLRA for outsourced pools, PSARA-licensed security vendor, POSH ICC channel.
25. Five new role cards (vitals-desk assistant, phlebotomist, quality manager/NABH, infection-control nurse, medical superintendent) — the quality/governance spine staffed from day one.
26. Day-one headcount bands corrected to the cards' honest sum (~70–100 under A2).

**Agentic layer (amends §16):**
27. Agents are **operating-mode aware** — disaster/surge/downtime context gates their triggers.
28. **Backfill semantics:** backfill-flagged events never trigger agent actions, only reports; agents pause during downtime recovery.
29. **Agent liveness:** every agent heartbeats like an interface; a deterministic (non-AI) watchdog monitors the monitoring agents.
30. Rate-limit shedding raises an alert — never silent drops during legitimate storms.
31. **Two-key rule:** Workflow-Tuner changes to clinical-safety definitions require owner + medical-director approval.

**Scale/DR (amends §2, §12, §13):**
32. Process-split architecture (§2, v4.3 note) · 33. Replica reads for analytics/agents (§2/§12) · 34. Semi-sync replication + fencing + gate revalidation (§12) · 35. Floor-scoped degradation with staleness banners (§12) · 36. PACS backup physics recomputed: tiered imaging retention, incremental object-storage offsite for images, staggered backup windows (procurement note in §13).

**Consistency repairs:** 37. Event-catalog arithmetic reconciled (see §10.6 note) and S10 mechanism events merged · 38. S10 dangling figure references repaired · 39. This list cross-referenced from every amended section's context.

**Pass-6 events:** payout.class_blocked · cash_limit.warned · cash_limit.blocked · ceiling.price_applied · allergy.rescreen_flagged · code.activated (type: nrp) · qc.override_recorded · retail_sale.recorded · attribution.unverified_flagged · agent.heartbeat_missed · mode.context_applied · care_audit.mismatch — full reconciled catalog **~285 events** (S10 workforce events now merged into §10.6's canonical set).

### 11.19-D Stress pass 7 — every-angle swarm fixes (all folded, v4.4)

Sixteen lenses (patient dignity, doctor adoption, insider collusion, external attack, courtroom, NABH assessor, statutory audit, TPA adversary, privacy, go-live, solo-maintainer decade, AI ethics, regression, scale re-check, human factors, black swan); 48 verified findings folded. This list is authoritative where it amends earlier sections.

**D-A. Money boundaries (closes the HMIS/Tally/bank/insurer seams):**
1. **Disbursement reconciliation (critical):** monthly three-way check — HMIS matched-invoice ledger vs Tally payment vouchers vs bank-statement debits (statements imported read-only); unmatched/duplicate/excess payments become tasks + digest lines. **Vendor master incl. bank details joins §11.18 change control** with owner approval and a cooling-off before first payment to changed details. Vendor-payment anomalies join Fraud Sentinel.
2. **Payer-settlement decomposition:** settlements record gross-allowed / disallowed / TDS-194J / GST-TDS / net-received; TDS-receivable ledger in the Tally voucher map; **aging and dunning compute on net-of-TDS expectation** (no false credit-stops); quarterly 26AS/AIS reconciliation task.
3. **GST is exemption-boundary logic, not a rate lookup:** engine models the healthcare exemption, the ₹5,000/day room-rent taxability line, IPD composite-supply treatment, and Rule 42/43 ITC-reversal data for the accountant; CA-configured, golden-suite covered.
4. **FY cut-off treatment defined with the CA:** deposits as liabilities, unbilled in-progress IPD as WIP at year-end, packages spanning March 31 — a year-end close procedure joins the financial rhythm.
5. **Insurer-share/patient-share split is first-class:** invoice lines carry payer-share decomposition; room-rent-cap proportionate deductions computed and shown; IRDAI non-payables list as configuration; co-pay handling.
6. **Pre-auth sanction is a first-class object** (sanctioned amount, class, LOS, procedure scope) with deviation triggers — **pulled forward to the IPD phase**, since cashless IPD precedes the full TPA desk.
7. **Consignment/loaner ownership dimension** on stock locations (owned / consignment / loaner): excluded from inventory valuation, leakage triangle computed per ownership class, GST §31(7) six-month deemed-supply clock tracked per consignment lot.
8. **Discount defensibility:** every discount carries a category (charity / scheme / negotiated-corporate / employee) so the tariff-display + discount trail answers a "lowest rate" desk audit instead of arming it.
9. **Discharge cascade gains an "awaiting payer final approval" state** and a claim-consistency check before final bill — the cascade clock pauses attributably on the payer, not the hospital.

**D-B. Governance & continuity (the owner stops being the single point of failure):**
10. **Owner becomes a governance role, not a person:** two-key emergency activation (duty manager + medical superintendent; medical director for clinical definitions) when the owner is unreachable; **declared-incapacity protocol** — a pre-designated deputy pair exercises time-boxed owner authorities, every act evented, auto-expiring, queued for ratification, backed by a legal delegation instrument. Owner joins the S10 succession-chain rule.
11. **In-flight instance remediation** is a workflow-engine capability: approval-gated migrate-to-version-N+1 (at mapped states) and abort-and-restart, evented per instance — amends §10.2's completion rule.
12. **Technical continuity kit:** sealed dual-custody credential escrow (unseal = two-person, evented), repo + deploy runbook + AI-tooling docs, retained outside-developer contract — verified by an **annual stranger drill** (an outsider ships a trivial patch to the training environment using only the kit).
13. **Replication-mode state machine (amends §12):** standby unreachable past timeout → scripted auto-demote to async, loudly evented (`replication.sync_degraded/.restored`), owner + duty-manager alerted — never a silent write-freeze; planned-maintenance pre-declares async with verified auto-restore; failover runbook step zero reads sync state (promotion under degraded mode widens reconciliation scope).
14. **Technology lifecycle policy:** N or N-1 major versions for every stack component; annual upgrade window rehearsed on the restore-drill environment first; golden suite + definition tests + event-contract tests are the upgrade regression gate; monthly OS/container patching as recurring verified tasks; annual maintenance budget line (§13).
15. **Risk-tiered change classes** (replaces owner-as-sole-gate at scale): **Class A** — clinical-safety, money rules, statutory/sealed config: owner + medical-superintendent two-key. **Class B** — operational thresholds within owner-pre-approved bands: department head + duty approval, digest-surfaced, revertible. **Class C** — routine master-data: automated with sampled audit. The taxonomy itself is Class A.
16. **Roster module integrated coherently** (repairs the fix-21 contradiction): §9's bought-HR line now reads — HR system keeps payroll and biometric attendance; **the HMIS owns roster authoring, validation, and publication** (S10 gates enforceable); roster module ships in the Phase-2 Quality/NABH fast-follow window.
17. **Initial-configuration validation gate:** before first live invoice, the golden suite runs against the loaded config (tariffs, GST, adjustment rules) in rehearsal mode; go-live requires a passed config-validation report.
18. **Machine-readable canonical registry:** workflow definitions, event catalog, and rule config export as a versioned registry that agents and future maintainers build against — the spec stays prose; the registry stays truth; a drift check between them is a standing T0 report.
19. **Total-loss recovery tier (amends §12):** primary and standby sited in different fire zones; documented bare-metal recovery runbook (any capable hardware + Compose + pgBackRest restore); offsite RPO stated honestly (weekly offsite = up to 7 days if both servers and NAS are lost — accepted and signed by owner, or upgraded to daily incremental offsite); cloud-restore option documented for building-loss scenarios.

**D-C. Trust fabric & security:**
20. **Network segmentation & NAC** join the LAN fit-out mandate (§13 flag): VLANs per zone (clinical / edge-devices / guest / office), port authentication, firewalling between zones — a lobby LAN jack is not a path to the database.
21. **Edge/device authentication:** every edge agent and device feed authenticates (mutual TLS / per-device tokens); unauthenticated submissions rejected; **auto-verification applies only to authenticated sources.**
22. **Event-log tamper evidence + court production:** daily hash-chain anchor of the event log (digest stored offsite/printed); a court-production workflow issues certified extracts with custodian certificate (BSA §63 / evidentiary requirements) — the trail's weight survives hostile scrutiny.
23. **Signed QR tokens:** wristbands, passes, gate passes, and document QRs carry signed payloads; scanners verify signatures; reissue rotates; a photographed static code fails the scan — the right-patient hard stops hold against cloning.
24. **WhatsApp authenticity defenses:** verified business account only; payment requests always reference the registered VPA printed on hospital materials; standing patient education line in every money message ("the hospital never asks for payment to personal numbers"); spoof-report channel; deposit-redirect smishing joins the incident catalog.
25. **Sealed-class propagation (closes the derived-surface leak):** the seal follows the fact to every surface — WhatsApp pushes become neutral collect-at-desk notices, attendant bills mask clinically-revealing lines per policy, handover views restrict, agent pipelines honor the seal. Sealed-class review joins the DPIA.
26. **Telemetry retention symmetry:** incident/legal-hold flags freeze the relevant telemetry windows on edge stores (holds reach the edges); the retention schedule is a published policy — deletion is policy execution, not spoliation.
27. **Clinical signature strength:** signature-class clinical acts (report signing, countersigns, verifies) require a second factor — same as money. Shared-terminal PIN switches identify; they do not sign.
28. **Downtime-window integrity:** floor-scoped downtime declarations need declarer + second person; all downtime windows appear in the owner digest with frequency/duration analytics — a repeat-pattern paper window is visible by design.
29. **Count randomization:** cycle counts assigned randomly among eligible non-custodian counters; periodic blind recounts; annual external stock audit.
30. **Collusion-dyad analytics:** Fraud Sentinel models standing pairs — approver/requester, witness pairings, counter/custodian — recurring dyads with anomalous outcomes are a report class.

**D-D. Clinical & human:**
31. **Guardianship model (Phase-1 patient master):** guardian entity with relationship, verified identity, **authority scope** (messages / consents / DSR / bills), validity dates, DOB-driven transition at majority; DPDP §9 guardian consent at minor registration; **sensitive-context override** — POCSO/abuse/adolescent-confidentiality flags force sealed-channel rules away from the default guardian number.
32. **Membership perk semantics + sale guardrails:** priority perk = bounded interleave (every Nth call), never overriding danger vitals or on-time appointments — §11.1 amended to name it; no membership/bundle sales at ER, admission desk, or IPD bedside; 7-day cooling-off with full refund; disclosure script; no sales incentives on counter roles.
33. **Deceased-patient conduct:** death event suppresses dunning/reminders to the family and reroutes settlement to a respectful path; **body release is never gated on payment**; estate/settlement follow-up is a separate, human-paced workflow.
34. **Patient navigation:** low-literacy and unaccompanied patients are a designed path — audio token calls (existing), staff-assisted flows, printed fallbacks for the phoneless, and navigation duty assigned to front-office roles day one (dedicated navigator post at scale, added to S10).
35. **Doctor adoption program (day one):** dictation path — voice → T2-drafted structured note → sign; scribe support option for senior consultants; **designed off-site access** (VPN/phone app) for countersigns, approvals, and worklists — the WhatsApp shadow channel loses its reason to exist; **documentation-time budget per role** — the summed mandatory interaction load per shift is computed, and any definition change adding a mandatory step must fit the budget or displace something; **day-one carrot: each doctor sees their own live accrual dashboard** (fee-splits transparent from week one, not month three).
36. **Automation-bias instrumentation (signer side):** time-in-draft and interaction depth before signing; sampled QA re-reads of signed AI drafts; periodic draft-withheld control cases; **AI-draft legal status defined** — a draft is an unsigned working paper; the signed document is the doctor's own, and the draft trail is QA material with a stated retention policy.
37. **Equity guardrails:** agent prioritization is payer-blind and VIP-blind by rule (VIP flags affect privacy, never clinical priority); a wait-time-by-payer-class equity report goes to the owner monthly.
38. **Nursing assessment scales day one of IPD:** fall risk (Morse), pressure-injury (Braden), pain scores in nursing charting — the NABH indicators' data source exists before the assessor asks. **Patient-satisfaction capture starts Phase 1** as a post-visit WhatsApp micro-survey, not at the CRM phase.

**D-E. Compliance machinery:**
39. **Committee machinery (Quality/NABH pack, Phase-2 fast-follow):** committee entity — membership, cadence, agenda auto-fed from flagged events, minutes, action-taken tracking with due dates. Covers: Drug & Therapeutics, infection control, quality & safety, mortality review, tumor board (§11.19-A), blood transfusion, POSH ICC. NABH's evidence artifact exists as a workflow, not a binder.
40. **Controlled-document layer:** SOPs as versioned, approved documents with **read-and-acknowledge assignments tracked per staff member**; each workflow definition links its SOP; training evidence generates itself.
41. **HR-evidence bridge:** HMIS owns the NABH-facing staff evidence — training records, drill participation, occupational-health/immunization register, credential files; the bought HR system keeps payroll only.
42. **DPDP architecture:** layered vernacular notice at registration; purpose-bound consent artifact; withdrawal object with propagation (marketing stops; clinical processing continues under legal basis, stated); **DPO designated** (quality manager dual-hats day one, dedicated at scale — S10 amended); grievance officer named; **DPIA required before each agentic phase**.
43. **Cutover & paper-era continuity:** hard-cutover runbook (registration-day switchover, no double-entry period); old-UHID cross-reference field + physical-file pointer in MRD; pre-cutover records requests route to physical MRD within the same statutory TAT; crk-hmis read-only archive retained.
44. **AI inference locus (decision forced to §19, pre-Phase-1):** either cloud LLM APIs under a DPDP processor agreement with data-minimization (de-identified/minimum-necessary context per agent job), or an on-prem inference server (₹3–6L budget option added to §13). The DPIA (fix 42) documents the choice; clinical records never leave without a documented posture.

**Pass-7 events:** disbursement.mismatch_flagged · vendor_master.changed · settlement.recorded · tds_credit.reconciled · preauth.deviation_flagged · consignment.aging_flagged · replication.sync_degraded · replication.sync_restored · instance.migrated · instance.aborted · governance.emergency_activated · incapacity.declared · registry.drift_flagged · config.validated · qr.signature_failed · message.spoof_reported · guardian.linked · guardian.authority_changed · navigation.assisted · doc_budget.exceeded · draft.qa_sampled · equity.report_issued · committee.minuted · sop.acknowledged · dsr_consent.withdrawn · dpia.completed — reconciled catalog **~310 events**.

### 11.19-E Stress pass 8 — approvals/communication/audit topology + fresh angles (all folded, v4.5; swarm phase closes here)

Ten lenses (approval topology, communication topology, the audit function itself, v4.4 regression, inspector day, payment rails, data exfiltration, ABDM deep readiness, cultural life-cycle, first 100 days); 38 verified findings folded. Authoritative where it amends earlier sections.

**E-A. Reachability, custody, and the chaperone gate (the pass's genuine gaps):**
1. **Public read-only surface:** a DMZ micro-service or cloud relay, fed **one-way by outbound push** from the gateway, serves the patient-facing links the design already promises — live queue position, document-verification views, running-package status — via **signed short-lived tokens, no PHI beyond the token's grant, no inbound path to the core**. Joins §3's topology, §13's budget (~₹5–15k/yr relay or small DMZ box), §14's threat model, and the DPIA. Without this, week one produces dead links and a field-rigged port-forward.
2. **Encryption at rest everywhere + vendor custody:** LUKS on both servers and every edge box; pgBackRest repo-level encryption (every backup tier ciphertext); encrypted NAS volumes; keys escrowed in the D-12 continuity kit. Drive-replacement runbook includes failed-media destruction/retention. **Vendor-access workflow** generalizes the OT rep pattern: escorted server-room/NAS access, `vendor_access.logged` (identity, scope, supervising staffer), remote sessions time-boxed and recorded; **DPDP processor agreements required of every vendor whose equipment touches patient data** (joins the procurement mandate). Server room + NAS join CCTV/physical-security scope (S10 card 34).
3. **Chaperone framework:** procedure/exam classes carry a chaperone-required attribute (intimate examinations, USG, ECG on female patients); `chaperone.present` (identity recorded) is a **documentation gate** on those encounters with witness-style last-resort rules; **roster publication validates that any shift running a chaperone-required station rosters an eligible female staff member in reach.**

**E-B. Regression repairs (pass-7 fixes that created holes):**
4. **Sealed-class treating-team carve-out:** the seal never blinds the *active treating team's* clinical surfaces — drug-safety checks, eMAR context, bedside handover see the fact; the carve-out access is itself evented. Privacy protects the patient from the world, never from their own care.
5. **Emergency-governance precedence rule:** the two-key emergency activation path explicitly supersedes the drafter/activator SoD pair via its own evented pathway — the deadlock is resolved by declared precedence, not by hoping.
6. **Authority naming unified:** the clinical-definition second key is the **Medical Superintendent** everywhere ("medical director" references removed); the MS (S10 card 39) joins the succession-chain list and has deputy coverage — a load-bearing authority is never an undefined post.
7. **Roster substrate ships in Phase 1:** duty assignment, on-call chains, and publication gates are foundation-scope (the day-one mechanisms that depend on them get their substrate); the *full* roster module (optimization, deep statutory validation) remains the Phase-2 fast-follow.

**E-C. Clinical reality & the first 100 days:**
8. **Entered-in-error grammar (universal):** wrong-patient/wrong-item entries are corrected by flag → reversing event → linked corrected entry — never edits, never deletes; bills, charts, and self-writing registers render corrected views with the trail intact; Fraud Sentinel understands correction semantics.
9. **Blood-refusal directive:** a signed refusal (patient/guardian) satisfies the OT blood-reserve gate as an explicit alternative path with a documented bloodless-surgery plan; the transfusion chain checks the refusal flag before any cross-match.
10. **Commissioning/ramp mode:** a declared operating mode for the first weeks — SLAs record but only patient-safety criticals alert; **Workflow-Tuner baselines start after ramp exits** (never learning from the chaos window); ramp exit is an owner decision, evented.
11. **Transition-operations plan:** the first ~100 days run a designed two-system hospital — the existing 10-bed IPD, pharmacy, lab, and licensed blood bank continue on current processes with a **boundary map** (single source of truth per record type) and a scheduled absorption order per rollout phase; the D-43 cutover runbook extends from a registration-day switch to this phased absorption schedule.
12. **Bulk-remediation path:** a config-error's credit-note/reissue storm is fixed by an owner-approved **remediation batch** — one approval covering the linked batch, tied to the causing config change; Fraud Sentinel whitelists the batch instead of attacking the cleanup crew.
13. **Death-to-release cascade:** SLA-timed with a 24×7 certification chain (duty doctor certifies; on-call signer chain for certificates) — last-rites timing (before-sunset/24-hour customs) is the design target, not an exception.
14. **Family-requested discharge hold:** a hold state attributable to the family pauses the cascade clock (mirror of the payer hold) — auspicious-time discharges stop breaching SLAs by design.

**E-D. Approvals, communication, and the audit function (the named angles):**
15. **Approval urgency classes:** time-critical clinical approvals (ICU admission, emergency overrides) ride an **interrupting channel** (app push + PBX page) with an act-first-review-after bypass where clinically warranted, evented.
16. **Out-of-band alerting locus:** the standby (or an independent watchdog box) monitors the primary and sends the "primary down" alert — **never the machine that just died**; the watchdog is exercised in every DR drill.
17. **Internal-audit program:** Companies Act §138 internal auditor (external firm, annual plan) + a concurrent-audit function; **control-testing calendar** (does the SoD block actually block? do gates actually gate?) on the compliance calendar; quarterly management control-review as a D-39 committee.
18. **Anomaly-report disposition:** every fraud/anomaly report class has a designated reviewer role, a disposition workflow (reviewed → action/no-action with reason), a closure SLA, and overdue escalation — **a report nobody must answer no longer exists.**
19. **Evidence-retention map:** retention schedule per audit type (NABH, 8-year books/tax — which the event log inherits as the books' source record, court/MLC, DPDP) mapped to event classes and registers; published policy.
20. **External-access personas + inspection workflow:** read-only scoped personas for statutory auditors, TPA desk auditors, and inspectors — time-boxed grants, sealed-class always excluded, access evented; an inspection-visit workflow (who attends, on-the-spot certified prints, inspection directions tracked as tasks to closure).
21. **Statutory-format renders:** every register has a prescribed-format certified printout; **electronic-register legality confirmed per act with counsel** (registers requiring bound physical books get print-and-bind procedures); joins §19.
22. **Amended-report supersession:** an amendment re-delivers on the original channels (superseding WhatsApp PDF with banner; print-recall where feasible); the document-verification view always shows the latest version + amendment notice.
23. **PBX procurement mandate + heartbeat:** PBX selection requires API/paging integration (the one-touch code's second leg is designed, not assumed); the PBX joins interface heartbeat monitoring.

**E-E. Payment rails:**
24. **Degraded-tender mode:** declared rails-down operation — cash + offline card vouchers + pay-later flag with recovery workflow; pay-before-consult relaxes to pay-before-exit under the declared mode, evented; full reconciliation on recovery.
25. **Tender lifecycle:** settled → disputed → chargeback → recovered/written-off states; **orphan-credit state** (money in bank, no matching event) with investigation task; chargeback response deadlines as SLA-tracked tasks.
26. **Settlement economics modeled:** MDR/fees and per-rail lag (UPI T+1, cards T+2/3) in reconciliation — expected-*net* matching; fee ledger flows to Tally.
27. **Per-payee payout status:** `payout.executed` becomes per-payee (batch keeps a summary); bounced NEFT → `payout.bounced` → retry workflow; **TDS certificates issue only against confirmed transfers.**

**E-F. Exfiltration, ABDM, and residuals:**
28. **Bulk-export governance + endpoint posture:** patient-list/bulk exports require approval, purpose, watermark, and `export.recorded`; managed browsers on hospital terminals, identity-watermarked prints, USB policy; scoped export rights.
29. **Access-review program:** a T0 access-vs-care-relationship report (accesses without a treating relationship flagged); notice-period staff on heightened review; break-glass review generalized into a standing access-review cadence with a designated reviewer (per fix 18's rule).
30. **ABDM identifier model:** patient master carries ABHA **address**, verification status, and link tokens (not one nullable number); M1/M2 flow fields reserved; **care-context link-suppression attribute** honors the sealed class; historical bulk-linking only by explicit consent.
31. **Standard-code dimensions:** ICD-10 diagnosis and procedure/package code fields on masters and encounters, **capturable at order/pre-auth time** (not only retrospective MRD coding); NHCX package-code mapping table reserved.
32. **HFR/HPR on the compliance calendar:** facility registration, practitioner HPR IDs (credential registry), and ABDM M1–M3/NHCX certification milestones tracked.
33. **Cold-chain logging:** pharmacy fridges, blood bank, vaccine storage on the utility-telemetry pattern (sensors, or manual recurring verified tasks day one); excursion events + register — the drug inspector's first ask, answered.
34. **CLRA principal-employer registers:** outsourced-pool attendance/wage evidence owned in the D-41 HR-evidence bridge; contractor licences/compliance documents on the compliance calendar.
35. **Publish-with-deviation:** a blocked roster can publish under owner/MS-approved deviation (evented, time-boxed, digest-surfaced) — role resolution never goes dark hospital-wide because one constraint failed.

**Pass-8 events:** chaperone.present · vendor_access.logged · export.recorded · correction.entered_in_error · remediation.batch_approved · tender.disputed · tender.chargeback_recorded · payout.bounced · rails_down.declared · rails_down.ended · ramp_mode.exited · access_review.flagged · coldchain.excursion · report.superseded · inspection.visit_logged · family_hold.applied · roster.deviation_published · audit.control_tested — reconciled catalog **~330 events**.

### 11.20 Swarm-phase convergence declaration

Eight stress passes are complete: five solo passes (S2 era through the final sweep), then three multi-agent adversarial swarms — pass 6 (8 lenses, 48 agents, 39 fixes), pass 7 (16 lenses, 67 agents, 48 fixes), pass 8 (10 lenses, 50 agents, 38 fixes). **Convergence evidence:** genuine gaps fell 3 → 8 → 3 per swarm pass with severity declining (pass 8's genuines are all major, none critical); raw findings fell 64 → 40; later passes increasingly found escapes-through-mechanisms rather than missing organs, and each swarm's regression lens caught the previous fold's own defects (semi-sync freeze; sealed-class blinding) — the process now polices itself. **The swarm phase is closed.** Residual risk is retired by different instruments, already in the design: the owner's independent review rounds, the golden suite + config-validation gate at build time, commissioning/ramp mode in the first 90 days, the internal-audit program (E-17), and the standing regression discipline that any future spec change of Class A/B receives a targeted adversarial review before activation.

## 12. Failover, Backups, Data Portability

- **(v4.7) EVERYTHING IN THIS SECTION THAT NEEDS A SECOND MACHINE IS STAGE 2+ (§1's staged-deployment ruling,
  2026-08-22).** Stage 1 runs ONE cloud server, so semi-sync replication, scripted promotion, fencing, the
  out-of-band watchdog (E-16) and hot-standby analytics reads all arrive with the hybrid step, not before.
  **What stage 1 still owes in full, because it is the only thing standing between a mistake and total loss:**
  pgBackRest continuous WAL archiving + nightly fulls, the **automated weekly restore drill**, and the weekly
  encrypted offsite copy on immutable media. A single server with a *proven* restore is a defensible pilot
  posture; a single server with an untested backup is not, and the drill is what tells the two apart. State the
  stage-1 RPO/RTO honestly in the runbook rather than inheriting this section's <15 min, which assumes a standby.
- **Two servers, scripted promotion.** Primary runs the full stack; standby receives every transaction via **semi-synchronous replication (v4.3)** — an acknowledged write exists on both servers, so failover can no longer lose the acked tail that hard-stop safety gates depend on. Failover = one scripted command; target RTO under 15 minutes; deliberately manual-trigger with a printed runbook. **Fencing (v4.3):** promotion revokes the old primary's outbound rights — a demoted/partitioned node's gateway and agent consumers stop (fencing token checked by outbox consumers), so a zombie node can't keep messaging patients. **Post-failover safety-gate revalidation:** in-flight hard-stop verifications (counts, cross-matches, pair-scans) re-verify against physical scans before resuming. Monitoring alerts the owner via WhatsApp/SMS. The downtime protocol (§11.4 map 1) covers the promotion window; **floor-scoped degradation (v4.3):** a single floor losing network triggers that floor's downtime kit and staleness banners on its screens — never a hospital-wide declaration.
- **Backups assume the server room burns down — or is ransomed.** pgBackRest continuous WAL archiving + nightly fulls to a NAS outside the server room; **weekly encrypted offsite copy on immutable/air-gapped media** (a permanently-connected replica can be encrypted along with the primary — the offline copy is the ransomware answer). **Automated weekly restore drill.** Orthanc image store syncs nightly to the NAS. Cyber-incident protocol incl. CERT-In 6-hour reporting: §11.14.
- **Portability:** Postgres open format; FHIR-shaped documents; DICOM portable by definition; one-click per-module CSV/JSON export. No lock-in, including to this software.

## 13. Hardware Plan (rough 2026 INR)

| Item | Spec sketch | Rough cost |
|---|---|---|
| **(v4.7) STAGE 1 — cloud, now** | ONE Hetzner cloud VM; no capex. Build, Phase-1 completion and owner UAT run here | **~₹1.5–2k/month** |
| **Phase 1 — before OPD go-live** *(v4.7: this is the ON-PREM cutover, stage 3 — see §1)* | | **~₹11–15L** |
| Primary server | 32-core, 128 GB ECC, 2×3.84 TB NVMe RAID-1, HDD bays | ₹4.5–6L |
| Backup NAS (outside server room) | 8-bay, 4×12 TB | ₹2–3L |
| 2× online UPS 3 kVA + rack basics | | ₹1.5–2L |
| Lab edge mini-PCs ×2 (fanless) | | ₹30–40k |
| USB barcode/QR scanners (~10 desks) + label printing | | ₹25–35k |
| IP-PBX + 30–50 IP phones (bought infra) | | ₹1–2L |
| Queue displays ×2–3 (43" TVs + player) — fast-follow | | ₹60–90k |
| **Phase 2 — before IPD/ICU go-live** | | **~₹7–9L** |
| Standby server *(v4.7: this line and §19's pre-Plan-11 gate contradicted each other — the owner's staged ruling resolves it. The standby arrives at STAGE 2, with the hybrid step, not before Phase-1 go-live)* | Similar, slightly smaller | ₹4–5L |
| PACS storage expansion, MQTT broker box, switches | | ₹2–3L |
| Wristband printers (per ward station) | | ₹25–40k each |
| Oxygen tank/pipeline level sensors + gateway | | ₹50–80k |
| ICU floor (45 beds, phased): per-hall vendor CMS w/ HL7 export | Buy bundled with monitors — mandate data export in purchase specs | Priced with monitor procurement |
| ICU integration: hall feeds → MQTT gateway + station terminals | | ₹1.5–2.5L |
| OT environment sensors ×9 theatres (temp/humidity/differential pressure) + gateway | | ₹1.5–2.5L |

**Flag:** hospital-wide LAN for a 610-bed building (cabling, switches, APs, terminals, tablets) is a separate fit-out project, typically ₹15–40L. This software rides on it but does not include it.

## 14. Security & Access Control

- Permissions are *action + scope* (own department / floor / hospital-wide); roles bundle permissions; users hold roles per department/floor.
- Second factor for narcotics registers and financial overrides.
- **Break-glass:** ER staff can open any record instantly; loudly logged and queued for review.
- **Confidential records (v3):** staff-as-patients and VIP-flagged records restricted beyond normal RBAC; aliases on all public surfaces; public displays announce tokens only.
- **Agents are first-class actors (v3):** own identities, own permissions, same RBAC enforcement as humans; every agent action is an evented, attributable act.
- Access logs + consent records align with the DPDP Act. All external traffic flows through the single gateway module.

## 15. UX Foundations (architectural, not cosmetic)

- Hard performance budgets enforced by tests: patient search < 300 ms; interactive response < 100 ms.
- Registration and billing counters keyboard-first; ward tablets get large touch targets.
- Role-based workspaces: each role logs into their queue/worklist, not a menu tree.
- Hindi/English switchable UI day one; per-patient language preference for outbound messages (§6).
- Print output is a first-class design surface — and every printed document carries its QR (§7).

## 16. Agentic AI Layer

The vision (§1) lands here: agents form the hospital's operational intelligence, standing on the deterministic substrate — they consume the event stream and act through the same permission-enforced APIs and workflow definitions as humans, never the database.

**Autonomy tiers govern every agent:** T0 observe/report → T1 remind/nudge → T2 draft for human sign-off → T3 act behind approval gate → T4 autonomous. Operational domains may climb to T4. **Clinical actions cap at T2–T3 permanently — agents draft, doctors decide.**

**Roster taxonomy (v4.6):** *automations* are deterministic jobs — rules, SQL, ladders — running under the agent harness (identity, kill switch, heartbeat, mode/backfill gates, tier); *agents* call an inference model or make a non-rule decision. Of the roster below, SLA Chaser, Expiry Watchman, Recall & Follow-up, Leakage Auditor, Fraud Sentinel (first stage), Payout Batcher, Coverage Resolver, Replenishment and Turnover Dispatcher are automations; Digest Writer, Ops Copilot, Discharge Summary Drafter, Radiology Report Drafter, Claims Drafter and Workflow Tuner are agents. The agentic claim rests on the T2 drafters, the Tuner and the runtime governance — never on autonomy in clinical actions. Where a rule is safer, cheaper and more auditable than a model, the rule wins.

**The roster (design series S8):**
- **T0:** Leakage Auditor (triangle, orphan offenders, variance patterns) · Fraud Sentinel (duplicate refunds, discount abuse, ghost patients, self-referral gaming) · Digest Writer (owner's 8 a.m. digest + weekly rollups) · Ops Copilot (operational Q&A chatbot with the asker's own permissions)
- **T1:** SLA Chaser (active-alert breaches → on-duty nudges + ladders) · Recall & Follow-up Agent (no-shows, missed sessions, review dates, vaccinations, re-collections, critical-result contact orchestration) · Expiry Watchman (batches, credentials, rate contracts, AMC)
- **T2:** Discharge Summary Drafter (§11.2) · Radiology Report Drafter (PACS phase) · Claims Drafter (TPA phase) · **Workflow Tuner** — drafts workflow-definition changes from observed baselines; activation only by the owner per §10.4 (the fabric self-improves under governance)
- **T3:** Payout Batcher (statements → dispute window → NEFT batch behind approval) · Coverage Resolver (roster-gap fixes, duty manager approves)
- **T4:** Replenishment Agent (par-level indent drafting; POs above threshold still approved) · Turnover Dispatcher (bed-turnover dispatch and re-dispatch)

**Uniform guardrails:** first-class actor identity with own RBAC (§14) · API-only, never the database · **fail-open** — an agent erroring or offline never blocks a human flow; every agent task has a manual path · **per-agent kill switch**, instant, itself evented · tier promotions require owner approval · **global halt (v4.6)** — one flag pauses every agent and automation, itself evented · **draft provenance (v4.6)** — every model-produced draft stamps model id, prompt version, input hash and output hash into its event and into the signed document, so the signed artefact proves what the human changed · **API-only and fail-open are lint-enforced (v4.6)**, not conventions — nothing under the agent runtime imports the database layer; no human path imports or awaits the agent runtime.

**Phased rollout — agents ship with the modules that feed them:** Phase 1 (v4.6): **Plan 12a** = the runtime + two proofs on one harness — Digest Writer (agent) and Leakage Auditor (automation); SLA Chaser is Plan 08.5's escalation delivery + Plan 10's channels, not a separate build; Fraud Sentinel and Recall (OPD scope) follow in **12b**; **Ops Copilot and generic summarisation are out of Phase 1** (no state to query yet — revisit after the resource registry) · Pharmacy: Replenishment, Expiry Watchman · Payouts pack: Payout Batcher · IPD: Discharge Drafter, Turnover Dispatcher, Coverage Resolver · PACS: Radiology Drafter · TPA: Claims Drafter · Workflow Tuner: after 90 days of live baselines. Models can change or fail with zero risk to clinical operations.

## 17. Rollout Roadmap

**Gate: the 9-session design series is COMPLETE (2026-08-11).** S1 fabric ✅ · S2 patient journeys ✅ (13 exception maps + stress passes 1–2) · S3 clinical ordering ✅ (§11.6–11.9) · S4 materials/supply ✅ (§11.10) · S5 money flows ✅ (§11.11) · S6 people/tasks ✅ (§11.12) · S7 communication matrix ✅ (§11.13) · S8 agent roster ✅ (§16; stress pass 3 §11.14) · S9 ✅ — floor pressure-tests (ICU §11.15, OT §11.16, maternity §11.17), whole-hospital sweep + ward-room model (§11.18), coverage matrix (§11.19). Extended: building reconciliation + service lines ✅ (§11.19-A) · final sweep ✅ (§11.19-B) · **S10 staffing & KPI book ✅** · stress passes 6/7/8 — three adversarial swarms, 125 verified fixes folded ✅ (§11.19-C/D/E) · **swarm phase declared CONVERGED and closed** (§11.20). ~330-event reconciled catalog. **Remaining before implementation planning: the owner's independent stress-test rounds over the written specs, and approval of the Flow Atlas visualization.** **2026-08-20 architecture review (v4.6):** swarm passes stay closed; the Phase-1 plan order is re-sequenced in the roadmap (**08 → 08.5 runtime loop → 10 → 11 → 09 → 12a → 13 resource registry → stage 2**); the worker process of §2 v4.3 ships in Plan 08.5, not Plan 11 — the built system's reactive half switches on there.

1. **Foundation + Registration/OPD/Billing (expanded scope §7–§11)** — go-live on current 100-OPD workload; WhatsApp/SMS confirmations included.
   *Fast follows:* queue/token displays with audio calling; desk-to-desk patient handoff.
2. **Pharmacy + inventory + procurement.**
   *Fast follows:* **Payouts pack** (statements, PAN/TDS, payout batches, Tally export — within ~2 months of go-live) · **Quality/NABH pack** (incident reporting, biomedical AMC/calibration, indicator dashboards — NABH work already underway).
3. **Lab/LIMS + lab edge agent** + barcode sample labels + health checkup packages.
4. **IPD cluster, staged:** (a) beds/admission/wristbands/nursing/eMAR, MRD + discharge cascade; (b) ED (per §11.3) + OT + CSSD; (c) **blood bank module — digitizes the already-licensed operation**; (d) support services (diet/kitchen, housekeeping, ambulance, mortuary, visitor/attendant passes).
5. **PACS / radiology.**
6. **TPA / PMJAY / claims desk** (+ NHCX when approvals land).
7. **ICU telemetry** (+ utility/oxygen sensor telemetry).
8. **Service-line modules** — cath lab, oncology (incl. RT vendor-system integration), dialysis, endoscopy, trauma registry, physiotherapy: sequenced by each floor's commissioning date (mechanisms locked in §11.19-A; per-module specs at commissioning).
9. **Full CRM / engagement** (campaigns, camps, feedback/grievance, IVR, teleconsult).
10. **ABDM wiring as approvals land; agentic layer deepens throughout (§16 tiers).**

## 18. Testing Strategy

- TDD per module; integration tests on every event flow.
- **Golden suite for billing/GST:** worked examples with exact expected invoices — adjustment contests (membership vs coupon vs discount), split tenders, refunds, accrual/reversal pairs, package in/out routing, payer-period splits, tariff-lock behavior.
- **Workflow-definition tests (v3):** every definition validates (no dangling states, every branch reaches a terminal state); event-contract tests pin catalog names + payload shapes.
- Load tests at 3× the 2,000-OPD/day target before IPD go-live.
- Standing drills as tests: weekly automated backup-restore; quarterly downtime drill; disaster-mode drill with reconciliation check.

## 19. Deferred Decisions (resolved at module-spec time)

- WhatsApp Business API / SMS / IVR provider selection (gateway module spec).
- ABDM sandbox registration timing and milestone sequencing.
- Analyzer models and protocols (lab spec); ICU monitor vendors (ICU spec).
- Exact server SKUs and vendor quotes (procurement, per §13).
- **GST treatment of membership card sales** (CA ruling before go-live; engine handles either answer).
- **TDS sections/rates for referral and fee-split payouts** (CA, at Payouts-pack spec).
- Exact membership tier pricing/benefits; deposit schedules; SLA thresholds; follow-up windows — all business configuration, not code.
- IP-PBX vendor/model; oxygen sensor vendor.
- Blood bank module detail (digitizing the existing licensed operation — at IPD-cluster spec time).
- LINAC/R&V/TPS vendor selection (data-export mandate applies; drives the RT integration spec) and AERB licensing timeline.
- Service-line module sequencing (per floor commissioning dates, §17 step 8).
- **HARD PRE-GO-LIVE GATE: legal-counsel review of referral-payout classes** (external-RMP payouts stay structurally OFF until a documented decision is on file — §11.19-C fix 1).
- **CA confirmation of cash-law thresholds** (269ST episode aggregation, 40A(3) vendor/day cap — configuration values, §11.19-C fix 2).
- NPPA/DPCO ceiling-list maintenance procedure (gazette-revision watch — §11.19-C fix 3).
- **PRE-GO-LIVE GATES from pass 7 (§11.19-D):** AI inference locus decision + DPIA (fix 44) · initial-config validation report (fix 17) · legal delegation instrument + continuity kit sealed (fixes 10/12) · GST exemption-boundary configuration signed by CA (fix 3) · FY cut-off treatment agreed with CA (fix 4).
- **PRE-IPD-GO-LIVE GATES:** pre-auth sanction object live (fix 6) · guardianship model in patient master (fix 31 — Phase 1 actually) · nursing scales in charting (fix 38).
- **PRE-GO-LIVE GATES from pass 8 (§11.19-E):** public read-only surface decision — DMZ vs cloud relay (E-1) · at-rest encryption provisioned at build (E-2) · electronic-register legality opinion per act (E-21) · internal-auditor appointment (E-17) · transition-operations boundary map for the two-system period (E-11).
- **(v4.6) Clinical knowledge sourcing — before the pharmacy spec:** drug & interaction database licence (the §11.8 hard-stop/warning tiers), terminology (SNOMED CT via NRCeS, LOINC, ICD-10), pediatric dose-range reference, IDSP/IHIP notifiable lists; budget line in §13; procurement + clinical governance, not code.
- **(v4.6) PRE-12a GATES:** DPIA artefact (fix 42) + inference-locus decision (fix 44) before any agent activation · ~~**PRE-PLAN-11 GATE:** deployment topology + second server in a different fire zone (§12)~~ **— RESOLVED 2026-08-22 by owner ruling (§1 v4.7): staged deployment, cloud single-server at stage 1, so Plan 11 is no longer blocked. The second server moves to STAGE 2 with the hybrid step. NEW GATE IN ITS PLACE — **PRE-PILOT (stage 2, secondary-HMIS beside the incumbent): a DPDP posture for real patient data on a cloud host outside India**, plus E-11's transition-operations boundary map, which the two-system period now definitely needs. · **PRE-STAGE-2 GATE:** kernel resource registry (Plan 13) before pharmacy/lab; hard gate before IPD.
