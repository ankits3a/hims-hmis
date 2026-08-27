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
| **A4** | `effectiveRegulation(itemId, at)` returns the row with the LATEST `effective_from ≤ at`, ties broken by `seq` DESC (the `regulated_prices` rule). | A query ordered by `effective_from` only. | **Two rows with the SAME `effective_from` and different ceilings, inserted in order; ask at that instant.** The mutant returns either; the shipped code returns the second by `seq`. Two rows with different dates do not discriminate. |

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
| **A8** | Two concurrent outbound movements against one balance of 1 serialise: exactly one succeeds, the other throws `insufficient_stock`, and `qty_on_hand` ends at 0, never −1. | A `postMovement` that reads the balance, checks, then updates without `for update`. | **Two transactions on two connections, both reading before either writes, orchestrated with a barrier** — `ledger.concurrency.test.ts`, the `versions.contention.test.ts` shape, **with a budget of ≥ 20s and the timing assertion written so an idle host cannot pass it by luck** (09a's race test sat 9s inside a 15s budget; §2.99). Against the mutant both commit (the CHECK then fails one at COMMIT with a constraint name, or, if the CHECK were missing, the balance goes negative); the shipped code refuses the second with a code. **Sequential calls do not discriminate.** |
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
| **A20** | A deployment exceeding the lot's remaining quantity is refused `lot_exhausted` and writes NOTHING — no ledger row, no `qty_deployed` change. | A consumer that posts the movement before checking the lot. | **A lot with `received 1, deployed 1`, deploy 1 more.** The mutant's `postMovement` may itself refuse (`insufficient_stock`) IF the balance is also exhausted — **so the fixture must hold balance ≥ 1 by receiving a second, OWNED batch of the same item into the same store** so only the LOT check can refuse. Named because the obvious fixture cannot discriminate. |
| **A21** | `material.consumed` carries the regulation EFFECTIVE AT `occurredAt`, not at processing time. | A consumer that calls `effectiveRegulation(itemId, now())`. | **Two regulation rows, one effective before `occurredAt` with ceiling C1, one effective after `occurredAt` but before now with ceiling C2.** Shipped: C1. Mutant: C2. One regulation row does not discriminate. |

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

## 6. CLOSE — appended as the phase runs

*(empty at write time; v3 §1.5. Findings as they arrive, the mechanical-verification evidence, the actuals row — NOT before §3.4's reviewer has returned (v3 §9.4) — the lessons bound for the ledger, the ARCHIVE pass, the token audit, and the roadmap amendment.)*

### 6.6 THE ROADMAP AMENDMENT — the slice, landed at write time

> **Plan 14 RE-SLICED 2026-08-27 (owner ruling, authoring session):** **14 — Materials core** (this document: masters, stores, the ledger, challan-GRN, two-sided issue, FEFO, recall, expiry, the `consignment.deployed` consumer) → **15 — Mini-OT** (consumes DD13) → **14b — Procure-to-pay** (indent + Replenishment, PO + approval bands R-095, GRN-against-PO, rate contracts/RFQ, supplier invoice + match + holds + registers + Tally export, emergency purchase + 40A(3); **gated on the CA session R-097/R-098/R-099**) → **14c — Consignment reconciliation & auto-PO, cycle counts + variance, capex → assets → `device`, payment runs + disbursement recon, scorecards, Invoice Reader flag-inert** (**gated on O1 for every two-key rule**). 14b and 14c may interleave with 16/17 as the calendar demands; 15 needs only 14.
