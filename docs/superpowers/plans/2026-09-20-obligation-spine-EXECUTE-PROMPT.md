# EXECUTE PROMPT — the obligation spine, phase O

**For the executing session (Opus), on the build host. Paste this file's path as the seed; read
nothing else first.**

---

## 0. What you are, and what you are not

You are the **main session of a phase under EXECUTE-METHOD-V3**, executing
`docs/superpowers/plans/2026-09-20-obligation-spine-IMPLEMENTATION-PLAN.md` (on `main`).

- **You code, task by task, sequentially, yourself: T3 → T1 → T4 → T5 → T6 → T7 → T13 → T11 → T8
  → T9 → T10 → T12.** No coding subagents. No Workflow tool. Subagents are for exactly one thing:
  the two independent close reviewers (V3 §5A, §9.7, §9.10).
- **One lane, one PR per task.** `tools/lane.sh new oblig-t<N>` per task, from `origin/main`;
  rebase before opening the PR; squash-merge when CI is green; drop the lane. **Every jest or vitest
  run goes through the test lock** (CLAUDE.md "Verify"): `$L run oblig-t<N> …`. Two pools OOM the box.
- **Phase R (the roster backbone) is executing in parallel** on lanes named `roster-r<N>`. Before
  T1 and before T5 read `tools/lane.sh status` and `gh pr list --search roster-r`; plan §5 says
  what to do in each case. Never race a lane on `kernel/workflow/timers.ts` or
  `kernel/alerts/consumer.ts`: rebase minutes before, one commit.
- You are **not** authorised to deploy, to run anything against `/opt/hmis-prod*`, to widen your
  own permissions, to edit `packages/contracts/*`, `kernel/copilot/*`, `kernel/auth/*` beyond
  `ROLE_MODEL` grants, or the sixteen approval type keys (plan §5 "Frozen").
- **Stop-loss: 1,100,000 tokens for T3–T11.** If you approach it, stop after the current task's PR
  is green and write the handoff (V3 §9.6). Do not re-tier. T8, T9, T10, T12 are ROUTINE and may
  be handed off whole.

## 1. Read, in this order, before the first tool call

1. `CLAUDE.md` at the repo root — the lane, the lock, the shared files.
2. `docs/superpowers/AGENT-RULES.md` — in full (rule 21: build the mutant, never predict it; §5
   the finish block; §6 migrations are irreversible).
3. `docs/superpowers/EXECUTE-METHOD-V3.md` — §3, §5A, §6, §9.1, §9.6, §9.7, §9.8, §9.9, §9.10 only.
4. The plan: `docs/superpowers/plans/2026-09-20-obligation-spine-IMPLEMENTATION-PLAN.md` — in
   full. It is the only plan you execute.
5. The phase doc's DECIDED table and the R2 ceiling table:
   `docs/superpowers/plans/2026-09-20-phase-obligation-spine.md` §DECIDED and §R2 only.
6. The edge register, in full (it is the test list):
   `docs/superpowers/brainstorms/2026-09-20-obligation-spine/02-EDGE-CASES.md`.
7. **The three measured dossiers, ONLY the section a task cites, when you reach that task:**
   `03-MEASURED-workflow-timers.md` (T1, T6), `04-MEASURED-notify-alerts-web.md` (T3, T4, T9,
   T12), `05-MEASURED-approvals-auth-migrations.md` (T5, T7, T8, T11, T13). They were measured on
   `main` @ 21fe8912; **re-measure every line you are about to edit** — phase R moves some of them.
8. Precedents each task transcribes: `kernel/alerts/consumer.ts` `handleApprovalRequested` (T2,
   #267 — the branch shape, the GC6 mutant test T2-3), `schema/radiology.ts:529-532` (the
   half-an-acknowledgement CHECK), `drizzle/0107_pharmacy_authorisations.sql` (CHECKs and the
   same-actor constraint), `git show 775a85da` (the four-edit permission recipe),
   `schema/retention.test.ts` (the census shape), `modules/aerb/` (a leaf module's wiring).

Do **not** read `EXECUTION-LESSONS.md`, the plan-series index, the department brainstorm series,
the project brief, `00-FABLE-REVIEW.md` or `01-STAFF-CENSUS.md` unless a task points at a section.

## 2. Before T3 — the kickoff block, recorded in the plan's §9.1

1. Re-measure every row of plan §1 with the command in its `how` column; correct the plan in place
   where a value moved. **G1 decides every migration serial** (`drizzle-when-silently-skips` trap
   4: free ≠ reachable — take the serial after the one on `main`, at rebase; drop the lane test DBs
   after any rebase that brings in a migration you did not have). **G2 and G3 decide sequencing**:
   merge #265 first if it is still open; if R6 has merged, T1 and T5 wrap its `whoIsOn` seam.
2. Confirm G8 (`Etc/UTC`) on your lane test DB: T7's five IST instants are only evidence if the
   session is UTC.
3. Run `alerts/consumer.test.ts` once (17/17) and keep that number: V20 says it never moves.

## 3. Executing the tasks

- **Tiers:** T1, T3, T5, T6, T7, T11, T13 CRITICAL; the rest ROUTINE. Every CRITICAL task builds
  its mutants as `*.mutant.ts`, runs them, records the kill in §9.5 (the assertion that failed,
  quoted), and never stages them.
- **Fail-first is literal:** a new test is red against the code it guards before it is green. For a
  DB CHECK the test writes rows *underneath* the domain code (the census suites do); a domain
  pre-check keeps a domain test green after the constraint is dropped.
- **Migrations:** one per PR; hand-carry every CHECK into the generated SQL and prove each from
  `pg_constraint` in the census test; generate on a **clean tree** (trap 3); never regenerate a
  migration that has merged; nullable additive columns on shipped tables only.
- **Pinned censuses** (`seed-roles` ×~12 per permission including the two bare-integer arrays,
  `manifests`, `standup-check`, the four job censuses + `alerts.yml`, `caddyfile-parity`, the
  templates whole-array, the alerts subscriptions array, `events.test.ts` "five names"): run them
  red, read the number off the failure, never predict it.
- **Verify discipline:** `pnpm typecheck && pnpm lint` before every verify; the suites you touched
  under the lock; the full core suite belongs to CI. Paste counts in the PR body. A test you did not
  run in that state is not green. `alerts/consumer.test.ts` 17/17 in every PR that touches alerts.
- **Commit hygiene:** stage by explicit path; `git status --porcelain` shows no `*.mutant.*`, no
  scratch, no foreign-lane file. Never `git add -A`. Never rewrite pushed history.
- **The five things the review found, restated so they cannot be lost in a build:** (1) the shipped
  `escalation` chain is a chain of deltas anchored on the breach and seven tests pin it — T1 ADDS
  `ladder`, it does not re-time `escalation`; (2) silence and lateness are two clocks — an ack stops
  the respond timer and never the budget; (3) the requester is never an addressee and the second
  approver is a third person; (4) attribution is to the RUNG until phase R's resolver can say who
  could have acted; (5) nothing external ever carries a patient, a staff health fact or a rupee
  amount — kind, lane, minutes, link.

## 4. CLOSE (after T11, before T8)

1. Fill the plan's §9.1–§9.5.
2. Write `test/obligation-spine.e2e.test.ts` (plan §6: the definition of done as one test).
3. ONE fresh reviewer, restricted tools, briefed at the operands (V3 §9.7): the phase's commits,
   `AGENT-RULES.md`, the plan's §2–§4, the edge register, the invariant table (plan §3) as the
   checklist — every V-id must be pointed at by a named test.
4. Remediate; a SECOND fresh reviewer over the remediation diff only (§9.10). Write §9.6.
5. `/token-audit`; record the actuals row (§9.7).
6. Commit the plan by path. **Do not deploy.** Report: the migration serials actually written, the
   pinned counts after T3 and after T11, the mutant tally, the e2e result, and which of T8 / T9 /
   T10 / T12 were built or handed off. Then continue with the ROUTINE tasks if budget remains.

## 5. If you must hand off mid-work

Spend the remaining budget in this order: (1) `pnpm typecheck`, (2) the narrowest suite covering
what you changed, under the lock, exit value read, (3) the handoff note (V3 §9.6) in the plan's §9.
Uncompiled, unrun code is UNKNOWN and is reported as such.
