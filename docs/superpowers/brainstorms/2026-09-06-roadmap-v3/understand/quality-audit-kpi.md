# quality-audit-kpi — pillar 5b ("100% real-time audit against clinical protocols") and the acceptance-parameter vocabulary

Read against `main-ro` @ `b04cbd9` (2026-09-06). Deployed base is `c11833d` = 56 migration files (`git ls-tree c11833d -- apps/core/drizzle` → 56); `main` carries 80 (`0000`…`0079`), so **24 migrations are pending** (roadmap §0c.1 counted 22 when written). Every "deployed" verdict below was checked with `git cat-file -e c11833d:<path>`; "merged" means on `main` but not at the base. Production's entire event log is 498 events (ROADMAP-v2.md:127).

The short answer to (a): the system already audits **100% of recorded interactions structurally** (every state change writes an event in the same transaction; every non-terminal workflow state must carry an SLA; every breach is recorded). What does **not** exist, at any status above "brainstormed/deferred", is anything that evaluates those events against a *clinical protocol*: there are no protocol rules as data, no evaluator, no conformance report, no nudge. The design already names that capability — deferred design note 12, "the 100%-audit concept, clinical form" — and tiers it (deterministic automation, deviations are T2 review tasks). (b): ~30 measurable parameters exist as events/columns/scripts today; none is a *registered* KPI because Plan 21 has no code, so every number is a hand-written SQL over the spine.

---

## A. The instruments that exist for pillar 5b

### A1. Event log as structural audit — DEPLOYED
- Law: "Audit is structural: event log + append-only financials + row-level updated_by/updated_at gives NABH-grade traceability without a separate audit subsystem" (architecture-design.md:125). Grammar/envelope §10.5 (:210-214): `occurred_at` / `recorded_at` distinct, actor `user | agent | system`, `correlation_id` = workflow instance.
- Code: `appendEvent` writes in the caller's transaction with an idempotency claim (kernel/events/append.ts:6-59). Table: `seq`, `name`, `occurred_at`, `recorded_at` (default now), `actor_type`, `correlation_id`; partitioned by `recorded_at`, indexed on name/patient/correlation (kernel/db/schema/events.ts:5-10, 24-51). Actor type includes `"agent"` (packages/contracts/src/envelope.ts:35).
- Catalogue in code: **229 distinct event names** defined via `defineEvent` (both one-line and multi-line forms; opd 29, lab 25, ot 21, materials 15, radiology 13, pharmacy 9, formulary 9 in the one-line form, plus ~90 kernel/billing/patients names in the multi-line form). Spec catalogue is ~285 (architecture-design.md:226).
- Consumers: cursor-based at-least-once dispatcher with a measured 5000-seq look-back (kernel/events/dispatcher.ts:9-24; `event_cursors.consumer/last_seq` eventCursors.ts:3-5). This is the mechanism a T0 conformance evaluator would ride.
- Subscription census: 21 of 24 manifests still declare `subscriptions: []`; the alerts manifest is "the first declaration" (kernel/alerts/manifest.ts:5-6). The alerts consumer handles exactly five names — `notification.failed`, `mode.changed`, `imaging.critical_overdue`, `imaging.report_unread`, else `escalation.triggered` (kernel/alerts/consumer.ts:92-108).
- Read-side audit also structural: PHI access log by named surface (kernel/phi/audit.ts:14-25); one search-audit row per search, 90-day retention (kernel/search/audit.ts:12, 27-30); `late_entry.flagged` carries the paper `occurred_at` beside `recorded_at` (ot/events.ts:169; ot/cockpit.ts:489).

### A2. §10.3 "structure everywhere, alerts selective" — DEPLOYED as kernel law
- Spec: every state carries an SLA, every breach is recorded (`sla.breached`); active alerting at go-live only on patient-facing waits, lab TAT, oxygen (architecture-design.md:201-204). Definitions are versioned data in the DB, in-flight instances complete on their version (:196-199).
- Schema: `sla: { minutes, alerting: "active" | "record_only", escalation?: [{afterMinutes, toRole}] }` (kernel/workflow/definition.ts:7-18). Lint: a non-terminal state without an SLA is rejected — "spec §10.3: structure everywhere" (definition.ts:77-81).
- Timers: `scheduleSlaTimer` (timers.ts:21-35); `runDueTimers` appends `sla.breached {instanceId, defKey, definitionVersion, state, slaMinutes, alerting, dueAt}` and, only for `alerting: "active"`, walks the ladder emitting `escalation.triggered {rung, role, resolvedUserIds, fallback, fallbackExhausted}` with a `duty_manager` fallback (timers.ts:71, 86-175).
- Durations are recoverable: `workflow_instances.state_entered_at` (kernel/db/schema/workflow.ts:56) and `workflow_transitions {from_state, to_state, actor, at}` (:67-80) — the state history of every instance.
- What actually alerts today (definition files, all at the base except pharmacy):
  - `opd_visit`: `waiting` 45 min ACTIVE → +15 `front_office_supervisor`, +30 `duty_manager`; `registered` 20, `in_consultation` 60, `awaiting_results` 240 record-only (modules/opd/workflow-def.ts:20-23).
  - `lab_item`: `awaiting_collection` 120 ACTIVE (+60 technician, +120 pathologist), `collected` 60 ACTIVE, `in_analysis` 240 ACTIVE, `resulted` 120 ACTIVE, `recollection_pending` 1440 ACTIVE; `ordered`/`accessioned`/`verified`/`sent_out` record-only (lab/workflow-def.ts:85-102). `lab_specimen`: `labelled`/`collected`/`in_transit` ACTIVE (:159-166).
  - `daycare_case`: `in_holding` 45 ACTIVE (+45 `ot_incharge`), `discharge_ready` 120 ACTIVE, eleven others record-only; `ot_gate.open` 1440 record-only (ot/workflow-def.ts:75-94, 156-159).
  - `pharmacy_dispense`: queued 120 / claimed 2 / verified 3 / picked 5 / billed 1440, ALL record-only (pharmacy/workflow-def.ts:33-39) — merged, main-only.
  - `imaging_study`: every state record-only, by design ("an active state here would page a human through a channel 18a-iii owns", radiology/workflow-def.ts:28-31).
- Lab additionally runs its own stateless sweep, `sweepLabSla`, emitting `lab.sla_breached {stage, dueAt, breachedAt, priority}` with STAT items held to the tighter of state SLA and the orderable's `tat_minutes_stat` — finding F18: the kernel definition cannot express a per-priority SLA (lab/sweeps.ts:231-275; lab/events.ts:231-234).
- **Nobody reads `sla.breached` today.** Its only references are the two files that define/emit it and approvals' event module (grep); there is no breach report, tile or panel.

### A3. Alert acknowledgement and the chasers — DEPLOYED (alerts kernel) / MERGED (radiology chasers)
- `alert.raised {alertId, userId, kind, refType, refId, sourceEventId}` / `alert.read` (kernel/alerts/events.ts:12-33); `alerts.read_at` (schema/alerts.ts:25). Idempotency unit is (source_event_id, user_id) so one escalation fans to every resolved holder (consumer.ts:85-89).
- Radiology: `sweepCriticalChaser` reads the window from the governed `critical_categories` book (`communicate_within_min`) — "a tier the book does not name is not chased, and that is deliberate" (radiology/chasers.ts:76-95); `UNREAD_REPORT_HOURS = 24` (:67). Both "escalate to a human, never to a status" (:15). Main-only (migration 0078).
- Lab: `lab_critical_calls {opened_at, attempts[], readback_text, closed_by, closed_at}` with a CHECK that closed ⇔ read-back ⇔ closer (schema/lab.ts:660-680); events `lab.result_critical_flagged` / `lab.critical_acknowledged` (lab/events.ts:172,178). At base.

### A4. Daily orphan report — DEPLOYED
- `runDailyClose` at 23:59 IST (kernel/worker/jobs.ts:170, 265-267) runs `orphanScan`: every OPD visit of the day whose consultation fee has no live invoice line (entered-in-error invoices are not cover) → one `charge.orphan_flagged` per encounter, plus `day.closed`; a second run the same day appends nothing (billing/daily-close.ts:18-26, 264-345). Scope is the OPD consult fee only — not lab, imaging or pharmacy charges. There is no "orphan cleared" event, so S10's "orphan-report clearance time" (staffing-kpi-design.md:54) has a numerator and no closing stamp.

### A5. Leakage Auditor / Fraud Sentinel / Digest Writer (T0) — ABSENT in code; designed
- Roster: automations vs agents (architecture-design.md:780); T0 = Leakage Auditor (triangle, orphan offenders, variance patterns), Fraud Sentinel, Digest Writer, Ops Copilot (:783); Plan 12a = runtime + Digest Writer + Leakage Auditor; Sentinel in 12b (:791).
- Code: zero hits for any of the three names (only a comment in billing/refunds.ts:39). `kernel/inference` is the Workers-AI speech client, inert at 503. ROADMAP-v2 §5: "No 12a agent runtime. DPIA v0.2 is counsel's" (:428).
- The raw material they would read already exists as events: `charge.orphan_flagged`, `variance.flagged`, `tender.mismatched/.reconciled`, `cashier_session.recounted`, `correction.entered_in_error`, `credit_note.issued`, `payment.refunded`, `approval_discount_override` instances, `sod.violation_blocked`, `break_glass.used`, `emergency_elevation.used`.
- The DPIA already fixes the digest's Class-0 shape: "a deterministic fact sheet (revenue close, OPD counts, SLA breach counts, orphan/variance summaries)" (dpia-agentic-runtime-v0.1.md:11); the Hermes brainstorm proposes it as a `digest.fact_sheet(date)` MCP tool (hermes-ops-copilot/00-BRAINSTORM.md:60).

### A6. Readiness census `standup:check` — MERGED (11i T2), not at the base
- 34 declared rows across gates G1–G4, three verdicts `ok | RED | NOT MODELLED`; reads only through module loaders (apps/core/scripts/standup-check.ts:23-75, 435-445). Row codes include `second_administrator`, `lab_critical_call_list` (NOT MODELLED: the bench's phone list is paper), `radiology_devices_licensed`, `pharmacist_council_number`. `deploy.sh` prints it non-fatally (docker/prod/deploy.sh:536-545); on UAT the exit code is the gate (T6). `scripts/standup-check.ts` is main-only.

### A7. `validate:config` (G7) — DEPLOYED
- Exit code is the verdict; persists a `config_validation_reports` row and appends `ops.config_validated` whether green or red (scripts/validate-config.ts:1-11, 33-41; schema/ops.ts:79). Requires CA signature + active tariff; the mode row cannot leave `commissioning` without an ok within 24 h.

### A8. `check-config-present` (G2) — DEPLOYED
- The deploy's hard gate: "are the configuration rows the modules THROW without actually present?" (scripts/check-config-present.ts:14-25).

### A9. `seed-roles` READY verdict (G4) — DEPLOYED
- A reachability census: every declared permission held by somebody; "states a readiness verdict in its last line" (scripts/seed-roles.ts:16, 48, 1524-1546). deploy.sh reads it as "READY" / "NOT READY", non-fatal (deploy.sh:493-509).

### A10. Restore-drill log and `backup.drill_passed` — DEPLOYED and passed 2026-09-05
- Weekly host cron Sat 22:00 UTC (deploy.sh:691); restores for real into a scratch container, runs the migrator, asserts the census back out; emits `backup.drill_passed` / `backup.drill_failed` (docker/prod/drill/restore-drill.sh:1-35). Watcher: `hmis_backup_last_drill_pass_age_seconds`, alert `HmisBackupDrillOverdue` > 8 days (prometheus/alerts-backup.yml:26-56; postgres-exporter/queries.yml:66). Passed 2026-09-05 with 498 events / 56 migrations read back (ROADMAP-v2.md:110-115).

### A11. Grafana / Prometheus — DEPLOYED, infrastructure only
- Eight panels, all host/scheduler/Postgres (grafana/provisioning/dashboards/hmis.json:6-140). Rules: `HmisSchedulerJobStale{Interval,Daily}`, `HmisSchedulerJobMissing` over the twelve named jobs, `HmisBackupDrillOverdue` (prometheus/alerts.yml:14-69). Zero clinical or operational panel; the exporter exposes only `hmis_scheduler_heartbeat` and `hmis_backup_last_drill` (queries.yml:22,66).

### A12. Desk tiles and `user_day_facts` — DEPLOYED (07c)
- Live per-user counts such as `desk.opd.waiting`, `desk.opd.seen`, `desk.billing.collected` (opd/desk-provider.ts:45,85-87; billing/desk-provider.ts:113); one arithmetic, cached nightly at 02:00 IST as `user_day_facts {user_id, day, facts jsonb}` (kernel/desk/rollup.ts:9-25; schema/desk.ts:35-43). These are counts for a person's own day, not hospital KPIs, and the facts are untyped JSON — the closest precedent to a compute lane, without versioned formulas.

### A13. KPI registry (Plan 21) — ABSENT in code; fully designed
- Design: registry = metric id + typed formula AST over events + semver + owner + load normaliser + denominator rules + SLA binding + audiences; `kpi_series` append-only with `correction_seq` and `input_event_watermark`; DQ gate withholds rather than shows a wrong number (11-staff-kpi-kra-performance.md:8, 153-164). Worked entry `nursing.dose_on_time_rate` (:412-427). Per-role ids (:431-449), department ids incl. `opd.wait_median`, `lab.tat_p50_p90`, `rad.tat_by_modality`, `fin.leakage_variance`, `ops.discharge_ready_to_discharged_hours` (:459). Targets: live tiles ≤ 60 min fresh (:492). Plan split 20/21/22 → renumbered 21/21b/21c (:540-548; 00-INDEX:67). Rulings R-116…R-125 (00-OWNER-RULINGS-REGISTER.md:128-137), R-125 puts it in `modules/performance/`.
- Code: no `kpi_*` table, no `modules/performance` (grep). ROADMAP-v2 §5: "not 21 (KPI registry — after 20)" (:415). S10 v1.3 stays the book of record (00-INDEX:148; staffing-kpi-design.md:20-25 — every KPI names its source events; "any KPI without an event source is a bug in this book" :368).

### A14. Plan 28 quality pack, 28d and 28e — BRAINSTORMED
- 28a registers/incidents/licences/evidence · 28b infection control · 28c committees/documents/credentialing/drills · **28d internal audit, clinical audits, protocol adherence, DPDP** · **28e inference lane** · 28-G governance after O1 (00-INDEX:74; 22-quality…md:532-541). 28d: control tests as automated assertions in prod (`audit.control_tested`), prescription/medical-record/consent/IPSG audit instruments, "Protocol-Adherence Evaluator only when machine-readable protocols exist (note 12)" (:537). 28e gate: DPIA L1 revision + provider DPA + eval fixtures + shadow mode (:539).
- NABH indicators are computed from events, each "a `kpi_metric_versions` row with `indicator_set = nabh`, a validation rule, and a 'not yet measurable' state until its feeding plan ships" (:413). Evidence-honesty law: "care without an event is invisible, so every indicator must carry a completeness/denominator flag" (:5).
- Automations proposed: Indicator Data-Validation Checker (numerator ≤ denominator, completeness ≥ 90 %, z-score), Audit Round Sampler, Care-Audit Mismatch (notes vs orders vs charges, T0), Protocol-Adherence Evaluator (T2-capped, "deviation ≠ correction", "gated on knowledge sourcing") (:455-466). Rulings R-240…R-249 (register:252-261); R-247 single-approver honesty mode until O1.
- ROADMAP-v2 §5: not 28 this quarter; 28a's licence register collides with 18c's AERB register — resolve at 28a authoring (:415-417, 474-475).

### A15. Deferred design note 12 — the pillar already has a design name
- "Continuous protocol-adherence evaluation (the 100%-audit concept, clinical form; extends note 8). Once protocols live in the Expertise store as machine-readable rules, a deterministic automation evaluates patient-context events against them: protocol → rules → event → evaluation → deviation task with a named clinical reviewer → resolution, every step evented. Sampling-based peer review becomes the fallback, not the method. Ships with the clinical modules + the NABH pack; gated by the clinical-knowledge-sourcing decision; deviations are review tasks, never auto-corrections — the T2 cap applies to quality machinery exactly as it applies to drafters." (plans/2026-08-11-phase1-plan-series.md:463, owner-ruled "log, don't schedule" :431).

### A16. Protocol-conformance capability map — what would be needed, layer by layer

| layer | status | evidence / nearest precedent |
|---|---|---|
| **P1 protocol definitions as data** | ABSENT for clinical protocols; PARTIAL precedents | `workflow_definitions` are versioned JSON with states/transitions/roles/SLA (schema/workflow.ts:6; definition.ts:26-33) — they encode *process* conformance, not clinical content. Governed clinical-parameter books exist per module: radiology `critical_categories` (chasers.ts:87-91), lab range book / critical bands / reflex rules gated at `pathologist` (lab/definitions.ts:22-24), OT `ot_definitions` (schema/ot.ts:525), formulary interaction set (formulary/events.ts). Expertise store (note 8) absent. Copilot Care-Setting Packs are versioned config artefacts with "applicable encounter states" (clinical-copilot-design.md:108) — a pack shape, not rules. |
| **P2 conformance evaluator (deterministic)** | ABSENT | Design: doc 22 §9 Protocol-Adherence Evaluator; note 12. Every existing "rule × instance → flag → human" job is hand-coded per module: `sweepLabSla` (lab/sweeps.ts:251), `sweepCriticalChaser` (chasers.ts:87), `flagLateSurgeons` slot+15/+30 (ot/lists.ts:236-285), `orphanScan` (daily-close.ts:295), `runDueTimers` (timers.ts:86). The only deployed *clinical* rule evaluator is the formulary's three checks at issue time (copilot spec §1.3 :63), whose exhaust is `prescription.issued.{allergy,interaction,duplicate}OverrideCount` (opd/events.ts, `prescriptionIssued`). |
| **P3 T0 conformance report** | ABSENT | No reader of `sla.breached`; no panel; DPIA fact sheet (dpia:11) is the ruled Class-0 shape; Plan 21 `kpi_series` is the designed home; 28a `q_indicator_set/values` the NABH face. |
| **P4 T1 nudge** | PARTIAL precedents | Alerts kernel + escalation ladders (A3); radiology chasers "never to a status"; OPD `queue.escalated` with a stored 10-s cancel window and `withinMs` on cancel (opd/events.ts:245-259). Constraint: §10.3 alarm-fatigue rule — new active alerting only as baselines emerge. |
| **P5 evidence / indicator honesty** | ABSENT | 28a Indicator Data-Validation Checker; DQ gate + `withheld` in 21; "not yet measurable" state. |
| **gates** | — | knowledge-sourcing decision (licensed content; doc 22 :5 "clinical rules engine (Phase-2, licensed content)"); DPIA v0.2 for anything with inference (CONTEXT); Plan 21 table shape frozen before 28a (doc 22 :543); O1 second approver for two-key Class-A definitions (R-247). |

What "100 %" honestly means today: 100 % of *recorded* interactions are evented in-transaction, 100 % of non-terminal workflow states are timed, and 100 % of breaches are written. It does not mean any interaction is compared with a clinical protocol. The deployed clinical checks that come closest — and are all deterministic, all owner-governed data, all T0/T1 — are: formulary allergy/interaction/duplicate at issue; vitals danger flags → `vitals.recheck_demanded` / `queue.escalated` (opd/events.ts:198-259); lab critical bands, reflex, absurd envelope and the read-back-closed call; radiology critical categories + chasers; OT gates (`gate.overridden`, `timeout.halted`, `count.mismatch`, ot_gate `waived|overridden`).

---

## B. Acceptance-parameter vocabulary — measurable today or designed

Legend: **DEPLOYED** = at base `c11833d`; **MERGED** = on `main` only; **DESIGNED** = doc only. "Computable" means a SQL over the named instrument yields the number now; none is a registered KPI (A13).

| # | PARAMETER | INSTRUMENT | COMPUTABLE TODAY? | NOTE |
|---|---|---|---|---|
| 1 | OPD wait (check-in → called), median/p90 | `patient.checked_in`/`visit.opened` → `queue.called` (opd/events.ts:77,132,304); `opd_queue_entries.called_at` (schema/opd.ts:381); `workflow_transitions` for `opd_visit.waiting` | YES, DEPLOYED | Live tile `desk.opd.waiting` is a count, not a duration. S10 :40 `opd.wait_sla_compliance`; doc 11 :459 `opd.wait_median`. |
| 2 | OPD wait-SLA breaches/day and escalations | `sla.breached{defKey=opd_visit,state=waiting}` (timers.ts:119-133); `escalation.triggered` | YES, DEPLOYED | 45-min ACTIVE state; the only patient-facing wait that pages today. No reader exists. |
| 3 | Consult duration | `consultation.started` → `consultation.completed` (opd/events.ts:315,319); `opd_encounters.consult_started_at` (:334) | YES, DEPLOYED | Record-only SLA 60 min; the mission's "adjust appointment length by visit type" needs this as baseline. |
| 4 | Registration time (arrival → registered) | `patient.registered`; `visit.opened` | PARTIAL, DEPLOYED | No arrival stamp before `patient.registered`; doc 11 :433 defines it as `patient.registered − visit.opened`, which only holds for the queue-first path. |
| 5 | Appointment no-show rate | `appointment.booked` / `appointment.no_show` (sweep 23:55 IST, jobs.ts:169,219) | YES, DEPLOYED | |
| 6 | Lab TAT collected → verified → published (p50/p90 by category, STAT vs routine) | `lab.specimen_collected` → `lab.result_verified` → `lab.report_published`; `lab_item` transitions; target per orderable `tat_minutes_routine/stat` (schema/lab.ts:69-70) | YES, DEPLOYED (events at base) | doc 11 :459 `lab.tat_p50_p90`; S10 :151. Prod has no lab orders yet. |
| 7 | Lab SLA breaches by stage/priority | `lab.sla_breached{stage,priority,dueAt,breachedAt}` via `sweepLabSla` (lab/sweeps.ts:251) | YES, DEPLOYED | Unique on (item, stage): emitted once. |
| 8 | Critical-value contact time (flag → read-back close) | `lab.result_critical_flagged` → `lab.critical_acknowledged`; `lab_critical_calls.opened_at → closed_at` (schema/lab.ts:660-680) | YES, DEPLOYED | Open rows at 07:00 are a runbook §9 harvest row (lab-go-live.md:214); the phone list is NOT MODELLED (standup row `lab_critical_call_list`). |
| 9 | Imaging critical acknowledgement within its tier window | `imaging.critical_flagged` → `imaging.critical_acknowledged`; `imaging.critical_overdue` by `communicate_within_min` (chasers.ts:87-95) | YES for the pair (DEPLOYED); overdue MERGED (0078) | Window is governed data, not code. |
| 10 | Imaging report unread > 24 h | `imaging.report_unread` (`UNREAD_REPORT_HOURS=24`, chasers.ts:67) | MERGED | |
| 11 | Radiology report TAT by modality | `imaging.study_acquired` → `imaging.report_published`; `imaging_study` transitions | YES, DEPLOYED | doc 11 :459 `rad.tat_by_modality`. |
| 12 | Dispense time queued → handed over | `dispense.queued` → `dispense.handed_over` (pharmacy/events.ts:14,57); `pharmacy_dispense` states 2/3/5 min record-only (workflow-def.ts:33-39) | MERGED | Pharmacy shelf empty on prod; S10 :213 dispense TAT. |
| 13 | Rx safety-override rates (allergy / interaction / duplicate) | `prescription.issued.{allergyOverrideCount, interactionOverrideCount, duplicateOverrideCount}` (opd/events.ts `prescriptionIssued`) | YES, DEPLOYED | "None ever is the flag" (doc 11 :435). The mission's DDI beta already has its KPI numerator. |
| 14 | Vitals danger-flag latency and recheck | `vitals.recorded` → `vitals.danger_flagged` → `vitals.recheck_demanded`; `queue.escalated{escalationOpenedAt}` → `queue.escalation_cancelled{withinMs}` (opd/events.ts:198-259) | YES, DEPLOYED | S10 :291 danger-flag latency. |
| 15 | Discharge decision → door (day-care) | `daycare.discharge_ready` → `daycare.discharged` (ot/events.ts:79,84); `daycare_case.discharge_ready` 120 min ACTIVE → `sla.breached`; `daycare_encounters.discharged_at` (schema/ot.ts:209) | YES, DEPLOYED | IPD discharge does not exist (Plan 44); doc 11 :459 `ops.discharge_ready_to_discharged_hours`. |
| 16 | OT start delay / first-case on-time | `surgeon.late_flagged{minutesLate 15|30}` vs NPO-gate `plannedStart` (ot/lists.ts:236-285); `ot_cases.wheel_in/induction/incision/closure/wheel_out` (schema/ot.ts:271-275) | YES, DEPLOYED | `plannedStart` is the only slot notion; a list has `list_date` + sequence, no slot instants (schema/ot.ts:241-260). |
| 17 | OT gate compliance / near-misses | `gate.overridden`; `ot_gate` terminal `satisfied|waived|overridden`; `timeout.halted`; `count.mismatch` | YES, DEPLOYED | S10 :114 "zero wheel-ins past open gates". |
| 18 | Alert acknowledgement time | `alert.raised` → `alert.read`; `alerts.read_at` (schema/alerts.ts:25) | YES, DEPLOYED | Only five source kinds fan into alerts (consumer.ts:92-108). |
| 19 | Escalation with nobody to receive it | `escalation.triggered.fallbackExhausted = true` (timers.ts:150-165) | YES, DEPLOYED | A staffing signal (G4) that is already an event. |
| 20 | Orphan consult charges / day | `charge.orphan_flagged`; `day.closed` (daily-close.ts:264-345) | YES, DEPLOYED | OPD fee only; no "cleared" stamp for S10 :54's clearance time. |
| 21 | Cash variance and tender mismatch | `variance.flagged`, `cashier_session.closed/.recounted`, `tender.mismatched/.reconciled` | YES, DEPLOYED | S10 :47 variance rate < 0.1 %. |
| 22 | Late-entry share (backfill) | `events.occurred_at` vs `recorded_at` (schema/events.ts:28-29); `late_entry.flagged` (ot only) | YES, DEPLOYED | doc 11 T7 :210: late-arriving share is itself a DQ metric. |
| 23 | Deploy lag: main vs prod | `git ls-tree <base> -- apps/core/drizzle` count vs applied-migration query (ROADMAP §3 G1) | YES, manual | 80 vs 56 = 24 pending today. `/api/health` reports only `status/db/worker` (health/health.controller.ts:24-37) — no sha/version field: the missing one-query instrument. |
| 24 | Census RED rows per module | `standup:check <module|all>` — 34 rows, `ok|RED|NOT MODELLED` (standup-check.ts:75,435-445); printed by deploy.sh:536-545 | MERGED (11i T2) | Exit code is the G1–G4 gate on UAT. |
| 25 | Config validated within 24 h (G7) | `ops.config_validated`; `config_validation_reports` (schema/ops.ts:79); `validate:config` exit code | YES, DEPLOYED | Never green on prod (no CA signature, no active tariff). |
| 26 | Roles READY (G4) | `seed-roles` last-line verdict; deploy.sh:505-509 | YES, DEPLOYED | Non-fatal by design. |
| 27 | Drill pass date / age | `backup.drill_passed/.failed`; `hmis_backup_last_drill_pass_age_seconds`; `HmisBackupDrillOverdue` > 691200 s | YES, DEPLOYED | Last pass 2026-09-05 22:00 UTC. |
| 28 | Scheduler job liveness | `scheduler_heartbeats`; `HmisSchedulerJobStale*` / `HmisSchedulerJobMissing` over 12 named jobs (alerts.yml:14-33) | YES, DEPLOYED | The rule file already names `sweepLabSla`, `sweepCriticalChaser`, `sweepExpiredPharmacyPicks`. |
| 29 | Runbook executed (G5) | dated `## Executed on UAT — …` section (11i plan :301; ROADMAP §3 rule 3) | NO | Four runbooks, zero executed. |
| 30 | Pilot harvest empty for a week (G6) | lab-go-live.md:207-216 six rows (`lab.sod_violation_blocked`, `lab.report_print_blocked`, `lab.tube_mismatch_flagged`, open critical calls at 07:00, `absurd_overridden_by`, `tariff_item_missing`) | Computable once the lab runs; NOT YET | Close rule: "last three empty for a full week" (:218). |
| 31 | Agent share of actions | `events.actor_type = 'agent'` (envelope.ts:35) | YES structurally; value is 0 | No agent identity exists on prod. |
| 32 | PHI reads per surface / per user | `phi_access_log` surfaces (phi/audit.ts:14-25); `search_audit` | YES, DEPLOYED | The audit *of readers*, which 28d's break-glass/access reviews would consume. |

Designed-only parameters worth naming for pillar authors (no instrument yet): protocol deviation rate per protocol version (note 12); `kpi.series_withheld` / DQ coverage (doc 11 :263, 492); NABH indicator set with "not yet measurable" (doc 22 :413); `agent.acceptance_rate` / `agent.edit_distance` (doc 11 :449; arch :538); `governance.single_approver_used` (R-247, absent in code).

---

## Facts
- Deployed base `c11833d` = 56 migration files; `main` = 80 (`0000`–`0079`); 24 pending. Prod holds 498 events (ROADMAP-v2.md:127).
- 229 distinct event names are defined in code; the spec catalogue is ~285 (architecture-design.md:226).
- `sla.breached` has no reader anywhere in `apps/core/src` other than its definers (grep); the alerts consumer fans out only `escalation.triggered` plus four named events (consumer.ts:92-108).
- Active alerting today: `opd_visit.waiting` (45 min), five `lab_item` states, three `lab_specimen` states, `daycare_case.in_holding` and `.discharge_ready`; pharmacy and imaging are entirely record-only (workflow-def.ts files cited in A2).
- The kernel SLA schema has no priority dimension; the lab holds STAT items to `tat_minutes_stat` in its own sweep (lab/sweeps.ts:243-249, finding F18).
- No `kpi_*` table, no `modules/performance`, no Leakage Auditor / Fraud Sentinel / Digest Writer, no Expertise store, no protocol evaluator exist in code; Plan 21 and Plan 28 are brainstormed only, and ROADMAP-v2 §5 excludes both, plus 12a, from this quarter (:415-428).
- Grafana has 8 panels, all infrastructure; the only application-level Prometheus series are scheduler heartbeats and the drill age (queries.yml:22,66).
- Deferred design note 12 already defines pillar 5b as a deterministic automation with T2-capped deviation review tasks, gated on the clinical-knowledge-sourcing decision (plan-series.md:463).
- `standup:check` (34 rows), `validate:config`, `check-config-present`, `seed-roles`, the restore drill and its watcher are the only *scripted* verdict instruments; three of them are non-fatal by design (deploy.sh:493-545).
- `/api/health` carries no build sha; deploy lag is measurable only by `git ls-tree` plus a DB query (health.controller.ts:24-37; ROADMAP §3 G1).

## Surprises
- The "100% audit" pillar already has a written design (note 12, 2026-08-21/22) that the mission brief re-asks for; it was owner-ruled "log, don't schedule" and never became a plan letter.
- Every breach is recorded and nothing reads the record: `sla.breached` is write-only on `main`, so the day-one SLA law (§10.3) has produced no report in the ~4 weeks since it shipped.
- The daily orphan report covers only the OPD consultation fee; lab, imaging and pharmacy orphans have no scan even though their charge events exist.
- The nearest thing to "protocol as data" is scattered across four module-owned books (lab ranges/critical bands/reflex, radiology critical categories, OT definitions, formulary interactions), each with its own governance and none registered in a shared store — the Expertise store of note 8 is what would unify them, and it is absent.
- The alerts rule file on `main` already names three sweeper jobs (`sweepLabSla`, `sweepCriticalChaser`, `sweepExpiredPharmacyPicks`) that the deployed base does not run; `HmisSchedulerJobMissing` would fire for them on the day the rules deploy ahead of the code, or stay silent if the reverse — a seam to check at the catch-up deploy.
- The workflow schema cannot express per-priority SLAs (F18), so "STAT TAT" as a parameter is a lab-private computation, not a kernel one — any pillar naming STAT/routine SLAs for other departments inherits this gap.
- `user_day_facts` is the only "KPI compute" on prod: untyped JSON, per-person day counts, not hospital indicators.
