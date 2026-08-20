# INDEPENDENT ADVERSARIAL REVIEW — HMIS Hospital OS architecture audit

You are reviewing a strategic architecture audit that was performed on 2026-08-20 by another
model (Claude Opus 5) against a real, in-progress codebase. Your job is to **adjudicate that
audit** — confirm it, correct it, or overturn it — and then answer one decision the owner has
to make this week.

**The audit is an input to be tested, not a conclusion to be confirmed.** If you agree with
every claim in it, you have probably not done the work. Do not manufacture disagreement
either — an honest "this is right and here is the strongest counterargument I could not
sustain" is a valid outcome for any individual claim.

---

## 0. HOW TO USE THIS DOCUMENT

There are two modes. Say which one you are in at the top of your answer.

**Mode A — you have the repository.** Working directory `C:\Users\ankit\hmis`, branch `main`,
audit performed at commit `ce8b6e7`. Every factual claim below carries a repro command.
**Re-run them.** Do not take the numbers on trust; the whole point of a second opinion is that
it is independent. Read the files listed in §6 yourself before ruling on anything.

**Mode B — you do not have the repository.** Then every number in §3 is a *reported*
measurement you cannot verify. Say so explicitly, treat §3 as testimony, and confine your
review to the reasoning built on top of it (§4, §5) — which is where the real disagreement
lives anyway. Flag any conclusion that would flip if a reported number were wrong.

The full audit report is published here and you may fetch it for the complete argument and
its scoring tables (optional — this document is self-contained):
https://claude.ai/code/artifact/93f46b48-8c2a-418c-84c9-55fa4a5ed2cc

---

## 1. THE PROJECT — ground truth

A greenfield hospital platform for a real Indian hospital, built from scratch.

**Who is building it.** The hospital's owner, solo. They are not a professional developer and
have no engineering staff; they build and maintain the entire system by directing AI coding
agents. This is not a hobby constraint — it is the reason the architecture was deliberately
chosen to be boring, consolidated and heavily documented (it drove the modular-monolith
decision). Engage the owner as an informed architect: they proposed the hybrid core+edge
design themselves. Their stated priorities, in order: user experience, module-to-module
information sync, medical device integration, data portability, fast server-failure recovery.

**Stated ambition.** "The world's first agentic AI hospital operating system" — a system that
*runs* the hospital rather than recording what happened in it, with AI agents doing most of
the work and clinical staff supervising, approving and handling exceptions.

**Scale.** Today (Aug 2026): ~100 OPD/day, 10 beds, ~20 users. Target (~Aug 2027): 610 beds,
2,000+ OPD/day, 300 concurrent users, 24×7 emergency department, 10 operating theatres.
Multispecialty teaching hospital. Blood bank already licensed and operating. NABH
accreditation work already underway. Real floors include cancer (with radiation oncology /
LINAC), cardiac + cath lab, dialysis, endoscopy, trauma, maternity with NICU, 3-hall ICU.

**Stack (locked).** TypeScript monorepo (pnpm). NestJS 11 + PostgreSQL 16 + Drizzle ORM +
zod 4 + ULID + pg-boss + Jest. React 19 + Vite + Tailwind 4 + shadcn/ui + TanStack Query.
Docker Compose on Ubuntu, on-premises. Edge services only at hardware boundaries (lab
analyzer agent on a mini-PC, ICU telemetry via MQTT → TimescaleDB, Orthanc PACS).
Transactional-outbox event log is the sync spine. Rule: new modules go in the monolith by
default; a separate service only when hardware or data physics demands it.

**Method.** A 9-session design series produced a ~121 KB architecture spec (now v4.5) plus a
staffing/KPI book. Three adversarial "swarm" passes (48 + 67 + 50 agents, 34 analytical
lenses) folded 125 verified fixes and then formally declared convergence (genuine gaps went
3 → 8 → 3, severity declining). Phase 1 was then decomposed into a 12-plan series; each plan
is written to a very high fidelity, executed by an agent pipeline, and closed with a
committed gate report. A defect ledger (`EXECUTION-LESSONS.md`, 188 KB) records how the
*pipeline itself* fails and is binding reading before compiling any new pipeline.

**Where they are.** Plans 01–07 shipped with gate reports. Plan 08 (billing counter) in
flight. Plans 09–12 unwritten.

| Plan | Scope | Status |
|---|---|---|
| 01 | Foundation kernel — events, outbox, module registry, dispatcher, CI | shipped |
| 02 | Auth, RBAC, actor fabric (incl. agent identity) | shipped |
| 03 | Workflow engine | shipped |
| 04 | Approvals engine v1 | shipped |
| 05 | Patient master & registration | shipped |
| 06 (+06.1, 06.2) | Tariff, adjustments, GST + golden suite, two hardening rounds | shipped |
| 07 | OPD — encounters, appointments, queues, vitals | shipped |
| 08 | Billing counter — invoices, tenders, cashier sessions, refunds | in flight |
| 09 | Memberships, coupons, accrual ledger | not written |
| 10 | Notifications gateway + public read surface | not written |
| 11 | Deployment, DR, ops hardening (**registers all background schedulers**) | not written |
| 12 | Phase-1 agent fleet (**6 agents**) | not written |

**Rollout beyond Phase 1** (10 stages): pharmacy + procurement → lab/LIMS → IPD cluster
staged (beds/eMAR/MRD, then ED + OT + CSSD, then blood bank, then support services) → PACS →
TPA/claims → ICU telemetry → service lines → CRM → ABDM wiring, with the agentic layer
deepening throughout.

---

## 2. THE DESIGNED ARCHITECTURE — what the spec commits to

You need this to judge whether the *design* is OS-shaped, separately from whether the *build* is.

**Seven canonical patterns** claimed complete for this hospital's operations: P1 patient
journey · P2 order-to-result · P3 request-to-issue · P4 procure-to-pay · P5 task-and-track ·
P6 charge-to-cash · P7 notify-remind-escalate. Approvals and scheduling are overlays, not
patterns. **Leakage principle:** every item-movement event must terminate on a patient bill
or a named cost centre; leakage becomes a variance report, not a mystery.

**Workflow engine.** Every flow is a workflow *definition* — states, transitions, allowed
roles per transition, SLA per state, escalation ladder per SLA. Definitions are versioned
data in the database, not code. In-flight instances complete on the version they started on.
"Humans and agents execute the same definitions through the same APIs." Department heads and
AI agents may *draft* definition changes; activation always passes through the approvals
engine to the owner.

**SLA policy.** Every state carries an SLA; every breach is recorded from day one. Active
alerting at go-live is deliberately limited to OPD wait, ER triage, lab TAT and oxygen stock,
because alarm fatigue is the documented killer of hospital alerting. Coverage expands as real
baselines emerge.

**Event grammar.** `entity.verb_past`. Envelope: `event_id` (ULID) · `name` · `version` ·
`occurred_at` **and** `recorded_at` (deliberately distinct, so downtime backfill is honest) ·
`actor` (user | agent | system) · `patient_id?` · `encounter_id?` · `correlation_id`
(workflow instance) · `causation_id` · `module` · typed payload · `site_id`. Append-only,
written in the same transaction as the state change. Catalog: ~330 events reconciled.

**Agentic AI layer (spec §16).** Autonomy tiers T0 observe → T1 nudge → T2 draft for
sign-off → T3 act behind an approval gate → T4 autonomous. Operational domains may reach T4;
**clinical actions are capped at T2–T3 permanently — agents draft, doctors decide.** Roster
of 15 named agents: Leakage Auditor, Fraud Sentinel, Digest Writer, Ops Copilot (T0); SLA
Chaser, Recall & Follow-up, Expiry Watchman (T1); Discharge Summary Drafter, Radiology Report
Drafter, Claims Drafter, Workflow Tuner (T2); Payout Batcher, Coverage Resolver (T3);
Replenishment Agent, Turnover Dispatcher (T4). Uniform guardrails: first-class actor identity
with its own RBAC · **API-only, never the database** · **fail-open** (an agent erroring or
offline never blocks a human flow; every agent task has a manual path) · per-agent kill
switch, instant, itself evented · tier promotions require owner approval. Agents ship with
the modules that feed them.

**Failure posture.** Downtime mode, degraded-tender mode, entered-in-error grammar,
break-glass access, two-key emergency path, owner-incapacity protocol, weekly automated
restore drills, two servers with streaming replication and scripted manual promotion,
RTO < 15 min.

---

## 3. WHAT IS ACTUALLY BUILT — measured, with repro commands

Every row was measured from the working tree at commit `ce8b6e7`. In Mode A, re-run these.

| # | Measure | Value | Repro |
|---|---|---|---|
| F1 | TypeScript/TSX lines (prod + test) | 49,380 | `find apps packages -name '*.ts' -o -name '*.tsx' \| grep -v node_modules \| grep -v dist \| xargs wc -l \| tail -1` |
| F2 | Test cases / test files | 922 / 142 | `grep -rc "it(\|test(" apps packages --include=*.test.ts --include=*.test.tsx \| awk -F: '{s+=$2} END {print s, NR}'` |
| F3 | Database tables defined | 60 | `grep -rc "pgTable(" apps/core/src/kernel/db/schema/*.ts` |
| F4 | `appendEvent` call sites (production) | 77 | `grep -rn "appendEvent(" apps/core/src --include=*.ts \| grep -v '\.test\.' \| wc -l` |
| F5 | Event types defined in code | 61 | count `defineEvent(` across `src/*/events.ts` |
| F6 | Event catalog designed | ~330 | spec §10.6 |
| **F7** | **Production consumers of the event stream** | **0** | `grep -rn "runDispatchCycle\|bus.on(" apps/core/src --include=*.ts \| grep -v '\.test\.'` → only the kernel's own definitions; the only caller is `dispatcher.test.ts` |
| **F8** | **Background sweeps scheduled** | **0 of 5** | `grep -rn "pg-boss\|@Cron\|ScheduleModule" apps/core/src --include=*.ts \| grep -v '\.test\.'` → nothing. The five written-but-unscheduled sweeps are `runDispatchCycle`, `runDueTimers`, `sweepExpiredTempRoles`, `sweepGuardianMajority`, appointment no-show. Source comments say "Plan 11's pg-boss cron later." |
| F9 | Domain workflow definitions | 1 (`opd_visit`) | `grep -rn "defineWorkflow(" apps/core/src --include=*.ts \| grep -v '\.test\.'` (plus one kernel definition for the approvals flow) |
| F10 | `startInstance` call sites in modules | 2 | `grep -rn "startInstance" apps/core/src/modules/` |
| **F11** | **Places an agent can act** | **0** | `grep -n "role_denied" apps/core/src/kernel/workflow/instances.ts` → `transition()` throws for every `actor.type === "agent"`, comment: "agent transitions arrive with Plan 12's agent grants". Agents also hold no permissions, so they cannot subscribe to any realtime topic. |
| F12 | Inference/LLM references anywhere | 0 | `grep -rin "InferenceClient\|openai\|anthropic\|\bLLM\b\|embedding" apps/core/src apps/web/src --include=*.ts --include=*.tsx` |
| F13 | References to bed / ward / occupancy / capacity | 1 | `grep -rin "\bbed\b" apps/core/src --include=*.ts \| grep -v '\.test\.'` |
| F14 | Spec + plan documents, total | ~2 MB | `find docs -name '*.md' \| xargs wc -c \| tail -1` |
| F15 | Largest plan documents | OPD 343 KB, Patient Master 306 KB, Billing 143 KB | `find docs/superpowers/plans -name '*.md' -exec wc -c {} \; \| sort -rn \| head` |

**What IS wired and working** (so the review is fair): the event log is appended inside the
caller's transaction with a full envelope and an idempotency table; the workflow engine
pins instances to definition versions, gates transitions by role, stores SLA timers as
database *rows* rather than `setTimeout` (explicitly so they survive restarts), and requires
two-key approval to activate a definition change; the approvals engine has cumulative
thresholds, separation-of-duties pairs, break-glass and temporary roles; an `agents` table
exists with hashed API keys and a per-agent kill switch; a WebSocket gateway fans out from a
per-process cursor tail over `events.seq` (never an in-memory emitter, so it is
multi-process-safe with no broker and no sticky sessions) and treats pushes as *hints* with a
15-second poll as the source of truth; patient master has merge/unmerge, guardians,
allergies, longitudinal identity; tariff is versioned with a GST golden suite.

---

## 4. THE AUDIT'S CLAIMS — adjudicate each one

These are numbered so you can rule on them individually. For each: **CONFIRMED / PARTLY /
OVERTURNED**, plus your reasoning and any evidence the original audit missed.

### Layer 1 — Inferences drawn from the facts

- **C1. The headline finding.** The event log has no consumers and nothing is scheduled,
  therefore the system is currently an *audit log*, not an event-driven system. Events are
  written and nothing reacts. The reactive half of the architecture is switched off.
- **C2. The consequence.** At go-live, SLA breaches will be recorded and never escalated —
  the OPD escalation ladder (supervisor at 15 min, duty manager at 30) exists in the database
  and in nobody's phone. Same for `vitals.danger_flagged`, which reaches no one not already
  looking at that screen.
- **C3. The ordering mistake.** The two capabilities that make this an operating system
  (schedulers = Plan 11, agents = Plan 12) are sequenced *last* in a 12-plan series, behind
  memberships and coupons. Roadmaps under pressure lose their tails; Plan 12 is where an
  agent fleet goes to be postponed indefinitely once the hospital is live.
- **C4. The second gap — no state model.** Every module reads its own transactional tables.
  Nothing anywhere answers "what is happening in this hospital right now?" Survivable at 100
  OPD/day with one clinical module; fatal at 610 beds, because every question worth asking is
  cross-domain (is this patient discharge-ready? can this surgery start? where is the
  bottleneck?). The specific predicted failure: the IPD plan invents its own bed-state table,
  the OT plan invents its own readiness flags, and the "command centre" becomes a reporting
  query joining eleven private schemas — i.e. a hospital OS quietly becomes an HIS with a
  dashboard.
- **C5. Verdict.** *"The direction is correct, but the operating-system layer is missing."*
  The substrate (transactional event log with causation, workflow-as-governed-versioned-data,
  first-class agent identity with kill switch, timers as rows) is genuinely rare and is the
  correct foundation. It is currently running as a conventional application.
- **C6. Scores.** True Hospital OS maturity **as built 30/100**, **as designed 72/100**.
  The 42-point spread is the finding. Maturity stage 2.5 of 7.
- **C7. The throughput risk exceeds the architecture risk.** Seven plans shipped, each with a
  100–340 KB plan document; OPD encounters received a *larger* plan than the billing counter.
  The owner's own token analysis found ~113k tokens of reading before a single agent starts a
  pipeline. At this fidelity, twelve plans buys OPD plus a counter, while eight more module
  clusters remain — several larger than everything built so far. "The architecture will not
  kill this project; the schedule will."
- **C8. On the benchmark itself.** The SuperOS public record is one launch article describing
  one deployed hospital in Bengaluru. It discloses no data model, no integration approach, no
  autonomy boundaries and no validation data; it labels drug-interaction checking and
  post-surgical wound monitoring as *beta with limited clinical testing*; it uses
  "orchestrates" and "agents" without technical definition. Therefore: architectural
  similarity scored 38/100 at low confidence, and the recommendation is **stop benchmarking
  against it** — one article is not enough signal to steer a two-year roadmap, and chasing a
  feature list is precisely how you arrive at "HIS with AI features."

### Layer 2 — Recommendations

- **R1. Reorder the plan series** from `08 → 09 → 10 → 11 → 12` to
  `08 → 08.5 → 10 → 12a → 10.5 → 09 → 11 → 12b`.
- **R2. New Plan 08.5 "The Runtime Loop" (P0).** One worker process registering the five
  already-written, already-tested sweeps; the first three production consumers on the
  subscription bus; retry, poison-message handling, loop observability. Argued to be the
  smallest plan in the series, and to deliver a real operational win at the *current* 100
  OPD/day scale (SLA escalation that actually fires), not a bet on 2028.
- **R3. Split Plan 12 into 12a and 12b.** 12a = agent runtime + permission grants + the
  workflow engine's agent seam (the `role_denied` throw becomes a real grant check, asserted
  by a test proving a human and an agent traverse the same definition) + a **tool catalog**
  (each callable declaring input, output, permission, approval requirement, audit record,
  failure behaviour) + the provider-agnostic `InferenceClient` + **exactly two agents**
  (Digest Writer T0, SLA Chaser T1). Rationale: two agents prove the runtime; six agents
  before the runtime is proven multiplies an unvalidated design by six.
- **R4. New Plan 10.5 "Hospital State Projection" (P0).** An event-fed read model holding
  current resource and journey state; scoped initially to what is already emitted (doctor-day,
  queue, room, encounter, cashier session); establishes the extension contract every later
  module follows. **Hard gate: ships before the IPD cluster begins.**
- **R5. Defer Plan 09** (memberships, coupons, accruals) by three slots — real revenue value,
  zero OS dependency, and the only Phase-1 plan nothing else waits on.
- **R6. New Phase-2 plan: Protocol & Rules Engine (P1).** Machine-readable clinical and
  operational rules — protocol → rule → patient context → event → evaluation → deviation →
  human review → audit trail. Deterministic first; AI only for judgements a rule cannot
  express. Substrate for both medication safety and continuous quality audit.
- **R7. Stop list.** (a) Further adversarial swarm passes on the spec — convergence is already
  declared and every further pass widens the design-to-build gap. (b) The Ops Copilot chatbot
  for now — an LLM box over tables is the exact "AI bolted on" antipattern and will
  underwhelm because there is no state to query. (c) Any command-centre dashboard before the
  projection exists. (d) Generic summarisation as a feature. (e) Applying billing-grade rigour
  uniformly — tier plan fidelity explicitly, with money/medication/identity earning golden
  suites and housekeeping/diet/visitor-passes not.
- **R8. Claimed differentiation** — not ambient AI or radiology models (commodity, buy them),
  but: the leakage principle as a continuously-audited financial-integrity claim; governance
  as a product feature (tiered autonomy with a CI-enforced permanent clinical cap, kill
  switches, causation-linked audit trail) in an Indian medico-legal environment; and
  continuous clinical quality audit for a NABH teaching hospital as a by-product of the event
  stream.
- **R9. The principle never to violate** (quoted from the owner's own spec, not invented):
  *agents act through the same permission-enforced APIs and workflow definitions as humans,
  never the database.*

---

## 5. THE STRONGEST COUNTERARGUMENTS — take these seriously

The original audit considered and rejected each of these. Test whether it was right to. If
any of them holds, say so plainly; the owner will act on your answer.

1. **"The loop deferral is correct, not a mistake."** There is nothing worth consuming yet.
   With OPD and billing as the only modules, the useful reactions are few, and Plan 11 is
   only weeks away. Building the worker now means maintaining it through five more plans of
   churn. YAGNI.
2. **"The state projection is premature abstraction."** Nobody knows the right shape of
   hospital state until IPD, OT and beds exist. Designing the projection against OPD-only
   events will produce the *wrong* contract, which every later module then inherits — a worse
   outcome than each module owning its state and consolidating once the requirements are real.
3. **"Two agents early is a distraction from go-live."** The hospital needs a working counter,
   not a daily digest. Every week spent on agent runtime is a week not spent on the thing that
   lets the hospital stop using its 15-year-old legacy system.
4. **"Design-heavy is correct for this builder."** A solo non-developer directing AI agents
   *should* over-specify, because a missed requirement costs a re-plan and the specs are the
   only durable memory across sessions. The 2 MB is an asset, not debt, and telling them to
   lower plan fidelity is telling them to remove their one working safety net.
5. **"30/100 is unfair scoring."** Scoring "as built" against a full-hospital-OS bar while
   only 7 of 12 Phase-1 plans of a 10-stage rollout are done measures progress-through-plan,
   not architectural correctness. A system 15% through its roadmap scoring 30% may in fact be
   *ahead*.
6. **"The audit under-weights clinical content."** No terminology services, no drug knowledge
   base, no care pathways, no formulary — and acquiring these is a long-lead procurement and
   licensing problem, not an engineering one. Arguably a bigger threat to the 2027 vision than
   the dispatch loop, and the audit ranked it P0 only inside the medication row.
7. **"Agents-as-cron-jobs is the whole roster."** If T0/T1 agents are correctly built as
   scheduled jobs, and clinical agents are permanently capped at drafting, then "agentic
   hospital OS" may be a branding claim over a well-governed automation platform — and the
   honest advice would be to drop the agentic framing rather than reorder a roadmap to chase it.

---

## 6. IF YOU HAVE THE REPOSITORY — read these before ruling

```
docs/superpowers/specs/2026-08-10-hmis-architecture-design.md   §10 (fabric), §16 (agents), §17 (rollout)
docs/superpowers/plans/2026-08-11-phase1-plan-series.md          the roadmap being challenged
docs/superpowers/plans/reports/EXECUTION-LESSONS.md              how the build pipeline itself fails
apps/core/src/kernel/events/{append,dispatcher,subscriptions}.ts the loop, and why it is inert
apps/core/src/kernel/workflow/{instances,timers,definitions}.ts  the engine; note the agent throw in instances.ts
apps/core/src/kernel/auth/agents.ts                              the entire agent identity implementation
apps/core/src/modules/opd/workflow-def.ts                        the one domain workflow that exists
apps/core/src/kernel/realtime/{gateway,tail}.ts                  fan-out design
README.md                                                        current shipped behaviour per module
```

---

## 7. WHAT I NEED FROM YOU

Answer in this order. Be specific and evidence-driven; cite files and line numbers where you
can. Prose over bullet-soup where the reasoning matters.

1. **Mode declaration** — A or B, and what you verified yourself.
2. **Factual audit.** Any number in §3 you found to be wrong, and what the correct value is.
   Explicitly list anything you could not verify.
3. **Ruling on C1–C8** — CONFIRMED / PARTLY / OVERTURNED, with reasoning. Be willing to
   overturn the headline.
4. **Ruling on the counterarguments in §5.** Which of the seven hold? For any that holds,
   what does it change?
5. **What the audit MISSED.** The most valuable section. What did a full read of the
   architecture surface that a one-session audit did not — risks, dependencies, sequencing
   traps, safety gaps, regulatory exposure (Indian context: DPDP Act, NABH, AERB for the
   LINAC, drug licensing, medico-legal accountability for AI-influenced decisions), or
   opportunities?
6. **Your own verdict**, using the same three sentences the audit had to choose between:
   *"You are building the wrong thing"* / *"The direction is correct, but the operating-system
   layer is missing"* / a reasoned statement that this is genuinely comparable in
   architectural ambition to an agentic hospital OS.
7. **Your own scores** — as-built and as-designed out of 100 — and where you differ from
   30/72 and why.
8. **The decision.** The owner must decide this week whether to reorder the plan series
   (R1–R5) before writing Plan 09. Answer directly: **reorder, do not reorder, or reorder
   differently** — and if differently, give the exact sequence with one line of justification
   per move.
9. **The single most important thing the owner should do next**, in one paragraph.

---

## 8. ANALYTICAL RULES

1. Architecture determines the answer, not branding and not ambition.
2. Do not confuse AI features with agentic architecture; automation with intelligence;
   dashboards with situational awareness; workflows with orchestration; data storage with
   patient context; an LLM chatbot with an agent.
3. Do not recommend an agent where a deterministic rules engine is safer, cheaper and more
   auditable. Say explicitly which of the 15 rostered agents should *not* be agents.
4. Do not recommend autonomous clinical action. The permanent T2–T3 clinical cap is a
   constraint to respect, not a limitation to solve.
5. Do not recommend technology because it is fashionable. Every technology you name must
   carry its architectural role and the specific failure it prevents.
6. Mark UNKNOWN rather than inventing — both for this codebase and for SuperOS. Do not
   attribute capabilities to SuperOS beyond the article's explicit claims.
7. Weight the constraint that one non-developer maintains this system. A recommendation that
   requires an engineering team is not a recommendation, it is a wish.
8. Optimise in this order: clinical safety, then operational leverage, then scalability, then
   AI autonomy — and autonomy only where it creates measurable value and can be governed.
9. Prefer "this is wrong because X, and here is what is right" over "consider also doing Y."
   The owner has more good ideas than build capacity; what they need is subtraction and
   sequencing, not addition.
