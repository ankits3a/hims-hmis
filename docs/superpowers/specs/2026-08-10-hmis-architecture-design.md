# HMIS Platform Architecture — Design Spec

- **Date:** 2026-08-10
- **Status:** Approved in brainstorming session; pending final written review
- **Scope:** Platform foundation + first module slice (Registration/OPD/Billing). Every later module (lab, pharmacy, IPD, PACS, TPA, ICU, CRM, AI) gets its own spec → plan → build cycle on top of this foundation.

## 1. Context & Goals

A new Indian hospital is replacing crk-hmis (a fork of `hmislk/hmis` — a Java EE / JSF / PrimeFaces monolith with server-rendered UI, no India-specific features, and structural lag from per-click server round-trips). The replacement is a greenfield build; crk-hmis holds no data worth migrating.

**Hospital profile:**
- Today: ~100 OPD visits/day, 10 beds, ~20 concurrent users.
- 1-year target: 610 beds, 2,000+ OPD visits/day, ~300 concurrent users, 24×7 emergency department, 10 operation theatres, full diagnostics + pathology labs.

**Priorities (in order):** user experience; information sync between modules; medical device integration; data portability; fast recovery from server failure; cheap addition of new modules.

**Constraints:**
- Built and maintained by the owner directing AI coding agents — no dedicated developer staff. Architecture must favor boring, consolidated, heavily-documented technology.
- Hosted on local (on-premises) servers. Patient care must never depend on internet connectivity.
- India compliance stack: GST-correct billing from day one; **ABDM-ready data model from day one, actual ABDM/NHCX wiring after external approvals land** (go-live never blocks on approval timelines). NABH traceability expectations built into the data layer. TPA/PMJAY handled as payers on the standard billing model when those desks open.

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
│  shared kernel: patient master, event log, auth/RBAC, GST engine,            │
│                 notifications gateway                                        │
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

EXTERNAL (only the core's gateway module talks to the internet)
  • WhatsApp / SMS / IVR providers
  • ABDM / NHCX / PMJAY (wired when approvals land)
```

## 4. Module Framework

- **A module is a folder** containing: its database tables (own schema; no other module may touch them), API routes, UI screens, event definitions, and a **manifest** declaring menu entries, permissions introduced, and event subscriptions. Adding a module = add folder + run migrations + register manifest. No infrastructure changes.
- **Modules communicate only two ways:** calling another module's declared interface (e.g., `patients.get(id)`), or consuming events. Cross-module table access is forbidden, enforced by lint rules.
- **Event log (transactional outbox) is the spine.** Every significant fact — patient registered, visit opened, prescription issued, payment received, sample collected, bed assigned — is written to an `events` table in the same transaction as the change. Consumers: other modules, WebSocket pushes, the WhatsApp/SMS queue, future ABDM care-context notifications, analytics. One mechanism supplies module sync, real-time UI, patient engagement, audit trail, and the integration surface.

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
- **Clinical timeline:** every interaction is an `encounter` (OPD, IPD, ER, teleconsult); orders (drugs, labs, imaging) and results hang off encounters. EMR views, MRD, discharge summaries, and ABDM care-contexts all derive from this one spine.
- **Clinical documents stored FHIR-shaped** (JSONB following FHIR resource structures for prescriptions, diagnostics, discharge summaries). ABDM/NHCX wiring later serializes what already exists.
- **Billing is double-entry and append-only.** Charges accrue from module events; invoices are immutable once issued; corrections are credit notes. Shared GST engine computes CGST/SGST, service-category rates, HSN codes at invoice time. TPA/PMJAY attach later as *payers* on the same invoice model — a claim is "who pays which lines."
- **Audit is structural:** event log + append-only financials + row-level `updated_by`/`updated_at` gives NABH-grade traceability without a separate audit subsystem.

## 7. Failover, Backups, Data Portability

- **Two servers, scripted promotion.** Primary runs the full stack; standby receives every transaction via streaming replication (seconds behind → near-zero RPO). Failover = one scripted command promoting the standby; target RTO under 15 minutes. Deliberately manual-trigger with a printed runbook — automatic failover risks split-brain a solo operator can't debug at 2 a.m. Monitoring alerts the owner via WhatsApp/SMS when the primary stops responding.
- **Backups assume the server room burns down.** pgBackRest continuous WAL archiving + nightly fulls to a NAS outside the server room; weekly encrypted copy to rotated external disk or cloud bucket. **Automated weekly restore drill** — backup restores to a test environment and runs sanity checks. Orthanc image store syncs nightly to the NAS.
- **Portability:** Postgres open format; FHIR-shaped clinical documents; DICOM images portable by definition; one-click per-module CSV/JSON export. Any future system can ingest this hospital's history — no lock-in, including to this software.

## 8. Hardware Plan (rough 2026 INR)

| Item | Spec sketch | Rough cost |
|---|---|---|
| **Phase 1 — before OPD go-live** | | **~₹9–12L** |
| Primary server | 32-core, 128 GB ECC, 2×3.84 TB NVMe RAID-1, HDD bays for images | ₹4.5–6L |
| Backup NAS (outside server room) | 8-bay, 4×12 TB | ₹2–3L |
| 2× online UPS 3 kVA + rack basics | | ₹1.5–2L |
| Lab edge mini-PCs ×2 (fanless) | | ₹30–40k |
| **Phase 2 — before IPD/ICU go-live** | | **~₹6–8L** |
| Standby server | Similar, slightly smaller | ₹4–5L |
| PACS storage expansion, MQTT broker box, switches | | ₹2–3L |

**Flag:** hospital-wide LAN for a 610-bed building (cabling, floor switches, WiFi APs, nurse-station terminals, tablets) is a separate fit-out project, typically ₹15–40L at that scale. This software rides on it but does not include it.

## 9. Security & Access Control

- Permissions are *action + scope* (own department / floor / hospital-wide); roles bundle permissions; users hold roles per department/floor. Floor and department management live in the security core, not a separate module.
- Second factor required for narcotics registers and financial overrides.
- **Break-glass:** ER staff can open any record instantly; the access is loudly logged and queued for review.
- Access logs + consent records align with the DPDP Act. All external traffic flows through the single gateway module.

## 10. UX Foundations (architectural, not cosmetic)

- Hard performance budgets enforced by tests: patient search < 300 ms; interactive response < 100 ms.
- Registration and billing counters are keyboard-first (full workflow without a mouse); ward tablets get large touch targets.
- Role-based workspaces: each role logs into their queue/worklist, not a menu tree.
- Hindi/English switchable from day one (i18n scaffolding in the foundation).
- Print output (prescriptions, GST invoices, lab reports) is a first-class design surface.

## 11. AI Layer

A separate service that is strictly a *client* of the platform: it reads through the same permission-enforced APIs and event log, never the database. Chatbot answers live operational questions with the asker's own permissions; agents draft discharge summaries, chase no-shows via WhatsApp, flag billing anomalies. Models can change or fail with zero risk to clinical operations.

## 12. Rollout Roadmap

1. **Foundation + Registration/OPD/Billing** — go-live on current 100-OPD workload; WhatsApp/SMS confirmations included
2. Pharmacy + inventory
3. Lab/LIMS + lab edge agent
4. IPD / beds / nursing / floor management
5. PACS / radiology
6. TPA / PMJAY / claims (+ NHCX)
7. ICU telemetry
8. Full CRM / IVR engagement
9. ABDM wiring as approvals land; AI capabilities layer in throughout

Each step is its own spec → plan → implementation cycle.

## 13. Testing Strategy

- TDD per module; integration tests on every event flow (registration → billing → notification).
- **Golden suite for billing/GST:** worked examples with exact expected invoices; any change that alters an invoice must update a golden file consciously.
- Load tests at 3× the 2,000-OPD/day target before IPD go-live.
- Automated weekly backup-restore drill (Section 7) counts as a standing test.

## 14. Deferred Decisions (resolved at module-spec time)

- WhatsApp Business API / SMS / IVR provider selection (gateway module spec).
- ABDM sandbox registration timing and milestone sequencing (compliance module spec).
- Analyzer models and their protocols (lab module spec — depends on purchased equipment).
- ICU monitor vendors and their export protocols (ICU module spec).
- Exact server SKUs and vendor quotes (procurement, guided by Section 8).
