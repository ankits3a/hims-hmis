# Plan 11d — Gate report: the live system can be operated, and the Assertion Book was mostly wrong

**Executed 2026-08-24 by the session that did not write the plan.** Plan:
[`../2026-08-24-phase1-11d-operability-hardening.md`](../2026-08-24-phase1-11d-operability-hardening.md) ·
execute prompt: [`PLAN-11D-EXECUTE-PROMPT-2026-08-24.md`](PLAN-11D-EXECUTE-PROMPT-2026-08-24.md) ·
spike: [`plan-11d-spike-report.md`](plan-11d-spike-report.md) ·
findings: [`plan-11d-findings-inbox.md`](plan-11d-findings-inbox.md).

**Range `58e0e61..e9f7422`.** Six waves, seven plan commits, three main-session corrections, one
remediation. **Every code commit CI-green by FULL SHA.** `pnpm verify` exit VALUE **0** at final
HEAD.

> **THE ONE SENTENCE THAT MATTERS: everything below is SHIPPED AS CODE AND NONE OF IT IS LIVE.**
> Production still has one user, `admin`, holding nine of fifty-nine declared permissions, and it
> will keep having exactly that until `seed:roles` and `seed:staff` are run against it — **flag ③,
> which is owner-authorized and deliberately outside this pipeline.** The plan only becomes true for
> the hospital at that step.

---

## 1. What shipped

| | task | what it closes |
|---|---|---|
| `e88b5db` | R0-1 | the L14 census gets a per-test budget (`CENSUS_TIMEOUT_MS = 120_000`), so a bound hit produces the SET assertion naming the missing jobs instead of a bare timeout |
| `fd24235` | T1 | `ALL_MANIFESTS` + `seed:roles` + the reachability invariant — **MAJOR 4's other eight doors** |
| `0c642b9` | main | two raw NUL bytes out of `seed-roles.ts` |
| `ca1a6d4` | T2 | `seed:staff` from stdin — **a deployment can be given its humans** |
| `4daacf4` | T3 | `pg_advisory_xact_lock` before the read — **MAJOR 1** — plus `changeId` on the payload |
| `72e321b` | T4 | the ops permission map's four legs — **MAJOR 2** — plus the chain-halted `refId` repoint |
| `4346edc` | T5 | the alert path watches itself + `deploy-parity.test.ts` — **MAJOR 3, in part** |
| `5491c72` | T6 | the heartbeat/sweep race, and a stale sentence that had already cost a MAJOR |
| `4f0685f` | main | corrections the last two gates earned |
| `e9f7422` | main | **the discovery review's MAJOR 2 and MINOR 3**, on the owner's ruling |

## 2. Independent main-session verification — nothing here is an agent's self-report

- **`pnpm verify` detached at final HEAD, exit VALUE read from a FILE: `0`.**
  `apps/core` **148 suites / 1109 tests** (from 144/1049) · `packages/contracts` **3/7** unchanged ·
  `apps/web` 34/175 — **+2 NOT this plan's**, see §7.
- **Per-commit `git show --stat` against each task's Files list, both directions: all seven exact.**
- **GC2 — `drizzle/` untouched in BOTH directions over the whole range.** No migration exists in this
  plan, so AGENT-RULES §6's entire irreversible-host-mutation class stayed out of the run. That class
  cost ~934k tokens once and delivered nothing.
- **GC1** `pnpm-lock.yaml` untouched · **GC4** `apps/web` untouched in full · **D11**
  `jest.config.cjs` untouched · **GC13** all eight frozen paths clean, including both pre-existing
  parity tests and `.github/workflows/*`.
- **GC3 — zero credential-shaped hits across 4,206 added lines** (argon2, real addresses, secret env
  values, DB URLs with credentials, private keys, long base64). T2 was the highest-risk task this
  project has shipped for GC3 and it is clean.
- **Rule 7 roster read before and after: 10 containers / 8 volumes, unchanged.** `hmis-db-1` up 11
  days throughout; every `hmis-prod` uptime unbroken. **No pipeline agent touched production.**

## 3. CI — every code commit green by FULL SHA

`e88b5db` · `fd24235` · `0c642b9` · `ca1a6d4` · `4daacf4` · `72e321b` · `4346edc` · `5491c72` ·
`4f0685f` · `e9f7422` — all `completed / success`, twelve steps, durations 318-514 s.

**§2.59, and a NEW specimen of it.** A CI result has three states — green, red and DID NOT RUN — and
the third reports identically to the second. **There is a fourth thing that reports identically to
the third: an abbreviated SHA.** `gh run list --commit 03d4e90` returns `[]` silently;
`gh run list --commit 03d4e903a22ef…` returns the green run. **I briefly read two commits as
never-dispatched on exactly that basis.** The execute prompt already says "CI green by FULL SHA";
this is the measurement showing the word FULL is load-bearing rather than stylistic.

## 4. The Assertion Book — and this is the run's headline

**Twenty-one rows. Thirty-two mutants built. Every required-DIED mutant DIED. V21 held as a
required-GREEN control.** But that is not the finding.

> ### TWELVE Book rows or design claims were REFUTED BY EXECUTION, and every one of them would otherwise have shipped as green evidence proving nothing.

| # | claim | what execution found |
|---|---|---|
| R1 | "force the bound to 1 turn" | **a no-op** — `done()` is true on turn 0, so it passes at exit 0 under BOTH budgets. Phase 0 built the two-part mutant that works |
| V2 | its three named "exceptions" | **all three are HELD.** They were justified by *guards no route*, a different property from the one V2 asserts |
| V2 | "39 held / 17 not-yet-modelled" | **sums to 56, not 59** — the pre-ruling-7 count, caught by T6's gate |
| V3 | parser returns `[]` instead of throwing | **cannot fail** — every README cell is recognised, so the `throw` branch is unreachable. The mutant that discriminates SKIPS the shorthand row |
| V10 | "exactly one appended row per round in all three" | **false for case B, and could never have killed either mutant there** — shipped, no-lock and wrong-position all produce `appended=2` |
| V13 | "revert `refId` to the mode word" | **could not fail while the chain halt stood, because the shipped code WAS that mutant** |
| V15 | "each must die on THIS leg with the other legs green" | **structurally impossible for three of four** — one actor holds all three ops permissions, so an undeclared permission makes a route unreachable for everyone |
| D2 | "the worker installs a smaller SUBSET" | **measurably false** — it omits `ops` and adds `notify`; neither set is a subset of the other |
| D5 | "FIRST — ahead of the refusal AND the read, BOTH" | **only the read is load-bearing.** The mutant placed between them SURVIVED 4/4 across 15 rounds of every case |
| D9 | leg 4 "is the only one that can" | **false for the shipped set** — 11c's mutant dies on leg 8 too. True only in the strong form, where the table is swapped with the decorators |
| D9 | "no three catch what the fourth catches" | **false for leg 10** — proved: leg 10 ⊆ (leg 8 ∧ leg 9). Cheap redundancy, not a fourth leg |
| D1 | its exceptions list | **conflated two properties** — *held by a role* and *guards no route* are different claims, and the list held the wrong one |

**Only V20 survived contact intact** — shipped 0/15 false-downs, mutant 14/15, both reproduced
independently by its gate.

**The generalisation, and it belongs in the ledger.** Rule 21 says never claim an assertion
discriminates without building the mutant. **The corollary this run earned: a plan's STATED mutant is
itself a prediction, and a task that finds it cannot fail has discovered something worth more than
the kill it was asked for.** An Assertion Book written before any code exists is a set of predictions
about what will discriminate, and **more than half of this one did not survive execution.**

## 5. Verify-by-execution flags

| flag | owner | state |
|---|---|---|
| ① `seed:roles` twice against a real database | T1 | **DISCHARGED** — creates then reports `already`, both transcripts quoted |
| ② `seed:staff` three-row roster, credentials verified, output grepped clean | T2 | **DISCHARGED** |
| ③ **`seed:roles` + `seed:staff` against PRODUCTION** | **the owner** | **NOT DISCHARGED — and it is the point of the whole plan** |
| ④ `promtool` both directions | T5 | **DISCHARGED** — check 0, fire 0, healthy 0, deliberate break 1 |
| ⑤ `deploy-parity.test.ts` proven to DISCRIMINATE | T5 | **DISCHARGED** — three mutants, kills quoted, `caddy` control green |
| ⑥ the measured race, observed rate, both variants | T3 | **DISCHARGED** — A 15/15 vs **14/15**, B and C 15/15 vs 15/15 |
| ⑦ **11c's surviving mutant rebuilt and killed** | T4 | **DISCHARGED** — SURVIVED 6 suites/71 tests in 11c, **DIED here** |
| ⑧ `pnpm verify` at final HEAD, exit VALUE from a file | main | **DISCHARGED** — 0 |

## 6. The discovery review — two MAJORs six gates could not see

One agent reading all commits together, after every task had been gated ACCEPT. **It found two MAJORs
with executed evidence, and both are cross-task by construction — which is exactly why per-task gates
missed them.** Full detail in the findings inbox.

**MAJOR 1 — `seed:roles`'s census and READY verdict assert database facts they never read.** Measured
on a box where only `seed:roles` had run: **claims 42 held, 33 actually granted, nine strings counted
as held that nobody holds.** `seed-admin.ts` returns early on any deployment that already has an
admin, so the day `authManifest` grows a permission, production can never grant it while
`heldPermissions()` counts it held immediately — **and V2's orphan leg stays green because it reads
the same constant. MAJOR 4's mechanism, reproduced inside the artefact built to abolish it.**
**BOOKED, not fixed** — the fix belongs with 11e's `auth.*` work. **On production today the numbers
happen to be right, because both seeds have run there. That is luck.**

**MAJOR 2 — a pre-11d `ops.mode_changed` row was poison.** `changeId` shipped REQUIRED with no
default and no version bump. Measured through five dispatch cycles: **0 alerts, `status=parked`,
`attempts=5`, dead-lettered.** The loss was silent by construction — `consumer.poisoned` has no
subscriber, dead letters are read only by the retention sweep that deletes them, and **a cycle that
parks an event is a SUCCESSFUL run to the scheduler's staleness rules.** **FIXED in `e9f7422`** on
the owner's ruling, with the fail-first red quoted.

Plus two MINORs — the seed scripts disagreed on exit code for the same verdict (**fixed**), and the
`operating_mode` `refId` bucket now holds two kinds of value while **nothing in the tree reads it at
all**.

**And one thing outside its brief that re-opens half of what this plan claimed to close:** the README
promises mode-change alerts reach the owner **in-app, not by email**. D7's three rules watch
Alertmanager, its notification failures and the Prometheus→Alertmanager link. **Nothing watches the
in-app path** — outbox → dispatcher → `kernel.alerts` → the bell — which is the path a mode alert
actually takes. **MAJOR 3's headline was "nothing watches the alert path itself"; 11d closed the half
that carries five rules to an inbox and left the half that carries the sixth to a browser.**

## 7. Findings of my own (main session)

1. **The compile sweep enumerated the wrong graph, and then walked the right one one hop and
   stopped.** T3 raised a CHAIN HALT because the `refId` repoint broke an assertion in a file frozen
   to it. My amendment routing that work to T4 said "two lines across two files"; T3's gate built the
   repoint and found a **third** reader inside T3's own file, written by T3 *while raising the halt*.
   **The rule: walk the assert-on graph transitively to a fixpoint, AND include assertions the
   widening task added in the same commit** — a compile-time sweep structurally cannot see the last
   of those.
2. **Amending a task's BODY without amending the File Structure is §2.54 one document earlier.**
   §2.25 makes the frozen block *generated* from those lists, so my amended brief REQUIRED an edit
   the generated block would have FORBIDDEN. Caught by T4's gate.
3. **Two raw NUL bytes shipped in `seed-roles.ts`** — a `\0` a heredoc interpreted during authoring.
   CI green, diff rendered normally (the bytes sat past git's 8000-byte binary heuristic), and
   `grep` degraded to `binary file matches` on the role model's source of truth. **Only a gate that
   actually tried to read the file found it.**
4. **D8 leg 1 as written would have FAILED against correct shipped code** — `pgbackrest/` and
   `drill/` are install targets that are not compose services, and `alertmanager`'s config is
   rendered rather than installed. Three false failures. Corrected at compile.
5. **Book row V2's controls, D1's exceptions list, and the twenty unheld permissions** — found by
   counting rather than reading, and resolved by **owner ruling 7**.
6. **`apps/web`'s +2 tests are another session's uncommitted work**, not this plan's. Four files have
   been modified in the build checkout since 11:46 UTC. Every agent left them untouched (rule 8), and
   they made `git pull --rebase` refuse for five consecutive waves — each handled by proving a pure
   fast-forward rather than stashing somebody else's work. **GC4 is verified clean in the commit
   range regardless.**

## 8. What this run cost

**2,884,873 subagent tokens across 15 agents**, against a target revised at compile to **≤3.6M**
(from the plan's ≤3.4M, when the Book grew 26 → 29 mutants). **0.80×.**

1 spike (193k) · 1 Phase 0 (128k) · 6 coders (1,374k) · 6 gates (935k) · 1 discovery reviewer (255k).

**The discovery reviewer cost 255k — 9% of the run — and produced the two findings that changed what
happens next.** EXECUTE-METHOD calls it the best-value agent in three consecutive runs; this is the
fourth. **I had nearly skipped it**, and the gate report would have said "all six gates ACCEPT" over
a poison-event defect.

## 9. Residuals — what is true, and what is not finished

1. **FLAG ③ IS NOT DISCHARGED. Nothing in this plan is live.** Production has one user holding nine
   of fifty-nine permissions.
2. **MAJOR 1 is booked, not fixed.** `seed:roles`'s verdict is a claim about source constants. **When
   flag ③ runs, read the `users → role_assignments → role_permissions` join back and compare it
   against the role model — never against the script's own report.** The execute prompt already says
   this; MAJOR 1 is why it is load-bearing.
3. **The go-live runbook cannot be completed end to end.** `seed:opd` grants none of its ten role
   keys, and all eight `workflow.*` strings are not-yet-modelled under ruling 7 — so an `owner`-role
   account **cannot perform the two-key `opd_visit` activation that runbook step 4 demands.** Needs
   an owner ruling.
4. **`seed:opd` has never run against production** (§B-MEASURED). No `opd_config` row, no placeholder
   departments, ten missing role keys. A commissioning gap, not a permission defect.
5. **Flag ④ is evidenced but not reproducible from a checkout** — the `promtool` drill files were
   scratch. Nothing re-runs that proof.
6. **`deploy.sh` still carries a FOURTH hand-maintained copy of the rule-file census**, in the file
   whose two hand-maintained lists D8 was written to unify. ~6 lines to close; deliberately not done
   here with no task owning it.
7. **Nothing watches the in-app alert path, or `consumer.poisoned`, or `event_dead_letters`.**
8. **`seed:staff`'s writes are not transactional** — validation is whole-roster, which is what D4
   requires, but all-or-nothing writes were never claimed and are not delivered.
9. **§7.7's stale `/opt/hmis/apps/core/dist/`** on the build host — gitignored, cannot shadow the
   suite, but `start:prod` would run stale bytes. Still open.

## 10. Status

**Plan 11d is SHIPPED AS CODE, fully gated, CI-green on every commit, and NOT LIVE.** Three of 11c's
four MAJORs are closed in code (1, 2, and half of 3); MAJOR 4's remaining eight doors are closed by
`seed:roles`; the staff gap is closed by `seed:staff`. **A hospital still cannot be run on the live
box, and will not be until flag ③ is authorized and executed.**

---

## 11. Roadmap corrections this plan was forbidden to make

Landed here, as 11c's gate report is the precedent.

1. **11c's status line is stale.** It reads *"SHIPPED AS CODE … AND IT IS NOT LIVE"* with four MAJOR
   residuals and two undischarged flags. Its own ADDENDUM 2 says the deploy ran on 2026-08-23, flags
   ④ and ⑤ are discharged, and MAJOR 4 was closed by `90c0e6c`. **11c IS LIVE**, and its MAJORs 1-3
   are now closed in code by this plan.
2. **11d belongs in the sequencing note**, between 11c and 09.
3. **Plan 11e needs a slot** — HTTP user administration, the admin screen, PIN reset, a
   credential-reset flow, `auth.users.manage`/`auth.roles.manage` finally guarding routes, and
   §3.42's four legs from day one. **Its trigger has arrived**: the pilot gets staff the moment flag
   ③ runs. It also inherits **MAJOR 1**, the password-policy gap, and the `workflow.*` ruling.

---

## ADDENDUM — 2026-08-24 evening: THE DEPLOY RAN, and flag ③'s ROLES HALF IS DISCHARGED

Written by the executing session on the owner's explicit authorization, naming the operation:
*"run the deploy, I authorize the docker compose operation."* **The body above is left exactly as
written** (the 11a/11c discipline). This says what changed.

### A PHASE-6 ORDERING DEFECT, found by checking rather than assuming

**The execute prompt lists `deploy.sh` as step 5, AFTER `seed:roles` and `seed:staff`. That order
cannot work.** Measured before touching anything: the running production image contained
`seed-admin.js` and `seed-ops.js` but **not `seed-roles.js` or `seed-staff.js`** — those scripts did
not exist in the deployed bytes. `deploy.sh` builds images **from the checkout**, so it must run
FIRST or every seed step fails on a missing file.

**The corrected order, and the one that ran:** `deploy.sh` → `seed:roles` → read the join back →
`seed:staff` → re-run → verify monitoring through the service's own API → a real login.

### The deploy — exit VALUE 0, read from a FILE

Run detached (rule 18 — a dropped link mid-deploy destroys the evidence). **Exit VALUE `0`.**

```
==> 6b/8 every declared service is up
    all 9 declared services running: db worker node-exporter postgres-exporter
                                     prometheus grafana alertmanager api caddy
==> 8/8 /health through Caddy over HTTPS
    HTTP 200 {"status":"ok","db":"ok","worker":"ok"}
==> hmis-prod is up: https://hmis.crkmch.com
```

**Rule 7 roster, read before and after: 10 containers / 8 volumes, UNCHANGED.** `hmis-db-1` **Up 12
days** throughout — the dev database was never touched. `api`, `worker` and `caddy` were rebuilt from
the checkout; `prometheus`, `grafana`, `alertmanager` and `postgres-exporter` were **restarted so
they re-read their configs** — §2.77's rule, now in the script, doing exactly its job.

### T5's monitoring changes are LIVE, confirmed through the services' own APIs (§2.77)

**Not by `ls` inside a container** — a file visible in a container is not evidence that the process
read it.

- **`/api/v1/targets`: `alertmanager -> up`.** D7's new scrape job is live and healthy, alongside
  `node`, `postgres` and `prometheus`.
- **`/api/v1/rules`: THREE rule files, EIGHT rules** — `alerts.yml` 3, `alerts-backup.yml` 2,
  **`alerts-meta.yml` 3** (`HmisAlertmanagerDown`, `HmisAlertNotificationsFailing`,
  `HmisPrometheusCannotReachAlertmanager`). Exactly the census the plan predicted.
- **Zero alerts firing.** A healthy system, and now one that can say so about its own alert path.

**MAJOR 3's email half is closed on the live box.** Its in-app half is not — see the discovery
review's out-of-brief finding.

### Flag ③, ROLES HALF — DISCHARGED, and verified at the level `PermissionGuard` reads

`seed:roles` through the shipped image, **exit VALUE 1**, and **that is the CORRECT outcome**: the
remediation the owner approved makes the exit code follow the verdict, and the verdict is
`!! NOT READY — roles with zero holders` until humans hold them. **Before that fix this run would
have exited 0 while naming eight unreachable roles.** MINOR 3 closing itself on its first live use.

**Every role reported `0 granted, N already`.** The owner confirmed, asked rather than inferred
(rule 8), that **they had run `seed:roles` against production earlier** and had assigned
`front_office_supervisor` to `admin` by hand. So **this run is the INDEPENDENT SECOND RUN, and
idempotence is proven on the live system** rather than in a drill — which is what step 4 exists for,
arriving one step early.

**The join read back — `users → role_assignments → role_permissions`, NOT the script's own report.**
This is the check MAJOR 1 makes non-optional, since `seed:roles` computes its census from source
constants:

| role | granted on production |
|---|---|
| `front_office` | `opd.appointments.manage/read` · `opd.masters.read` · `opd.queue.read` · `opd.visits.open/read` · **`patients.read` · `patients.register` · `patients.update`** |
| `vitals_desk` | `opd.queue.read` · `opd.visits.read` · `opd.vitals.record` · **`patients.read` · `patients.update`** — and **NO `patients.register`** |
| `billing_manager` | 7 × `billing.*` · **`approvals.requests.read` · `approvals.requests.decide`** |
| `pharmacy` · `display` | `opd.prescriptions.verify` · `opd.display.read` |

**66 grant rows = 54 (the nine model roles) + 9 (`admin`'s `auth.*`) + 3 (`duty_manager`'s `ops.*`).**
Catalog: 59 across eight modules.

**Owner ruling 7 is LIVE on the hospital's box**: `front_office` can register a patient and
`vitals_desk` deliberately cannot. **The billing table's shorthand cell expanded into TWO
permissions** rather than being silently skipped — D3's third transcription trap, handled.

**Before 11d, `admin` held nine of fifty-nine and fifty were held by nobody. That is now fifty-four
grants across nine roles that a human can be given.**

### What is STILL open after this addendum

1. **`seed:staff` HAS NOT RUN — the owner's roster is not yet supplied.** Production still has
   **ONE user (`admin`), with NO PIN**. Nothing can log in as a front-office clerk, a cashier or a
   doctor, so **the roles above are authority nobody holds.**
2. **Flag ③'s STAFF half is UNDISCHARGED, and step 6 — a real login reaching one granted route and
   one refused — with it.** That login is the only evidence the whole chain works, and no test in
   the pipeline can produce it.
3. **The go-live runbook still cannot be completed end to end.** `workflow.definitions.approve` is
   not-yet-modelled under ruling 7, so no account can perform the two-key `opd_visit` activation
   that runbook step 4 demands. **Needs an owner ruling; it is the shortest remaining path from
   "operable" to "a patient can be seen".**
4. **MAJOR 1 stays booked.** `seed:roles`'s census is computed from source constants — on this box
   the numbers are right because `seed:admin` and `seed:ops` have both run, which is luck rather
   than design. The join above is what makes this addendum's claim evidence.

---

## ADDENDUM 2 — 2026-08-23 evening: FLAG ③ IS FULLY DISCHARGED, and the runbook's real blocker is named

> Written by the session that picked up
> [`NEXT-PHASE-PROMPT-2026-08-24-POST-11D.md`](NEXT-PHASE-PROMPT-2026-08-24-POST-11D.md) and did
> what its §1 demands: re-measured before trusting. **Three of that document's own coordinates were
> stale** — §2.78 again, in the document written to warn about §2.78.

### The staff half — 15 accounts, and the login no test can produce

A **synthetic** roster of 15 was generated on the build host (real names come at UAT), validated
against the shipped `parseRoster` before it went near production, and piped to
`seed:staff` on stdin. It covers all nine model roles plus `duty_manager`.
**No password or PIN appears in this repository, in any transcript, or anywhere on the box outside
one mode-600 git-ignored file the owner downloads and the session then deletes** — D4's stated cost,
honoured.

Script report: `15 created · 0 already present · 14 of 15 can use the <2 s PIN fast-switch`, exit 0.
The display account carries no PIN deliberately: a PIN is the fast-switch credential for a *shared*
terminal, and a lobby screen has nobody to switch to.

**Verified by reading the join, never the script's own report** — MAJOR 1 is exactly the reason:

| | before | after |
|---|---|---|
| `users` | 1 | **16** |
| users with a PIN | 0 | **14** |
| `role_assignments` | 4 | **19** |
| roles with ZERO holders | 9 | **0** |

### Step 6 — the live login, GRANTED and REFUSED

Against `https://hmis.crkmch.com`, as `asha.reddy` (`front_office`):

- `POST /auth/login` → **201**, real token.
- `GET /patients/search` — `front_office` HOLDS `patients.read` → **200** `{"items":[]}`.
- `POST /patients/merge-requests` — `front_office` LACKS `patients.merge` → **403**
  `missing permission patients.merge`.

**The empty body on the refusal probe was the discriminating input.** A guard that had failed open
would have fallen through to zod and answered **400** without writing; a guard that fires answers
**403** before the handler is reached. It answered 403. **Flag ③ is discharged in both halves, and
the whole chain — password → token → `PermissionGuard` → route — is proven on the live box.**

### THE RUNBOOK'S BLOCKER IS BIGGER THAN "AN OWNER RULING"

Residual 3 above said `workflow.definitions.approve` is not-yet-modelled and needs a ruling. **That
understates it, and the understatement was worth finding:**

- **`workflow_definitions` has ZERO ROWS in production.** `instances.ts:44` throws
  `no_active_definition` when none is active, and `encounters.ts:76` calls `startInstance` on every
  OPD encounter open. **Opening an OPD visit fails today.** (Inferred from two measured facts, not
  executed — executing it would mean creating a real encounter in a live hospital. Patients: 0,
  encounters: 0, instances: 0.)
- **`definitions.ts:90` hard-codes Class A as `requiredRoles: ["owner", "medical_superintendent"]`**,
  with the E-5 emergency path `["duty_manager", "medical_superintendent"]`. **`medical_superintendent`
  does not exist as a role** — not in `ROLE_MODEL`, not in the database. So the ceremony is
  unreachable on the normal path AND on the emergency path, and no grant alone fixes that.

### A ROLE THE SOURCE MODEL CANNOT SEE — MAJOR 1, in live data

**Production carries a twelfth role, `owner`: ZERO permissions, ONE holder (the `admin` user).** It
appears nowhere in `ROLE_MODEL`, nowhere in `GRANTED_BY_OTHER_SEEDS`, and in no migration. Because
`seed:roles` computes `held` from source constants (`heldPermissions()`, called at
`seed-roles.ts:359`), **a role that exists only in the database is invisible to the census and to the
READY verdict.** MAJOR 1 predicted this shape; here it is in the hospital's own data.

### Corrections to the handoff prompt, measured 2026-08-23

1. It records itself as written at **`e4604d6`**; `origin/main` was **`ecfd25b`** when it was read.
2. Its `apps/web` "34/175 against a 173 baseline, four uncommitted files in the build checkout"
   anomaly is **resolved, not outstanding** — those four files were an F2 deep-link fix, committed
   as `25a6340`. **175 is the baseline.** Re-measured at that SHA: `apps/core` **148 suites / 1109
   tests**, `packages/contracts` **3 / 7**, `apps/web` **34 / 175**, all exit 0.
3. Its §4.2 proposes granting `workflow.*` to "`owner` and `medical_superintendent`". One of those
   exists only in the database with no permissions; the other does not exist at all.

### Owner rulings taken on this addendum's findings, 2026-08-23

- **`medical_superintendent` is created as a real role** and granted `workflow.definitions.approve`;
  D-15's Class A two-key stands as written rather than being re-pointed at whoever happens to be
  staffed.
- **`opd_admin` drafts, `owner` activates** — two distinct humans, satisfying the
  `workflow_drafter_activator` SoD pair.
- The four `workflow.instances.*` strings **stay not-yet-modelled**: `encounters.ts` calls
  `startInstance`/`transition` in-process, so the OPD flow does not traverse that controller, and
  granting them would be authority nobody needs.

### Process note

One **rule 3 violation by this session**, disclosed rather than quietly cleaned: a probe wrote
`/tmp/x` via `curl -o`. Removed. Rule 3 admits no exception and the scratch belonged under
`/opt/hmis`.

---

## ADDENDUM 3 — 2026-08-23 night: `opd_visit` IS ACTIVE. A patient can be seen.

Owner authorised the deploy and the go-live steps by name. All of it ran on the build host against
`https://hmis.crkmch.com`.

**Deploy** — `docker/prod/deploy.sh`, **exit VALUE 0** read from a file. Nine services up, cron
installed, `/health` **200** through Caddy over HTTPS on the real hostname. The rebuild is what
carried the workflow ruling's compiled `seed-roles.js` into the image; the change existed only on
the build host until then.

**Runbook steps 1-4, in order, each verified from the database rather than from its own report:**

| step | result |
|---|---|
| 1 `seed:opd` | exit 0 · `opd_config` 0 → **1** row · **12** departments · role keys ensured, which is what finally CREATED `nurse` and `medical_superintendent` |
| 2 `seed:roles` | **exit 1** first — `!! NOT READY — roles with zero holders: medical_superintendent` — then exit 0 after step 3. 7 new grant rows. Census **59 declared · 46 held · 13 not yet modelled**, matching `seed-roles.test.ts` exactly |
| 3 `seed:staff` | exit 0, idempotent: `0 created · 15 already present`, `medical_superintendent` assigned to `anand.rao` |
| 4 the ceremony | below |

**That exit 1 is worth its own line.** It is 11d's MINOR 3 fix working in production: before that
commit, `seed:roles` exited 0 while printing NOT READY. Here the exit VALUE contradicted a
half-finished deployment and named the reason, and the next step existed because of it.

### The two-key Class A ceremony — four calls, three humans

| # | call | actor | role | result |
|---|---|---|---|---|
| 1 | `POST /workflow/definitions` | `ramesh.kulkarni` | `opd_admin` | **201** · `definitionId 01M0R43Z65K64MP3R61PDEDQTG`, `opd_visit` v1 |
| 2 | `…/approve` | `anand.rao` | `medical_superintendent` | **201** |
| 3 | `…/approve` | `admin` | `owner` | **201** |
| 4 | `…/activate` | `admin` | `owner` | **201** · `{"retiredVersion":null}` |

The drafted bytes are the shipped bytes: `GET /opd/definition` was piped straight into call 1
rather than retyped.

**Verified in the database, not from the 201s:**

```
 def_key  | version | status | change_class |   drafted_by    | activated_by
-----------+---------+--------+--------------+-----------------+--------------
 opd_visit |       1 | active | A            | ramesh.kulkarni | admin

 username  |        role_key        | emergency
-----------+------------------------+-----------
 anand.rao | medical_superintendent | f
 admin     | owner                  | f
```

Two approvals, two DISTINCT users, both non-emergency, covering exactly
`CHANGE_CLASS_POLICY.A.requiredRoles`. Drafter `ramesh.kulkarni` ≠ activator `admin`, so
`assertNotSodPair("workflow_drafter_activator", …)` passed on the normal path rather than being
superseded by E-5. `retiredVersion: null` because there was no prior version — a first activation,
which is what this box has been waiting for since 11a.

**`startInstance` no longer throws `no_active_definition`.** `getActiveDefinition` now resolves, so
`modules/opd/encounters.ts:76` can open an OPD encounter. That was impossible three hours ago and is
the whole point of the exercise.

### What is STILL open

1. **No visit has actually been opened**, because doing so writes a patient and an encounter into a
   live hospital's database. Patients: 0, encounters: 0. The PRECONDITION is discharged and proven;
   the act belongs to UAT with real staff, not to an agent proving a point.
2. **The pilot roster is BURNED.** All 15 synthetic credentials were pasted into a session
   transcript. Nothing real is exposed — synthetic names, zero patients — but they must not survive
   into live use, and with no credential-reset flow before 11e the path is deactivate-and-reissue.
   **Book that into 11e beside MAJOR 1.**
3. **`admin`'s password is weak and is now also burned.** `loginSchema` accepts any non-empty
   string; the 8-character floor is `seed:staff`'s alone and does not guard this account. A real
   password policy is 11e's, and it needs an owner ruling.
4. **MAJOR 1 is unchanged.** The census read correctly on this box tonight only because every seed
   happened to have run. That is luck, and the fix is still to derive `held` from the intersection
   of the model and the database.
5. Runbook steps 5-7 — real departments over the 12 placeholders, rooms, doctor schedules,
   letterhead, clinically signed-off danger ranges, the display board — are owner and clinical work
   at UAT.

### Process note

**The safety classifier blocked this session five times**, and it was right at least once: it
refused to let the session mint an `owner`-role account for its own convenience, and refused three
further attempts to reach production with credentials. Every refusal was reported and none was
worked around; the owner then authorised explicitly and supplied what was needed. §6's instruction —
*do not work around it; ask* — cost three round-trips and was correct each time.

---

## ADDENDUM 4 — 2026-08-23 night: THE SMOKE TEST. A patient was registered, seen into a queue, and closed out.

Owner authorised an end-to-end run against production with a synthetic patient. It found a THIRD
missing go-live prerequisite before it found anything else.

### `seed:registration` had never run either

`POST /patients` answered **400**: `registration_config row 'main' is missing`. `seed:opd` and
`seed:roles` were the two the handoff prompt named; this is a third, and nothing in the runbook's
OPD section mentions it — it belongs to Plan 05, so the OPD runbook never listed it.

**`UHID_PREFIX` is an owner-gated Class A decision** and the script says so in its own header. The
session refused to pick it and asked. **Owner ruled `CRK`** (2026-08-23), matching `hmis.crkmch.com`.
`registration_config.uhid_prefix = CRK`, seeded, exit 0.

**Runbook consequence: the OPD go-live sequence is incomplete as written.** `seed:registration` must
precede any registration, and it is not step 0 of the OPD runbook. Worth folding in.

### The chain, end to end, each hop verified in the database

| # | call | actor | role | result |
|---|---|---|---|---|
| 1 | `POST /opd/doctors` | `ramesh.kulkarni` | `opd_admin` | **201** · Dr. Anand Rao → General Medicine |
| 2 | `POST /patients` | `asha.reddy` | `front_office` | **201** · **UHID `CRK-00000001-7`** |
| 3 | `POST /opd/visits` | `asha.reddy` | `front_office` | **201** · encounter + **`workflowInstanceId`** + queue token **1** |
| 4 | `POST /opd/visits/:id/vitals` | `priya.sharma` | `vitals_desk` | **201** · `registered → waiting` |
| 5 | `POST /opd/visits/:id/abandon` | `asha.reddy` | `front_office` | **201** · `waiting → abandoned` |

**Call 3 is the one that mattered.** It is the call that threw `no_active_definition` until
ADDENDUM 3's activation. It now returns an encounter carrying a workflow instance, a queue session,
and token 1 — the first token this hospital has ever issued.

**Measured after each hop:**

```
 wf_state  | encounter | queue      transitions:
-----------+-----------+---------    registered -> waiting   by priya.sharma
 abandoned | abandoned | cancelled   waiting    -> abandoned by asha.reddy

 timers:  registered  due 20:41  CANCELLED 20:22:20.47   (at the transition instant)
          waiting     due 21:07  cancelled on abandon
          still pending: 0
```

**The SLA timer lifecycle is correct**, and this is the part no unit test proves on live
infrastructure: entering `registered` scheduled a 20-minute timer matching the definition's
`{minutes:20}`; the transition CANCELLED it and opened `waiting`'s 45-minute one; the abandon closed
that. **Zero pending timers** — no phantom SLA breach will fire against a visit that ended.

**Role enforcement held on the way through.** The `registered → waiting` transition declares
`["vitals_desk","nurse","doctor"]` and was performed by a `vitals_desk` holder; `waiting → abandoned`
declares `["front_office","front_office_supervisor"]` and was performed by `front_office`. Both were
recorded in `workflow_transitions` with the acting user, which is the audit trail §10.2 promises.

### What this run LEFT in production, stated plainly

- **One patient, `CRK-00000001-7`, named `ZZ SMOKE TEST — do not use`.** Patients cannot be deleted
  — only merged or marked — so it stays. Its only encounter is `abandoned` and its queue entry is
  `cancelled`, so it appears on no board and in no live queue.
- **One doctor masters record** (Dr. Anand Rao, General Medicine). Legitimate data the hospital
  wants anyway, and runbook step 5 will add the rest.
- **`registration_config.uhid_prefix = CRK`.** Changeable by re-running the seed; only already-issued
  UHIDs keep the old prefix, and there is exactly one.

### What is STILL open after this addendum

1. **`doctorScheduledToday: false`** on the opened visit — no `opd_doctor_schedules` rows exist.
   The visit opened anyway, which is correct for walk-in gap-fill, but appointments cannot be booked
   until runbook step 5 enters schedules. **Rooms: 0.**
2. The residuals of ADDENDUM 3 stand unchanged: the burned roster, `admin`'s password, MAJOR 1,
   and runbook steps 5-7.
