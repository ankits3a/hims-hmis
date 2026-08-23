# Plan 11c — Gate report: the operating-mode spine shipped, and the alert path is built but not delivering

**Run 2026-08-23 by the compile/execute session.** Spike (1 agent) + Phase 0 (2 commits, 1 agent) +
a six-task pipeline (`wf_fe17b268-6fa`, 15 agents) + one main-session remediation + independent
verification. Plan:
[`../2026-08-23-phase1-11c-operating-modes-downtime-kit.md`](../2026-08-23-phase1-11c-operating-modes-downtime-kit.md) ·
spike: [`plan-11c-spike-report.md`](plan-11c-spike-report.md) ·
inbox: [`plan-11c-findings-inbox.md`](plan-11c-findings-inbox.md).

> **The headline, stated first because a gate report that buries it is advertising.** All six tasks
> shipped, all fifteen Assertion Book mutants died on their own assertions, and the workspace grew
> 962 → 1049 core tests with nothing deleted. **The alert path this plan exists for is NOT
> delivering:** `deploy.sh` was never run, so Alertmanager is not running in production, and flags
> ④ and ⑤ are **UNDISCHARGED**. Two causes, both recorded below: the owner deferred the SMTP
> credential, and the deploy was independently blocked by a safety classifier and by the owner's own
> `Bash(docker compose -f docker/prod/*)` deny rule. **The discovery reviewer then found four
> MAJORs, three of them measured**, and one of those — MAJOR 4 — means that *even if the deploy had
> run*, every `ops.*` route on the live system would answer 403 to every user, because nothing in
> the repository can grant the three new permissions. **Plan 11c is SHIPPED AS CODE and NOT LIVE.**

---

## 1. What shipped

| | commit | subject (exact, from the plan's table) | CI |
|---|---|---|---|
| R0-1 | `0439682` | `fix(core): strip X-Powered-By — the one-line close the T3 gate offered and T6 left open` | GREEN 8m41s a1 |
| R0-2 | `7bfdd3a` | `test(core): the L14 census advances to each daily instant — the 16% flake fixed by shape, measured by the spike` | GREEN 7m52s a1 |
| T1 | `e757f20` | `feat(core): migration 0017 and the operating-mode service — commissioning until proven, downtime declared loudly` | GREEN 6m42s a1 |
| T2 | `2e41d17` | `feat(core): validate:config — one D-17 gate over every validator, and the commissioning exit reads it` | GREEN 8m13s a1 |
| — | `74dea4d` | `style(core): LF line endings on the three T2 files a Windows-side rewrite had turned CRLF` | GREEN 8m00s a1 |
| T3 | `827f464` | `feat(core): interface heartbeats — the staleness sweep as the tenth job, down and restored evented` | GREEN 7m58s a1 |
| T4 | `b819054` | `feat(core): the downtime kit — serial ranges under a single-winner counter, a signed QR on every form` | GREEN 8m07s a1 |
| T5 | `5ae8ec8` | `feat(web): the mode banner, the mode desk, and the printable downtime kit` | GREEN 8m20s a1 |
| T6 | `e81219d` | `feat(infra): Alertmanager to the owner's inbox — critical reaches a human, and the restore drill is watched` | **RED 8m01s a1** → §3a |
| fix 1 | `766cade` | `test(core): the census walks every interval instant too — the two jobs R0-2 left in the tail` | GREEN 8m05s a1 — **but see §3a: this fix DID NOT WORK** |
| gate report | `de668ad` | `docs(reports): Plan 11c gate report …` | **RED 8m03s a1** — the same census, on a four-markdown-file diff |
| fix 2 | `7e38b28` | `test(core): the census waits on the CONDITION, not on a turn count — my last fix was wrong` | see §3a |

Every task passed on its **first rung**. The wave-stall break never fired. Two commits are not in the
plan's table and both are accounted for: `74dea4d` is T2's own line-ending correction, landed as a
NEW commit rather than an amend (rule 15 honoured — see §7.5), and `766cade`/`7e38b28` are my two
remediations of the CI red — **the first of which did not work** (§3a).

## 2. Independent main-session verification

- **Detached `pnpm verify` at HEAD, exit VALUE read from a file: `0`.** `apps/core` **144 suites /
  1049 tests** · `apps/web` **34 / 173** · `packages/contracts` **3 / 7**. **Zero FAIL lines.**
  Baseline into the pipeline was 138/962 · 31/152 · 3/7, so the workspace grew by **87 core tests and
  21 web tests** and nothing decreased.
- **Per-commit `git show --stat` against Files lists, BOTH directions: clean on all six.** T1 14
  files (12 list entries; `drizzle/` expands to the migration, its snapshot and the journal), T2 9,
  T3 12, T4 5, T5 10, T6 8. **No commit touched a path its Files list did not name.**
- **Frozen-path audit over the whole range: 52 files changed, ZERO outside the union of the Files
  lists.** GC13's list — dispatcher, notify pump/gauntlet, retention sweep,
  `modules/billing|tariff|patients|opd`, `caddyfile-parity`, the dev compose, `.github/workflows` —
  **untouched, verified by grep.**
- **Server tree clean.** The only untracked path was the findings inbox, which this report commits.
- **Container and volume roster, read and compared against rule 7:** **9 containers** (8 `hmis-prod-*`
  + `hmis-db-1` **Up 11 days** — the dev database, never stopped, rebuilt or pruned) and **7 volumes**,
  all declared. **No stray container, no anonymous volume, and no blanket prune was ever run.** The
  roster is byte-identical to the pre-pipeline roster because **nothing was deployed** (§5).
- **`pnpm-lock.yaml` untouched across the entire range.** GC1 held; no task needed a dependency.

## 3. CI — every commit green by FULL SHA except TWO, and neither was a flake

Every duration above is minutes with a non-empty 12-step job — **none of these is §2.59's third
state**, and every commit has a run object (§2.62 stayed closed: strictly sequential waves, one push
each).

### 3a. The T6 red was NOT a flake, and the Pipeline Notes' clause is what caught it

`e81219d` failed the L14 census with `Expected -2 / Received +0`: **`runNotifyPump` and
`sweepExpiredTempRoles` missing from the invoked set**, every other job including the new tenth
present. T6's diff is YAML, shell and Markdown and cannot reach that test, so by §2.64 this was a
re-run candidate. **The plan's own instruction overrode that** — *"a post-R0-2 census red is a
REGRESSION SIGNAL, not a flake to re-run past"* — and investigating found a real defect **that R0-2
introduced**.

Across the old 25-hour sweep the 8 h notify pump fired three times and the 9 h temp-roles sweep
twice, so a firing whose real heartbeat write had not settled before `stop()` was covered by a later
one. Inside R0-2's new **9 h 05 m** span each fires **exactly once** — both inside the tail `walkTo`,
which settled `WALK_SETTLE_TURNS = 10` real turns where a daily instant gets 50 — and temp-roles
fires **five fake minutes** before the span ends. **The span reduction removed the redundancy that
had been hiding an unsettled write.** It is the identical queue-starvation mechanism R0-2 fixed for
daily jobs, relocated to the interval jobs at the tail.

**First fix (`766cade`) — AND IT DID NOT WORK. Corrected in place rather than left standing.** It
made the walk stop at every instant where anything fires and settle fully at each. CI went green on
attempt 1, **and I reported the defect fixed on that single run.** That was wrong. The very next
commit — `de668ad`, four markdown files, incapable of reaching a test — came back **red with the
identical signature**: `runNotifyPump` and `sweepExpiredTempRoles` missing. One green run against a
roughly one-in-four failure rate is what luck looks like, and I read it as confirmation while this
very report said "one green run is one data point".

**The real defect was the INSTRUMENT, not the placement (`7e38b28`).** A fixed turn count buys ~50 ms
of real time regardless of load. R0-2's comment argues the opposite — *"on a starved container each
turn takes LONGER, so the same count buys proportionally more real time"* — and **that is false when
what you are waiting on is one database round-trip's latency rather than accumulated event-loop
work.** The measurement is decisive: this census takes **37.6 s on CI against 2.9 s on the build
host**. `settleUntil(done, maxTurns)` now yields real turns **until every job has actually been
invoked**, bounded at 20 000. It costs one turn when the work is already done (suite time unchanged
at ~2.9 s locally) and as many as the machine needs when it is not; it cannot hang the suite, and it
cannot make a broken census pass because the assertion after it is untouched.

**What is NOT claimed:** that the flake is fixed. The build host reproduces this failure in **no**
shape — spike §A.7 measured shipped and stepwise both 10/10 green under `taskset -c 0` and predicted
CI would be the only available confirmation. I did **not** manufacture starvation with CPU load,
because production serves a live hospital on that box. **The honest bar is several consecutive green
runs across commits touching unrelated files, and it has not been met.** This is a better instrument
with an argument behind it, not a proven fix.

## 4. The Assertion Book — every row, with its verdict

| # | task | verdict | evidence |
|---|---|---|---|
| R1 | R0-1 | **DIED** | Disable reverted in a scratch copy beside the source. `expect(received).toBeUndefined()` / `Received: "Express"`. Fail-first genuinely discharged: the assertion was red against unmodified shipped code first, quoted. |
| R2 | R0-2 | **MEASUREMENT — 30/30 (spike) + 10/10 in-run**, isolation quoted from output both times. Runtime **parity** (median 2735 ms vs shipped 2717 ms), not the reduction the brief predicted; daily ticks −63.7 %. **Superseded in part by §3a.** |
| V1 | T1 | **DIED** | `"commissioning"→"normal"`. `Expected: "commissioning"` / `Received: "normal"`. |
| V2 | T1 | **DIED** | Gate deleted. `- "code": "golive_gate_unsatisfied", - "detail": "no_report"` / `+ "resolvedTo": "normal"`. Three refusal fixtures plus the fresh-ok control. |
| V3 | T1 | **DIED** | Initial-only rule dropped. `- "code": "mode_commissioning_is_initial_only"` / `+ "resolvedTo": "commissioning"`. |
| V4 | T1 | **DIED** | Note check dropped. `- "code": "mode_note_required"` / `+ "resolvedTo": "downtime"`. `ramp` without a note allowed — the control. |
| V5 (**P**) | T1 | **DIED** | `desc(seq)→desc(id)`. `Expected: "degraded"` / `Received: "downtime"`. **The input was engineered and T1 said so**: three rows whose id order inverts seq order with `at` shuffled independently of both, so that five wrong orderings each give a different answer; a second test puts two rows on one identical `at`, where only `seq` can separate them. |
| V6 | T1 | **DIED** | Consumer branch deleted. `["first: resolved","second: resolved"]` / `["first: threw ZodError","second: threw ZodError"]` — **the compile-time finding about the escalation fallthrough, confirmed by execution.** Control: `ramp→normal` raises nothing. Needed a second pass because the first kill was an *unhandled* ZodError escaping the test rather than an assertion failure; T1 widened its scratch spec rather than accept it (rule 21's exact standard). |
| V7 | T2 | **DIED** | Tariff leg hardcoded ok. `expect(report.ok).toBe(false)` / `Received: true`, tariff scope red in the persisted row, script exit 1. |
| V8 (**P**) | T2 | **DIED** | Guard consults any ok row. Older `ok=true` then newer `ok=false` → refused; mutant allowed. |
| V9–V12 | T3 | **ALL FOUR DIED**, run isolated | Staleness predicate, `unknown` inclusion, the restore flip, and V12's cadence take-effect (GC10, the `NOTIFY_STUCK_AFTER_MS` scar one surface over). |
| V13 (**P**) | T4 | **DIED** | Counter row lock dropped → overlap observed and quoted, round 0. Measured race: **15 × 5 concurrent generations**, all ranges pairwise disjoint every round. |
| V14 | T4 | **DIED** | Off-by-one the advance. Expected `[1, 10, 11, 16]` / received `[2, 11, 12, 17]`. |
| V15 | T4 | **DIED** | Verify ignores the signature. `expect(received).toBeNull()` / received the parsed triple. Untampered control asserted first. |

**Fifteen required-DIED rows, fifteen kills, zero survivors, zero silent fixes.** (R1 died in
Phase 0, making sixteen against the plan's stated count — the plan's arithmetic counted R1 inside the
pipeline; the pipeline carried fifteen. Re-derived before the run, as §2.68 requires.)

**T6 owns no Book row and built three mutants anyway** — `> 691200` widened, `> 691200` → `> 0`
(caught only by the negative control), and `== 1` → `>= 0` — all three **DIED**. That is the
practice EXECUTE-METHOD §4 credits, done unprompted.

## 5. Verify-by-execution flags

| flag | owner | status |
|---|---|---|
| ① `pnpm validate:config` proven BOTH ways | T2 | **DISCHARGED** — all-green run exit 0 with per-scope lines; forced-failure run exit 1. |
| ② the boot line names TEN jobs; parity green at 10 | T3 | **DISCHARGED** |
| ③ the kit payload rendered under `.print-doc` | T4/T5 | **DISCHARGED as far as code goes; real paper is owner UAT and T4 said so plainly.** See MINOR 7 — the reviewer predicts what that UAT will find. |
| ④ `deploy.sh` re-run, step 6b reports 9/9 services | T6 | **UNDISCHARGED — the deploy was never run.** §5a. |
| ⑤ synthetic critical alert → SMTP notify → owner's inbox | T6 | **UNDISCHARGED, both halves.** §5a. |
| ⑥ `promtool test rules` over `alerts-backup.yml`, both directions | T6 → **ME** | **DISCHARGED, AND RE-RUN BY ME** (§5b). |
| ⑦ the mode route enforces the SPECIFIC permission | T2 | **DISCHARGED for `ops.mode.set`** — granted actor 201, same actor without it 403 with the guard's own message. **But see MAJOR 2: `ops.interface.manage` got no such leg and a mutant SURVIVED.** |
| coexistence (ruling 2, inherited from 11a) | **ME** | **DISCHARGED BY ME** (§5c). |

### 5a. Why ④ and ⑤ are undischarged, stated plainly

**The deploy did not happen, and production is untouched.** Three independent facts, each sufficient
on its own:

1. **`/opt/hmis-prod/.env.smtp` exists (created by the owner mid-run, `-rw------- root root`, 600)
   with five of six keys set and `SMTP_PASSWORD` EMPTY** (`len=0`, confirmed by reading key names and
   emptiness only, never values). T6 measured exactly this, **halted, and fabricated nothing** — no
   credential invented, no derivation stubbed, no placeholder that would let the deploy pass. That
   is precisely what its brief demanded and it is the right outcome.
2. **Two T6 coder rungs were blocked by a safety classifier**, on the grounds that the deploy mutates
   a live production system and the user's own messages had not named that operation. The third rung
   completed *because it halted on the prerequisite first.*
3. **The owner's settings carry a `Bash(docker compose -f docker/prod/*)` deny rule**, which
   `deploy.sh` invokes directly.

The owner subsequently **authorized the deploy explicitly**, then **deferred the SMTP credential**
("skip the gmail and email part for now"). So the authorization exists and the credential does not.
**Nothing about the alert path is claimed to work, because none of it has been observed to work.**

### 5b. Flag ⑥ — discharged by me, not taken on T6's word

```
Unit Testing:  /rules/.mygate.test.yml
  SUCCESS
TEST RULES EXIT VALUE = 0
```

My own test file, not T6's: **leg 1** drives `hmis_backup_last_drill_pass_age_seconds=800000` and
`hmis_backup_last_drill_failed_after_pass=1` and asserts both rules fire with exact labels and
annotations; **leg 2 is the negative control** — healthy input (100000 s ≈ 27 h, flag 0) asserts
`exp_alerts: []` for both. Worth recording: my **first** run FAILED, on `1w 2d 6h 13m 20s` versus the
`9d 6h 13m 20s` promtool actually renders. That was my error, not the rules' — and it demonstrates
the assertion discriminates on exact annotation text rather than merely on firing. `promtool check
rules` separately: `SUCCESS: 2 rules found`, exit 0.

### 5c. Coexistence — ruling 2's acceptance, and nobody else may certify it

Dev `pnpm verify` run **concurrently with the full `hmis-prod` stack up**: exit VALUE `0`, zero FAIL
lines. Measured in the same window: prod `/health` over HTTPS returned **200**, the roster held at
**9 containers / 7 volumes**, and dev `hmis-db-1` was **Up 11 days** — different container, different
volume, different port, untouched. **Contention was not observable in the result.**

## 6. The discovery reviewer — four MAJORs, three measured

Again the best-value agent in the run.

### MAJOR 1 — the mode ledger takes no lock; two concurrent declarations both win. **MEASURED**

`mode.ts:127` reads the current mode with a plain `SELECT` and `:144` appends, with nothing
serialising the pair. Under READ COMMITTED all four refusals — including `mode_unchanged`, whose own
comment says it exists so `downtime → downtime` cannot re-alert every owner — are check-then-act with
no guard. Executed, 15 rounds per case: **A** two concurrent identical `normal → downtime` →
**14/15 appended TWO rows and TWO events**; **B** concurrent `→ downtime` and `→ degraded` →
**15/15 both succeeded, and `current=degraded` in all fifteen** — *the duty manager who declared
downtime got a 201 and the banner says degraded*; **C** two concurrent go-live exits → **15/15 left
two commissioning-exit rows.** A double-click on T5's mode desk is enough.

**This is §2.75's shape inside one plan:** T4's counter got a single-winner `UPDATE … RETURNING`, an
ordered lock and a 15 × 5 measured race; T3's sweep got conditional updates with a header paragraph
explaining why. **The mode ledger — the one surface whose wrong answer is shown to the whole
hospital — got neither, and the Book has no concurrency row for it.** Fix named:
`pg_advisory_xact_lock` as the first statement of `changeOperatingMode`; a `FOR UPDATE` will not do,
because the zero-row commissioning case is exactly the one that must serialise.

### MAJOR 2 — `ops.interface.manage` is bound to its routes by nothing a test can see. **MUTANT SURVIVED, WITH A CONTROL THAT DIED**

Both interface routes are only ever driven by an actor holding all three permissions. Mutant (the two
interface decorators repointed to `OPS_MODE_SET`, a real declared permission): **6 suites, 71 tests,
all green — SURVIVED.** Control (the *kit* decorators repointed the same way): **DIED** with
`Expected "missing permission ops.downtime.generate"` / `Received "missing permission ops.mode.set"`.
The harness discriminates; the interface routes are simply not covered. **§3.42 was applied to two of
the three permissions and not the third** — and it is the one that decides when a human is woken up.

### MAJOR 3 — nothing watches the alert path this plan just made the single point of failure

D11's own header states the principle — *"a drill that silently stopped running looked exactly like a
drill that was passing: both are silence"* — and the plan then builds Prometheus → Alertmanager →
SMTP → inbox in which **every failure mode is that same silence**. Alertmanager is **not a scrape
target**, so `up{job="alertmanager"}` and `alertmanager_notifications_failed_total` do not exist, and
no rule touches `prometheus_notifications_errors_total`. A rotated app password, a bouncing mailbox,
a crash-looping alertmanager after a passing deploy — all indistinguishable from a quiet night. Fix
named: one scrape job plus two rules, `promtool`-provable, `docker/prod/` only.

### MAJOR 4 — nothing in the repository can grant the three new `ops.*` permissions

`syncPermissions` mirrors permission NAMES at boot and **grants nothing to any role**. Grants come
from `grantPermissionToRole`, whose one non-test caller is `scripts/seed-admin.ts:32` — unreachable on
any deployment that already has an admin user, and even on a virgin one it installs `authManifest`
alone, six `auth.*` strings. There is no HTTP surface. **`README.md:703-704` asserts the gate is
already satisfied — "the seeded `admin` role holds every manifest permission in dev" — and against
`seed-admin.ts` that sentence is false as written.**

**This is the finding that most justifies not having deployed.** Had `deploy.sh` run, every `ops.*`
route on `hmis.crkmch.com` would 403 for every user, and the mode-desk and downtime-kit nav links
would lead to screens whose every action is refused. Fix named: a `seed:ops` script in the shape of
`seed-billing`, plus a README correction.

### MINORs

- **5 — a heartbeat landing between the sweep's read and its update is overwritten by a false
  `interface.down`. MEASURED 14/15.** The conditional update re-checks only `status`, not
  `last_seen_at`. MINOR *today* only because `interface.down` has no alert subscription — it is
  **dormant-then-armed**: Plan 11b puts real printers on this seam. One-line fix.
- **6 — nothing pins `prometheus.yml`'s `rule_files` against the rule files that exist** or against
  `deploy.sh`'s install list. §3.34's shape; `deploy.sh`'s own comment is doing a test's job.
- **7 — `.print-doc` is a single-page rule and the kit is the first multi-page consumer. UNBUILT —
  the reviewer states it as a prediction, with no mutant**, because it is print-engine behaviour a
  jsdom test cannot see. It names what flag ③'s owner UAT will find.
- **8 — three smaller things:** a README sentence promising an interface list that has no screen; a
  75 000-form theoretical bound on one kit response; and the findings inbox being untracked — **this
  report commits it.**

**What the reviewer checked and found sound**, recorded because it is evidence too: the census dance
is complete and non-vacuous (parsers throw rather than return `[]`, and that is itself tested); the
`:317` subscription pairs are pinned whole and T1's event lands there; `truncateAll` covers all six
tables in three statements with the §3.35/§3.12 reasoning transcribed and an executed test that the
sequences restart; `deploy.sh` installs `alerts-backup.yml`, dies with the shape printed on a missing
`.env.smtp`, and adds alertmanager to the §2.77 restart loop; the compose service gets the named
volume the spike required; `verifyKitSerial` verifies the MAC before trusting any field.

## 7. Findings of my own

### 7.1 The compile-time sweep paid for itself, four times

Four HALT-class defects were found before a single brief was written, each folded into a brief as a
pre-diagnosed instruction rather than left to cost a rung:

1. **R0-1's assertion had no home.** `health.e2e.test.ts` called `createNestApplication()` and never
   called `configureApp`, so the header-absent assertion would have gone red against a *correct*
   fix. Resolved inside the existing Files list by adopting the convention its eight sibling suites
   already carry.
2. **No shipped fixture could make D5's aggregate green.** `seedBillingBase` seeds one of four
   `DISCOUNT_CATEGORIES` and sets `caSigned: false`; the tariff suite's own helper is file-local and
   does the same. Without the three extra caps and `caSigned: true`, T4's e2e chain was unreachable
   — §3.36's class exactly.
3. **T1's actor columns had to be plain text**, or §3.12/§3.35 would have forced the six new tables
   into the existing users-group truncate statement and made the plan's "three added statements"
   description and a green suite jointly unsatisfiable.
4. **T3's `alerts-parity` edit was three changes, not the plan's "count pin"**, and its `alerts.yml`
   edit four places, not two.

### 7.2 A compile-time census expires — and so do LINE NUMBERS (§2.73, extended)

§2.73 says re-run the greps after Phase 0. I did: **3 `JobIntervals` literals at `7bfdd3a`**,
unchanged. But R0-2 also **moved every line in `scheduler.test.ts`** — `THE_NINE` 140→168,
`CENSUS_INTERVALS` 223→251, `CENSUS_DAILY_TICK_MS` 261→289, M-S2 304→460 — so every line reference
the plan cites for that file went stale in the same commit. T3's brief was told to navigate that file
**by symbol, never by the plan's line numbers**. `worker-runtime.e2e.test.ts` was unaffected and its
`:100`/`:317`/`:366` stayed exact. **New ledger entry §2.78.**

### 7.3 My own transcription defect, caught by the agent I gave it to

T2's brief transcribed `validateBillingConfig` as *"It throws `billing_not_configured` if the
`billing_config` 'main' row is missing."* **It does not throw** — it catches and returns
`{ok: false, errors: […]}`. T2 measured this, disclosed it in the inbox, and noted that believing the
brief would have led it to wrap the billing leg in a redundant try/catch. Cost: zero. This is the
agents-report-plan-defects behaviour EXECUTE-METHOD §6 says not to touch, working exactly as intended
— against *my* error this time.

### 7.4 The pre-flight's negative controls all fired

Module parse (planted duplicate declaration, broken string literal), marker assertions (rules pointer
stripped → reported), the **wave-stall break** (T3's gate forced to reject three times → stalled at
T3 with T4/T5/T6 never dispatched and no discovery run), and **§2.54 both directions** — into which I
planted Plan 08.5's actual defect, dropping `alerts-parity.test.ts` from T3's array, and watched the
checker catch it. §2.22 is satisfied: no probe here is one nobody has watched fail.

### 7.5 CRLF is a live hazard in the mirror workflow, and it cost one commit

T2's Windows-side authoring turned three files CRLF, which shipped as a 717-insertion/717-deletion
whole-file rewrite and needed the correction commit `74dea4d`. R0-2 hit the same trap and caught it
before committing, by byte-inspecting with `od -c` after `git apply` silently rewrote line endings.
**Both handled correctly — a new commit, never an amend** — but two agents hitting one trap is a
pattern. **New ledger entry §2.79.**

### 7.6 My own commit message was truncated, and the amend was correctly blocked

`766cade`'s message lost its final sentence and both trailers to a nested-heredoc quoting failure.
The commit was unpushed, so amending would not have violated rule 15 — but the classifier blocked
`git commit --amend` anyway, and **that block was right**: rule 15's whole principle is that
corrections land as new commits. I pushed as-is and recorded it here rather than fighting the denial.
The diff is correct; only the message tail is missing. **The second remediation `7e38b28` was committed from a scp'd message FILE instead — the same §2.79 quoting family, hit a third time in one run, and the fix is to stop using nested heredocs over ssh at all.**

### 7.7 A residual I am not fixing, disclosed

`/opt/hmis/apps/core/dist/` on the build host carries a stale `app.bootstrap.d.ts` predating R0-1.
It is gitignored and cannot shadow the suite (jest's `testMatch` covers `src`/`test` only), and
production runs from the image rather than that directory — but `start:prod` would run stale bytes.
Outside every Files list, so booked rather than fixed.

## 8. What this run cost

**2,486,408 subagent tokens for the pipeline against a ≤3.0M target — 0.83×, under budget.** 15
agents, 1,001 tool uses, 4 h 35 m wall clock. Outside that target: the **spike 172,007** (against an
~80k target with an honest range to 200k — inside the range) and **Phase 0 249,371** across one
agent's two items (103,345 + 146,026), against a 150–250 k prediction. **Total ≈ 2.91M.**

The §2.68 arithmetic was re-derived before the run and it held: the pipeline carried **fifteen**
required-DIED mutants, not the plan's stated sixteen (R1 sits in Phase 0), plus one measured race and
three drills across 13 planned agents. Two extra agents were spent on the T6 rungs the classifier
blocked. Where the money went, honestly: this plan is **mutant-shaped like Plan 10** (2.64M for 13
agents / 20 mutants) and **far lighter on drills than 11a** (3.34M) — and the drill it was lightest
on is precisely the one that did not happen.

## 9. Residuals — what is true, and what is not finished

**Live and verified:** nothing new. Production is exactly as Plan 11a left it — `hmis-prod` on
`https://hmis.crkmch.com`, 8 services, WAL archiving to R2, dev stack untouched and green beside it.

**Shipped as code, not live:**
1. **MAJOR 4 — no mechanism grants the three `ops.*` permissions.** Until a `seed:ops` exists, the
   whole ops surface 403s on the live system. **Fix this before deploying, not after.**
2. **MAJOR 1 — the mode ledger race.** Measured 14/15 and 15/15. The declared downtime can lose to a
   concurrent degraded.
3. **MAJOR 2 — `ops.interface.manage` unpinned**, mutant survived.
4. **MAJOR 3 — nothing watches the alert path itself.**
5. **Flags ④ and ⑤ UNDISCHARGED** — the deploy never ran; `SMTP_PASSWORD` is empty and the owner
   deferred it.
6. **MINOR 5** (heartbeat/sweep race, dormant-then-armed for 11b) · **MINOR 6** (`rule_files`
   unpinned) · **MINOR 7** (the multi-page print prediction) · **MINOR 8** · **§7.7** (stale `dist/`).

**Owner actions still open, in the order I would do them:**
1. **The escrow ceremony — `SECRET_KEY` + the pgBackRest cipher passphrase.** Unchanged since 11a's
   §9, still the most urgent thing on this list, and it is not a code task: **until it happens every
   backup in R2 is one disk failure away from permanent ciphertext, including to the owner.**
2. The Gmail app password into `/opt/hmis-prod/.env.smtp`, when the alert path is wanted.
3. Counsel bundle · DPIA + inference locus (blocks 12a) · WhatsApp BSP onboarding · E-11 boundary map
   · E-1 · internal auditor · **the R2-endpoint masking reminder, delivered again.**

## 10. Status

**Plan 11c is SHIPPED AS CODE with four MAJOR residuals and two undischarged flags, and it is NOT
LIVE.** The operating-mode spine, the D-17 aggregate, the interface-heartbeat seam, the downtime kit
and the web surfaces all exist, are tested, and are green on CI. The alert path is built and
delivering nothing.

**The single sentence that matters most:** this plan set out to decide whether anyone finds out when
production breaks at 03:00, and **as of this report, nobody would** — not because the code is wrong,
but because it was never deployed and, had it been, nobody could have logged in to act on it
(MAJOR 4). That is the honest state, and the fix list above is short and named.

---

## ADDENDUM 2026-08-23 (afternoon) — the two owner-action blockers are CLEARED, and the escrow debt is PAID

Written by the plan-writing/owner-ops session, on the owner's explicit authorization ("do the
needful related to escrow ceremony and those six keys"), after this report was committed. **The
body above is left exactly as written** — the 11a discipline. This addendum says what changed.

### §9 owner action 1 — the escrow ceremony was PERFORMED 2026-08-23

Open since 11a's §9; closed today. The shape, so a future reader can trust it: a ceremony script
(`/root/hmis-escrow-ceremony.sh`, kept for rotations) assembled the continuity kit **in process
memory only** — `SECRET_KEY` and the pgBackRest repo cipher passphrase (the two irreplaceables),
the five R2 values, the SMTP credential, and a one-paragraph recovery procedure — and encrypted
it with AES-256-CBC/PBKDF2 (600k iterations) under a passphrase **typed by the owner on a TTY**:
it appears in no transcript, no log, no memory file, and is held by the owner (password manager +
paper instructed). The script's fail-path was proven before the real run (FATAL on an empty
source key, rc=1, before any prompt).

**The bundle:** `hmis-escrow-2026-08-23.enc` — on the box at `/root/` AND fetched to the
owner's out-of-git escrow directory (`C:\Users\ankit\hmis-context\escrow\`), **hashes matching
byte for byte on both sides**. ~~One known staleness: sealed BEFORE the SMTP account correction
below (1552 B, sha256 `3bbb3f3b0c2b…b418dae2`)~~ — **RESOLVED the same afternoon: the owner
re-ran the ceremony after the correction; the current bundle is 1536 bytes, sha256
`55287b847e5c2daa96967ec15d1002b6f62e4dbcc53bc4ddef09b8b8727fc958`, re-fetched and re-matched.**
Still owed by the owner, disclosed: a second off-machine copy (cloud/USB — from the CURRENT
bundle), and the decrypt-verify hash confirmation.

### §9 owner action 2 / §5a blocker 1 — the SMTP credential is IN PLACE and VALIDATED end to end

`SMTP_PASSWORD` is no longer empty. The first credential FAILED validation — `curl` exit 67
`Login denied` under both AUTH=PLAIN and AUTH=LOGIN, stopped after two attempts deliberately —
and the cause was an account mismatch: the app password was minted on **`ankit.sa3@gmail.com`**,
not the address the file named. `SMTP_USER`/`ALERT_EMAIL_FROM`/`ALERT_EMAIL_TO` were corrected
to the minting account (owner-supplied), and a **real message was then accepted by Gmail from
the box, credentials sourced server-side** (`SMTP send OK`; TLS 1.3 on 587 — which also
re-confirms the spike's question B on the live path). A validation failing first and passing
after a NAMED correction is worth more than one that passed immediately.

**Flags ④ and ⑤ remain UNDISCHARGED and this addendum does not claim otherwise:** Alertmanager
still does not exist in production, and only the deploy discharges them. What changed is that
the SMTP→inbox leg of ⑤ is now proven with the production credential — the remaining leg is
Alertmanager itself firing through it.

### §9 residual 1 / MAJOR 4 — closed after this report, by `90c0e6c`

`seed:ops` and the README correction landed (commit verified to exist and to state exactly
MAJOR 4's mechanism; its behaviour is the deploying session's to verify). The deploy checklist
above therefore reads: `seed:ops` as a deploy step · MAJORs 1–3 unchanged · the deny-rule/
classifier gate on the production deploy unchanged.

---

## ADDENDUM 2 — 2026-08-23 (evening): THE DEPLOY RAN. 11c IS LIVE. Flag ④ discharged, ⑤ half-discharged, and one more §2.77 specimen found by deploying.

Written by the deploying session on the owner's explicit authorization, naming the operation:
*"run the deploy, I authorize the docker compose operation."* **The body above and ADDENDUM 1 are
left exactly as written.** This says what changed.

### The deploy — flag ④ DISCHARGED

`deploy.sh` from the checkout at `90c0e6c`, run **detached with the exit VALUE read from a file**
(rule 18 — a dropped link mid-deploy destroys the evidence). **Exit VALUE `0`.**

```
==> 6b/8 every declared service is up
    all 9 declared services running: alertmanager db api node-exporter postgres-exporter
                                     prometheus grafana worker caddy
==> 8/8 /health through Caddy over HTTPS
    site hostname hmis.crkmch.com
    HTTP 200 {"status":"ok","db":"ok","worker":"ok"}
==> hmis-prod is up: https://hmis.crkmch.com
```

**Rule 7 roster, read and compared before and after:** 9 containers → **10** (the 9 `hmis-prod`
services + dev `hmis-db-1`), volumes 7 → **8**. The single new volume is
**`hmis-prod_alertmanager_data`**, the NAMED volume the spike required, confirmed by `docker
inspect` to be what `/alertmanager` mounts. **Zero anonymous volumes** — gate report §7.8's exact
specimen, avoided. **`hmis-db-1` Up 11 days throughout**, and the `hmis-prod` db service was not
recreated (its image is unchanged by this plan).

### Flag ⑤ — the machine half is PROVEN; the inbox half is the owner's to confirm

Alertmanager `/-/ready` and `/-/healthy` both **200** on loopback. `amtool config routes test
severity=critical` → **`owner-immediate`**. A synthetic `severity: critical` alert
(`HmisDeployDrill`) was fired via `amtool` and Alertmanager itself reports it matched that
receiver (`"receivers": ["owner-immediate"]`, state `active`).

**The evidence is the counters, not the log** — the spike measured that Alertmanager REDACTS the
receiver URL in its notify log, so the log cannot be the proof:

| metric | before | after |
|---|---|---|
| `alertmanager_notifications_total{integration="email"}` | 0 | **1** |
| `alertmanager_notifications_failed_total{...}` (all five reasons) | 0 | **0** |

One email notification was delivered to the SMTP server and **nothing failed**. No notify error
appears in the log for the window.

**Flag ⑤ IS THEREFORE HALF-DISCHARGED AND SAYS SO.** What is proven: Alertmanager accepted the
alert, routed it correctly, and handed it to Gmail without error. What is NOT proven by anything
in this report: that the message arrived in a human's inbox. **The owner's receipt ack remains
OUTSTANDING**, exactly as the plan requires it to be recorded when it cannot be obtained during
the run.

**No secret entered git.** The derived `/opt/hmis-prod/alertmanager/alertmanager.yml` uses
`smtp_auth_password_file` and never carries the password inline; both derived files are `600`; and
the committed template `docker/prod/alertmanager/alertmanager.yml.tpl` greps to **zero**
real-looking values. GC2 held.

### MAJOR 4's fix, verified IN PRODUCTION — and it proves the defect was real there

ADDENDUM 1 correctly left `seed:ops`'s *behaviour* to this session. Run against the production
database through the shipped image (`compose run --rm api node dist/scripts/seed-ops.js`):

```
role "duty_manager": CREATED
role "owner": CREATED
granted 3 ops permissions to "duty_manager"
granted 3 ops permissions to "admin"
duty_manager holders: 0
owner holders:        0
!! NOT READY
```

**Both roles were CREATED, not "already present" — so on the live system neither role existed and
MAJOR 4 was real there, not merely a reading of the code.** The grants landed. The script then
refused to report READY because **no human holds either role**, which is the honest state: until
the owner names duty managers, every `/ops` route still answers 403, and a downtime declaration
would still alert nobody. **That assignment is an owner action and is the last step to a usable
ops surface.**

### NEW FINDING, MAJOR — §2.77's THIRD specimen, and D11's watcher was INERT after a clean deploy

**Found by deploying, which is the only way this class is ever found.** After the first successful
deploy, `hmis_backup_last_drill_pass_age_seconds` had **NO SERIES** — so `HmisBackupDrillOverdue`
could never fire and **the backup-drill watcher D11 exists to provide was inert.** That is the
precise silence D11's own header says it was written to abolish, reproduced by the plan that wrote
it.

Cause: T6 added `alertmanager` to the config-at-startup restart loop and cited §2.77 for it — and
omitted **`postgres-exporter`, whose config THIS SAME PLAN also changed** (D11's query goes into
`postgres-exporter/queries.yml`). That process parses `queries.yml` once at startup, and
`compose up -d` does not recreate a service whose definition is unchanged. Measured: the file was
correct on disk, correct **inside** the container (the mount is a directory; `grep` found the query
there), and not being served.

Restarting the exporter made both series appear at once — **age `36781 s` (~10.2 h, so the weekly
drill IS passing) and `failed_after_pass 0`**. Fixed at the root in **`ea4da87`**, which puts the
service in the loop, and **the rule is written beside it: every service whose config directory step
2 installs must appear in this loop** — not "remember postgres-exporter", because this is the third
specimen after grafana and prometheus and the pattern kept being rediscovered per service. `caddy`
stays out deliberately; it gets an explicit reload, which is stronger.

**Re-verified by running the whole deploy again** (it is designed to be idempotent): exit VALUE 0,
all four services report *"restarted so it re-reads"*, 9/9 running, `/health` 200 over HTTPS.

### Live monitoring state, measured after the second deploy

- Prometheus → Alertmanager link **ACTIVE** (`http://alertmanager:9093/api/v2/alerts`), **zero
  dropped**.
- **Five rules loaded across two files**: `HmisSchedulerJobStaleInterval`,
  `HmisSchedulerJobStaleDaily`, `HmisSchedulerJobMissing` · `HmisBackupDrillOverdue`,
  `HmisBackupDrillFailed`.
- **10 `hmis_scheduler_heartbeat_staleness_seconds` series — the TENTH job live in production**,
  which is flag ② confirmed on the real box rather than in a test.
- **Zero alerts firing.** A healthy system, and now one that can say so.

### CLOSED THE SAME EVENING — flag ⑤ is FULLY DISCHARGED and the ops surface is USABLE

**Flag ⑤ — DISCHARGED IN FULL.** The owner confirmed receipt of the `HmisDeployDrill` message in
their inbox (2026-08-23, in conversation). Both halves are now evidenced: the machine half by
Alertmanager's own counters (0 → 1 delivered, all five failure counters 0) and the human half by
the owner's ack. **A `severity: critical` alert raised on this box reaches a human being.** That is
the sentence this entire plan existed to be able to write, and it is now true.

**The role assignment — done, and the ops surface is READY.** `seed:ops` re-run against production
with `OPS_DUTY_MANAGERS=admin OPS_OWNERS=admin`; the deployment has exactly one user (`admin`).
Exit **VALUE 0** read from a file. A second re-run reported `already held` for both roles and
`READY` again — **idempotence proven on the live system, not merely in the drill.**

```
duty_manager holders: 1
owner holders:        1
READY: duty managers can declare downtime and generate kits; owners will be alerted.
```

Verified at the level the `PermissionGuard` actually reads — the `users → role_assignments →
role_permissions` join, not the script's own report:

| username | role_key | scope_type | permission |
|---|---|---|---|
| admin | admin | hospital | ops.downtime.generate · ops.interface.manage · ops.mode.set |
| admin | duty_manager | hospital | ops.downtime.generate · ops.interface.manage · ops.mode.set |

`owner` carries **no** `ops.*` permission, exactly as designed — map 1's rule is that the owner is
alerted and never required to act, and the role exists so `usersHoldingRole(owner)` has somewhere
to land.

**One honest note on the shape of this deployment:** `admin` is the only user, so it now holds the
declaring authority, the kit authority and the alert-recipient role simultaneously. That is correct
for a single-operator UAT box and it is **not** the go-live shape — D2's separation (duty managers
declare, the owner is alerted and does not act) only becomes real when there are distinct humans.
Re-run `seed:ops` with the real names when staff accounts exist; it is idempotent and additive.

### What is STILL open after this addendum

1. ~~**Flag ⑤'s inbox ack**~~ — **DISCHARGED**, see above.
2. ~~**Nobody holds `duty_manager` or `owner`**~~ — **DONE**, see above. The separation-of-duty
   shape remains a go-live task, not a defect.
3. **MAJORs 1, 2 and 3 are UNCHANGED and none is fixed** — the mode-ledger race (measured 14/15),
   `ops.interface.manage` unpinned (mutant survived), and nothing watching the alert path itself.
   MAJOR 3 is now *more* pointed, not less: the alert path is live, so its silent failure modes are
   live too.
4. **The L14 census fix (`7e38b28`) is NOT confirmed** — §2.80's bar is several consecutive greens
   across commits touching unrelated files, and it has not been met.
