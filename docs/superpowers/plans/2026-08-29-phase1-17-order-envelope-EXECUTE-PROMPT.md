# EXECUTE PROMPT — Plan 17 Phase 0, the P2 ORDER ENVELOPE

**For the executing session (Opus), on the build host, in `/opt/hmis`.** Paste this file's path as the seed; read nothing else first.

---

## 0. What you are, and what you are not

You are the **main session of a LIGHT-lane phase under EXECUTE-METHOD-V3 §3**, executing
`docs/superpowers/plans/2026-08-29-phase1-17-order-envelope.md` (committed `d4cc5f8`).

- **You code, task by task, sequentially, yourself.** Six tasks, T1→T6, in order. No coding subagents. No Workflow tool. No compiled pipeline.
- **Subagents are used for exactly one thing: the independent close review** — one FRESH reviewer after T6; a SECOND FRESH reviewer over the remediation if the first found anything. Never resume a reviewer (v3 §9.5, ledger §2.115).
- You are **not** authorised to deploy, to widen your own permissions, to run anything against `/opt/hmis-prod`, or to edit anything under `kernel/auth/` or `packages/contracts/` — the `Actor` union is another lane's (22c-A, now merged through `b13d74c`; confirm with `git log --oneline -5`).
- **Stop-loss: 640,000 tokens** (phase doc, THE LANE). If you approach it, stop and report — do not re-tier.

## 1. Read, in this order, before the first tool call

1. `docs/superpowers/AGENT-RULES.md` — in full. Rule 3 (no `/tmp`), rule 21 (build the mutant, never predict it), §3 (mutant discipline by tier), §5 (finish block), §6 (migrations are irreversible host mutations).
2. `docs/superpowers/EXECUTE-METHOD-V3.md` §3, §6, §9.1, §9.5, §9.6, §9.9 (rules 4–7: preflight `pnpm typecheck && pnpm lint` before every verify; fold code-complete tasks into one verify; tree frozen while a verify runs; sibling-grep with a DIRECTORY and a glob, never a file list).
3. `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` — **another session may be coding in this checkout** (22c-B or later in the patient self-service lane). Run its §2 pre-flight before you begin and before every broad suite. Read `git status --porcelain` before every `git add`. Never `git add -A` or `git add <directory>` — `cfde549` exists because someone did.
4. The ledger `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` — **§5 only, which starts at line 1323** (measure: `grep -n '^## 5' …`). Never the whole file: 393 KB, re-billed per tool call. Entries the phase doc cites by number (§2.54, §2.115, §2.131, §2.132) are read by number.
5. `docs/superpowers/plans/2026-08-29-phase1-17-order-envelope.md` — the phase document, in full. It is the only plan you read.
6. The three precedents every task transcribes: `apps/core/src/kernel/resources/kinds.ts`, `apps/core/src/kernel/search/registry.ts`, `apps/core/src/kernel/workflow/instances.ts` (the compare-and-set at 136–150), and `apps/core/src/kernel/episodes/series.ts`.

Do **not** read the brainstorm series or any other phase doc unless the phase doc points at a specific section.

## 2. Before T1 — the kickoff block, recorded in the phase doc's §9.3

1. **Re-measure every row of §2** of the phase doc with the command in its `how` column, and correct the doc in place where a value moved. Row 1 is the one that decides your migration number: the doc reserves **`0044` as a measurement** — if the journal has grown, you write the next free number and say so; you never rename or hand-edit `drizzle/meta/_journal.json`.
2. **Answer the spike S1–S6** by reading code and read-only SQL. Record answers in §9.3 before touching T1. S2 (the actor-type CHECK on `workflow_transitions`) and S5 (`istDate` locus) change T1 and T3's code; S6 (test files constructing a bare `ModuleManifest`) tells you which censuses T2's optional field touches.
3. Run the parallel-session pre-flight (§1.3 above).

## 3. Executing the tasks

- **Tier per task as the doc rules:** T1 ROUTINE · T2 CRITICAL · T3 CRITICAL · T4 CRITICAL · T5 CRITICAL · T6 ROUTINE. Every CRITICAL task's Assertion Book mutants are **built as `*.mutant.ts` scratch beside the source, run isolated, DIED/SURVIVED recorded with expected vs received**, then deleted before commit. A surviving required-DIED mutant is disclosed per AGENT-RULES §3, never fixed silently.
- **T1 generates the migration.** Generate only when you are ready to carry it to a commit (§6). Hand-carry the CHECKs and the immutability trigger the way `0043_patient_identity_spine.sql:79-81` did. Grep the sibling `patientIdentityVersions` across `apps/core/src --include=*.ts` for every census (`truncateAll` included) the new tables must join.
- **T3 moves the encounter-resolver registry** from `modules/billing/invoices.ts:312-340` to `kernel/episodes/encounter-resolvers.ts`. Behaviour and the three exported names are unchanged; billing re-exports; `opd.module.ts`, `ot.module.ts`, `billing/index.ts` change import path only. The existing billing tests are the parity proof.
- **T5 appends `ordersManifest` to `ALL_MANIFESTS`.** Find every census with `grep -rn 'formularyManifest' apps/core/src --include=*.ts` — the count-grep found two of four last time (§9.9 rule 7).
- **Verify discipline:** `pnpm typecheck && pnpm lint && echo PREFLIGHT OK` first, then ONE `pnpm verify` per batch of code-complete tasks, exit value read from a file, tree frozen until it returns. Commit per task or per batch (message separates tasks); watch CI by full SHA with `docs/superpowers/pipelines/ci-watch-host.sh`.
- **Commit hygiene:** stage by explicit path only. `git status --porcelain` must show no `*.mutant.*`, no scratch, no foreign-lane file in your staged set.
- **Frozen surfaces you must NOT touch:** `kernel/resources/kinds.ts`, the `resources_kind_ck` CHECK, `kernel/episodes/series.ts` (no new series letter), `kernel/auth/*`, `packages/contracts/*`, anything under `modules/opd/` beyond the one import line in `opd.module.ts`, anything under `modules/patients/`.

## 4. CLOSE

1. Fill the phase doc's §9.1–§9.5 (commits by SHA, findings, spike answers, Assertion Book as corrected by execution, mechanical verification with counts).
2. Spawn ONE fresh reviewer (restricted tools, no MCP roster) pointed at: the phase's commits, `AGENT-RULES.md`, the phase doc's §4.1/§6/§8, and the operand instruction from v3 §9.7 verbatim — *for every "already exists" check in `placeOrder` and `advanceOrderItem`, name what it queries and which writes it would miss; for `listOrdersForPatient`'s restricted and sealed filters, name one row each would leak.* Money file first does not apply — there is none; **`place.ts` and `read.ts` first.**
3. Remediate; then a SECOND FRESH reviewer over the remediation diff only. Write §9.6.
4. Run the token audit (`/token-audit`) and record the actuals row only after §9.6 exists (v3 §9.4).
5. Commit the doc by path. **Do not deploy.** Report: the migration number actually written, the claimed-kinds parity result (`[]` expected), the mutant tally, and whether Plans 17 and 18a may now be authored as two lanes.

## 5. If you must hand off mid-work

Spend the remaining budget in this order: (1) `pnpm typecheck`, (2) the narrowest suite covering what you changed, exit value read, (3) the handoff note — v3 §9.6. Uncompiled, unrun code is UNKNOWN code however well described.
