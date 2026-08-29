> # ⚠ SUPERSEDED 2026-08-29 — DO NOT SEED A SESSION FROM THIS FILE
>
> **Plan 17 executed T1 and T2 from this prompt (`39beff0`) and then stopped on its stop-loss.** The
> owner re-cut the remaining seven tasks into two phases, and **each carries its own executor seed in
> its own §0**, which is what v3 §1 prescribes and what this file's existence cost:
>
> - **T3–T5** → [`2026-08-29-phase1-17a-lims-order-to-accession.md`](2026-08-29-phase1-17a-lims-order-to-accession.md)
> - **T6–T9** → [`2026-08-29-phase1-17b-lims-result-to-report.md`](2026-08-29-phase1-17b-lims-result-to-report.md)
>
> Its §1 reading order, §2 kickoff block and §3 task tiers are **stale in three ways**: the tiers list
> nine tasks, the kickoff tells you `0046` may be free (it is taken — this phase wrote it), and the
> §2 censuses have all moved. It is kept, not deleted, because `39beff0`'s commit message and Plan
> 17's §9.0 both cite it as the seed they actually ran from — the rule-6 pattern. **Read it as a
> record of what T1 and T2 were told, never as an instruction.**

---

# EXECUTE PROMPT — Plan 17, the LIMS core

**For the executing session (Opus), on the build host, in `/opt/hmis`.** Paste this file's path as the seed; read nothing else first.

---

## 0. What you are, and what you are not

You are the **main session of a LIGHT-lane phase under EXECUTE-METHOD-V3 §3**, executing
`docs/superpowers/plans/2026-08-29-phase1-17-lims-core.md` (commit SHA: read it from `git log --oneline -- <that path> | tail -1`).

- **You code, task by task, sequentially, yourself.** Nine tasks, T1→T9, in order. No coding subagents. No Workflow tool. No compiled pipeline.
- **Subagents are used for exactly one thing: the independent close review** — one FRESH reviewer after T8; a SECOND FRESH reviewer over the remediation, briefed at the FIXES with a verdict per fix (v3 §9.10). Never resume a reviewer (v3 §9.5, ledger §2.115).
- You are **not** authorised to deploy, to widen your own permissions, to run anything against `/opt/hmis-prod`, or to edit any envelope file (`kernel/db/schema/orders.ts`, `kernel/orders/{place,advance,kinds,manifest}.ts`, `drizzle/0044*`, `drizzle/0045*`) — the envelope is phase 0's and is LIVE. The phase doc's THREE kernel edits (T2: `phi/audit.ts` union, `orders/read.ts` PHI call, `kinds.test.ts` claimed set) are the only kernel lines you touch, and you name them in T2's commit message.
- **Stop-loss: 730,000 tokens** (phase doc, THE LANE). If you approach it, stop and report — do not re-tier. **Hand-off rule:** if your context passes ~60% before T6 is committed, hand off at a task boundary per v3 §9.6 — typecheck, narrowest suite with the exit value read, then the note.

## 1. Read, in this order, before the first tool call

1. `docs/superpowers/AGENT-RULES.md` — in full. Rule 3 (no `/tmp`; heredoc scripts instead), rule 7 (a scratch database you name, use and drop), rule 20 (`pgrep -af jest` — read the lines), rule 21 (build the mutant, never predict it), §3 (mutant discipline by tier), §5 (finish block), §6 (migrations are irreversible host mutations).
2. `docs/superpowers/EXECUTE-METHOD-V3.md` §3, §6, §9.1, §9.5, §9.6, §9.7, §9.8 (rule 4 — the disclosure-fix enumeration), §9.9 (rules 4–8: preflight before verify; fold code-complete tasks; frozen tree during a run; grep the SIBLING for names and the LIST for counts, directory + glob; **take your own test databases AND NAME THEM**), §9.10.
3. `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` §1, §2, §7 — **Lane B (Plan 18a, radiology) may be executing in this checkout at the same time.** Run §2's pre-flight before you begin and before every broad suite. Read `git status --porcelain` before every `git add`. Never `git add -A` or `git add <directory>`. Files you did not write are theirs.
4. The ledger `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` — **§5 only; measure its line first: `grep -n '^## 5' …` (1485 on 2026-08-29; it has moved 160 lines in a day before).** Never the whole file (407 KB). Entries the phase doc cites by number — §2.54, §2.115, §2.131, §2.133, §2.137, §2.138, §2.139, §2.140 — are read by number (`grep -n '^\*\*2\.137' …`).
5. `docs/superpowers/plans/2026-08-29-phase1-17-lims-core.md` — the phase document, in full. It is the only plan you read.
6. Phase 0's CONTRACT, and only that: `docs/superpowers/plans/2026-08-29-phase1-17-order-envelope.md` **lines 297–374** (§6, §6A, §8); `sed -n '134,190p'` of the same file when you need an envelope column name. **Never the whole file (112 KB).**
7. The seam every task calls: `apps/core/src/kernel/orders/kinds.ts`, `place.ts` (the input type at lines 16–76 and the guard), `advance.ts` (lines 16–40), `read.ts` (the three exported readers and the alias rule); `apps/core/src/kernel/orders/envelope.e2e.test.ts` — **the working model of T2's manifest field and T4's first placement**. Precedents by task: T1 `drizzle/0043_patient_identity_spine.sql:79-81` (the trigger) and `test/helpers/db.ts:150-310` (the statement rules); T2 `modules/ot/{manifest,approval-types,events,errors}.ts`; T4 `modules/billing/idempotency.ts` + `billing.controller.ts:350` (the header), `modules/ot/workflow-def.ts`; T5 `modules/ot/specimens.ts` (an `S` number already minted by the OT), `kernel/worker/jobs.ts:171-220`; T6 `kernel/workflow/instances.ts:136-150` (the CAS); T7 `modules/billing/{settlement,credit-notes}.ts`, `kernel/notify/enqueue.ts:68`, `kernel/phi/audit.ts:82-120`; T8 `apps/web/src/screens/ot-cockpit.tsx` and `components/rx-print.tsx`.

Do **not** read the brainstorm series unless the phase doc points at a specific id (§5 rows are cited as `02 A1` etc. — read that ONE line with `grep -n '^- \*\*A1\*\*' docs/superpowers/brainstorms/2026-08-27-department-series/02-central-lab-lims.md`).

## 2. Before T1 — the kickoff block, recorded in the phase doc's §9.0 and §9.3

1. **Re-measure every row of §2** with the command in its `how` column and correct the doc in place where a value moved. Row 1 decides your migration number: the doc reserves **`0046` as a measurement** — if Lane B has generated first, you write the next free number, say so in the commit, and rename nothing by hand. Rows 2–6 and 12 are the censuses Lane B may have already moved: read their CURRENT values, not the doc's.
2. **Answer the spike S1–S9** by reading code and read-only SQL (S5 is a production read — `psql` read-only, the 11d Question B precedent; no write, no `setsid`). Record answers in §9.3 before touching T1. **S1 changes T4's invoice call; S2 changes `openLabWalkin`; S9 changes T6's reflex placement.** Do not guess any of the three.
3. Run the parallel-session pre-flight. Then choose your database name and USE it for every run in this phase:
   `export TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_a_scratch"` — and **write that name into every commit message that cites a green run and into §9.5**. Drop the `hmis_lane_a_scratch_*` databases in the CLOSE, by explicit name, and say you did.

## 3. Executing the tasks

- **Tier per task as the doc rules:** T1 ROUTINE · T2 ROUTINE · T3 CRITICAL · T4 CRITICAL · T5 CRITICAL · T6 CRITICAL · T7 CRITICAL · T8 ROUTINE · T9 ROUTINE. Every CRITICAL task's Assertion Book mutants are **built as `*.mutant.ts` scratch beside the source, run isolated (`exec jest <path> -t "<name>"`, isolation line quoted), DIED/SURVIVED recorded with expected vs received**, then deleted before commit. A surviving required-DIED mutant is disclosed per AGENT-RULES §3, never fixed silently. Concurrency rows (T4 A1b, T5 A1/A2, T6 A2) are MEASURED over ≥ 8 rounds with `uptime` quoted and `pgrep -af jest` lines read.
- **T1 generates the migration.** Generate only when you are ready to carry it to a commit (§6). Re-check `_journal.json` immediately before and after. Hand-carry the two triggers and every CHECK the way `0043` did. The `truncateAll` rule: a table whose parent is truncated joins the parent's OWN statement; an island takes its own.
- **T2's censuses:** run BOTH greps the doc names — the sibling (`otManifest`, `ot_incharge`) for the places that NAME, and the list (`ALL_MANIFESTS`) for the places that COUNT — at directory-and-glob scope. Five manifest censuses exist; `seed-roles.test.ts` alone holds three. `kinds.test.ts:140` (claimed set) and `resources/kinds.test.ts:130` (collected kinds) are two more. **If Lane B has already moved any of them, append; never reorder.**
- **T4's transaction boundary is the phase's money seam.** `placeOrder` and `issueInvoice` run in ONE `withTx`; the controller — not the service — wraps it in `withIdempotency`. A4's `restricted:true` on a consent-class item is what keeps the kernel reader's filter honest; do not set it after the fact.
- **T6's reflex is placed INSIDE the verify transaction, in the API process.** Nothing in this phase calls `placeOrder` from the worker; if you find yourself wanting to, stop — DD8 records why, and the worker cannot resolve an encounter (§6A.1).
- **T7: `money.ts` and `interlock.ts` first, tests before screens.** A7's "no values in the WhatsApp body" is asserted on the enqueued payload, not on a template string. A8 uses `expect(spy.mock.calls.map(c => c[1]))`, never `not.toHaveBeenCalled()` on a `Db`-taking function (§2.139).
- **T8: every route body asserted over HTTP** (22c-A C1: a field missing from the wire schema returned 200 and wrote nothing). Four `path:` lines in `router.tsx` move `nav-parity` and `shell-nav` — both censuses.
- **Verify discipline:** `pnpm typecheck && pnpm lint && echo PREFLIGHT OK` first, exit value read; then ONE `pnpm verify` per batch of code-complete tasks (suggested batches: T1+T2 · T3+T4 · T5+T6 · T7+T8 · T9 docs only), run detached with the exit value read from `/opt/hmis/.verify.exit`, tree frozen until it returns, **one blocking waiter, no hand-polling**. Commit per batch (message separates tasks and names the database). Watch CI by full SHA with `docs/superpowers/pipelines/ci-watch-host.sh`.
- **Commit hygiene:** stage by explicit path only. `git status --porcelain` must show no `*.mutant.*`, no `.verify.*`, no `docs/design/`, no Lane B file in your staged set. `git pull --rebase origin main` before every push; on a conflict in a shared census file, take theirs and re-append yours.
- **Frozen surfaces you must NOT touch:** everything under `kernel/orders/` except the two named test/reader lines; `kernel/episodes/series.ts` (no new letter — `S` already exists); `kernel/resources/kinds.ts` and `schema/resources.ts` (`bench`/`analyzer` are already in the set — you DECLARE them on the manifest, you do not add them); `kernel/auth/*`; `packages/contracts/*`; `modules/billing/*` except as an IMPORT (you call `issueInvoice`, `issueCreditNote`, `settlementState`, `withIdempotency`; you edit none of them); `modules/opd/*` except `encounters.ts` (`openLabWalkin`), `index.ts` (its re-export) and the ONE results panel in `opd-consult.tsx`; `modules/patients/*`.

## 4. CLOSE

1. Fill the phase doc's §9.0–§9.5 (kickoff re-measure, spike answers, commits by SHA, findings, Assertion Book as corrected by execution, mechanical verification with counts AND the database name of every run).
2. Spawn ONE fresh reviewer (restricted tools, no MCP roster, **told that Lane B may be running tests and forbidden to run any**) pointed at: the phase's commits, `AGENT-RULES.md`, the phase doc's §4/§6/§8, and the operand instruction from v3 §9.7 verbatim — *for every "already paid", "already collected", "already verified", "already exists" check — `deliveryAllowed`, the accession CAS, the verify SoD, the duplicate detector, the idempotent desk route — name what it queries and which writes it would miss; for `deliveryAllowed`, name one real charge its sum does not include.* **Money file first: `money.ts`, then `interlock.ts`, then `desk.ts`.** Name the frozen interfaces consumed: `placeOrder`, `advanceOrderItem`, `issueInvoice`, `settlementState`, `withIdempotency`, `recordPhiAccess`.
3. Remediate; **run the suite after each guard and read the failure count** (v3 §9.8); then a SECOND FRESH reviewer briefed at the FIXES — the remediation commit, the findings list, what each fix CLAIMS — requiring CORRECT / INCOMPLETE / WRONG per fix. Write §9.6 and §9.6.2.
4. Run the token audit (`/token-audit`) and record the actuals row only after §9.6 exists (v3 §9.4).
5. Drop your scratch databases by name; say so. Commit the doc by path. **Do not deploy.** Report: the migration number actually written, the claimed-kinds parity result (`['lab']` or `['lab','imaging']` — say which), the mutant tally, the database name every run used, and what §9.9 will need from the owner (grants, catalogue, signatory, department, activation).

## 5. If you must hand off mid-work

Spend the remaining budget in this order: (1) `pnpm typecheck`, (2) the narrowest suite covering what you changed, exit value read, database named, (3) the handoff note — v3 §9.6. Uncompiled, unrun code is UNKNOWN code however well described.
