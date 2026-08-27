# 11 — Staff KPI, KRA & Performance System — Brainstorm & Planning

- **Date:** 2026-08-27
- **Status:** Brainstorm v1 — for owner review; nothing here is ruled unless marked RULED
- **Series:** Department Brainstorm & Planning Series (2026-08-27), document 11 (cross-cutting)
- **Book of record it extends:** S10 `2026-08-11-hmis-staffing-kpi-design.md` v1.3 (39 role cards, §2 framework, §12 mechanisms 7/9/11/12/13/27) and roadmap deferred design note 5 (KPI formula registry)

**Executive summary.** This module is the hospital's single arithmetic for "how is the work going": a **KPI formula registry** (metric id + formula over events + semver + owner + load-normaliser + denominator rules + SLA link + allowed audiences), a **compute lane** that turns the append-only event spine into per-subject, per-period series, the **KRA/OKR bundles** that roll metrics up per role and per department head, the **review cadence** (monthly 1:1 with an auto-generated evidence pack, quarterly OKR scoring), the **dispute-and-correction loop** (`attribution.disputed/.resolved`), and the **incentive statement** that hands numbers — never payroll — to the bought HR SaaS. It is NOT an HR system (no payroll, no appraisal letters, no leave), NOT a fraud system (Fraud Sentinel owns anomaly disposition; this module only pairs each KPI with its gaming check), NOT a leaderboard product, and NOT a BI warehouse (series are read models over the spine, computed in the monolith). Three hardest problems: **(1) attribution under shared, handed-over, agent-assisted and backfilled work** — who "owns" the minute, and what happens when the clock was wrong; **(2) making "diagnostic, never auto-punitive" a structural property** — no code path from a metric to a penalty, no leaderboard by default, exposure only by owner grant, data-quality gates that hide a number rather than show a wrong one; **(3) denominators** — zero, tiny, shifting between shifts and floors, and Simpson's paradox turning a fair nurse into an unfair one in the roll-up. Everything else is plumbing.

---

## 1. Frame — what exists, what is locked, what this document adds

**Locked decisions inherited (not re-litigated):**

| Source | Decision |
|---|---|
| S10 §2 | KPI = event-derived with target, **names its source events**; KRA = responsibility bundle; OKR = quarterly, objectives set by owner, key results auto-measured. Philosophy (owner-confirmed): KPIs **never auto-trigger penalties or rankings**; appraisal is human judgment KPIs inform. Fairness rule: every rate KPI reported with load context; raw cross-load comparison structurally prevented. Integrity rule: every KPI ships with its gaming check routed to Fraud Sentinel as diagnostics. |
| S10 §12 mech. 7, 9, 11, 12, 13, 18, 23, 24, 27, 29 | Activity-attendance reconciliation is a T0 report, never auto-action · attribution-dispute workflow (both doctors + MS; `attribution.disputed/.resolved`) · gaming checks paired to every KPI · load-context structural · `overload.flagged` protects people *and* the KPIs · duplicate-UHID false-attach check · dyad analytics · per-doctor live accrual dashboard from week one · anomaly report classes have named reviewers (billing supervisor / matron / MS / owner) · role-card KPIs activate per area only at absorption date (ramp mode). |
| Arch §10.5 | Event envelope with `occurred_at` ≠ `recorded_at`, `actor` (user/agent/system), `correlation_id`, `causation_id`, `site_id`. KPI arithmetic runs on `occurred_at`; audit runs on `recorded_at`. |
| Arch §10.3 | Every state carries an SLA; every breach recorded (`sla.breached`) from day one; alerting selective. KPIs that are "SLA compliance %" are therefore derivable day one for every workflow, whether or not it alerts. |
| Arch §9, §11.12, fixes 16/21/41 | HR SaaS keeps **payroll and biometric attendance**; HMIS owns roster authoring/validation/publication and the NABH-facing staff evidence (training, drills, credentials). |
| Arch §7, fixes 1/17, Plan 09/09a | Silent accrual ledger: in-house staff incentives are a referrer payee class (a); accrue on `payment.received`, reverse on refund; attribution verification gate (unverified = captured but ineligible); class (c) external RMP payouts structurally OFF (IMC cl. 6.4). Plan 09a: accrual subject keyed `(invoice_id, direction)`, ratio clamped. **Staff incentives route to the payroll head** — the HMIS computes, HR pays. |
| Arch fix 32 | **No sales incentives on counter roles** (memberships/bundles). A KPI/incentive on "cards sold" at registration/billing is forbidden by design law, not by policy. |
| Arch §11.19-C "Governing the AI itself" | T2 draft quality = edit distance + acceptance rate is **the agent's KPI, not the doctor's** (`draft.acceptance_recorded`); symmetric surveillance of agent identities. |
| Arch §16 + roadmap | Digest Writer (T0 agent) is Plan 12a scope — owner's 8 a.m. digest + weekly rollups. Not shipped; nothing computes a KPI in the codebase today. |
| Roadmap deferred note 5 | Formulas become versioned definitions (metric id + formula + semver) in exactly one place; lands with the first surface that renders KPIs; **S10 v1.3 is the book of record until then**. |
| Roadmap note 3 | Three presentation lanes over one tool catalog: Lane 1 hand-built, Lane 2 schema-generated worklists, Lane 3 conversation with propose→confirm. Track B ops roles are the Lane-2/3 pilot cohort. |
| Roadmap notes 11, 14, 17 | Agent memory = the spine; action budgets; **cost-per-outcome is an agent KPI**; calibration record over recommendation/response/outcome events (autonomy earned per (agent, action-class), never trust scalar). |
| Copilot spec §3.3 (D-36 with teeth) | Signer-side engagement signals and Honcho impressions are **never performance evaluation**; no admin read path to per-person impressions, structurally. |
| Arch fix E-18 | Every agent report lands as a task/alert with a named reviewer. |

**What this document adds:** the registry's concrete schema and versioning rules; the compute contract (subject × period × version, numerator/denominator/load kept separately); attribution rules as data (share models, handover splits, agent-assist credit, trainee shadowing); data-quality gates; the exposure model (self → head → department → owner-granted wider); review artefacts; dispute mechanics; incentive statements as a one-way export; department-level KPIs; ~100 edge rows; agents; and the plan split.

**Scope boundaries / neighbouring owners:**

| Concern | Owner | This module |
|---|---|---|
| Source facts | Each module's tables + events | Reads events only (declared subscriptions in manifest); never joins module tables directly |
| Journey state | `workflow_instances` (kernel) | Reads state timestamps via engine read API for SLA-class KPIs |
| Resource state, floors, units | Plan 13 `resources` | Denominator scoping (per ward/floor/theatre) by `resource_id` |
| Roster / on-duty picture | Roster module (Phase-2 fast-follow; today `opd_doctor_schedules` for doctors only) | Consumes `roster.published`, shift boundaries, assignment spans for load normalisation |
| Attendance, payroll, appraisal letters, PIP/discipline | HR SaaS | Exports incentive statements + review acknowledgements; imports nothing but attendance-exception flags via mech. 7 |
| Money accruals | Plan 09 `partners` accrual ledger | Reads `commission.accrued/.reversed` for fee-split and staff-incentive heads; never writes money |
| Anomalies | Fraud Sentinel (12b) | Emits `kpi.gaming_check_flagged` (NEW) as input; disposition stays with Sentinel's reviewer roles |
| Patient feedback / NPS | Notifications gateway (Plan 10) + future feedback module | Consumes `feedback.received` (NEW, owned by feedback module) |
| Agent quality | 12a runtime (`draft.acceptance_recorded`, calibration record) | Agent KPIs registered here too, so humans and agents share one registry and one arithmetic |

---

## 2. Actors, roles & role cards

**Human roles (S10 card numbers):**

| Role | Card | Duty in this module |
|---|---|---|
| Owner | — | Sets quarterly objectives (S10 §2); **approves every audience widening** beyond self/head; approves incentive rules; receives 8 a.m. digest; governance-class anomaly reviewer |
| Medical Superintendent | 39 | Metric owner for clinical KPIs; attribution-dispute resolver (with both doctors); co-signs clinical metric definitions (two-key, arch E-6) |
| Quality Manager / NABH coordinator (dual-hat DPO) | 37 | **KPI Registrar**: curates the registry, runs semver hygiene, owns data-quality gates, DPIA line for staff data; NABH indicator mapping |
| Matron / Nursing Superintendent | 24 | Metric owner for nursing KPIs; fairness guardian; reviewer of nursing/scan anomaly classes; monthly 1:1 chain owner for nursing |
| Billing Supervisor | 4 | Metric owner for money KPIs; reviewer of money anomaly classes; incentive-statement preparer (SoD: never approver) |
| Department heads (ER head, Lab head, Diagnostics head, OT head, Pharmacy head, Materials head, Operations head) | various | Metric owners for their department's KPIs; run monthly 1:1s; hold the department KRA; propose targets |
| Duty Manager | 31 | Contextual annotator: declares surge/downtime/short-staffed windows that the compute lane treats as load context |
| Every staff member | all | **Subject and first reader** of their own KPIs; can raise a dispute; can opt into coaching nudges; can view evidence pack before the 1:1 |
| **Performance & Analytics Officer (NEW card 40, proposed)** | — | Day-one: dual-hat with Quality Manager. At scale (≥300 beds) 1 FTE: maintains formulas with metric owners, runs quarterly calibration of targets, answers "why did this number move" before an agent does. KPI: registry change lead time · dispute TAT · DQ-gate coverage. KRA: one arithmetic, trusted. |
| HR SaaS operator (HR executive) | external role | Receives statements/acknowledgements; never has an HMIS KPI screen beyond exported files |

**Agents & automations (all under the 12a harness; identity, kill switch, heartbeat, mode gates):**

| Actor | Kind | Tier | Does |
|---|---|---|---|
| KPI Compute | automation | T0 | Materialises series per (metric_version, subject, period) from events; idempotent, replayable |
| Data-Quality Gate | automation | T0 | Computes input completeness per series; withholds display below threshold; emits `kpi.series_withheld` (NEW) |
| Gaming-Check Runner | automation | T0 | Runs each metric's paired check; emits `kpi.gaming_check_flagged` (NEW) → Fraud Sentinel reviewer task |
| Evidence-Pack Compiler | automation | T0 | Assembles the monthly pack (series, load context, SLA breaches with links, disputes, kudos events) — deterministic, no inference |
| Digest Writer | agent | T0 | Narrates the 8 a.m. digest and weekly rollup from a fact sheet (12a, exists in scope) |
| KPI Anomaly Explainer | agent | T0 | Given a flagged movement, drafts a 3-line "what moved, what load changed, what to ask" from cited series lines; never a verdict |
| Coaching Nudge | agent | T1 | **Opt-in only**, per staff member, revocable; private message to self; never seen by head unless the subject shares |
| Workflow Tuner (12b) | agent | T2 | Consumes SLA-class KPI baselines to *propose* definition changes (existing roster item; no new grant) |

**Shifts & bundling:** compute runs on the worker clock (nightly full, hourly incremental for live tiles); nothing in this module requires a human on a night shift. **SoD hard pairs (RBAC-enforced, `sod.violation_blocked`):** metric author ≠ audience-widening approver (owner) · dispute resolver ≠ party to the dispute · incentive-statement preparer ≠ incentive-statement approver · a metric owner may not edit a formula whose subject set includes only themselves · reviewer of a gaming flag ≠ subject of the flag.

---

## 3. Core flows as workflow definitions

All four are workflow definitions (arch §10.2), P5 task-and-track with P7 overlays; activation by owner (§10.4).

### 3.1 Metric definition lifecycle (`kpi_metric_definition`)

```
draft ──submit──▶ in_review ──approve──▶ approved ──activate──▶ active ──deprecate──▶ deprecated ──retire──▶ retired
  ▲                  │ reject                                         │ new major version
  └──────────────────┘                                                ▼
                                                              (successor active; old version keeps serving frozen periods)
```
- Roles: draft = metric owner or Registrar; review = Registrar (+ MS co-sign for clinical class); approve = owner **only if** the definition's `allowed_audiences` exceeds `{self, direct_head}`; otherwise Registrar approves. Activate = Registrar, scheduled at a period boundary (IST month start) — never mid-period.
- SLA: in_review 7 days → escalates to Quality Manager → owner. Deprecated definitions must have a successor or a written retirement reason.
- Semver: **patch** = wording/description/audience narrowing; **minor** = additive (new load-normaliser, new breakdown dimension, new event name added as an *alternative* source); **major** = numerator/denominator/window/exclusion change. A major bump **never rewrites closed periods**; closed periods keep the version they were computed on and the report shows the version tag beside the number. Both versions compute in parallel for one full period ("shadow period") before the new one becomes the displayed one — the roadmap note 7 shadow-governance pattern.
- Events: `kpi.metric_defined` · `kpi.metric_version_activated` · `kpi.metric_deprecated` (all NEW) · `workflow.definition.updated` (existing) when the metric is bound to an SLA.

### 3.2 Review cycle (`kpi_review_cycle` — one instance per subject per period)

```
period_closed ──compute──▶ series_ready ──dq_pass──▶ pack_generated ──▶ self_reviewed ──▶ scheduled ──▶ held ──▶ notes_signed ──▶ acknowledged ──▶ closed
                              │ dq_fail                                     (subject sees pack first, 72 h)          │ dispute raised at any point → parallel dispute instance; cycle waits at `held`
                              ▼
                        pack_withheld_partial (pack shows "withheld — inputs N% complete" tiles; cycle continues)
```
- Roles: subject (self_review, acknowledge) · direct head (schedule, hold, sign notes) · head-of-head sees only the acknowledgement state and the KRA roll-up, not the 1:1 notes, unless escalated.
- SLA: pack within 3 days of period close · 1:1 held within 15 days · acknowledgement within 7 days of notes; breach → escalation to matron/MS/owner by family. Missed 1:1s are a **head's** KPI (`review_cadence_adherence`), not the subject's.
- Quarterly variant: OKR scoring adds `kr_scored` (auto) → `calibrated` (head adjusts with reason, evented) → `owner_reviewed` for department heads.
- Events: `review.pack_generated` · `review.held` · `review.notes_signed` · `review.acknowledged` · `okr.key_result_scored` · `okr.calibrated` (all NEW).

### 3.3 Attribution dispute & correction (`kpi_dispute`) — S10 mech. 9 generalised beyond doctors

```
raised ──triage──▶ under_review ──resolve──▶ resolved(upheld | partial | rejected) ──recompute──▶ closed
                        │ needs_evidence ──▶ awaiting_evidence (7 d) ──▶ under_review
```
- Who may raise: the subject, the metric owner, or a gaming-check reviewer. Who resolves: family reviewer (matron / MS / billing supervisor / owner per E-18 classes); for doctor-vs-doctor attribution, both doctors + MS (S10 mech. 9).
- Resolution writes a **correction event**, never edits a series row: `attribution.resolved` (existing) carrying `{from_actor, to_actor, share, effective_from}`; KPI Compute replays affected periods; the corrected number appears with a "corrected on <date>" mark and the previous value stays visible in history.
- SLA: triage 2 working days · resolution 10 working days · overall 30 days. Open disputes freeze incentive statements for the affected subject and head only (not the department).
- Events: `attribution.disputed` · `attribution.resolved` (existing, payload extended additively) · `kpi.correction_applied` (NEW).

### 3.4 Exposure grant (`kpi_exposure`) — how a number is allowed to be seen wider

```
requested(by head) ──▶ owner_review ──grant──▶ granted(scope, expiry ≤ 12 months) ──expire/revoke──▶ ended
                                     └─reject──▶ rejected
```
- Default audiences baked into every metric: `self` and `direct_head`. Anything else — department team view, cross-department comparison, a floor display, a "top performers" tile — requires a grant with **named metric versions, named audience role, an expiry, and the statement of purpose**. Team views show **distributions, not ranks** (box/strip plots with the viewer's own mark) unless the grant explicitly says `ranked: true`, which the owner must approve per metric per quarter.
- Events: `kpi.exposure_requested` · `kpi.exposure_granted` · `kpi.exposure_revoked` (NEW).

### 3.5 Incentive statement (`incentive_statement`) — monthly, one-way to HR

```
computed ──▶ preview(subject sees; 5-day dispute window) ──▶ frozen ──approve──▶ approved ──export──▶ exported_to_hr ──▶ hr_acknowledged
                        │ dispute → §3.3 instance; statement held for that subject only
```
- Inputs are events only: `commission.accrued/.reversed` (fee splits, in-house incentive head — Plan 09 payee class a), roster-derived night hours (`roster.published` + attendance-exception flags), and **rule-based** incentive components (e.g. night allowance = published night shifts × rate). **No KPI value ever multiplies into an incentive** unless the incentive rule is a *threshold gate on a department-level metric with the owner's ruling on file* (O-4). Individual KPIs are diagnostic by law.
- SoD: preparer (billing supervisor) ≠ approver (owner or finance head). Export = a signed CSV/JSON to the HR SaaS + Tally voucher reference for the payroll head; HMIS keeps the statement immutable (corrections = a reversing line next month, mirroring credit-note discipline).
- Events: `incentive.statement_computed` · `incentive.statement_frozen` · `incentive.statement_exported` · `incentive.hr_acknowledged` (NEW).

---

## 4. Data model sketch

Module folder `modules/performance/` (owns tables + manifest; subscribes to events; exposes read API `performance.getSeries()`, `performance.getPack()`; nothing else reads its tables).

| Table | Key columns (sketch) |
|---|---|
| `kpi_metrics` | `metric_id` (slug, immutable, e.g. `nursing.dose_on_time_rate`) · `family` (front_office/doctor/diagnostics/nursing/pharmacy/support/ops/governance/department/agent) · `owner_role` · `class` (operational/clinical/money/governance) · `subject_type` (user/role_at_unit/unit/department/hospital/agent) · `created_by` |
| `kpi_metric_versions` | `metric_id` · `semver` · `status` (draft…retired) · `formula` (typed JSON AST: numerator event set + filters, denominator event set, window, aggregation, exclusions) · `source_events[]` (must exist in the catalog — lint) · `attribution_rule_id` · `load_normaliser` (e.g. `per_assigned_patient_hour`, `per_shift_census`, `per_100_orders`) · `denominator_rules` (`min_n`, `zero_policy`, `small_n_policy`) · `sla_binding` (workflow def id + state) · `allowed_audiences[]` (default `[self, direct_head]`) · `direction` (higher_better/lower_better/band) · `target_default` · `gaming_check_id` · `dq_inputs[]` (which fields must be present) · `dq_threshold` (default 0.90) · `reading_text` (the diagnostic sentence shown under the number) · `activated_at` (period boundary) · `approved_by` · `shadow_from` |
| `kpi_attribution_rules` | `rule_id` · `model` (sole/shared_equal/shared_weighted/handover_split_by_time/primary_with_assist/trainee_shadow/agent_assisted) · params · `disputable` bool |
| `kpi_series` | `metric_id` · `semver` · `subject_type` · `subject_id` · `unit_resource_id?` (Plan 13) · `period_kind` (shift/day/week/month/quarter) · `period_start` · `numerator` · `denominator` · `value` · `load_ctx` JSONB (census, assigned, queue depth, shift, mode) · `completeness` · `withheld` bool · `withheld_reason` · `computed_at` · `input_event_watermark` (max `recorded_at` consumed) · `correction_seq` — **append-only; recomputes insert a new `correction_seq`** |
| `kpi_targets` | `metric_id` · scope (hospital/department/unit/role) · `target` · `band_low/high` · `valid_from/to` · `set_by` · reason |
| `kra_bundles` / `kra_items` | role → list of (metric_id, weight_for_reading_only, station/flow ref); versioned; the "responsibility bundle" of S10 |
| `okr_objectives` / `okr_key_results` | quarter · owner-set objective text · KR = metric_id + target + scope · `auto_score` · `calibrated_score` · `calibration_reason` |
| `review_cycles` / `review_sessions` / `review_notes` | mirror of the §3.2 instance; notes are **sealed-class** (subject + head + escalation chain only) |
| `evidence_packs` | `subject_id` · period · immutable JSON (series ids, breach links, kudos events, disputes, load summary) · `hash` · `generated_by` (automation identity) |
| `kpi_disputes` | §3.3 instance mirror · `subject` · `metric_id` · `period` · `claim` · `evidence_refs[]` · `resolution` · `share_from/to` |
| `kpi_exposure_grants` | metric versions[] · audience role · scope · `ranked` bool · purpose · expiry · granted_by |
| `kpi_gaming_checks` | `check_id` · metric_id · detector (typed rule: clustering, edit-distance-to-close, refusal-rate delta, ordering ratio, referral concentration…) · reviewer role · threshold · last_run |
| `kpi_dq_snapshots` | per series: which inputs missing, backfill pending count, downtime windows overlapped, clock-skew flags |
| `incentive_rules` / `incentive_statements` / `incentive_lines` | rule kind (fee_split_passthrough/night_allowance/department_gate) · statement per subject per month · immutable lines · export hash · HR ack ref |
| `kpi_staff_notices` | version of the staff data notice (DPDP) · per-user acknowledgement · coaching opt-in state |

**Registry resource kinds needed (Plan 13):** none new; uses `ward/hall/theatre/bench/analyzer/room` as denominator scopes. **FHIR:** not clinical; no FHIR shape. **Statutory registers:** none owned here — but NABH quality indicators (§7) are *derived views* over the same series, version-tagged. **Retention:** series and packs 8 years (align with financial/incentive records; employee-related retention under Shops & Establishments/labour rules varies by state — 3 years minimum); review notes 3 years after separation then purge; coaching-nudge content 90 days then purge; gaming-check flags follow Fraud Sentinel retention; DQ snapshots 2 years.

---

## 5. Edge-case catalogue

Format: **ID · scenario → required behaviour → proving test/assertion → ruling ref.** Rows are about KPI correctness and fairness.

### A. Attribution — who owns the work

| ID | Scenario → behaviour → test → ruling |
|---|---|
| A1 | Two consultants see the same IPD patient (primary + cross-consult). ALOS/outcome KPIs attribute to primary; consult TAT to the consultant; fee-split follows the accrual ledger (§11.4 map 5) → test: one encounter, two `consult.completed`, series for each doctor count the right events only. |
| A2 | Doctor change mid-stay with handover note → `doctor.changed` splits the stay at `occurred_at`; each doctor's ALOS share is time-weighted; readmission within 30 d attributes to discharging doctor → test: change on day 3 of 7 → 3/7 vs 4/7 shares. |
| A3 | Doctor change **without** handover note (arch map 5 requires one) → attribution stays with the first doctor and a `kpi.attribution_unverified` (NEW) flag opens a dispute pre-filled; not silently reassigned → test: no note ⇒ no split. |
| A4 | Nurse A hands over to Nurse B mid-shift (early departure) → `handover.completed` timestamp splits assignment spans; a dose due at 14:00 given at 14:20 after a 14:10 handover counts against B's on-time rate **only if** the order was visible to B ≥ 10 min (grace param) → test: parameterised grace boundary. |
| A5 | Float/pool nurse covers two wards in one shift → load context = union of assigned patients with time overlap; denominator per ward uses only the span present; the nurse's own view shows both wards → test: two `assignment.started` spans, no double counting of patient-hours. |
| A6 | Trainee/intern performs under supervisor → `trainee_shadow` rule: the act attributes to the trainee for learning KPIs (private, self+educator audience only) and to the supervisor for accountability KPIs; never both in one department roll-up → test: department sum equals unique acts. |
| A7 | Phlebotomy sample rejected in lab: collection-attributable vs lab-attributable separated by `sample.rejected.reason_class` (S10 card 17/36) → test: hemolysed → collector; mislabelled at accession → lab. |
| A8 | Task claimed from a pooled queue by porter X, completed by porter Y (re-claim after X's device died) → `task.assigned` chain; TAT attributes to the last claimant, the abandoned-claim count attributes to X as a *diagnostic* with device-offline context → test: two claims, one completion. |
| A9 | Agent drafts a discharge summary; doctor edits and signs → doctor's "discharge documentation TAT" measures order→sign; **edit distance is the agent's KPI** (arch §11.19-C) and never appears on the doctor's card → test: `draft.acceptance_recorded` excluded from human subject series by lint. |
| A10 | Agent (T4 Replenishment) raises indents that a storekeeper used to raise → storekeeper's "issue TAT" denominator drops; the KPI shows the A2→A3 model tag in load context and the KRA line for indenting is retired for the role (S10 §1) → test: model switch event re-scopes KRA bundle version. |
| A11 | Two clerks share a login (shift overlap at a busy counter) → registration-time KPI attributes to the session actor; `activity_attendance.mismatch` fires when the biometric says the actor was off-site → both clerks' numbers marked `attribution_uncertain` → test: mismatch flag suppresses ranking eligibility for that day. |
| A12 | Referral attribution to an in-house doctor is unverified (fix 17) → counts in "referrals received" KPI only when verified; unverified shown as a separate grey count → test: `attribution.unverified_flagged` excluded from numerator. |
| A13 | Patient merge (`patient.merged`) after month close collapses two encounters → per-patient KPIs (readmission, duplicate-UHID rate) recompute with a correction seq; the duplicate-UHID KPI charges the registering clerk of the *later* record → test: merge after close creates `correction_seq=2`. |
| A14 | Unmerge reverses that → symmetric recompute; both corrections visible in history → test: value returns to seq-1 value with seq 3. |
| A15 | Locum/temp role (`temp_role.granted`) works 3 days → subject exists for those days only; small-n policy suppresses rate KPIs; only counts shown → test: n<`min_n` ⇒ value null, count visible. |
| A16 | Same doctor works OPD (employee) and visiting panel (fee-split) → two `subject_type` bindings: `user` for KPIs, `referrer` for accrual; one identity, two ledgers; the KPI card never shows money → test: no join from `kpi_series` to `commission_accruals` exists. |
| A17 | Nurse performs a witnessed act (narcotic issue) — issuer and witness both evented → issuer's KPI counts the issue; witness's "witness availability" counts separately; never "both did the dose" → test: dose count = 1. |
| A18 | Agent-assisted registration (kiosk pre-registration, clerk verifies) → registration-time KPI measures clerk verification span only; kiosk span attributes to the kiosk automation's own KPI → test: two actors, two series. |

### T. Timing, clocks & concurrency

| ID | Scenario → behaviour → test → ruling |
|---|---|
| T1 | Ward tablet clock is 40 min ahead → server stamps `recorded_at`; `occurred_at` from device is compared to server receipt; skew > 5 min flags the event `clock_skew` and the KPI uses server time for *that* event, marking the series `dq: clock_skew_n` → test: skewed event doesn't create a negative TAT. |
| T2 | Backfilled downtime events with `occurred_at` days earlier → KPI series for that closed period recompute (correction seq) after backfill completes; the pack notes "recomputed after downtime backfill" → test: backfill ⇒ recompute of the *occurred* period, not the recorded one. |
| T3 | Backfill still incomplete when the monthly pack generates → DQ gate withholds affected tiles; shows count of pending backfill rows (`downtime.ended` without `backfill.completed`, NEW) → test: withheld while pending > 0. |
| T4 | Shift straddles midnight (night 20:00–08:00) → shift-period KPIs use roster shift windows, not calendar days; daily roll-ups allocate by `occurred_at` day; both shown consistently → test: a 02:00 dose belongs to the night shift that started yesterday. |
| T5 | IST vs UTC storage → all period boundaries computed in `Asia/Kolkata`; the DST-free zone still has boundary bugs at month end; test with 31-Mar 23:59:59 IST event. |
| T6 | Two events with identical `occurred_at` for order and result (analyzer batch push) → TAT = 0 is legal but flagged if > X% of a series → gaming/DQ check `zero_tat_share`. |
| T7 | Late `result.verified` arrives after period close (7 days late, valid) → correction seq; TAT counted where it occurred; the "late-arriving share" itself is a DQ metric per department → test: watermark advance triggers recompute only for affected subjects. |
| T8 | Concurrent recompute (nightly full + hourly incremental) → per-(metric,subject,period) advisory lock; the second run sees the first's watermark and no-ops → test: parallel runs produce one correction row. |
| T9 | Event redelivered by dispatcher → compute is idempotent on `event_id` set hash; same inputs ⇒ same value, no new correction seq → test: replay same batch twice. |
| T10 | Metric version activated mid-month by mistake → engine refuses activation not on a period boundary; a forced activation (owner) creates a split period marked as such → test: activation date validation. |
| T11 | Workflow definition changes SLA from 30 to 20 min mid-quarter → SLA-compliance KPI binds to the *definition version that governed each instance*; the series shows a version mark; comparison across versions is labelled → test: mixed-version month computes per instance. |
| T12 | Roster published late (after shift began) → assignment spans reconstructed from `roster.published` with `effective_from`; until then load context = "unknown roster" and the rate KPI is withheld for that shift → test: late publish ⇒ withheld shift row. |

### D. Denominators, statistics & fairness

| ID | Scenario → behaviour → test → ruling |
|---|---|
| D1 | Denominator zero (no doses due on a nurse's shift) → value `null`, rendered "no activity", never 0% or 100%; excluded from averages → test: null propagation. |
| D2 | Low volume (n=3 registrations on a Sunday) → `min_n` per metric (default 20 per period for rates); below: show count + "insufficient volume"; trend charts pool weeks until n reached → test: pooling boundary. |
| D3 | Simpson's paradox: Nurse A has better on-time rate on both day and night shifts than B, but worse overall because A works more nights (harder) → the roll-up always shows the **stratified** view by shift and a load-adjusted composite (direct standardisation to the department's shift mix) beside the crude rate; crude never shown alone → test: constructed fixture where crude and standardised disagree in sign; UI asserts both present. |
| D4 | Floor with higher acuity (ICU step-down) vs general ward → comparisons only within `unit_class` peer groups defined in the registry; cross-class comparison requires an exposure grant with `peer_group_override` → test: peer set computed from Plan 13 `class`. |
| D5 | OPD consultant throughput: 40 patients in 4 h vs 12 complex patients → throughput shown per booked-slot and per assigned queue, with median consult minutes; never a raw count tile alone (S10 fairness) → test: series has `load_ctx.queue_depth`. |
| D6 | Cashier collections/session compared across a cash-heavy desk and a UPI-heavy desk → tender mix in load context; variance rate is the primary; collections is context-only → test: metric direction = `context`. |
| D7 | Ratio KPI where numerator events can exceed denominator (re-collections > samples on a bad day) → cap policy per metric (`ratio_cap` = 1 or none, declared) → test: declared cap applied. |
| D8 | Percentile KPIs (median TAT) on skewed distributions with outliers (one 3-day-lost sample) → show median and P90; mean never used for TAT; outliers listed in the pack as links → test: mean absent from schema for TAT class. |
| D9 | Target set at hospital level applied to a department with different case mix → targets scoped; a missing scoped target inherits with an "inherited" tag; heads propose their own → test: inheritance chain. |
| D10 | Fairness across gender/night rules: women's night-shift constraints (S10 mech. 17) reduce night exposure → night-weighted KPIs never compared without shift stratification; roster-legal constraints are load context, not deficits → test: stratified only. |
| D11 | New joiner's first 60 days (S10 mech. 14 ramp) → series tagged `probation`; excluded from team distributions; own view shows a "ramp" band → test: exclusion by `joined_at`. |
| D12 | Rounding: 19/20 = 95.0%; display rounding never crosses a target boundary silently (94.96% shown as 95.0% but flagged "below target") → test: comparison on raw value. |
| D13 | Weighted composite KRA score requested by a head ("give me one number") → composites are *reading aids* with weights visible and no rank; the number carries the version of the weight set → test: composite recomputes when weights change with a new version, closed periods frozen. |
| D14 | Seasonal dengue surge doubles lab volume → TAT KPI shows against the period's load band; the target auto-widens only if an owner-approved `surge_target_policy` exists; otherwise target unchanged and the surge context banner appears → test: `disaster.declared`/`overload.flagged` windows present in load_ctx. |

### G. Gaming vectors & formula defences

| ID | Scenario → behaviour → test → ruling |
|---|---|
| G1 | Cherry-picking easy patients (a consultant's assistant routes complex cases to a colleague) → case-mix index in load context; "complex share" per doctor vs department; drift > 2σ flags to MS via gaming check `case_mix_drift` → test: synthetic routing skew flags. |
| G2 | Closing housekeeping tasks early (mark complete before cleaning) → `task.verified` is the numerator, not `task.completed`; complete-to-verify gap and verifier concentration checked; random re-verification sampling → test: unverified completes do not count. |
| G3 | Deferring difficult discharges past month-end to protect ALOS → ALOS computed on `patient.discharged` occurrence; discharge-ready-but-not-discharged span (arch note 10 watcher) is its own KPI; a spike of discharges on the 1st flags `period_edge_clustering` → test: clustering detector on day-of-month histogram. |
| G4 | Under-reporting incidents to keep fall rate low → incident rate is **never** a lower-is-better individual KPI; it is department-level with *reporting rate* as the higher-is-better companion (NABH culture standard); a ward with zero incidents and high census flags for review → test: `direction=band`. |
| G5 | Over-ordering to hit "same-day result review closure" or revenue → orders-per-encounter vs specialty peer band; result-review closure denominator = results, so ordering more does not help; over-ordering flag to MS → test: numerator/denominator both scale. |
| G6 | Referral gaming (self-referral loops, ghost referrals — arch Fraud Sentinel scope) → referral-received KPI counts verified only (fix 17); Sentinel owns the loop detection; the KPI card links the flag → test: unverified referrals never in numerator. |
| G7 | Dose "given" scanned in bulk at 06:00 for the night → scan-time clustering check (S10 §2 example): inter-scan gaps < physiological minimum flag → test: 12 scans in 90 s flags. |
| G8 | Cashier voids and re-issues to reset a session variance → variance is on `cashier_session.closed` reconciled against tenders; voids are a separate diagnostic count; re-issue pattern flags to billing supervisor → test: void ratio check. |
| G9 | Registration clerk skips demographics to hit median time → completeness KPI is paired (S10 card 1); time KPI only counts registrations with completeness ≥ threshold → test: incomplete rows excluded from time numerator. |
| G10 | Lab tech overrides QC lockout to keep TAT → `qc.override_recorded` is a hard-negative event on the QC KPI and TAT gains are neutralised (TAT for results published under QC override excluded) → test: override ⇒ excluded from TAT. |
| G11 | Doctor sets follow-up dates aggressively to inflate "follow-up conversion" → conversion measured against clinically-typed follow-up reasons; follow-up density per patient vs peer band flags → test: density check. |
| G12 | Sonologist closes scans without Form F to protect TAT → module blocks close (roadmap mini-OT fact 2); KPI cannot be gamed because the event cannot occur; test lives in Plan 18. |
| G13 | Nurse marks `medication.refused` to avoid a late dose → refusal rate delta per nurse vs ward; refusal without a documented reason flags → test: refusal-rate detector. |
| G14 | ER physician re-triages to lower category to meet the 5-min clock → `er.retriaged` count and direction is a diagnostic; downgrades within 2 min of a breach flag → test: retriage-near-breach detector. |
| G15 | Pharmacist marks substitution as "policy" to avoid stock-out variance → substitution reasons typed; `policy` share vs stock-out events cross-checked → test: substitution without a corresponding `stock.below_reorder` flags. |
| G16 | Agents gamed: a T2 drafter learns that shorter drafts get accepted faster → acceptance rate paired with entailment/coverage eval (12a); cost-per-outcome (note 14) → test: agent KPI pair rule. |
| G17 | Head sets targets low to make the team look good → targets versioned, visible to owner with history; quarter-over-quarter target movement is a governance KPI → test: target change evented. |
| G18 | Staff collude to swap assignments so hard patients rotate to the float → assignment churn per patient flags; load context carries acuity → test: churn detector. |

### Q. Downtime, data quality & partial failure

| ID | Scenario → behaviour → test → ruling |
|---|---|
| Q1 | A metric's source event stops arriving (module bug, dead consumer) → DQ gate sees zero events against a non-zero roster and withholds; `kpi.series_withheld{reason: source_silent}` → task to Registrar; never renders 100% on-time because nothing was recorded → test: silent source ⇒ withheld. |
| Q2 | Completeness 87% (below 90% threshold) → tile shows "withheld — inputs 87% complete" with the missing input names; the head can still open the raw counts → test: threshold boundary 89.9/90.0. |
| Q3 | Worker down for a day → series computed late; `computed_at` shown; digest says "figures as of <watermark>" → test: watermark in digest fact sheet. |
| Q4 | Paper-path shift (floor-scoped downtime) → the whole shift for that floor is `mode: downtime`; rate KPIs withheld; counts from backfill shown once `backfill.completed` → test: mode window overlap. |
| Q5 | Partial backfill: some doses backfilled with `occurred_at` = the backfill time (lazy entry) → clustering detector on backfilled events with identical timestamps → DQ flag `backfill_time_collapsed`; those events excluded from on-time computation, kept in counts → test: identical-occurred detector. |
| Q6 | Event schema v2 minted for `task.completed` → formula AST references event name + min version; compute reads both; lint fails activation if a referenced field is absent in either version → test: schema compatibility lint. |
| Q7 | Event catalog renames (e.g. a NEW event later folded) → registry references catalog ids, not free text; catalog lint runs on every metric version → test: unknown event name blocks draft→review. |
| Q8 | Recompute storm after a large correction (patient merge touching 400 encounters) → bounded batch with priority to current period; older periods queued; digest notes "historical recompute in progress" → test: batch cap. |
| Q9 | Series row exists but the formula version was retired → read API returns it with `retired` tag; never silently maps to the successor → test: version pinned on read. |
| Q10 | Roster feed absent (roster module not yet built — today) → load normalisers requiring assignment fall back to *unit-level* denominators with a `normaliser: fallback_unit` tag; individual rate KPIs needing assignment are withheld until the roster module ships → test: fallback tag. **Ruling O-2.** |
| Q11 | Event with null `actor` (system) counted as a human's work → lint: human-subject metrics filter `actor.kind = user`; system/agent actors go to agent metrics → test: actor filter. |
| Q12 | `site_id` gains a second value (branch) → every series is site-scoped from day one (`site_id` column present, default `main`) → test: schema has site_id. |

### M. Money, incentives & the HR boundary

| ID | Scenario → behaviour → test → ruling |
|---|---|
| M1 | Fee-split accrual reversed by refund after the incentive statement was exported → next month's statement carries a reversing line with reference; never edits the exported one → test: reversal line. |
| M2 | Owner wants a KPI-linked bonus for nurses ("95% on-time earns ₹X") → refused by default law; the only allowed shape is a **department-level gate** (O-4) so no individual is paid per metric; reason on file → test: `incentive_rules.kind` enum has no `individual_kpi` value. |
| M3 | Counter clerk gets membership-sale incentive → forbidden (fix 32); rule validator rejects any incentive rule whose subject role ∈ {registration, cashier, admission} and source ∈ {membership.sold} → test: validator. |
| M4 | Night allowance computed from roster but HR attendance shows absent → attendance-exception import (mech. 7 T0 report) marks the line `disputed_by_attendance`; HR decides; HMIS never zeroes it automatically → test: line status only. |
| M5 | Visiting consultant's fee split — an external RMP referral (class c) → payout structurally OFF (fix 1); statement shows attribution captured, amount 0, reason `class_c_blocked` → test: class c ⇒ 0. |
| M6 | TDS/PAN for fee splits → belongs to Payouts pack; the incentive statement carries only the accrual ids; no tax computation here → test: no tax columns. |
| M7 | Doctor asks to see accrual live (mech. 24) → per-doctor accrual dashboard is a Plan 09 read model, linked from their KPI workspace but not a KPI → test: separate route/permission. |
| M8 | Statement exported twice (retry) → idempotent on `(subject, period, statement_hash)`; HR ack references the hash → test: duplicate export rejected. |
| M9 | HR SaaS changes file format → adapter with versioned column map; failure loud; statements stay frozen → test: format drift error. |
| M10 | A department gate metric is withheld by DQ in the month it would have paid → gate evaluates as "undetermined"; payment waits for recompute or an owner decision; never defaults to paid or unpaid silently → test: tri-state gate. |
| M11 | Revenue/bed and leakage appear in a doctor's view → forbidden audience: money-class department KPIs default audience = {owner, finance, department head}; a doctor sees clinical/operational only → test: audience matrix. |

### P. Privacy, DPDP, legal & staff-as-subject

| ID | Scenario → behaviour → test → ruling |
|---|---|
| P1 | Staff member requests their own KPI data (DPDP §11 right to access) → self-view + export of their series and packs in machine-readable form within 72 h; review notes included; gaming flags included with disposition → test: self export route. |
| P2 | Staff requests correction (DPDP §12) → routed as a dispute (§3.3); the correction trail is the response → test: dispute from self-view. |
| P3 | Staff exits → series retained per §4 retention; self-view access revoked at `exit.completed`; a copy of their packs can be requested through HR → test: revoke on exit. |
| P4 | D-36 engagement signals (time-on-draft, edits) and Honcho impressions → **never joinable** to `kpi_series`; lint forbids imports across the boundary; the only agent-side use is the calibration record (note 17) → test: import lint. |
| P5 | Head tries to view a colleague-head's team → RBAC scope = own department; cross-department requires a grant → test: 403. |
| P6 | Leaderboard on a ward TV → not possible without a grant with `ranked: true` + `display: public` — and public display of individual staff KPIs is **never allowed** (audience enum excludes `public_display`) → test: enum. |
| P7 | KPI evidence used in a disciplinary/legal proceeding → packs are immutable and hashed; the hospital's HR policy (HR SaaS side) governs use; the HMIS records `evidence_pack.exported{purpose}` → test: purpose required on export. |
| P8 | Coaching nudge content is private; a head asks the Registrar for it → no read path exists (mirrors D-36 structure); aggregate opt-in counts only → test: no route. |
| P9 | Staff-as-patient: a nurse admitted to her own ward → her patient events are sealed-class; KPIs computed for *colleagues* over that patient must not leak identity into packs (pack shows encounter token only) → test: sealed encounter tokenised in evidence links. |
| P10 | VIP patient's encounter in a doctor's evidence pack → link resolves only with the viewer's own permission; alias on the pack → test: alias rendering. |
| P11 | Staff notice (copilot §3.3 pattern) not acknowledged → KPI self-view still works (you cannot hide a person's own data from them) but coaching opt-in is blocked until acknowledged → test: gate on opt-in only. |
| P12 | POSH/grievance-related events (mech. 17) → never a KPI input; lint blocks any formula referencing grievance events for human subjects → test: banned-event list. |
| P13 | Anomaly flag on a person turns out false → flag closes `rejected`; the person's pack shows "1 flag, closed — no finding"; flags never count in any KPI → test: flags not in numerators. |

### I. Identity & wrong-subject

| ID | Scenario → behaviour → test → ruling |
|---|---|
| I1 | Two nurses with the same name; roster assigns by name in a spreadsheet import → subjects are `user_id` only; roster import must resolve to ids or fail per row → test: name never a key. |
| I2 | A user holds two roles (RMO by day, duty manager by night) → series per (user, role_at_unit); the person's own view shows both cards; department roll-ups count the role → test: role-scoped series. |
| I3 | Shared "ward tablet" generic login → events from generic actors attribute to no person; the ward's KPI shows `unattributed_share`; a rising share is the in-charge's diagnostic → test: generic actor class. |
| I4 | Agent identity misused (human using an agent API key) → symmetric surveillance (arch); events with agent actor from a human IP pattern flag; KPI excludes → test: Sentinel hook. |
| I5 | User id reused after deletion (should be impossible with ULIDs) → assert ULID; no reuse. |

### S. Staff lifecycle, absence, overload & handover

| ID | Scenario → behaviour → test → ruling |
|---|---|
| S1 | `overload.flagged` on a nurse's shift (1:12 instead of 1:6) → that shift's rate KPIs carry an `overload` context and are excluded from the composite by default (mech. 13: overload must not mask understaffing — the *in-charge's* roster KPI shows it) → test: exclusion + in-charge attribution. |
| S2 | Maternity leave / long leave → subject paused; no empty periods rendered; ramp band on return → test: pause spans. |
| S3 | Head on leave during 1:1 window → review cycle escalates to the deputy per succession chain (mech. 16); the head's cadence KPI is not charged for the leave span → test: succession resolution. |
| S4 | Mid-shift departure (mech. exceptions) → open tasks return to pool; abandoned tasks do not count as failures for the departing person if `handover.forced` evented → test: forced handover context. |
| S5 | Staff on probation refuses to acknowledge the pack → cycle stays at `notes_signed` with a 7-day SLA; escalation to matron/MS is a conversation trigger, never an auto-mark → test: no auto-acknowledge. |
| S6 | Succession: the only radiologist is the subject *and* the only reviewer for radiology KPIs → reviewer resolves up the chain (MS) → test: self-review blocked. |
| S7 | Ramp-mode (mech. 29): legacy lab staff not yet absorbed → their KPIs are inactive until the area absorption date; series before that date never exist → test: activation date per area. |

### X. Scale & performance

| ID | Scenario → behaviour → test → ruling |
|---|---|
| X1 | 2,000 OPD/day × ~40 events each ≈ 80k events/day; nightly compute over 30 days for ~1,500 subjects × ~60 metrics → incremental compute by watermark; full recompute < 20 min budget on the stage-2 host; series table partitioned by month → perf test in plan. |
| X2 | Digest fact sheet must build in < 5 s at 8 a.m. → precomputed at 07:30 by the worker; digest reads a snapshot → test: build time budget. |
| X3 | Self-view page for a nurse: < 300 ms (arch §15) → series read by (subject, last 6 periods) index → perf test. |
| X4 | Formula AST evaluation is data-driven → compiled to SQL with an allowlist of aggregations; no arbitrary SQL in the registry → test: AST validator rejects raw SQL. |
| X5 | 100 metric versions × 6 subjects types → registry lint runs in CI against the event catalog — a metric naming a non-existent event fails the build → test: CI lint. |

### N. Integrations & dependencies

| ID | Scenario → behaviour → test → ruling |
|---|---|
| N1 | Patient feedback/NPS arrives via WhatsApp reply (Plan 10 inbound adapter, note 2) → `feedback.received` with encounter ref; NPS attributes to department and (for doctor-specific questions) to the consultant with n≥30 before display → test: min_n on NPS. |
| N2 | Biometric attendance export from HR SaaS is late → mech. 7 reconciliation report runs on whatever arrived; missing days listed; never blocks compute → test: absent import ⇒ report partial. |
| N3 | Roster module ships later and changes assignment granularity (per-patient vs per-bay) → normaliser versioned; new minor version with new normaliser; old periods keep old → test: normaliser version pin. |
| N4 | Tally voucher export for incentive heads → via Payouts pack; this module emits a reference only → test: no Tally code here. |
| N5 | NABH indicator submission (quarterly) → derived view over versioned series with the version list attached → test: version list in export. |

### R. Disputes & corrections

| ID | Scenario → behaviour → test → ruling |
|---|---|
| R1 | Dispute raised on a closed quarter after OKR scoring → resolution recomputes; OKR auto-score updates with a `rescored` mark; calibrated score stays unless the head re-calibrates → test: rescoring path. |
| R2 | Both doctors dispute the same encounter in opposite directions → single dispute instance with two parties (mech. 9) → test: dedupe by (encounter, metric). |
| R3 | Dispute filed against a withheld tile → allowed (dispute the withholding); Registrar resolves DQ → test: dispute on withheld. |
| R4 | Resolution changes an accrual-eligible attribution → the accrual ledger is informed via `attribution.resolved` (Plan 09 consumer already subscribes? — verify; if not, NEW consumer in Payouts pack), never edited by this module → test: no ledger writes. |
| R5 | Dispute spam (one person raises 40) → per-actor rate limit with a review by the family reviewer; disputes are never punitive but volume is a diagnostic for the head → test: rate limit. |
| R6 | Correction applied to a period already exported to NABH → export marked superseded; re-export offered; history keeps both → test: superseded export. |

### AG. Agents in the loop

| ID | Scenario → behaviour → test → ruling |
|---|---|
| AG1 | Digest Writer hallucinates a trend not in the fact sheet → typed-claim contract with line citations (copilot §2.4 pattern); uncited claims dropped; digest shows "N claims dropped" → test: citation guard fixture. |
| AG2 | Anomaly Explainer names a person as "the cause" → output schema forbids person-level causal language; only "series X moved; load context Y changed; question to ask" → test: schema + banned-phrase eval. |
| AG3 | Coaching Nudge sends a nudge during a declared surge → suppressed when `overload.flagged`/`disaster.declared` window overlaps → test: suppression window. |
| AG4 | Global halt → dashboards still render series (automations under the harness stop only inference? **No** — global halt pauses every agent and automation (arch §16); the read of already-computed series still works; digest shows "compute paused") → test: halt ⇒ stale-with-banner. |
| AG5 | Agent KPIs themselves (acceptance, edit distance, cost-per-outcome, abstention rate) registered in the same registry, subject_type `agent` → test: agent subject series. |
| AG6 | Workflow Tuner proposes an SLA change citing KPI baselines → proposal carries metric version ids; activation via owner (§10.4) → test: proposal references. |

**Row count: 102.**

---

## 6. Chaos scenarios — day-in-hell walkthroughs

**C1 — Month-end with a 3-day floor downtime in the middle (paper eMAR on Ward 2, 27th–29th).** 30th 23:00 worker starts the monthly compute; Ward 2's nursing series for 27–29 have zero `medication.administered` events. DQ gate: roster shows 9 nurses on duty, events zero ⇒ `source_silent`; tiles withheld. 1st 07:30 digest fact sheet: "Ward 2 nursing KPIs withheld (downtime backfill pending: 412 paper rows)". Humans: in-charge's team keys the paper MAR by the 3rd (`occurred_at` from paper). 3rd 23:00 `backfill.completed` → recompute of the *August* period, correction seq 2; packs regenerate; 1:1s already scheduled see the updated pack with a "recomputed after backfill" banner. Q5 detector runs: 60 doses share the timestamp 03/09 14:00 (lazy entry) ⇒ excluded from on-time, counted in counts; in-charge gets a DQ task, not a nurse. Audit: `downtime.declared/.ended`, `backfill.completed`, `kpi.series_withheld`, `kpi.correction_applied`, pack hashes v1 and v2.

**C2 — A department head builds a leaderboard by screenshot.** OT head exports his team's monthly pack tiles and posts a ranked WhatsApp image. System: could not prevent the screenshot; but the exposure log shows no grant, the packs are per-person so the head had to open 12 self-views (`evidence_pack.viewed` by head, 12 in 4 minutes → an access-pattern report to the Quality Manager, E-18 class governance). Owner ruling O-3 defines the norm; the Registrar's task is a conversation, not a lock-out. Afterwards: the head requests a grant for a *distribution* view; owner grants unranked for one quarter.

**C3 — Server down 6 h on a Monday; hourly live tiles stale.** Ward boards show "as of 09:10" banners; no KPI is computed from partial hours; when the server returns the incremental compute replays from the watermark; the OPD wait KPI for that Monday carries `mode: downtime 09:10–15:20`; SLA breaches during the window are recorded on backfill with `occurred_at` from paper token slips; Front-office supervisor's wait-SLA compliance for the day is withheld; the weekly rollup shows the day with a hatch pattern. Agents: SLA Chaser was silent (fail-open); Digest Writer's Tuesday digest cites the downtime event.

**C4 — Mass-casualty (bus accident, 38 arrivals in 40 min), `disaster.declared`.** ER triage <5 min compliance collapses to 40%; door-to-disposition medians triple. Compute: the disaster window is load context; ER physicians' series for that shift tagged `disaster`, excluded from composites by default, kept as a separately-labelled row "disaster-mode performance" with its own reading text ("this is what the team did under mass casualty"). The MS's quarterly review shows it as evidence of capability, not deficit. Nothing withheld — the data is real; only the *comparison* is suppressed. Gaming check `retriage_near_breach` is suppressed inside the window (retriage is legitimate in MCI).

**C5 — Wrong clock on the new lab analyzer edge box (+9 h) for two weeks.** Result TATs go negative; T1 rule flags `clock_skew` on every event from that source; the lab TAT series falls under DQ threshold (skewed share 35%) ⇒ withheld; Registrar task; biomedical fixes NTP; a correction run recomputes with server-side `recorded_at` for skewed events (declared per metric as the fallback); the two-week period keeps a `clock_fallback` tag forever; NABL indicator export for the quarter carries the note.

**C6 — Attribution war: two consultants, one VIP patient, an MLC, and a fee-split dispute in the same hour.** VIP admitted under Dr A; Dr B takes over after a family complaint; no handover note. A3: attribution stays with A and `kpi.attribution_unverified` opens a pre-filled dispute. MLC flag → the encounter is sealed-class; the dispute UI shows the encounter token, not the name. Dr B claims the fee split; accrual ledger holds (Plan 09 verification gate); MS resolves in 6 days with both doctors present (mech. 9); `attribution.resolved{share A:0.4, B:0.6, effective_from}`; KPI series recompute; accrual consumer picks up the resolved share (R4 — verify consumer). Audit: dispute instance, sealed access log on the VIP record, two `evidence_pack` versions.

**C7 — A3 switch: Turnover Dispatcher goes T4 on Floor 3.** Housekeeping supervisor's "dispatch latency" KPI becomes meaningless (an agent dispatches). KRA bundle for the role gets a new version: dispatch line retired, "verification audit quality" and "re-dispatch exception handling" added; the agent gets `dispatch_latency` as its own metric. The switch date is a period boundary; the supervisor's pack shows "role model changed A2→A3 on 1 Nov; 3 KRA lines re-based". Fairness: no comparison across the boundary.

---

## 7. Compliance, audit & statutory surfaces

- **DPDP Act 2023 — staff as data principals.** KPI series, packs, notes and nudges are personal data of employees. Purpose limitation: "performance diagnostics informing human review"; a **staff data notice** (versioned in `kpi_staff_notices`) states what is computed, who sees it (self, direct head, escalation chain; wider only by grant), retention, rights (access §11, correction §12 via disputes, grievance to the DPO — Quality Manager dual-hat, mech. 20). Employee data processing for employment purposes has a legitimate-use basis (§7(i)); the notice is still issued. **D-36/copilot §3.3**: engagement signals and impressions never enter this module (P4). DPIA line item: staff-KPI processing, gaming checks (profiling-like), and any inference agent reading staff series (Digest Writer, Explainer, Coaching Nudge) — the Explainer and Nudge read staff-identified data, so they are **Class-1-like for staff** and need the DPIA line before activation even though no patient PHI is involved.
- **NABH (5th ed.) quality indicators** — derived views: OPD wait, lab/radiology TAT, medication errors, falls, HAI rates (CAUTI/CLABSI/VAP/SSI), return to OT, ICU readmission, mortality (crude + expected where scoring exists), patient feedback, incident closure. Each indicator maps to metric ids + versions; the assessor gets the definition page (formula, source events, version history) — the registry *is* the indicator manual. Continual Quality Improvement standards ask for staff appraisal linkage; the answer is the review cycle records, not KPI-pay linkage.
- **Clinical Establishments Act** — no direct KPI obligation; records retention aligns.
- **Labour law** — Shops & Establishments / Factories-type rosters (mech. 5/17) are roster module concerns; this module must not compute anything that pressures night-shift rules (D10).
- **IMC Professional Conduct Regs cl. 6.4** — no KPI or incentive may reward referral volume from external RMPs (M5, G6).
- **Income tax** — incentive statements are inputs to payroll; TDS is HR/Tally; the HMIS holds the accrual trail (§7 Payouts pack).
- **Registers as tables:** none statutory here; `kpi_metric_versions` is the indicator manual; `incentive_statements` is the evidence for payroll heads; `kpi_disputes` is the grievance-of-attribution register.
- **What an auditor asks:** "show me the definition of ALOS and when it changed" (version page) · "show me this nurse's data and who saw it" (`evidence_pack.viewed` log) · "prove no one is paid per KPI" (incentive rule enum + owner ruling) · "show the incident reporting rate alongside incident rate" (G4).
- **Retention:** §4.

---

## 8. Staff KPI & KRA — the registry content

### 8.1 Registry entry shape (worked example)

```
metric_id: nursing.dose_on_time_rate           semver: 1.2.0        class: operational   family: nursing
subject_type: user (role_at_unit: staff_nurse @ ward resource)   period: shift, day, month
numerator: count(medication.administered where |occurred_at − due_at| ≤ 30 min, actor = subject)
denominator: count(medication.due for patients in subject's assignment span, excluding medication.refused with reason, excluding orders visible < 10 min before due)
window: assignment spans from roster.published ∩ handover.completed splits
load_normaliser: per_assigned_patient_hour ; shown with census, assigned count, overload flag
denominator_rules: min_n 20 (shift-pooled to reach); zero → null
sla_binding: workflow eMAR / state "dose_due" (Plan IPD nursing)
allowed_audiences: [self, direct_head]           direction: higher_better   target_default: 0.95
gaming_check: scan_time_clustering(min_gap 45 s) → reviewer matron
dq_inputs: [medication.due, medication.administered, roster.published]  dq_threshold 0.90
reading_text: "Doses given within 30 min of due. Read with census and overload; a low shift usually means a staffing or supply problem, not a person problem."
```

### 8.2 Per-role KPI sets (formula, normaliser, SLA link, diagnostic reading) — condensed; S10 cards carry the targets

| Role (card) | KPIs (id · numerator/denominator · normaliser · SLA link) | Diagnostic reading · gaming pair |
|---|---|---|
| Registration clerk (1) | `fo.registration_median_min` (patient.registered − visit.opened, complete rows only · per shift arrivals) · `fo.duplicate_uhid_rate` (patient.merged later / registered) · `fo.demographic_completeness` · `fo.abandonment` | slow = queue or device; dupes = search UX · G9 completeness pairing, mech. 18 false-attach |
| Cashier (3) | `money.variance_rate` (cash_variance.recorded / sessions) · `money.refund_tat` · `money.upi_match_rate` · `money.collections_ctx` (context only) | variance = training/float issues · G8 void-reissue |
| OPD consultant (8) | `doc.consult_throughput_ctx` (per booked slot + queue) · `doc.same_day_result_review` (result.acknowledged same day / result.published) · `doc.rx_alert_override_rate` (with reasons) · `doc.followup_conversion` | overrides with reasons are fine; none ever is the flag · G1, G5, G11 |
| RMO (9) | `doc.escalation_ack_time` (escalation.triggered → acknowledged) · `doc.verbal_order_countersign_in_window` · `doc.rounds_completion` | slow ack at night = coverage · retriage n/a |
| ER physician (10) | `er.triage_under_5` · `er.door_to_disposition_median` · `er.ceiling_breaches` · `er.mlc_documentation_completeness` | disaster window excluded from composite · G14 |
| Radiologist (15) | `rad.report_tat_by_modality` · `rad.critical_comm_compliance` · `rad.amendment_rate` | drafter edit distance is the agent's · G12 |
| Lab technician (17) | `lab.tat_by_category` · `lab.rejection_rate_lab_attributable` · `lab.qc_compliance` · `lab.recollection_closure` | QC override neutralises TAT · G10, A7 |
| Staff nurse (20) | §8.1 · `nursing.scan_compliance` · `nursing.vitals_timeliness` · `nursing.handover_ack` · `nursing.incident_rate_ctx` (band, dept-level) | S1 overload exclusion · G7, G13, G4 |
| ICU nurse (21) | `icu.alarm_ack_time` · `icu.charting_validation_rate` · `icu.bundle_compliance` · `icu.data_gap_incidents` | telemetry gaps are device diagnostics first |
| Ward in-charge (23) | `ward.roster_publish_compliance` · `ward.handover_completion` · `ward.stock_variance` · `ward.overload_flags_addressed` · `ward.review_cadence_adherence` (NEW: 1:1s held on time) | overload on the floor is *this* card's number, not the nurse's |
| Pharmacist (25) | `pharm.dispense_tat` · `pharm.substitution_policy_compliance` · `pharm.expiry_writeoff` · `pharm.narcotics_recon_exact` | G15 |
| Storekeeper (26) | `stores.stock_accuracy` · `stores.issue_tat` · `stores.expiry_on_shelf` | counts by non-custodian (SoD) |
| Housekeeping supervisor (32) | `hk.turnover_tat` (bed.released → task.verified) · `hk.deep_clean_verification` · `hk.round_completion` | G2 verify-not-complete · A8 |
| Duty manager (31) | `ops.escalation_resolution_time` · `ops.downtime_protocol_adherence` · `ops.override_rate_ctx` | overrides are contextual, never a target |
| Quality manager (37) | `qm.indicator_timeliness` · `qm.incident_closure_tat` · `qm.dq_gate_coverage` (NEW) · `qm.registry_change_lead_time` (NEW) | |
| Medical superintendent (39) | `ms.dispute_resolution_tat` · `ms.privileging_tat` · `ms.committee_cadence` | |
| Agents (subject_type agent) | `agent.acceptance_rate` · `agent.edit_distance` · `agent.abstention_rate` · `agent.cost_per_outcome` · `agent.calibration_error` · `agent.action_budget_breaches` | symmetric surveillance |

### 8.3 KRAs → OKRs per role and per department head

- A **KRA bundle** = the S10 card's KRA sentence decomposed into station/flow lines, each linked to the metric ids that evidence it. Version-controlled; re-based on operating-model change (C7).
- A **department head's KRA** = the department-level KPIs (§8.4) + the people-leadership lines: review cadence adherence, disputes resolved in SLA, overload flags addressed, roster publication compliance, DQ coverage of their department's series.
- **OKR**: owner sets ≤3 objectives per department per quarter (S10 §2); each KR = (metric_id, target, scope); auto-scored 0–1 by the registry at quarter close; head calibrates with reason (evented); the owner reviews calibrations for heads. No individual OKR scoring below head level by default (O-6).

### 8.4 Department-level KPIs (subject_type department/unit)

`opd.wait_median` & `opd.wait_sla_compliance` · `lab.tat_p50_p90` · `rad.tat_by_modality` · `ipd.alos_by_specialty` (case-mix shown) · `ipd.bed_occupancy` (registry-derived, per class) · `fin.revenue_per_occupied_bed_day` (owner/finance audience) · `fin.leakage_variance` (Leakage Auditor triangle) · `ic.hai_rates` (CAUTI/CLABSI/VAP/SSI per 1,000 device-days) · `clin.mortality_crude` and `clin.mortality_within_48h_excluded` (NABH split) · `clin.return_to_ot_rate` · `clin.icu_readmission_48h` · `pt.nps` (n≥30) · `pt.grievance_first_response` · `qm.incident_reporting_rate` (higher-better companion to incident rate) · `ops.discharge_ready_to_discharged_hours` (note 10 watcher).

### 8.5 Owner's 8 a.m. digest (Digest Writer fact sheet) and weekly rollup

Daily: yesterday's census/OPD/ER volumes with 7-day band · the five active-alert KPIs (OPD wait, ER triage, lab TAT, oxygen stock, cash variance) vs target with the *load line* · new withheld tiles (why) · open disputes count and oldest · gaming flags opened/closed (counts, classes; **no names**) · downtime/disaster windows · agents: runs, halts, budget breaches, cost-per-outcome · one "ask" line the Explainer proposes (cited). Weekly (Monday): department KPI table with week-on-week and stratified view where Simpson's risk exists · target changes · registry changes activated · review cadence adherence by head · incentive statement status · DQ coverage %. Names of individuals appear in the owner's digest **only** for governance-class items (disputes awaiting the owner, exposure requests).

---

## 9. AI agents & the copilot — where inference earns its place

| Candidate | Kind / tier | Trigger & inputs | Output | Sign-off | Fail-open path | Kill scope | Provenance | Eval / guardrail | DPIA class | Ships with |
|---|---|---|---|---|---|---|---|---|---|---|
| KPI Compute | automation T0 | worker clock; events by watermark | series rows | none (deterministic) | dashboards show stale + watermark | agent class `performance` | run id per series | golden fixtures per metric; mutant: drop actor filter must fail | staff-identified, no PHI in series (encounter refs only) | Plan 20 |
| Data-Quality Gate | automation T0 | after compute | withheld flags + Registrar tasks | Registrar closes | show counts only | same | — | boundary tests Q2 | same | Plan 20 |
| Gaming-Check Runner | automation T0 | after compute | `kpi.gaming_check_flagged` → Sentinel reviewer task | family reviewer (E-18) | none needed | same | rule version | false-positive rate tracked as its own agent KPI | profiling-like; DPIA line | Plan 20 (checks), Sentinel 12b (disposition) |
| Evidence-Pack Compiler | automation T0 | period close / recompute | immutable pack JSON + hash | head signs notes | head reads series directly | same | hash | pack equals series (property test) | staff-identified | Plan 21 |
| Digest Writer | agent T0 | 07:30 fact sheet (precomputed, typed lines) | narrative with cited claims | owner reads | fact sheet renders raw | agent id (12a) | model id, prompt v, input/output hash | citation guard; dropped-claim count; adversarial fixtures (note 13) | Class 0 (aggregates; names only for governance items) | 12a (exists) — KPI lines join in Plan 20 |
| KPI Anomaly Explainer | agent T0 | a flagged movement (> 2σ or target crossing) + 8 weeks of series + load context lines | 3 typed claims: what moved / what load changed / question to ask | head reads before 1:1 | head reads raw series | agent id | same | banned person-causal language; citation guard; entailment sampling | staff-identified (Class-1-like for staff) — DPIA before activation | Plan 21 |
| Coaching Nudge | agent T1 opt-in | weekly, only for opted-in users; own series + own targets | private message, self-only | subject | none | agent id | same | no comparison to peers ever; suppression in surge; tone eval | staff-identified; explicit consent; revocable | Plan 21, flag-inert until owner enables (O-7) |
| Workflow Tuner | agent T2 (existing) | 90-day baselines from registry | definition-change proposals | owner activates | — | 12b | — | — | — | 12b |

**Three lanes for this module's work:** Lane 1 hand-built — the owner digest page, the self-view card, the 1:1 pack page (high frequency, must be beautiful and fast). Lane 2 schema-generated — registry editor, dispute worklist, exposure-grant worklist, DQ task list, incentive statement preview (schemas already define them). Lane 3 conversation — "why did Ward 3's on-time rate drop last week?" → tool call `performance.getSeries` + `performance.explain` under the asker's permissions; propose→confirm for raising a dispute or requesting a grant; **never** for changing a formula (Lane 2 only, workflow-gated). **Journey Feed contributions:** none patient-facing; the *staff* journey (a person's own timeline of packs, disputes, acknowledgements) is a private feed.

**Prompt inputs, concretely (Explainer):** `{metric: {id, version, reading_text, direction}, subject_scope: "ward-3 nursing" (never a person name in Class-0 mode; person token in Class-1 mode), series: [{period, value, n, load_ctx}]×8, flags: [{kind, window}], recent_context_events: [overload.flagged, downtime.declared, roster.blocked… with line ids]}` → output schema `{claims: [{type: movement|load|question, text, cites[]}]}`.

---

## 10. Speed, accuracy, efficiency, auditability — the levers

- **Speed:** no manual MIS anywhere (S10 §2) — every KPI is exhaust; precomputed series and packs; the self-view opens in one click from the workspace header; 1:1 pack is a single printable page with QR (arch §15) linking to the live version.
- **Accuracy:** one registry, one arithmetic, version tag on every number; DQ gate hides rather than misleads; clock-skew and backfill detectors; stratified views by construction; `min_n` everywhere.
- **Efficiency:** registry editor is Lane-2 generated; formulas are typed AST compiled to SQL; adding a metric = data, no deploy; CI lint against the event catalog; agent explanations reduce "why" meetings.
- **Auditability:** append-only series with correction seq; immutable hashed packs; every view of a pack evented; every exposure granted by the owner with expiry; the registry doubles as the NABH indicator manual; incentive statements immutable with HR acknowledgements.
- **Targets:** series freshness ≤ 60 min for live tiles; monthly packs within 72 h of close; self-view < 300 ms; registry change lead time < 7 days; DQ coverage (metrics with a declared dq_inputs list) 100% before activation; dispute resolution median < 10 working days.

---

## 11. Integrations, devices & dependencies

- **HR SaaS (bought):** outbound incentive statements (CSV/JSON, signed), review acknowledgement summary (dates only), notice acknowledgements; inbound attendance-exception file (mech. 7). Indian market examples: greytHR, Keka, Zoho People — adapter with versioned column maps; SFTP/CSV is the honest baseline.
- **Biometric attendance:** via the HR SaaS, never direct device integration here.
- **Roster module (Phase-2 fast-follow):** `roster.published`, assignment spans — until it ships, unit-level fallback (Q10).
- **Plan 13 registry:** unit/floor/theatre scoping and `class` peer groups.
- **Plan 09/09a + Payouts pack:** `commission.accrued/.reversed`; `attribution.resolved` consumer (R4 — verify existence during authoring).
- **Plan 10 gateway + note 2 inbound:** NPS/feedback events; coaching nudges go in-app only (channel-cost ruling: routine staff coordination stays in-app).
- **12a runtime:** harness, `InferenceClient`, provenance, budgets, kill scopes.
- **Tally:** via Payouts pack only.
- **Events consumed:** the whole catalog by subscription per metric version (manifest lists them; the manifest test's census will move — note for the plan). **Events emitted (NEW):** `kpi.metric_defined/.metric_version_activated/.metric_deprecated` · `kpi.series_withheld` · `kpi.correction_applied` · `kpi.gaming_check_flagged` · `kpi.attribution_unverified` · `kpi.exposure_requested/.granted/.revoked` · `review.pack_generated/.held/.notes_signed/.acknowledged` · `okr.key_result_scored/.calibrated` · `incentive.statement_computed/.frozen/.exported/.hr_acknowledged` · `evidence_pack.viewed/.exported` · `backfill.completed` (proposed for the ops/downtime kit, owned there). Existing reused: `attribution.disputed/.resolved`, `sla.breached`, `overload.flagged`, `activity_attendance.mismatch`, `draft.acceptance_recorded`, `roster.published/.blocked`, `downtime.declared/.ended`, `disaster.declared/.ended`, `temp_role.granted/.expired`, `exit.completed`, `patient.merged/.unmerged`.

---

## 12. Buy vs build, hardware & rough INR budget

- **Build:** the registry, compute, packs, disputes, exposure, incentive statements — this *is* the differentiator and must share the spine. No BI tool substitutes for a versioned formula registry with audiences and DQ gates.
- **Do not buy:** a BI/warehouse (Power BI/Metabase) for staff KPIs — it would create a second arithmetic and a second audience model. Grafana (already deployed) may render *department-level* tiles from the read API for ops screens; never staff-identified series.
- **Buy (already):** HR/payroll SaaS (₹60–150/employee/month; ~₹1–2 L/yr day-one, ~₹15–25 L/yr at 1,200 staff); external DPDP counsel review of the staff notice and DPIA line (₹50k–1.5 L one-off).
- **Hardware:** none beyond the stage-2 host; series partitioning keeps the table under ~50 GB at 610 beds over 8 years. One 43" display per department head office for distribution (unranked) views is optional (₹25–35k each) — only after grants exist.
- **Inference cost:** Digest Writer + Explainer ≈ 30–60 Class-0 calls/day at stage 2 ≈ ₹3–8k/month; coaching nudges bounded by opt-ins and weekly cadence.

---

## 13. Owner rulings needed

| # | Question | Recommended default & why |
|---|---|---|
| O-1 | Default audience for every metric | `{self, direct_head}`; widening only by owner grant with expiry; team views unranked. Corporate chains do publish ranked boards; the owner-confirmed S10 philosophy rejects auto-ranking, so ranking is a per-metric per-quarter owner act. |
| O-2 | Individual rate KPIs before the roster module exists | Withhold individual *rate* KPIs needing assignment spans; show counts and unit-level rates with `fallback_unit` tag. Alternative (approximate from login/session spans) creates unfair numbers in the first months and poisons trust. |
| O-3 | Norm on informal sharing (screenshots, WhatsApp leaderboards) | Written policy in the staff notice: packs are personal data; sharing outside the grant model is a data-protection breach handled by the DPO; the system logs access patterns but never locks heads out. |
| O-4 | Any KPI-linked pay | Individual KPI-linked pay **forbidden by design** (enum has no such kind). Permit only owner-approved *department-level gates* (e.g. quarterly quality bonus pool released if the department's HAI and reporting-rate targets are both met). Fee splits and night allowance are rule-based, not KPI-based. |
| O-5 | DQ threshold and `min_n` defaults | 90% completeness; n=20 for rates; n=30 for NPS; overridable per metric by the Registrar with the owner informed monthly. |
| O-6 | OKR scoring below head level | Off by default; OKRs are quarterly at hospital/department/head level; individual KRAs are conversation material in the monthly 1:1. |
| O-7 | Coaching Nudge activation | Ship flag-inert; enable only after the staff notice is live, opt-in UI exists, and the DPIA line is signed. |
| O-8 | Retention periods for series, packs, notes, nudges | 8 y / 8 y / 3 y post-separation / 90 d, pending counsel. |
| O-9 | Disaster/surge windows in composites | Excluded from composites and comparisons by default; always shown as a labelled row. |
| O-10 | Who is the Registrar day one | Quality Manager (card 37) dual-hat; card 40 created at ≥300 beds. |
| O-11 | Where the module lives | `modules/performance/` (own tables, manifest); the registry *definitions* table could arguably be kernel-level like workflow definitions — recommend module-owned with a kernel-registered read interface, because nothing in the kernel needs to read KPIs. |

---

## 14. Plan sketch — how this becomes phase documents

Roadmap note 5 says the registry lands with the first surface that renders KPIs. That surface is the **Digest Writer in Plan 12a**. Recommendation: do not let 12a hand-code arithmetic; split as follows.

**Plan 20 — KPI Formula Registry & Compute (kernel-adjacent, before or alongside 12a's Digest Writer proof).**
T1 tables + migration (`kpi_metrics`, `kpi_metric_versions`, `kpi_attribution_rules`, `kpi_series` partitioned, `kpi_targets`, `kpi_dq_snapshots`, `kpi_gaming_checks`) + manifest (thirteenth/fourteenth manifest — the `ALL_MANIFESTS` and worker-difference pins move, as Plan 13 documented) · T2 formula AST + validator + catalog lint in CI (X4, X5, Q6, Q7) · T3 metric definition workflow (§3.1) as a workflow definition, semver rules, period-boundary activation, shadow period · T4 KPI Compute automation on the worker (watermark, idempotent, correction seq, advisory lock) + DQ gate + withheld events · T5 attribution rules (sole/shared/handover/trainee/agent-assisted) with golden fixtures for A1–A18 and the Simpson fixture D3 · T6 read API + Lane-2 registry editor + self-view card (Lane 1) + digest fact-sheet lines for 12a · T7 seed: the S10 §2-derived metrics for **shipped modules only** (OPD wait, registration time, duplicate-UHID, cashier variance, refund TAT, SLA compliance for every active workflow, agent KPIs) — everything else registers as `draft` awaiting its module · T8 perf test (X1–X3) with the 2,000/day synthetic load. **Gate before authoring:** Plan 13 shipped (unit scoping); 12a scope frozen; roadmap note 5 amended to point here; decision O-11.

**Plan 21 — Reviews, KRAs, Evidence Packs, Disputes, Exposure (after the roster module or with unit-level fallback per O-2).**
T1 `kra_bundles`, `okr_*`, `review_*`, `evidence_packs`, `kpi_disputes`, `kpi_exposure_grants`, `kpi_staff_notices` · T2 review-cycle and dispute workflow definitions (§3.2, §3.3) with SLAs and family reviewers (E-18) · T3 Evidence-Pack Compiler + hashed immutability + `evidence_pack.viewed` audit · T4 exposure-grant workflow + audience enforcement in the read API (P5, P6, M11) · T5 Anomaly Explainer under 12a (`InferenceClient`, citation guard, banned-language eval) · T6 Coaching Nudge, flag-inert · T7 staff notice + DPDP self-export (P1) · T8 NABH indicator export view (N5, R6). **Gate:** DPIA line for staff data signed; staff notice reviewed by counsel; O-1, O-3, O-6, O-7 ruled.

**Plan 22 — Incentive Statements & HR export (with or after the Payouts pack).**
T1 `incentive_rules/statements/lines` + rule validator (M2, M3) · T2 statement workflow (§3.5) with SoD · T3 consumers: `commission.accrued/.reversed`, roster night shifts, attendance-exception import · T4 HR SaaS adapter with versioned column map + idempotent export + acknowledgement · T5 `attribution.resolved` → accrual consumer verification (R4). **Gate:** Payouts pack shipped; O-4 ruled; HR SaaS chosen.

**Sequencing:** 20 can start once 13 closes and 12a's scope is confirmed; 21 needs 20 + the roster module (or O-2 fallback); 22 needs Payouts. Department-level KPIs activate per module as Track A/B ship (each stage-2 plan's §8 must *register* its metrics in Plan 20's registry rather than hand-roll — a standing rule for the series).

**Negative-space question for this module:** *a KPI that never moves, a subject with no series, a head with no 1:1s, a department with zero disputes and zero gaming flags for a year, an incident rate of zero on a full ward, a metric never withheld by DQ.* Each absence is a watcher: `kpi.flatline_flagged` (NEW, plan 20 T4), review-cadence adherence, dispute-silence report to the owner, G4's reporting-rate companion, DQ-coverage KPI.

**Staff edge-case interview questions (department heads, matron, MS, billing supervisor):**
1. When two of your people share a patient, who do you credit today, and how do they argue about it?
2. What do you do at month-end that changes your numbers (discharges, closures, orders)?
3. Which of your KPIs would you game if you were junior, and how?
4. On your worst night this year, what did the numbers say and what actually happened?
5. Which tasks are marked done before they are done, and why?
6. Who covers when your night in-charge leaves early, and how would the system know?
7. What number, if put on a wall, would make your team stop reporting incidents?
8. When the system was down, how did you reconstruct the shift's work, and how accurate was the time?
9. Which of your staff work across two units or two roles in one shift?
10. What load context (census, acuity, device outages) do you *always* want beside a number before you believe it?
11. What would you want to see in a 1:1 pack that you cannot get today?
12. Which incentives do your staff believe exist, formally or informally?
13. What do you tell a trainee's number versus a supervisor's number?
14. Which comparisons between floors do you consider unfair, and why?

---

## 15. Open questions & risks

1. **Roster module timing** — most individual rate KPIs are unfair without assignment spans; O-2's fallback is honest but thin; the roster module's place on the roadmap ("Phase-2 Quality/NABH fast-follow") should be re-checked against Plan 21.
2. **`attribution.resolved` consumer in Plan 09/Payouts** — not verified in this brainstorm; R4 must be measured at Plan 22 authoring.
3. **Manifest pins** — Plan 13 showed a new manifest moves `ALL_MANIFESTS` and the worker-difference test; Plan 20 will move both again and must say so up front.
4. **Case-mix index** — G1/D5 need a case-mix proxy before clinical modules ship (ICD-coded diagnoses arrive with MRD); until then complexity is approximated by orders/encounter and encounter type — declare it as such in the metric's reading text.
5. **Where D-36's calibration record and this registry meet** — the agent KPIs (acceptance, calibration error) are computed by the 12a runtime per note 17; registering them here must be a *read* of that record, never a second computation.
6. **Staff notice under DPDP for employee data** — the legitimate-use basis for employment purposes (§7(i)) may not require consent, but the notice and rights still apply; counsel to confirm, especially for the profiling-like gaming checks.
7. **Simpson-safe composites** — direct standardisation needs a stable reference mix; choose the department's trailing-12-month shift mix and version it; decide at Plan 20 T5.
8. **Public-sector-style transparency vs private norms** — corporate chains (Apollo, Fortis, Manipal) run ranked doctor revenue boards; the owner's ruling rejects this for staff KPIs; revenue attribution remains a finance read model, not a staff KPI — restate this in the staff notice so expectations match.
9. **Series partition maintenance** — monthly partitions need a scheduler job; the 08.5 worker pattern covers it but it is one more sweep to pin.
10. **A3 model switches** re-base KRAs mid-year; the OKR arithmetic across a switch is undefined beyond "no comparison across the boundary" — decide per department at switch time.
