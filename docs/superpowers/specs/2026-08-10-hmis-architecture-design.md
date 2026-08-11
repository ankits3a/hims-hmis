# HMIS Platform Architecture — Design Spec

- **Date:** 2026-08-10, updated 2026-08-11 (v3 — Hospital Operating Fabric + patient-journey designs folded in)
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
- India compliance stack: GST-correct billing from day one; **ABDM-ready data model from day one, actual ABDM/NHCX wiring after external approvals land** (go-live never blocks on approval timelines). NABH accreditation work already underway → Quality pack lands early (§17). TPA/PMJAY handled as payers on the standard billing model when those desks open.

## 2. Architecture Decision

**Hybrid: modular monolith core + edge services at hardware/physics boundaries.**

- The core — all administrative, clinical-record, and financial workflow — is one TypeScript application over one PostgreSQL database. ACID transactions guarantee financial and narcotics audit integrity; modules share data instantly without network calls.
- Edge services exist only where a protocol or data-physics boundary forces them: lab analyzers (serial/USB/ASTM), ICU telemetry (per-second streams that must not load the transactional DB), and DICOM imaging (bulk storage). Each edge service can crash without taking the hospital down, and the core can restart without losing edge data (edges buffer locally).
- **Rule for all future work: a new module goes in the monolith by default; it becomes a service only if hardware or data physics demands it.** No message broker, no service mesh, no per-module databases in the core.

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
| Jobs/queues | pg-boss | Postgres-backed jobs; no Redis to run/fail over. Add Redis only if measurement demands |
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

The catalog grows in design sessions S4–S8; grammar and envelope are the stable contract.

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

## 12. Failover, Backups, Data Portability

- **Two servers, scripted promotion.** Primary runs the full stack; standby receives every transaction via streaming replication (near-zero RPO). Failover = one scripted command; target RTO under 15 minutes; deliberately manual-trigger with a printed runbook. Monitoring alerts the owner via WhatsApp/SMS. The downtime protocol (§11.4 map 1) covers the promotion window operationally.
- **Backups assume the server room burns down — or is ransomed.** pgBackRest continuous WAL archiving + nightly fulls to a NAS outside the server room; **weekly encrypted offsite copy on immutable/air-gapped media** (a permanently-connected replica can be encrypted along with the primary — the offline copy is the ransomware answer). **Automated weekly restore drill.** Orthanc image store syncs nightly to the NAS. Cyber-incident protocol incl. CERT-In 6-hour reporting: §11.14.
- **Portability:** Postgres open format; FHIR-shaped documents; DICOM portable by definition; one-click per-module CSV/JSON export. No lock-in, including to this software.

## 13. Hardware Plan (rough 2026 INR)

| Item | Spec sketch | Rough cost |
|---|---|---|
| **Phase 1 — before OPD go-live** | | **~₹11–15L** |
| Primary server | 32-core, 128 GB ECC, 2×3.84 TB NVMe RAID-1, HDD bays | ₹4.5–6L |
| Backup NAS (outside server room) | 8-bay, 4×12 TB | ₹2–3L |
| 2× online UPS 3 kVA + rack basics | | ₹1.5–2L |
| Lab edge mini-PCs ×2 (fanless) | | ₹30–40k |
| USB barcode/QR scanners (~10 desks) + label printing | | ₹25–35k |
| IP-PBX + 30–50 IP phones (bought infra) | | ₹1–2L |
| Queue displays ×2–3 (43" TVs + player) — fast-follow | | ₹60–90k |
| **Phase 2 — before IPD/ICU go-live** | | **~₹7–9L** |
| Standby server | Similar, slightly smaller | ₹4–5L |
| PACS storage expansion, MQTT broker box, switches | | ₹2–3L |
| Wristband printers (per ward station) | | ₹25–40k each |
| Oxygen tank/pipeline level sensors + gateway | | ₹50–80k |
| ICU floor (45 beds, phased): per-hall vendor CMS w/ HL7 export | Buy bundled with monitors — mandate data export in purchase specs | Priced with monitor procurement |
| ICU integration: hall feeds → MQTT gateway + station terminals | | ₹1.5–2.5L |

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

**The roster (design series S8):**
- **T0:** Leakage Auditor (triangle, orphan offenders, variance patterns) · Fraud Sentinel (duplicate refunds, discount abuse, ghost patients, self-referral gaming) · Digest Writer (owner's 8 a.m. digest + weekly rollups) · Ops Copilot (operational Q&A chatbot with the asker's own permissions)
- **T1:** SLA Chaser (active-alert breaches → on-duty nudges + ladders) · Recall & Follow-up Agent (no-shows, missed sessions, review dates, vaccinations, re-collections, critical-result contact orchestration) · Expiry Watchman (batches, credentials, rate contracts, AMC)
- **T2:** Discharge Summary Drafter (§11.2) · Radiology Report Drafter (PACS phase) · Claims Drafter (TPA phase) · **Workflow Tuner** — drafts workflow-definition changes from observed baselines; activation only by the owner per §10.4 (the fabric self-improves under governance)
- **T3:** Payout Batcher (statements → dispute window → NEFT batch behind approval) · Coverage Resolver (roster-gap fixes, duty manager approves)
- **T4:** Replenishment Agent (par-level indent drafting; POs above threshold still approved) · Turnover Dispatcher (bed-turnover dispatch and re-dispatch)

**Uniform guardrails:** first-class actor identity with own RBAC (§14) · API-only, never the database · **fail-open** — an agent erroring or offline never blocks a human flow; every agent task has a manual path · **per-agent kill switch**, instant, itself evented · tier promotions require owner approval.

**Phased rollout — agents ship with the modules that feed them:** Phase 1: Digest Writer, SLA Chaser, Leakage Auditor, Fraud Sentinel, Recall (OPD scope), Ops Copilot · Pharmacy: Replenishment, Expiry Watchman · Payouts pack: Payout Batcher · IPD: Discharge Drafter, Turnover Dispatcher, Coverage Resolver · PACS: Radiology Drafter · TPA: Claims Drafter · Workflow Tuner: after 90 days of live baselines. Models can change or fail with zero risk to clinical operations.

## 17. Rollout Roadmap

**Gate (2026-08-11): the 9-session design series must complete before Phase 1 implementation planning begins.** Status: S1 fabric ✅ · S2 patient journeys ✅ (13 exception maps + stress passes 1–2) · S3 clinical ordering ✅ (§11.6–11.9) · S4 materials/supply ✅ (§11.10) · S5 money flows ✅ (§11.11) · S6 people/tasks ✅ (§11.12) · S7 communication matrix ✅ (§11.13) · S8 agent roster ✅ (§16; stress pass 3 in §11.14) · S9 coverage matrix — pending. The owner will additionally run their own stress-test rounds over all locked decisions before any implementation plan is written.

1. **Foundation + Registration/OPD/Billing (expanded scope §7–§11)** — go-live on current 100-OPD workload; WhatsApp/SMS confirmations included.
   *Fast follows:* queue/token displays with audio calling; desk-to-desk patient handoff.
2. **Pharmacy + inventory + procurement.**
   *Fast follows:* **Payouts pack** (statements, PAN/TDS, payout batches, Tally export — within ~2 months of go-live) · **Quality/NABH pack** (incident reporting, biomedical AMC/calibration, indicator dashboards — NABH work already underway).
3. **Lab/LIMS + lab edge agent** + barcode sample labels + health checkup packages.
4. **IPD cluster, staged:** (a) beds/admission/wristbands/nursing/eMAR, MRD + discharge cascade; (b) ED (per §11.3) + OT + CSSD; (c) **blood bank module — digitizes the already-licensed operation**; (d) support services (diet/kitchen, housekeeping, ambulance, mortuary, visitor/attendant passes).
5. **PACS / radiology.**
6. **TPA / PMJAY / claims desk** (+ NHCX when approvals land).
7. **ICU telemetry** (+ utility/oxygen sensor telemetry).
8. **Full CRM / engagement** (campaigns, camps, feedback/grievance, IVR, teleconsult).
9. **ABDM wiring as approvals land; agentic layer deepens throughout (§16 tiers).**

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
