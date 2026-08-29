# EXECUTE PROMPT — Plan 18a, Radiology & Imaging CORE

**For the executing session (Opus), on the build host, in `/opt/hmis`.** Paste this file's path as the seed; read nothing else first. **NOT APPROVED until the owner says so in this session's own words.**

---

## 0. What you are, and what you are not

You are the **main session of a LIGHT-lane phase under EXECUTE-METHOD-V3 §3**, executing
`docs/superpowers/plans/2026-08-29-phase1-18a-radiology-core.md` (commit SHA: the one that carries this file — `git log --oneline -3 -- docs/superpowers/plans/2026-08-29-phase1-18a-radiology-core.md`).

- **You code, task by task, sequentially, yourself.** Nine tasks, T1→T9, in order. No coding subagents. No Workflow tool. No compiled pipeline.
- **Subagents are used for exactly one thing: the independent close review** — one FRESH reviewer after T9; a SECOND FRESH reviewer over the remediation if the first found anything (and it will — 14, 15, 22c-A and 17 phase 0 all did). Never resume a reviewer (v3 §9.5, ledger §2.115).
- You are **not** authorised to deploy, to widen your own permissions, to run anything that WRITES against `/opt/hmis-prod` (S6 is a READ-ONLY query), or to edit anything under `kernel/auth/`, `packages/contracts/` or `modules/patients/`. The four kernel edits you ARE authorised to make are named in the phase doc §8.12 and nowhere else.
- **Stop-loss: 736,000 tokens** (phase doc, THE LANE). If you approach it, stop and report — do not re-tier, do not skip the second reviewer (§2.140).

## 1. Read, in this order, before the first tool call

1. `docs/superpowers/AGENT-RULES.md` — in full. Rule 3 (no `/tmp`, and the heredoc alternative), rule 7 (a scratch database you name, use and drop), rule 20 (READ the `pgrep` lines), rule 21 (build the mutant, never predict it), §3 (mutant discipline by tier), §5 (finish block), §6 (migrations are irreversible host mutations).
2. `docs/superpowers/EXECUTE-METHOD-V3.md` §3, §6, §9.1, §9.5, §9.6, §9.9 (rules 4–8: preflight `pnpm typecheck && pnpm lint` before every verify; fold code-complete tasks into one verify; tree frozen while a verify runs; grep the sibling AND the list; your own test databases, NAMED).
3. `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` §1, §2, §7 — then §4 of THIS file, which supersedes its "queue behind the other session" with the private-database rule.
4. The ledger `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` — **§5 only. MEASURE the line: `grep -n '^## 5' …` (1485 at write time; it moved 162 lines in one day).** Never the whole file: 407 KB, re-billed per tool call. Entries the phase doc cites by number (§2.54, §2.115, §2.131, §2.137, §2.138, §2.139, §2.140) are read by number, with `grep -n '^\*\*2\.NNN '` and a bounded `sed`.
5. `docs/superpowers/plans/2026-08-29-phase1-18a-radiology-core.md` — the phase document, in full. It is the only plan you read whole.
6. `docs/superpowers/plans/2026-08-29-phase1-17-order-envelope.md` — **§4.1 (lines 145–296), §6/§6A/§8 (lines 297–374) ONLY.** Do not read the rest: 112 KB.
7. The precedents the tasks transcribe, when the task arrives and not before: `apps/core/src/modules/ot/gates.ts`, `ot/workflow-def.ts`, `ot/definitions.ts`, `ot/approval-types.ts`, `ot/manifest.ts`, `ot/cockpit.ts:130-180` (assign-first), `ot/consents.ts`; `apps/core/src/kernel/orders/place.ts`, `advance.ts`, `read.ts`, `envelope.e2e.test.ts` (the model for T9's e2e); `apps/core/src/kernel/resources/kinds.ts` (the collector T2's `device` declaration must satisfy); `apps/core/src/kernel/episodes/series.ts`; `apps/core/src/kernel/auth/totp.ts:37-58`; `apps/core/src/modules/opd/walk-in.ts:41-80`; `apps/core/src/modules/billing/idempotency.ts:52-80`.

Do **not** read the brainstorm series. The phase doc §7 already drew from it; if a task genuinely needs one row, `grep -n '^| N2 '` the file and read that line.

## 2. Before T1 — the kickoff block, recorded in the phase doc's §9.0 and §9.3

1. **Run the parallel-session pre-flight (protocol §2)** and READ it. `git status --porcelain` will show files you did not write — at write time `apps/core/scripts/seed-roles.ts` was already modified by another lane, and `docs/design/` was untracked. **They are not yours to stage, revert or tidy.**
2. **Re-measure every row of §2** of the phase doc with the command in its `how` column, and correct the doc in place where a value moved. **Rows 1, 3, 4, 8, 9, 11 are the ones Lane A moves.** Row 1 decides your migration number: the doc reserves **`0046` as a measurement** — if the journal has grown, you write the next free number, say so in T1's commit message, and never rename or hand-edit `drizzle/meta/_journal.json`.
3. **Answer the spike S1–S8** by reading code and read-only SQL. Record answers in §9.3 before touching T1. **S8 is the one that changes your Files lists**: if Lane A has landed the PHI call in `read.ts` (surface `orders.patient`) or a widened `PhiSurface`, T3 REUSES them and APPENDS only its four names (§2.54). Nobody writes `addOrderItem` — DD10c and Lane A's DD9 agree an add-on is a new order. S1 changes T1 (a CHECK to widen or not); S2 changes T3 (one OPD export or none); S3 changes T7; S4 changes T2; S5 changes T8's window; S7 changes T8's publish shape.
4. **Take your test databases** — §4 below — before the first `jest`.

## 3. Executing the tasks

- **Tier per task as the doc rules:** T1 ROUTINE · T2 CRITICAL · T3 CRITICAL · T4 CRITICAL · T5 CRITICAL · T6 CRITICAL · T7 CRITICAL · T8 CRITICAL · T9 ROUTINE. Every CRITICAL task's Assertion Book mutants are **built as `*.mutant.ts` scratch beside the source, run ISOLATED with the isolation line quoted, DIED/SURVIVED recorded with expected vs received**, then deleted before commit. A surviving required-DIED mutant is disclosed per AGENT-RULES §3, never fixed silently. **T5 A7 and T2 A2 are pins of KERNEL guards, not mutants of yours — record them as such rather than manufacturing a mutant.**
- **T1 generates the migration.** Re-check `_journal.json` immediately BEFORE and AFTER `db:generate`. Generate only when you are ready to carry it to a commit (§6). Hand-carry the CHECKs, the two partial uniques and the two triggers the way `0044`/`0045` did. Every table joins `truncateAll` in the statement §4.1 names, and T1's test proves each one empties.
- **T2 appends TWO manifests** (`pcpndt` then `radiology`). Find every census with BOTH greps — `grep -rn 'otManifest' apps/core --include=*.ts` (the sibling, for the places that NAME it) and `grep -rn 'ALL_MANIFESTS' apps/core --include=*.ts` (the list, for the places that COUNT it) — directory and glob, never a file list (§9.9 rule 7). The seed-roles pins, the README parity table and `manifests.test.ts`'s six-omitted list all move or are pinned unchanged; say which.
- **T3 lands the worker consumer WITH its handler and the `workerConsumers` entry in ONE commit** (the `partnersManifest` rule — a declared subscription with no handler is a boot error).
- **T6 seeds NO registration.** The module refuses every applicable scan until the owner's runbook creates one; T9's e2e creates a fixture registration in the test the way `test/helpers/ot.ts` creates definitions — through the real functions, never by inserting a row.
- **T7's transaction order is the task.** `assignResource` before `advanceOrderItem`; `assertFormFRecorded` before any write in `recordAcquired`. A1 and A2 each have a mutant that swaps the order — build both.
- **T8's sign takes the SESSION.** The controller passes it; `signReport` calls `secondFactorFresh`. No route reaches `signReport` without a session object, and the test for A1 constructs one with `secondFactorAt` on both sides of the window.
- **Verify discipline:** `pnpm typecheck && pnpm lint && echo PREFLIGHT OK` first, exit value read; then ONE `pnpm verify` per batch of code-complete tasks (T1+T2, T3+T4, T5+T6, T7+T8, T9 is the natural batching), detached, exit value read from a file under `/opt/hmis`, tree frozen until it returns, **one blocking waiter and no hand-polling** (§2.130). Commit per batch (message separates tasks); watch CI by full SHA with `docs/superpowers/pipelines/ci-watch-host.sh`.
- **Commit hygiene:** stage by explicit path only. `git status --porcelain` READ before every `git add`; no `*.mutant.*`, no scratch, no `.exit`/`.log`, no foreign-lane file in your staged set. **Never `git add -A`, never `git add <directory>`.**
- **Frozen surfaces you must NOT touch:** `kernel/resources/kinds.ts` and `resources_kind_ck`; everything under `kernel/orders/` except the `recordPhiAccess` call in `read.ts` and its test, and only if Lane A has not landed it (§8.12); `kernel/auth/*` (you CALL `totp.ts`); `packages/contracts/*`; `modules/patients/*` (you CALL `allergies.ts`); `modules/opd/*` beyond the ONE export S2 may require; `modules/ot/*` (you IMPORT `consentSchema`); `modules/billing/*` (you IMPORT `withIdempotency`, `settlementState`); `kernel/worker/scheduler*` (no job).

## 4. THE PARALLEL LANE — Lane A (Plan 17, LIMS) may be EXECUTING in this checkout while you do

Four files collide by construction, and both lanes edit all four. The rule for each:

| file | the rule |
|---|---|
| `apps/core/src/kernel/modules/manifests.ts` + `manifests.test.ts` | the count and the ordered key list are **MEASURED, never remembered**. Whoever lands second `git pull --rebase`s and re-reads them before editing |
| `apps/core/scripts/seed-roles.ts` + `test/seed-roles.test.ts` + the README table | **five censuses, and a sibling-grep finds only two** (§2.138). Grep the LIST: `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts`. This file was ALREADY modified by another lane at write time — pull before you touch it, and stage only your hunks by path AFTER confirming `git diff` shows only yours (if it shows theirs too, STOP: it is not yours to commit) |
| `apps/core/test/helpers/db.ts` | a table absent from `truncateAll` is NEVER EMPTIED; a table whose parent is truncated must be in the parent's OWN statement. Both lanes append; rebase and re-read |
| `apps/core/drizzle/` | **next free was `0046` at write time and BOTH lanes want it.** Re-check `meta/_journal.json` immediately before AND after generating; state the number you took in your commit message; **if you collide, renumber YOURS (rename the `.sql`, the snapshot, retag the journal entry) — never the one already pushed** |

**Plus two kernel seams both lanes reach for** — the `recordPhiAccess` call in `kernel/orders/read.ts` (agreed surface name `orders.patient`) and `PhiSurface` in `kernel/phi/audit.ts`. **First to land writes the call; the second REUSES it and APPENDS its own surface names** (Lane A: `lab.results`, `lab.report`; Lane B: `imaging.worklist`, `imaging.study`, `imaging.report`, `pcpndt.form_f`). S8 is where you find out which you are.

**Your test databases.** `test/helpers/db.ts` derives the worker database name from `TEST_DATABASE_URL`, so:

```
TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch" pnpm --filter @hmis/core exec jest …
```

and the same prefix on `pnpm verify`. Measured on phase 0: 105 failures at load 18.70 → green at 2.35 with nothing changed but the box. **Two obligations come with it (§2.137, v3 §9.9 rule 8):** NAME THE DATABASE where every count is claimed — in each commit message and in §9.5 — and drop the databases in the same task (rule 7): `hmis_lane_b_scratch` and every `hmis_lane_b_scratch_<n>` the helper created. Without the name, `exit 0` is a claim about a database nobody can inspect, and it cost a reviewer's CRITICAL slot last time.

**And the rule that makes any of this work:** files you did not write are Lane A's. Never stage, revert, stash or "tidy" them; never run a broad suite against the shared default databases while their jest is running; never infer from mtimes who did what (rule 8).

## 5. CLOSE

1. Fill the phase doc's §9.0–§9.5 (kickoff measurements and the number taken; spike answers; commits by SHA; findings; Assertion Book as corrected; mechanical verification with counts AND the database name beside each).
2. Spawn ONE fresh reviewer (restricted tools, no MCP roster) pointed at: the phase's commits, `AGENT-RULES.md`, the phase doc's §4.1/§6/§8 and the Assertion Books of T5–T8 ONLY, and the operand instruction from the phase doc's THE LANE paragraph verbatim — *for every gate, name the row `evaluateReadiness` reads and the write that would satisfy it without a human; for the Form F gate, name every code path from `checked_in` to `acquired` and show the one that does not call `assertFormFRecorded`; for the worklist, name one row an alias would leak and one row a restricted flag would not hide.* **`acquisition.ts` and `form-f.ts` first, then `reports.ts`, then `read.ts`.**
3. Remediate; then a SECOND FRESH reviewer over the remediation diff only, briefed at the fixes (v3 §9.10): *for every disclosure the first pass removed, enumerate every other field on the same response that is a function of it, and every caller-supplied parameter that interacts with the filter* (§2.140). Write §9.6 and §9.6.2.
4. Run the token audit (`/token-audit`) and record the actuals row only after §9.6.2 exists (v3 §9.4).
5. Commit the doc by path. **Do not deploy.** Report: the migration number actually written (measured), the claimed-kinds parity result (`['imaging']`, or `['lab','imaging']` if Lane A executed first — say which), the manifest count (19 expected), the permission census (131 expected, or the measured value with its cause), the mutant tally, the databases named, which §6A items closed and how (§6A.2 idempotency by header + duplicate window; §6A.5 by the add-on-is-a-new-order rule; §6A.8 PHI-at-the-reader), and what Lane A had already landed that you reused.

## 6. If you must hand off mid-work

Spend the remaining budget in this order: (1) `pnpm typecheck`, (2) the narrowest suite covering what you changed, on YOUR database, exit value read, (3) the handoff note — v3 §9.6 — including the migration number you hold, the databases you have not yet dropped, and which of the four shared files you have touched. Uncompiled, unrun code is UNKNOWN code however well described.
