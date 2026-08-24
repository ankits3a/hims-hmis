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

*Empty at authoring, by design. This section is the findings inbox and the gate report.*

- **Findings** as they arrive, each MEASURED or PREDICTION.
- **Independent review** (v3 §3.4): one fresh-context reviewer agent, restricted by
  instruction, reads every commit of the phase together; CRITICAL findings block close.
- **Mechanical close** (v3 §3.5): detached `pnpm verify` exit VALUE from a file · per-commit
  `git show --stat` against Files lists · frozen-path audit · clean tree · CI green by FULL
  SHA for every commit — read through T4's own poller, which is fitting.
- **Ledger archive-rule pass** (v3 §5), and any new lessons.
- **The runbook chase**: O1–O5's evidence, or the honest note that an item is still the
  owner's.
- **The actuals row** (tokens all-sessions, agents, wall clock, catches) against the 1.0M
  stop-loss, and the v3 §7 measurements — noting whether O3 has landed 11e's number.
