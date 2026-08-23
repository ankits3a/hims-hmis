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
| fix | `766cade` | `test(core): the census walks every interval instant too — the two jobs R0-2 left in the tail` | GREEN 8m05s a1 |

Every task passed on its **first rung**. The wave-stall break never fired. Two commits are not in the
plan's table and both are accounted for: `74dea4d` is T2's own line-ending correction, landed as a
NEW commit rather than an amend (rule 15 honoured — see §7.5), and `766cade` is my remediation of
the CI red (§3a).

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

## 3. CI — every commit green by FULL SHA except one, and that one was real

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

**Fix (`766cade`):** the walk now stops at **every** instant where anything fires — the five daily
instants plus every interval multiple inside the span, merged and de-duplicated — and settles fully
at each; only a daily instant still needs its due window crossed tick by tick. CI **GREEN on attempt
1**.

**The honest limit, and it is the spike's own caveat vindicated:** the build host reproduces this
failure in **no** shape. Spike §A.7 measured shipped and stepwise both **10/10 green under
`taskset -c 0`**, and predicted in as many words that CI would be the only confirmation available.
It was. A green full suite on the box proves the fix breaks nothing; only CI can show it fixes
anything, and one green run is one data point.

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
The diff is correct; only the message tail is missing.

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
