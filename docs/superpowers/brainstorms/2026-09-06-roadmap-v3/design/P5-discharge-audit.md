# P5 — Operational & quality: Magic Discharge and the 100 % real-time audit

Read against `main-ro` @ `b04cbd9` (2026-09-06); paths repo-relative. Position as re-measured (CONTEXT.md:20; position-state §0): production has run `399f92c` (78 migrations, all 14 modules incl. `ot`) since 12:35 UTC today. Abbreviations: SPEC = `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md`; RM = `docs/superpowers/2026-09-06-ROADMAP-v2.md`; IDX = `docs/superpowers/brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md`; REG = `…/00-OWNER-RULINGS-REGISTER.md` (R-nnn at line 12+nnn); IPD = `…/17-ipd-adt-bed-mrd.md`; Q22 = `…/22-quality-nabh-incidents-infection-control-governance.md`; A12 = `…/12-agentic-copilot-layer.md`; PHY = `…/04-physiotherapy-session-departments.md`; K11 = `…/11-staff-kpi-kra-performance.md`; P15 = `docs/superpowers/plans/2026-08-28-phase1-15-mini-ot-daycare.md`; KD = `docs/superpowers/plans/2026-08-28-phase1-kernelD-document-chrome.md`; DPIA = `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md`; core = `apps/core/src`.

## 0. The mission sentence(s) this pillar serves, and the honest reconciliation with the spec

**5a. "Magic Discharge: instantly generate the summary on doctor confirmation and process departmental clearances automatically in the background."**
**5b. "100 % Case Real-Time Auditing: monitor and audit 100 % of patient interactions against clinical protocols in real time."**

1. **The cascade is already the spec's law** — SPEC:256: eight SLA-timed steps, fit-declared → out < 3 h, "summary drafted by AI (T2), doctor edits and signs". It is **Plan 44** (IDX:86: needs "41 live 30 d; 16 returns; 43b; R-190, R-192–R-195"); 41 is only *authored* week 7–9 and starts only if O1, Plan 20, the dues numbers and 11b land (RM:338,419-420). Nothing of it is in code: `fit_declared` has zero hits in `core` and `packages`; `report.signed` is not an event name (the only textual hit is a column read, `core/modules/radiology/read.ts:427`).
2. **"Doctor confirmation" is lawfully an RMO here.** R-192 (REG:204): RMO signs, consultant countersigns ≤ 24 h. Two clocks; the KPI set at IPD:438-440 names `fit_to_summary_signed` but no countersign clock — added here (D12).
3. **"Instantly" = pre-generation, and the template is the product.** IPD:596: provider latency 0.8–60 s, "the draft must be pre-generated at fit-declared"; IPD:241 D5: timeout → "summary editor opens with structured pre-fill … never blocks signing; test: drafter kill switch on → summary flow completes". The model half is a T2 agent (SPEC:785; cap SPEC:778) behind the 12a runtime ("No 12a agent runtime", RM:428), an undeclared `complete()` (`core/kernel/inference/types.ts:9-11`), R-126 (REG:138) and DPIA v0.2 (RM:405; DPIA:3 "0.2 DRAFT … not signed"). **Reconciled:** the fail-open path is the feature; the model draft is a layer behind four gates. Buy-not-build: the model is a provider behind one choke module; template, signature chain and fact sheet are ours.
4. **The design auto-*chases*; it never auto-*clears*.** IPD:99-112: each clearance is "a task with 60-min SLA, silence auto-escalates"; IPD:470: only drafting, coding, readiness prediction and forecasting use inference "and none acts". Automations around eight human confirmations: orders sweep, orphan check, MRD deficiency rules, T1 Clearance Chaser (IPD:460), T4 Turnover Dispatcher (IPD:458). **Reconciled:** "automatic" = opened, chased, escalated and *attributed* (hospital/payer/family/doctor, IPD:113,163) by rules; "cleared" = a named human within 60 min — except a zero-balance billing clearance and an empty sweep (D2).
5. **The only discharge in code is the day-care one, and it is G1 only.** `dischargeDaycare` (`core/modules/ot/recovery.ts:443-506`) refuses outside `discharge_ready` (:455-457), without a discharge-time escort verification after the last wheel-out (:462-475), with an unnamed ISBAR acknowledger (:478-480); releases the bay to cleaning (:483-487); emits `daycare.discharged{encounterId,patientId,bayResourceId,at}` (`core/modules/ot/events.ts:84-86`). Deployed (0035 ≤ 78) but: no `ot` rows in `standup:check` (`apps/core/scripts/standup-check.ts:128,210,322,361` — hospital, lab, pharmacy, radiology), no runbook (`docs/runbooks/` = four files, none OT), Class-B seeds "stay drafts" (RM:375; `apps/core/scripts/seed-ot.ts:64-73`), zero consumers of the event (grep outside `modules/ot` empty), no recall task although P15:339 promised "DD10 + follow-up recall task" and `markAbsconded`'s comment promises one (`recovery.ts:549`) while the body writes only an `ot_incidents` row (:573-577), and a conversion "handoff document" that is a bare ULID (`recovery.ts:525`). **So this quarter's buildable Magic Discharge is the day-care discharge finished, measured and rehearsed**; 44 inherits a measured seam.
6. **5b: the structural audit exists; the protocol audit does not.** SPEC:125 ("audit is structural"), SPEC:201-204 (§10.3: every state carries an SLA, every breach recorded), emitted by `runDueTimers` (`core/kernel/workflow/timers.ts:86,122`). Missing: any *reader* — `sla.breached` is referenced only by its definer (`core/kernel/workflow/events.ts:20-21`), its emitter (`timers.ts:13,122`, via the `slaBreached` symbol), a comment (`core/kernel/approvals/events.ts:6`) and two tests. Protocol-as-data, an evaluator and deviation tasks are **deferred design note 12** (`docs/superpowers/plans/2026-08-11-phase1-plan-series.md:463`; owner-ruled "log, don't schedule", :431) and Plan **28d** (Q22:537 as "22d", renumbered 28d at IDX:74) "only when machine-readable protocols exist", T2-capped review tasks (Q22:460; A12:393), not this quarter (RM:416). One brainstorm claim is false: Q22:125 says `audit.control_tested` "(exists)"; grep of `core` is empty.
7. **Reconciled 5b, three rungs:** (i) *read what is recorded* — a Class-0 daily fact sheet (DPIA:11 already fixes the shape: "SLA breach counts, orphan/variance summaries", aggregates only); (ii) *the gates already built are the first protocol set* — count refusals and overrides per gate per day, `no_data` never rendered as compliance. A gate that leaves no event is not audited: the AERB gate the roadmap calls live (RM:34) refuses `device_not_licensed` as a 403 code (`core/modules/aerb/errors.ts:19`) and `core/modules/aerb/events.ts` defines no refusal event — the first lint finding of E2-M3; (iii) *the evaluator* (28d) after an Expertise store (R-260), just-culture (R-240 — else a deviation register is a disciplinary tool, IDX:207 risk 13), a named reviewer via Plan 20, versioned rules with unit tests. "Real time" = the dispatcher's cycle — 2 s dispatch, 20 s timers by default (`core/kernel/config.ts:53-54`; `core/kernel/worker/jobs.ts:199-207`) — never in-transaction; a block is the module's own gate (D4). T0 report; T2-capped review tasks; never T3+.
8. **DPIA and the IPD gate.** The only inference here is the Drafter's model half (E4-M5). Everything else is deterministic; deviation tasks are staff behavioural data (DPIA:38) → an addendum before E5 pilots. The IPD gate binds E4 and nothing else.

## 1. Goals

| # | goal | north-star parameter | instrument | baseline today | target | reader |
|---|---|---|---|---|---|---|
| G1 | A discharge the hospital can perform, measured decision → door | `daycare_case` `discharge_ready → discharged` p50/p90 min (K11:459's `ops.discharge_ready_to_discharged_hours`, registered by 21 later — D17); `sla.breached{daycare_case, discharge_ready}` per week | `workflow_transitions{from_state,to_state,at}` (`core/kernel/db/schema/workflow.ts:67-80`); `events.occurred_at` (`schema/events.ts:28`); the 120-min ACTIVE SLA (`core/modules/ot/workflow-def.ts:29-31,88`) | not yet measurable: zero day-care cases on production (~500 events) | p90 ≤ 120 min over the first 20 real discharges; 0 breaches for a full week | OT in-charge; the fact sheet |
| G2 | Every breach recorded is read | days in the last 7 with `ops.fact_sheet_produced`; `sla.breached` rows > 24 h old absent from any sheet | `ops_fact_sheets` + event (E2) | 0 readers of `sla.breached` (§0.6) | 7/7 days; 0 unread | owner 07:00 IST; quality manager |
| G3 | The gates are the protocol — refusals and overrides are numbers | refusals/overrides per gate kind per day; gate kinds reporting `no_data`; authority refusals with no event twin | `PROTOCOL_GATE_EVENTS` (E2-M3) over events that exist: `gate.overridden`, `timeout.halted`, `count.mismatch`, `sod.violation_blocked`, `lab.sod_violation_blocked`, `lab.report_print_blocked`, `lab.tube_mismatch_flagged`, `imaging.critical_overdue`, `break_glass.used`, `emergency_elevation.used`, `prescription.issued.{allergy,interaction,duplicate}OverrideCount` (`core/modules/opd/events.ts:333,341-342`); plus the twins E2-M3 adds (`aerb.acquisition_refused`) | events deployed; never counted; ≥ 1 live gate un-evented | every registered gate on the sheet daily; a refusal event not on the list fails CI; 0 un-evented authority refusals | quality manager; 28d |
| G4 | IPD Magic Discharge under two clocks | `fit_declared → patient.discharged` p50 hospital-attributed; countersign ≤ 24 h share | 44's definition transitions; `sla.breached{summary_countersign_pending}` | not measurable — no IPD, no `fit_declared` | p50 < 3 h (SPEC:256) over 50; countersign ≥ 95 %; before-11 *reported* at 60 % by month 6, never gated (R-190, REG:202) | discharge coordinator; RMO |
| G5 | Deviations are review tasks with a named reviewer | rules with a version id; deviation tasks opened/closed per day; rules auto-demoted; deviations with `fallbackExhausted` | `protocol_rules`, `protocol.deviation_flagged`, approval instances (E5); `escalation.triggered.fallbackExhausted` (`timers.ts:150-165`) | 0 rules, 0 evaluator | 5 clinical rules in shadow 30 d; reviewer named 100 %; closure ≤ 72 h p90 | quality manager; DTC |

## 2. Epics

### P5-discharge-audit-E1 — 15e: the day-care discharge follow-through
- **Plan home:** `15e`, a free letter in Plan 15 — 15b (MTP/PCPNDT/FP/MLC), 15c (CSSD), 15d (theatre bands) are claimed by Plan 15's split (P15:44,184; `core/kernel/db/schema/ot.ts:87-88`); `15e` absent from `docs/superpowers` (grep). Letter-in-block.
- **Goal:** the deployed day-care discharge becomes one the hospital can open, print, follow up and measure (G1–G6 for the mini-OT), so 44 adopts a measured seam.
- **Exists:** `dischargeDaycare` and its refusals (`recovery.ts:443-506`); `evaluateDischargeReady` system move + late-cutoff *offer* (`recovery.ts:277-282`); `convertToAdmission`, `at` = billing boundary (`recovery.ts:509-545`); `markAbsconded` (`recovery.ts:552-582`); `daycare.discharged` (`ot/events.ts:84-86`); 120-min ACTIVE SLA (`workflow-def.ts:88`); print outbox, four OPD kinds, "a new document is a code change plus a template, never a migration" (`core/kernel/db/schema/printing.ts:42-46`); `enqueueNotification`, which validates the template key exists (`core/kernel/notify/enqueue.ts:68-73`; keys at `notify/templates.ts:52-165`); `notification.sent|failed|expired|suppressed` (`notify/events.ts`); `seed-ot` drafts (`seed-ot.ts:64-73`) and `ot_definitions_one_active_ux` (`schema/ot.ts:543`); `/ot/recovery` (`apps/web/src/router.tsx:233`); the census and its `NOT MODELLED` verdict (`standup-check.ts:23-75`).
- **Build:** the recall writer (SPEC:460 "missed follow-up = recall, never a no-show") at discharge and abscond, template key `daycare_followup`; `procedureClass`/`procedureCode` on `daycare.discharged` (additive, v2) so Plan 25 can key on it (PHY:90); outbox kinds `daycare_discharge_slip` (instructions, follow-up date, Hindi + English) and `daycare_conversion_handoff` (the body behind `handoffDocumentId`); `ot` rows in `standup:check`; `docs/runbooks/mini-ot-go-live.md` with a seat walk and a six-row harvest; the decision→door line on the fact sheet (E2).
- **Gates:** G1 done. G2: the MS publishes the DD6 drafts under single-approver honesty (R-247, RM:183-191; P15:201). G3: package tariff (placeholders on UAT; O6 for a live invoice, never the pilot — "discharge is never blocked on money", P15:172). G4: OT in-charge, recovery nurse, anaesthetist *named*. G5: runbook executed on UAT. No DPIA, no O1.
- **Tier:** recall = T1 automation (SPEC:784). No agent. **Deps:** 11i T3/T5 (UAT, week 2); FD-24 outbox (0069); the front-desk "printing v2" (RM:334) touches `kernel/printing/render.ts` — coordinate.

### P5-discharge-audit-E2 — 11l: the breach ledger and the daily fact sheet
- **Plan home:** `11l` — the 11 series is deployment and operability (RM:461-467); 11j (RM:469-470) and 11k (`…11i….md:411`) are taken; `11l` free (grep). Letter-in-block.
- **Goal:** 5b rungs (i)+(ii): every breach, escalation, orphan and gate refusal read within a day as one deterministic Class-0 object — the Digest Writer (12a) and Hermes (`digest.fact_sheet`, `/opt/hmis/docs/superpowers/brainstorms/2026-09-01-hermes-ops-copilot/00-BRAINSTORM.md:60,113`) narrate it later; HMIS writes no prose.
- **Exists:** `sla.breached`, `escalation.triggered{fallbackExhausted}` (`timers.ts:86-175`); `charge.orphan_flagged` from `orphanScan`, OPD consult fee only (`core/modules/billing/daily-close.ts:295-306`); `workflow_instances.state_entered_at` + `workflow_transitions` (`schema/workflow.ts:56,67-80`); `occurred_at`/`recorded_at` (`schema/events.ts:28-29`); the dispatcher and timer jobs (`jobs.ts:199-207`); the one-arithmetic rollup `user_day_facts` (`core/kernel/desk/rollup.ts:9-25`); `/ops/mode`, `/ops/downtime-kit` (`router.tsx:931-942`); `validate:config`'s report row + event (`apps/core/scripts/validate-config.ts:28-41`; `schema/ops.ts:79`); `notification.sent` (`notify/events.ts`); DPIA:11's sheet shape; the lab harvest as prose (`docs/runbooks/lab-go-live.md:207-218`).
- **Build:** `kernel/ops/fact-sheet.ts` `factSheetFor(day)` (the job stores what it returns) → `ops_fact_sheets{day, facts, input_event_watermark}` + `ops.fact_sheet_produced`; sections: breaches by defKey/state, escalations + `fallbackExhausted`, orphans, gate refusals/overrides (`PROTOCOL_GATE_EVENTS`), open critical calls at 07:00, late-entry share, agent share (`actor_type='agent'`, today 0), discharge decision→door, the lab/pharmacy/OT harvest rows; `/ops/fact-sheet` + `pnpm ops:fact-sheet <day>`; delivery via the notify gateway; a refusal-twin lint (every 403 authority code in a module's `errors.ts` names an event) and its first fix, `aerb.acquisition_refused` (one additive event, radiology lane); the orphan scan widened to lab/imaging/pharmacy as a new billing function.
- **Gates:** G1/G2 (the screen's permission ships with `check-config-present`, RM rule 4). Class 0: no patient identifier. No names, no DPIA. **Tier:** T0 automation. **Deps:** none hard; `kernel/ops` is everyone's (CLAUDE.md:38) — one lane.

### P5-discharge-audit-E3 — kernel-D `documents`: the signed clinical document, revived
- **Plan home:** KD (authored 2026-08-28, never built: no `documents` table, no `kernel/documents`, no commit). Existing.
- **Goal:** one document face for 44's signed summary, 45's MRD file and 15e's handoff — not a third and fourth bespoke face after FD-24's outbox and the lab's snapshots.
- **Exists:** DD1 a document is a row with `identity_snapshot` + `body` at issue (KD:92); DD7 clinical documents amend by reissue, money documents void by mark (KD:104); the failure it prevents (KD:40-46); `print_jobs` outbox (`schema/printing.ts:38-46`, 0069); the lab's versioned snapshots (`cfba8d5`).
- **Build:** `documents` table, reissue grammar, verification code + `GET /documents/verify/:code`, a renderer that takes a `documents` row and nothing else; outbox gains nullable `document_id`; two adopters. One additive migration at rebase.
- **Gates:** none legal; starts after the lab's G6 closes (RM §0c.5). **Tier:** none. **Deps:** printing v2; the lab lane as adopter.

### P5-discharge-audit-E4 — Plan 44: the IPD discharge cascade
- **Plan home:** `44` (IDX:86), IPD cluster. Existing.
- **Goal:** SPEC:256 in code: fit declared → sweep → nine parallel clearances → template summary signed under two clocks → final bill → gate pass → bed turnover; the model Drafter as a shadow layer last.
- **Exists:** the definition (IPD:97-113), sketched `ipd_discharges`/`ipd_clearances` (IPD:163), roster rows (IPD:458-470), KPI ids (IPD:438-442), D5 (IPD:241); the approvals engine and worklist (`core/kernel/approvals/flow.ts`, `worklist.ts`); the registry `onRelease` cascade 15 already uses (`recovery.ts:486`); timers and ladders (`timers.ts:86-175`).
- **Build:** `ipd_discharge` definition with `discharge_type`; clearances as approval instances `discharge_clearance.<dept>`, 60-min SLA + ladder (D1); orders sweep; template summary + `report.signed` + `summary_countersign_pending` (D12) on E3; final bill via Plan 08's dues path (R-195); pass issue/scan; bed release; Chaser as an SLA-ladder instance; sheet lines; Drafter shadow (T2) last.
- **Gates:** the IPD gate (O1; Plan 20; the five money ladders; 41 live 30 d); 16 returns for `pharmacy_returns` (absent in `core/modules/pharmacy` — `NOT MODELLED → runbook` until then); 43b for `death`; DPIA v0.2 + R-126 + 12a + `complete()` for M5 only.
- **Tier:** Chaser T1; Turnover Dispatcher T4 (ops, IPD:458); Drafter T2 (SPEC:778); Readiness Predictor T0 after 90 d (IPD:463), not in the first cut. **Deps:** 41, 20, E3, 16 returns, 43b.

### P5-discharge-audit-E5 — 28d: protocol adherence as data, evaluator, deviation review
- **Plan home:** `28d` (IDX:74; Q22:537). Existing.
- **Goal:** note 12 exactly: protocol → versioned rules → event → evaluation → deviation task with a named reviewer → resolution, every step evented; sampling audits the fallback.
- **Exists:** note 12 (`plan-series.md:463`); roster rows (A12:393; Q22:460); four module-private books — lab ranges/critical bands/reflex (`core/modules/lab/definitions.ts:22-24`), radiology `critical_categories` (`core/modules/radiology/chasers.ts:87-91`), `ot_definitions` (`schema/ot.ts:526-543`), formulary pairs (`core/modules/opd/rx-checks.ts:178-186`); versioned workflow definitions, in-flight instances complete on their version (SPEC:196-199); the dispatcher; E2's `PROTOCOL_GATE_EVENTS`.
- **Build:** `protocol_rules{id, module, version, kind: block|review, source, event_names, status: active|diagnostic}` seeded from existing gates with a lint; evaluator consumer → `protocol.deviation_flagged{ruleId, ruleVersion}` → review approval to a named reviewer; demotion rule; `no_protocol` coverage line; first five clinical rules through the Expertise store (R-260).
- **Gates:** R-240 signed (law); R-119 signed (owner's signature; IDX:207 risk 13); Plan 20 live; O1 for 28-G; the doc-11 registry shape frozen before 28a (Q22:541; `q_indicator_set` FKs `kpi_metric_versions`, Q22:167 — 28d keeps its own register, D14); DPIA staff-data addendum (DPIA:38) before pilot; the knowledge-sourcing ruling for M4. No inference (28e is separate).
- **Tier:** T0 evaluator; T2-capped review tasks; never a block, never a correction (Q22:460). **Deps:** E2-M3, Plan 20, the approvals engine (D1).

## 3. Milestones

### E1 — 15e
| id | name | gate | acceptance (parameter · instrument · threshold) | depends_on | size · human act |
|---|---|---|---|---|---|
| E1-M1 | The event carries the procedure; the recall has a writer | G1 | `daycare.discharged` has `procedureClass`+`procedureCode` · contract zod + consumer test · 100 %; one `notifications` row key `daycare_followup` per discharge and per abscond · fail-first test (0 rows today) · exactly 1 per encounter, idempotent on retry (the dedupe key, `enqueue.ts:66-67`); recall date = review date else day 7, next working day on holidays · unit test · 3 fixtures | — | 3 d · none |
| E1-M2 | Two papers in the outbox | G1 | renderer kinds · `render.ts` switch + parity test · 4 → 6; slip carries follow-up date, Hindi + English, digits unchanged · snapshot per language · 2; `handoffDocumentId` resolves to a `print_jobs` row · test on `convertToAdmission` · 100 % | E1-M1 | 4 d · none (coordinate printing v2) |
| E1-M3 | The OT census and the runbook | G2–G4 | `standup:check ot` · module keys 4 → 5 · ≥ 8 rows (definitions active, theatre + 2 bays, package tariff, `ot_incharge`/`recovery_nurse`/`anaesthetist` held, relay reachable); `docs/runbooks/mini-ot-go-live.md` · §Seat walk, §Harvest (6 rows: `discharge_ready` breaches, `escort_required` refusals, late-cutoff offers, `absconded` incidents, conversions without a printed handoff, `tariff_item_missing`), §Executed · exists, pinned by deploy-parity; active `ot_definitions` on UAT · `ot_definitions_one_active_ux` · ≥ 2 | — | 4 d · the MS publishes the drafts on UAT (R-247); the owner names three OT holders |
| E1-M4 | Rehearsed on UAT | G5 | one synthetic case `booked → discharged` in a browser by the OT in-charge · runbook `## Executed on UAT — <date>` · dated; decision→door for the walk · `workflow_transitions` · a number in the section; `standup:check ot` · exit code · 0 | E1-M1..M3; 11i T3/T5 | 2 d + one afternoon of the OT in-charge |
| E1-M5 | Piloted on production | G6 | first 20 real discharges · transitions · p90 ≤ 120 min; breaches · sheet · 0 for a full week; recalls · `notification.sent` per `daycare_followup` row · ≥ 95 %; harvest read · dated line per day · 7/7 | E1-M4; E2-M1 | 0 build · the owner's weekly deploy; OT in-charge reads the harvest; paper authoritative |

### E2 — 11l
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E2-M1 | `factSheetFor(day)`, table, job, event | G1 | rows · `ops_fact_sheets` · 1 per day, idempotent on re-run; sections · typed object · ≥ 9; empty day · fixture · every section `no_data`, never `0 = compliant`; breach `occurred_at` 23:59 IST, `recorded_at` 00:01 · watermark test · on the day it occurred, flagged late; patient identifiers · schema test · 0 | — | 4 d · none |
| E2-M2 | Read surfaces | G1–G2 | `/ops/fact-sheet` · `router.tsx` + `test/caddyfile-parity.test.ts` · +1; `ops.fact_sheet.read` present at deploy · `check-config-present` · green; `pnpm ops:fact-sheet <day>` · one-arithmetic test · same object as the screen | E2-M1 | 3 d · none |
| E2-M3 | The gates are the protocol | G1 | `PROTOCOL_GATE_EVENTS` · exported list + lint that a `defineEvent` matching `*.blocked|*.overridden|*.refused|*_flagged` off the list fails · ≥ 12 names, CI red on omission; authority refusals without an event twin · lint over each module's `errors.ts` 403 codes · 0 (today ≥ 1: `device_not_licensed`, `aerb/errors.ts:19`); `aerb.acquisition_refused` · defined + emitted on refusal · fail-first test; per-gate line · sheet · daily | E2-M1 | 3 d · none (radiology lane adds the one event) |
| E2-M4 | Delivered and read | G5-equivalent | delivery 07:00 IST · `notification.sent` for the sheet's row · 7/7; lab, pharmacy, OT harvest rows · sheet sections · present; a breach with no sheet line after 24 h · SQL · 0 | E2-M2 | 2 d · owner names the channel (email/in-app now; WhatsApp after WABA) |
| E2-M5 | The orphan scan widens | G1 | `charge.orphan_flagged.feeKind` · `opd_consult|lab|imaging|pharmacy` · one per encounter per kind, second run appends nothing; no orders on a day · fixture · `no_data` | E2-M1 | 3 d · none (billing: new function, no signature change, D16) |

### E3 — kernel-D
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E3-M1 | `documents` table and renderer contract | G1 | migration · `apps/core/drizzle` · +1 additive; reissue · test · version+1, `supersedes_id`, old row `superseded`; `GET /documents/verify/:code` · 100 % of issued, 0 % of revoked | lab G6 closed (dated) | 6 d · none |
| E3-M2 | Two adopters | G1 | lab print jobs with `document_id` on UAT · SQL · 100 %; 15e's `handoffDocumentId` · FK `documents.id` · every conversion | E3-M1; E1-M2 | 5 d · none |
| E3-M3 | Reissue walk rehearsed | G5 | an amended lab report reissued AMENDED in a browser · runbook §Executed · dated; old code · verify endpoint · `superseded` | E3-M2 | 1 d · the pathologist of record |

### E4 — Plan 44
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E4-M1 | Authored, gate conditions written as conditions | IPD gate | phase doc · `docs/superpowers/plans/…44…md` · exists; §2b rows · ≥ 24; each clearance names a role and a `NOT MODELLED → runbook` fallback · 9/9; money rows · §7 · each names R-nnn + the corporate default | 41 live 30 d; O1 | 5 d · O1 named; the five ladder numbers |
| E4-M2 | Cascade, clearances, sweep, template summary, two clocks (no inference) | G1–G4 on UAT | `fit_declared` opens 9 approval instances in one tx · test · 9; silence 60 min · `escalation.triggered` rung 1 · timer test; empty required section · completeness check · unsigned (IPD:438); RMO → `report.signed`; countersign · `summary_countersign_pending` 1440 min · breach attributed `doctor`; summary is a `documents` row · 100 % | E4-M1; E3; Plan 20 | 15 d · RMO + consultant named |
| E4-M3 | Final bill, dues, pass, bed | G1–G4 on UAT | final bill = charges − deposit − returns · composer test with a return · exact; dues · Plan 08 path (R-195) · no discharge blocked on money; `pass.issued`/`pass.scanned` · 1 each; bed `dirty → available` · registry · via `task.verified`; `pharmacy_returns` without 16 returns · census · `NOT MODELLED` | E4-M2; 16 returns | 10 d · money ladders ruled |
| E4-M4 | Rehearsed on UAT | G5 | one synthetic admission fit → exit in a browser, every clearance by its seat · runbook §Executed · dated, ≤ 3 h; hospital-attributed minutes · attributed durations · per hold | E4-M3 | 3 d · a morning of coordinator, RMO, nurse, billing, pharmacist |
| E4-M5 | The Drafter in shadow (T2) | DPIA v0.2; 12a; R-126 | draft at `fit_declared` · `draft.provenance` (model id/prompt/hashes) · 30 consecutive, p90 < 60 s before editor open; kill switch on · D5 test · flow completes; uncited claims dropped · renderer test · 100 %; draft→signed edit distance · hashes · recorded | E4-M4; 12a; `complete()`; DPIA v0.2 | 10 d · counsel signs DPIA v0.2 + addendum; owner promotes the tier (R-130) |
| E4-M6 | Piloted | G6 | fit → exit p50 hospital-attributed · sheet · < 3 h over 50; countersign ≤ 24 h · ≥ 95 %; clearance breaches by dept · read daily; before-11 share · reported, never gated | E4-M4 | 0 build · discharge coordinator named (IPD:46) |

### E5 — 28d
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E5-M1 | The register of the gates that exist | G1 | `protocol_rules` · seeded from `PROTOCOL_GATE_EVENTS` with a lint · ≥ 12, each with version + unit test; sheet cites rule ids · 100 % | E2-M3 | 5 d · none |
| E5-M2 | Evaluator → deviation → named reviewer (shadow) | G1–G4 | lag `recorded_at` → `protocol.deviation_flagged` · p90 < 5 min; reviewer named · approval holder · 100 %, `fallbackExhausted` 0; one patient-day reconstructed end-to-end · script · yes; clinical-record writes by the evaluator · test · 0 | E5-M1; Plan 20; R-240 | 10 d · just-culture signed |
| E5-M3 | Demotion and honesty | G1 | flag rate > 30 % over 7 d · demotion event + QM alert · automatic; conditions without a rule · `no_protocol` line · shown, never "compliant" | E5-M2 | 3 d · none |
| E5-M4 | First five clinical rules from a named source | G3 | rules with source citation, DTC signature, unit tests · 5; shadow · 30 d · precision reviewed by the DTC | E5-M3; R-260; sourcing ruling | 8 d · owner picks the source; DTC chairs named (R-243) |
| E5-M5 | Piloted | G6 | closure · ≤ 72 h p90; per-person aggregates · schema + test · none (R-119); DPIA staff-data addendum · signed | E5-M4 | 0 build · counsel addendum; QM reads daily |

## 4. Edge cases — the Indian day this pillar must survive

| # | the day | expected behaviour | artefact that proves it | milestone |
|---|---|---|---|---|
| 1 | Day-care patient scored ready 19:55 IST; the escort's phone is the patient's own | refuse `escort_required`; the 20:00 cutoff *offers* conversion, never performs it | refusal + no conversion event (`recovery.ts:277-282,462-475`) | E1-M4 |
| 2 | Ready patient sits in bay 2 for 3 h; the bill is not composed | `sla.breached` at 120 min; discharge never blocked on money (P15:172) | breach on the next sheet; decision→door > 120 counted | E1-M5 / E2-M1 |
| 3 | Discharge 21:30 Saturday; the day-7 review falls on a public holiday | one recall on the next working day; never two | `notifications` count = 1 per encounter | E1-M1 |
| 4 | Patient walks out while the nurse is at the counter | `absconded`; incident records whether an escort was verified **and** a recall is enqueued | `ot_incidents` + `notifications` (today: incident only, `recovery.ts:573-577`) | E1-M1 |
| 5 | Conversion to the incumbent IPD at 20:10; the ward wants paper | the handoff prints with the bill cut at `at` (R-3.6); the ULID at `recovery.ts:525` has a body | `print_jobs` kind `daycare_conversion_handoff` | E1-M2 |
| 6 | The attendant reads only Hindi | the slip carries Hindi beside English; digits the same in both scripts | snapshot per language | E1-M2 |
| 7 | The `ot` module is deployed; the MS never published the drafts | `standup:check ot` prints `ot_definitions_active` RED with the fixing screen; recovery screen refuses with the reason | census row + refusal | E1-M3 |
| 8 | 02:00, nobody holds `recovery_nurse`; the 120-min timer fires | ladder falls to `duty_manager`; `fallbackExhausted` recorded; G4 row RED next morning | `escalation.triggered{fallbackExhausted:true}` (`timers.ts:150-165`) + sheet | E1-M3 / E2-M1 |
| 9 | Holi: zero events all day | every section `no_data`; nothing reads as compliant | empty-day fixture | E2-M1 |
| 10 | A breach `occurred_at` 23:59:50 IST, recorded 00:00:10 | lands on the day it occurred; the late-entry share counts it | watermark test | E2-M1 |
| 11 | A lane ships a new `*.refused` event for a new gate | CI fails until the name is on `PROTOCOL_GATE_EVENTS` | lint red → green | E2-M3 |
| 12 | The AERB gate refuses a night CT on the empty licence table; the technologist retries three times | each refusal is an event, not only a 403; the sheet shows 3 refusals against 0 licences, and the census row explains why | `aerb.acquisition_refused` × 3 (today: nothing written — `aerb/errors.ts:19`, no event in `aerb/events.ts`) | E2-M3 |
| 13 | Printer relay down at discharge | the slip queues; discharge proceeds; queue depth is a sheet line | `print_jobs` status + sheet | E1-M2 |
| 14 | IPD: summary drafted while a lab result is unpublished (MD1) | the template lists pending results; `pending_results` cannot satisfy while one is unpublished | gate test | E4-M2 |
| 15 | IPD: meds "returned" that never were; billing clears on its own (MD2) | clearances are approvals by a named human; only a zero-balance billing clearance auto-satisfies | holder ≠ `system` for 8 of 9 | E4-M3 |
| 16 | IPD: the consultant changes the plan after fit was declared (MD3) | `fit_declared` versioned; a new template supersedes with a diff; a signed summary is reissued AMENDED (KD DD7) | `documents` version+1 with `supersedes_id` | E4-M2 / E3 |
| 17 | IPD: consultant in theatre till 13:00; six summaries wait | the RMO signs; the 24-h clock runs; a breach is attributed `doctor`, never `hospital` | `sla.breached{summary_countersign_pending}` | E4-M2 |
| 18 | IPD: the drafter's provider times out / kill switch on | template editor opens at once; flow completes; kill-switch state is a sheet line | D5 test (IPD:241) + sheet | E4-M5 |
| 19 | IPD: TPA final approval at 17:00 for a 10:00 fit | clock attributed `payer`; above the threshold the counsellor signs and the patient leaves (R-219) | attributed hold + `undertaking.signed` | E4-M3 |
| 20 | IPD: the family wants the 06:00 muhurat | `family_hold` attributed `family`; no extra bed-day for a hospital-caused delay (R-186) | hold row + bed-day test | E4-M3 |
| 21 | IPD: death on the ward at 03:00 | `discharge_type: death` branches to 43b's MCCD chain (R-111); no gate pass; no template until the certifier acts | condition row; no `pass.issued` | E4-M1 |
| 22 | Audit: a condition with no codified protocol (AU1) | `no_protocol` shown as coverage, never as compliance | coverage line | E5-M3 |
| 23 | Audit: a wrong rule flags 100 % of admissions (AU2) | > 30 % over 7 d → `diagnostic`; QM paged; nobody tasked | demotion event | E5-M3 |
| 24 | Audit: a protocol version changes mid-admission | evaluation pins the version at encounter start; the deviation carries `ruleVersion` | payload test | E5-M2 |
| 25 | Audit: an MLC/sealed record | the evaluator reads through the caller's filter (spec fix 25); the task shows no sealed content | sealed-class test | E5-M2 |
| 26 | An inspector says "show me the 100 %" | one patient-day reconstructed end-to-end from events, rules and tasks | script output | E5-M2 |
| 27 | HR asks for deviations per doctor for appraisal | refused by design — no per-person aggregate exists (R-119) | schema + test | E5-M5 |
| 28 | **Session:** 15e merged; nobody holds `ot_incharge` on production | census reads *unstaffed*; the session writes the runbook line and stops — never creates a human on production (RM rule 1) | RED row + refusal in the lane report | E1-M3 |
| 29 | **Session:** the deploy lands the sheet job before its read permission | the job stores the sheet; the screen refuses all but `admin`; `check-config-present` names the row (RM rule 4) | `ops_fact_sheets` rows + gate output | E2-M2 |
| 30 | **Session:** the owner is asleep; 44's write-off number is pending | the amount is config; the session records the corporate default (R-148) in §7, builds the approval type, stops at the number | §7 row naming R-148 | E4-M1 |
| 31 | **Session:** a grep finds `sla.breached` and the report says "the audit exists" | a claim is a reader with a row count; the report pastes the day's sheet count and the SHA | count in the report header | E2-M1 |
| 32 | **Session:** printing v2 and 15e both add kinds to `render.ts` in one week | the second lane rebases and proves both render (parity 6, not 5) | parity count in the PR | E1-M2 |
| 33 | **Session:** a lane proposes the Drafter "in shadow" on production before counsel signs | refused; E4-M5 stays *not started* with the gate named | milestone row unchanged + the refusal | E4-M5 |

## 5. DECIDED and RULINGS

**DECIDED** (Indian-corporate-hospital standard; one line of reasoning each):
- **D1** Clearances are approval instances `discharge_clearance.<dept>` on the existing approvals engine, 60-min SLA + ladder — a clearance is a one-click confirm, which is what an approval is; no tasks engine before 44.
- **D2** A zero-balance billing clearance and an empty orders sweep auto-satisfy; every other clearance is a named human — "automatic" means chased and attributed, never signed by a rule.
- **D3** The template summary is the product and ships first; the model draft is a layer — the fail-open path must exist before the thing that fails.
- **D4** "Real time" is the dispatcher cycle (2 s / 20 s); anything in-transaction is a module gate — a block belongs to the module that owns the rule.
- **D5** The first protocol set is the gates already built — measure what exists before sourcing what does not; a gate that refuses without an event gets its event twin first.
- **D6** The sheet is Class 0 (aggregates, no ids) by email/in-app until WABA/DLT — WhatsApp is a channel, not a design.
- **D7** Letters `15e` and `11l` (15b/c/d, 11j/11k claimed); numbering never moves.
- **D8** Kernel-D is revived before 44 is authored; 44 and 45 land on it; the outbox stays the transport — KD:44-46's failure.
- **D9** The mini-OT opens under R-247 honesty mode (MS publishes; re-ratified ≤ 30 d after O1) — the roadmap adopted it for the lab (RM:183-191).
- **D10** Recall = the review date, else day 7; next working day on holidays; one message; missed = recall, never no-show (SPEC:460).
- **D11** Slip in Hindi + English, digits unchanged (memory: refusals are prose carrying data).
- **D12** Countersign is a second SLA state `summary_countersign_pending` 1440 min — `record_only` in commissioning, `active` after the pilot (§10.3 alerts selective).
- **D13** Deviation tasks carry no per-person aggregate — R-119 by construction.
- **D14** 28d keeps its own `protocol_rules`; Plan 21 consumes later — a KPI registry is not a rule store.
- **D15** Rule versions pin at encounter start (SPEC:196-199 precedent); demotion at > 30 % over 7 d — alarm fatigue applied to a rule.
- **D16** Orphan widening is a new billing function, no signature change — billing is imported by every lane.
- **D17** Discharge KPIs are one arithmetic on the sheet (`user_day_facts` precedent) until 21 registers them under K11:459's ids.
- **D18** The OT harvest is six rows on the lab's model (`lab-go-live.md:207-218`); the window closes when the last three are empty for a week.
- **D19** 44 adopts `daycare.discharged` for `discharge_type: day_care`; never re-implements the day-care path.
- **D20** Readiness Predictor and Demand Forecaster stay out of 44's first cut (IPD:463 "after 90-day baselines").

**RULINGS** (money / procurement / law / facts the owner holds):

| id | question | category | recommended default | unblocks |
|---|---|---|---|---|
| O1 | Who is the second full administrator? | fact (staffing) | a name by week 3 (RM:336) | E4-M1; 28-G; re-ratifying 15's definitions |
| R-148 / R-187 / R-195 / R-219 / R-220 | The five IPD money ladders | money | the register's defaults (≤ ₹2k auto write-off, ≤ ₹25k billing head; admit regardless; dues only via Plan 08; counsellor-signed undertaking; ≤ ₹10k / ≤ ₹50k) | E4-M1, E4-M3 |
| R-192 + R-111 | RMO signs / consultant ≤ 24 h; MCCD chain | law | as REG:204,123 | E4-M2; the `death` branch |
| R-262 + Drafter addendum | DPIA v0.2 signed by counsel | law | one session; split the STT carve-out so Class-0 signs alone | E4-M5 only |
| R-126 | Class-1 inference locus | law | on-prem default; cloud only with in-region DPA | E4-M5 |
| R-240 / R-241 | Just-culture; open disclosure | law | adopt the register's text | E5-M2 |
| R-119 | KPI-linked pay forbidden | law (a policy instrument the owner signs) | sign; do not deliberate | E5-M5; Plan 21 |
| R-245 | Internal auditor appointment | money | appoint the §138 firm before the payouts pack | 28d control-testing |
| NEW-P5-1 | Machine-readable protocol source: licensed content or in-house SOPs via the Expertise store? | procurement | in-house SOPs first (₹0, DTC-signed); licensed content when a service line needs it | E5-M4 |
| NEW-P5-2 | The names: OT in-charge, recovery nurse, anaesthetist on call | fact | name before E1-M3 can be green | E1-M3, E1-M5 |
| NEW-P5-3 | WABA/DLT registration for patient messages | procurement | in-app + printed slip now | E1-M1's channel; E2-M4's |
| O6 | CA signature + real package tariff | money / law | one CA session (R-255) | E1-M5's first *live* invoice, not the pilot |

## 6. Not now

- **No 12a runtime, no model Drafter** this quarter or next (RM:428); E4-M5 is the only inference here and it is last.
- **44 not built** this quarter, not authored before 41 has been live 30 d (IDX:86; RM:419-420). 45, 54 (41 live 90 d), the Coding Suggester, ABDM care-context, the WhatsApp summary PDF and the discharge lounge (R-195) follow 44.
- **No pharmacy returns path** here; 44-M3 carries `pharmacy_returns` as `NOT MODELLED → runbook` until the pharmacy lane ships 16 returns after its own G6.
- **No 28a/28e, no Expertise store module** this quarter (RM:416); E5-M1 is Q1 2027 at the earliest; the evaluator waits on Plan 20 and R-240; clinical rules on NEW-P5-1.
- **No Plan 21 registry** (RM:415): the sheet is one arithmetic (D17). **No Grafana clinical panel**: a panel over an empty production is decoration.
- **No physio trajectory alert** (Plan 25, pillar 4) — E1-M1's procedure code is the seam it keys on (PHY:90).
- **Kernel-D waits for the lab's G6** (Q1 2027) — a document component while zero departments pilot is RM §0c.5's pattern.
- **Absorption before building, as a number:** ≈ 28 lane-days on E1+E2 this quarter, 0 on E3–E5; the hospital gets one discharge it can rehearse and one sheet it can read.

## 7. Sequencing note

Against RM §2 (weeks from Monday 2026-09-07; lanes L/R/P→S/F; rows RM:334-339):
- **Weeks 3–5 — E2 (11l)** by **F** after the FD-25 close (RM:335), ≈ 12 d for M1–M4; M5 week 6 if F is free before joining S. No human act to start. The sheet is live before the lab pilot's harvest week (RM:337), so the harvest is a sheet section from day one; the AERB refusal twin (E2-M3) lands before radiology opens in week 7–9 (RM:338), so the licence gate's refusals are counted from its first real week.
- **Weeks 5–6 — E1-M3** by **S** beside the pharmacy census (RM:337); **weeks 6–8 — E1-M1/M2** by **F** (≈ 7 d, coordinated with printing v2, RM:334); **week 9 — E1-M4** on UAT. Human acts: the MS publishes the DD6 drafts on UAT (week 6); the owner names the three OT holders (week 8) or the row reads *unstaffed*.
- **Weeks 10–13 — E1-M5**, the day-care pilot on production behind the owner's weekly deploy (RM:334,341-342), paper authoritative, harvest on the sheet. This makes 15 "open for real" — RM:418's precondition for 29/31, next quarter's call.
- **Q1 2027 — E3** weeks 1–4 after the lab's G6 closes (dated in `lab-go-live.md`); **E5-M1** weeks 3–4. **E4-M1** only once 41 — authored week 7–9 (RM:338), started weeks 10–13 only if O1 + Plan 20 + the ladder numbers + 11b land (RM:339,419-420) — has been live 30 d: end of Q1 2027 at best. Human acts: O1, the five ladder numbers, the counsel session booked (for E4-M5 later).
- **Q2 2027 — E4-M2..M4** (≈ 28 d, one lane) on E3 + Plan 20 + approvals; **E5-M2/M3** (≈ 13 d) once R-240 is signed and 20 is live. **E4-M5** and **E5-M4/M5** start only when their gates are dated — DPIA v0.2 signed, R-126 ruled, `complete()` landed; the sourcing ruling, the DTC chairs named. Each start is a human act with a name, so a slip reads "unsigned / unnamed", never "the discharge is late".
