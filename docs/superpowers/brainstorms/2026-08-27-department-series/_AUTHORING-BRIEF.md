# Authoring brief — Department Brainstorm & Planning Series (2026-08-27)

You are writing ONE document of a series the hospital owner asked for overnight: "a detailed
brainstorming and planning document series" for every department/module not yet built, with
"edge cases considered, practical cases considered so that we could handle chaos easily",
staff KPI & KRA, AI agent / agentic-AI copilot placement, and the four qualities
**speed, accuracy, efficiency, auditable & compliant**. The owner explicitly said: go deep,
most edge cases. Depth is the deliverable. A thin document is a failed document.

## Ground truth you MUST read before writing (use sed -n / grep; do not read whole files)
Repo: /opt/hmis (read-only for you — do NOT edit, run tests, or commit anything in the repo).
- Architecture spec: `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md` (v4.8).
  Read §4–§10 (lines 93–232: module framework, stack, data spine, billing, approvals,
  module landscape, operating fabric P1–P7, workflow engine, SLA policy, event grammar +
  catalog), §14–§16 (lines 757–792: security, UX, agentic layer + tiers T0–T4 + roster +
  guardrails), and the §11 subsections relevant to your topic (headings via
  `grep -n '^### ' <spec>`; e.g. §11.6 lab, §11.7 imaging, §11.8 meds, §11.9 OT, §11.10
  materials, §11.11 money, §11.12 people & tasks, §11.13 communication, §11.14 codes &
  compliance, §11.15 ICU, §11.16 OT, §11.16-A mini-OT, §11.17 maternity, §11.18 ward-room,
  §11.19-A building/service lines, §11.19-C/D/E swarm fixes — grep these for your topic's
  keywords; they contain locked decisions you must NOT re-litigate, only extend).
- Staffing & KPI book (S10): `docs/superpowers/specs/2026-08-11-hmis-staffing-kpi-design.md`
  — read §1–§2 (operating models A1/A2/A3; KPI/KRA/OKR framework: event-derived,
  diagnostic never auto-punitive, load-normalized) and the role cards for your department.
- Clinical copilot design: `docs/superpowers/specs/2026-08-25-clinical-copilot-design.md`
  §0 and §2 (design laws, context lens, tokenization boundary, narrate-never-originate).
- Roadmap: `docs/superpowers/plans/2026-08-11-phase1-plan-series.md` — grep for your
  module (stage-2 acceleration section ~line 404 onward: Track A 14 procurement → 15
  mini-OT → 16 pharmacy → 17 LIMS → 18 radiology ∥ Track B 19 housekeeping/laundry/BMW;
  deferred design notes 1–5: override-mining, inbound staff channel, Journey Feed +
  Conversational Work Surface three lanes, graph lens, KPI formula registry).
- Plan 13 resource registry (what "resource" means; kinds): `docs/superpowers/plans/2026-08-26-phase1-13-resource-registry.md` — skim §1–§3.
- Format precedent for edge-case catalogues: `/opt/hmis-context/plan-09-brainstorm-2026-08-25.md` §4.
- What is built (Phase 1): kernel (events outbox, workflow engine, approvals, RBAC actor
  fabric, scheduler/worker, ops modes/downtime kit), patients, tariff/GST, OPD encounters,
  billing counter, notifications gateway (WhatsApp/SMS), memberships/coupons/accrual ledger,
  formulary + prescribing safety, global search/command palette, user admin. Stage 1 = ONE
  cloud VM; production currently in `commissioning` mode with ~100 OPD/day, 10 beds.
  Target ~Aug 2027: 610 beds, 2,000+ OPD/day, 24×7 ED, 10 OTs, 45 ICU beds.

## Non-negotiable design laws (do not violate; cite when you rely on them)
1. Modular monolith; a module = folder with own tables + manifest; cross-module access only via
   declared interfaces or events. New module only if it owns tables + workflow; commodity → buy.
2. Every SLA-bearing lifecycle is a **workflow definition** (versioned data), never a status
   column; states/transitions/roles/SLA/escalation ladder. Owner approves activation.
3. Events: `entity.verb_past`, full envelope (§10.5); append-only; same transaction.
   Reuse existing catalog names where they exist; propose NEW names explicitly marked NEW.
4. Every item movement terminates on a patient bill or a named cost center (leakage principle).
5. Billing append-only; charges accrue from module events; corrections are credit notes.
6. Agents: first-class actors with RBAC, API-only never DB, fail-open, per-agent kill switch,
   global halt, draft provenance stamps; tiers T0 observe → T1 nudge → T2 draft → T3 act behind
   approval → T4 autonomous; **clinical actions cap at T2–T3 forever**. Prefer a deterministic
   automation over an inference agent whenever a rule is safer/cheaper/more auditable.
   Inference locus: text is tokenised/de-identified before leaving; DPIA governs.
7. SLA structure everywhere, alerts selective (alarm fatigue is the killer).
8. Downtime posture: every flow has a paper/manual path with backfill (`occurred_at` ≠ `recorded_at`);
   floor-scoped degradation; agents never block a human path.
9. Compliance is Indian: NABH, Clinical Establishments Act, DPDP Act 2023, PCPNDT, MTP Act,
   BMW Rules 2016, NDPS, Drugs & Cosmetics Act/Schedule H/H1/X, NABL ISO 15189, AERB, Telemedicine
   Practice Guidelines 2020, ABDM/NHCX, GST/TDS/40A(3)/269ST, CERT-In, Medical Termination,
   Transplantation of Human Organs Act, POCSO, MLC. Cite the specific statute where relevant.
10. Owner's team norm: **exception-first**. "Consider what corporate hospitals in India practice"
    → propose corporate-standard defaults (configurable) rather than asking open questions.
    Decide judgment calls yourself; reserve owner rulings for genuinely owner-owned choices
    (money, legal exposure, policy, purchases).
11. KPIs: event-derived, diagnostic never auto-punitive, load-normalized; S10's KPI formula
    registry idea (metric id + formula + semver) is the target home.
12. UX law: role-based workspaces (queue/worklist, not menu trees); keyboard-first at desks;
    large touch targets on ward tablets; QR on every printed doc; Hindi/English; perf budgets.
13. Owner is a solo non-developer directing AI agents: designs must be boring, consolidated,
    heavily documented. Buy-not-build for commodity (PBX, Tally, HR/payroll SaaS, licensed
    clinical knowledge content, vendor CMS/PACS/R&V).

## Required document structure (use these exact H2 headings, numbered)
Front matter: title `# <NN> — <Module> — Brainstorm & Planning`, date 2026-08-27, status
"Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED", and a
5–10 line executive summary stating what this module is, what it is NOT, and its 3 hardest
problems.

## 1. Frame — what exists, what is locked, what this document adds
   Cite spec sections/plans by number. List locked decisions you inherit. State scope boundaries
   and neighbouring modules (who owns what table).
## 2. Actors, roles & role cards
   Every human role that touches the module (S10 card names where they exist; propose new cards
   where S10 lacks them), plus every agent/automation actor. Shifts, bundling, SoD hard pairs.
## 3. Core flows as workflow definitions
   For each lifecycle: states → transitions → allowed roles → SLA per state → escalation ladder;
   map to P1–P7 pattern; name events emitted/consumed (mark NEW). Include a text state diagram.
   Cover the happy path AND the standard corporate-hospital variants.
## 4. Data model sketch
   Tables the module owns (columns at sketch level), registry resource kinds it needs (Plan 13),
   FHIR resource shapes where clinical, statutory registers as first-class tables, retention.
## 5. Edge-case catalogue  (THE MEAT — minimum 80 numbered rows, grouped by theme)
   Each row: **ID · scenario (concrete, Indian-hospital-real) → required system behaviour →
   the test/assertion that proves it → owner ruling ref if any.** Themes must include at least:
   identity & wrong-patient · timing/concurrency/race · partial failure & downtime · money
   (billing, refunds, payer switches, packages, TPA) · consent/legal/MLC/minors/unconscious ·
   staff absence/overload/handover · equipment failure · data quality/late-arriving/backdated ·
   fraud/leakage/gaming · privacy/sealed records/VIP/staff-as-patient · language/literacy/
   accessibility · scale (100/day today → 2,000/day) · integration failures (device/vendor/ABDM).
## 6. Chaos scenarios — day-in-hell walkthroughs (minimum 6)
   Narrative, minute-by-minute where useful: e.g., mass-casualty arrival, server down mid-shift,
   key staff no-show, analyzer breakdown on a Monday, power+network loss, a VIP + MLC + fraud
   attempt in the same hour. For each: what the system does, what humans do, what the agents do,
   what the paper path is, how backfill reconciles, what the audit trail shows afterwards.
## 7. Compliance, audit & statutory surfaces
   Statutes, registers (as tables, not reports), retention periods, consent forms, who signs,
   what NABH asks to see, what an auditor/inspector walks in and demands. DPDP data classes.
## 8. Staff KPI & KRA
   Per role: 5–10 KPIs with event-derived formula, load normalisation, SLA link, and the
   diagnostic (non-punitive) reading; KRAs per role; gaming vectors and how the formula resists
   them; what the owner's 8 a.m. digest shows for this department.
## 9. AI agents & the copilot — where inference earns its place
   Per candidate: name · automation-vs-agent · tier (respect the clinical cap) · trigger/inputs ·
   output · human sign-off point · fail-open manual path · kill-switch scope · provenance ·
   eval/guardrail · DPIA data class · what phase it ships with. Include the three presentation
   lanes (hand-built screens / schema-generated worklists / conversational copilot) for this
   department's work, and the Journey Feed contributions. Be concrete about prompts' inputs.
## 10. Speed, accuracy, efficiency, auditability — the levers
   Concrete UX/mechanism levers (barcode/QR, keyboard flows, pre-filled forms, one-beep context,
   TAT clocks, worklists, mobile/tablet surfaces, printing, voice where lawful), measured targets.
## 11. Integrations, devices & dependencies
   Devices/vendors (with Indian market examples where useful), protocols (HL7 v2/ASTM/DICOM/
   MQTT/FHIR), the edge-service rule, dependency on other plans (numbers), events consumed.
## 12. Buy vs build, hardware & rough INR budget
## 13. Owner rulings needed (numbered O-1…; each with the default you recommend and why)
## 14. Plan sketch — how this becomes phase documents
   Proposed split into plans (with names/numbers consistent with the roadmap: 14 procurement,
   15 mini-OT, 16 pharmacy, 17 LIMS, 18 radiology, 19 housekeeping; propose 20+ for new ones),
   task list per plan at section level, sequencing/gates, what must be true before authoring,
   the negative-space question ("what absence is a signal here?") answered for this module,
   and the staff edge-case interview questions (10+) to ask the department head.
## 15. Open questions & risks (things you could not resolve from the specs)

## Style
- Markdown, dense, specific, no filler, no marketing. Tables for catalogues. British/Indian
  English is fine. Indian context throughout (₹, UHID, ABHA, TPA, PMJAY, MLC, GST).
- Target length: 25–45 KB of real content. Do not pad; do not truncate the edge-case catalogue
  to hit a length. If you find yourself under 80 edge rows, you have not thought hard enough:
  walk the flow once more as a night-shift nurse, once as a fraudster, once as an auditor,
  once as a patient who speaks only Bhojpuri, once as the server going down.
- Never invent that something is already built or ruled; say "proposed" / "recommended default".
- Write the file to the exact output path given to you. Your final message should be a
  5-line summary (path, byte size, edge-row count, agents proposed, rulings count).
