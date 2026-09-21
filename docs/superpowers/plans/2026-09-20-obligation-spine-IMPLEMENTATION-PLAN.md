# The obligation spine — implementation plan (phase O)

**Authored 2026-09-20 in lane `obligation-plan`, from the brainstorm set
`brainstorms/2026-09-20-obligation-spine/` (00 review · 01 staff census · 02 edge register · 03–05
the measured dossiers) and the phase doc `2026-09-20-phase-obligation-spine.md` (#266, on main).
FOR EXECUTION BY A SEPARATE SESSION (Opus) via `2026-09-20-obligation-spine-EXECUTE-PROMPT.md`.
Supersedes the task table in the phase doc §Tasks; the phase doc's rulings (RO-1..RO-7), its
DECIDED table (O1–O20) and its R2 ceiling table remain the reference.**

The owner's brief, 2026-09-20: *every event that needs a human act must find the right human, in
time, on a medium that can reach them; if it does not, the person above inherits it as their own
failure to supervise; every seat in the building, gate guard to owner, and the AI agents beside
them.* T2 (filing tells somebody) is **built and merged** (#267, 99e7632c). This plan is T1 and
T3–T13. Screens beyond the six named in §7 are a later phase.

---

## 0. Standing rulings this plan is built on

| ruling | source |
|---|---|
| in-app notifications, approvals and Chrome Web Push FIRST; DLT SMS registration and the WhatsApp API purchase are STARTED | owner RO-4 |
| all support-service classes carry obligations; contractor supervisors on the same delay ledger; contractor records MAY be exported to the firm | RO-1, RO-2, RO-5 |
| English primary, Hindi next; templates in both before a class is switched on | RO-3 |
| R2 ceilings = the table in the phase doc; seven types never auto-grant, two under sequential dual control | RO-6 (delegated, decided) |
| ageing sweep: 3 working days, then every 7 days; compliance lead times 30/14/7/1 | RO-7 (delegated, decided) |
| the `owner` role reads and decides every type; money ladders end at the owner, clinical and definitional at `duty_manager` | approvals-spine R1, R3 |
| obligation is the primitive; two clocks; two ladders; a breach files an obligation on the accountable rung; attribution to the RUNG until the roster answers | phase doc O1–O5 |
| Code Blue, fire, Code Pink are NOT this spine; patient-facing reminders are Plan 10's | O19 |
| roster phase R is executing (lane `roster-r1` live 2026-09-20); its R5 resolver and R6 call-site move touch the same kernel files as T1 and T5 | §5 |

---

## 1. Ground truth to re-measure at kickoff (record answers in §9)

| # | fact | how | value on 2026-09-20 |
|---|---|---|---|
| G1 | newest migration on `origin/main` | `ls apps/core/drizzle/*.sql \| tail -1` | `0107_pharmacy_authorisations.sql`; **lane `roster` (#264) and phase R's R1 both claim 0108 — every task here takes the next free serial AT REBASE, never at start** |
| G2 | phase R progress | `gh pr list --search "roster-r"`; `ls /opt/hmis-lanes \| grep roster` | R1 in flight; R5/R6 not started. **T1 must merge before R6 or rebase onto it; T5 reads §5 before touching `alerts/consumer.ts`** |
| G3 | #265 (approvals-spine: authority fix, `owner` decides every type) | `gh pr view 265` | OPEN. Merge first: T5's derived ladders end at `owner` and R3 is only reachable with R1's grant |
| G4 | pins: manifests / allPermissions / modelPairs / held / NON_TABLE_PAIRS / `approvals:` per-module / app-only word | run `manifests.test.ts`, `test/seed-roles.test.ts` red and read the numbers | 22 · 175 · 355 · 161 · 169 · `approvals: 4` · "seven" (moves to 23 · +1 · … after R1; **read, never predict**) |
| G5 | scheduler job census | `jobs.test.ts:355`, `scheduler.test.ts:332/667/714`, `test/worker-runtime.e2e.test.ts:100`, `test/alerts-parity.test.ts:160` + `alerts.yml` | **18** in four files; T4 and T10 each add one job → five edits each |
| G6 | SPA route census | `test/caddyfile-parity.test.ts:415` | 68; T4 +1 (`/me/reach`), T8 +2, T9 0 |
| G7 | alerts subscriptions / notify templates / notify consumer subscriptions | `alerts/consumer.test.ts` manifest pin; `notify/templates.test.ts:19-32` whole-array pin; `notify/consumer.test.ts:166-175` | 6 · 7 · 5 |
| G8 | DB session timezone on the lane test DB | `show timezone` | `Etc/UTC` — every IST test in T7 relies on it |
| G9 | `usersHoldingRole` runtime call sites | `grep -rn "usersHoldingRole(" apps/core/src --include=*.ts \| grep -v test` | `alerts/consumer.ts` ×8, `workflow/timers.ts:148,153`, `notify/consumer.ts:230`, `desk/staff.controller.ts:226`, `materials/counts.ts:170`, `materials/transfers.ts:270` |
| G10 | the ladder anchoring pins T1 must keep green | `timers.test.ts:91`, `test/worker-runtime.e2e.test.ts:695-709, 775-787`, `test/approvals-lifecycle.e2e.test.ts:143-153`, `instances.test.ts:69`, `requests.test.ts:90`, `remediation.test.ts:82` | all pin the CHAIN shape (`from: timer.dueAt`); none may move |
| G11 | web push readiness | `grep -rniE "serviceWorker\|PushManager\|vapid" apps/web/src apps/core/src` | absent everywhere; `public/` holds only `fonts/` |
| G12 | lanes touching shared files | `tools/lane.sh status` | `roster-r1`, `copilot`, `desk-upcoming`, `cds` — coordinate before T1/T5/T9 |


## 1a. Amendment, 2026-09-21 — measured after roster phase R merged R1–R6 overnight (read this before §1)

Written after coordinating with the three live sessions on the box (roster executor `hmis-27`,
`hmis-58` on #269, the orchestrator). **Where §1 and this section disagree, this section wins; the
kickoff re-measures both.**

| # | what moved | now |
|---|---|---|
| G1′ | migration serial | `0112_roster_escalation_targets` on main; **#280 (R7) and #269 both target 0113** and #280 is armed to auto-merge — whoever lands second renumbers; R8/R9 take the next two. Take every serial at rebase. |
| G2′ | phase R | R1–R6 MERGED as #273–#279; R7 = #280 open; the roster session ended and a fresh one resumes from `plans/2026-09-21-roster-R8-HANDOFF.md` on lanes `roster-r8` / `roster-r9`, touching `modules/roster/**`, `periods.ts` (R8) and `kernel/worker/jobs.ts` (R9's job). |
| G5′ | scheduler job census | 18 on main today; **19 once #280 lands** (`sweepRosterWindows`, daily IST 01:30). Registering a job moves **SEVEN** sites: `jobs.test.ts`, `scheduler.test.ts` (the named array AND the `spies()` helper), `test/worker-runtime.e2e.test.ts` (the named array), `test/alerts-parity.test.ts` (sorted list + count + `Set.size`), `docker/prod/prometheus/alerts.yml` (the correct staleness leg — interval and daily are asserted disjoint — plus an `absent()` term), and `alerts/consumer.test.ts`'s two subscription censuses if the task declares a subscription. A `toHaveLength` grep cannot find a census expressed as a named array: **run the whole `test/` directory and read the counts off the red run.** Registrations are appends; two lanes registering coexist — do not wait for R9. |
| G9′ | the resolver seam | R6 (#279) moved `alerts/consumer.ts:251, 327, 354` (`notification.failed`, the two imaging chasers) and `timers.ts:158` (the ladder rung) to **`escalationRecipients(exec, alertKind, { fallbackRoleKey, departmentId? }, at, env)` → `{ userIds, via: "roster" \| "role", rosterWasEmpty, roleKey, positionKey }`** from `modules/roster/escalation.ts`. It ships INERT: with no `roster_escalation_targets` row it returns exactly `usersHoldingRole(fallbackRoleKey)`; it also falls back when the flag is off, when nothing is published, or when the roster answers nobody (`rosterWasEmpty`). `ROSTER_ESCALATION_KINDS` is closed (`escalation.triggered`, `notification.failed`, `ops.mode_changed`, `imaging.critical_overdue`, `imaging.report_unread`, `workflow.timer_rung`) with a CHECK — a new kind is a migration. **Deliberately still on `usersHoldingRole`, and to stay so (roster findings F23/F24):** `alerts/consumer.ts:198, 290` (the OWNER is an office, not a duty), `:393/397/401` (the approvals chain; its duty-manager rung is the one never removed), `timers.ts:166` (the duty-manager fallback after the seam), `desk/staff.controller.ts`. |
| G13 | `roster_holidays` (#280) | PK `(site_id, ist_date)`; `kind` ('gazetted' \| 'restricted' \| 'declared' \| 'local'), `applies_to text[]`, `pattern` ('as_sunday' \| 'opd_short' \| 'opd_off_ot_proceeds'), `declared_by`, `declared_at`, `confirmation_due_at`. Writer `declareHoliday()` re-materialises that date's duty windows. **A declared holiday runs the Sunday pattern but never advances the Sunday sequence** — phase O reads this table and never writes it. |
| G14 | #265 (`lane/approvals-spine`) | docs + the R1 grant in `seed-roles.ts`/its test/`README.md`. Merge before T5 (G3 stands). Its L1 packet and L9 rail stay its own. |
| G15 | #269 (`lane/doctor-token`) | adds `consultation.fee_overridden` (a doctor sees the patient before the bill, reason in the payload), unconsumed — a clean hook for a T8 task kind `fee_override_billing` (the counter bills within the day). |
| G16 | dossiers 03/04 | their `consumer.ts` / `timers.ts` line numbers are pre-R6. Re-measure. |

**Task deltas (these override the task text below):**
- **T1:** `resolveRung()` WRAPS `escalationRecipients(tx, "workflow.timer_rung", { fallbackRoleKey: rung.toRole }, now)` for a percent rung exactly as #279 does for a chain rung, then the static duty-manager fallback at `timers.ts:166` — no new `usersHoldingRole` site, no new escalation kind. The `respond.overdue` nudge goes to the assignee in-app and needs no roster resolution.
- **T5:** `resolveAddressee` kind `role` inside the approvals chain (`consumer.ts:393-401`) STAYS `usersHoldingRole` (F24); kinds `post` and `unit` use `whoIsOn` behind `ROSTER_RESOLVER_ENABLED`; the OWNER is never routed through the roster (F23). The fallback event still fires for every rung that fell through.
- **T7:** **`hospital_calendar_days` is DROPPED.** T7 builds `department_hours` only and reads `roster_holidays`: `as_sunday` → the department is closed; `opd_short` → closes 13:00; `opd_off_ot_proceeds` → OPD closed, `ot_desk` open. The half-day case of V12 becomes the `opd_short` case.
- **T4, T10 (jobs):** the seven-site census; register, run `test/`, read the counts; put the relay in the interval leg and the sweeps in the daily leg of `alerts.yml`.
- **Every migration task:** `kernel/db/schema/index.ts` is the one file every open PR shares (#264 too); whoever lands second re-reads it. `seed-roles` pins are three-way against the merge base — equal totals from disjoint causes have already fooled a two-way diff on this box (163 = 163, true 166).
- **The lock:** `$L run <lane> pnpm …` with NO `--` (the script shifts two and runs `"$@"`; a `--` becomes the command and exits 127 having run nothing). Never `git stash` — every worktree shares one `refs/stash`.

---

## 2. The data model — what the tasks build

Conventions: ULID text ids via `newId()`; text + CHECK vocabularies, never PG enums; instants
`timestamptz`; IST calendar days only where a human declares a day (holidays, sweep dates); every
new table gets a `schema/<name>.test.ts` census in the `retention.test.ts` shape (dossier 05 §7);
nullable additive columns on shipped tables. **All measured line numbers refer to dossiers 03–05.**

### 2.1 Kernel workflow (T1)
- **`sla` spec gains two optional keys** beside the shipped `escalation` (dossier 03 §1a):
  `respondMinutes?: int > 0` and `ladder?: { atPercent: int 1..400, toRole: string }[]`.
  `defineWorkflow` adds one problem string: a state may declare `escalation` OR `ladder`, never
  both; `ladder` percents strictly ascending. **The shipped `escalation` chain is untouched** (G10).
- **`workflow_timers`** + `percent integer NULL` (set on `kind='escalation'` rows that came from a
  `ladder`), + `superseded_by text NULL` (the timer that fired instead, C4), + timer kind
  `'respond'`. No CHECK on `kind` today; add `workflow_timers_kind_ck IN ('sla','escalation','respond')`.
- **`workflow_instances`** + `budget_minutes integer NULL` (per-instance override of
  `sla.minutes`; read by `scheduleSlaTimer` and the ladder; written only by `rescheduleBudget`).
- **`escalation.triggered` payload** + optional `percent`, `budgetMinutes` (additive; version 1
  stays; `events.test.ts` "exactly five names" unchanged). **New event** `respond.overdue`
  (module `workflow`; payload `{ instanceId, defKey, state, respondMinutes, dueAt }`) — the sixth
  name; move that pin.

### 2.2 Alerts acknowledgement (T3)
- **`alerts`** + `ack_kind text NULL` CHECK IN ('seen','owned','handed_over'), `acknowledged_at
  timestamptz NULL`, `owned_until timestamptz NULL`, `ack_note text NULL`, `handed_to_user_id text
  NULL → users.id`, `ack_extensions smallint NOT NULL DEFAULT 0`. CHECK `(ack_kind IS NULL) =
  (acknowledged_at IS NULL)` (the radiology precedent, dossier 04 §9); CHECK `ack_kind <> 'owned'
  OR owned_until IS NOT NULL`; CHECK `ack_kind <> 'handed_over' OR handed_to_user_id IS NOT NULL`.
- **Event** `alert.acknowledged` `{ alertId, userId, kind, ownedUntil?, handedToUserId?, refType,
  refId }` — fanned on the alerts topic (`ALERTS_REALTIME_NAMES` gains it) so a second tab clears.

### 2.3 Reach (T4)
- **`user_reach_profiles`** — `user_id PK → users.id`, `language text NOT NULL DEFAULT 'en'` CHECK
  IN ('en','hi'), `ladder text[] NOT NULL DEFAULT '{web_push,whatsapp,sms}'` (each ∈ channels),
  `quiet_exempt boolean NOT NULL DEFAULT false` (night supervisor, CMO), `consent_at timestamptz
  NULL` (R2), `shared_phone boolean NOT NULL DEFAULT false` (R1: carries `seen` only), the four audit
  columns. A missing row = the class default; the class default table is code (`reach-defaults.ts`,
  transcribed from census §Q.4).
- **`push_subscriptions`** — `id`, `user_id → users.id`, `endpoint text UNIQUE`, `p256dh`, `auth`,
  `user_agent`, `created_at`, `revoked_at NULL`. A 410 from the push service revokes.
- **Channel union** `"whatsapp" | "sms" | "web_push"` in the four synchronized places (dossier 04
  §1.6) + `NOTIFY_PUSH_PROVIDER: "console" | "webpush"` in `config.ts` beside `NOTIFY_PROVIDER`
  (which stays `console` until the purchases land). VAPID keys `WEB_PUSH_VAPID_PUBLIC_KEY /
  PRIVATE_KEY / SUBJECT` — refused at boot when the provider is `webpush` and a key is missing.
- **Templates** (closed registry, dossier 04 §1.7): `staff_alert_relay_now` (urgency `urgent`),
  `staff_alert_relay_later` (urgency `routine`), `staff_alert_digest`; params are `{ kind, lane,
  remainingMinutes, link }` and nothing else; both languages. Templates pin 7 → 10.
- **Relay job** `runReachLadder` (census 18 → 19): for every unread alert of a lane older than the
  lane's minutes whose user's next ladder channel is not yet enqueued, enqueue with dedupe
  `reach:<alertId>:<channel>`; a `seen`/`owned` ack stops further rungs; the reach budget (R9: 6 per
  user per hour, `quiet_exempt` bypasses) coalesces the 7th into one `staff_alert_digest`.

### 2.4 Addressees and chains (T5)
- **`role_parents`** — `role_key PK → roles.key`, `parent_role_key → roles.key NULL`, `department_id
  text NULL` (scope column, unused by the seed), audit. **DAG validated on every write** (A3) and at
  boot by `standup:check` (a RED row on a cycle).
- **`posts`** — `key PK`, `label`, `supervisor_role_key → roles.key`, `department_id NULL`,
  `phone text NULL` (the post phone, shared: `seen` only), `active`. Seed: `gate_main`,
  `billing_counter`, `ward_station`, `ot_desk`, `pantry`, `maintenance_desk`, `mortuary`.
- **`post_holders`** — `post_key → posts.key`, `user_id → users.id NULL`, `contractor_supervisor_user_id
  → users.id NULL`, `starts_at`, `ends_at NULL`; CHECK one of the two user columns set. The
  contractor's shift roster (A10) is this table.
- **`resolveAddressee(tx, ref: { kind: 'person'|'post'|'role'|'unit'|'committee'|'contractor'|'external'|'agent', key }, at): Promise<{ userIds: string[]; fellBackTo: string | null }>`**
  in `kernel/obligations/addressees.ts`. `role` refuses a role with > 8 holders (A4) at
  *definition* time (`assertAddressable`). `unit` and roster-aware `role` call phase R's `whoIsOn`
  when `ROSTER_RESOLVER_ENABLED` (V14 parity there), else `usersHoldingRole`. Every fallback
  appends `obligation.addressee_fell_back` `{ ref, fellBackTo, at }` and the alerts consumer raises
  a `duty_manager` alert for it (A1 — recorded, never silent).
- **Derived ladders on the sixteen types**: `deriveLadder(approverRole, height)` walks
  `role_parents`; `height` per type from the importance constants (`irreversible`, `blastRadius`,
  `fraudClass` declared beside `closureSlaMinutes` in each `approval-types.ts`); money types end at
  `owner` (R3), the rest at `duty_manager`; owner only at 200 % for Q1 (O12). Each type's definition
  is re-versioned (`createDraft` → `activateDefinition`; in-flight instances stay pinned; the drift
  guard at `requests.ts:59-75` still holds because `approverRole` is unchanged).

### 2.5 The delay ledger (T6)
- **`obligation_delays`** — `id`, `instance_id → workflow_instances.id`, `subject_kind` ('approval'
  | 'task'), `subject_id`, `rung smallint`, `percent smallint`, `role_key`, `held_by_user_ids text[]`
  (who held the rung, recorded, **not attributed**), `attribution text NOT NULL DEFAULT 'rung'` CHECK
  IN ('rung','person'), `opened_at`, `budget_minutes`, `over_by_minutes`, `review_instance_id →
  workflow_instances.id NULL` (the obligation this delay created), `excused boolean DEFAULT false`,
  `excuse_reason`, `excused_by`, `closed_at NULL`, `closed_by NULL`, `closed_how` CHECK IN
  ('acted','covered','excused','counselled','subject_closed') NULL.
- **Definition** `delay_review` (kernel, key `delay_review`, states `open` → `closed`; `open` carries
  `sla { minutes: 480 working, alerting: active, respondMinutes: 30, ladder: [70%, 100%, 150%] }`).
  Created by the obligations consumer on `escalation.triggered` with `percent >= 100` (V10: bounded
  by chain depth; the top rung files nothing and lands in the digest).

### 2.6 Derivation, calendar, working minutes (T7)
- **`approvals`** + `priority_lane text NULL` CHECK IN ('now','today','can_wait'), `blocking boolean
  NOT NULL DEFAULT false`, `importance smallint NULL`, `priority_signals jsonb NULL` (the signals
  that fired, explainable), `respond_by timestamptz NULL`, `resolve_by timestamptz NULL`. D4:
  `urgency_class` untouched; the lane is the type's floor raised by signals, never lowered.
- **`approval_types`** + `irreversible boolean DEFAULT false`, `blast_radius text DEFAULT 'one'`
  CHECK IN ('one','many','all'), `fraud_class boolean DEFAULT false`, `working_minutes boolean
  DEFAULT true` (false for Q1 types: wall-clock).
- **`hospital_calendar_days`** — `day date PK` (IST), `kind` CHECK IN ('holiday','half_day'),
  `label`, `department_id NULL` (override), audit. **`department_hours`** — `id`, `department_code`
  (opd code or a post key), `weekday smallint`, `opens 'HH:MM'`, `closes 'HH:MM'`, `valid_from`,
  `valid_to NULL`. Seed: 09:00–17:30 Mon–Sat for every OPD code (owner's office timings, roster
  ruling), 24 h for `casualty`, `ward_station`, `ot_desk`. **Phase R's R7 consumes these two tables
  for holidays; if R7 lands first with its own, T7 consumes R7's (G2 decides).**
- `workingMinutesBetween(dept, from, to)`, `deadlineAfter(dept, from, workingMinutes)` in
  `kernel/obligations/working-minutes.ts` — pure over the two tables, IST arithmetic like
  `quietHoursDeferral` (dossier 04 §1.5), tested at 00:00 / 05:29 / 05:30 / 08:00 / 23:59 IST.
- **`POST /approvals/:id/signal`** `{ blocking: boolean, reason }` (permission
  `approvals.requests.create`, the counter's own) re-derives the lane; a lane change appends
  `approval.reprioritised` `{ approvalId, from, to, reason }` and calls `rescheduleBudget`.

### 2.7 Tasks — the second verb (T8)
- **`obligation_tasks`** — `id`, `kind` (registry key), `instance_id → workflow_instances.id`,
  `addressee_kind`, `addressee_key`, `subject_type`, `subject_id`, `patient_id NULL`, `location_key
  NULL`, `filed_by_kind` CHECK IN ('user','agent','sensor','external'), `filed_by_id`, `lane`,
  `evidence_kind` CHECK IN ('decision','keypad','qr_scan','photo','read_back','sensor_in_range',
  'on_behalf_tap'), `evidence jsonb NULL`, `status` CHECK IN ('open','done','cancelled'), `done_by
  NULL`, `done_at NULL`, `requested_at`. CHECK `status <> 'done' OR evidence IS NOT NULL` (V14).
- **`task_kinds`** registry in code: `transport_request` (post `ward_station` → evidence
  `qr_scan`, 10 min, Now), `bed_turnaround` (housekeeping supervisor, 45 working min, Today,
  `on_behalf_tap`), `breakdown_ticket` (maintenance desk, minutes by criticality of `location_key`,
  `photo`), `mrd_deficiency` (the doctor named, 24 h working, `decision`). Each is a
  `taskFlowDefinition({ kind, respondMinutes, budgetMinutes, ladder })` on the same engine.
- **`location_qr`** — `key PK` (ward, radiology, OT), `secret text` (static QR in phase one, G1),
  `label`. `POST /obligations/tasks/:id/evidence` validates the kind.
- **Board** `GET /obligations/board/:postKey` → `{ lanes: { now, today, can_wait }, oldestMinutes }`
  — counts and ages, **no subject field by construction** (V15, mutant).

### 2.8 Anticipation and the sweeps (T10)
- **`compliance_items`** — `id`, `kind` (licence | return | amc | calibration | badge | rotation |
  contract), `subject_type`, `subject_id`, `label`, `due_on date`, `lead_days smallint[] DEFAULT
  '{30,14,7,1}'`, `addressee_kind`, `addressee_key`, `status` CHECK IN ('open','done','waived'),
  `done_at`, audit. Seed from what exists: AERB licences (`aerb_licences.valid_to`), PCPNDT
  registration, CRMI rotation ends (phase R), AMC rows when biomedical lands.
- **Job** `runObligationSweeps` (census 19 → 20): (a) compliance lead times file a `compliance_due`
  task at each lead day; (b) the ageing sweep: every approval `can_wait` open ≥ 3 working days files
  ONE `ageing_review` alert to the MS role and, every 7 days after, again; the weekly owner digest
  lists them with age. No last rung (O14).

### 2.9 Dual control and the digest (T11)
- `approvalFlowDefinition({ dualControl: true })` emits a FOURTH state: `pending → countersign
  (approverRole) → granted | rejected (approverRole)`; `countersign` carries its own sla (same
  budget, own ladder). **Not a second `approvals` row** (`approvals_instance_ux`, dossier 05 §1).
- **`approvals`** + `first_decided_by text NULL`, `first_decided_at NULL`, `first_note NULL`;
  `status` gains `'countersigning'`. `decide()` refuses `decidedBy === firstDecidedBy` and
  `=== requesterId` (`ApprovalError("second_approver_required")`), and the DB CHECK
  `approvals_second_approver_ck CHECK (first_decided_by IS NULL OR decided_by IS NULL OR
  decided_by <> first_decided_by)` mirrors it (the `pharmacy_authorisations_same_actor_ck` precedent).
- **Digest** `GET /approvals/digest?weeks=1` (permission `approvals.requests.read`): per type —
  filed, granted %, median decision seconds, rejections, reject-under-N-seconds count (G4), handovers
  per person (G6), auto-grant candidates (≥ 98 % granted, 0 rejections in 90 days), items older
  than 7 days. Also emailed later; in phase one it is a screen section on `/approvals`.

### 2.10 Standing policy (T13)
- **`approval_policies`** — `id`, `type_key → approval_types.type_key`, `ceiling jsonb` (`{
  maxPaise?, maxPercent?, minShelfLifeDays?, maxSharePercent?, unrenderedOnly?, originalTenderOnly?,
  excludeNarcotic?, excludeColdChain? }`), `conditions jsonb` (`{ selfPayOnly: true,
  firstOfDayForPatient: true, firstOfDayForPayee: true }`), `authored_by → users.id`, `effective_from`,
  `effective_to NULL`, `review_by date`, `active`. Seed = the R2 table, authored by the owner user.
- `requestApproval` after the insert consults the live policy; when satisfied it calls
  `grantByPolicy(tx, approvalId, policy)`: `transition(tx, instanceId, "granted", { type: "system",
  id: `policy:${policy.id}` })` (system actors bypass the role check — `instances.test.ts:108`),
  `approvals.decided_by = 'policy:<id>'`, `decision_note = 'policy <id> by <author>'`, event
  `approval.policy_granted`. **`decide()` is not used** (it refuses non-user actors). D13 holds:
  `decidedBy` never impersonates a person.
- **`POST /approvals/:id/reverse`** (permission `approvals.requests.decide`, until IST midnight of
  the grant day, D14): status → `reversed`, event `approval.policy_reversed`; the subject module's
  reaction (credit note, restock) is that module's later task, named in §7.

---

## 3. Invariants — each is a test, named here so the reviewer can grep for it

| id | invariant | where enforced |
|---|---|---|
| V1 | the shipped `escalation` chain keeps its arithmetic: rung k at `entry + sla + Σ afterMinutes[0..k]`; G10's seven pins stay green untouched | `timers.test.ts` (existing) |
| V2 | a `ladder` rung fires at `entry + budget × percent / 100`; every rung is scheduled at state entry; one transition cancels all (instance-wide `cancelOpenTimers`) | `timers.test.ts` (new block) |
| V3 | `rescheduleBudget(tx, instanceId, minutes)` leaves exactly ONE live ladder and one live sla timer, and stamps `budget_minutes` | `timers.test.ts` |
| V4 | three `ladder` rungs all due in one pass: the highest emits, the lower two carry `superseded_by` and emit nothing | `timers.test.ts` (C4) |
| V5 | `respond.overdue` fires once; an `owned` or `seen` ack cancels the respond timer only; the sla timer is untouched by any ack | `timers.test.ts`, `obligations/consumer.test.ts` |
| V6 | no alert column, no `alert.raised`/`alert.acknowledged` payload, no external body carries a patient's or a staff member's identity or health fact; amounts leave as bands | mutant class in `alerts/consumer.test.ts`, `notify/templates.test.ts` |
| V7 | the requester is never an addressee; a second approver ≠ first ≠ requester (code + DB CHECK) | `decisions.test.ts`, `schema/approvals.test.ts` |
| V8 | `role_parents` is a DAG on every write and at boot; a role with > 8 holders is refused as an addressee at definition time | `addressees.test.ts`, `standup-check` |
| V9 | every addressee fallback appends `obligation.addressee_fell_back`; none is silent | `addressees.test.ts` (absence test: no code path returns `[]` without the event) |
| V10 | a breach at 100 % files ONE `delay_review`; its breach files one on the parent; the top rung files none; depth ≤ chain depth | `delays.test.ts` (chain of three) |
| V11 | reach: the 7th interrupt in an hour coalesces into a digest; a `shared_phone` profile receives no decision-carrying template; an SMS reply carries ack only; a replayed action token is refused | `reach.test.ts`, `tokens.test.ts` |
| V12 | working minutes at 00:00 / 05:29 / 05:30 / 08:00 / 23:59 IST with the DB in UTC; a holiday pauses; a half day closes at 13:00 | `working-minutes.test.ts` (G8) |
| V13 | a signal change moves the lane and appends `approval.reprioritised` with the reason; age alone never moves a lane | `derive.test.ts`, `worklist.test.ts` |
| V14 | a task closes only with evidence of its declared kind; the DB CHECK refuses `done` without evidence | `schema/obligations.test.ts`, `tasks.test.ts` |
| V15 | the board endpoint's response contains no subject, patient or name field (mutant renders one) | `board.test.ts` |
| V16 | a policy grant records `policy:<id>` and the author, never a person; reversible by a decider until IST midnight of the grant day, refused after | `policy.test.ts` |
| V17 | an obligation filed at 07:59 on a take ending 08:00 hands over with no delay record | `handover.test.ts` (C6, after phase R's R7) |
| V18 | an approval open 3 working days surfaces once, and again every 7 days, with no last rung | `sweeps.test.ts` |
| V19 | every new event payload is ids, codes, instants and minutes — a schema walk rejects a free-text field on `obligations`/`workflow` events | `events.test.ts` |
| V20 | the six shipped alerts branches and the T2 branch are unchanged in behaviour: `alerts/consumer.test.ts` 17/17 stays green through T3, T5 | existing suite |

---

## 4. Tasks — one PR each, one migration each, fail-first, rail + first consumer together

Tiers: T1, T3, T5, T6, T7, T11, T13 CRITICAL; T4, T8, T9, T10, T12 ROUTINE. Every CRITICAL task
builds its mutants as `*.mutant.ts`, runs them, records the kill in §9.5, never stages them. Order:
**T3 → T1 → T4 (push leg) → T5 → T6 ∥ T7 → T13 → T11 → T8 → T9 → T10 → T12 (when providers land)**.
T3 goes before T1 so T1 can consume `alert.acknowledged`; T4's WhatsApp/SMS legs wait for the DLT
header and BSP templates and are a §8 follow-up when they land.

### T3 · CRITICAL · Acknowledgement states on alerts, the ack route, the bell's deep link
- Migration (next free serial at rebase): §2.2 columns and CHECKs on `alerts`.
- `kernel/alerts/alerts.ts`: `AlertRow` + the six fields; `acknowledgeAlert(db, actor, alertId,
  input: { kind; untilMinutes?; note?; handedToUserId? }, now?)` beside `markAlertRead` (same
  conditional-UPDATE shape, `owned` allows ≤ 2 re-owns — `ack_extensions`, G5 — the third refuses
  `ack_limit`); an ack also sets `read_at` if null. `alerts.controller.ts`: `POST :id/ack`
  (authenticated-only, `requireUserActor`, like the two shipped routes). `events.ts`:
  `alert.acknowledged`. `realtime.ts`: `ALERTS_REALTIME_NAMES = ["alert.raised", "alert.acknowledged"]`.
- Web: `lib/alerts-api.ts` `acknowledgeAlert`; `alerts-bell.tsx` rows gain Seen / Own 30 min /
  Hand over (a user picker is T9's; phase one hands over by staff code typed) and a **`Link`** when
  `refType === "approval"` → `/approvals?focus=<refId>`; `approvalsRoute` gains `validateSearch`
  (`focus`), the inbox scrolls to `[data-approval-id]` and highlights it. `test-utils.tsx` gains
  `renderWithRouter(ui, path)` (a `createMemoryHistory` router around `renderWithProviders`);
  the bell test moves to it. Locale keys `alerts.seen/own/handOver/owned/…` in en + hi.
- **Tests:** schema census (CHECK refusals ×3); `acknowledgeAlert` idempotence + `ack_limit`; the
  event fans on the topic; bell renders the three actions and the link; inbox focuses.
- **Mutants:** ack without `acknowledged_at` → CHECK census red; link rendered for
  `workflow_instance` refType → bell test red.
- **Pins moved:** none (no permission, no route, no job). `alerts/consumer.test.ts` stays 17/17.

### T1 · CRITICAL · Kernel: percent ladders, the respond clock, the per-instance budget — `kernel/workflow`, alone, before R6
- Migration: §2.1 columns + `workflow_timers_kind_ck`. Generated on a clean tree; hand-carry the CHECK.
- `definition.ts`: `slaSchema` + `respondMinutes?`, `ladder?`; the two new problem strings.
  `timers.ts`: `scheduleSlaTimer` reads `budget_minutes ?? sla.minutes` and, when `sla.ladder`,
  schedules every rung at once with `percent`; when `sla.respondMinutes`, a `respond` timer;
  `runDueTimers` fires `respond` → `respond.overdue`; a `ladder` rung resolves like a chain rung
  (`usersHoldingRole`, duty-manager fallback — **the two call sites R6 will move; do not add a
  third: route both through one local `resolveRung()`**), payload + `percent`, `budgetMinutes`;
  coalescing (V4) at claim; **new** `rescheduleBudget(tx, instanceId, minutes, now)` and
  `cancelTimersOfKind(tx, instanceId, kind)`. `instances.ts`: unchanged except `transition` passes
  through (cancel is already instance-wide). `flow.ts`: `approvalFlowDefinition` passes
  `respondMinutes?` and `ladder?` through (the `toEqual({minutes:45, alerting:"active"})` pin at
  `flow.test.ts:6` stays because both are set only when supplied).
- `kernel/obligations/consumer.ts` (first file of the new kernel area; module key `obligations`,
  worker-installed): on `alert.acknowledged` with kind `owned`/`seen` → `cancelTimersOfKind(…,
  'respond')` for the alert's instance (`refType` `workflow_instance` → `refId`; `approval` → the
  approval's `instance_id`). On `respond.overdue` the alerts consumer raises the nudge (title from
  `defKey`/`state`/minutes only).
- **Tests:** G10's seven pins untouched and green; V2, V3, V4, V5; `events.test.ts` five → six
  names; the definition problem strings; `requests.test.ts:90` still `entry + 45 min`.
- **Mutants:** rung scheduled from breach instead of entry → V2 red; coalescing dropped → V4 red;
  ack cancels the sla timer too → V5 red.
- **Coordination:** rebase minutes before; one commit; if R6 has merged, `resolveRung()` calls
  `whoIsOn` behind the flag exactly as R6 left it.

### T4 · ROUTINE · Reach: profiles, Web Push, the relay job, the reach budget (push leg now; WA/SMS legs when providers land)
- Migration: `user_reach_profiles`, `push_subscriptions` (§2.3).
- Core: channel union widened (four places + `sent_channel` comment); `adapters.ts` gains
  `webPushAdapter` (npm `web-push`, VAPID from config) and `consoleWebPushAdapter`;
  `adaptersFor(cfg)` takes `notifyPushProvider`; the pump's `prepareRow` step 5 resolves `to` for
  `web_push` as the user's live subscriptions (all of them; a 410 revokes); templates §2.3 (10);
  `runReachLadder` job (`jobs.ts` beside `runNotifyPump`; census 18 → 19 in the four files +
  `alerts.yml`); `quietHoursDeferral` gains the staff leg: `routine` staff templates defer outside
  the addressee's department hours (T7's tables when present, else 08:00–21:00 IST) unless
  `quiet_exempt`; the reach budget (V11).
- Web: `public/sw.js` (push → `showNotification(title, { data: { link } })`, click → focus/open
  the link); `lib/push.ts` (`subscribe()`, `unsubscribe()`, permission state); route **`/me/reach`**
  (caddy 68 → 69; no NAV row — linked from the bell's footer): language, ladder order, push on/off,
  consent line. `router.tsx` recipe (dossier 04 §5).
- **Tests:** relay enqueues exactly one row per (alert, channel) and stops on ack; the 7th
  interrupt coalesces; push adapter revokes on 410 (fake); `sw.js` unit test via a `self` stub;
  templates render both languages with no patient field (V6 mutant).
- **Pins moved:** jobs 18 → 19 (five edits), templates 7 → 10, caddy 68 → 69.

### T5 · CRITICAL · Addressees, posts, chains, derived ladders on the sixteen types
- Migration: `role_parents`, `posts`, `post_holders` (§2.4). Seed chains (`scripts/seed-chains.ts`,
  run in `seed-roles`'s deploy path; test-imported so `scripts/` is type-checked — memory
  `scripts-not-typechecked`): cashier → billing_manager → finance… → owner; front_office →
  front_office_supervisor → medical_superintendent; pathologist / radiologist / pharmacist /
  materials_head / ot_incharge / nursing roles → medical_superintendent → owner; duty_manager → owner.
  Every role in `ROLE_MODEL` has a row (a test walks `ROLE_MODEL`).
- `kernel/obligations/addressees.ts` (§2.4) + `deriveLadder`; `alerts/consumer.ts`'s eight
  `usersHoldingRole` sites route through `resolveAddressee` (**one commit, rebased minutes before,
  coordinated with R6 — if R6 has landed, `resolveAddressee` wraps R6's `whoIsOn` call instead of
  replacing it**); the fallback event + its alert branch (7th subscription; pin 6 → 7).
- The sixteen types re-versioned with `ladder` from `deriveLadder` and `respondMinutes` (Now 5,
  Today 30, Can wait 240) — in each module's `approval-types.ts` registrar; `flow.test.ts` gains
  the ladder passthrough case.
- Permissions: `obligations.chains.manage` (MS, owner) — the four-edit recipe (dossier 05 §5d);
  README prose constant; `approvals: 4` unchanged (it is an `obligations` string); all ~12 pins read
  off the red run.
- **Tests:** V7 (requester excluded through the resolver), V8, V9, `deriveLadder` for a money and a
  clinical type, the drift guard still passes after re-versioning; `alerts/consumer.test.ts` 17/17.
- **Mutants:** DAG check dropped → cycle insert succeeds → V8 red; fallback event dropped → V9 red.

### T6 · CRITICAL · The delay ledger as obligations
- Migration: `obligation_delays` (§2.5). Definition `delay_review` seeded by `seed-approvals`-style
  script at deploy (kernel definition, change class C).
- `kernel/obligations/delays.ts`: consumer on `escalation.triggered` (`percent >= 100`) → row +
  `startInstance('delay_review', …)` addressed to the parent rung; verbs `excuse` / `cover` /
  `counsel` / `act` as `POST /obligations/delays/:id/<verb>`; `subject_closed` on
  `approval.granted|rejected` / task done (closes every open delay of the instance). `GET
  /obligations/delays?mine=1` — a person sees their own rung's records; a supervisor their chain's.
- Permissions: `obligations.ledger.read` (every role in `ROLE_MODEL` that can decide anything —
  the seed walks `approvals.requests.decide` holders), `obligations.ledger.manage` (MS, owner).
- **Tests:** V10 chain of three; `subject_closed`; attribution stays `'rung'`; excuse records
  `excused_by`; a delay never opens under 100 %.
- **Mutants:** attribution `'person'` by default → red; a fourth level created → V10 red.

### T7 · CRITICAL · Derivation, the hospital calendar, working minutes, the live blocking signal
- Migration: §2.6 (approvals + approval_types columns, `hospital_calendar_days`, `department_hours`).
- `kernel/obligations/working-minutes.ts` (V12); `kernel/approvals/derive.ts`:
  `derivePriority(type, input, now, calendar) → { lane, blocking, importance, signals, respondBy,
  resolveBy }` — U1 blocking from the caller (`ApprovalRequestInput.blocking?`), U2 desk-close
  (`resolveBy = min(type budget, department closes)` on the RESPOND clock only, O13), I1–I2 bands
  from the row, I3–I5 from the type; stored at file time; `requestApproval` sets
  `budget_minutes` on the instance via `rescheduleBudget` when working minutes apply. Worklist order
  becomes `lane, requested_at` (`worklist.ts:77-80` + its pins). Desk-close carry-over: at
  `resolveBy` an undecided blocking item appends `approval.carried_over` and re-files the clock at
  next opening (no delay record, C3). `POST /approvals/:id/signal` (§2.6).
- Seeds: 09:00–17:30 Mon–Sat per OPD code; a `hospital_calendar_days` admin route `POST
  /obligations/calendar` (permission `obligations.calendar.manage`, MS + owner).
- Web: the inbox card shows the lane word and the two clocks (D8: remaining, not elapsed).
- **Tests:** V12 five instants; V13; the closing-hour case (19:40 vs 20:00); a Q1 type stays
  wall-clock; `worklist.test.ts` order pins moved.
- **Mutants:** age moves a lane → V13 red; UTC arithmetic → the 05:29 case red.

### T13 · CRITICAL · Standing policy — the R2 table as data, policy grants, same-day reversal
- Migration: `approval_policies` + `approvals.status` gains `'reversed'` (§2.10).
- `kernel/approvals/policy.ts`: `livePolicyFor(tx, typeKey, now)`, `policySatisfied(policy, row)`,
  `grantByPolicy`, `reversePolicyGrant`; `requestApproval` hook after insert; seed script
  `seed-policies` = the R2 table verbatim, `authored_by` = the owner login.
- Permissions: `obligations.policy.manage` (owner only; reads by every `approvals.requests.read`).
- Web: the card says "granted by policy P-x, authored by …" with a Reverse button until midnight.
- **Tests:** V16; every R2 row exercised (16 cases: 9 grants at the ceiling, 7 nevers); the
  `firstOfDayForPatient` condition uses the C-12 snapshot; a `system` actor decides through
  `transition`, never through `decide`.
- **Mutants:** `decided_by` set to the author's user id → V16 red; reversal after midnight allowed → red.

### T11 · CRITICAL · Sequential dual control + the M-6 digest
- Migration: §2.9 columns + `approvals_second_approver_ck`.
- `flow.ts` `dualControl`; `decisions.ts` `decide` handles `countersign` (first approve → state
  `countersign`, `first_decided_by`; second → `granted`); `worklist` shows `countersigning`;
  vendor bank change, patient merge, tariff revision flip `dualControl: true`; `GET /approvals/digest`.
- **Tests:** V7 with one user in all three seats; the fourth state's own ladder; digest figures
  from a seeded week (auto-grant candidate detected; reject-under-N flagged).
- **Mutants:** CHECK dropped → census red; digest counts a `reversed` as granted → red.

### T8 · ROUTINE · Tasks: the second verb, four kinds, evidence, the station board
- Migration: `obligation_tasks`, `location_qr` (§2.7). New leaf module `modules/obligations-tasks`
  (manifest 23rd/24th after R1: append; `standup-check` NOT_DEPARTMENTS: "cross-cutting — the task
  verb of the obligation spine"; worker-installed because its consumer runs there — the app-only
  word does NOT change). Routes: `POST /obligations/tasks`, `POST /obligations/tasks/:id/evidence`,
  `GET /obligations/tasks?mine=1|post=`, `GET /obligations/board/:postKey`. Permissions
  `obligations.tasks.create` (every clinical + support supervisor role), `.act` (every role),
  `.read` — the four-edit recipe ×3.
- Web: `/obligations/board/:postKey` (a TV page, no names) and `/obligations/tasks` (mine) — caddy
  +2; the QR scan page uses the camera via `BarcodeDetector` with a typed fallback.
- **Tests:** V14, V15 (mutant), transport request → QR closes; breakdown criticality from location.

### T9 · ROUTINE · The shift brief and the handover boundary
- `GET /me/obligations` (everything a person and their posts owe, ordered by respond clock, with
  what expires in their shift — `dutiesOf` from phase R when flagged, else department hours);
  a `DeskProvider` on the obligations manifest so `/` (`GET /me/desk`) carries the top three + a
  count (D10); the login brief line in the Shell header. Handover: on the take boundary (R7's
  `unitOnTake` when present) open obligations of the outgoing person re-address to the incoming
  post with no record (V17, C6); before R7, the boundary is the post's `department_hours` close.
- **Tests:** V17; the brief lists only the person's and their posts' items; a 07:59 filing.

### T10 · ROUTINE · Anticipation: the compliance calendar and the two sweeps
- Migration: `compliance_items` (§2.8). `runObligationSweeps` job (census 19 → 20, five edits);
  seed from `aerb_licences` and the PCPNDT registration; the ageing sweep (V18); the weekly owner
  digest section. Permissions `obligations.compliance.manage` (MS, owner).
- **Tests:** V18; lead days 30/14/7/1 each file once; a waived item files nothing.

### T12 · ROUTINE · Acting from the channel — one-time tokens, WhatsApp buttons, IVR keypad (gated on providers)
- Migration: `channel_action_tokens` (`id`, `alert_id`, `user_id`, `action` CHECK IN
  ('seen','owned','approve_small'), `token_hash UNIQUE`, `expires_at`, `used_at NULL`).
- `kernel/notify/inbound/`: `POST /notify/inbound/whatsapp` (BSP webhook, signature verified),
  `POST /notify/inbound/sms` (DLT reply: ack only, O9), `POST /notify/inbound/voice` (keypad 1/2/3).
  `approve_small` only under the type's R2 band and only from a BSP-verified WhatsApp number that
  is not `shared_phone`.
- **Tests:** V11 token replay; SMS carrying `approve` refused; band check.

---

## 5. Coordination — files that belong to everyone, and what this plan does to them

| file | task | rule |
|---|---|---|
| `kernel/workflow/{definition,timers,instances,events,flow}.ts` | T1 | **alone, one PR**; R6 has merged (#279) — `resolveRung()` wraps `escalationRecipients` at `timers.ts:158` and keeps the static fallback at `:166` (§1a G9′) |
| `kernel/alerts/consumer.ts` + test | T1 (respond nudge), T5 (resolver, fallback branch) | rebased minutes before; the three moved sites (251/327/354) stay on `escalationRecipients`; the OWNER and approvals-chain sites stay on `usersHoldingRole` (§1a G9′) |
| `kernel/notify/{adapters,pump,templates,events,consumer}.ts`, `config.ts` | T4, T12 | the channel union in four places at once; templates pin whole-array |
| `kernel/db/schema/index.ts` | T1, T3, T4, T5, T6, T7, T8, T10, T11, T12, T13 | one `export *` line each; rebase first; serial at rebase (G1) |
| `kernel/modules/manifests.ts` + test | T5/T6 (`obligations` kernel manifest, worker-installed), T8 (`obligations-tasks`) | append; count read off the red run; the app-only word unchanged |
| `scripts/seed-roles.ts`, `test/seed-roles.test.ts`, `README.md` | T5, T6, T7, T8, T10, T13 | the four-edit recipe (dossier 05 §5d); every count read off the red run, never predicted; the two bare-integer arrays too |
| `test/standup-check.test.ts` | T8 (and T5 if `obligations` is a manifest) | NOT_DEPARTMENTS rows; `MANIFEST_BY_IDENTIFIER` |
| `app.module.ts`, `worker.module.ts`, `worker/jobs.ts` + the four job censuses + `alerts.yml` | T4, T5, T8, T10 | job count read red; `notify` stays worker-only |
| `test/caddyfile-parity.test.ts` | T4 (+1), T8 (+2) | one line each, dated comment |
| `apps/web/src/router.tsx`, `locales/*.json`, `test-utils.tsx` | T3, T4, T7, T8, T9, T13 | `renderWithRouter` lands in T3 and every later web test uses it; `i18n-keys.test.ts` rules |
| `modules/*/approval-types.ts` (8 modules) | T5 (ladders), T7 (importance constants), T11 (`dualControl`) | leaf edits; run each module's suite |
| `apps/core/drizzle/**` | every migration task | one per PR; **never regenerate a merged one**; generate on a clean tree; hand-carry every CHECK |

**Frozen:** `packages/contracts/*` (the `Actor` union is not widened — a policy actor is `system`
with id `policy:<id>`), `kernel/auth/*` except `ROLE_MODEL` grants, `kernel/copilot/*` (the agents'
obligations are the copilot phase's), `opd_departments` / `opd_doctor_schedules` columns, the
sixteen approval type KEYS, the seven shipped notify templates' bodies.

---

## 6. Edge cases this plan owes tests for (ids from `02-EDGE-CASES.md`)

C1 C2 C3 C4 C5 C6 C7 C8 C9 · A1 A2 A3 A4 A5 A8 A9 A10 A12 A13 · R1 R5 R6 R7 R8 R9 R10 R11 R12 ·
G1 G2 G4 G5 G6 G7 G8 · S1 S2 S3 S5 · E1 E2 E4 E5 — plus the phase doc's definition of done as
one e2e (`test/obligation-spine.e2e.test.ts`, T11's close): the 19:40 refund, the ward transport
request, the vendor bank change with two approvers, the licence thirty days out, and the owner's
phone silent throughout.

---

## 7. Out of scope — deliberately, and where it went

- Screens beyond six (bell rows, inbox focus + lane + clocks + policy line, `/me/reach`, the
  board, `/obligations/tasks`, the desk card): the S-series after the boards are drawn.
- The subject modules' reactions to `approval.policy_reversed` (billing credit note, materials
  restock): one task per module, named when the module is touched.
- WhatsApp BSP and DLT SMS go-live, voice/IVR: a runbook when the templates are approved (§8).
- The agents' own obligations and the copilot tools: the copilot phase.
- Committees, external parties, `unit` addressees beyond the roster flag: T5 declares the kinds;
  the resolvers for `committee` and `external` return the owning seat's users in phase one.
- Person attribution on the ledger (O5): switches on with phase R's R5 — a one-line flag in T6,
  named `OBLIGATIONS_ATTRIBUTE_PERSONS`, default false.
- The decision packet (L1) and the dashboard rail beyond the desk card (L9): the approvals-spine
  phase's own tasks (#265's doc).

---

## 8. Phases after O, in order — each authored when reached

**S** the six screens' boards → **P** providers go-live (DLT header, BSP templates, VAPID keys in
prod, voice) → **A** attribution on (R5 merged) + the HR export for contractor firms (RO-5) →
**C** the compliance calendar content per statute (AERB, PCPNDT, drug licence, fire NOC, BMW,
GSTR, TDS, NMC) → the copilot phase (agents file, chase, answer their own delays).

---

## 9. CLOSE — filled at execution

9.1 kickoff measurements (§1, corrected) · 9.2 migration serials actually written · 9.3 pins
before/after each task · 9.4 verify counts per task · 9.5 mutant tally · 9.6 close review pass 1 +
remediation + pass 2 · 9.7 token actuals · 9.8 handoff if any.
