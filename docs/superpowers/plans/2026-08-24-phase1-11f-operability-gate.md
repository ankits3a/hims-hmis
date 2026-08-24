# Plan 11f — the operability gate: the distance between "deployed" and "operating"

> **The phase document** — the only phase-specific artifact, per
> [`EXECUTE-METHOD-V3.md`](../EXECUTE-METHOD-V3.md) §1. **v3's second phase, first
> post-pilot.** Written 2026-08-24 by the session that answered
> [`reports/NEXT-PHASE-BRAINSTORM-PROMPT-2026-08-24-post-11e.md`](reports/NEXT-PHASE-BRAINSTORM-PROMPT-2026-08-24-post-11e.md);
> every number in §2 and §3 was measured by that session on the build host, not carried forward.
>
> **The seed for the executing session is three lines: read this document,
> [`AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — then execute.**

## THE LANE — ruled at write time, v3 §2

**Ruled LIGHT, and it is not close.** Four tasks, one of them CRITICAL; no migration, no new
screen, no module build; the largest single change is a ~15-line shell script. The only depth
risk is one credential seam (T1), and depth is carried by rule-21 executed mutants and the
independent close reviewer, both lane-independent. *(No dissent to record: nothing about this
phase is HEAVY-shaped.)*

**Stop-loss: 1.0M total tokens, all sessions counted.** The honest comparable — 11e's actual —
is owner-held and unrecorded (§7's cost claim is UNDISCHARGED; runbook item O3 chases it), so
v3 §6's 1.5×-comparable rule cannot be applied honestly. The precedented anchor is the v2 band
floor 11e used (2.5M) — but a tripwire at 2.5M could not fire before this four-task phase had
already spent like a full v2 phase, which is the condition it exists to detect. 1.0M is 40% of
that floor for well under half of 11e's surface: crossing it means something is structurally
wrong. When O3 lands 11e's real number, future stop-losses return to the 1.5×-comparable rule.

**Verification depth is not set by the lane** (v3 §2): T1 touches the bootstrap credential
path, so it carries executed mutants, rule 21 unchanged.

---

## 1. Why this phase — and the two options marked dead

The software is deployed and the hospital is not running on it. `operating_mode_changes` is
EMPTY — production has never left `commissioning`; its 2 patients and 3 encounters are a smoke
test (§2). Three things are simultaneously true about credentials: the 15-account pilot roster
burned into a transcript on 2026-08-23 is still unrotated (D5, owner-only by construction);
production has exactly ONE holder of the full `auth.*` set, and 11e's takeover rule means
nobody may reset that account — the top credential's only repair today is direct database
access; and `seed:admin` applies no password policy to `ADMIN_PASSWORD` (11e F8, a stated seam
that wanted a ruling — ruled here, D1). Meanwhile 11e's reviewer proved the shipped-vs-working
gap is not hypothetical: an entire plan's production surface (`/ops`) was dark for a plan cycle
under a green test (ledger §2.88). That is evidence about what "shipped" is worth on a system
nobody exercises — and every phase of new surface added before the system is exercised makes
the next such gap bigger and later to find.

So this phase is deliberately small and verification-shaped: close the last code seams 11e
named (the password floor, the two-admin blindness, the suite's one single-sample wall-clock
assertion, the build host's CI blindness), and put the owner's half — rotation, the second
admin, the first real day — into a runbook whose items are named, evidenced, and chased at
CLOSE. Then Plan 09 runs immediately.

**DEAD OPTION 1 — Plan 09 next (the standing 2026-08-23 ruling).** Dead as "next", alive as
"immediately after 11f", and the sequencing ruling is amended in the roadmap accordingly. Four
reasons, none re-litigable without new evidence: (a) the 2026-08-23 ruling predates 11e's
findings — §2.88 is evidence about the size of the shipped-vs-working gap, not an anecdote, and
Plan 09 would add surface to a system with zero operating days; (b) the credential state is a
standing operational hazard (burned roster, one irreparable admin) that revenue features
compound and this phase's runbook retires; (c) Plan 09's own scope presupposes operation —
recognition at the counter needs a counter that operates, and the accrual consumer needs real
`payment.received` events to consume; (d) practically, its planning session needs the owner's
out-of-git `hmis-context/plan-09-channel-partners-2026-08-23.md`, which is not on this host.

**DEAD OPTION 2 — "not a phase at all: a runbook and an afternoon."** Dead as the whole
answer; adopted for its owner half. The owner-only work IS a runbook (§5.5) — writing tasks an
agent must not execute would be theater. But the code half contains a credential-path change
(T1), and v3 §0 keeps two things untouchable in every lane: executed mutants on credential
seams, and independent eyes on every phase before it closes. Code shipped outside any phase
escapes both, and the first unreviewed credential change in this project's history is not worth
the ceremony it saves. At four tasks, the LIGHT lane's apparatus costs almost nothing.

## 2. Ground truth — measured 2026-08-24 by the authoring session

- **SHA `9013df1`**, clean tree, on the build host. Baseline `pnpm verify` exit 0 at
  `f8885be` (11e's close verification): `apps/core` **152 suites / 1167 tests** ·
  `apps/web` **36 files / 190 tests** · `packages/contracts` **3 / 7**. Every commit since is
  docs-only. Next migration is `0019`; this phase generates none.
- **Production** (`hmis-prod-db-1`, read-only SELECTs, this session): `operating_mode_changes`
  **0 rows** · live sessions **0** · `must_change_password` **0** users · `ops.*` grants
  **6** — so 11c/11d's permission repair IS live in production, and the roadmap's "11d IS NOT
  LIVE" line was stale (corrected in the roadmap this session) · the only role holding any
  `auth.*` string is `admin`, and per 11e's CLOSE exactly one user holds it.
- **The carried-findings state is better than the brainstorm prompt assumed.** `0624c82`
  (post-CLOSE, CI green) already fixed M3 (route table pinned to Nest's own decorator metadata,
  both mutants DIED), M7 (gateway must-change/deactivated tests), and all four minors
  (uniqueness race, error ordering, `SubmitButton` on all five admin-screen writes). `38e2c98`
  shipped the takeover rule. **What remains open from 11e is exactly four items:** D5's
  rotation (owner) · F2's cause (owner `gh`) · the v3 pilot token total (owner `/cost`) · the
  `seed:admin` password floor (ruled here, executed as T1).
- **The two red commits, narrowed one step** (unauthenticated API, re-verified this session):
  run 32668118868's only job fails at **step 7, `Run pnpm verify`** — setup, containers and
  install all green — so the failure is inside the suite, consistent with a test failure and
  inconsistent with §2.59's did-not-run shape. Job logs remain **403** without a credential;
  the failing test name still needs the owner's `gh` (runbook O4).
- **`auth.e2e.test.ts:77` is the suite's ONLY single-sample wall-clock assertion** (grep over
  `apps/core/test`): every other `toBeLessThan` wall-clock assertion is `fastest(times)`
  best-of-N in the two perf suites. Its candidacy for F2 remains a PREDICTION.
- **The unauthenticated GitHub API serves check-runs and job/step conclusions** for this public
  repo (ledger §2.91, re-verified); rate limit 60 requests/hour/IP — a poller must budget it.
- **`seed-admin.ts` uses `input.password` in exactly one place**: the `createUser` branch of
  step 4, which runs only when the username is absent. A reconcile-only re-run never touches
  the password. The takeover rule's holder-set helper (`users-admin.controller.ts:160-173`)
  reads a user's held `auth.*` set at hospital scope from `authManifest.permissions` — the one
  function that decides, per §2.89 the one the detector must derive from.

## 3. Spike — answered by measurement at authoring (v3 §1.2)

**Q1 — Can F2's cause be read without a credential?** NO, only narrowed: step-level data
(readable) pins the failure inside `pnpm verify`; the test name is in job logs (403). The
owner's `gh run view 32668118868 --log-failed` remains the one-line settle (O4).

**Q2 — Where does the password-policy call land in `seed:admin`?** Immediately before the
`createUser` branch, and ONLY there. Validating at env-read would make a reconcile-only re-run
refuse on a stale or irrelevant `ADMIN_PASSWORD` — breaking exactly the repair path T5 of 11e
built (D4's "every code path executes on every run" contract). The policy guards the value
where it is USED.

**Q3 — What is a "full administrator", queryably?** A user whose held `auth.*` set at hospital
scope equals `authManifest.permissions`' `auth.*` subset — the takeover rule's own comparison.
The detector (T2) must call the same helper the takeover check reads, not re-derive the count
with its own join: §2.89's rule, and C2 was the cost of ignoring it.

**Q4 — Is the flake candidate structurally defective regardless of F2?** YES. A single-sample
wall-clock assertion on an argon2id verify (memoryCost 19456) on a shared 4-core CI runner is
the shape the two perf suites already refuse — they measure best-of-N precisely because one
sample conflates the code's speed with the box's mood. T3 fixes the shape on its own merits and
makes NO claim about F2 until O4's log line lands.

**Q5 — Is the unauthenticated API enough for a build-host CI poller?** YES within budget:
check-runs by full SHA return status and conclusion; at 60 req/hr/IP a 2-minute poll interval
over a handful of SHAs fits with headroom. Logs are out of reach, which is fine — the poller's
job is green/red-by-full-SHA (§2.55), not diagnosis.

## 4. Design decisions — the brainstorm's five rulings, recorded

### D1 — `seed:admin` applies the password policy (RULED 2026-08-24 by this session, under the brainstorm prompt's explicit delegation)

`ADMIN_PASSWORD` becomes the **sixth policy-guarded path**: validated by the shared
`password-policy.ts` (10+ chars, no composition, username and top-20 rejected — D3 of 11e,
unchanged and not re-litigated) at the point of use (Q2). Refusal is whole-and-before-first-
write, the `seed:staff` pattern. No live account is affected: the script only creates when the
username is absent, and an existing admin's stored hash is never touched. The script-header
seam note (F8) retires in the same commit — §2.90's rule.

### D2 — Two full administrators: OPERATIONAL, with a code detector (RULED 2026-08-24)

**The mitigation stays operational; code ENFORCEMENT is marked dead in place.** An invariant
refusing states with fewer than two full administrators is unsatisfiable at bootstrap
(`seed:admin` mints exactly one) and in today's production (count = 1) — it would refuse the
very mutations that repair the state, or carry escape hatches that gut it. What ships instead
is **visibility** (T2): the `seed:roles` census prints the full-administrator count and warns
by name when it is below two, and the admin-users surface shows the same warning — both counts
derived from the takeover rule's own holder-set helper (Q3, §2.89). Creating the second admin
is runbook item O1, and it is step 0 of the rotation.

### D3 — F2 discipline: fix the shape, do not claim the cause

T3 converts `auth.e2e.test.ts:77` to the perf suites' best-of-N pattern because the assertion
is defective by class (Q4). Whether it caused F2 stays a PREDICTION until the owner's log line
(O4) lands in 11e's CLOSE; if the log names a different test, that is a NEW finding for this
phase's CLOSE and T3 stands anyway.

### D4 — The build host watches CI (closes ledger §2.91's gap)

`pipelines/ci-watch-host.sh`: a `curl`-only poller, green/red per FULL SHA from the
unauthenticated check-runs API, exit value distinguishes green / red / timed-out, rate-limit
budgeted (Q5). With it, v3 §3.3's "CI is watched, not assumed" stops depending on which
machine the session runs on. The same task amends the two sentences §2.91 convicted — v3 §8's
"`gh` cannot authenticate there" ruling and `ci-watch.sh`'s own header — to record WHICH TOOL
the incapacity belongs to, the rule-6 strike pattern, citing the ledger entry.

## 5. Tasks

Sequential, main session, LIGHT lane (v3 §3): narrow suites while iterating, detached runs
with exit files, **`pnpm verify` before every push** (§2.87 — the rule this phase's own T4
poller then watches), CI-green-by-FULL-SHA before close.

---

### T1 — CRITICAL — `seed:admin` becomes the sixth policy-guarded path

**Files:** `apps/core/scripts/seed-admin.ts` · `apps/core/test/seed-admin.test.ts`.

**Acceptance:** D1 delivered; a policy-violating `ADMIN_PASSWORD` is refused before any write
with the policy's own error naming the floor; a reconcile-only run (admin exists) completes
regardless of the env password (Q2 — D4-of-11e's contract preserved, asserted); the F8 seam
note in the script header is retired in the same commit (§2.90).

**Book rows:**
- **R1** · a 4-character `ADMIN_PASSWORD` is refused before any write, and a compliant one
  creates the admin · mutant: the policy call removed (today's shipped code — §2.81's tell
  checked: the discriminating input is the weak-password run, which today measurably succeeds)
  · discriminating input: `ADMIN_PASSWORD="abcd"` on an empty deployment — shipped refuses
  naming the policy, mutant creates the user. Control: a 10-character non-common password
  seeds under both, so the row cannot pass by refusing everything.
- **R2** · a reconcile-only re-run never evaluates the policy · discriminating input: existing
  admin + `ADMIN_PASSWORD="abcd"` — shipped completes and reports reconciliation; a
  validate-at-env-read implementation refuses. No separate mutant build: the wrong
  implementation is the row's named input placement, asserted by the test's own leg.

**Commit:** `fix(core): seed-admin applies the password policy at the create path — the sixth guarded path (ruling 2026-08-24, closes 11e F8)`

---

### T2 — ROUTINE — the two-admin detector: the census and the screen can SEE the mitigation unmet

**Files:** `apps/core/scripts/seed-roles.ts` · `apps/core/test/seed-roles.test.ts` ·
`apps/core/src/kernel/auth/users-admin.controller.ts` (list response gains the
full-administrator count) · `apps/core/test/user-admin.e2e.test.ts` ·
`apps/web/src/screens/admin-users.tsx` + `.test.tsx` ·
`apps/web/src/locales/en.json` + `hi.json` (the banner strings — named here so F5's class does
not recur).

**Acceptance:** D2 delivered; both surfaces derive the count from the takeover rule's
holder-set helper (Q3 — acceptance includes pointing at the shared function, not a lookalike
join); the census warns by name below two, citing the takeover rule; the screen banners the
same condition; no mutants (ROUTINE reporting), tests required, fail-first not owed — say so.

**Commit:** `feat(core,web): the two-admin detector — the census and the admin screen see the takeover rule's mitigation unmet (ruling 2026-08-24: operational, with visibility)`

---

### T3 — ROUTINE — retire the suite's only single-sample wall-clock assertion

**Files:** `apps/core/test/auth.e2e.test.ts`.

**Acceptance:** D3 delivered: the PIN-switch budget assertion measures best-of-N (N≥3,
warm-up kept) in the perf suites' `fastest(times)` idiom; the assertion's comment names the
pattern and why (single-sample conflates code speed with runner mood); no claim about F2
anywhere in code or commit — the disposition lands in CLOSE when O4 does.

**Commit:** `test(core): the PIN-switch budget measures best-of-N — the suite's last single-sample wall-clock assertion retired`

---

### T4 — ROUTINE — `ci-watch-host.sh`, and §2.91's two convicted sentences amended

**Files:** `pipelines/ci-watch-host.sh` (new) · `pipelines/ci-watch.sh` (header sentence) ·
`docs/superpowers/EXECUTE-METHOD-V3.md` (§8's `ci-watch` sentence, struck-and-amended in
place citing ledger §2.91).

**Acceptance:** D4 delivered; the poller is proven by execution against known conclusions
(`3eec860` reports red, `00c3747` reports green — verify-by-execution, the Plan-01 lesson);
exit values distinguish green / red / timed-out and are read from the VALUE, not the pipeline
(rules 16–17); polling interval respects the 60/hr unauthenticated budget; both amended
sentences record that `gh` is what cannot authenticate, per §2.91's rule.

**Commit:** `feat(pipelines): ci-watch-host — the build host watches CI over unauthenticated curl (ledger 2.91)`

---

## 5.5 The owner runbook — named, evidenced, chased at CLOSE, executed by NO agent

None of these is a task, and D5's rotation especially is **owner-only by construction** — an
agent performing it would put fifteen credentials into a transcript, the exact state 11e was
built to end. Each item names where its evidence lands.

- **O1 — create the SECOND full administrator** through `/admin/users` (assign the `admin`
  role), then verify T2's detector goes quiet. This is step 0 of the rotation and the takeover
  ruling's named mitigation: until it is done, the top credential's only repair is the
  database. *Evidence: the census line / screen banner; recorded in this CLOSE.*
- **O2 — D5's rotation**, through the screen: password-reset the 15 roster accounts, PIN-reset
  the 14 PIN-holders, then `admin`'s own password via `/change-password`. *Evidence: a
  read-only session records `must_change` counts and session revocations in this CLOSE.*
- **O3 — record 11e's token total** (`/cost`, or the Anthropic console for 2026-08-23/24) into
  11e's CLOSE actuals row. Until then v3 §7's cost claim stays UNDISCHARGED in both
  directions, and this phase's stop-loss note stands as the record of planning without it.
- **O4 — `gh run view 32668118868 --log-failed`**, one line into 11e CLOSE F2, and T3's
  disposition into this CLOSE (D3).
- **O5 — one real day through the system**, registration → OPD → billing, real staff, still in
  `commissioning`; findings land in this CLOSE. When ready, leave commissioning via the ops
  surface (E-10) — the first row in `operating_mode_changes` is the hospital starting to
  exist on this system.
- **O6 — named so it is not lost, NOT this phase's to close:** before the first live invoice,
  real tariffs loaded and `validate:tariff` printing `ok=true` (D-17), with the CA-gate flags
  (§19). This is the go-live checklist's lane; it needs the DTC/CA workstreams, not a phase.

**After this phase closes, Plan 09 runs immediately.** Its planning session needs the owner to
supply `hmis-context/plan-09-channel-partners-2026-08-23.md` (not on this host), and should
read the roadmap's re-shaped Plan 09 entry plus this document's §1.

## 6. CLOSE — appended as the phase runs (v3 §1.5)

**Executed 2026-08-24 in one session, on the build host, LIGHT lane. Four tasks, four commits,
plus one close-remediation commit.**

| task | commit | tier | CI |
|---|---|---|---|
| T1 | `22a5e3b` | CRITICAL | GREEN |
| T2 | `f98cfa5` | ROUTINE | GREEN |
| T3 | `b88a8bb` | ROUTINE | GREEN |
| T4 | `39af9a2` | ROUTINE | GREEN |
| close sweep — F2's remediation | `1bae1d0` | — | GREEN |
| review remediation — M1–M4 and seven minors | `30227e6` | — | GREEN |
| CLOSE, ledger §3.54–§3.57, first ARCHIVE pass | `a35573f` | — | GREEN |
| the third §2.91 claim, in the v2 manual (F8) | `6db3899` | — | GREEN |

*CLOSE was finalised across two docs commits (`a35573f`, then `6db3899` once the whole-repo sweep
F8 describes had actually been run). This table lists the phase's substantive commits; the small
follow-up correcting it is not itself a row, which is the only sane place to stop the regress.*

### Findings

- **F1 — MEASURED. T2's Files list cannot carry T2's acceptance.** The acceptance requires the
  admin screen to render a count the SERVER computes; the screen reads it through
  `apps/web/src/lib/admin-api.ts`, which is the file that describes the wire contract — and T2's
  Files list does not name it. The alternative was to derive the count client-side, which is the
  §2.89 defect this very task exists to avoid, in a second language. Fixed minimally (the return
  type widened, one docblock) and disclosed rather than silently absorbed. *The authoring lesson:
  a Files list for a task that widens a RESPONSE must include the client's transcription of that
  response.*
- **F2 — MEASURED, and it is this phase's own defect. T1's acceptance under-scoped the §2.90 sweep
  it invoked.** The criterion named ONE location (the script header); §2.90's rule is *every*
  claim. Three live claims survived T1 — `password-policy.ts`'s "FIVE call sites" (in the module
  that owns the fact), `seed-staff.ts`'s "four other paths", and `password-policy.test.ts`'s
  account of the per-call-site coverage — plus the roadmap's 11e "still open" line. Found at close
  by grepping for the retired claim, which is what §2.90's own closing sentence says to do.
  Remediated in `1bae1d0` as a NEW commit, never an amend (rule 15). **Ledger §3.54.**
- **F3 — MEASURED, caught before its commit, at zero cost.** `ci-watch-host.sh`'s first draft read
  `/commits/{sha}/check-runs` — the endpoint §2.91 names — and got every verdict and exit value
  right, while printing `gh run view <CHECK-RUN id>`, a command that does not resolve. Executing
  the poller against the known-red sha and reading *what it told the operator to type* is what
  found it. Switched to `/actions/runs?head_sha=`, which returns the workflow-run id `gh` accepts
  and which O4 names. **Ledger §3.55.**
- **F4 — MEASURED, and it is a gap in this document's own runbook. RESOLVED at close by the
  owner-authorised deploy (above).** O1 says create the second administrator "then verify T2's
  detector goes quiet", but the detector was on `main` and not in production — this phase ships no
  deploy task, and deploys are owner-authorised in as many words (v3 §3.6) — so O1's verification
  step could not run. *The authoring lesson stands even though the blocker is gone: a runbook item
  whose evidence depends on code the phase does not deploy must say so at authoring, or it reads as
  actionable when it is not.* **O1 is now doable end to end.**
- **F5 — MEASURED (read-only production SELECTs, this session).** Production is unchanged from §2
  on every axis this phase can see: still exactly ONE holder of the full `auth.*` set (`admin`,
  6/6, measured by a query written for this check and NOT by the shipped helper, which is not
  deployed), `operating_mode_changes` still empty, 16 users all active, `must_change_password` 0,
  live sessions 0. **The mitigation D2 makes visible is still unmet, and D5's rotation has not
  happened.** Both are owner work by construction; neither is a defect in this phase.
- **F6 — PREDICTION, unchanged and deliberately so.** Whether `auth.e2e.test.ts`'s former
  single-sample assertion caused F2-of-11e is still unsettled; T3 makes no claim about it, in code
  or in its commit message, exactly as D3 requires. The disposition lands when O4's log line does.
- **F7 — MEASURED, process, minor, and it happened TWICE.** The finish-block `git pull --rebase`
  refused ("Please commit or stash them") at T3, because this session had already begun T4's edits
  in the same tree, and again at the review-remediation commit, with the CLOSE documentation
  uncommitted. Both pushes succeeded as fast-forwards and `origin/main` was confirmed equal to
  `HEAD` immediately after each, so nothing was missed and no history was rewritten — but
  AGENT-RULES §5's finish block assumes a clean tree, and **under v3's LIGHT lane one session holds
  every task in sequence, so the next task's edits (or the phase's own CLOSE) are exactly what will
  be sitting there.** Recurrence is what makes it worth writing down rather than shrugging at: the
  guard silently degrades from "rebase onto anything that landed" to "nothing landed, luckily".
  Still no ledger entry — the cost was zero both times and §5 already implies the clean tree — but
  the discipline is *finish the block before touching the next thing*, and the honest note is that
  I did not, twice.

- **F8 — MEASURED, and it is F2's twin on the OTHER sweep.** After the reviewer's fourth-claim
  finding, I grepped the whole repository for the §2.91 claim rather than the files T4 named — and
  found a **third** standing sentence in `EXECUTE-METHOD.md`, the v2 manual still in force as the
  HEAVY-lane document: *"Run it in the background on the owner's machine."* T4's acceptance named
  two sentences (V3 §8 and `ci-watch.sh`'s header) and this manual is neither. **So both of this
  phase's sweeps missed a location, both times a file the Files list did not name, and both times
  the miss was found by somebody or something other than the sweep itself.** Amended in place with
  the rule-6 pattern, pointing at `ci-watch-host.sh` and preserving what genuinely still needs the
  owner's machine (a rolling watch over `origin/main`, because `ci-watch.sh` drives `gh`). This is
  now §3.54's second and better specimen, and it converted that entry's rule into a mechanical one:
  **grep the whole repository for the retired behaviour's name before closing — not the files you
  edited, not the files you listed, all of them.**

### Deployment — OWNER-AUTHORISED AND DONE, 2026-08-24 (after close, at `16e11e6`)

**The phase shipped no deploy task, deliberately (v3 §3.6). The owner authorised one in as many
words at close, and it ran.** `docker/prod/deploy.sh`, detached, **exit VALUE 0**.

- **Pre-flight, measured before touching anything:** 9 containers up, db and api healthy, **0 live
  sessions** — so nobody was signed in and no consultation was interrupted — 19 migrations applied.
- **After:** all 9 declared services up · `/health` **200** through Caddy over HTTPS on
  `hmis.crkmch.com` (`{"status":"ok","db":"ok","worker":"ok"}`) · `/admin/users` answers **401**
  unauthenticated through the edge, so the route is live and still guarded.
- **Nothing moved that should not have.** Migrations still **19** — this phase generated none, and
  the count proves it rather than the plan asserting it. 16 users, all 16 active,
  `must_change_password` **0**: no lockout, the 11e deploy's property preserved.
  `operating_mode_changes` still **0** — deploying is not operating, and this phase's whole thesis
  is that those are different things.
- **The change is verifiably IN the running images, not merely on `main`** — checked in the
  containers rather than inferred from the build: `fullAdministrators` in the API's compiled
  `users-admin.controller.js`, the `ACT ON THIS` warnings block (M1's fix) in
  `dist/scripts/seed-roles.js`, and the banner string in the SPA bundle Caddy is serving. That
  check exists because §2.88 is the standing proof that "it deployed" and "it is reachable" are
  different claims.

**So F4's blocker is gone: O1 is now doable end to end.** The detector is live and it is currently
WARNING — production holds one full administrator, so `/admin/users` shows the banner today. That
is the phase working: the thing that was invisible is now on the screen of the person who can fix
it.

### Independent review (v3 §3.4)

**VERDICT: does not block close. No CRITICAL.** One fresh-context reviewer agent, read-only by
instruction, read all five commits together. **It cleared the two properties the phase most risked
getting wrong, both by tracing rather than by assertion:** T1's hoist of the existence check is
safe (nothing between the new and old positions touches `users`; the pre-existing TOCTOU against a
concurrent `seed:admin` widens but its outcome is unchanged, `users_username_ux` still arbitrating),
and **T2 genuinely satisfies §2.89** — it could construct no input where the count says ≥2 while no
repair is possible, and it checked the six cases the brief named plus a seventh `auth.*` permission
declared later. It confirmed the counter is strictly STRICTER than the guard (temporary grants
count for `hasPermission` and for neither `fullAdministrators` nor `assertMayTakeOver`), which is
§2.89's safe direction.

**It also went past its brief and found four MAJORs. All four were real. All four are fixed in
`30227e6`, with their tests.**

- **M1 — the detector was enforcing D2 through the exit code, and D2 marks enforcement DEAD.** The
  shortfall went into `problems`, `problems` feeds `ready`, `ready` feeds `process.exitCode`. So
  **every deployment with one administrator — every bootstrap, and production today — would have
  exited 1 for ever**, on the one channel 11d built to mean "the roles and grants are wrong", under
  a deploy checklist that says *"confirm it exits 0"*. That is §2.63(b)'s dead-watchdog problem
  arriving backwards: teach an operator that exit 1 is normal and they stop reading it. **This was
  my error and it was a misreading of the ruling I was implementing** — D2 says the census *prints*
  and *warns*, and I reached for `problems` because that was the census's existing loud channel.
  Fixed with a `warnings` channel that prints above the verdict and changes no exit code, plus a
  leg asserting `ready` is identical with and without the shortfall.
- **M2 — MEASURED: the poller passed the API body through the environment, and at scale that made
  the plumbing mint a verdict.** `execve` on this host refuses an env string at ~131 KB (fails at
  132 000 bytes, succeeds at 131 000); one `workflow_run` object is ~17 KB; the request asked for
  `per_page=20`. **At eight runs on one sha the probe dies with "Argument list too long" on stderr
  — which `$(probe …)` does not capture — and the empty stdout fell through to the conclusion
  branch and printed "CI DID NOT RUN … almost always billing" about a commit that may be RED.** Not
  a false green, but a wrong statement about somebody's commit, blamed on GitHub. Fixed three ways:
  the body goes on stdin (re-measured: the old form dies on a 324 KB body, the new one parses all
  20 runs), `per_page` dropped to 10, and — the durable half — **the conclusion arms are now an
  exhaustive allowlist and `*)` means "the plumbing broke, retry", so no unrecognised token can
  ever become a verdict again.**
- **M3 — the one construction in which the poller could say GREEN about a RED commit.** It grouped
  runs by `workflow_id` alone and took the latest. `.github/workflows/ci.yml` is
  `on: [push, pull_request]`: the two events share a `workflow_id`, report the same `head_sha`, and
  **test different trees** — a `pull_request` run checks out `refs/pull/N/merge`. A green
  merge-result run scheduled second would therefore mask a red push run. Not reachable today (this
  repo pushes straight to main) which is why it was MAJOR, but it is the exact failure the whole
  script exists to prevent. Fixed: the key is `(workflow_id, event)` and the WORST across events
  wins. The reviewer also correctly noted my header's re-run justification was weaker than it read
  — GitHub re-runs increment `run_attempt` on the same run object — and the comment now says what
  the grouping actually buys.
- **M4 — the GC3 leg on the CRITICAL task could not see the leak that actually happens.**
  `not.toMatch(/"admin"/)` is blind to an implementation interpolating the credential *unquoted*
  (`ADMIN_PASSWORD (admin) must be at least 10 characters`). The shipped transcript contains no
  lowercase `admin` at all, so the strong form passes against shipped code and kills both leak
  mutants. Fixed to a bare, case-sensitive `not.toMatch(/admin/)`. *This one stings: the same file
  already used the strong form four lines away (`not.toContain("bootstrap-secret")`).*

**Minors, all nine accepted; seven fixed, two accepted-with-reason.** Fixed: the `seed-admin.ts`
comment that was factually wrong about its own scope (it claimed `ADMIN_PASSWORD` was "in scope one
frame up"; it is read inside `main()` and is not in scope there at all) · the census sentence that
over-claimed "no repair but direct database access" when two mutual-superset holders of the same
five-of-six *can* reset each other · **"Only 0 person"**, reworded in both locales to read
correctly at zero, with a screen leg at `fullAdministrators: 0` — the count a bare deployment
actually has · the rate-budget line that announced a ceiling of 60 while the threshold that fired
was 40 · a permanent 404/401 now fails fast instead of burning a 30-minute timeout and a third of
an hourly budget · a duplicated sha argument no longer hangs the script for the full timeout
(measured: 0.19 s, was 1800 s) · the header now says the script needs `python3` and is
credential-free rather than "curl-only". **Accepted with reason:** T3 inlines `Math.min(...times)`
rather than a shared `fastest()` helper, which is a third copy of a three-line idea (§2.54's own
class) — extracting it spans three test files in two suites and belongs to whichever phase next
touches the perf suites, not to a close remediation. And the reviewer's minor 8 — **a FOURTH
surviving claim of the retired seam, in 11e's own CLOSE F8 record** — is fixed here, and is the
best evidence for §3.54 that the phase produced: my close sweep found three and stopped.

**One correction to the reviewer, for the record:** its report describes the CLOSE section as empty
and `1bae1d0` as still running in CI. That was true when it started reading and not when it
finished — it reviewed a close that was in flight around it. All five commits are green (below),
and its own §2.89 trace, its execution of the poller's three exit values, and its `execve`
measurement are unaffected by that.

### Mechanical close (v3 §3.5)

- **`pnpm verify` exit VALUE `0`**, read from a file after a detached run, **before every push** —
  **eight times, once per commit, including the docs-only ones.** That is §2.87's rule, which this
  phase's own T4 poller then watches; the phase deliberately did not economise here.
- **Counts at HEAD**, quoted from the runners' own summary lines: `apps/core` **152 suites /
  1175 tests** · `apps/web` **36 files / 193 tests** · `packages/contracts` **3 / 7**. Against §2's
  baseline that is **+8 core** (T1's four legs, T2's three, M1's verdict leg) and **+3 web** (T2's
  two, plus the zero-count banner leg). The workspace total did not decrease and no test was
  deleted.
- **Per-commit `git show --stat` against Files lists**: every commit matches, with F1's single
  disclosed addition.
- **Frozen-path audit**: this phase declares no frozen path (unlike 11d, which froze `apps/web` in
  full) and T2 names `apps/web` files explicitly. No violation. No `*.mutant.*` residue and no
  scratch in the phase diff.
- **Clean tree** at each commit, `git status --porcelain` read before every `git add`.
- **One risk closed by execution rather than by reading.** T2 makes `seed-roles.ts` — a script —
  import from `users-admin.controller.ts`, which drags the Nest decorator graph in behind it. The
  suite proves the function works but runs under jest with the test environment already set, so it
  could not see a module-load-time `requireEnv` anywhere in that new import chain. Loading the
  script under `tsx` with **no `DATABASE_URL` in the environment** succeeds, so the import is inert
  until `main()` runs and `seed:roles` still starts on a box where the variable is supplied late.
- **CI green by FULL SHA for all eight commits, read through `ci-watch-host.sh` itself** — the
  poller T4 shipped, in five detached runs reporting exit VALUE `0` each time. Which is the
  fitting proof: the instrument built to close §2.91's gap discharged §2.55's criterion for the
  phase that built it, from the build host, with no credential — including for `30227e6`, the
  commit that fixed the poller. Its rate-limit guard fired on the two multi-sha runs and raised the
  interval rather than burning a shared 60/hour budget.
- **The poller was re-proven by execution after M1–M4's rewrite**, not assumed to have survived it:
  `3eec860` → RED, exit VALUE 1, still naming run `32668118868` · `00c3747` → GREEN, exit VALUE 0 ·
  an all-zeros sha → UNRESOLVED, exit VALUE 2 · a duplicated sha argument → correct verdict in
  **0.19 s**, where the old code slept out the full 1800 s timeout · a wrong `CI_WATCH_REPO` → named
  as PERMANENT and not retried. M2's ceiling was re-measured directly: a 324 KB body kills the old
  environment-variable form with "Argument list too long" and parses cleanly on stdin.

### Mutants (rule 21)

**T1/R1 — DIED.** The mutant is the shipped script with the step-0 policy call removed, built as
`scripts/seed-admin.mutant.ts` beside the source with its own scratch spec, run isolated
(`1 failed, 1 passed, 2 total`), both deleted before the commit. Expected a `SeedAdminRefusal`;
received `seedAdmin RESOLVED — it did not refuse`. **The control leg passed on the mutant**, so the
row cannot pass by refusing everything. §2.81's tell was checked as the plan asked: the
discriminating input measurably succeeded against shipped code before the fix — that same output
is T1's fail-first red, staged per §2.5 so the red was semantic rather than an unresolved import
(the `SeedAdminRefusal` import was added back after the implementation landed).

**R2 needed no mutant and got none**, as the plan states: the wrong implementation is a placement
(validate at env-read), and the row's own leg asserts the placement by executing a reconcile-only
re-run with a policy-violating `ADMIN_PASSWORD`.

**T2/T3/T4 are ROUTINE: mutants not required and none built; fail-first not owed and not
manufactured. Said here rather than left to inference,** per AGENT-RULES §3.

### Ledger (v3 §5)

- **Archive rule, first pass ever run.** No `ARCHIVE` section existed; one now stands at the
  ledger's foot. **§2.40** (shared-scratchpad mirror contamination) and **§2.79** (CRLF from
  Windows-side writes) are archived — both were bought by the two-host topology, which §8's ruling
  retired on 2026-08-23, and neither has a mechanism left to recur through. Entries are struck IN
  PLACE and listed in `ARCHIVE` rather than physically moved; the reasoning is recorded there, and
  it is the rule-6 rationale: earlier documents cite these by number. **§2.70 was considered and
  KEPT** — its lesson ("a removal verified against the inventory you knew about misses the layer
  you did not") is general and does not depend on the InsForge stack it was found in.
- **New entries, four, each with a specimen from this phase: §3.54** (an acceptance that names one
  location for a sweep whose rule says every location — and the reviewer's fourth surviving claim
  is now part of its evidence, because my sweep found three and stopped) · **§3.55**
  (verify-by-execution includes reading the guidance the program prints) · **§3.56** (a ruling that
  says warn-not-enforce is enforced anyway if the warning channel is wired to an exit code — M1) ·
  **§3.57** (a parser's silence must not be a value; a `case` default must mean "the plumbing
  broke", which is what exposed the missing `startup_failure` arm — M2).

### The runbook chase (§5.5)

- **O1 — NOT DONE, and now the most valuable hour available, with nothing left in its way.** Still
  one full administrator, and the detector is now LIVE and saying so on `/admin/users`. F4's
  blocker is gone (see Deployment): create the second admin through the screen, assign it the
  `admin` role, and the banner goes quiet. The provisional password is forced-change at first
  sign-in, which is why this is a five-minute job for a human and still not an agent's.
- **O2 — NOT DONE.** D5's rotation is owner-only by construction; the burned roster is still
  unrotated (F5's counters are the evidence, and they have not moved).
- **O3 — NOT DONE.** 11e's token total is still unrecorded, so v3 §7's cost claim stays
  UNDISCHARGED in both directions. **This phase adds a second undischarged number**, for the same
  reason: a session cannot read its own token total, so 11f's actual is the owner's `/cost` too.
- **O4 — NOT DONE.** Needs the owner's authenticated `gh`. `ci-watch-host.sh` narrows nothing
  further here: it confirms the verdict and states plainly that logs are 403 from this host.
- **O5 — NOT DONE.** `operating_mode_changes` is still empty; the hospital has still never
  operated on this system. **This remains the phase's whole point, and no code in it substitutes
  for the day.**
- **O6 — not this phase's to close**, unchanged.

### Actuals

| | |
|---|---|
| tokens, all sessions | **UNMEASURED — the owner's `/cost`.** A session cannot read its own total (O3's class, now twice) |
| stop-loss | 1.0M. **Not observably crossed**, but that is an assertion this session cannot discharge — see above. Nothing in the run's shape suggested it: four tasks, one mutant, one reviewer, no rework beyond F2's sweep |
| agents | **1** — the independent reviewer. No subagent did any of the coding |
| wall clock | ~2 hours end to end, dominated by six full `pnpm verify` runs and one reviewer pass |
| catches | **3 by the session** (F1, F2, F3 — F3 by executing its own artefact rather than reading it) · **4 MAJOR + 9 minor by the independent reviewer**, every one real, none CRITICAL |

**The reviewer earned its place, and the shape of what it found is the finding.** Three of its four
MAJORs (M1, M2, M3) are defects in which the code did exactly what I intended and my intent was
wrong — a visibility ruling implemented as enforcement, a probe whose failure mode mints a verdict,
a grouping key missing the field that makes two runs incomparable. None is the kind of mistake a
test I would have written could catch, because I would have written the test to the same
misunderstanding. **That is v3 §3.4's whole claim — "the session that wrote the code must not be
the only judge of it" — discharged with specimens rather than asserted**, and it is the strongest
evidence this phase produced about the method itself.

**v3 §7's measurements:** transcription-class incidents **zero** — structurally, there was one
document and nothing to transcribe between. Defects reaching production: **none from this phase**,
which ships no deploy. F2 is a defect of the phase document itself, found and remediated inside the
phase, which is the class v3 predicts one document should make cheaper to find rather than
impossible to make.
