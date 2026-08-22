# Phase 1 / Plan 11c — Operating modes, the downtime kit, and an alert path that reaches a human · Implementation Plan

**Written 2026-08-23 by the next-phase brainstorm session** (prompt:
[`reports/NEXT-PHASE-BRAINSTORM-PROMPT-2026-08-23.md`](reports/NEXT-PHASE-BRAINSTORM-PROMPT-2026-08-23.md)),
against the tree at **`8ec862f`** (== `origin/main`; all four 11a-addendum commits present).
Spike brief: [`reports/PLAN-11C-SPIKE-BRIEF-2026-08-23.md`](reports/PLAN-11C-SPIKE-BRIEF-2026-08-23.md) ·
**spike report: [`reports/plan-11c-spike-report.md`](reports/plan-11c-spike-report.md).**

> **FORK CLOSED 2026-08-23 by the execute session, against measurement.** D12 (the L14 census
> shape) was the one open fork; it is **RESOLVED** — 30/30 green isolated on the build host, with
> two amendments the measurement forced and which are written into D12 below. T6's SMTP shape is
> likewise settled: **587/STARTTLS, and 465 is BLOCKED outbound on this box**, so it is not a
> fallback (D10). Execute-prerequisites 3 and 4 are discharged. Nothing in this document is
> fork-open any more; where superseded text survives it is marked dead where it stands (§2.48).

Execute prompt:
[`reports/PLAN-11C-EXECUTE-PROMPT-2026-08-23.md`](reports/PLAN-11C-EXECUTE-PROMPT-2026-08-23.md).
The writer of this plan does not execute it (the separation that has paid three times).

**Baseline at writing (gate-report addendum, 2026-08-23):** `apps/core` **138 suites / 961 tests** ·
`apps/web` **31 / 152** · `packages/contracts` **3 / 7**. Re-measure at compile; measurement beats
this document.

## Why 11c is next (argued in the brainstorm, owner-approved 2026-08-23)

The critical path to the stage-2 pilot is no longer feature code. Registration, OPD, billing (with
dues/advances/refund guards — Plan 08 SHIPPED, whatever the roadmap's stale status line says), the
runtime loop, notifications and deployment all exist and are live at `https://hmis.crkmch.com`.
What stands between here and "weeks of live use as the secondary HMIS" is (a) the one go-live gate
that is pipeline-shaped code — exactly this plan — and (b) a stack of owner/counsel artifacts with
multi-week lead times that no pipeline can produce (listed under Execute-prerequisites and
Decisions).

**Deliberately not next:** Plan 09 (owner ruled 2026-08-23: no live memberships in the pilot — the
roadmap default slot holds, after 11c and before cutover) · Plan 12a (its mode gate CONSUMES this
plan's operating-mode service — fix 27; its DPIA/inference-locus gates have not started; its
proofs want live baselines) · the relay (E-1 still open, and it blocks only the relay) · a
standalone hardening plan (its code-shaped residue is small enough to ride here as Phase 0 and
T6; the rest is owner action).

## Owner rulings this plan encodes (2026-08-23, in conversation)

1. **Plan 11c runs next**, expanded into the pilot-readiness plan; Plan 09 after it (no live
   memberships in the pilot); Plan 12a after that.
2. **The alert sink is EMAIL over SMTP** — Alertmanager → the owner's inbox. The SMTP credential
   is the project's first real outbound credential; it lives in `/opt/hmis-prod`, never in git,
   and **joins the escrow list** beside `SECRET_KEY` and the pgBackRest cipher passphrase.
3. **The downtime kit prints as print-HTML now; a server-side PDF renderer is the IPD-era
   upgrade**, booked in D13's deferred list — zero new npm dependencies in this plan.
4. Standing rulings inherited and untouched: retention stays INERT (`RETENTION_ENABLED=false`
   until counsel signs) · staged deployment (spec v4.7) · production shares the build host under
   the `hmis-prod` project (rules 3 and 7 as amended).

## Design (the decisions this plan makes — read before the tasks)

### D1. The operating-mode service: append-only rows, commissioning by default

Modes are `commissioning | ramp | normal | degraded | downtime` (E-10's commissioning/ramp flag
and map 1's downtime, one enum). State is an **append-only** table `operating_mode_changes` —
current mode = the row with the highest `seq`, a **`bigserial`**, never `max(id)` and never
`max(at)`: `newId()` ULIDs are non-monotonic within a millisecond (Plan 06.1 audit A1) and two
changes in one clock tick must still order (Book V5). History therefore comes free, and every
change carries actor, note and the validation-report reference.

**Zero rows reads as `commissioning`, and that is load-bearing, not a fallback** (Book V1): a
freshly-migrated deployment — including the live `hmis-prod` today, which is UAT, not a
go-live — IS commissioning until D-17's gate passes (D3). Reads are one indexed
`ORDER BY seq DESC LIMIT 1`; no cache, no middleware, no in-memory state (multi-process rule).
`getOperatingMode(db)` is the one read seam — the Shell banner polls it over HTTP, and **Plan
12a's fix-27 mode gate is its named future consumer**.

### D2. Why mode is a table and not a workflow instance (§10.2, recorded exception)

"Every SLA-bearing lifecycle is a workflow instance" — and operating mode bears no SLA, no
approver ladder, and no per-subject instances: it is one hospital-wide value. The decisive reason
is dependency direction: **a downtime declaration must not depend on the workflow engine being
healthy**, because degraded-and-down states are exactly when it is declared. The mode service
depends on the database and the event append and nothing else. Recorded here as §10.2's second
Phase-1 exception (billing's cashier session is the first), with the reason.

Transition legality is a small code matrix, not definition data: `commissioning` is
initial-only (never a target — Book V3); leaving `commissioning` requires D3's gate (Book V2);
every other transition is free under the permission, with a **mandatory note when entering
`downtime` or `degraded`** (Book V4) — map 1's declare/recover authority is the permission
`ops.mode.set` (duty-manager-role data at go-live; seeded `admin` holds every permission in dev).
A no-op transition (`to === current`) is refused (`mode_unchanged`) so the history never carries
a change that changed nothing.

### D3. The commissioning exit IS D-17's gate — E-10 and D-17 compose into one guard

`changeOperatingMode` refuses `commissioning → ramp|normal` unless the **latest**
`config_validation_reports` row has `ok = true` and `at` within **24 h** (code constant
`VALIDATION_FRESH_HOURS = 24`). This is what keeps the mode service from being §2.49 ornament and
keeps D-17 from being a script nobody is forced to run: **the only way to leave commissioning is
through a fresh, persisted, all-green validation report** (Book V2, V8). The refusal names what is
missing (`golive_gate_unsatisfied` with `no_report | stale_report | report_not_ok` detail).

### D4. Mode changes reach humans through the shipped alerts fabric

`ops.mode_changed` joins `alertsManifest.subscriptions` and the `kernel.alerts` consumer gains a
third branch: transitions **into or out of `downtime`/`degraded`** raise an alert for every
holder of `OWNER_ROLE` (map 1: owner alerted, never required to act; the declaring duty manager
is not re-notified about their own act). The branch reuses `raiseAlerts` verbatim — the
`(source_event_id, user_id)` idempotency, the won-insert-only `alert.raised` append, and the
no-patient-identity rule all come free (`consumer.ts:78-125`). Manifest edit and consumer branch
are ONE edit (the rule `alerts/manifest.ts:19-28` already states). Book V6.

### D5. `validate:config` — one D-17 aggregate over every module validator, persisted

`kernel/ops/validate.ts` exports `runConfigValidation(db, now)`: it calls the two shipped
validators — `validateTariffConfig(db, now)` (`modules/tariff/index.ts:8`; report
`{ok, errors, caSigned}`) and `validateBillingConfig(db)` (`modules/billing/config`; report
`{ok, errors}`) — computes `ok = every scope ok` (for tariff, `ok && caSigned`), **persists a
`config_validation_reports` row** (per-scope results as JSONB), and appends **`ops.config_validated`**
(new event, module `ops`). It deliberately does NOT emit tariff's `config.validated` — that
event's `scope` is `z.literal("tariff")` (`modules/tariff/events.ts:10`) and widening a shipped
module's catalog for an aggregate would be scope creep; the tariff script keeps its own event
when run alone. `scripts/validate-config.ts` (`pnpm validate:config`) is the runbook-facing
runner: prints per-scope verdicts, exits non-zero unless `ok=true` — proven in both directions
(flag ①). A hardcoded-ok or ignored-validator aggregate is Book V7's mutant; the guard reading
the PERSISTED latest row (not a value in memory, not an older ok) is V8's.

### D6. The interface heartbeat framework — the seam ships, a synthetic proves it

Spec §11.14's `interface.down/.restored` framework (the spec's own names, kept verbatim even
though `down` breaks the `verb_past` grammar — design law wins and the deviation is recorded
here). `interfaces` table: id, kind (`printer|scanner|other`), name, location,
`stale_after_ms` (per-device, default 180 000, zod-min 30 000), `last_seen_at` (nullable),
`status` (`unknown|up|down`), `active`. Status is a column, not an instance — device liveness is
monitoring state, not an SLA-bearing work lifecycle; same §10.2 reasoning as D2.

Semantics, each with its own discriminating fixture: a heartbeat sets `last_seen_at` and flips
`unknown→up` silently, `down→up` with `interface.restored` appended (Book V11) · the sweep
(`sweepInterfaceHeartbeats`, **the TENTH job**, cadence `WORKER_INTERFACE_SWEEP_INTERVAL_MS`
default 60 000) downs only `active` rows currently `up` whose `last_seen_at` is older than their
own `stale_after_ms`, appending `interface.down` (V9) · a registered-but-never-seen interface is
NEVER downed — there is nothing to lose and the event would be noise (V10). Stage 1 has no
physical printers; the e2e drives a synthetic registrant end to end, and the seam is the
deliverable — 11b's printer/scanner registration lands on it.

> **BINDING ON T3, from the spike's question-A measurement (D12 amendment 2):** R0-2 shrinks the
> L14 census span to **9 h 05 m**. T3's new `workerInterfaceSweepIntervalMs` entry in
> `CENSUS_INTERVALS` must therefore be **under 9 h 05 m** or the tenth job never fires inside the
> census window. Its four neighbours there are 4/6/8/9 h; anything at or below 8 h is safe. The
> failure is loud — the set-equality assertion goes red naming the missing job — but it is a
> wasted rung, so it is written here.

**The tenth job is a census event, enumerated completely** (§2.65/§2.73, measured at `8ec862f`):
the cadence is a real config key, so `JobIntervals` WIDENS — the Pick at `jobs.ts:79-110` plus
all **three** object literals (`scheduler.test.ts:223` `CENSUS_INTERVALS` · `jobs.test.ts:131`
`INTERVALS` · `retention/sweep.test.ts:702-713`) — and the censuses move 9→10 in
`scheduler.test.ts:140` (`THE_NINE`→`THE_TEN`, plus the spy list), `worker-runtime.e2e.test.ts:100`
and `:366`, `alerts.yml` (all THREE places: the interval `job=~` leg and one `absent()` term —
it is an interval job, so the daily leg does not change), and **`alerts-parity.test.ts:100-101`'s
deliberate count pin 9→10**. Every one of these files is in T3's Files list. Re-run the grep
after Phase 0 before compiling (§2.73) — Phase 0 here adds no literal, but the rule is the rule.

### D7. The downtime kit reserves ITS OWN serials — billing's `document_series` is never touched

Map 1's paper forms carry serials from reserved ranges so recovery can prove every sheet
accounted for. The serial is a **reconciliation key, not a document number**: recovery backfills
real documents with real invoice numbers (per-FY, GST-consecutive, billing-owned), so the kit
allocates from its own `downtime_form_counters` (`form_kind` PK, `next_serial`), advanced under a
single-winner row lock (`UPDATE … RETURNING`, the shipped series pattern — and the 06.1 C1
ordered-lock lesson: counters are locked in `form_kind` order when one generation spans several
kinds). Concurrent generations yield DISJOINT ranges — measured, not asserted (Book V13, race
floor ≥15 runs per §3.22); sequential kits are contiguous with no gap and no overlap (V14). Form
kinds at stage 1 are the code constant `["registration", "consultation", "receipt"]` — a design
decision, promotable to data when a real drill demands a fourth kind. `downtime_kits` +
`downtime_kit_ranges` (FK) record what was issued to which desk, and `downtime.kit_generated` is
the event.

### D8. Print-HTML now; the PDF renderer is the IPD-era upgrade (owner ruling 3)

The kit prints from the web app through the shipped `.print-doc` isolation
(`styles.css`; `invoice-print.tsx:24-26` states the mutual-exclusion convention the kit screen
honours). Zero new dependencies; the spec's dedicated PDF-renderer process arrives when IPD
documents need server-side PDFs, and D13 books it.

### D9. Every form carries a signed QR (E-23)

Per-serial payload `dtk1.<kitId>.<formKind>.<serial>` signed with the kernel HMAC
(`kernel/crypto.ts:30` `hmacSign` / `:34` `hmacVerify` — Plan 02's utility, consumed not
recreated). `verifyKitSerial(key, qr)` returns the parsed triple or `null`; a tampered serial
fails (Book V15). Backfill-time consumption (scan → verify → reconcile) is recovery-procedure
scope documented in T6's runbook; the verify helper ships now so the printed paper is
verifiable from day one.

### D10. Alertmanager: `severity: critical` reaches the owner's inbox, and no secret enters git

> **MEASURED 2026-08-23 by the spike ([report](reports/plan-11c-spike-report.md), questions B and
> C) — four facts, all binding on T6:**
>
> 1. **SMTP stays `587` with STARTTLS, as written below.** Confirmed against two independent
>    providers, IPv4 and IPv6: TCP connects, TLS 1.3 establishes, certificate verifies, the server
>    reaches `250`.
> 2. **`465` is BLOCKED OUTBOUND on this box — it is NOT a fallback.** Silent timeout (`rc=124`,
>    no output at all, the drop signature rather than a refusal) on both providers and both address
>    families; port 25 is blocked too. **A provider that offers only implicit-TLS 465 cannot be used
>    here without a relay.** Recorded because the plan elsewhere assumed 465 was an available
>    alternative; it is not. *(Execute-prerequisite 4 is thereby discharged: no relay decision is
>    owed by the owner.)*
> 3. **The compose service MUST give `/alertmanager` a NAMED volume.** `prom/alertmanager:v0.27.0`
>    declares `VOLUME`, so without one every recreate strands another anonymous volume and loses the
>    silence and notification-log state across restarts. This is gate report §7.8's exact specimen —
>    the stray anonymous Prometheus volume that the T6 mechanical check rejected a task over — and
>    it is the one new volume the post-W6 roster may gain.
> 4. **Alertmanager REDACTS the receiver URL in its own notify log** (`Post "<redacted>"`). Flag ⑤'s
>    drill evidence therefore comes from the alert's `receivers` field and `amtool`, never from an
>    expectation that the log names the SMTP endpoint.
>
> Also confirmed so T6's first rung is not a discovery: the pinned tag boots this exact routing
> shape, answers `/-/ready` and `/-/healthy` 200 on loopback, dispatches a `severity: critical`
> alert immediately under `group_wait: 0s`, routes `warning` to the grouped leg, and **ships
> `amtool`** — no curl-only fallback shape is needed.

The 11a gate report's §7.6, closed. A ninth compose service (`prom/alertmanager:v0.27.0`,
`127.0.0.1:9093`, resource-limited like its neighbours), an `alerting:` block in
`prometheus.yml`, and a routing config that sends `severity: critical` immediately and
`warning` on a long group interval — **derived at deploy time, never committed**: the owner
supplies `/opt/hmis-prod/.env.smtp` (six keys: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`; chmod 600), and `deploy.sh` step 2
translates the committed **template** `docker/prod/alertmanager/alertmanager.yml.tpl` into
`$DEPLOY_DIR/alertmanager/alertmanager.yml` (600) exactly as it derives `.env.pgbackrest` from
`.env.r2` (`deploy.sh:169-217` — the precedent, one directory over). The password goes into a
separate `smtp_password` file referenced via `smtp_auth_password_file`, so the derived yml never
carries it either. **A missing `.env.smtp` is a `die` with the shape printed** — the `.env.r2`
precedent: an unreachable alert sink must fail the deploy loudly, not ship a crash-looping
service that step 6b would catch anyway with a worse message. Alertmanager reads config at
startup, so it joins the §2.77 restart loop (`deploy.sh:297-303`) beside prometheus and grafana.
Owner email addresses and SMTP hosts stay out of the public repo — the template carries
placeholders only.

### D11. The backup-drill watcher — the negative-space rule applied to the DR story (note 10)

Nothing today notices a restore drill that stops passing: the drill events
(`backup.drill_passed/.drill_failed`, `retention/events.ts:105-106`) land in a table nobody
watches, and on a single server the drill IS the DR story. One custom query in
`postgres-exporter/queries.yml` serves `hmis_backup_last_drill_pass_age_seconds` (age of the
newest `backup.drill_passed` by `recorded_at` — index-served, the events name index) and a NEW
rule file `docker/prod/prometheus/alerts-backup.yml` carries `HmisBackupDrillOverdue`
(critical: age > 8 days — one missed weekly drill plus a day) and `HmisBackupDrillFailed`
(critical: a `drill_failed` newer than the newest `drill_passed`, served by a second query
column). **A second rule file, deliberately**: `alerts.yml` is pinned three ways by
`alerts-parity.test.ts`, whose parsers THROW on shapes they do not recognise (its own §2.49
defence) — backup rules do not belong inside the scheduler-parity surface. `prometheus.yml`'s
`rule_files` list grows by one line; the rules are proven by `promtool test rules` executed in
the task (flag ⑥), not by reading YAML.

### D12. Phase 0 / R0-2 — the L14 census flake, fixed by SHAPE, resolved by the SPIKE

> **RESOLVED 2026-08-23 by the spike ([report](reports/plan-11c-spike-report.md), question A).
> Read the rest of this section as the reasoning that produced the fork, not as a live choice.**
> The stepwise direction WON and R0-2 ships it. **The fallback — a test-only daily-check seam on
> `Scheduler` — is DEAD and is not to be built.** Three things the measurement changed, and they
> are binding on R0-2 because the shape below is not literally what this section described:
>
> 1. **The settle is REAL EVENT-LOOP TURNS, and this is the load-bearing half of the fix.** "Settle
>    room" below does not say what settle room *is* under fully-faked timers — and it cannot be
>    `setTimeout`/`setImmediate`/`queueMicrotask`, because the census fakes all three. R0-2 captures
>    the real timer at module load (`const realSetTimeout = setTimeout;`) and yields *n* genuine
>    turns through a `settleRealTurns(n)` helper. A fixed COUNT, not a time budget: on a starved
>    container each turn takes longer, so the same count buys proportionally more real time exactly
>    where more of it is needed. It asserts nothing and cannot fail (GC8 is not engaged).
> 2. **The span SHRANK, 25 h → 9 h 05 m**, which this section did not state and which is what makes
>    the tick count fall (~3 000 → ~1 090, −63.7 %). The five daily instants all fall within 7 h
>    45 m of the pin, and the longest cadence in `CENSUS_INTERVALS` is `workerTempRolesIntervalMs`
>    at 9 h. **This binds T3:** its new `workerInterfaceSweepIntervalMs` census value must be
>    **under 9 h 05 m** or the tenth job never fires. The failure is loud, not silent — the
>    set-equality assertion goes red naming the missing job — which is the only reason a bare
>    constant is acceptable there rather than a computed maximum.
> 3. **The test's NAME changes** (`…within a faked 25 hours advanced from a pinned instant` →
>    `…across a stepwise advance from a pinned instant`). Grepped at `349c735`: no parity test, no
>    other suite and no CI config pins the old name.
>
> **Measured: 30/30 green isolated, runtime PARITY (median 2735 ms vs the shipped 2717 ms), full
> suite green beside it, typecheck and lint exit 0.** §7.9's constraint — *must not multiply the
> ~3 000 real DB reads* — is satisfied with room to spare, at equal wall clock. The brief predicted
> a runtime reduction; there is none, and the spike said so plainly.
>
> **AND THE CAVEAT THAT MATTERS MOST, which the brief did not ask for and the spike ran anyway:**
> under `taskset -c 0` starvation the SHIPPED shape is *also* **10/10 green** on this host, as is
> the stepwise one. **So the 30/30 demonstrates determinism; it does not DISCRIMINATE between the
> two shapes.** No measurement available on the build host reproduces the failure at all — gate
> report §3a's CI observation (~16 % red per run, red twice consecutively) remains the only
> evidence it exists. **The post-ship CI window is the real confirmation, and the Pipeline Notes'
> "a post-R0-2 census red is a REGRESSION SIGNAL, not a flake to re-run past" is therefore
> load-bearing rather than belt-and-braces.**

Gate report §3a/§7.9, with the runtime/flake trade stated there. Root cause (written inside the
test itself, `scheduler.test.ts:250-261`): the Scheduler takes its daily tick from its
CONSTRUCTOR (`scheduler.ts:115-119`, default 30 000), the census passes `CENSUS_DAILY_TICK_MS =
30_000`, so `runDailyClose`'s one-IST-minute window is sampled ~2 ticks — and each tick's
`isDailyDue` awaits a REAL database read (`scheduler.ts:208-217`), which under
`advanceTimersByTimeAsync`'s compressed clock on a starved CI container does not settle before
`stop()` latches. Lowering the tick multiplies real DB reads (~3 000 → ~18 000) — refused.

**The fix this plan takes: advance to each daily instant explicitly.** From the pinned start
(`2026-08-21T12:00:00Z` = 17:30 IST) the five daily instants are known (23:55, 23:59 IST, then
00:05, 00:15, 01:15 next IST day); the census replaces the single 25-hour sweep with a stepwise
sequence — advance TO just past each instant, then advance a small, bounded number of ticks with
settle room so the due window is crossed deterministically and every tick's DB promise resolves
before the next step. Same assertions (`jobs()` census + invoked-set equality + the
`DATABASE_URL`-unset guard at `:269-277` untouched); M-S2's grave (`:304-339`) is a separate
test and is not touched. ~~**This shape is a prediction until the spike runs it ≥30× isolated on
the build host and reports the observed rate and runtime** — spike question A. If the measured
rate is not 0/30-or-better, the spike names what it observed and R0-2 is re-authored against the
measurement (fallback direction: a test-only seam on `Scheduler` to invoke the daily check
directly — a scheduler.ts change this plan does not make on speculation).~~ **STRUCK — the spike
ran it 30/30; the shape is measured, not predicted, and the `Scheduler`-seam fallback is dead.
The verbatim diff R0-2 ships is in the spike report §A.9.** Book R2 is a measurement row, not a
mutant row.

### D13. What this plan deliberately does NOT build

The relay (E-1) · real WhatsApp/SMS providers (`NOTIFY_PROVIDER` stays `console`; the BSP
onboarding clock is an owner action — Decisions 2) · Alertmanager→WhatsApp (email is stage 1's
sink; the gateway grows real channels with provider selection) · rewiring billing's E-24
degraded-tender flag onto the mode service (a documented seam: the counter's flag is
billing-config data today; unifying it is a one-consumer change AFTER modes exist in anger) ·
mode-aware allocators (note 9 — allocators take mode as INPUT when they are built; the read
seam is what ships here) · the PDF renderer (owner ruling 3; IPD era) · the owner
daily-collection digest (12a's Digest Writer) · retention flipping (counsel) · quarterly
downtime DRILLS as tracked tasks (map 1 — they need a live hospital and land with the pilot
runbook, not a pipeline) · Loki, contact-point sprawl, Grafana-behind-Caddy (unchanged 11a
decisions).

## Phase 0 — before the pipeline (two commits, after the spike, before compile)

- **R0-1 — strip `X-Powered-By`** (gate report §7.7, the one-liner T6 was offered).
  `configureApp` (`app.bootstrap.ts:8`) gains
  `app.getHttpAdapter().getInstance().disable("x-powered-by")` — in `configureApp` so every e2e
  app and production get it from the one shared place; `test/health.e2e.test.ts` asserts the
  header ABSENT (naming the field that would make it appear — evidence discipline §2.6). Book R1.
- **R0-2 — the L14 census restructure** per D12, in the shape the spike measured. Files:
  `apps/core/src/kernel/worker/scheduler.test.ts` ONLY. Its evidence is the spike's ≥30/30 plus
  an in-run 10× isolated re-verify quoted in the report. Book R2.

## Consumed shipped surfaces (transcribed from source at `8ec862f`, 2026-08-23, this session)

- **`Scheduler`** — `kernel/worker/scheduler.ts`: constructor 4th arg `dailyTickMs` default
  30 000 (:115-119) · `isDailyDue` awaits a real heartbeat read, `pastInstant` `>=` at :210,
  `istDayIndex(hb.lastOkAt) < istDayIndex(now)` at :217 · IST constant :67. Not modified.
- **`registerAllJobs` / `JobIntervals`** — `kernel/worker/jobs.ts`: the Pick :79-110 with the
  amendment-7 warning (widening is a TYPE event) · nine registrations :145-229 · daily instants
  are code constants :20-31 · reads no environment (:129-134, the B1 scar) · the 8th/9th-job
  comments :194-217 narrate exactly the census dance T3 repeats. T3 adds one `every`
  registration + one Pick key.
- **The job-name censuses (§2.65, measured at `8ec862f`):** `scheduler.test.ts` — `THE_NINE`
  :140, `CENSUS_INTERVALS` :223, `CENSUS_DAILY_TICK_MS` :261 (with the finding), census test
  :279-302, M-S2 :304-339, `DATABASE_URL` guard :269-277 · `test/worker-runtime.e2e.test.ts` —
  `THE_NINE` :100, `jobs()` equality :366, **subscription pairs asserted WHOLE at :317**
  (`["kernel.alerts", ["escalation.triggered", "notification.failed"]]` — T1's new subscription
  edits this line) · `jobs.test.ts` — `INTERVALS` literal :131-140 · `retention/sweep.test.ts` —
  `JobIntervals` literals :702-713. **Three `JobIntervals` object literals total; every owner
  named in a Files list.**
- **`alerts-parity.test.ts`** — registration-order parser :48 (throws on unrecognised shape),
  count pin `toHaveLength(9)` :100-101 (T3 moves to 10), the two `job=~` legs + `absent()` set
  disjointness. `caddyfile-parity.test.ts` untouched.
- **`config.ts`** — schema :34-81 (every worker key defaulted — the B1 scar comments :57-59,
  :63-64; the `RETENTION_ENABLED` two-string-enum lesson :70-78 — T3's new key is a plain
  positive int and copies the `WORKER_*_INTERVAL_MS` shape); `AppConfig` :83-105; `loadConfig`
  :107. T3 adds `WORKER_INTERFACE_SWEEP_INTERVAL_MS` default 60 000, defaulted, no `.env`
  change anywhere.
- **The alerts fabric** — `kernel/alerts/manifest.ts` (subscriptions :19-28; the
  manifest+consumer-are-one-edit rule) · `kernel/alerts/consumer.ts`: name-routing :56-64,
  `raiseAlerts` :78-125 (per-recipient own-tx, `(source_event_id, user_id)` conflict target :98,
  won-insert-only `alert.raised` :101-122, NO patient identity in any column :41-48),
  `OWNER_ROLE` :21, `usersHoldingRole` import :8. T1 adds one routed branch + one subscription.
- **`app.module.ts`** — `registry.install(...)` :44-54 (seven module manifests + `alertsManifest`).
  T2 adds `opsManifest`; `syncPermissions` mirrors at boot (`auth.module.ts:25`), no new boot-time
  DB call.
- **`app.bootstrap.ts`** — `configureApp` :8-11 (body parsers; callers pass `bodyParser: false`).
  R0-1's home.
- **`health.controller.ts`** — `@Public() @Get()` on `Controller("health")`; freshest-heartbeat
  staleness; `degraded` never `down`. Not modified (mode is NOT added to `/health` — the banner
  reads `GET /ops/mode` authenticated; `/health` stays the unauthenticated machine surface).
- **`truncateAll`** — `test/helpers/db.ts:51-84`: group statements with the two transcribed FK
  rules (§3.35/§3.12). T1 adds three statements: the ops group
  (`operating_mode_changes`, `config_validation_reports`), the interfaces statement, and the kit
  group (`downtime_kit_ranges, downtime_kits, downtime_form_counters` — one statement, the FK
  rides it).
- **Validators (D-17's shipped precedents):** `validateTariffConfig` re-exported at
  `modules/tariff/index.ts:8`, report `{ok, errors, caSigned}`, evented per-run by its own script
  (`scripts/validate-tariff-config.ts`, `config.validated` scope-literal `"tariff"` —
  `modules/tariff/events.ts:10`) · `validateBillingConfig` (`modules/billing/config`), report
  `{ok, errors}`, deliberately NO event (billing's closed twenty-name catalog —
  `scripts/validate-billing-config.ts:8-11`). Consumed, not modified.
- **`kernel/crypto.ts`** — `hmacSign(key, payload)` :30, `hmacVerify` :34; `CONFIG` provides
  `secretKey: Buffer`. Consumed by D9.
- **Events plumbing** — `defineEvent` from `@hmis/contracts`; `appendEvent` in
  `kernel/events/append.ts`; the retention-events file (`kernel/retention/events.ts`) is the
  house pattern for a kernel events file, including the no-per-run-noise rule its header states.
- **`newId()` is non-monotonic ULID** (Plan 06.1 audit A1); every ordering in this plan rides a
  `bigserial seq` (the 06.2 Option-B precedent).
- **Web:** `router.tsx` `Shell` :27-52 (nav links, `AlertsBell` :52 — the banner mounts beside
  it) · `.print-doc` isolation convention (`invoice-print.tsx:24-26`; TokenSlip/RxPrint
  precedent: a screen REPLACES itself with the print surface) · `lib/opd-api.ts` is the
  fetch-module precedent for `lib/ops-api.ts` · locale key parity is mechanically tested
  (Plan 05) — every new key lands in BOTH `en.json` and `hi.json`.
- **`docker/prod/` (sequential owners, all shipped):** `docker-compose.prod.yml` — EIGHT
  services (db, api, worker, caddy, node-exporter, postgres-exporter, prometheus :270-294,
  grafana :308-325), loopback-only monitoring ports, resource limits on every service ·
  `deploy.sh` — step 2 installs :133-167, the `.env.r2`→`.env.pgbackrest` derivation :169-217
  (D10 copies this shape), the §2.77 restart loop :297-303, **step 6b's whole-service-set gate**
  :307-350 (a ninth service is covered with NO edit), cron :352-382, `SITE_HOST` extraction
  :389 · `prometheus.yml` — `rule_files` single entry, NO `alerting:` block (T6 adds both),
  `honor_labels: true` on the postgres job (load-bearing, measured) ·
  `postgres-exporter/queries.yml` — the heartbeat query D11's query sits beside ·
  `prometheus/alerts.yml` — the three scheduler rules, pinned by parity.
- **Migrations** — latest `0016_bright_thor.sql`; **next is `0017`** (measured).
- **Roles seeded today:** `admin` only (`scripts/seed-admin.ts:29-34` — grants EVERY manifest
  permission). `duty_manager` and `owner` are role DATA created at go-live/runbook time
  (`consumer.ts:21-28` already names both constants).

## Global Constraints

1. **No new npm dependency; a `pnpm-lock.yaml` diff anywhere is a halt** (owner ruling 3 made
   this free — print-HTML, and Alertmanager is a container image, not a package).
2. **No secret in git, ever**: no SMTP host, user, password, or owner email address — the
   template carries placeholders; derived files live in `/opt/hmis-prod`, chmod 600.
3. **Migration `0017` ONLY, owned by T1**, generated once via `db:generate`, full output
   committed; rollback stated in the task before the generator runs (AGENT-RULES §6).
4. **Retention semantics untouched**: nothing in this plan reads or changes
   `RETENTION_ENABLED`, the sweep, or the holds. Nothing assumes deletion happens.
5. **The mode read is one indexed SELECT by `seq`**; no cache, no in-memory state, no
   middleware on request paths (perf budgets untouched).
6. **Alert rows never carry patient identity** (existing GC, restated because T1 adds a consumer
   branch — mode alerts carry mode words and a note, nothing else).
7. **Serial ranges are disjoint under concurrency, proven by measurement** (§3.22: the run count
   in V13 is a floor; report the observed rate).
8. **Every clock-reading function takes `now: Date = new Date()`**; no wall-clock timing
   assertions (08.5 GC9/10); no fixture derives from the wall clock (§3.31).
9. Workspace totals never decrease; no test deleted (AGENT-RULES §4); no per-task count targets.
10. **Config that ships must demonstrably take effect** (GC14's inheritance): the one new key has
    a take-effect assertion through the production registration shape (Book V12).
11. **Production containers**: rule 7 as amended governs; T6 is the ONLY task authorized to act
    on `hmis-prod`, and its brief says so in as many words (see T6 — §2.71's named-deploy-owner
    rule).
12. **Infra work is verified by drills that actually ran**; transcripts go in the gate report.
13. **Frozen unless a Files list names it**: the dispatcher, the notify pump and gauntlet, the
    retention sweep, everything under `modules/billing|tariff|patients|opd`, `caddyfile-parity`,
    the dev compose, `.github/workflows/*` (rule 10).
14. **Portability (spec v4.7)**: nothing provider-specific — Alertmanager+SMTP stand up from
    Compose on any metal; re-pointing means editing `/opt/hmis-prod/.env.smtp`, no file in git.

## File Structure (locked; the frozen-path block is GENERATED from these lists — §2.25)

```
apps/core/
  src/app.bootstrap.ts                              R0-1 (disable x-powered-by)
  test/health.e2e.test.ts                           R0-1 (header-absent assertion)
  src/kernel/worker/scheduler.test.ts               R0-2 (D12 census shape) · T3 (THE_NINE→THE_TEN, CENSUS_INTERVALS key, spy)
  drizzle/                                          T1 (0017 generated + meta/; full output committed)
  src/kernel/db/schema/ops.ts                       T1 create (6 tables: operating_mode_changes, config_validation_reports, interfaces, downtime_kits, downtime_kit_ranges, downtime_form_counters)
  src/kernel/db/schema/ops.test.ts                  T1 create
  src/kernel/db/schema/index.ts                     T1 (barrel export)
  test/helpers/db.ts                                T1 (three truncate statements)
  src/kernel/ops/mode.ts                            T1 create (getOperatingMode · changeOperatingMode · matrix · D3 guard)
  src/kernel/ops/mode.test.ts                       T1 create (V1-V5, V8's guard half)
  src/kernel/ops/events.ts                          T1 create (ops.mode_changed) · T2 add (ops.config_validated) · T3 add (interface.down/.restored) · T4 add (downtime.kit_generated) — each owner ADDS ITS NAMED DEFINITIONS AND NOTHING ELSE (§2.72: enumerated, not "change nothing else")
  src/kernel/alerts/manifest.ts                     T1 (subscription: ops.mode_changed → kernel.alerts)
  src/kernel/alerts/consumer.ts                     T1 (third routed branch; raiseAlerts untouched)
  src/kernel/alerts/consumer.test.ts                T1 (V6 + redelivery)
  test/worker-runtime.e2e.test.ts                   T1 (:317 subscription pair gains ops.mode_changed) · T3 (census 9→10)
  src/kernel/ops/validate.ts                        T2 create (runConfigValidation + report persistence)
  src/kernel/ops/validate.test.ts                   T2 create (V7, V8's writer half)
  scripts/validate-config.ts                        T2 create
  package.json                                      T2 ("validate:config" script line ONLY)
  src/kernel/ops/manifest.ts                        T2 create (opsManifest: permissions ops.mode.set · ops.downtime.generate · ops.interface.manage; two menu entries; subscriptions [])
  src/kernel/ops/ops.controller.ts                  T2 create (mode + validation routes) · T3 add (interface routes) · T4 add (kit routes) — enumerated per owner
  src/kernel/ops/ops.module.ts                      T2 create
  src/app.module.ts                                 T2 (registry.install(opsManifest) + OpsModule import — two lines)
  src/kernel/ops/interfaces.ts                      T3 create (register · heartbeat · sweepInterfaceHeartbeats)
  src/kernel/ops/interfaces.test.ts                 T3 create (V9-V11)
  src/kernel/config.ts                              T3 (WORKER_INTERFACE_SWEEP_INTERVAL_MS, defaulted)
  src/kernel/worker/jobs.ts                         T3 (tenth registration + Pick key)
  src/kernel/worker/jobs.test.ts                    T3 (literal + V12)
  src/kernel/retention/sweep.test.ts                T3 (JobIntervals literals gain the key — type-driven, no semantic change)
  test/alerts-parity.test.ts                        T3 (count pin 9→10)
  src/kernel/ops/downtime-kit.ts                    T4 create (generateDowntimeKit · verifyKitSerial · print payload)
  src/kernel/ops/downtime-kit.test.ts               T4 create (V13-V15)
  test/ops-lifecycle.e2e.test.ts                    T4 create (the whole surface over HTTP)
apps/web/src/
  router.tsx                                        T5 (ModeBanner in Shell + two routes + two nav links)
  components/mode-banner.tsx                        T5 create (poll GET /ops/mode; render when ≠ normal)
  components/mode-banner.test.tsx                   T5 create
  screens/ops-mode.tsx                              T5 create (mode + gate state + change-with-note)
  screens/ops-mode.test.tsx                         T5 create
  screens/ops-downtime-kit.tsx                      T5 create (generate · list · .print-doc print)
  screens/ops-downtime-kit.test.tsx                 T5 create
  lib/ops-api.ts                                    T5 create
  locales/en.json · locales/hi.json                 T5 (all new keys, both files — parity test)
docker/prod/
  prometheus/alerts.yml                             T3 (tenth job: interval leg + absent() term)
  docker-compose.prod.yml                           T6 (ninth service: alertmanager)
  prometheus/prometheus.yml                         T6 (alerting: block + alerts-backup.yml in rule_files)
  prometheus/alerts-backup.yml                      T6 create (D11's two rules)
  postgres-exporter/queries.yml                     T6 (drill-age query)
  alertmanager/alertmanager.yml.tpl                 T6 create (placeholders only)
  deploy.sh                                         T6 (step 2: template derivation + installs; restart loop gains alertmanager)
  .env.prod.example                                 T6 (.env.smtp shape documented)
README.md                                           T6 (operating modes · downtime protocol + kit · alert path · escrow addendum: SMTP joins the list)
```

Everything not listed is frozen to this plan (GC13).

## Tasks

### Task 1: Migration 0017 and the operating-mode service *(CRITICAL, opus coder + opus gate)*

D1+D2+D3(guard half)+D4: the five schema files' tables in `schema/ops.ts` (every ordering
column a `bigserial seq`; `downtime_kit_ranges` FKs `downtime_kits`), migration `0017`
generated ONCE (rollback for the additive tables: `drop table` in reverse FK order — stated here
before the generator runs, GC3), the three `truncateAll` statements, `kernel/ops/mode.ts`
(`getOperatingMode(db)` — zero rows = `commissioning`; `changeOperatingMode(tx, actor, {to,
note})` — the D2 matrix, D3's freshness guard reading the PERSISTED latest report row by `seq`,
refusal codes `mode_commissioning_is_initial_only | golive_gate_unsatisfied | mode_note_required
| mode_unchanged`, append + `ops.mode_changed`), `ops.mode_changed` in a NEW
`kernel/ops/events.ts` (payload `{from, to, note: nullable, reportId: nullable}`), the
`alertsManifest` subscription + consumer branch (D4 — recipients `usersHoldingRole(tx,
OWNER_ROLE)`, only for transitions touching `downtime|degraded`, `raiseAlerts` reused verbatim),
and the `:317` subscription-pair edit in `worker-runtime.e2e.test.ts`. T1 writes NO HTTP route
(T2's), so V2's fixtures insert report rows directly. Mutants V1-V6.

**Consumes:** shipped alerts fabric, schema barrel, truncate helper. **Produces:** the tables
every later task reads; `getOperatingMode` (12a's fix-27 seam, named); the mode-change events
T5's banner ultimately reflects.

### Task 2: `validate:config` — the D-17 aggregate, and the ops HTTP surface *(CRITICAL, opus coder + opus gate)*

D5: `kernel/ops/validate.ts` (`runConfigValidation(db, now)` — tariff + billing validators,
per-scope results, `ok` conjunction with tariff's `caSigned` folded in, report row persisted,
`ops.config_validated` appended), `scripts/validate-config.ts` + the `package.json` script line,
`opsManifest` + `OpsModule` + `ops.controller.ts` (routes: `GET /ops/mode` authenticated-only —
every screen's banner reads it, minting a read permission would repeat the trap
`alerts/manifest.ts:9-12` names · `POST /ops/mode` `@RequirePermission("ops.mode.set",
"hospital")` · `POST /ops/config-validation` same permission, runs the aggregate ·
`GET /ops/config-validation/latest` authenticated), `registry.install(opsManifest)` +
`OpsModule` in `app.module.ts`. The 403 sweep asserts the SPECIFIC permission admits and its
absence refuses (§3.42 — not merely that a role-less user fails). Flag ① discharges the script
both ways. Mutants V7-V8.

**Consumes:** T1's tables + guard; tariff/billing validators (read-only). **Produces:** the
report rows T1's guard requires; the HTTP surface T5 renders; flag ⑦'s subject.

### Task 3: Interface heartbeats — the tenth job *(CRITICAL, opus coder + opus gate)*

D6 in full: `kernel/ops/interfaces.ts` (`registerInterface`, `recordHeartbeat` — `down→up`
appends `interface.restored`, `unknown→up` silent; `sweepInterfaceHeartbeats(db, now)` — downs
stale `active` `up` rows per their own `stale_after_ms`, appends `interface.down`),
the two event definitions ADDED to `kernel/ops/events.ts`, the config key + `AppConfig` field,
the tenth registration in `jobs.ts` (Pick widens), **the complete census dance enumerated in D6**
— three literals, two censuses, the alerts-parity pin 9→10, and `alerts.yml`'s interval leg +
`absent()` term — and the controller's interface routes (`POST /ops/interfaces` +
`POST /ops/interfaces/:id/deactivate` `@RequirePermission("ops.interface.manage", "hospital")`;
`GET /ops/interfaces` and `POST /ops/interfaces/:id/heartbeat` authenticated-only — a heartbeat
is a liveness write from a device identity, and 12a's agent grants are its future tightening,
noted in the route comment). Mutants V9-V12; flag ② (boot line names ten, parity green at 10).

**Consumes:** T1's `interfaces` table + events file; T2's controller. **Produces:** the seam 11b
registers real printers on; the sweep the census now counts.

### Task 4: The downtime kit *(CRITICAL, opus coder + opus gate)*

D7+D9: `kernel/ops/downtime-kit.ts` (`generateDowntimeKit(tx, actor, {desks: [{desk, counts}],
note?})` — counters locked in `form_kind` order, single-winner `UPDATE … RETURNING`, ranges
inserted per desk×kind, `downtime.kit_generated` appended (definition ADDED to events.ts);
`getKitPrintPayload(db, secretKey, kitId)` — per-serial `dtk1.` payloads signed via `hmacSign`;
`verifyKitSerial(key, qr)`), kit routes (`POST /ops/downtime-kits` + `GET /ops/downtime-kits`,
`GET /ops/downtime-kits/:id` — all `@RequirePermission("ops.downtime.generate", "hospital")`),
and `test/ops-lifecycle.e2e.test.ts` — the whole plan over HTTP with `now` injected, no sleeps:
commissioning boot → exit refused (`golive_gate_unsatisfied`) → seed minimal valid
tariff/billing config (fixture shapes from the validators' own suites) → `POST
/ops/config-validation` ok → commissioning→normal → downtime declared with note → owner-role
alert row exists → kit generated, ranges disjoint and QR verifiable → interface registered,
heartbeat, staled under the sweep (`interface.down`), heartbeat again (`interface.restored`) →
recover to normal. Mutants V13-V15 (V13 is the measured race, GC7).

**Consumes:** T1-T3's whole surface; `kernel/crypto.ts`. **Produces:** the payload T5 prints;
the e2e that certifies the backend before the web wave.

### Task 5: The web surfaces *(ROUTINE, sonnet coder + mechanical check)*

D8: `mode-banner.tsx` (polls `GET /ops/mode` 15 s — the AlertsBell cadence; renders nothing on
`normal`, a full-width tinted banner otherwise, mode word + note, i18n) mounted in `Shell`
beside the bell; `ops-mode.tsx` (current mode + since + gate state from
`/ops/config-validation/latest`, change-with-note form — refusal codes rendered, keyboard-first
form kit); `ops-downtime-kit.tsx` (generate form — desks + counts; list; print view rendering
the payload's serials + QR values under `.print-doc`, REPLACING the screen per the
invoice-print convention); `lib/ops-api.ts`; two routes + two nav links; every new key in BOTH
locale files. Tests are behavioral where the surface decides something (banner absent on
`normal`, refusal rendering, print exclusivity) and labelled presence-only where they are
(the pipeline-C precedent). No mutants, no fail-first — say so in the report.

**Consumes:** T2-T4's routes. **Produces:** the surfaces the owner actually operates.

### Task 6: Alertmanager, the drill watcher, and the runbook *(CRITICAL, opus coder + opus gate — infra drills)*

D10+D11: the compose service (ninth; loopback 9093; limits), `prometheus.yml`'s `alerting:`
block + second `rule_files` entry, `alertmanager.yml.tpl` (placeholders; critical→immediate
email, warning→grouped; `smtp_auth_password_file`), `deploy.sh` step 2 — the `.env.smtp`
derivation (die-with-shape when missing, the `.env.r2` precedent verbatim), the template
render, the password file, alertmanager joining the §2.77 restart loop; `alerts-backup.yml`
(D11's two rules) + the drill-age query in `queries.yml`, **proven with `promtool test rules`
executed in-task** (flag ⑥); `.env.prod.example` documents the six keys; README gains the
operating-modes runbook (declare/recover procedure, who may, what the owner receives), the
downtime protocol + kit procedure (generate → print → seal → recover → reconcile against
serials), the alert path (what reaches the inbox and what to do at 03:00), and the **escrow
addendum: the SMTP credential joins `SECRET_KEY` and the cipher passphrase in the ceremony**.

**AUTHORIZED IN AS MANY WORDS (rule 7 / §2.71):** T6 runs `deploy.sh` on the box as its final
step. That deploy rebuilds the server image from the checkout at T6's HEAD — so api and worker
are RECREATED onto this plan's code, the alertmanager service is created, and prometheus,
grafana and alertmanager are restarted by the script. `hmis-db-1`, `hmis_hmis_pgdata` and the
`hmis-prod` db service are not touched (the db image is unchanged by this plan). Acceptance:
step 6b reports **9/9 declared services running**; flag ④'s transcript; then flag ⑤'s synthetic
alert drill — fired via `amtool` (or the v2 API on loopback), the SMTP notify observed to
succeed in alertmanager's own log, and **the owner confirming inbox receipt** (recorded in the
gate report; if the ack cannot be obtained during the run, the flag is UNDISCHARGED and says
so — never quietly dropped, §2.59's rule).

**Consumes:** the shipped prod stack; T3's alerts.yml only via parity (no edit here).
**Produces:** the alert path; the watched drill; the operator document for all of it.

## Commit messages — one per task, exact (AGENT-RULES §5 step 1 resolves here)

| task | subject |
|---|---|
| R0-1 | `fix(core): strip X-Powered-By — the one-line close the T3 gate offered and T6 left open` |
| R0-2 | `test(core): the L14 census advances to each daily instant — the 16% flake fixed by shape, measured by the spike` |
| T1 | `feat(core): migration 0017 and the operating-mode service — commissioning until proven, downtime declared loudly` |
| T2 | `feat(core): validate:config — one D-17 gate over every validator, and the commissioning exit reads it` |
| T3 | `feat(core): interface heartbeats — the staleness sweep as the tenth job, down and restored evented` |
| T4 | `feat(core): the downtime kit — serial ranges under a single-winner counter, a signed QR on every form` |
| T5 | `feat(web): the mode banner, the mode desk, and the printable downtime kit` |
| T6 | `feat(infra): Alertmanager to the owner's inbox — critical reaches a human, and the restore drill is watched` |

## Assertion Book — predictions until executed; the verdict column is filled by the shipping task

Rows marked **P** carry inputs the task must confirm by building the mutant and watching it die
(rule 21). R2 and the drills are measurements, not mutants.

| # | task | assertion | killing mutant | discriminating input | P? |
|---|---|---|---|---|---|
| R1 | R0-1 | No response carries `X-Powered-By` | revert the disable | `GET /health` → shipped: header absent (assert the header NAME, §2.6); mutant: `X-Powered-By: Express` | |
| R2 | R0-2 | **Measurement — DISCHARGED BY THE SPIKE: 30/30 green isolated**, full suite green beside it, typecheck+lint 0. Runtime **PARITY** (median 2735 ms vs shipped 2717 ms), not the reduction the brief predicted; daily ticks −3 000→≈1 090 (−63.7 %), so §7.9's “do not multiply the reads” holds. R0-2 still owes a 10× in-run isolated re-verify, quoted. **CAVEAT (spike §A.7): under `taskset -c 0` the SHIPPED shape is also 10/10 green here — this host discriminates nothing; CI is the confirmation.** | (none — a flake fix has no mutant; the evidence is the observed rate, quoted) | | |
| V1 | T1 | Zero rows reads `commissioning` | default `"normal"` | empty table → `getOperatingMode` → shipped: `commissioning`; mutant: `normal` | |
| V2 | T1 | Commissioning exit requires a fresh ok report | delete the guard | three fixtures: no report / ok report 25 h old / latest ok=false → all refused `golive_gate_unsatisfied` with the right detail; fresh ok=true → allowed (the control) | |
| V3 | T1 | `commissioning` is initial-only | drop the rule | from `normal`, `to: "commissioning"` → shipped: `mode_commissioning_is_initial_only`; mutant: succeeds | |
| V4 | T1 | Note mandatory entering `downtime`/`degraded` | drop the check | `to: "downtime", note: undefined` → refused `mode_note_required`; `to: "ramp"` without note → allowed (control) | |
| V5 | T1 | Current mode ordered by `seq`, never id/time | order by `id` | two rows inserted with EXPLICIT ids where id-order inverts seq-order → shipped: the later `seq` wins; mutant: the larger ULID wins | **P** |
| V6 | T1 | Downtime entry alerts every owner-role holder, idempotent on redelivery | drop the consumer branch | `ops.mode_changed` to=`downtime` delivered TWICE, two owner-role users → shipped: exactly one alert row each, one `alert.raised` each; mutant: zero rows. Control: `ramp→normal` raises nothing | |
| V7 | T2 | Aggregate `ok=false` when ANY scope fails, and the report row records which | ignore the tariff report (hardcode its leg ok) | billing config valid + tariff `caSigned=false` → shipped: `ok=false`, tariff scope red in the persisted row, exit 1; mutant: `ok=true` | |
| V8 | T2 | The guard reads the PERSISTED LATEST report | guard consults an in-memory value / any ok row | an older ok=true row THEN a newer ok=false row → exit refused; mutant: allowed | **P** |
| V9 | T3 | Sweep downs only stale `up` rows, evented | drop the staleness predicate | one fresh `up` + one stale `up` (per-row `stale_after_ms`) → shipped: only the stale one flips + one `interface.down`; mutant: both | |
| V10 | T3 | Never-seen (`unknown`) is never downed | include `unknown` in the sweep | registered, no heartbeat ever, hours past stale → shipped: still `unknown`, zero events; mutant: downed | |
| V11 | T3 | Heartbeat restores a `down` interface with `interface.restored` | drop the flip | force `down` via sweep, then heartbeat → shipped: `up` + one restored event; mutant: `last_seen_at` moves, status stays `down` | |
| V12 | T3 | The cadence key reaches the registration (GC10) | hardcode 60 000 in the registration | `registerAllJobs` with `workerInterfaceSweepIntervalMs: <distinct>` under fake timers → invocation at the distinct cadence; mutant: fires on the default grid | **P** |
| V13 | T4 | Concurrent generations yield DISJOINT ranges | drop the counter row lock | ≥15 measured concurrent runs (floor, §3.22), N parallel `generateDowntimeKit` → shipped: all ranges pairwise disjoint every run; mutant: an overlap observed and quoted | **P** |
| V14 | T4 | Sequential kits are contiguous; counters advance by exactly the count | off-by-one the advance | kit A (10 forms) then kit B → B starts at A.end+1, no gap, no overlap; mutant: gap or overlap at the boundary | |
| V15 | T4 | A tampered QR fails verification; a straight one parses | verify ignores the signature | flip one serial digit in a signed payload → shipped: `null`; mutant: parses. Control: untampered verifies to the triple | |

**Required-DIED mutant count: 16** — R1 (Phase 0) · V1-V6 (T1) · V7-V8 (T2) · V9-V12 (T3) ·
V13-V15 (T4). R2 is a measurement, not a mutant; V13 additionally carries a measured race.
Drills, counted per the 11a lesson: **3** —
the T6 deploy (9/9 services), the alert-to-inbox drill, the `promtool` rules run. These numbers
are the §2.68 inputs to the budget below; if compile grows the Book, the target moves with it,
in the execute prompt, before the run.

## Verify-by-execution flags (each names its owning task)

- **①** (T2) `pnpm validate:config` proven BOTH ways: an all-green run (exit 0, per-scope lines
  quoted) and a forced-failure run (exit 1) — §2.6's negative control.
- **②** (T3) The worker boot line names TEN jobs; `alerts-parity` green at count 10; the
  scheduler census green with the tenth registered.
- **③** (T4) The e2e's kit payload rendered by T5's print screen — serials and QR values visible
  under `.print-doc`; real paper is owner UAT, said plainly.
- **④** (T6) `deploy.sh` re-run on the box: step 6b reports **9/9** declared services running,
  alertmanager among them; transcript in the gate report.
- **⑤** (T6) A synthetic `severity: critical` alert accepted by Alertmanager, the SMTP notify
  observed to SUCCEED in its log, and the owner's inbox receipt recorded — or the flag is
  UNDISCHARGED and says so.
- **⑥** (T6) `promtool test rules` over `alerts-backup.yml` executed with both rules firing on
  their synthetic inputs and NOT firing on healthy inputs (the negative control), output quoted.
- **⑦** (T2) The mode-change route enforces the SPECIFIC permission: an actor granted
  `ops.mode.set` succeeds; the same actor without it (not merely role-less) gets 403 (§3.42).

## Pipeline Notes (for the compile session — ~~do not compile before D12 is resolved in this document~~ **D12 RESOLVED 2026-08-23; compile is unblocked**)

- **Spike FIRST** (the brief beside this plan), **then Phase 0** (two commits, CI checked per
  commit by full SHA, one push each — §2.62), then compile.
- **One pipeline, six waves, STRICTLY SEQUENTIAL** — W1[T1] → … → W6[T6]. T1→T4 share
  `kernel/ops/`; T3 owns the census dance; T6 mutates the box.
- **Models:** T1-T4, T6 opus coder + per-task opus gate (CRITICAL); T5 sonnet + mechanical
  check. Phase 0: one opus agent (R0-1 + R0-2, the latter against the spike's measured shape).
  One discovery reviewer for the pipeline. **Do not cut the mechanical check** (gate report
  §7.8).
- Briefs POINT at AGENT-RULES.md and this plan — never paste (§2.40's scar); restricted tool
  set; baseline re-measured at compile, detached, exit value from a file.
- **The EXECUTE-METHOD §3 sweep runs before any brief**, and additionally, from this plan's own
  authoring: re-run the `JobIntervals`-literal grep AFTER Phase 0 (§2.73 — expected: still 3
  literals, but state the count with its SHA) · confirm `worker-runtime.e2e.test.ts:317`'s pair
  pin is edited by T1 and only T1 before T3 touches the same file · confirm the e2e's minimal
  valid tariff/billing config fixtures against the validators' own test fixtures · confirm
  `alerts-parity`'s parsers really do reject a second rule file's shapes (the D11 rationale) —
  if they tolerate it, D11 still stands (separation is cheaper than entanglement), note it.
- **Sequential owners of shared files, enumerated:** `kernel/ops/events.ts` T1→T2→T3→T4 (each
  ADDS named definitions) · `ops.controller.ts` T2→T3→T4 (each ADDS named routes) ·
  `worker-runtime.e2e.test.ts` T1 (:317) → T3 (census) · `scheduler.test.ts` R0-2 → T3. Briefs
  carry the forward notes; NO brief says "change nothing else" (§2.72 — enumerate additions).
- **Budget, from the Book per §2.68 with the 11a drills correction:** 16 required-DIED mutants
  (1 Phase 0 · 6 T1 · 2 T2 · 4 T3 · 3 T4) + one measured race + 3 drills
  + 5 opus gates + mechanical checks + discovery ≈ 15-16 agents. Plan 10 ran 13 agents/20
  mutants at 2.64M; 11a ran 16 agents drill-heavy at 3.34M. This plan is mutant-shaped like 10
  and lighter on drills than 11a (no restore, no recreate). **Target: ≤ 3.0M subagent tokens**,
  arithmetic not analogy; the spike is budgeted separately in its brief (~80k target, honest
  range to 200k given 11a's 4× spike).
- CI watched by `ci-watch.sh` for the whole run (R0-3's fixed watcher); **the L14 flake should
  be GONE after Phase 0 — a red on that census after R0-2 is a REGRESSION SIGNAL, not a flake to
  re-run past** (the §2.76 control discipline applies in reverse).
- The repo is public: nothing in any commit may carry an owner email, hostname beyond what is
  already public, or credential shape beyond placeholders (GC2).

## Execute-prerequisites (owner actions; the pipeline halts where noted)

1. **`/opt/hmis-prod/.env.smtp` exists (chmod 600) with the six keys before W6** — SMTP host,
   port, user, an app password, from-address, to-address. **T6 HALTS without it** (its deploy
   dies in step 2 by design). The credential joins the escrow ceremony.
2. **The escrow ceremony itself** — `SECRET_KEY` + the pgBackRest repo cipher passphrase (+ now
   SMTP). **Independent of this plan and MORE urgent than it**: until it happens, every backup
   in R2 is one disk failure away from permanent ciphertext. Blocks nothing in the pipeline;
   screamed at here because the gate report's §9 already said it and it is still open.
3. ~~**The spike has run and D12 is resolved in this document** (blocks Phase 0's R0-2 and
   therefore compile).~~ **DISCHARGED 2026-08-23** — spike run (172k tokens, inside its budget),
   report committed at [`reports/plan-11c-spike-report.md`](reports/plan-11c-spike-report.md),
   D12 amended in place above. Phase 0 is unblocked.
4. Nothing else: no DNS, no R2, no new hostname. ~~Port-587 egress is the spike's question B — if
   it is blocked, T6's SMTP port and the `.env.smtp` shape change to what the spike measured
   (585/465 or a relay), before compile, in this document.~~ **DISCHARGED 2026-08-23: 587 is OPEN
   and STARTTLS establishes, so T6 ships as written and NO relay decision is owed by the owner.
   465 is blocked outbound and is not a fallback (D10).**

## Decisions for the owner (with what stalls without each)

1. **None new — this plan's three were ruled in the brainstorm** (11c next · SMTP sink ·
   print-HTML now). Restated from 11a, all still open, none blocking this pipeline:
   Grafana-behind-Caddy (convenience) · the repo-private timing (decide before the stage-2
   pilot) · staff/owner phone numbers for `users.phone` (stalls staff external messages only).
2. **The lead-time clocks this plan does NOT absorb, started this week by the owner:** counsel
   bundle (retention values + the two §7.2 sweep-comment questions + DPDP pre-pilot posture +
   E-21 register legality) · DPIA author + inference locus (blocks 12a activation) · WhatsApp
   BSP onboarding + template approval (blocks go-live's confirmations; weeks) · E-11
   transition-operations boundary map (pre-pilot) · E-1 (blocks only the relay) · internal
   auditor (E-17) · **the R2-endpoint masking reminder, delivered again**.

## Self-review — what this plan's own passes caught before commit

1. **Every consumed surface re-verified against the tree at `8ec862f`**, not inherited from the
   brainstorm: the nine-job census and its THREE literals (not two — `retention/sweep.test.ts`
   holds the third) · `worker-runtime.e2e.test.ts:317`'s WHOLE-pair subscription pin, which
   put that file in T1's Files list (the draft had it only in T3's — a §2.47 collision caught
   by reading the file, not the plan) · `alerts-parity`'s `toHaveLength(9)` pin and throwing
   parsers, which produced D11's second-rule-file decision · tariff's `config.validated` scope
   being `z.literal("tariff")`, which killed the draft's "reuse the event with scope 'all'"
   shape and produced `ops.config_validated` · `validateBillingConfig` emitting NO event
   (billing's closed catalog — the aggregate must not append one for it) · `deploy.sh`'s
   step 6b already covering a ninth service with no edit, and its restart loop being the §2.77
   home for alertmanager · the `admin`-only seeded-role fact, which moved duty-manager/owner
   grants to runbook data rather than a seed edit.
2. **The un-planned-gaps premise in the owner's own prompt checked and REFUTED before planning
   on it:** dues/advances/refund guards shipped in Plan 08 (rulings R1-R3, pipeline-C notes T14
   `b81e127`). The roadmap's Plan 07/08 STATUS lines are stale — the gate-report commit of this
   plan's run should fix both and add 11c's entry (noted for the execute session; a plan must
   not silently edit the roadmap it was born from).
3. **§2.72 applied to this plan's own multi-owner files:** `kernel/ops/events.ts` and
   `ops.controller.ts` have four and three sequential owners; every brief ENUMERATES its
   additions; no brief may carry "change nothing else".
4. **What is deliberately a prediction, flagged as such** — *and the first two are now MEASURED,
   2026-08-23:* ~~D12's census shape (spike question A, Book R2 is a measurement row) · port-587
   egress (spike question B)~~ **both discharged by the spike; see D12, D10 and Book R2** · V5, V8, V12, V13 carry
   **P** because their discriminating inputs are exactly the class §2.57/§3.24 has been wrong
   about — orderings, persisted-vs-memory reads, take-effect wiring, race windows.
5. **Authoring defects caught in this session's own passes:** the draft's `/health`-carries-mode
   idea dropped (it would put an authenticated concern on the unauthenticated machine surface —
   the banner polls `/ops/mode` instead) · the draft had the aggregate emitting per-scope
   `config.validated` events (refuted by the scope literal, above) · the draft's kit serials
   initially rode billing's `document_series` (refuted by D7's reconciliation-key argument
   before a line was written) · the Book's draft count paragraph disagreed with its own rows
   (it said 14-then-15; the rows say 16: R1 + V1-V15, R2 a measurement) — corrected in this
   pass rather than shipped disagreeing (the 11a self-review §6 lesson, repeated verbatim).
6. **Scope cut, not padded:** D13's list, each with its trigger condition. The quarterly
   downtime drill, the E-24 unification and the mode-aware allocators are the three the next
   session will be most tempted to pull in; each has its stated reason to wait.

## Carried forward

- **Closes** the roadmap's 11c obligation (operating modes · downtime kit · D-17 wiring ·
  E-10) · gate report §7.6 (no alert sink) and §7.7 (`X-Powered-By`) · §7.9 (the L14 flake,
  by measured shape) · the "restore drill silently rotting" negative-space gap (D11, note 10's
  pattern).
- **Does not touch** 08.5's remaining booked items · Plan 10's §7.3 MINOR · retention semantics
  · E-1. The E-24/mode seam and the PDF renderer are booked in D13 with owners named.
- **Hands to Plan 12a:** `getOperatingMode` (fix 27's mode gate) · the heartbeat-table pattern
  for agent liveness (already 08.5's shape) · the alert path its Digest Writer delivery rides.
- **Hands to Plan 11b:** the interface registration seam (real printers/scanners) · the
  downtime kit as the floor-scoped degradation building block.
