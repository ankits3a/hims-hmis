# Plan 14 — Materials core: item & vendor masters, stores, and the stock ledger

**Written 2026-08-27 on the build host, the morning Plan 13 closed and deployed. NOT APPROVED FOR EXECUTION — this document is the whole of what that session produced; execution is a separate session with its own approval.** Three owner rulings were taken in the authoring session and are recorded where they bite: the SLICE (§1 — this is the first of three Plan-14 slices), the SCREENS (DD16), and four brainstorm rulings adopted as recommended (§4A, RULED).

**Roadmap:** [`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md) § *Stage-2 acceleration* (Track A: **14 → 15 → 16 → 17 → 18**, ruled 2026-08-25; re-sliced 2026-08-27 — see § 6.6's amendment, landed at write time). **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §11.10 (materials & supply chain — the store network, batch+expiry everywhere, UOM once, FEFO, two-sided scans, the recall freeze), §11.19-C fix 3 (regulated-price layer: batch-MRP at GRN), §11.19-D fix 1 (vendor master under change control, cooling-off) and fix 7 (ownership dimension on stock locations, the §31(7) clock), §11.16-A (the mini-OT's consignment and store contributions), §4 (module framework). **Brainstorm:** `/opt/hmis-context/brainstorm-2026-08-27/09-procurement-stores-vendors.md` (out of git) §1, §3, §4, §13, §14 — the raw material; nothing in it is ruled unless this document says so. **This plan argues from those and does not restate them.**

**Slot:** Plan 13 closed and deployed 2026-08-27 (`c4ac4e1`); production is at `0033`. Plan 15's own brainstorm gates itself on *"Plan 14's consignment interface signature frozen"* — DD13 is that signature. Nothing else in the house blocks this phase.

**Executor seed (v3 §1):** read this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — then execute, on the build host, task by task. **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: it is 362,381 bytes ≈ 90k tokens and it is re-billed on every tool call (v3 §9.1).** The entries that bear on this phase are cited by number where they bite: §2.54, §2.93, §2.102, §2.115, §3.12/§3.35.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT, and the sentence is honest about the edge it sits on.** Nine tasks — the same count as 16a and 11h, both LIGHT — and it IS a module build, which v3 §2 names as the HEAVY shape. Two things keep it LIGHT. First, the owner's slice ruling (§1): this document is deliberately the masters-and-ledger third of the brainstorm's Plan 14, with procure-to-pay (14b) and consignment reconciliation / counts / capex / payments (14c) as their own documents, so no task here carries a workflow definition, an approval band, a Tally export or a register. Second, the method's own data: every LIGHT phase since 11e has been correct at close because of ONE independent reviewer, and the one HEAVY phase in the same window (09) cost 13× a comparable LIGHT phase's subagent spend for a comparable task count (`token-baselines.json`). **What makes it not a small phase is the ledger: money-adjacent quantities under concurrent writers.** That does not change the lane — v3 §2 is explicit that the lane sets dispatch and not verification depth — it changes the tiering: **five of the nine tasks are CRITICAL** and carry executed mutants.

**The main session codes task by task** under AGENT-RULES in full, builds every mutant the inline Assertion Books name, watches CI with [`../pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh) by full SHA, and closes with one independent reviewer — **spawned FRESH for scope, RESUMED only for memory** (v3 §9.5, ledger §2.115: Plan 13's third invocation cost 28% more than its first and did 5% of the work).

### Stop-loss (v3 §6): **675,000 tokens**, and the arithmetic is shown because §2.95 exists

`stop-loss = 1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`

- **Per-task rate — 20,178**, from Plan 16a (LIGHT, 9 tasks, 181,605 subagent tokens; [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). It is the closest phase in shape: a new table family, its masters, a screen, and one reviewer. **The known bias, inherited from Plan 13's own note: for a LIGHT phase `subagentTokens` IS the reviewer, so this "per-task rate" is a review cost wearing an execution cost's clothes.** The honest input — main-session cost — is unmeasurable from inside a session (runbook **O3**).
- **Task term:** `1.5 × (20,178 × 9) = 272,403`.
- **Review term — TWO passes: `175,209 + 227,772 = 402,981`.** One fresh pass at Plan 13's measured pass-1 rate, plus one **resumed** pass priced at **1.3×** it, per the §9.5 amendment Plan 13 bought. Two passes rather than the default one because the ledger is a money-adjacent path with locking, and 09a and 13 both found their most valuable defect in the REMEDIATION of their first pass.
- **Total: 675,384 → 675,000.**

**The lever the executor holds, named so it is used:** if the second review question is *"confirm these N properties of this diff"* rather than *"is the fix for the defect YOU found correct?"*, spawn fresh — Plan 13 measured that at 4–7× cheaper with nothing verified less. The review term above prices the expensive case so the stop-loss does not fire on the correct one.

### Context budget (v3 §9.2), measured before compiling

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | **78,878** at write time; re-measure at kickoff (`wc -c`) | **19,720** |
| `AGENT-RULES.md` | 24,550 | 6,138 |
| ledger §5 only (lines 1081–1095) | 3,455 | 864 |
| **NOT pointed at:** the ledger in full | 362,381 | **90,595 — the number §9.1's cite-by-number rule exists to avoid** |

**Per-agent context budget: ≈ 26,700 tokens carried.** Plan 09's briefs carried 374,461 into every one of 2,327 tool calls (ledger §2.97).

**Parallel-work fence.** `git status` was CLEAN at write time (`main`, `751c0b5`) and `ps -eo pid,cmd | grep -iE 'jest|vitest'` matched nothing. Several idle `claude` sessions were resident on the host, one of them Plan 13's authoring session; none was running a suite. If a jest/vitest process appears during execution it is a second lane: read [`reports/2026-08-26-parallel-session-protocol.md`](reports/2026-08-26-parallel-session-protocol.md) before trusting any test evidence (AGENT-RULES rule 20 — **read the matched command lines, never the count**).

---

## 1. Why this phase

**Nothing in the hospital has stock.** OPD prescribes against a formulary (16a) and bills against a tariff (06/08), but no table records that a box of anything exists, where it is, which batch it belongs to, when it expires, what MRP is printed on it, or who owns it. The mini-OT (Plan 15) cannot be authored without that: §11.16-A's own resource line reads *theatre ×1 · recovery-bay beds ×2 · autoclave · instrument sets · consignment store location*, and its case flow's central money event — implant scan-on-use as `consignment.deployed`: *charge + patient sticker + vendor liability in one event* — needs a consignment lot to deploy FROM and a ledger to write TO. Pharmacy (16c) and the lab (17) need the same ledger; the brainstorm's scope table gives every one of them the same relationship to it: *pharmacy calls `stores.issue()`*. Built per module that is §2.54's mechanism applied to the most-copied table in any hospital system.

**Why this slice and not the brainstorm's whole Plan 14 — the owner's ruling, 2026-08-27, with the planner's reasoning recorded so the two later slices inherit it.** Doc 09 §14 sketches thirteen sections, ~30 tables, fourteen workflow definitions and nine statutory registers under one number. That is three or four phases of the size this method has actuals for, and most of its second half is gated on things that do not exist yet: the CA session (ITC posture R-098, 40A(3) R-097, MSME R-099 — all "pre-pilot"), the 12a agent runtime for the Replenishment and Invoice Matcher harness, and a second approving actor (runbook **O1**) before any two-key rule is anything but theatre. **So Plan 14 is the third that has no external gate: masters, stores, the ledger, receiving against a challan, two-sided issue, FEFO, recall, expiry, and the consignment consumer.** Plan 14b (indent → PO → GRN-against-PO → invoice → Tally) waits for the CA; Plan 14c (consignment reconciliation and auto-PO, counts, capex → `device`, payment runs) waits for O1 where it needs two keys. Each slice is independently deployable and each is LIGHT.

**And it lands the interface Plan 15 is waiting on.** DD13 freezes `consignment.deployed`'s payload and the `material.consumed` fact it produces; T7 ships the consumer; Plan 15 imports the schema and appends the event. That is the roadmap's *"15 consumes 14's consignment interface"* built as the thing it is: one zod object in one file, owned by the module that consumes it.

---

## 2. Ground truth — measured on this host, 2026-08-27, and **re-measure it at kickoff** (AGENT-RULES §6)

Every line below was run in this checkout or read-only against production at write time. Plan 13's launch prompt had three of its numbers wrong within a day; Plan 13's own kickoff re-measure found nothing moved and recorded it anyway. **Do both.**

- **Migration head `0033_worried_salo.sql`**, 34 `.sql` files. `git status` clean, branch `main`, HEAD `751c0b5`. **This phase generates ONE: `0034` — additive, no data migration, one deploy** (DD17). Read the head yourself (`ls apps/core/drizzle/*.sql | tail -1` **and** `git status`) before writing a number into a commit.
- **No materials table exists anywhere.** `grep -rli "vendor" apps/core/src --include=*.ts` (excluding tests) returns **zero files**; `pgTable("items"`, `stock_ledger`, `grns` are zero hits across `apps` and `packages`.
- **`ALL_MANIFESTS` holds THIRTEEN**, pinned by key and in order at `kernel/modules/manifests.test.ts:9`, cross-pinned to `app.module.ts` (leg V4, line 36) and to the worker (leg 3, line 46: *"differs from ALL_MANIFESTS in exactly four enumerated, intentional ways"* — `ops`, `membership`, `formulary`, `resources`). **This phase's manifest carries a subscription and a job, so it is installed in BOTH processes and leg 3 stays at four** (DD15).
- **The worker installs its manifests by hand, one `registry.install(...)` per line** (`kernel/worker/worker.module.ts:59-73`), **and does NOT call `collectResourceKinds`** — `app.module.ts:62-66` does, since Plan 13's close (M2). That is Plan 13's named carry-forward: a manifest declaring `resourceKinds` boots in the worker without the duplicate-kind refusal. **This phase's manifest is the first such manifest, so T2 closes it** (DD2).
- **`workerConsumers(db)` returns THREE handlers** — `kernel.alerts`, `kernel.notify`, `partners.accrual` (`worker.module.ts:132-138`). A declared subscription with no handler is a worker BOOT ERROR (`jobs.ts:56-62`), which is why `partnersManifest` shipped its subscriptions and its handler in one commit. T7 does the same.
- **Permission census: 78 declared = 64 held + 14 not-yet-modelled**, pinned at `test/seed-roles.test.ts:453`, `:527`, `:544`, `:802`, `:810`, and compared cell for cell, both directions, against two tables in `README.md` (lines 281 and 594 head them). Per-module declared counts are pinned at `:430-445` (`tariff: 5, opd: 14, billing: 14, alerts: 0, ops: 3, membership: 7, partners: 7, formulary: 3`, …). **Fourteen roles exist**: `front_office`, `front_office_supervisor`, `vitals_desk`, `doctor`, `opd_admin`, `pharmacy`, `cashier`, `billing_manager`, `owner`, `medical_superintendent`, `tariff_editor`, `membership_admin`, `mrd_officer`, `biomedical_engineer` (plus `admin`, `display`, `duty_manager` seeded elsewhere). **No materials role exists** (DD11).
- **SPA route census 25** (`test/caddyfile-parity.test.ts:304`), 25 `path:` entries in `apps/web/src/router.tsx`. **Deploy seed census 11, in order** (`test/deploy-parity.test.ts:398`); `apps/core/package.json` carries twelve `seed:*` scripts, `docker/prod/deploy.sh` runs eleven of them (`seed:admin` is deliberately out). **Approval types are registered by seed scripts** (`scripts/seed-tariff.ts:209` → `registerTariffApprovalTypes`), which is why a phase that adds an approval type moves the seed census (DD10).
- **Suites: apps/core 219 test files · apps/web 43 · packages/contracts 4.** Workspace total may not decrease (AGENT-RULES §4).
- **The formulary is the drug half of the item master and it is EMPTY in production**: `formulary_medicines` **0 rows**, `formulary_salts` 29. So `items.formulary_medicine_id` has nothing to point at on the live box, and every drug-class fixture in this phase must create its own medicine first (DD3, and Spike Q2).
- **`counterparties` (Plan 09) is NOT a vendor table**: 0 rows in production; `payee_class` CHECK closed to `('channel_partner','staff_internal','external_rmp')`, its whole apparatus is commission attribution and payout eligibility. A supplier of gloves is none of those things (DD4).
- **`regulated_prices` (tariff) carries MRP + DPCO ceiling keyed by SERVICE, not by item** (`schema/tariff.ts:75-95`: `serviceId`, `mrpPaise`, `ceilingPaise`, `effectiveFrom`, `gazetteRef`, ordered by `seq`), and `priceInvoiceLines` clamps a `regulated` service to `min(tariff, MRP, ceiling)`. **Production holds 0 regulated_prices rows and 6 services.** The item→service bridge does not exist and is not this phase's (DD8, § 4A).
- **Billing has NO event-driven charge path.** Invoices are issued from a draft at the counter (`issueInvoice`, `invoices.ts:638`); the daily close's `orphanScan` (`daily-close.ts:286`) is the §11.11 orphan REPORT, not a poster. So `consignment.deployed` cannot "post a charge" today — it can record the consumption, the liability, and the price facts the bill will need (DD13, § 4A).
- **`regulatedPrices`/`resources`/`counterparties` locking precedents**: `receipts.ts:637` locks by `order by id for update`, never row-then-set; `ops/mode.ts:166` uses `pg_advisory_xact_lock(hashtext(...))` for a single global row. The balance table takes the first shape (DD6).
- **`EPISODE_SERIES` (`kernel/episodes/series.ts:19`) is a per-document-type, per-day number series** (`formatEpisodeNo`, 4 digits, max 9,999/day). A GRN number joins it (T1) rather than growing a private counter.
- **Alerts route THREE event kinds** (`kernel/alerts/consumer.ts:20-24`: escalation, manual notify, operating mode) and the alerts manifest subscribes to `escalation.triggered` only. **`batch.expiring` will therefore NOT become an alert in this phase** — it is an event plus a worklist route (DD14), which is §10.3's "structure everywhere, alerts selective" and 11g's record-only-at-go-live posture.
- **Approvals need a USER requester** (`requests.ts:30-33`: *"only user actors may request approvals"*) and a money request needs `patientId` or `payeeId` for C-12 aggregation. A vendor bank change carries no amount and no patient; `payeeId` is the vendor id (DD10).
- **`truncateAll` (`test/helpers/db.ts:~150-175`) is one hand-maintained statement.** A table absent from it is never emptied (16a F2). Fifteen new tables join it in T1, in one statement, parent-before-child is irrelevant inside a single `truncate` but the names must ALL be there.

### Production, measured read-only against `hmis-prod-db-1` (user `hmis`, db `hmis`), 2026-08-27

| | |
|---|---|
| `drizzle.__drizzle_migrations` | **34 rows applied** = files `0000`…`0033` (read the COUNT beside `max(id)` — Plan 13 A3) |
| `resources` | **2 rows**, both `kind='room'`, `status='available'` — **no `store` exists anywhere** |
| `formulary_medicines` / `formulary_salts` | **0 / 29** |
| `counterparties` | 0 |
| `services` / `regulated_prices` | 6 / 0 |
| `approval_types` | 9 (`billing_*` ×5, `membership_grace_honor`, `patient_merge`, `patient_unmerge`, `tariff_revision`) |
| `workflow_definitions` | 10 active — nine Class-C approval flows + `opd_visit` (Class A) |
| `users` | 33 |
| `operating_mode_changes` | **0 rows — production has never left `commissioning`** |

### RE-MEASURED AT KICKOFF — 2026-08-27, execution session, on the build host

**Nothing moved.** Every line of §2 above was re-run in this checkout before T1 and the answer was
the same one the authoring session recorded. This block exists because AGENT-RULES §6 requires the
re-measure whether or not it finds anything, and because Plan 13's launch prompt was wrong about
three numbers within a day of being written — recording a null result is the only way the next
session can tell "measured, unchanged" from "not measured".

| line of §2 | expected at write time | measured at kickoff | verdict |
|---|---|---|---|
| migration head | `0033_worried_salo.sql`, 34 `.sql` files | `0033_worried_salo.sql`, **34** files | unchanged — this phase generates `0034` |
| uncommitted migration | none | `git status --porcelain` **empty**, branch `main`, HEAD `cc76aed` | unchanged |
| `ALL_MANIFESTS` | 13 | **13**, pinned `manifests.test.ts:105` (`toHaveLength(13)`) | unchanged → 14 at T2 |
| worker leg 3 | exactly four: `ops`, `membership`, `formulary`, `resources` | **exactly four**, `manifests.test.ts:180`; `workerKeys` pinned `toHaveLength(10)` and the shared array pinned at nine keys | unchanged |
| permission census | 78 declared = 64 held + 14 not-yet-modelled | **78 = 64 + 14**, pins at `seed-roles.test.ts:453`, `:527`, `:544`, `:802`, `:810` | unchanged |
| SPA routes | 25 | **25**, `caddyfile-parity.test.ts:304` | unchanged → 28 at T9 |
| deploy seeds | 11 | **11**, `deploy-parity.test.ts:398` | unchanged → 12 at T2 |
| `workerConsumers` | THREE handlers | **three** — `kernel.alerts`, `kernel.notify`, `partners.accrual` (`worker.module.ts:132-139`) | unchanged → four at T7 |
| `collectResourceKinds` in the worker | absent | **absent** — the only two hits are `app.module.ts:25` (import) and `:73` (call). Plan 13's carry-forward is still open and T2 closes it | unchanged |
| suites | core 219 · web 43 · contracts 4 | **219 · 43 · 4** | unchanged |
| `grep -rli vendor apps/core/src --include=*.ts` non-test | zero files | **zero files** | unchanged |
| `pgTable("items"/"vendors"/"stock_ledger"/"grns")` across `apps` + `packages` | zero | **zero** | unchanged |

**Parallel-work fence — READ, not counted (AGENT-RULES rule 20).** `ps -eo pid,cmd | grep -iE 'jest|vitest'`
matched four lines and **none of them is a test run**: PID 3009865 is an idle `claude` session whose
*prompt text* contains the words `jest` and `pgrep -af jest` (it is Plan 13's authoring session, still
resident); two lines are this probe's own `bash -c`, whose command line contains the pattern; one is the
`ugrep` the probe spawned. This is the self-match trap rule 20 names, hit four ways at once. **No jest or
vitest process is running; this session is the only lane.** `reports/2026-08-26-parallel-session-protocol.md`
is therefore not engaged.

---

## 3. Spike — questions written now, answered at kickoff by read-only SQL against production

Write the measured answers **in place here** before T1 starts (v3 §1.2). None of these needs an agent.

**Q1 — Where is production, and is the name space clear?** `select max(id), count(*) from drizzle.__drizzle_migrations;` and `select to_regclass('items'), to_regclass('vendors'), to_regclass('stock_ledger'), to_regclass('grns');`
*Consequence:* a count other than 34 re-bases `0034` before T1 generates anything; a non-NULL regclass means somebody claimed the name and T1 halts.
**ANSWERED AT KICKOFF 2026-08-27 — production is at 34, and the name space is clear.**
`select max(id), count(*) from drizzle.__drizzle_migrations;` → **`34|34`**. The COUNT beside
`max(id)` is read, not inferred (Plan 13 A3): thirty-four rows applied, `0000`…`0033`, and the two
numbers agreeing is itself the evidence that no row was inserted by hand. `select to_regclass(...)`
for `items`, `vendors`, `stock_ledger`, `grns`, `stock_batches`, `consignment_lots` → **six NULLs**.
**`0034` stands as this phase's number; no re-base, no halt.**


**Q2 — Is the formulary still empty?** `select count(*) from formulary_medicines; select count(*) from formulary_salts;`
*Consequence:* if still 0, the owner cannot register a single drug-class item on the live box after this phase deploys until a medicine exists — **say so in CLOSE as a named dependency on the owner's platinumrx mining track (16a spec D2), not as a defect.** Either way T3's fixtures build their own medicine and A3's leg where `formulary_medicine_id` is null-on-a-drug must exist.
**ANSWERED AT KICKOFF — still empty. `formulary_medicines` 0, `formulary_salts` 29.**
So the consequence fires: after this phase deploys, **no drug-class item can be registered on the
live box until a medicine exists**, because DD3's CHECK makes `formulary_medicine_id` mandatory for
`class = 'drug'`. Non-drug classes (`consumable`, `consumable_dated`, `implant`, `reagent`,
`stationery`, `linen`, `gas`, `asset`, `service`) are unaffected and are what the mini-OT's first
consignment challan actually needs. **Carried to CLOSE as a named dependency on the owner's
platinumrx mining track (16a spec D2) — not a defect of this phase.** T3's fixtures build their own
medicine, as planned.


**Q3 — Is `store` still unclaimed?** `select kind, count(*) from resources group by 1;` and, at build time, `grep -rn '"store"' apps/core/src --include=*.ts | grep -v test | grep kind`.
*Consequence:* a `store` row in production or a manifest already declaring the kind means Plan 16's session got there first and DD2 re-opens with the owner before T2. (Plan 13 said "Plan 16 adds `store`"; this document moves that to Plan 14 — DD2 says why.)
**ANSWERED AT KICKOFF — `store` is unclaimed, in both halves.**
`select kind, count(*) from resources group by 1;` → **`room|2`, and nothing else**: production holds
two resources and both are rooms (Plan 13's migrated OPD rooms). The build-time half:
`grep -rn '"store"' apps/core/src --include=*.ts | grep -v test | grep -i kind` → **no output**. No
manifest declares the kind. **DD2 does not re-open; T2 claims `store` as written.**


**Q4 — What is the hospital doing right now?** `select from_mode, to_mode, at, seq from operating_mode_changes order by seq desc limit 1;`
*Consequence:* this phase is additive and has no destructive step, so `live` does not halt it — but a `live` answer means the deploy is an operational act on a working hospital and the owner authorises it as one, in as many words (§3.6).
**ANSWERED AT KICKOFF — production has still NEVER left `commissioning`. `operating_mode_changes`
holds 0 rows**, so the `order by seq desc limit 1` returns nothing at all. The hospital is not
`live`. That does **not** relax the deploy gate: §3.6 requires owner authorisation naming the SHA,
the migration and the seed regardless, and `commissioning` is a real deployment with 33 users, 2
rooms and real patients behind it. It only means the deploy is not an operational act on a *working*
hospital, and CLOSE should say which of the two it was.


**Q5 — Does `services` carry anything an implant could be billed against?** `select id, code, category, regulated from services order by code;`
*Consequence:* informs § 4A item 3 (the item→service bridge). Zero `device`/`pharmacy`-category services confirms the bridge is a later phase's and that `material.consumed` must carry its own price facts (DD13).
**ANSWERED AT KICKOFF — six services, and NOT ONE of them is a `device` or `pharmacy` category.**

| id | code | category | regulated |
|---|---|---|---|
| `01M0TE3AQE931Y6X0XWTCNXK6C` | `OPD-CONSULT-NEW` | consultation | f |
| `01M0TE3AQMPMZMV06BP01HQAME` | `OPD-CONSULT-RENEWAL` | consultation | f |
| `01M0TFNSVZZT7AN2GBE5MG38Q8` | `SYN-OPD-GEN` | consultation | f |
| `01M0TFNSW21FMCVPXAR5V4TMWS` | `SYN-OPD-SPEC` | consultation | f |
| `01M0TFNSW4CZ5VR2PS47MA1BRZ` | `SYN-LAB-CBC` | investigation | f |
| `01M0TFNSW6NBWWBPKZZCFC2KEP` | `SYN-PROC-DRESS` | procedure | f |

Three categories (`consultation`, `investigation`, `procedure`), **`regulated = false` on all six**,
and `regulated_prices` holds **0 rows** — so the tariff's regulated-price clamp has nothing to clamp
today either. **There is nothing an implant could be billed against.** § 4A item 3 stands as
written: the bridge is a later phase's, and `material.consumed` must carry its own price facts
(`mrpPaise`, `mrpUom`, `ceilingPaise`) because no service row can supply them. DD13 confirmed.


**Q6 — Does the worker boot with a kind-declaring manifest installed?** Not SQL: after T2, `node dist/kernel/worker/main.js` (or the shipped worker entry) against a scratch database, once with the materials manifest and once with a scratch duplicate `store` declaration. *Consequence:* the second run must REFUSE. If it boots, T2's worker fix is incomplete and Plan 13's carry-forward is still open. Quote both boot lines in CLOSE.

**ANSWERED AT T2, 2026-08-27 — BOTH LEGS, ON THIS HOST, AGAINST A SCRATCH DATABASE.**
`hmis_spike_q6` was created on the dev container, migrated to **35 applied migrations** (`0000`…`0034`
— production's 34 plus this phase's), used, and **dropped in the same task** (AGENT-RULES rule 7's
one exception, discharged).

*Leg 1 — the SHIPPED worker entry (`apps/core/src/worker.ts`), materials manifest installed:*

```
[Nest] 3586618  - 08/27/2026, 4:04:22 PM     LOG [InstanceLoader] WorkerModule dependencies initialized +28ms
worker started: jobs=runDispatchCycle,runDueTimers,sweepExpiredTempRoles,sweepGuardianMajority,
sweepAppointmentNoShows,runDailyClose,runNotifyPump,createEventPartitions,retentionSweep,
sweepInterfaceHeartbeats
```

**It boots.** `collectResourceKinds(registry)` now runs inside the worker's `MODULE_REGISTRY`
factory and the kind-declaring manifest passes it.

*Leg 2 — the same `WorkerModule`, booted, with a SECOND manifest claiming `store` installed into the
registry it actually built* (a scratch file beside the source; nothing shipped was edited — rule 21's
shape). Exit value read from a file: **0**.

```
Q6b: WorkerModule booted; its registry holds 11 manifests
Q6b: kinds collected from the WORKER's registry = ["store"]
Q6b: REFUSED as required -> ResourceError: two manifests declare the resource kind "store" — one kind
     has one vocabulary, and a second declaration makes onRelease depend on which one a reader
     happened to find
```

**The second run REFUSES, so T2's worker fix is complete and Plan 13's carry-forward is CLOSED.**

Two details worth keeping. **The worker's registry collects `["store"]` and nothing else** — one
kind, not six — because the worker deliberately omits `resourcesManifest`, which is where the five
KERNEL kinds live. That is the precise reason the gap was invisible until now: *the only manifest
carrying `resourceKinds` before this phase was one the worker does not install*, so a collector call
in the worker would have had nothing to collect and nothing to refuse. `materialsManifest` is the
first kind-declaring manifest the worker holds, which is why DD2 could put the fix here rather than
leaving it for Plan 15's `theatre`. And **eleven manifests** is the worker's own census — ten before
this phase (`manifests.test.ts` leg 3) plus materials.

---

## 4. Design decisions — what this plan rules beyond the spec

**DD1 — One module, `materials`, at `apps/core/src/modules/materials/`, and its tables in `kernel/db/schema/materials.ts`.**
The brainstorm's own recommendation (doc 09 §4: *"one module `materials`"*), and the house shape (`modules/formulary/` — `manifest.ts`, `events.ts`, `errors.ts`, `index.ts`, `materials.module.ts`, `materials.controller.ts`, logic files with their tests beside them). It is a MODULE and not a kernel subsystem, unlike the registry: it owns journeys (receiving, issuing) and screens. Pharmacy, the mini-OT and the lab reach its tables only through `index.ts`'s exports — spec §4's rule, enforced the way `formulary` enforces it today.

**DD2 — The `store` kind is CLAIMED by the materials manifest, and T2 makes the worker collect kinds.**
Plan 13's seam is open for claiming a kind with no kernel edit, and `store` is among the ten. Declaration: `statuses: ["available","blocked","retired"]`, `initial: "available"`, **`occupied: null`** (a store is not assignable — its contents are the ledger's business, not the registry's), `onRelease: "available"`, `retired: "retired"`. Plan 13 wrote *"Plan 16 adds `store`"*; **this document moves the claim to Plan 14** because the ledger that keys on `store` resources lives here, and a kind claimed by a module that does not own the table keyed on it is two homes for one concept. Pharmacy (16c) declares no kind; it creates its stores through this module's `createStore`. **Every stock location is a registry resource of kind `store`** — central stores, sub-stores, the consignment bin, the quarantine bin, and one **`IN-TRANSIT`** store per site created lazily by `ensureTransitStore` (DD9). **Plan 13's carry-forward closes here:** `worker.module.ts` gains the same `collectResourceKinds(registry)` call `app.module.ts:62-66` carries, with the same discarded return value and the same comment, and Spike Q6 proves the refusal exists in the running worker.

**DD3 — An item is not a medicine. `items` REFERENCES `formulary_medicines`; a drug-class item MUST, a non-drug item MUST NOT.**
`items.formulary_medicine_id` is a nullable FK with a CHECK: `(class = 'drug') = (formulary_medicine_id IS NOT NULL)`. Composition, salts, strength, schedule flag stay in the formulary and are never copied (doc 09 §1's scope table, and 16a's whole reason for existing). **One item per medicine** — brand × strength × form is the formulary's grain and it is the item's grain; **packs are UoM rows, not items** (`item_uoms`: box=10 strips, strip=10 tablets, with exactly one row whose multiplier is 1 = the base). This is § 4A item 1, ruled provisionally here because Plan 16 may want pack-level SKUs; if it does, a pack is still a UoM with a barcode (`item_barcodes.pack_uom`), not a second item. Item `class` is a CHECK over `drug | consumable | consumable_dated | reagent | implant | stationery | linen | gas | asset | service`; **batch and expiry are mandatory at the gate for `drug | consumable_dated | reagent | implant`** and that list is ONE constant in `items.ts` read by the GRN gate (DD8) — never restated.

**DD4 — Vendors are NOT counterparties.**
`counterparties.payee_class` is a closed CHECK over three commission classes, its agreements are attribution and payout terms, and its S10 SoD pairs are *payout preparer / approver*. A vendor's are *PO approver / GRN receiver* and *custodian / counter*, its documents are drug licences and Udyam certificates, and its lifecycle has `blacklisted`. Forcing one table to carry both is the `patient_merge_requests.approval_id` shape (a column meaning two things). So: `vendors`, `vendor_documents`, `vendor_bank_changes`, module-owned. **The seam named rather than built:** when 14b exports payment vouchers to Tally, the payee ledger name is derived from either table by a mapper; a `payees` view can unify them then. Vendor bank details are stored as a JSONB `bank` object and **every read path outside `vendor_bank_changes` masks the account number to its last four** (doc 09 §7's DPDP class: financial-sensitive, masked in UI, change-controlled).

**DD5 — Ownership is a column on the BATCH, it is IMMUTABLE, and consignment stock has a lot.**
§11.19-D fix 7 puts the ownership dimension on stock locations; this plan puts it on `stock_batches.ownership` (`owned | consignment | loaner | donated`) because a batch never changes hands without leaving the ledger and re-entering as a different batch (a consignment implant that is bought outright is a GRN of an owned batch, not a flag flip). Immutability is enforced at the write path (no `updateBatch` touches it) and asserted (A11). Balances are per `(resource, batch)`, so *ownership per location* falls out of the join and the leakage triangle per ownership class (fix 7) is a query, not a column. **`consignment_lots`** is one row per (challan, item, batch): `challan_no`, `challan_date`, `agreement_document_id` (DD8 — **O-8 RULED**: no signed agreement on file, no consignment GRN), `deemed_supply_deadline = challan_date + 180 days` (§31(7), computed at insert and never recomputed), `qty_received / qty_deployed / qty_returned`. The 150-day aging flag, the vendor statement reconciliation and the auto-PO are **14c's**; the lot exists here so Plan 15 has something to deploy from.

**DD6 — The ledger is APPEND-ONLY; balances are materialised per `(resource, batch)` in the same transaction, locked `for update` in id order, and NEVER go negative.**
`stock_ledger` has no update and no delete path (A7). `stock_balances` is the read model billing, pharmacy and the board will query; it is updated in the transaction that appends the ledger row, after locking the affected balance rows `order by resource_id, batch_id for update` — the `receipts.ts:637` shape, set-then-rows, never row-then-set, so two pickers on the last strip serialise (A8, doc 16 B2). `CHECK (qty_on_hand >= 0 AND qty_reserved <= qty_on_hand AND qty_frozen <= qty_on_hand)` defends the invariant against every write path including raw SQL. **Negative stock is refused in this phase, full stop** — no backfill-order exception. Doc 16's H1 (a dispense recorded before its GRN during downtime) is a real case and it is **16c's**, with 11c's downtime kit; it is named here so the refusal reads as chosen. `occurred_at` may precede `recorded_at` (the downtime-kit convention), but the balance check applies in RECORDED order.

**DD7 — Quantities are INTEGERS in the item's BASE UoM; conversion happens once, at capture, from `item_uoms`; money is integer paise.**
A GRN line captured as "3 boxes" is stored as `qty_in_uom = 3, uom = 'box', qty_base = 300`; every ledger row is in base units. `unit_cost_paise` on a GRN line is per BASE unit (landed cost per tablet, not per box), and MRP is per the pack it is printed on — **`mrp_paise` is stored beside `mrp_uom`** so a strip MRP is never divided into a tablet MRP by a rounding step nobody audited (16a DD5: one constant, one owner; §2.93: verify a formula where its operands differ). The conversion function is pure, lives in `uom.ts`, and is the one place a multiplier is applied (A2).

**DD8 — The GRN gate is DETERMINISTIC and its rules are listed here in the order they run, because the order is the semantics.**
Per line, at `qcLine`: (1) item exists and is active; (2) UoM is one of the item's; (3) batch + expiry present when the class demands it (DD3's constant); (4) expiry after today; (5) **residual shelf-life ≥ 6 months OR ≥ 75% of the item's `shelf_life_days`, whichever is LOWER — O-2 RULED 2026-08-27** — else the line is `near_expiry` and posting needs a granted `materials_near_expiry_acceptance` approval on the GRN (DD10); (6) `mrp_paise` present for `drug | implant` and **MRP < landed cost is a hard block** (selling below cost, or a mis-key); (7) **MRP > ceiling is a hard block** where an `item_price_regulations` row with `ceiling_paise` is effective on the challan date (doc 16 D2 — the offence is selling above ceiling and the gate is the cheapest place to stop it); (8) batch `recall_status` — a batch already frozen refuses new receipts; (9) consignment source needs a vendor document of type `consignment_agreement` valid on the challan date (**O-8**). The two-stage flow (`captured_by` → `qc_by`) exists so a lorry can leave before the pharmacist arrives (doc 09 §6.1); **capture and QC may be the same user in this phase** — the SoD pairs S10 names are PO-approver/receiver and custodian/counter, neither of which exists until 14b/14c, and inventing a third pair here would be a rule nobody ruled. Posting creates one `stock_batches` row per accepted line (or reuses an existing `(item, batch_no, ownership)` row and asserts its expiry and MRP agree — A9), appends one `grn` ledger row per line, and emits `grn.received` once; rejected lines emit `grn.line_rejected` each; a GRN with zero accepted lines emits `grn.rejected`. **Free goods are separate zero-cost lines with full batch discipline** and their landed cost is 0, which is why rule (6) reads `<` and not `<=`.

**DD9 — Issue is TWO-SIDED through a real `IN-TRANSIT` store, and a discrepancy is a row, not an adjustment.**
`issueStock(from, to, lines)` moves each batch quantity `from → IN-TRANSIT` (ledger reason `issue`) and creates a `transfers` header in `in_transit`; `receiveStock(transferId, lines)` moves `IN-TRANSIT → to` (reason `receive`) for the quantities the receiver confirms; a shortfall stays in `IN-TRANSIT`, the header goes to `discrepancy`, and `material.discrepancy_flagged` fires the same transaction (§11.10: *"discrepancies surface same-hour"*). Resolution (return to source or write off) is **14c's** variance machinery; in this phase a discrepancy is visible and nothing hides it. The transit store is a registry `store` created by `ensureTransitStore(tx, siteId)` on first use, code `IN-TRANSIT`, and the board excludes it by code — that exclusion is one predicate in one reader (Plan 13 DD9's discipline). **Issue picks FEFO by default**: `fefoPick(resource, item, qty)` returns batches ordered by `expiry_date, id`, skipping frozen and fully-reserved quantities, and the caller may override the batch only through an explicit `batchId` with a reason (the pharmacy's substitution case) — the override is evented.

**DD10 — TWO approval types, registered by a seed script, and the cooling-off is computed, not enforced, here.**
`materials_near_expiry_acceptance` (approver `materials_head`, routine, no act-first, 240-minute pending SLA) and `materials_vendor_bank_change` (approver **`owner`** — **O-6 RULED**: owner approval always; routine; no act-first; 1,440 minutes). Both go through `requestApproval` with `payeeId = vendorId` on the bank change (the engine's C-12 aggregation needs a target and this is the honest one). On grant, `applyBankChange` writes the new bank object and sets `vendor_bank_changes.cooling_off_until = granted_at + 7 days` and `vendors.first_payment_allowed_at` to the same instant. **Nothing in this phase pays anyone, so nothing here can enforce the cooling-off** — 14c's payment run refuses a payee whose `first_payment_allowed_at` is in the future, and that column exists now so 14c reads it rather than re-deriving it. Registered by **`scripts/seed-materials.ts`** in the `seed-tariff.ts:209` shape (idempotent, skip-if-present), which moves the deploy seed census (DD15).

**DD11 — Two new roles, eleven permissions, and `pharmacy` gains the QC half.**
Roles: **`materials_head`** and **`storekeeper`**. Permissions, all declared on the manifest in T2 ahead of the routes that guard on them (the 16a T2 / 09 T1 precedent, and the reason `seed-roles.ts` is in T2's Files list and no later task's): `materials.items.read`, `materials.items.manage`, `materials.vendors.read`, `materials.vendors.manage`, `materials.stores.manage`, `materials.stock.read`, `materials.grn.capture`, `materials.grn.qc`, `materials.stock.issue`, `materials.stock.receive`, `materials.recall.manage`. `materials_head` holds all eleven. `storekeeper` holds `items.read`, `vendors.read`, `stock.read`, `grn.capture`, `stock.issue`, `stock.receive`. **`pharmacy` gains `items.read`, `stock.read`, `grn.qc`** — the pharmacist is the QC signatory for drugs (doc 09 §7 *"who signs what"*), and giving the role the read halves means the formulary curator can see what the item it curates is called on a shelf. `owner` holds nothing new (the bank-change approval reaches the owner through `approvals.*`, already held). Vendor `blacklist` is an action under `materials.vendors.manage` with a mandatory reason from the **O-11 RULED** trigger list and `blacklist_until = now + 3 years`; reinstatement before that date is refused (A5). **Measure the census after T2 and write the numbers in CLOSE; the expected shape is 78 → 89 declared, 64 → 75 held, 14 not-yet-modelled unchanged, and the README gains a third table headed by the two new roles.**

**DD12 — Events: five catalog names reused, six NEW under the `entity.verb_past` lint, each with its subscriber or its reader named.**
Reused from spec §10.6/§11.10: `grn.received`, `grn.rejected`, `material.issued`, `batch.recalled`, `batch.expiring`. NEW, module `materials`: `item.registered` / `item.updated` (audit, DD8-of-Plan-13's reasoning — a master that emits nothing is an audit hole), `vendor.registered` / `vendor.updated` / `vendor.status_changed` (same; the bank change is a `vendor.updated` with `changed: ["bank"]` and NO bank values in the payload), `grn.line_rejected` (reader: the GRN screen's rejection list and 14b's vendor scorecard), `material.received` and `material.discrepancy_flagged` (reader: 14c's variance register; the discrepancy is also the transfer screen's red row), `material.consumed` (reader: Plan 15's discharge bill and 16c's dispense charge — DD13). `near_expiry.accepted` is NOT a new event: it is `approval.granted` on a `materials_near_expiry_acceptance` subject, and the GRN row carries the `approval_id`. `consignment.deployed` is defined here and emitted by Plan 15 (DD13).

**DD13 — THE CONSIGNMENT INTERFACE, frozen: `consignment.deployed` in, `material.consumed` out, and the price facts travel with the fact.**
`events.ts` exports `consignmentDeployed = defineEvent("consignment.deployed", "materials", …)` with payload `{ lotId, batchId, itemId, storeResourceId, qtyBase, patientId, encounterId, caseRef: { type, id }, stickerRef?, occurredAt }`. Plan 15 IMPORTS this object and appends it inside its scan-on-use transaction; it never redefines the name. The materials manifest subscribes `{ event: "consignment.deployed", consumer: "materials.consumption" }`, the handler is registered in `workerConsumers` in the same commit (T7 — the `partnersManifest` one-commit rule), and it is **idempotent by event id** through `event_idempotency` (the accrual consumer's shape). What it does, in one transaction: locks the balance, appends a `consume` ledger row (ownership `consignment`, `patient_id`, `encounter_id`), increments `consignment_lots.qty_deployed`, and emits **`material.consumed`** `{ ledgerEntryId, itemId, batchId, ownership, vendorId, qtyBase, patientId, encounterId, caseRef, mrpPaise, mrpUom, ceilingPaise (effective at occurredAt, or null), occurredAt }`. **It posts NO charge**, because there is no event-driven charge path in billing (§2), and inventing a private one here would put a money poster in the stores module. The bill for the case is composed by Plan 15 at discharge from `consumptionsFor(encounterId)` — the read interface T7 ships — with the tariff's `regulated` clamp applied by billing as it is today. **This is § 4A item 3**: the day billing grows a chargeables spine (§11.11's *"nothing is remembered onto a bill"*), `material.consumed` is already the event it consumes. A deployment against a lot with insufficient `qty_received − qty_deployed − qty_returned` is refused (`lot_exhausted`) and the refusal is an event the OT screen can show — doc 09 §6.3's Friday-evening case, caught at the scan rather than at month-end.

**DD14 — Recall is ONE action, and `batch.expiring` is an event with a worklist, not an alert.**
`recallBatch(tx, actor, batchId, reason)` sets `stock_batches.recall_status = 'frozen'` and, in the same transaction, sets `qty_frozen = qty_on_hand` on **every** balance row of that batch under the DD6 lock, then emits ONE `batch.recalled` carrying the list of `{ storeResourceId, qtyFrozen }` (§11.10: *"one-action freeze at every location"*). `issueStock`, `fefoPick`, `reserveStock` and the consumption consumer all refuse a frozen batch (`batch_frozen`); the GRN gate refuses new receipts of it (DD8 rule 8). `releaseRecall` (false alarm) and the return/destroy paths are **14c's** — in this phase a frozen batch stays frozen, which is the safe direction. **`sweepBatchExpiry`** is a `dailyIst("06:30")` worker job (the `sweepAppointmentNoShows` shape at `jobs.ts:176`) that emits `batch.expiring` at the 90/60/30-day thresholds, **once per batch per threshold** (idempotent by `(batchId, threshold)` recorded on the batch row as `expiry_notified_thresholds`), only for batches with non-zero on-hand somewhere. `GET /materials/expiring` is the worklist. It does not become an alert: the alerts consumer routes three kinds and adding a fourth is a kernel change this phase has no ruling for; doc 09 §9 says the Expiry Watchman's own fail-open path is "reports still queryable", and that is what ships.

**DD15 — Censuses this phase moves, each named with the task that moves it and the file that pins it.**
Manifest census **13 → 14** (T2: `manifests.ts`, `manifests.test.ts:9`, `app.module.ts`, **and** `worker.module.ts` — this manifest is installed in BOTH, so leg 3's "exactly four" stays four and T2 says so in the (1e) comment). Permission census **78 → MEASURED** (T2: `seed-roles.ts`, `seed-roles.test.ts` all five pins plus the per-module block, `README.md`). **SPA route census 25 → 28** (T9: `router.tsx`, `caddyfile-parity.test.ts:304`). **Deploy seed census 11 → 12** (T2: `scripts/seed-materials.ts`, `package.json`, `docker/prod/deploy.sh`, `deploy-parity.test.ts:398`). **Worker consumers 3 → 4** (T7: `worker.module.ts`). `EPISODE_SERIES` gains `grn` (T1: `series.ts`, `series.test.ts`). **Unmoved, verified:** the API prefix census (one, `/api`) and `packages/contracts` (4 suites) — no contract change; the module's zod lives in its own `materials.controller.ts` like the formulary's.

**DD16 — Three screens, hand-built (Lane 1), and the reason the GRN gate is one of them — OWNER RULED 2026-08-27.**
`/materials/items`, `/materials/vendors` (the `formulary-admin.tsx` shape: list, create, edit, activate/retire, documents on the vendor), and **`/materials/grn`** — keyboard-first: vendor → source → store → lines (item picker, UoM, qty, batch, mfg, expiry, MRP + its UoM, cost, free-goods toggle) → QC verdict per line with the rule that fired → post. There is no Lane-2 generator in the house yet (deferred note 3 remains deferred), so "schema-generated worklists" is not an option this phase can choose; the two worklists that matter (expiring, discrepancies) are read routes with tables on the GRN screen's second tab rather than screens of their own. The owner ruled screens IN because without an admin screen nobody can register an item or a vendor except by script, and the mini-OT's first consignment challan is received on the GRN gate. Menu entries on the manifest, guarded by `materials.items.manage`, `materials.vendors.manage`, `materials.grn.capture`. Locale keys in both `en.json` and `hi.json` (the shell's i18n contract).

**DD17 — ONE additive migration, `0034`, and ONE deploy.**
Fifteen tables, no backfill, no repoint, nothing dropped. `pnpm db:generate` output is committed as generated — no hand-authoring, because there is no ordering to fix and no guard to write; **read the generated file anyway** (Plan 13 lesson 4: the generator's default can be the dangerous form — here the risk is a CHECK it fails to emit, which `materials.test.ts` pins by reading `pg_constraint`). Deploy after T9, owner-authorised in as many words (§3.6), with `seed:materials` in the seed chain.

**DD18 — What this phase deliberately does NOT build, so CLOSE cannot be written as if it did.**
No indent, no PO, no rate contract, no supplier invoice, no match, no Tally export, no register, no payment, no petty cash, no cycle count, no variance adjustment, no capex, no asset, no vendor scorecard, no Replenishment Agent, no Invoice Reader. No per-patient indent. No `IN-TRANSIT` resolution. No alert. No search provider (`@item` is not a chip yet; the first module to give it a screen adds the `search:` entry — Plan 11h DD1 makes that one line). The value this phase ships is **that stock exists, is batched, expires, is owned by someone, moves with two signatures, freezes in one action, and can be deployed against a patient from a consignment lot** — and everything else is forward-looking, said here in as many words (16a's precedent).

---

## 4A. ROUTED TO THE OWNER — ruled, provisional, and named

> **RULED 2026-08-27 in the authoring session (owner adopted the brainstorm's recommendations as written):** **O-2** near-expiry acceptance rule (DD8 rule 5, with the fast-mover exception being the approval itself); **O-6** vendor bank-change cooling-off 7 days, owner approval always (DD10); **O-8** consignment GRN refused without a signed agreement on file (DD8 rule 9); **O-11** blacklist 3 years with the four trigger codes (DD11). Values are configuration constants in `materials/config.ts` with those defaults, not literals in logic — the CA/counsel sessions (R-097, R-102) may move them without a code change.

1. **Pack-level SKUs — PROVISIONAL (DD3).** One item per formulary medicine; packs are UoM rows with barcodes. **Plan 16's author should confirm before 16c T1**; if pharmacy needs pack-level *pricing*, `item_price_regulations` already carries `mrp_uom`. Nothing in this phase closes the door; a pack-as-item later would be a data shape, not a migration.
2. **The stores ↔ pharmacy collision — RULED BY THE PLANNER, recorded for the owner.** Doc 16 §14 gave 16c *"`store` kind + locations; items…; batches via Plan 14 interface; movements; FEFO"*, and doc 09 §1 gave the same things to Plan 14 with pharmacy as a caller of `stores.issue()`. `00-INDEX` did not list the collision. **One ledger, in `materials`; pharmacy is a consumer** — `pharmacy_batches` in doc 16's sketch becomes a reference to `stock_batches`, and 16c's "dispense" is a `consume` ledger row with a patient, exactly what DD13's consumer already writes for an implant. The owner may overturn this at 16c authoring; the cost of overturning it then is one FK direction, not a rewrite.
3. **Charge posting from events — a NAMED GAP, not this phase's.** Spec §11.11 says every charge posts from an event; the shipped billing issues invoices from counter drafts and REPORTS orphans. `material.consumed` is emitted with every fact a charge needs (DD13); nothing consumes it into a bill. **The routed question:** does the chargeables spine land with Plan 15 (its first paying consumer — the implant on the day-care bill), with 16c (the first high-volume one — every dispense), or as its own billing phase? The planner's recommendation is **16c**, because a day-care bill can be composed at discharge from one read call and a pharmacy counter cannot. Plan 15 should be authored knowing the answer.
4. **Item → service bridge — 14b or 16c, not here.** `regulated_prices` is per SERVICE; `item_price_regulations` is per ITEM; a drug is both. The bridge (`items.service_id`, or a tariff-side map) belongs to whichever phase first BILLS an item — see item 3. Until then a consignment implant's tariff is the service the OT case names, clamped by billing against the batch MRP and ceiling that `material.consumed` carries.
5. **Role names.** `materials_head` and `storekeeper` are the brainstorm's S10 names. If the owner's org chart says "Purchase Manager" or "Store In-charge", the KEY stays and the title changes — `ensureRole(db, key, title)` takes both.

---

## 5. Tasks

Tiers per AGENT-RULES §3. **CRITICAL tasks carry their Assertion Book rows inline** — assertion · mutant · discriminating input. Every task ends with the finish block (AGENT-RULES §5); commit messages are exact. **The migration number is re-based at kickoff against the measured head (Spike Q1).**

> **A standing note on every Assertion Book row below — 16a's F10 and Plan 13's four corrected rows: a "discriminating input" is a PREDICTION until somebody runs it.** Where a row's input is arguable it is argued; where an obvious-looking input would NOT discriminate, that is said. **The executor is expected to correct these rows and to record the correction as a finding — a corrected row is the instrument working.** And the fixture rule §2.102 leaves behind: **for every fixture, name the field whose value coincides with another's, and write one leg where they differ.** In this phase the coinciding fields are: `qty_in_uom` = `qty_base` (multiplier 1 hides every conversion defect), `mrp_paise` = `unit_cost_paise` (hides rule 6), `occurred_at` = `recorded_at` (hides ordering), one store (hides the `parentId`/`resourceId` predicate), one batch per item (hides FEFO), `ownership = 'owned'` everywhere (hides DD5).
>
> **AMENDED AT CLOSE — a SEVENTH coinciding field, and it is the only one that hid a MONEY defect:
> `mrp_uom` = the item's BASE unit.** The six above are about ordering, identity and conversion
> arithmetic; their cost is a test that fails to discriminate. This one's cost is a wrong number in
> a patient's bill. `consumption.test.ts` gave the batch and the regulation `mrpUom: "each"` on an
> `each`-based item, so `mrpPerBaseUnit` multiplied by 1, every conversion in the consumer was a
> no-op, and **`material.consumed` could carry a per-PACK MRP beside a per-BASE ceiling with no
> assertion in the file able to see it** (close review M3). Plan 15 applies
> `min(tariff, MRP, ceiling)` to those two fields.
>
> The general rule the seventh instance sharpens: **where a fixture makes a CONVERSION the identity,
> it has removed the conversion from the test rather than exercised it.** A multiplier of 1, an
> offset of 0, a timezone at UTC noon and a currency at par are all the same trap, and the last of
> those is not hypothetical either — the same close pass found `NOW = 06:30 UTC` hiding an IST
> calendar-day defect in `expiry.test.ts` (m2), where the UTC day and the IST day coincide for
> eighteen and a half hours out of every twenty-four.

---

### T1 — Fifteen tables, the GRN series, and migration `0034` — **ROUTINE**

**Files:** Create `apps/core/src/kernel/db/schema/materials.ts`, `apps/core/src/kernel/db/schema/materials.test.ts`; Modify `apps/core/src/kernel/db/schema/index.ts` (export after `formulary` and `resources` — both are referenced), **`apps/core/test/helpers/db.ts`** (all fifteen names into the `patients`/`opd` truncate statement — see below), `apps/core/src/kernel/episodes/series.ts` (+ `grn` key), `apps/core/src/kernel/episodes/series.test.ts`; Generate `apps/core/drizzle/0034_*.sql` + `drizzle/meta/` via `pnpm db:generate`.

**Produces (exact — every later task depends on these names):**
- **`items`**: `id` text PK (ULID) · `code` text NOT NULL · `name` text NOT NULL · `class` text NOT NULL CHECK (DD3's ten) · `formularyMedicineId` text nullable → `formulary_medicines.id`, **CHECK `(class = 'drug') = (formulary_medicine_id IS NOT NULL)`** · `hsnCode` text nullable · `gstRateBps` integer nullable · `baseUom` text NOT NULL · `batchTracked` boolean NOT NULL · `serialTracked` boolean NOT NULL default false · `storageClass` text NOT NULL CHECK (`ambient|cold_2_8|frozen|narcotic|flammable`) default `ambient` · `shelfLifeDays` integer nullable · `abcClass`/`vedClass` text nullable · `active` boolean NOT NULL default true · the `formulary_medicines` audit quartet. Unique on `lower(code)`.
- **`item_uoms`**: `id` · `itemId` → items · `uom` text · `toBaseMultiplier` integer NOT NULL CHECK `> 0` · `isPurchaseUom` · `isIssueUom` booleans. Unique `(item_id, lower(uom))`.
- **`item_barcodes`**: `id` · `itemId` · `code` text · `packUom` text · `vendorId` text nullable (no FK — vendors is declared below it; T3 validates). Unique on `lower(code)` globally.
- **`item_price_regulations`**: the `regulated_prices` shape keyed by `itemId`: `seq` bigserial · `id` · `itemId` · `mrpDefaultPaise` bigint nullable · `mrpUom` text nullable · `ceilingPaise` bigint nullable · `effectiveFrom` timestamptz · `gazetteRef` · `createdBy`/`createdAt`. Index `(item_id, effective_from)`.
- **`vendors`**: `id` · `code` unique lower · `legalName` · `tradeName` nullable · `gstin` nullable · `gstinVerifiedAt` nullable · `pan` nullable · `msmeUdyamNo` nullable · `msmeClass` text nullable · `paymentTermsDays` integer nullable · `classFlags` jsonb NOT NULL default `{}` (`drugLicensed`, `device`, `service`, `consignment`) · `bank` jsonb nullable · `firstPaymentAllowedAt` timestamptz nullable (DD10) · `status` text NOT NULL CHECK (`draft|active|suspended|blacklisted`) default `draft` · `blacklistUntil` timestamptz nullable · `blacklistReason` text nullable · audit quartet.
- **`vendor_documents`**: `id` · `vendorId` · `type` text CHECK (`drug_licence_20b|drug_licence_21b|gst_certificate|pan|cancelled_cheque|udyam|dpdp_processor_agreement|consignment_agreement|iso|aerb_type_approval`) · `number` · `validFrom`/`validTo` nullable · `fileRef` text nullable · `verifiedBy`/`verifiedAt` nullable · `createdBy`/`createdAt`.
- **`vendor_bank_changes`**: `id` · `vendorId` · `oldMasked`/`newMasked` text · `newBank` jsonb · `requestedBy` · `approvalId` text NOT NULL · `status` CHECK (`pending|applied|rejected`) · `coolingOffUntil` nullable · `appliedAt` nullable · `createdAt`.
- **`stock_batches`**: `id` · `itemId` · `batchNo` text · `mfgDate` date nullable · `expiryDate` date nullable · `mrpPaise` bigint nullable · `mrpUom` text nullable · `landedCostPaise` bigint NOT NULL (per base unit) · `vendorId` nullable · `grnLineId` text nullable · `ownership` text NOT NULL CHECK (DD5's four) · `consignmentLotId` text nullable · `recallStatus` text NOT NULL CHECK (`none|frozen`) default `none` · `expiryNotifiedThresholds` jsonb NOT NULL default `[]` · `createdBy`/`createdAt`. Unique `(item_id, lower(batch_no), ownership)`.
- **`consignment_lots`**: `id` · `vendorId` · `agreementDocumentId` → vendor_documents · `challanNo` · `challanDate` date · `itemId` · `batchId` → stock_batches · `storeResourceId` text NOT NULL → `resources.id` · `qtyReceived`/`qtyDeployed`/`qtyReturned` integer NOT NULL default 0, CHECK `deployed + returned <= received` · `deemedSupplyDeadline` date NOT NULL · `status` CHECK (`open|reconciled|closed`) default `open` · `createdBy`/`createdAt`.
- **`stock_ledger`** (append-only): `seq` bigserial (ordering) · `id` text PK · `resourceId` → resources · `batchId` → stock_batches · `itemId` · `qtyDelta` integer NOT NULL CHECK `<> 0` · `reason` CHECK (`grn|issue|receive|consume|return`) · `refType`/`refId` text · `eventId` text nullable · `patientId`/`encounterId` text nullable · `costCenter` text nullable · `actorId` NOT NULL · `occurredAt` NOT NULL · `recordedAt` NOT NULL defaultNow. Index `(resource_id, batch_id, seq)`, `(item_id, seq)`.
- **`stock_balances`**: PK `(resourceId, batchId)` · `itemId` · `qtyOnHand`/`qtyReserved`/`qtyFrozen` integer NOT NULL default 0 · **CHECK `qty_on_hand >= 0 AND qty_reserved <= qty_on_hand AND qty_frozen <= qty_on_hand`** · `updatedAt`.
- **`stock_reservations`**: `id` · `resourceId` · `batchId` · `qty` CHECK `> 0` · `refType`/`refId` · `expiresAt` nullable · `status` CHECK (`held|consumed|released`) · `createdBy`/`createdAt`.
- **`transfers`** / **`transfer_lines`**: header `id` · `fromResourceId` · `toResourceId` · `status` CHECK (`in_transit|received|discrepancy`) · `issuedBy`/`issuedAt` · `receivedBy`/`receivedAt` nullable · `note`; line `id` · `transferId` · `batchId` · `qtyIssued` · `qtyReceived` nullable · `discrepancyReason` nullable.
- **`grns`** / **`grn_lines`**: header `id` · `grnNo` text NOT NULL unique · `vendorId` · `source` CHECK (`challan|consignment_challan|donation`) · `poRef` text nullable (no FK — 14b) · `challanNo` · `challanDate` date · `invoiceNo` nullable · `storeResourceId` → resources · `status` CHECK (`draft|gate_qc|accepted|partially_accepted|rejected|posted`) · `capturedBy` · `qcBy` nullable · `postedAt` nullable · `approvalId` nullable · audit; line `id` · `grnId` · `itemId` · `uom` · `qtyInUom` · `qtyBase` · `batchNo` nullable · `mfgDate`/`expiryDate` nullable · `mrpPaise`/`mrpUom` nullable · `unitCostPaise` NOT NULL (per base) · `freeGoods` boolean · `qtyAcceptedBase`/`qtyRejectedBase` integer default 0 · `rejectReason` nullable · `nearExpiry` boolean default false · `tempLogRef` nullable · `batchId` nullable (set at post).

**`EPISODE_SERIES` gains `grn`** with a `GRN` prefix in the existing format; `series.test.ts` pins the key list.

**`truncateAll`:** all fifteen names join the `patients`/`opd` statement, adjacent to `resources` (every ledger row points at a `resources` row, so they must truncate together — §3.35 and 16a F2's island rule, in the same reasoning Plan 13 T1 recorded).

**Acceptance:** `materials.test.ts` pins every table's columns by name (the `resources.test.ts` pattern) **and reads `pg_constraint` to assert the five CHECKs that carry semantics exist by name**: items' class↔formulary CHECK, balances' non-negative CHECK, batches' ownership CHECK, ledger's non-zero delta, lots' deployed+returned ≤ received. Migration generated only when ready to carry it to the commit (AGENT-RULES §6); full-suite migration applies clean. `pnpm verify` exit 0 before push, detached, exit value read from a file.
**Commit:** `feat(core): materials schema — items, vendors, batches, ledger, GRN, consignment lots (14 T1)`

---

### T2 — The module skeleton: manifest, the `store` kind, permissions, roles, events, errors, seed — and the worker collects kinds — **ROUTINE**

**Files:** Create `apps/core/src/modules/materials/{manifest.ts, events.ts, errors.ts, config.ts, index.ts, materials.module.ts, kinds.ts, kinds.test.ts}`, **`apps/core/scripts/seed-materials.ts`**, `apps/core/src/modules/materials/approval-types.ts` (+ `.test.ts`); Modify `apps/core/src/kernel/modules/manifests.ts` (**13 → 14**), `apps/core/src/kernel/modules/manifests.test.ts` (census leg, and the (1e) comment: installed in both, leg 3 unchanged at four), `apps/core/src/app.module.ts` (install), **`apps/core/src/kernel/worker/worker.module.ts`** (install the manifest **and add the `collectResourceKinds(registry)` call** — DD2), `apps/core/scripts/seed-roles.ts` (two roles, the grants, `pharmacy`'s three), `apps/core/test/seed-roles.test.ts` (all five census pins + the per-module block), `README.md` (a third permission×role table), `apps/core/package.json` (`seed:materials`), `docker/prod/deploy.sh` (after `seed:formulary`), `apps/core/test/deploy-parity.test.ts` (**11 → 12**).

**Produces:**
- `manifest.ts`: key `"materials"`, three menu entries (DD16 — the paths exist from T9; a menu entry whose screen is not yet built is the formulary precedent and is fine for seven commits), the eleven permissions (DD11), `subscriptions: []` **in this task** (T7 adds the one subscription with its handler in one commit — the `partnersManifest` rule), `resourceKinds: MATERIALS_RESOURCE_KINDS` from `kinds.ts` (DD2's `store` declaration).
- `events.ts`: the DD12 names, **including `consignmentDeployed` with DD13's payload verbatim** — this file IS the interface Plan 15 imports.
- `errors.ts`: `MaterialsError` with codes `unknown_item | unknown_vendor | unknown_store | unknown_batch | unknown_uom | duplicate_code | drug_needs_medicine | non_drug_has_medicine | base_uom_required | vendor_not_active | vendor_blacklisted | blacklist_active | agreement_missing | batch_required | expiry_required | expired | near_expiry_unapproved | mrp_below_cost | mrp_above_ceiling | batch_frozen | batch_mismatch | insufficient_stock | lot_exhausted | not_in_transit | already_received | negative_stock`, and `materialsHttpStatus` in the formulary shape (404 for the `unknown_*`, 409 otherwise). **Every code listed here is thrown by some task below; a code thrown by no path is a lie the reviewer should catch.**
- `config.ts`: `NEAR_EXPIRY_MIN_MONTHS = 6`, `NEAR_EXPIRY_MIN_FRACTION = 0.75`, `BANK_CHANGE_COOLING_OFF_DAYS = 7`, `BLACKLIST_YEARS = 3`, `BLACKLIST_REASONS` (the four), `EXPIRY_THRESHOLD_DAYS = [90, 60, 30]`, `DEEMED_SUPPLY_DAYS = 180`, `BATCH_MANDATORY_CLASSES` — **each a named export read by exactly one logic file** (§2.54).
- `approval-types.ts`: the two DD10 specs and `registerMaterialsApprovalTypes(db, activator)` in the `seed-tariff.ts` shape; `seed-materials.ts` calls it and nothing else.
- Worker: install `materialsManifest`; add the `collectResourceKinds` line with `app.module.ts:62-66`'s comment pointed at this task.

**THE FOUR NUMBERS THIS TASK MOVES:** manifests 13→14 · permissions 78→**measured** · deploy seeds 11→12 · per-module declared block gains `materials: 11`. **Measure and report** (AGENT-RULES §4).

**Acceptance:** `kinds.test.ts` pins `store`'s declaration and that `occupied` is null; `manifests.test.ts` green at fourteen with leg 3 still four; `seed-roles.test.ts` closes at the measured census; `deploy-parity` at twelve; `approval-types.test.ts` proves idempotence (second call registers nothing). Spike Q6 answered here. `pnpm verify` exit 0.
**Commit:** `feat(core): materials module seam — manifest, the store kind, permissions, roles, events, seed (14 T2)`

---

### T3 — Item master, UoM conversion, price regulations — **CRITICAL**

**Files:** Create `apps/core/src/modules/materials/{items.ts, items.test.ts, uom.ts, uom.test.ts}`; Modify `apps/core/src/modules/materials/index.ts`.

**Produces** (all `(tx, actor, …)`, the `formulary/masters.ts` shape): `registerItem` (creates the item, its base UoM row with multiplier 1, any additional UoMs, barcodes; validates DD3's CHECK in code so the error names the rule, not the constraint), `updateItem`, `addItemUom`, `addBarcode`, `setPriceRegulation`, `listItems`, `getItem`, `resolveBarcode(code) → { itemId, packUom }`, `effectiveRegulation(db, itemId, at)`. `uom.ts`: **`toBase(uoms, uom, qty) → integer`** and `fromBase` — pure, throw `unknown_uom`, never round (a quantity that does not divide evenly in `fromBase` returns the remainder explicitly).

#### Assertion Book — T3

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | A `drug`-class item without `formulary_medicine_id` is refused (`drug_needs_medicine`), and a non-drug item WITH one is refused (`non_drug_has_medicine`) — at the write path, before the CHECK. | A validator that checks only the first direction. | **A `consumable` item created with a valid medicine id.** The one-direction mutant accepts it and the database CHECK then fails with a constraint name; the shipped code refuses with a code the screen can render. A drug-without-medicine input does NOT discriminate (both refuse; only the error text differs). |
| **A2** | `toBase` multiplies through the item's OWN UoM table and never a literal: 3 boxes of an item whose box is 10 strips of 10 is 300. | A `toBase` that returns `qty * 10` for any non-base UoM. | **Two items with different multipliers for the SAME uom name** — item X `box = 10`, item Y `box = 24` — and `toBase(Y, 'box', 1)`. The mutant returns 10, the shipped code 24. **A single item with a box of 10 cannot discriminate** (§2.102: the multiplier coincides with the mutant's literal). |
| **A3** | Exactly one UoM per item has multiplier 1 and it is `baseUom`; `registerItem` creates it and `addItemUom` refuses a second. | An `addItemUom` that accepts any positive multiplier. | **`addItemUom(item, { uom: 'each', toBaseMultiplier: 1 })` on an item whose base is `tablet`.** Shipped refuses `base_uom_required`-class error; mutant creates two bases and every later conversion has two answers. |
| **A4** | `effectiveRegulation(itemId, at)` returns the row with the LATEST `effective_from ≤ at`, ties broken by `seq` DESC (the `regulated_prices` rule). | ~~A query ordered by `effective_from` only.~~ **CORRECTED AT EXECUTION — that mutant SURVIVES. The killing mutant is a tie-break that is PRESENT but BACKWARDS (`asc(seq)`).** | **Two rows with the SAME `effective_from` and different ceilings, inserted in order; ask at that instant.** The input is right; the MUTANT was wrong. Executed 2026-08-27: the missing-key mutant returned the same row as the shipped code at 2, 3 and 5 tied rows — `agree=true` every time — because Postgres's top-N sort happened to keep insertion order, and `ORDER BY` on a tie is *permitted* to return either. **A missing tie-break is not observably wrong, only unreliably right, so no assertion over the returned row can kill it.** The `asc(seq)` mutant DIED: expected `g2`, received `g1`. Two rows with different dates still do not discriminate. |

**Acceptance:** rows built as separate scratch files beside the source, run ISOLATED, DIED/SURVIVED quoted with expected-vs-received (rule 21); fail-first quoted. `items.test.ts` covers the full masks: create/update/list/barcode resolve, `item.registered`/`item.updated` appended once each.
**Commit:** `feat(core): item master — items, UoM conversion, barcodes, price regulations (14 T3)`

---

### T4 — Vendor master: documents, lifecycle, blacklist, the bank-change approval — **CRITICAL**

**Files:** Create `apps/core/src/modules/materials/{vendors.ts, vendors.test.ts}`; Modify `apps/core/src/modules/materials/index.ts`.

**Produces:** `registerVendor` (status `draft`), `updateVendor` (never touches `bank` — A6), `addVendorDocument`, `activateVendor` (draft → active; refuses without a `gst_certificate` or `pan` document on file — the minimum the brainstorm's onboarding names for any class; drug-licence documents are required only when `classFlags.drugLicensed`), `suspendVendor`, `reinstateVendor`, `blacklistVendor(reason ∈ BLACKLIST_REASONS)` → `blacklist_until = now + 3y` (**O-11**), `requestBankChange(tx, actor, vendorId, newBank)` → `requestApproval` (`materials_vendor_bank_change`, `payeeId = vendorId`, subject `{ type: 'vendor_bank_change', id }`) and a `pending` row, `applyBankChange(tx, actor, changeId)` — refuses unless the approval is `granted`, writes `vendors.bank`, sets `cooling_off_until` and `vendors.first_payment_allowed_at = granted_at + 7d` (**O-6**), emits `vendor.updated { changed: ['bank'] }` **with no bank values in the payload**. `getVendor`/`listVendors` return `bank` MASKED (`{ …, accountNo: '••••1234' }`); only `vendor_bank_changes` rows carry the full new object and only `materials.vendors.manage` may read them. `hasValidDocument(tx, vendorId, type, onDate)` — the read T6 uses for **O-8**.

#### Assertion Book — T4

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A5** | `reinstateVendor` on a blacklisted vendor before `blacklist_until` throws `blacklist_active`; after it, succeeds. | A reinstate that checks `status === 'blacklisted'` and ignores the date. | **Blacklist, then reinstate with a clock injected at `blacklist_until − 1 day`, then again at `+ 1 day`.** The mutant refuses both (it can never reinstate) or accepts both (if it just flips status) — either way it fails one leg; the shipped code fails the first and passes the second. A single "reinstate immediately" leg does not discriminate the always-refuse mutant. |
| **A6** | The ONLY path that changes `vendors.bank` is `applyBankChange` with a granted approval. | An `updateVendor` that spreads its input over the row, `bank` included. | **`updateVendor(id, { legalName: 'X', bank: {…} })`** — the shipped code ignores or refuses `bank`; the mutant writes it with no approval and no cooling-off. Then `applyBankChange` on a `pending` (not granted) change — refuses `approval_not_granted`-class. |
| **A7** *(ledger row, placed here because the vendor is its payee)* | Masking: `getVendor` never returns more than the last four of `accountNo`. | A mapper that returns `bank` unmasked. | An account number `'123456789012'`; assert the response contains `'9012'` and does NOT contain `'12345678'`. Trivial to build, listed because the reviewer will otherwise have to supply it. |

**Acceptance:** as T3. `vendors.test.ts` proves the approval round-trip end to end through `approveRequest` by a user holding `owner`, and that `vendor.status_changed` fires once per transition.
**Commit:** `feat(core): vendor master — documents, lifecycle, blacklist, bank change under owner approval (14 T4)`

---

### T5 — The ledger: post, balances, lock, FEFO, reserve, freeze — **CRITICAL**

**Files:** Create `apps/core/src/modules/materials/{ledger.ts, ledger.test.ts, ledger.concurrency.test.ts, stores.ts, stores.test.ts}`; Modify `apps/core/src/modules/materials/index.ts`.

**Produces:** `stores.ts`: `createStore(tx, actor, { code, name, parentId?, siteId? })` → `createResource(kind: 'store')`; `ensureTransitStore(tx, siteId)`; `listStores(db)` (excludes `IN-TRANSIT` by code — one predicate). `ledger.ts`: **`postMovement(tx, actor, { resourceId, batchId, qtyDelta, reason, ref, patientId?, encounterId?, occurredAt })`** — the ONLY writer of `stock_ledger` and `stock_balances`: lock the balance row(s) `for update` in `(resource_id, batch_id)` order, refuse `batch_frozen` for outbound movements on a frozen batch, refuse `insufficient_stock` when `on_hand − reserved − frozen < |delta|` on outbound, upsert the balance, append the row, return `{ ledgerEntryId, balanceAfter }`; `balances(db, { resourceId?, itemId?, batchId? })`; `fefoPick(db, resourceId, itemId, qtyBase) → [{ batchId, qty }]` ordered `expiry_date NULLS LAST, id`, skipping frozen and fully reserved; `reserveStock` / `releaseReservation` / `consumeReservation` (the pharmacy seam — functions with tests and NO route, Plan 13 DD14's posture); `recallBatch` (DD14); `movementsFor(db, { batchId | resourceId }, { limit })` by `seq`.

#### Assertion Book — T5

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A8** | Two concurrent outbound movements against one balance of 1 serialise: exactly one succeeds, the other throws `insufficient_stock`, and `qty_on_hand` ends at 0, never −1. | A `postMovement` that reads the balance, checks, then updates without `for update`. | **Two transactions on two connections, both reading before either writes, orchestrated with a barrier** — `ledger.concurrency.test.ts`, the `versions.contention.test.ts` shape. The timing assertion is a STATE, not a duration, so a busy host makes it MORE true (§2.99's trap avoided rather than budgeted around). **TWO CORRECTIONS, EXECUTED 2026-08-27.** (i) *The "is it still blocked?" observation does NOT discriminate* — the mutant blocks too, because its `ON CONFLICT DO UPDATE` takes the same row lock at WRITE time that the shipped code takes at READ time. That leg SURVIVED and is kept as a property, not as the discriminator; the `versions.contention.test.ts` precedent warned of exactly this shape and it applies here in reverse. (ii) *The mutant's failure mode is not the one predicted.* The plan expected "both commit and the CHECK fails one, or the balance goes negative". **Measured: BOTH racers FULFILLED, both returning `balanceAfter: 0`, two `issue` rows written for one unit of stock — a LOST UPDATE that lands on ZERO and is therefore invisible to `stock_balances_non_negative_ck`.** The CHECK is not the backstop for this case; only the lock is. The OUTCOME leg is the discriminator and it DIED. **Sequential calls do not discriminate** — confirmed, kept as a control. |
| **A9** | `postMovement` locks balance rows in `(resource_id, batch_id)` order across a multi-line movement, so two multi-line issues touching the same two batches in opposite orders do not deadlock. | Locking in the caller's line order. | **Issue A: batches [X, Y]; issue B: batches [Y, X]; run concurrently.** The mutant deadlocks (Postgres aborts one with 40P01); the shipped code serialises. Single-line issues do not discriminate. |
| **A10** | `fefoPick` returns the EARLIEST-expiring available batch first and never a frozen one or a fully reserved one. | A pick ordered by `id` (creation order). | **Two batches of one item where the LATER-created one expires EARLIER**, plus a third, earliest-expiring, that is frozen. Shipped: the later-created one; mutant: the earlier-created one. **Creation order = expiry order is the coinciding fixture and it cannot discriminate** (§2.102). |
| **A11** | `stock_batches.ownership` and `stock_ledger` rows are never updated: there is no code path, and raw-SQL update of a ledger row is caught by the append-only assertion. | (mechanical) `grep -rn "update(stockLedger)\|update(stockBatches)" apps/core/src` returns zero hits outside a scratch file; a test that attempts `db.update(stockLedger)` through the module API finds no such export. | **Named honestly as a WEAK row**: it is a grep and an absence, kept because the reviewer should confirm the absence rather than infer it. |
| **A12** | `recallBatch` freezes EVERY location's balance of the batch in one transaction and emits ONE `batch.recalled` naming all of them. | A recall that freezes only the store the caller passed. | **One batch held in THREE stores; recall; assert `qty_frozen = qty_on_hand` on all three and the event payload lists three.** One store cannot discriminate. |

**Acceptance:** all rows per rule 21. `ledger.test.ts` also proves: creation-order `seq` on the ledger, `occurred_at ≠ recorded_at` preserved, `movementsFor` ordered by `seq` not `id`.
**Commit:** `feat(core): the stock ledger — movements, balances under lock, FEFO, reservations, recall freeze (14 T5)`

---

### T6 — The GRN gate: capture, QC, near-expiry approval, post — **CRITICAL**

**Files:** Create `apps/core/src/modules/materials/{grn.ts, grn.test.ts, qc.ts, qc.test.ts}`; Modify `apps/core/src/modules/materials/index.ts`.

**Produces:** `qc.ts`: **`qcLine(ctx, line) → { verdict: 'pass' | 'near_expiry' | 'reject', rule?: RuleCode }`** — pure, DD8's nine rules in DD8's order, `ctx` carrying the item, its UoMs, the effective regulation, the batch's recall status, the vendor's agreement validity and the clock. `grn.ts`: `captureGrn` (header + lines, status `gate_qc`, `grnNo` from the series), `runGateQc` (every line through `qcLine`; a `near_expiry` line sets `nearExpiry = true`; header → `accepted` / `partially_accepted` / `rejected`), `requestNearExpiryAcceptance` (→ `requestApproval`, `materials_near_expiry_acceptance`, subject the GRN), `postGrn` — refuses `near_expiry_unapproved` if any `near_expiry` line and no granted approval on the header; for each accepted line: find-or-create the batch (A14), `postMovement(reason: 'grn')`, and for `consignment_challan` create the `consignment_lots` row with `deemed_supply_deadline`; emit `grn.received` once (or `grn.rejected` if nothing was accepted), `grn.line_rejected` per rejected line; status → `posted`. `getGrn`, `listGrns`.

#### Assertion Book — T6

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A13** | The shelf-life rule is `min(6 months, 75% of shelf_life)`, evaluated against the item's OWN `shelf_life_days`. | A `qcLine` that applies the 6-month rule only. | **An item with `shelf_life_days = 180` and a batch expiring in 150 days.** 75% of 180 is 135 days, so the shipped code PASSES it (150 ≥ 135, the lower bound wins); the 6-month-only mutant marks it `near_expiry`. **An item with a 3-year shelf life does not discriminate** (both bounds land on 6 months). |
| **A14** | Re-receiving a batch that already exists for `(item, batch_no, ownership)` REUSES the batch row and refuses `batch_mismatch` if expiry or MRP differ. | A post that always inserts a new batch row. | **Two GRNs of the same item and batch number, the second with a different expiry.** Shipped: refuses. Mutant: the unique index fails with a constraint name — or, if the mutant also drops the `ownership` from the key, silently creates a second batch. Assert the error CODE. |
| **A15** | `mrp_below_cost` fires on `mrp < landed cost` and NOT on equality, and free-goods lines (cost 0) never trigger it. | A rule using `<=`. | **A line with `mrp_paise = unit_cost_paise` (in the same UoM)** — shipped passes, mutant rejects. This is the §2.102 fixture (mrp = cost) used ON PURPOSE as the discriminating leg, which is why every OTHER fixture in this task must have them differ. |
| **A16** | A `consignment_challan` GRN from a vendor with NO `consignment_agreement` document valid on the challan date is refused `agreement_missing` — and a document valid yesterday but expired today does not count. | A check for the document's existence that ignores `valid_to`. | **A vendor with an agreement whose `valid_to` is the day before the challan date.** Shipped refuses; mutant accepts. A vendor with no document at all does not discriminate. |
| **A17** | `postGrn` with a `near_expiry` line and a PENDING approval refuses; with a GRANTED one posts; and the GRN's `approval_id` is the one that was granted. | A post that checks `approval_id IS NOT NULL` rather than the approval's status. | **Request the approval, do NOT approve, attempt post.** Shipped refuses `near_expiry_unapproved`; mutant posts. |

**Acceptance:** rows per rule 21. `grn.test.ts` covers all three sources, free goods, the consignment lot's deadline arithmetic (`challan_date + 180` exactly, across a month boundary and a leap day — §2.93), and that a fully rejected GRN writes NO ledger row.
**Commit:** `feat(core): the GRN gate — capture, deterministic QC, near-expiry approval, post to ledger and lots (14 T6)`

---

### T7 — Two-sided issue, discrepancies, and the consignment consumer — **CRITICAL**

**Files:** Create `apps/core/src/modules/materials/{transfers.ts, transfers.test.ts, consumption.ts, consumption.test.ts}`; Modify `apps/core/src/modules/materials/{manifest.ts (the ONE subscription), index.ts}`, **`apps/core/src/kernel/worker/worker.module.ts`** (`workerConsumers` gains `materials.consumption` — same commit as the subscription, the `partnersManifest` rule), `apps/core/src/kernel/modules/manifests.test.ts` (only if a leg pins subscription counts — verify).

**Produces:** `transfers.ts`: `issueStock(tx, actor, { fromResourceId, toResourceId, lines: [{ itemId, qtyBase, batchId? , overrideReason? }] })` → FEFO unless `batchId`, `postMovement(issue)` into `IN-TRANSIT`, header `in_transit`, `material.issued`; `receiveStock(tx, actor, transferId, lines: [{ lineId, qtyReceived }])` → `postMovement(receive)` from `IN-TRANSIT`, header `received` or `discrepancy`, `material.received` and, on any shortfall, `material.discrepancy_flagged` with the per-line gap; refuses `not_in_transit` / `already_received`. `consumption.ts`: `consumptionConsumer(db): Handler` (DD13, idempotent by event id via `event_idempotency`), and the read **`consumptionsFor(db, encounterId)`** returning `material.consumed`'s payload shape per row.

#### Assertion Book — T7

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A18** | A shortfall at receive leaves the difference IN `IN-TRANSIT` and flags the header; it is never silently written down. | A receive that moves `qty_issued` regardless of `qty_received`. | **Issue 10, receive 7.** Shipped: destination 7, transit 3, header `discrepancy`, event fired. Mutant: destination 10, transit 0. Receive-all does not discriminate. |
| **A19** | The consumption consumer is idempotent: the same `consignment.deployed` delivered twice writes ONE ledger row and increments `qty_deployed` ONCE. | A consumer that skips the idempotency claim. | **Dispatch the same event object twice through the bus.** Mutant: two consume rows, `qty_deployed` doubled. |
| **A20** | A deployment exceeding the lot's remaining quantity is refused `lot_exhausted` and writes NOTHING — no ledger row, no `qty_deployed` change. | A consumer that posts the movement before checking the lot. | **CORRECTED AT EXECUTION — the plan had this exactly backwards, in two ways, and both were measured.** (i) *The prescribed fixture does not work at all.* A balance is keyed `(resource, batch)` and the deployment names a specific `batchId`, so **a second OWNED batch of the same item adds nothing to THIS batch's balance** — the movement still refuses. The only shape that leaves the batch healthy while one lot is exhausted is a **SECOND LOT against the SAME batch** (a second challan of one batch number — a real case the consumer's own comment anticipates). (ii) *With that corrected fixture the mutant SURVIVES*, because both implementations run in ONE transaction: the throw rolls the movement back either way, so **"writes NOTHING" is a property of the transaction, not of the order of the checks**, and no assertion over persisted state can see the difference. **THE OBVIOUS FIXTURE IS THE DISCRIMINATOR** — lot AND balance exhausted — and the observable is the refusal's CODE: shipped `lot_exhausted`, mutant `insufficient_stock`. Measured verbatim: `Expected: "lot_exhausted"  Received: "insufficient_stock"`. It matters operationally: `insufficient_stock` sends a scrub nurse to the shelf, `lot_exhausted` sends them to the vendor rep. Both fixtures ship as legs; the corrected one is the assertion. |
| **A21** | `material.consumed` carries the regulation EFFECTIVE AT `occurredAt`, not at processing time. | A consumer that calls `effectiveRegulation(itemId, now())`. | **Two regulation rows, one effective before `occurredAt` with ceiling C1, one effective after `occurredAt` but before now with ceiling C2.** Shipped: C1. Mutant: C2. One regulation row does not discriminate — confirmed, and it ships as a control. **The row is RIGHT and its first instantiation was WRONG:** the executor's first fixture dated C2 to the day AFTER `occurredAt` but that day was still in the FUTURE relative to the real clock, so `effectiveRegulation(now())` returned C1 and the leg passed against the mutant — **a vacuously green assertion**. C2 must fall strictly between `occurredAt` and now, which the plan's wording already said. Corrected to `occurredAt + 1 hour`; the mutant then DIED. Recorded because "the input is a prediction until somebody runs it" applies to the executor's transcription of it as much as to the author's choice of it. |

**Acceptance:** rows per rule 21; the worker boots with the subscription bound (quote the boot line); `consumptionsFor` ordered by `seq`.
**Commit:** `feat(core): two-sided issue and receive, discrepancies, and the consignment.deployed consumer (14 T7)`

---

### T8 — Routes, the expiry sweep, and the e2e — **ROUTINE**

**Files:** Create `apps/core/src/modules/materials/materials.controller.ts`, `apps/core/src/modules/materials/expiry.ts` (+ `.test.ts`), `apps/core/test/materials.e2e.test.ts`; Modify `apps/core/src/modules/materials/materials.module.ts` (controller only — the global guards rule Plan 13 T5 records), `apps/core/src/kernel/worker/jobs.ts` (`sweepBatchExpiry`, `dailyIst("06:30")`), `apps/core/src/kernel/worker/jobs.test.ts` (if it pins the job census — verify).

**Produces:** routes under `/materials/*`, every one `@RequirePermission(...)` per DD11, zod-parsed, `MaterialsError` → `toHttp` **through the shared mapper** (the formulary controller's header says why in as many words — Plan 13's M-class 500 was exactly a new error code unmapped): `items` (list/get/create/patch/uoms/barcodes/regulations), `vendors` (list/get/create/patch/documents/activate/suspend/reinstate/blacklist/bank-change/apply), `stores` (list/create), `stock/balances`, `stock/movements`, `grns` (list/get/capture/qc/near-expiry-request/post), `transfers` (issue/receive/get/list), `recalls` (post), `expiring` (the DD14 worklist), `consumptions?encounterId=`. **No route for `reserveStock`** (DD14 of Plan 13's posture — the first caller mounts it). `expiry.ts`: `sweepBatchExpiry(db, now)` per DD14, idempotent per `(batch, threshold)`.

**Acceptance:** e2e asserts 401 unauthenticated, **403 for an authenticated `front_office` actor** on every family, 200 for `materials_head`, and the capture→qc→post→issue→receive chain end to end with the runner's summary line quoted. `expiry.test.ts` proves one event per batch per threshold across two sweeps and none for a zero-on-hand batch. **No Caddyfile, no vite edit** (API prefix census is one).
**Commit:** `feat(core): materials routes, the batch-expiry sweep, and the e2e (14 T8)`

---

### T9 — Three screens: items, vendors, the GRN gate — **ROUTINE**

**Files:** Create `apps/web/src/lib/materials-api.ts`, `apps/web/src/screens/{materials-items.tsx, materials-items.test.tsx, materials-vendors.tsx, materials-vendors.test.tsx, materials-grn.tsx, materials-grn.test.tsx}`; Modify `apps/web/src/router.tsx` (three routes, **25 → 28**), **`apps/core/test/caddyfile-parity.test.ts:304`** (the pin), `apps/web/src/locales/en.json`, `apps/web/src/locales/hi.json`, `apps/web/src/shell-nav.test.tsx` (only if it pins menu counts — verify).

**Produces:** DD16's three screens on `form-kit`, `submit-button`, `money-input` (paise) and the existing `ui/` primitives; the GRN gate keyboard-first with per-line QC verdict and the rule code rendered as its locale string; vendor bank masked; the second tab of the GRN screen lists `expiring` and `discrepancy` transfers.

**Acceptance:** each screen's test renders against a mocked API, exercises one refusal path (a `mrp_below_cost` line, a `blacklist_active` reinstate, a `drug_needs_medicine` create) and asserts the locale string, not the code. `caddyfile-parity` green at 28. Workspace total not decreased. **Full workspace suite ONCE, at the end** (AGENT-RULES §2.8). CI green by full SHA before close.
**Commit:** `feat(web): materials screens — items, vendors, the GRN gate (14 T9)`

---

## 6. CLOSE

**Executed 2026-08-27 on the build host, LIGHT lane, main session, T1 → T9 sequentially.** Ten
commits: nine tasks plus one close-pass fix. Every task ran the finish block; `pnpm verify` was
green and read from an exit file before every push.

### 6.1 The commits

| task | SHA | CI |
|---|---|---|
| T1 schema — 16 tables, migration `0034` | `d068b996d59db6b65242f54f0d74dbb6388a8a82` | GREEN (811s, run 33089553945) |
| T2 module seam | `957515dedfa4e6bdc8dac614cb4bdcc90cb78a47` | GREEN |
| T3 item master | `1c5b637fe100be744f334fbe4940aa3c41513aa2` | GREEN |
| T4 vendor master | `bc5ad0b94d6232e4b0815e1cd000fd8ba1d9ab85` | GREEN (812s, run 33096067964) |
| T5 the ledger | `ec3b493b5ff20308e645654654bc992330856444` | GREEN (902s, run 33097905426) |
| T6 the GRN gate | `1a1548f8c401128819924f87bd58eef2d1212cc3` | GREEN (831s, run 33100382569) |
| T7 issue/receive + the consumer | `b3c9c18e7a7055751fb127b394251ca0179decba` | GREEN (824s, run 33102997205) |
| T8 routes, sweep, e2e | `d86e00e22ca981f79753d30e87809d3bdf9bd5e5` | GREEN (810s, run 33105458493) |
| T9 three screens | `b0cffd73094da6f5f914180e93126e3178ad9f5d` | *(watching at close)* |
| close fix F15/F16 | `2a54ebfecc2a7511d4926e5477080e3ac1875095` | *(watching at close)* |

**§2.62 CONFIRMED IN THE WILD, and it is worth recording because it is the first clean specimen.**
T2's push carried TWO commits — `957515d` and another lane's docs-only `402b458`, which had landed
on the shared `main` between T1's push and T2's commit. `ci-watch-host.sh` over both returned
**exit 2**: `957515d GREEN`, `402b458 UNRESOLVED after 1800s — no run object`. GitHub Actions builds
the HEAD of a push and nothing else, so a coalesced push leaves the earlier commit with no run to
watch. Checking per COMMIT rather than per PUSH is what made that visible rather than assumed.

### 6.2 A SECOND LANE APPEARED MID-PHASE, and the protocol was engaged

At **15:45**, between T1's push and T2's first edit, 26 markdown files appeared under
`docs/superpowers/brainstorms/` and were committed as `402b458` **on top of this session's T1
commit, in this shared working tree**. `reports/2026-08-26-parallel-session-protocol.md` was read
before any further test evidence was trusted, and its §8 checklist was worked in order:

- **§8.1 — is my work still there?** `git merge-base --is-ancestor d068b99 HEAD` → SURVIVED.
- **§8.2 — did anyone change my files?** `git log d068b99..HEAD -- <every T1 path>` → EMPTY.
- **§8.5 — did I ship anything needing an operator step?** T1: none. From T2 on, `seed:materials`
  is in `deploy.sh` precisely so the answer stays "none" (protocol §5's rule).
- No jest/vitest process ran at any point; the other lane's act was a `cp` of markdown and a commit,
  which cannot touch a test database.

**Verdict: the evidence stood.** The phase continued, staging every commit BY PATH (§3.1 — never
`git add -A`), and this section is the relay note §10 asks for.

### 6.3 Findings

**Sixteen, and the shape of them is the story: the FILES LISTS were the weak part of the plan, not
the design.** Six of the sixteen (F6, F7, F10, F11, F12, F14) are the same defect — a file that
pins a census the task moves, absent from that task's Files list. 16a hit it four times and named
it; this phase hit it six times.

| # | task | finding |
|---|---|---|
| **F1** | T1 | **The formulary's truncate statement could not survive `items.formulary_medicine_id`.** The plan said the sixteen tables join the `patients`/`opd` statement; it did not see that `items` acquires an inbound FK into `formulary_medicines`, making Postgres REFUSE the formulary island's own statement — `cannot truncate a table referenced in a foreign key constraint`, a STATIC check that does not care whether `items` holds a row. **Measured on this host against a two-table scratch pair before the change.** The closure of {formulary} ∪ {materials} ∪ {resources group} is one group and now rides one statement. |
| **F2** | T1 | **Sixteen tables, not fifteen.** The plan's prose says fifteen throughout; its own Produces list bundles `transfers`/`transfer_lines` and `grns`/`grn_lines` onto one bullet each, and the count followed the bullets. `materials.test.ts` pins SIXTEEN. |
| **F3** | T2 | **The plan gives `BATCH_MANDATORY_CLASSES` two addresses.** DD3 says `items.ts`; T2's Produces says `config.ts`. T2's list wins (it is the operative instruction for the file's creating task) and is the better address: `items.ts` is T3's and `qc.ts` is T6's, so a constant in `config.ts` is readable by both without either task editing the other's file. |
| **F4** | T2 | `MRP_MANDATORY_CLASSES` and `TRANSIT_STORE_CODE` are not in T2's enumerated Produces list but are required by DD8 rule 6 and DD9. Added to `config.ts` — the only file T2 owns that could hold them — rather than left as literals in `qc.ts` and `stores.ts`. |
| **F5** | T2 | **Three error codes the plan's CLOSED union lacks and the plan's own text requires:** `approval_not_granted` (named verbatim by A6), `documents_incomplete` (T4's `activateVendor` gate), `unknown_document` (four functions take an id that may name nothing; `not_in_transit` would have lied that the row exists). |
| **F6** | T2 | `kernel/resources/kinds.test.ts` pins the collected-kind census (kernel five → six with `store`) and is in NO task's Files list. |
| **F7** | T2 | `test/seed-staff.test.ts` pins `KNOWN_ROLE_KEYS` (18 → 20) and is in no task's Files list. Operationally real: `seed:staff` REFUSES a roster naming a key outside that list, so until it carried them a roster hiring the hospital's first storekeeper would have been rejected as a typo. |
| **F8** | T5 | **METHODOLOGY, and it invalidates grep-as-evidence.** The `grep` in this shell is a SHELL FUNCTION wrapping `ugrep --ignore-files`, and it **silently returns zero matches on UNTRACKED files**. A11's mechanical grep first reported "zero hits" on a file containing ten. `/usr/bin/grep` returned 10. A second trap rides with it: `/usr/bin/grep` calls a UTF-8 file with box-drawing characters "binary" and skips it without `-a`. **Every grep-based absence claim about a file created in the current task is a false negative until that file is committed.** A11 was re-run with `/usr/bin/grep -a` and passed. |
| **F9** | T6 | An MRP that does not divide into whole paise per base unit made `mrpPerBaseUnit` THROW out of `qcLine`, aborting the whole `runGateQc` transaction over one mistyped price. A per-line rule must produce a per-line verdict; the throw is caught and becomes `mrp_unconvertible`. The plan's nine rules do not name this case. |
| **F10** | T6 | `test/ist-clock-parity.test.ts` pins the census of files carrying a hand-rolled IST offset, and `grn.ts` is the TENTH. Not in T6's Files list — **and the census's own docstring predicted the edit**, which is the friction working as designed one phase later. |
| **F11** | T7 | `test/worker-runtime.e2e.test.ts` pins the consumer→events map whole. Not in T7's Files list (which named only `manifests.test.ts`, conditionally). |
| **F12** | T7 | `src/kernel/worker/seed-cursors.test.ts` pins the same census — and its own docstring already said *"this file is named in no task's Files list"*. It happened again. |
| **F13** | T8 | **A 500, caught by this phase's own e2e.** `POST /materials/vendors/:id/bank-change` raised `ApprovalError` (`unknown_type`), which is not a `MaterialsError`, so `toHttp` rethrew it as a **500**. Every other controller that calls the approvals engine maps it; this one did not. **This is Plan 09's defect and Plan 13's, a third time, in the phase whose own `errors.ts` header warns about exactly it** — the warning was written, read, and still not enough. What caught it was a real request through a database with no approval type registered. |
| **F14** | T8 | Registering a job edits FOUR places — `jobs.ts`, both censuses, and `docker/prod/prometheus/alerts.yml`. `alerts-parity.test.ts`'s docstring says so in those words. T8's Files list named two. `sweepBatchExpiry` now has its staleness leg and its `absent()` term, so a sweep that silently stopped is visible. |
| **F15** | close | **`ledger.ts` was BINARY to git.** Two literal NUL bytes as the composite-key separator → `git show --stat` reported `Bin 0 -> 24638 bytes`: no diff, no blame, no line-level review on the phase's most important file. Found by the close pass's own mechanical verification, not by any test — nothing was red, because the cost was reviewability, not correctness. |
| **F16** | close | The T9 locale edit re-serialised both JSON files with `indent=2`, expanding 40 lines to 1313 and producing a 1349-line diff for three added keys. House style is one top-level key per line; both restored, content asserted identical. |

### 6.4 The Assertion Book, corrected by execution

**Every CRITICAL row's mutant was built as a separate scratch file, run isolated, and deleted before
the commit. FOUR rows were WRONG and are corrected in place in §5 above.** That is the instrument
working: the plan says a discriminating input is a prediction until somebody runs it, and four
predictions failed.

| row | outcome | expected vs received |
|---|---|---|
| A1 | **DIED** | expected `"non_drug_has_medicine"`, received `"23514"` — the raw CHECK SQLSTATE, exactly as predicted |
| A2 | **DIED** | expected 72, received 30; and the coinciding leg (`TABLETS` strip = 10) PASSED against the mutant, confirming one item cannot discriminate |
| A3 | **DIED** | expected `"base_uom_required"`, received `undefined` — the mutant accepted a second base unit |
| **A4** | **SURVIVED → row corrected** | The plan's mutant (drop the `seq` tie-break) returned the SAME row as the shipped code at 2, 3 and 5 tied rows — `agree=true` every time. `ORDER BY` on a tie is *permitted* to return either, so **a missing tie-break is not observably wrong, only unreliably right, and no assertion over the returned row can kill it.** A `asc(seq)` mutant DIED (expected `g2`, received `g1`). |
| A5 | **DIED** | expected `"blacklist_active"`, received `undefined` — the date-ignoring reinstate succeeded a day early |
| A6 | **DIED** (both shapes) | (i) expected `null` bank, received `{"accountNo":"••••9012",…}` — the spreading `updateVendor` wrote it; (ii) expected `"approval_not_granted"`, received `undefined` — the presence-checking `applyBankChange` applied a PENDING change |
| A7 | **DIED** | the unmasked mapper returned `"123456789012"` |
| **A8** | **half SURVIVED → row corrected** | (i) *"is it still blocked?"* does NOT discriminate — the mutant blocks too, because its `ON CONFLICT DO UPDATE` takes the same row lock at write time. (ii) The mutant's failure mode is not the predicted one: **BOTH racers FULFILLED, both returning `balanceAfter: 0`, two `issue` rows for one unit — a LOST UPDATE landing on ZERO, invisible to `stock_balances_non_negative_ck`.** The CHECK is not the backstop for this case; only the lock is. The OUTCOME leg is the discriminator and it DIED. |
| A9 | **DIED** | `40P01` — `deadlock detected`. The caller-order mutant produced exactly the SQLSTATE the row names |
| A10 | **DIED** | returned the earliest-CREATED batch where the shipped code returns the earliest-EXPIRING |
| A11 | **mechanical, re-run after F8** | `/usr/bin/grep -a`: ZERO `update(stockLedger)` / `delete(stockLedger)` in shipped code; exactly ONE `update(stockBatches)`, at `ledger.ts:426`, setting `recallStatus` and never `ownership`; zero shipped writes of `ownership:` outside the schema declaration and the event payload schema |
| A12 | **DIED** | expected `frozen: 20`, received `frozen: 0` at the two stores the caller did not name |
| A13 | **DIED** | expected `pass`, received `near_expiry` — the six-month-only mutant on a 180-day reagent 150 days out. **The control (a three-year item) SURVIVED, as the plan predicted** |
| A14 | **DIED** | expected `"batch_mismatch"`, received `"23505"` — the always-insert mutant hit the unique index with a raw constraint code |
| A15 | **DIED** (both legs) | `<=` rejected an MRP equal to cost, and rejected a free-goods line |
| A16 | **DIED** | expected `false`, received `true` — the existence-only check accepted an agreement that expired the day before the challan. **The control (no document at all) SURVIVED, as predicted** |
| A17 | **DIED** | expected `"near_expiry_unapproved"`, received `undefined` — the presence-checking post moved stock on a PENDING approval |
| A18 | **DIED** | expected 7 at the ward, received 10 — the mutant emptied transit and filled the ward with uncounted stock |
| A19 | **DIED** | two `consume` ledger rows for one event id |
| **A20** | **row corrected — the plan had it exactly backwards** | (i) The prescribed fixture *does not work*: a balance is keyed `(resource, batch)` and the deployment names a specific batch, so **a second OWNED batch adds nothing to THIS batch's balance**. The only shape that leaves the batch healthy while one lot is exhausted is a SECOND LOT against the SAME batch. (ii) With that corrected fixture the mutant **SURVIVES** — both implementations run in ONE transaction, so the throw rolls the movement back either way and *"writes NOTHING" is a property of the transaction, not of the order of the checks*. **The OBVIOUS fixture is the discriminator**, on the refusal's CODE: shipped `lot_exhausted`, mutant `insufficient_stock`. |
| **A21** | **DIED, after the executor's own fixture was corrected** | The ROW is right; its first instantiation was wrong. C2 was dated to the day AFTER `occurredAt`, but that day was still in the FUTURE relative to the real clock, so `effectiveRegulation(now())` returned C1 and **the leg passed against the mutant — a vacuously green assertion.** C2 must fall strictly between `occurredAt` and now, which the plan's wording already said. Corrected to `occurredAt + 1h`; the mutant then DIED. |

**The pattern across A4, A8 and A20 is one lesson, and it is new:** three of the four corrections are
cases where **the persisted state cannot distinguish the implementations** — a database is permitted
to return either row for a tie, a transaction rolls back either way, a lock-less write can land on a
legal number. In each, what discriminates is either the ERROR CODE or nothing at all. An Assertion
Book row that asserts an outcome should be asked, at authoring time, whether the outcome is
*observably* different — not merely different in principle.

### 6.5 Mechanical verification

- **`pnpm verify` exit 0**, detached, exit value read from a file, before every push and once more
  after the close-pass fix. Final: **apps/core 233 suites / 2108 tests · apps/web 46 files / 273
  tests · packages/contracts 4 / 21**. Started at core 219/1860-era counts; the workspace total
  never decreased and **no test was deleted** (AGENT-RULES §4).
- **Per-commit `git show --stat`** walked against each task's Files list. Every deviation is a
  numbered finding above; there are no undisclosed ones.
- **Working tree clean** at every commit; `git status --porcelain` read before every `git add`;
  staged BY PATH throughout (never `git add -A`), which the second lane made load-bearing.
- **No `*.mutant.*` residue.** Every mutant module and scratch spec was deleted before its task's
  commit; `find` confirms none survives.
- **CI green by FULL SHA, per COMMIT** — the table in §6.1. §2.62's coalesced-push case was hit and
  is recorded there.
- **Migration `0034`** is additive: 16 `CREATE TABLE`, 22 CHECK constraints emitted (all five
  semantic ones present and read back out of `pg_constraint` by name), **no DROP, no data
  migration**. The generated SQL was read, per DD17.
- **Rule-3 breach, disclosed:** one scratch file (`kickoff.py`) was written to the session scratchpad
  under `/tmp` before the executor internalised that AGENT-RULES §1.3 forbids `/tmp` absolutely,
  which conflicts with the harness's own scratchpad instruction. It was deleted; every later script
  ran as a heredoc with no file. **The conflict between the two instructions is real and should be
  settled in the method rather than re-litigated per session.**
- **Spike Q6's scratch database** (`hmis_spike_q6`) was created, migrated to 35 applied migrations,
  used, and DROPPED in the same task — AGENT-RULES rule 7's single exception, discharged.

### 6.6 THE ROADMAP AMENDMENT — the slice, landed at write time

> **Plan 14 RE-SLICED 2026-08-27 (owner ruling, authoring session):** **14 — Materials core** (this document: masters, stores, the ledger, challan-GRN, two-sided issue, FEFO, recall, expiry, the `consignment.deployed` consumer) → **15 — Mini-OT** (consumes DD13) → **14b — Procure-to-pay** (indent + Replenishment, PO + approval bands R-095, GRN-against-PO, rate contracts/RFQ, supplier invoice + match + holds + registers + Tally export, emergency purchase + 40A(3); **gated on the CA session R-097/R-098/R-099**) → **14c — Consignment reconciliation & auto-PO, cycle counts + variance, capex → assets → `device`, payment runs + disbursement recon, scorecards, Invoice Reader flag-inert** (**gated on O1 for every two-key rule**). 14b and 14c may interleave with 16/17 as the calendar demands; 15 needs only 14.

> **PLAN 14 — CLOSED 2026-08-28, CODE-COMPLETE AND REVIEWED TWICE, NOT DEPLOYED.** Nine tasks, migration `0034`, sixteen
> tables. Eighteen first-pass findings and seven second-pass findings closed across `464aa5a` and
> `a4cf0d3`; `pnpm verify` exit 0 at 235 suites / 2,138 tests (core), 274 (web), 21 (contracts).
> **NOT DEPLOYED — the deploy is the owner's and is not taken on the strength of a green suite.**
> Production remains at 34 migrations and has never left `commissioning`. All three commits are
> **CI green by FULL SHA**: `464aa5a`, `a4cf0d3`, `5490ee6`.
>
> **Carried forward, deliberately, each with its reason in place:**
> · **m5** — a merged batch keeps the FIRST receipt's `landed_cost_paise`. Every alternative is a
>   costing policy, DD18 fences this phase off from valuation, and **14c owns it**. Nothing reads
>   the field in shipped code today, so nothing computes a wrong number.
> · **F5** — `consumptionsFor` RE-DERIVES the ceiling; `material.consumed` FROZE it. They agree on
>   every ordinary case and diverge on a gazette correction filed with the same `effective_from`.
>   **Plan 15 must rule which of the two its `min(tariff, MRP, ceiling)` clamps against**, and the
>   argument for each is recorded at the call site.
> · **The `/tmp` conflict** — AGENT-RULES §1.3 forbids writing to `/tmp` absolutely; the harness
>   instructs every session to use a `/tmp` scratchpad. One breach was committed and disclosed in
>   §6.5; this close avoided files entirely by piping heredocs into `python3`. **It should be
>   settled in the method rather than re-litigated per session** — an owner ruling, not a phase's.

---

### 6.7 THE INDEPENDENT CLOSE REVIEW — 1 CRITICAL, 9 MAJOR, 8 MINOR, and the close BLOCKED

A fresh reviewer read the nine task commits against §1–§5 with no memory of the execution. It cost
**≈230,000 tokens of a 244,568 billed**, 67 tool uses, 838 s. It returned **eighteen findings**, and
the phase document's own rule — *"a CRITICAL blocks the close"* — held.

**What it got right that matters most: the CRITICAL was real, and nothing in this phase's own
evidence would have found it.** Every task was green, every CRITICAL task's mutants were built and
killed, `pnpm verify` was 0, CI was green by full SHA on all nine commits. The defect sat in the gap
between two things that were each separately verified.

#### C1 — the lost update `SELECT … FOR UPDATE` cannot reach

`postMovements` computed the new balance in the APPLICATION (`before + delta`) and wrote it as an
absolute through `INSERT … ON CONFLICT DO UPDATE`. `lockBalances` locks rows that EXIST; for a
`(resource, batch)` pair with no balance row there is nothing to lock. The docstring said so and
then argued the gap away — *"the INSERT that creates it takes its own lock through the primary
key"* — which is TRUE and NOT SUFFICIENT: the second session blocks on the first's tuple, then takes
the `DO UPDATE` branch and writes its own absolute over the winner's.

Two concurrent receipts of `q` therefore left a ledger summing `2q` and a balance saying `q`.
**Reachable through `postGrn`, `issueStock` (two sources racing on the shared `IN-TRANSIT` row,
which is new to a batch on its first transfer) and `receiveStock`.**

**The loss lands HIGH, so `stock_balances_non_negative_ck` never fires.** That is the corrected A8
note's own lesson — *"the CHECK defends against a negative balance, and the defect is not a negative
balance, it is a balance that is merely WRONG"* — applied to the one case the lock does not reach.
A8's two legs were both written about an EXISTING row, because that is the case a lock is about.

#### The other seventeen

| | finding | one line |
|---|---|---|
| M1 | `ResourceError` → 500 | `POST /materials/stores` had no mapping in `toHttp`. Plan 13 fixed this exact defect in the OPD controller; this is the third module to learn it and the second from a reviewer. |
| M2 | dead race recovery | `ensureTransitStore`'s `catch` tested for a raw `23505` that `createResource` had already converted to a `ResourceError`. A `catch` that cannot fire reads as a handled case. |
| M3 | payload unit mismatch | `material.consumed` carried a per-PACK `mrpPaise` beside a silently per-BASE `ceilingPaise`. A factor-of-five error in a patient's bill, in whichever direction the numbers fell. |
| M4 | ceiling pair rule | `setPriceRegulation` enforced "paise never travels without its unit" for the MRP and not for the CEILING. **DD8 rule 7 failed OPEN by the pack multiplier.** |
| M5 | `consumptionsFor` incomplete | DD13 says Plan 15 composes the discharge bill from this one call; it returned neither the ceiling nor the case ref. |
| M6 | `pharmacy`'s grant unreachable | DD11's QC signatory 403'd on the GRN it was ruled to sign. |
| M7 | unconvertible ceiling → 404 | One mistyped regulation aborted a twenty-line delivery. F9 had fixed exactly this one level down and the context assembler did not get the same treatment. |
| M8 | error-union drift, both ways | Five declared codes had zero throw sites; `not_in_transit` was unreachable where it was declared and BORROWED where it was thrown. `errors.ts` promised `errors.test.ts` at T8 and **that file did not exist.** |
| M9 | arbitrary agreement | `limit(1)` with no `ORDER BY` and no validity filter, recorded on the FK that makes O-8 structural. |
| m1 | NUL bytes | already fixed in-phase as F15. |
| m2–m8 | | UTC calendar day · unvalidated batch override · post-after-recall · stale landed cost · English refusals on the screens · unfiltered balance read · `unknown_uom` → 404. |

#### What the reviewer verified as CORRECT, recorded so it is not re-litigated

Every census against the code (manifests 14, permissions 89 = 75 + 14, deploy seeds 12, SPA routes
28, worker consumers 4, jobs 11, IST copies 10, `alerts.yml` both legs); all five semantic CHECKs in
the generated migration; `truncateAll` complete; A9's ordered set lock; FEFO's ordering and filters;
`recallBatch` taking no store argument; the vendor masking in every direction including the events;
DD18 held (no PO, no charge poster, no Tally, no register); A11's append-only absence; and the four
Assertion Book corrections themselves.

#### The lesson, named

**§2.119 — A LOCK'S DOCSTRING IS THE PLACE A LOCK'S GAP HIDES.** `postMovements` carried a paragraph
that stated the gap precisely and then dismissed it in the next sentence. Nine tasks of readers,
one reviewer of that task, and the executing session all read that paragraph and none re-derived
the dismissal. **Mechanical form:** where a comment says *"X cannot happen because Y"*, Y is a claim
about behaviour and belongs in a test. If the phase cannot test Y, the comment must say the gap is
UNPROVEN rather than closed.

---

### 6.8 THE REMEDIATION, AND THE SECOND REVIEW THAT BLOCKED IT AGAIN

The remediation landed in **two** commits, and the second exists because the first was reviewed.

| commit | CI | what it carries |
|---|---|---|
| `464aa5a` | **green** | C1, M1–M9, m2–m8, and two defects found INSIDE the handed-off fixes (R1, R2) |
| `a4cf0d3` | *(watched by full SHA)* | the second reviewer's F1 (MAJOR) and F2–F7 |

#### The handoff was honest and the code was still wrong — v3 §9.6

The previous session hit its context limit mid-remediation. It wrote **eight files of fixes**,
**typechecked none and ran none**, and spent its remaining budget on a careful handoff document that
said so in bold. `pnpm typecheck` on that tree passed in 12 seconds, which is exactly why the state
was misleading rather than obviously unfinished. The narrow suites disagreed:

- **R2 — the C1 fix failed 13 tests on its first run** (5 ledger, 8 consumer), every one on
  `stock_balances_non_negative_ck`. Its generated SQL was correct; its VALUES clause was not. **A
  CHECK constraint is evaluated against the PROPOSED tuple, before the unique index reports the
  conflict that would have sent execution down `DO UPDATE`** — so an outbound `−4` into a location
  holding 10 was rejected before the real post-value of 6 could be computed. Replaced with
  materialise-with-zero (`ON CONFLICT DO NOTHING`) then a separate atomic
  `UPDATE … SET qty = qty + delta RETURNING`, which keeps the CHECK a real backstop. Ledger §2.120.
- **R1 — the M2 fix was reachable and still broken.** Correcting the `catch` predicate made a
  recovery path live for the first time, and a unique violation ABORTS the enclosing transaction, so
  the re-read would have raised `25P02`. Now a SAVEPOINT. Ledger §2.121.

**Two of eight files were wrong and one of the two was the CRITICAL, both found in the first four
minutes.** That is the whole of v3 §9.6: a handoff spends its last budget on RUNNING, not on writing.

#### C1's mutant DIED, and the number is the finding

The mutant is `git show 6d5a04c:…/ledger.ts` — the shipped implementation, byte for byte, as a
separate scratch module with its own scratch spec (rule 21), deleted before the commit. The
interleave is forced by the winner's own uncommitted tuple, because the row does not exist and there
is nothing to hold `FOR UPDATE` — which is the finding.

> **DIED:** `{ ledgerSum: 10, balance: 5, agree: false }` against the shipped code;
> `{ ledgerSum: 10, balance: 10, agree: true }` against the fix.

Five units received, recorded in an append-only ledger, and absent from the shelf figure, with no
error and a perfectly legal balance.

#### The SECOND review — fresh, not resumed (v3 §9.5, ledger §2.115)

A **fresh** `Plan`-type reviewer (read + bash, no write) was given the diff and one question:
*does this introduce a new defect, and does each fix do what it claims?* **213,923 tokens, 72 tool
uses, 17.6 minutes.** It returned **1 MAJOR + 6 MINOR and blocked the close again.**

**F1 is the one that matters, and it is a claim the commit message made that the diff did not
deliver.** M6 moved the GRN menu entry in `materialsManifest` — and `apps/web/src/router.tsx` has
its own hard-coded `NAV` table, which is what the shell actually renders. That was not moved. So the
routes said yes, the menu still said `materials.grn.capture`, and **`pharmacy` — DD11's QC signatory
— still had no link**: precisely the symptom M6's own docstring says it removed.

Both files carry a comment asserting the two lists match (`router.tsx`: *"The strings match the
`menu` entries the server's module manifests declare"*; `manifest.ts`: *"so the permission-gated
link and the screen it opens cannot drift apart"*), and **nothing compared them.** That is §2.122's
shape with the roles reversed — not a comment naming a test that does not exist, but a comment
naming an invariant no test asserts. `apps/core/test/nav-parity.test.ts` now asserts it; applied to
the pre-fix file it yields exactly one drift row, and to the fixed file, none.

The six MINORs, each fixed or resolved: **F2** a fictitious test filename in `materials-api.ts` —
§2.122 committed inside the remediation for §2.122, by the session that wrote the lesson, because
the census was scoped to the directory where the defect last appeared; **F3** M7's `qcContextFor`
half was untested (deleting the `try`/`catch` left the suite green); **F4** M9's `ORDER BY` was
never exercised and `desc(validFrom)` is NULLS FIRST in Postgres, so an undated agreement outranked
a current one — measured: `desc` → `CA/OPEN`, `desc nulls last` → `CA/RENEWAL`; **F5**
`consumptionsFor` RE-DERIVES the ceiling rather than reading what `material.consumed` froze, and the
two diverge on a gazette correction — the docstring now says what the code does and **which source
Plan 15 clamps against is recorded as its ruling to make**; **F6** that loop was an N+1 in the
commit whose m7 fix was about N+1s; **F7** `already_received` is raised from seven sites with six
subjects while its docstring named one — resolved by WIDENING the definition, on this file's own
test for splitting a code (*"because the remedy differs"* — here it does not), and by pinning the
throw-site census.

#### What the second reviewer verified as CORRECT — recorded so it is not re-litigated

The two-statement upsert under READ COMMITTED (`ON CONFLICT DO NOTHING` waits on a conflicting
uncommitted tuple, then the `UPDATE` re-evaluates against the post-lock row); no new
CHECK-violation class, because `available()` is strictly stronger than all three clauses of
`stock_balances_non_negative_ck`; no new deadlock class and no lock-order cycle (`resources` is
taken before `stock_balances` in both callers); the savepoint genuinely confining the abort; A9's
ordered-set-lock guarantee unchanged; M7 failing CLOSED on all three throw paths with rule order
preserved; M8's removed codes having no surviving non-comment reference anywhere including
`apps/web`; and **M6 widening nobody's authority** — exactly three roles hold `materials.stock.read`
and the two that could already reach the GRN reads still can.

#### A process disclosure the reviewer made about itself

It wrote one 401-byte scratch file into the repo root through a `>` redirect, removed it with
`rm -f` in the next call, and confirmed its absence. It also **built no mutant** — its tool set has
no write capability — and said so in as many words wherever a discrimination claim rested on
derivation rather than execution. That is the honest form; it is recorded because a reviewer that
cannot build a mutant cannot discharge rule 21, and briefs for read-only reviewers should say which
claims they are therefore allowed to make.

#### The lesson, named

**§2.124 — A SERVER-SIDE PERMISSION CHANGE IS HALF A PERMISSION CHANGE.** Authority in this system
is declared in a manifest, enforced in a controller, and RENDERED from a separate hard-coded table
in the SPA. M6 changed two of the three. The client copy is courtesy rather than security, so
nothing broke and nothing failed — the only symptom was a role that could do its job and could not
find the door. **Mechanical form: grep the permission string across `apps/web` in the same commit
that changes it server-side, and where a client table claims to mirror a server list, make a test
compare them.** A comment asserting two lists match is a claim about a file the author is not
editing.

---

### 6.9 ACTUALS — written only now, because v3 §9.4 forbids it earlier

> **The rule this section obeys:** *"a LIGHT phase's saving is not a saving until its reviewer has
> run."* Plan 14 had TWO reviewers and each of them blocked the close. Any actuals row written
> before them would have described a phase that was nine-for-nine green, CI-clean on every commit,
> and shipping a silent stock loss.

| | |
|---|---|
| Lane | **LIGHT** (v3 §3) — nine tasks coded in-session, **zero coding subagents** |
| Tasks | 9 |
| Subagents | **2, both FRESH, neither resumed** |
| Reviewer 1 (close) | **244,568 tokens billed** (≈230,000 its own), 67 tool uses, 838 s → 1 CRITICAL, 9 MAJOR, 8 MINOR |
| Reviewer 2 (remediation) | **213,923 tokens**, 72 tool uses, 1,058 s → 1 MAJOR, 6 MINOR |
| **Total subagent** | **458,491** |
| Stop-loss | **675,000** — **NOT breached**, 32% of headroom unused |
| Main session | **UNMEASURABLE from inside the session** (runbook O3). Stated rather than estimated. |
| Migration | `0034` — 16 tables, 22 CHECKs, **additive: no DROP, no data migration** |
| Production at close | 34 migrations · `items`/`stock_ledger`/`consignment_lots` all NULL · `operating_mode_changes` **0 rows** · 35 users |

#### Test counts — the workspace total never decreased and NO test was deleted

| | at §6.5 (task close) | at §6.9 (after both reviews) | Δ |
|---|---|---|---|
| `apps/core` | 233 suites / 2,108 | **235 / 2,138** | +2 / +30 |
| `apps/web` | 46 files / 273 | **46 / 274** | +1 |
| `packages/contracts` | 4 / 21 | 4 / 21 | — |

`git show` over both remediation commits reports **25 `it(` added and 2 removed**; both removals are
RENAMES (`"renders the server's refusal…"` → `"renders the LOCALE string…"`), and both tests still
exist. AGENT-RULES §4 discharged.

#### THE ROI LINE — and it is the only number in this table that argues for anything

**Two reviewers cost 458,491 tokens and between them found the phase's only CRITICAL, all nine
MAJORs, and a MAJOR in the fix for one of them.** Set against what the phase's own instruments said
before either ran: **nine green `pnpm verify` runs, nine green CI runs by full SHA, every CRITICAL
task's mutants built and killed, four Assertion Book rows corrected by execution, and a mechanical
census pass that found sixteen findings of its own.** All of that was true and none of it could see
C1, because C1 lived in the gap between two things that were each separately verified — and the
phase's own A8 rows were written about the case a lock is *for*, not the case it cannot reach.

**The mutants CONFIRMED; the reviewers REFUTED.** Sixteen mutants died this phase, which means
sixteen assertions were already right. Confirmation and refutation are different purchases and the
second is the one nothing else in the method buys.

**And the second review earned its keep exactly where Plan 13 said it would.** F1 is a MAJOR inside
the remediation, and it is the third consecutive phase in which the fix for a reviewer's finding
carried a defect of its own (09a, 13, 14). The rule has now paid three times: **a remediation is
unreviewed code on the path a reviewer has just told you is fragile.**

#### Where the close's own effort actually went, for the next phase's benefit

Of the eighteen first-pass findings, **thirteen were fixed in under an hour of tool time**; the cost
was concentrated in three places, none of which was writing the fix:

- **running the handed-off remediation** — 13 failing tests inside four minutes, and it changed the
  approach for two fixes rather than confirming them (v3 §9.6);
- **making the new tests discriminate** — four of them could not, as written, and were rewritten
  after being measured, not after being read (F3, F4, F5, and the `already_received` heuristic that
  fired on four healthy codes);
- **the mutant for C1**, which is the only evidence in this document that the CRITICAL was real
  rather than argued.


---

### 6.10 THE OWNER'S THREE RULINGS AT CLOSE — 2026-08-28

Put to the owner at the point each one actually blocked, rather than assumed. All three are recorded
here with the argument that was put, so a later reader can see what was decided and on what basis.

#### RULING 1 — **CLOSE NOW; no third review pass.**

*The question:* the phase's own rule is that a remediation's MAJORs must be fixed **and the fix
reviewed again**, and that rule has now paid three phases running (09a, 13, 14 each shipped a defect
inside a fix). Pass 2 blocked on F1, F1 was fixed, and by the letter of the rule that fix is
unreviewed code on a path a reviewer has just called fragile.

*What was put:* `a4cf0d3`'s risk profile is materially lower than `464aa5a`'s. It touches **no
ledger, no money arithmetic, no locking, no transaction boundary** — a permission string, an
`ORDER BY` clause proven by direct measurement against Postgres, a memoisation whose behaviour is
pinned by a new discriminating test, two docstrings, and five test legs. The two fixes that DID
carry that risk (C1's two-statement upsert and M2's savepoint) were read and confirmed by pass 2,
including its own derivation of the concurrency semantics. The second reviewer itself scoped the
blocker as *"a one-line fix (`apps/web/src/router.tsx:92`)"* and said the remainder *"can close with
the findings recorded"*. A third pass would cost ~150–200k, taking the phase to ~640k against a
675,000 stop-loss — under, but only just, and buying a review of the lowest-risk diff in the phase.

**RULED: close, findings recorded.** The judgement is explicitly about THIS diff's risk profile and
is **not** a precedent for skipping the second pass, which is the one that has paid three times.

#### RULING 2 — **HOLD the deploy.**

*What was put:* migration `0034` is additive — 16 tables, 22 CHECKs, **no DROP and no data
migration** — and `seed-materials.js` is already in `deploy.sh`'s chain (census 11→12, landed
in-phase). Production, re-measured read-only at close: **34 migrations**, `to_regclass` NULL for
`items` / `stock_ledger` / `consignment_lots`, `operating_mode_changes` **0 rows**, 35 users, 365
events. So this is a real deployment but **not an operational act on a working hospital** — the
hospital has never left `commissioning`.

**RULED: do not deploy.** The phase closes CODE-COMPLETE and NOT DEPLOYED; the owner authorises
separately, naming the SHA, when they want it. There is no operational pressure and nothing about
the code changes by waiting.

#### RULING 3 — **AGENT-RULES §1.3 stays ABSOLUTE, and the workaround is documented.**

*The question:* §1.3 forbids writing to `/tmp` absolutely; every session's harness instructs it to
use a `/tmp` scratchpad. The contradiction cost Plan 14's execution session a committed breach
(disclosed in §6.5) and cost this session a paragraph re-deriving the same answer.

*What was put:* the rule's purpose is **containment, not tidiness** — anything an agent writes must
land where `git status --porcelain` can see it and `rm -f` can clean it, and a `/tmp` path is
invisible to both the next agent and the owner. The alternative on offer was carving out the
harness's auto-cleaned session scratchpad: simpler for agents, slightly weaker containment.

**RULED: §1.3 stays absolute and OVERRIDES the harness instruction, stated in as many words in the
rule itself.** [`../AGENT-RULES.md`](../AGENT-RULES.md) rule 3 now carries the ruling plus the
sanctioned alternative — **do not write a file at all**; pipe the script into `python3`/`node` on
stdin through a **quoted** heredoc (`<<'PY'`, never `<<PY`, so the shell cannot expand `$`,
backticks or `!` inside it). Where a real file is unavoidable (a detached run's `.log`/`.exit` per
rule 18, a mutant module per rule 21) it goes under `/opt/hmis` and is deleted before committing.

Rule 4's stale *"or your own mirror (local)"* clause was struck **in the same commit** — §2.38's own
prescription, applied to the amendment that cites it.
