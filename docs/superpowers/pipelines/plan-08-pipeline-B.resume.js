export const meta = {
  name: 'plan-08-billing-pipeline-B-resume',
  description: 'Plan 08 Billing Counter, pipeline B (T7-T12) on execute method v2: credit notes, refund vouchers, reconciliation, the pay-before-consult gate + daily close, the HTTP surface, and the lifecycle e2e.',
  phases: [
    { title: 'Wave 5', detail: "T11 [ROUTINE/opus] Module surface - manifest, module, controller (31 routes), index, AppModule, e2e" },
    { title: 'Wave 6', detail: "T12 [ROUTINE/sonnet] Lifecycle e2e, docs, runbook - pipeline B capstone" },
    { title: 'Discovery', detail: 'One cross-task discovery review over all of pipeline B commits' },
  ],
}

// ==== Plan 08 pipeline B, compiled 2026-08-19 under EXECUTE-METHOD v2 ====
// Plan: docs/superpowers/plans/2026-08-18-phase1-08-billing-counter.md (see Pipeline Notes v2)
// Rules: docs/superpowers/AGENT-RULES.md v2 - referenced by briefs, not inlined
// Baseline MEASURED 2026-08-19 at a044ee1: apps/core 110/665, web 21/80, contracts 3/7
// Review shape: full opus gate on CRITICAL tasks, sonnet mechanical check on ROUTINE,
//               plus ONE opus discovery reviewer over the whole pipeline.
// Tiers/models are the plan's Pipeline Notes v2 table.

const RULES = "THE RULES ARE IN THE REPO. READ THEM FIRST, IN FULL.\n\n  /opt/hmis/docs/superpowers/AGENT-RULES.md   (version 2, 2026-08-19)\n\nThat file is the binding contract: 22 hard rules, the evidence discipline, the risk-tiered\nmutant discipline, the counting rule, the finish block, and the migration rule. It is NOT\npasted into this brief any more — there is one copy, versioned with the repo, and this brief\npoints at it. Where this brief and AGENT-RULES.md disagree about PROCESS, AGENT-RULES.md wins.\n\nREAD RULE 22 BEFORE YOU TOUCH A FILE. It changed how you work, and it is the reason this\npipeline is expected to cost a third less than the last one:\n\n  (a) ONE command at the start pulls the whole tree (~7 MB) into a LOCAL scratch mirror.\n  (b) You then READ, GREP and AUTHOR natively in that mirror with Read/Grep/Glob/Edit/Write —\n      not over SSH. In the previous pipeline 234 of 318 coder shell calls were SSH round-trips,\n      about 42 of them pure navigation per agent. That was the single largest cost in the run.\n  (c) You push the files you changed in ONE scp, and THE FILES LIST IS THE SYNC LIST.\n  (d) You CONFIRM the sync landed (git status + md5sum) before running anything.\n  (e) Everything that produces EVIDENCE still runs on the server: migrations, tests,\n      pnpm verify, git, commit, push. There is no local Postgres and no local node_modules;\n      a result obtained locally would not be a result.\n\nIf you find yourself about to `ssh ... 'cat file'` or `ssh ... 'grep ...'`, stop: that is what\nthe mirror is for."

const PLAN_REF = "THE PLAN IS THE SPEC — READ IT ON THE SERVER\n\n  /opt/hmis/docs/superpowers/plans/2026-08-18-phase1-08-billing-counter.md\n\nRead it IN FULL before you touch anything: the Design section (D1-D10), \"Consumed shipped\nsurfaces\", \"Global Constraints\", the \"File Structure\" block, YOUR OWN task section, the\nAssertion Book rows naming your task, the \"Verify-by-execution flags\" list, and — this is new —\n**\"Pipeline Notes v2\" at the very end of the document**, which supersedes the original tier map\nand review shape.\n\nThis brief does NOT restate the plan's code, schemas, error codes, SQL, fixture values or\nderivations. The plan is the single source of truth for all of them. Where this brief and the\nplan disagree about CODE, the plan wins; about PROCESS, AGENT-RULES.md wins.\n\nALSO READ, before you start — it is short and it is about YOUR pipeline:\n\n  /opt/hmis/docs/superpowers/plans/reports/plan-08-pipeline-A-notes.md\n\nSection 4 is a 19-item carried-forward list from pipeline A. The items that name your task are\nrepeated in your task body below, but read the whole section: several are \"known and accepted,\ndo not fix these\", and one of them will otherwise look like a defect you should chase.\n\nOwner rulings R1-R5 in the plan header are binding design inputs. R5 (2026-08-19) is the one\nthat shipped in pipeline A: billing keeps its FKs into `patients`, and the fourteen billing\ntable names live INSIDE the existing patients/OPD truncate statement."

const BASELINE = "BASELINE — MEASURED, WITH ITS TIMESTAMP, AND IT HAS A SHELF LIFE\n\nYour baseline is THE PREVIOUS TASK'S COMMIT, i.e. whatever \"git rev-parse origin/main\" returns\nwhen you start. This pipeline is strictly sequential and docs commits land from the owner's\nmachine while it runs, so origin/main WILL have moved. Do not treat a moved HEAD as drift, do\nnot investigate it, do not write a reconciliation paragraph. Pull and work.\n\nMeasured by the main session on the server:\n  - 2026-08-19, at commit a044ee1 (end of pipeline A), full detached \"pnpm verify\", exit\n    VALUE 0 read from a file:\n        apps/core          110 suites / 665 tests\n        apps/web            21 files  /  80 tests   (NO task in pipeline B touches apps/web)\n        packages/contracts   3 suites /   7 tests\n  - 2026-08-19, re-confirmed green after the v2 docs commits (two shipped suites, exit VALUE 0).\n\n*** RE-CONFIRM BEFORE YOU TRUST IT (AGENT-RULES evidence discipline; EXECUTION-LESSONS 2.21) ***\nA measured baseline has a shelf life inside a pipeline that mutates shared state. Pipeline A's\nFIRST run falsified its own baseline within the hour — a task generated a migration, let the\nsuite apply it, then deleted the file, and origin/main itself went RED on this host with no\ncommit containing the cause. Every later brief in that run carried \"all suites GREEN\" as a\nstated fact while it was false.\nSo before you trust the numbers above, run ONE cheap shipped suite and confirm the host is\nstill green, e.g.\n    pnpm --filter @hmis/core exec jest --passWithNoTests --runInBand src/kernel/db/schema/events.test.ts\nIf it is NOT green, that is a FINDING to report, not your bug and not something to work around.\nSay so and stop.\n\nCOUNTS — READ AGENT-RULES section 4. There is NO per-task test-count target in this pipeline\nany more. The plan's ladder rows are a sanity reference, not an acceptance criterion; chasing\nthem cost four gate findings in pipeline A. The rule is:\n  - the workspace total must NOT DECREASE, and your diff must DELETE NO TEST;\n  - quote the runner's own summary line for the suites you added, by exact path;\n  - if a number anywhere disagrees with what you measure, REPORT the difference and its cause.\nNever pad, split, merge, or delete a test to hit a number."

const MIRROR = "THE MIRROR WORKFLOW — AGENT-RULES rule 22, restated here because it is new and it is the\nsingle biggest change to how you work.\n\n  1. PULL, once, at the very start:\n       mkdir -p \"<YOUR SCRATCHPAD>/mirror\" && ssh root@62.238.106.231 \\\n         'cd /opt/hmis && tar czf - --exclude=node_modules --exclude=.git .' \\\n         | tar xzf - -C \"<YOUR SCRATCHPAD>/mirror\"\n     Your scratchpad is a WINDOWS path, so Read / Grep / Glob / Edit / Write all work against\n     the mirror natively. Do this BEFORE you read the plan — read the plan FROM the mirror.\n\n  2. NAVIGATE AND AUTHOR in the mirror. Every file you read, every grep, every edit. One tool\n     call each, no SSH, no command echo, no shell output in your context.\n\n  3. PUSH the files you changed in ONE scp, and THE FILES LIST IS THE SYNC LIST:\n       scp \"<MIRROR>/apps/core/src/...\" root@62.238.106.231:/opt/hmis/apps/core/src/...\n     (batch several paths into one invocation). If you are about to sync a file your Files list\n     does not name, STOP — that is a scope violation, not a sync problem.\n\n  4. CONFIRM THE SYNC LANDED before running anything:\n       ssh root@62.238.106.231 'cd /opt/hmis && git status --porcelain && md5sum <files>'\n     and compare against local md5sum. A stale server file under a green local edit is the ONE\n     way this workflow can lie to you. Never run a test against a tree you have not just\n     confirmed.\n\n  5. EVERYTHING THAT PRODUCES EVIDENCE STILL RUNS ON THE SERVER — migrations, tests,\n     pnpm verify, git, commit, push. There is no local Postgres and no local node_modules; a\n     result obtained locally would not be a result. The mirror is a reading and typing surface.\n\n  6. DELETE the mirror at the end of your task.\n\nWhy: in the previous pipeline, 234 of 318 coder shell calls were SSH round-trips and about 42\nper agent were pure navigation, against 30 native tool calls in total. That was the largest\nsingle cost in the run and none of it bought any evidence."

const MUTANTS_CRITICAL = "MUTANT DISCIPLINE — YOUR TASK IS **CRITICAL** TIER, SO ALL OF THIS IS BINDING.\n\n- Build every mutant the plan's Assertion Book names for your task.\n- A mutant is a SEPARATE SCRATCH FILE beside the source. NEVER produce one by editing, moving,\n  reverting, or deleting the shipped file.\n- Each gets a SELF-CONTAINED scratch spec and is run ISOLATED. Quote the isolation line from\n  the OUTPUT (\"N skipped, 1 passed\"), never an exit code.\n- Record DIED or SURVIVED with the RUN COUNT **and quote expected vs received from the\n  assertion itself**. A mutant that dies at TYPECHECK proves nothing — this repo compiles with\n  noUncheckedIndexedAccess, so an indexed array literal dies at TS2532 before any assertion\n  runs, and a DIED recorded from that run is worthless.\n- Rows the plan marks *measure* authorise an honest SURVIVED reported with the OBSERVED rate;\n  name the structural defence.\n- Fail-first is OWED by this task. Quote the failing output.\n- DELETE every mutant and scratch spec BEFORE final counts and BEFORE committing. The invariant\n  a reviewer checks: \"git status --porcelain\" EMPTY, no *.mutant.* residue, no frozen path in\n  the diff. Frozen-path rules govern what may be COMMITTED, so transient scratch may sit beside\n  its source even in a frozen directory — prefer a non-frozen location.\n- NEVER fix a surviving required-DIED mutant silently. Two branches, disclose either way:\n    (a) the survival implies SHIPPED CODE IS WRONG, or the fix reaches OUTSIDE your Files list\n        → CHAIN HALT. Commit nothing further. Report it as a plan defect with the evidence.\n    (b) the survival means the PLAN'S TEST cannot discriminate and that test is YOUR OWN task's\n        file → fix it MINIMALLY in-task and disclose the fix."

const MUTANTS_ROUTINE = "MUTANT DISCIPLINE — YOUR TASK IS **ROUTINE** TIER.\n\n- **Mutants are NOT required for this task.** The plan's Assertion Book names no required-DIED\n  row for it, and building them anyway is not thoroughness, it is spend the owner has asked us\n  to stop.\n- **Fail-first is not owed** beyond any red your acceptance criteria explicitly name. Where a\n  criterion does name one, it is owed and must be quoted. Where none is named, say plainly in\n  your report that no red was owed — do not manufacture one, and do not mutate shipped state to\n  produce one.\n- Your tests must still pass, and every acceptance criterion must still be met and evidenced.\n- **If you NOTICE an assertion that cannot discriminate — a fixture where both sides are\n  identical, an absence assertion whose fixture could never produce the thing, a status code two\n  mechanisms produce — SAY SO in your interpretations.** That observation is worth more than a\n  mutant nobody asked for, and it is exactly the class of defect this project keeps finding late.\n- All scratch is still deleted before committing; \"git status --porcelain\" must be empty."

const FROZEN = "FROZEN PATHS WHILE THIS PIPELINE RUNS (a commit touching one of these fails the task)\n\n  apps/core/src/kernel/**            byte-frozen. Pipeline A's T1 spent the only two permitted\n                                     exceptions (the schema barrel re-export and the\n                                     test/helpers/db.ts truncate statement). There are none\n                                     left. Nothing in kernel, at all, in pipeline B.\n  apps/core/drizzle/**               FROZEN. Both migrations shipped in pipeline A (0011+0012).\n                                     A THIRD MIGRATION IS A CHAIN HALT — see HALT CONDITIONS.\n  apps/core/test/helpers/db.ts       frozen.\n  apps/core/src/modules/tariff/**    byte-frozen.\n  apps/core/src/modules/patients/**  byte-frozen.\n  apps/core/src/modules/opd/**       byte-frozen EXCEPT T10's four named files. No other task\n                                     in this pipeline may touch OPD.\n  apps/core/src/kernel/realtime/**   byte-frozen.\n  packages/contracts/**              byte-frozen.\n  apps/web/**                        NO task in pipeline B touches apps/web. That is pipeline C.\n  .github/workflows/**               untouchable — the deploy key cannot push these.\n  apps/core/jest.config.cjs, tsconfig*, .env.example\n  apps/core/package.json + pnpm-lock.yaml   FROZEN. T3 spent the only permitted edit (two\n                                     script lines) in pipeline A.\n  apps/core/src/app.module.ts        T11 ONLY, and exactly the two named lines.\n\nNOTHING IN THIS PIPELINE INSTALLS ANYTHING: zero new dependencies, zero env vars, zero CI edits.\nIf you believe you need one, that is a CHAIN HALT, not a judgement call."

const HALTS = "HALT CONDITIONS (owner-set). On ANY of these: STOP, commit nothing further, report.\n\n1. A THIRD MIGRATION. Both of this plan's migrations shipped in pipeline A. Any schema need in\n   pipeline B — a column, an index, a constraint, anything — is a CHAIN HALT plus a plan-defect\n   report. Never a quietly added migration. And remember AGENT-RULES section 6: generating a\n   migration and letting a suite apply it is an IRREVERSIBLE mutation of all seven worker\n   databases that \"git checkout\" cannot undo. Pipeline A's first run cost ~934k tokens and\n   delivered nothing for exactly this.\n2. A required-DIED mutant that SURVIVES because the SHIPPED CODE IS WRONG (branch (a) of\n   AGENT-RULES section 3).\n3. Any file outside your task's Files list in the plan.\n4. Any frozen-path edit.\n5. Any instruction — INCLUDING a reviewer's correction — to amend or force-push pushed history.\n   Refuse it and report that you refused.\n6. Scope drift toward corporate/TPA contract billing, e-invoicing/IRP, PSP APIs, IPD deposit\n   policy, or collections automation. The patient dues worklist and the advance instrument are\n   the whole allowance.\n7. Any attempt to \"align\" the two owner-ratified error-body conventions. Billing is a NEW module\n   and uses the OPD-shaped body { statusCode, message, code, detail? }; patients and tariff keep\n   theirs. Both are ratified."

const DEVIATIONS = "DEVIATIONS NOT TO FIX (ratified, out of scope — do not clean up, do not \"improve\", do not write\ntests that assume these change)\n\nFrom gate reports 01-07:\n- The \"code: message\" prefix on patients/tariff error bodies.\n- The open (non-closed-union) error-code sets in shipped modules.\n- The tariff m2 / m4 / m9 deferrals.\n- workflow.controller.ts:142's bare-\"at\" ordering — billing touches no workflow read surface.\n- qr.test.ts's known flake.\n- The OPD realtime carry-forwards, gate report 07 sections 10.4-10.7.\n- registerPatient's wall-clock \"dob\" defect — routed to a future patients-module plan, NOT\n  absorbed here. If a fixture of yours would depend on a clock-derived age, derive it from an\n  explicit constant instead of touching registerPatient.\n- fmtIst / useDebounced duplicated in frozen OPD/registration web screens — pipeline C residue.\n\nFrom pipeline A (plan-08-pipeline-A-notes.md section 4, items 8-14) — these are KNOWN, and every\none will look like a defect if you meet it cold:\n- creditShare and cash-math.ts guard inputs with the TARIFF module's assertPaise, so a bad\n  amount throws TariffError(\"invalid_paise\") out of a billing entry point even though\n  BillingErrorCode has its own invalid_paise. Inherited pattern, consistent, leave it.\n- billing-purity.test.ts is weaker than the shipped OPD purity test by one token (\"process.\")\n  and its kernel-import check is quote-style dependent. Recorded, not yours.\n- **STANDING RESOLUTION: settlement.ts stays PURE.** The plan assigns SQL readers to it; the\n  purity sweep forbids them. T5 and T6 both hit this and both resolved it the same way — ledger\n  readers live in the writer file that owns their rows (invoices.ts, receipts.ts). Follow that\n  precedent; do not re-litigate it and do not relax the purity test.\n- CASH_DENOMINATIONS_PAISE is hardcoded in cash-math.ts, not config. Pipeline C's problem.\n- listDues has no pagination and filters in memory. Scale seam, fine at Phase-1 volumes.\n- episodeCashPaise (C-2) has no entered-in-error filter — voiding a mis-keyed cash receipt does\n  not restore that patient's 269ST headroom for the day. Documented counter-workflow surprise,\n  not a bug to fix here.\n- T5's cash_threshold.blocked event is appended in a SECOND transaction after the issue\n  transaction rolls back. Deliberate — an audit event that only survives when the money was\n  accepted is no audit trail."

const FINISH = "FINISH BLOCK — see AGENT-RULES section 5. Three numbered steps, in this order, never chained.\n\n0. BEFORE any \"git add\": run \"git status --porcelain\" ON THE SERVER and READ IT. Delete every\n   scratch file you created (mutants, scratch specs, .log, .exit) AND delete your local mirror.\n   The tree must contain ONLY files your Files list names. Never \"git add -A\" over an unread\n   status.\n1. Commit with the plan's EXACT commit message for your task.\n2. git pull --rebase origin main\n3. git push origin main\n\nThen report: \"git status\" clean, and the resulting commit SHA. If step 2 conflicts in a way you\ncannot resolve without rewriting pushed history, STOP and report.\n\nNote: \"git stash list\" on the server holds stash@{0}, an obsolete edit from pipeline A run 1\nmade under a design the owner overruled. LEAVE IT ALONE. Do not pop it, do not drop it. It is\ninvisible to \"git status --porcelain\" and cannot contaminate your commit."

const CODER_PERSONA = "You are a senior software engineer executing one briefed implementation task inside an\nautomated pipeline. This brief is your ENTIRE context — you cannot see the conversation that\nproduced it, and no one is available to answer questions.\n\nHow to work:\n- FIRST pull your local mirror (see THE MIRROR WORKFLOW below), then read the rules file, the\n  plan section, and every file your Files list names — all from the mirror, natively.\n- Match the existing codebase: its style, naming, idiom, and comment density. Introduce no new\n  patterns, dependencies, or abstractions unless the brief asks for them.\n- Deliver exactly the scope in the brief. No drive-by refactors, no extra features, no\n  speculative error handling, no \"while I was in there\" fixes.\n- Run the tests covering your change on the SERVER before reporting, and report results\n  faithfully. Paste failing output if anything fails. Never claim a result you did not observe.\n- If the brief is contradictory or missing something essential, say so plainly and do the part\n  that is unambiguous — do not guess at the rest. Reporting a plan defect is always better than\n  quietly working around one."

const GATE_PERSONA = "You are a senior reviewer gating one implementation task in an automated pipeline. You cannot\nsee the conversation, but the PLAN and the RULES are on the server and in your mirror, and you\nare expected to read them:\n\n  docs/superpowers/AGENT-RULES.md\n  docs/superpowers/plans/2026-08-18-phase1-08-billing-counter.md\n  docs/superpowers/plans/reports/plan-08-pipeline-A-notes.md\n\nRead the task's own plan section, its Assertion Book rows, and the Global Constraints. Then:\n- Read the changed files yourself. Does the change do what was asked, and ONLY what was asked?\n- Re-run the tests covering the change YOURSELF. Never accept a claim that tests pass.\n- Check every acceptance criterion explicitly, one by one, from what you observe.\n- Where the plan hand-derives a money value, RE-DERIVE it by hand and compare against the\n  shipped fixture — not merely that the test is green.\n- Fail scope creep (files or behaviour neither the brief nor the criteria asked for) and\n  overengineering (speculative abstractions, unrequested features, handling for impossible\n  scenarios).\n- Verify the Files list and the frozen-path list against \"git show --stat\" of the actual\n  commit, never against the coder's summary of it."

const MECHANICAL_PERSONA = "You are a MECHANICAL VERIFIER for a ROUTINE-tier task in an automated pipeline. Your job is\nnarrow and objective: run a fixed checklist, observe the results yourself, and return a verdict.\n\nYou are NOT a design reviewer. Do not critique architecture, do not propose refactors, do not\nre-derive the plan's arithmetic. Do not re-litigate decisions the brief already made.\n\nYou DO fail the task if an objective check fails: verify not green, a file outside the Files\nlist, a frozen path touched, CI red, a dirty tree, a wrong commit message, or an acceptance\ncriterion you cannot confirm from your own observation.\n\nEvidence rules bind you exactly as they bind the coder: exit VALUES read from files (never a\npiped or wrapped status), isolation confirmed from OUTPUT, and your own scratch deleted before\nyou return."

const DISCOVERY_PROMPT = "You are the DISCOVERY REVIEWER for a completed pipeline. Six tasks (T7-T12) of Plan 08's\nbilling module have just shipped to /opt/hmis on root@62.238.106.231, each already verified\nindividually. Your job is the one thing a per-task reviewer structurally CANNOT do: read all of\nthis pipeline's commits TOGETHER and find what only shows up across them.\n\nSTART by pulling a local mirror so you can read natively rather than over SSH:\n  mkdir -p \"<YOUR SCRATCHPAD>/mirror\" && ssh root@62.238.106.231 \\\n    'cd /opt/hmis && tar czf - --exclude=node_modules --exclude=.git .' \\\n    | tar xzf - -C \"<YOUR SCRATCHPAD>/mirror\"\n\nREAD FIRST, from the mirror:\n  docs/superpowers/AGENT-RULES.md\n  docs/superpowers/EXECUTE-METHOD.md\n  docs/superpowers/plans/2026-08-18-phase1-08-billing-counter.md   (all of it, incl. Pipeline Notes v2)\n  docs/superpowers/plans/reports/plan-08-pipeline-A-notes.md       (the carried-forward list)\n  docs/superpowers/plans/reports/EXECUTION-LESSONS.md              (sections 2 and 3)\n\nThen read every commit this pipeline produced (they are the commits after pipeline A's final\ncommit a044ee1 that touch apps/core), with \"git show\" and by reading the resulting files.\n\nWHAT TO HUNT FOR — these are the classes that have actually cost this project:\n\n1. **DORMANT DEFECTS ARMED BY A LATER TASK.** A task ships a code path nothing exercises yet,\n   and a later task turns it on. Plan 07's T8 shipped a shutdown race that T9 armed by\n   registering a router; it went CI-red and read as an unrelated flake three times. Ask of every\n   task: what did it ship that nothing yet calls, and does something later in this pipeline —\n   or in pipeline C — call it?\n\n2. **CONVENTIONS NOTHING TESTS.** A rule stated in six briefs, honoured by six implementations,\n   protected by zero assertions. Build the mutant against the convention: neuter it in a scratch\n   copy and see whether any shipped test fails. If none does, that is a finding.\n\n3. **ASSERTIONS THAT CANNOT DISCRIMINATE.** Fixtures where both sides are identical; absence\n   assertions whose fixture could never produce the thing; a status code two mechanisms produce;\n   a harness that flattens the axis under test. Where you suspect one, BUILD THE MUTANT and\n   report DIED or SURVIVED with counts — a hand-walk is a prediction, not evidence.\n\n4. **CROSS-TASK DUPLICATION AND DRIFT.** The same aggregate computed two ways in two files; two\n   error conventions in one module; a helper reimplemented because a Files list forbade editing\n   the original. Pipeline A already accepted one such duplication deliberately — say whether it\n   grew.\n\n5. **THE CARRIED-FORWARD LIST.** plan-08-pipeline-A-notes.md section 4 named items for T8, T10,\n   T11 and T12 specifically. For each, state whether the task that owned it actually discharged\n   it, deferred it with disclosure, or silently dropped it.\n\n6. **ANYTHING THE PLAN PROMISED THAT NOTHING PROVES.** A verify-by-execution flag whose\n   discharging assertion does not exist; an acceptance criterion that claims a proof its test\n   cannot deliver; an Assertion Book row whose stated mechanism is wrong even though its verdict\n   was right.\n\nRULES THAT BIND YOU: everything in AGENT-RULES.md. In particular — build mutants as separate\nscratch files and never by editing shipped code; prove isolation from OUTPUT; read exit VALUES\nfrom files; delete every scratch file and your mirror before you return; and change NOTHING in\nthe repository. You are read-only apart from your own scratch. You commit nothing and push\nnothing.\n\nRETURN, as data:\n- findings: each a self-contained paragraph naming the file, what is wrong or notable, and the\n  EVIDENCE (a mutant verdict with counts, a quoted output, a re-derivation). Rank them\n  most-important first.\n- commits_read: the SHAs you actually read.\n- cross_task_risks: anything that is only a risk because of how two or more tasks combine.\n- carried_forward_to_c: what pipeline C's briefs must carry, stated so it can be pasted in."

const SEP = "\n\n==============================================================================\n\n"

const TASKS = [
  {
    id: "t7",
    tier: "CRITICAL",
    model: "opus",
    wave: 1,
    deps: [],
    title: "Credit notes - cumulative partial-refund arithmetic, clearance discount, correction",
    body: "TASK T7 — Credit notes: refunds' paper, clearance discount, correction.\n\n  RISK TIER: **CRITICAL**   →  mutants REQUIRED, fail-first OWED, full opus gate.\n  Model: opus (cumulative money arithmetic + fixture discrimination).\n\nPLAN SECTION TO FOLLOW IN FULL: \"### Task 7: Credit notes — refunds' paper, clearance discount,\ncorrection\". Design context: D4 in full (credit notes and the cumulative partial-refund\narithmetic — this is the rule Plan 06 deliberately left to this plan), D1's settlement\nparagraph, and the Global Constraint \"Sum line heads; never recompute\". Your Assertion Book\nrows: K24, K25, K26.\n\nFILES — EXHAUSTIVE. Anything outside this list is a HALT. Paths under apps/core/ :\n  Create:  src/modules/billing/credit-notes.ts  + credit-notes.test.ts\n  Modify:  test/helpers/billing.ts\n\nTASK-SPECIFIC NOTES\n- The cumulative rule is the whole point: shares are derived from the STORED line, never\n  re-priced, and cumulative credits must EXACTLY EXHAUST the line. The naive per-refund\n  divHalfUp leaks paise (100/3 → 33+33+33 = 99). B-06's worked numbers are already in the\n  Fixture Book that T2 shipped — they must land as ROWS here (gross 3333 / discount 333 /\n  heads 180+180 / net 3360, then the cumulative 3334 step, then the exhausting remainder).\n  The reviewing gate WILL re-derive them by hand.\n- Clearance-discount caps come from the ENGINE's own loadRuleConfig(db, at), never from\n  listAdjustmentRules. That is the M1 lesson and M-C2 is exactly that regression — its fixture\n  must seed an INACTIVE cap row through the tariff API so the mutant has something to honour.\n- The over_cap error must record the ASKED paise in its detail (the M2 lesson).\n- A clearance CN on an invoice with zero outstanding is a disguised refund →\n  clearance_requires_outstanding, which is already in T1's closed union.\n- A correction must cover the FULL remaining value; a partial \"correction\" is a refund or a\n  clearance discount by definition.\n- Mutants required: M-C1, M-C2, M-C3 — 3 isolated runs each, all required DIED, expected vs\n  received quoted (AGENT-RULES rule 21).",
    criteria: [
      "FAIL-FIRST, EXECUTED AND QUOTED: credit-notes.test.ts observed RED before implementation, failing output quoted. If the red is only an unresolved-import error, say so and state what SEMANTIC red you captured instead (stage the deployable subset). Skippable ONLY by naming a commit SHA that already contains the artifact; none exists.",
      "B-06's worked numbers land as ROWS: the first partial credit produces gross 3333 / discount 333 / cgst 180 / sgst 180 / net 3360, the cumulative second step produces 3334 / 334 / 180 / 180 / 3360, and the final step EXHAUSTS the line exactly (the sum of credit-note nets equals the original line net). Every one of these is hand-derived from the plan, not from program output. The gate will re-derive them.",
      "Clearance-discount caps are read from the tariff engine's own loadRuleConfig(db, at), NOT from listAdjustmentRules — name the loader the code calls. The over_cap error records the ASKED paise in its detail.",
      "A clearance credit note on an invoice whose outstanding is zero is refused with clearance_requires_outstanding; a partial \"correction\" is refused with correction_must_exhaust.",
      "Mutants M-C1, M-C2 and M-C3 each built as SEPARATE scratch files with self-contained specs, each run 3 times ISOLATED (isolation quoted from OUTPUT), each recorded DIED with counts AND with expected-vs-received quoted — never a bare exit code, and never a typecheck failure (AGENT-RULES rule 21). M-C2's fixture seeds an INACTIVE cap row through the tariff API so the mutant has something to honour. All scratch deleted before commit.",
      "settlement.ts is NOT modified. Any derived-state reader you need lives in credit-notes.ts, following the standing resolution from pipeline A.",
      "Test counts quoted from the runner's own summary line by EXACT path for apps/core/src/modules/billing/credit-notes.test.ts. The apps/core workspace total does not decrease and no test is deleted. Report any difference from expectation with its cause.",
      "pnpm verify GREEN, run DETACHED with the exit VALUE read from a file and quoted.",
      "git status clean on the server; local mirror deleted; commit message EXACTLY the plan's Task 7 Commit line; SHA reported; git show --stat shows no path outside the Files list and no frozen path.",
    ],
  },
  {
    id: "t8",
    tier: "CRITICAL",
    model: "opus",
    wave: 2,
    deps: ["t7"],
    title: "Refund vouchers - the four guards, approval-gated always, refund-to-payer",
    body: "TASK T8 — Refund vouchers: the four guards, approval-gated always, refund-to-payer.\n\n  RISK TIER: **CRITICAL**   →  mutants REQUIRED, fail-first OWED, full opus gate.\n  Model: opus (structural money guard + an ordered-lock race + guard-flag derivation).\n\nPLAN SECTION TO FOLLOW IN FULL: \"### Task 8: Refund vouchers — the four guards, approval-gated\nalways, refund-to-payer\". Design context: D6 in full (the four legacy guards in their 2026\nrenderings), D1's advance-balance paragraph, owner ruling R3 in the plan header. Your Assertion\nBook rows: K27, K28, K29, K30.\n\nFILES — EXHAUSTIVE. Anything outside this list is a HALT. Paths under apps/core/ :\n  Create:  src/modules/billing/refunds.ts  + refunds.test.ts\n  Modify:  test/helpers/billing.ts\n\nCARRIED FORWARD FROM PIPELINE A — BOTH ARE YOURS TO OWN, AND NEITHER IS OPTIONAL:\n- **advanceOf is NOT floored at zero, and markEnteredInError does not consider advance-refund\n  vouchers already drawn against the receipt.** D1 states the advance balance is \"never\n  negative: enforced under the ordered receipt-row lock\" — that enforcement is YOUR\n  refund_exceeds_advance, and nothing before you implements it. T6 shipped advanceOf with the\n  full three-term formula (including the voucher subtraction) precisely so you could.\n- **The exported insertReceiptWithTenders does NOT itself assertPaise the tender amounts** —\n  the belt lives in issueInvoice's own boundary. Any new caller carries its own boundary belt.\n  If your code path reaches that helper, put the belt in front of it.\n\nTASK-SPECIFIC NOTES\n- Guard 1 is STRUCTURAL and the test must be built on a genuinely partially-paid (dues) invoice:\n  vouchers against an invoice are capped by money ACTUALLY RECEIVED (Σ effective allocations),\n  not by the invoice's net. M-R1 caps against net instead — on a dues bill that lets the whole\n  thing be refunded.\n- Guards 2+3 are FLAGS, not blocks. terminal_encounter and delivered_line ride the approval\n  payload and the voucher row so the approver sees WHY it is escalated. Nothing is auto-blocked.\n- The advance-refund race (K30) is a *measure* row: floor of 5 ISOLATED runs, isolation quoted\n  from OUTPUT, observed rate reported, and the structural defence named — the SINGLE ordered\n  lock `select id from receipts where patient_id = $1 order by id for update` (the Plan 06.1 C1\n  lesson; never row-then-set). Cite that lesson in the code comment.\n- When you assert something BLOCKS, name the lock AND ITS MODE and confirm no other lock the\n  implementation takes produces the same wait. A gate mutant in pipeline A proved that swapping\n  `for no key update` for `for update` silently destroys a lock test's ability to discriminate\n  (EXECUTION-LESSONS §3.21, fourth bullet).\n- Mutants required: M-R1, M-R2, M-R3 — 3 isolated runs each, all required DIED.",
    criteria: [
      "FAIL-FIRST, EXECUTED AND QUOTED: refunds.test.ts observed RED before implementation, failing output quoted, with the import-only case disclosed and substituted as in AGENT-RULES evidence discipline item 5.",
      "GUARD 1 IS PROVEN ON A GENUINELY PARTIALLY-PAID INVOICE: the fixture has an invoice whose allocations are LESS than its net (a dues bill), and vouchers beyond the allocated amount are refused with refund_exceeds_received. A fixture where allocated == net cannot distinguish M-R1 from correct code and does not satisfy this criterion.",
      "CARRIED-FORWARD ITEM DISCHARGED: advanceOf is floored at zero in effect — an advance refund cannot drive the patient's balance negative, enforced under the ordered receipt-row lock, and refund_exceeds_advance is the refusal. State explicitly how the three-term formula T6 shipped is consumed, and whether markEnteredInError's blindness to drawn vouchers is now reachable; if it is, that is a FINDING to report, not something to fix outside your Files list.",
      "CARRIED-FORWARD ITEM DISCHARGED: every externally-supplied amount reaching insertReceiptWithTenders through your code path passes an assertPaise boundary belt that YOUR code owns — the helper does not carry one.",
      "The advance-refund race (K30) is MEASURED: floor of 5 ISOLATED runs, isolation quoted from OUTPUT, the OBSERVED rate reported, interference addressed per AGENT-RULES rule 20, and the structural defence named as the SINGLE ordered lock over the patient's receipt rows.",
      "Where any assertion claims something BLOCKS, the lock AND ITS MODE are named, and the report states why no other lock the implementation takes produces the same wait.",
      "Mutants M-R1, M-R2 and M-R3 each built as SEPARATE scratch files, each run 3 times ISOLATED with isolation quoted, each DIED with counts and expected-vs-received. All scratch deleted before commit.",
      "Test counts quoted by EXACT path for apps/core/src/modules/billing/refunds.test.ts; workspace total does not decrease; no test deleted.",
      "pnpm verify GREEN, DETACHED, exit VALUE quoted from a file.",
      "git status clean; mirror deleted; commit message EXACTLY the plan's Task 8 Commit line; SHA reported; no path outside the Files list; no frozen path.",
    ],
  },
  {
    id: "t9",
    tier: "CRITICAL",
    model: "sonnet",
    wave: 3,
    deps: ["t8"],
    title: "Tender lifecycle, degraded mode, statement-upload reconciliation",
    body: "TASK T9 — Tender lifecycle, degraded mode, statement-upload reconciliation.\n\n  RISK TIER: **CRITICAL**   →  mutants REQUIRED, fail-first OWED, full opus gate.\n  Model: sonnet (the numeric compare is fully specified by the plan; the judgement here is\n  implementation, not fixture design).\n\nPLAN SECTION TO FOLLOW IN FULL: \"### Task 9: Tender lifecycle, degraded mode, statement-upload\nreconciliation\". Design context: D7's tender-lifecycle and recon paragraphs (E-24/25/26). Your\nAssertion Book rows: K31, K32.\n\nFILES — EXHAUSTIVE. Anything outside this list is a HALT. Paths under apps/core/ :\n  Create:  src/modules/billing/recon.ts  + recon.test.ts\n  Modify:  test/helpers/billing.ts\n\nTASK-SPECIFIC NOTES\n- expectedNetPaise is ALREADY STAMPED on each upi/card tender at CAPTURE time — T5 ships that.\n  You consume it; you do not recompute it. Stamping at recon would let a fee-config change\n  rewrite what \"expected\" meant for old tenders.\n- The tolerance compare is settled vs EXPECTED-NET, never vs the gross amount. M-N1 is exactly\n  that swap, and the card case (150 bps on 50000 → expected 49250) is what makes it visible.\n  Hand-derive the expected-net in a test comment.\n- Re-upload must be idempotent: the per-tender UPDATE is conditional on state 'captured', so an\n  already-reconciled tender is never re-matched. M-N2 makes it unconditional.\n- Unmatched statement refs are REPORTED, never guessed onto a tender.\n- Degraded mode's whole additional effect is the receipt stamp — refText for upi/card is already\n  unconditional via tender_ref_required — so assert the stamp here, where the flag lives.\n- No PSP API anywhere. Statement upload only. A PSP integration is a HALT (scope drift).\n- Mutants required: M-N1, M-N2 — 3 isolated runs each, both required DIED.",
    criteria: [
      "FAIL-FIRST, EXECUTED AND QUOTED: recon.test.ts observed RED before implementation, with the import-only case disclosed and substituted.",
      "The tolerance compare is settled vs EXPECTED-NET, and the card case is hand-derived in a test comment (150 bps on 50000 → fee 750 → expected 49250). expectedNetPaise is CONSUMED from the tender row that T5 stamped at capture, never recomputed at recon time — say where it is read.",
      "Re-upload is idempotent: the per-tender UPDATE is conditional on state 'captured', and a second upload of the same statement leaves an already-reconciled tender untouched. Assert the absence of the second state change, not just a return value.",
      "A malformed CSV row refuses with recon_parse_failed NAMING THE LINE NUMBER, and the batch is NOT persisted. A duplicate ref within one upload refuses with duplicate_ref. Unmatched refs are reported in the batch and the response, never guessed onto a tender.",
      "Mutants M-N1 and M-N2 each built as SEPARATE scratch files, run 3 times ISOLATED with isolation quoted, each DIED with counts and expected-vs-received.",
      "Degraded mode: setDegraded flips config and emits degraded_mode.changed, and while on, a receipt recorded through recordReceipt is stamped degraded: true — asserted here, where the flag lives.",
      "No PSP API, no network call to any payment provider, anywhere in the diff.",
      "Test counts quoted by EXACT path for apps/core/src/modules/billing/recon.test.ts; workspace total does not decrease; no test deleted.",
      "pnpm verify GREEN, DETACHED, exit VALUE quoted from a file.",
      "git status clean; mirror deleted; commit message EXACTLY the plan's Task 9 Commit line; SHA reported; no path outside the Files list; no frozen path.",
    ],
  },
  {
    id: "t10",
    tier: "CRITICAL",
    model: "opus",
    wave: 4,
    deps: ["t9"],
    title: "Pay-before-consult gate (the only OPD edit), charge rules, daily close, GSTR-1",
    body: "TASK T10 — The pay-before-consult gate (the plan's only shipped-code edit), charge rules,\ndaily close + day book + GSTR-1.\n\n  RISK TIER: **CRITICAL**   →  mutants REQUIRED, fail-first OWED, full opus gate.\n  Model: opus (the OPD edit, a dependency-inverted registry, and a report-layer recompute trap).\n\nPLAN SECTION TO FOLLOW IN FULL: \"### Task 10: The pay-before-consult gate (the OPD edit),\ncharge rules, daily close + day book + GSTR-1\". Design context: D8 in full (the guard registry\nand the fee branch), D9's runDailyClose paragraph, and §11.11's orphan scan. Your Assertion\nBook rows: K33, K34, K35.\n\nFILES — EXHAUSTIVE. Anything outside this list is a HALT. Paths under apps/core/ :\n  Create:  src/modules/billing/gate.ts + gate.test.ts\n           src/modules/billing/charge-rules.ts + charge-rules.test.ts\n           src/modules/billing/daily-close.ts + daily-close.test.ts\n  Modify (the D8 hook — EXACTLY these four OPD files, no others, ever):\n           src/modules/opd/consultation.ts\n           src/modules/opd/errors.ts            (+ \"consult_gate_refused\")\n           src/modules/opd/index.ts             (+ 2 export lines)\n           src/modules/opd/consultation.test.ts (+ 3 tests)\n\nCARRIED FORWARD FROM PIPELINE A — THIS SAVES YOU AN AUTHORING PASS:\n- **K35's discriminating fixture ALREADY EXISTS. Do not author a new one.** T2 deliberately\n  built `b09` so the merged GSTR-1 row's stored-head sum (1133 + 1133 = 2266) differs from a\n  group-level recompute (taxHead(37750, 1200) = 2265). That one-paise gap is the whole\n  discriminator for \"the report layer sums STORED heads\". Use b09; M-G3 recomputes at the report\n  layer and must die on it.\n\nTASK-SPECIFIC NOTES\n- This is the ONLY task in the entire plan permitted to edit shipped OPD code, and the four\n  files above are exhaustive. The registry is a keyed Map so re-registration REPLACES — an array\n  would double-register across jest testing modules in one worker.\n- The guard returns a VERDICT; OPD owns the thrown error (consult_gate_refused). A billing error\n  thrown inside an OPD route would 500. Billing supplies data, never exceptions, across that seam.\n- OPD's own tests must still pass unchanged with NO guard registered — that is the regression\n  pin, and it is test 1 of the three you add to consultation.test.ts.\n- revisit is FREE and passes the gate with NO invoice at all. M-G1 makes the check\n  existence-only for every visit type and must die on the revisit leg.\n- The orphan scan reads opd_encounters (indexed), not the event log, and EIE'd fee invoices do\n  NOT count as cover — M-G2 forgets that exclusion.\n- runDailyClose's day claim is ON CONFLICT DO NOTHING: a second run the same day emits no second\n  day.closed and no duplicate orphan events. Assert the absence of the second emission, not just\n  the return value.\n- Mutants required: M-G1, M-G2, M-G3 — 3 isolated runs each, all required DIED.",
    criteria: [
      "FAIL-FIRST, EXECUTED AND QUOTED: the three tests appended to src/modules/opd/consultation.test.ts are observed RED against shipped OPD code before the registry exists, and that red is quoted. Disclose that it is an import-resolution red and state what it does and does not prove.",
      "THE OPD EDIT IS EXACTLY THE FOUR NAMED FILES: consultation.ts, errors.ts, index.ts, consultation.test.ts. Prove it from git show --stat. Any fifth OPD file is a HALT.",
      "REGRESSION PIN: with NO guard registered, startConsultation behaves exactly as shipped — the full happy path re-asserted, green. This is what makes the hook safe for every existing OPD test.",
      "The guard registry is a KEYED MAP: re-registering under the same key REPLACES (idempotent across jest testing modules in one worker), and the returned unregister function restores pass-through. Both asserted.",
      "A not-ok verdict throws OpdError(\"consult_gate_refused\") carrying the guard's code and detail — OPD owns the error shape, billing supplies only data. No BillingError crosses the seam.",
      "revisit passes the gate with NO invoice at all. M-G1 (existence check for every visit type) must DIE on that leg.",
      "K35 USES THE EXISTING b09 FIXTURE — not a newly authored one. The gstr1 summary sums STORED line heads, and M-G3 (recompute at the report layer) dies on b09's one-paise gap (stored 1133+1133 = 2266 vs recompute 2265). State that you used b09.",
      "runDailyClose's day claim is idempotent: a second run the same day emits NO second day.closed and NO duplicate charge.orphan_flagged. Assert the absence of the second emission.",
      "The orphan scan excludes EIE'd fee invoices from cover — an EIE'd invoice still flags. M-G2 forgets the exclusion and must die.",
      "Mutants M-G1, M-G2 and M-G3 each built as SEPARATE scratch files, run 3 times ISOLATED with isolation quoted, each DIED with counts and expected-vs-received.",
      "Test counts quoted by EXACT path for the three new billing suites and for src/modules/opd/consultation.test.ts; workspace total does not decrease; no test deleted.",
      "pnpm verify GREEN, DETACHED, exit VALUE quoted from a file.",
      "git status clean; mirror deleted; commit message EXACTLY the plan's Task 10 Commit line; SHA reported; no path outside the Files list.",
    ],
  },
  {
    id: "t11",
    tier: "ROUTINE",
    model: "opus",
    wave: 5,
    deps: ["t10"],
    title: "Module surface - manifest, module, controller (31 routes), index, AppModule, e2e",
    body: "TASK T11 — Module surface: manifest, module, THE controller (31 routes), index, AppModule,\nfirst e2e.\n\n  RISK TIER: **ROUTINE**   →  no mutants required, no fail-first owed beyond the e2e's own\n  404-red, mechanical verification. (The plan's own Assertion Book row K36 is DECLARED, not a\n  required-DIED row — this tier follows the plan's risk assessment, not a guess.)\n  Model: opus (31 routes, module-init wiring, and the error-body seam below need judgement).\n\nPLAN SECTION TO FOLLOW IN FULL: \"### Task 11: Module surface — manifest, module, THE controller\n(31 routes), index, AppModule, first e2e\". The route table in that section IS the contract —\nimplement it verbatim; the 403 sweep iterates it, so a dropped route fails by count and by name.\n\nFILES — EXHAUSTIVE. Anything outside this list is a HALT. Paths under apps/core/ :\n  Create:  src/modules/billing/manifest.ts\n           src/modules/billing/billing.module.ts\n           src/modules/billing/billing.controller.ts\n           src/modules/billing/index.ts\n           test/billing.e2e.test.ts\n  Modify:  src/app.module.ts   (billingManifest + BillingModule — the two named lines ONLY)\n\nCARRIED FORWARD FROM PIPELINE A — FOUR ITEMS, ALL YOURS. DECIDE THEM, DO NOT DISCOVER THEM:\n1. **updateBillingConfig throws a raw ZodError** with no billing error code. T1's closed\n   BillingErrorCode union has no invalid_config, and errors.ts was outside T3's Files list, so\n   the coder's hands were tied and the gate ruled it forced. `PUT /billing/config` now inherits\n   an untyped throw that has nothing to map onto the ratified OPD-shaped body. **Resolve it\n   here**: either map it in the controller, or extend the union in errors.ts — and if you extend\n   errors.ts, say so explicitly in your report, because that file is not in your Files list and\n   the extension must be ratified rather than assumed. If you judge it out of scope, say that\n   and leave the seam documented; do not leave a 500.\n2. **BillingError ships `message` as OPTIONAL** with `super(message ?? code)`, so a code-only\n   throw renders `message === code` in the HTTP body. Confirm the body is still\n   `{ statusCode, message, code, detail? }` with a message worth reading.\n3. **confirmClose performs NO actor check** — any actor may finalize a `closing` session once\n   the variance approval is granted, and the cashier_session.closed event records that arbitrary\n   caller. Harmless while module-internal; **your route must guard it.**\n4. **listSessions ships with zero test coverage** and orders by openedAt alone (cashier_sessions\n   has no seq column, so it cannot honour the global recency rule). Cover it at the route.\n\nTASK-SPECIFIC NOTES\n- The e2e is written RED-FIRST at 404 against the route table before the controller exists, and\n  that red is quoted. This is the one fail-first this task owes.\n- Leg 2 of the e2e is the load-bearing one: `/opd/.../consult/start` 409 consult_gate_refused\n  while unpaid → pay → 201 start, over REAL HTTP. That is the proof T10's module-init guard\n  registration actually wired up — T10's own test registers the guard by hand, so this is the\n  only place the wiring itself is tested.\n- Error body: the OPD convention `{ statusCode, message, code, detail? }`. Do NOT align\n  patients/tariff to it or it to them. Both conventions are owner-ratified.\n- Unannotated POST returns 201 (Plan 07 E5); this plan annotates nothing.",
    criteria: [
      "FAIL-FIRST: the e2e is written against the route table and observed RED at 404 before the controller exists, and that run is quoted. This is the only red this task owes.",
      "The route table is implemented VERBATIM from the plan's Task 11 Step 1, and the 403 sweep iterates it so a dropped route fails by count and by name. Report the route count you implemented and reconcile it against the table.",
      "THE OPD INTEGRATION LEG IS GREEN OVER REAL HTTP: unpaid consult start returns 409 consult_gate_refused, payment is taken through the billing routes, and the retry starts 201. This is the ONLY proof that billing.module.ts's OnModuleInit guard registration actually wires up — T10 registers the guard by hand in its own test.",
      "CARRIED-FORWARD ITEM 1 RESOLVED AND STATED: updateBillingConfig's raw ZodError is either mapped in the controller to the OPD-shaped body, or errors.ts is extended with a typed code — and if you extended errors.ts you say so explicitly, since that file is outside your Files list and the extension needs ratifying. PUT /billing/config must not 500 on a bad body. If you judge the fix out of scope, say so and leave the seam documented rather than leaving a 500.",
      "CARRIED-FORWARD ITEM 2 CHECKED: a code-only BillingError renders an HTTP body with a message worth reading, not one where message === code. State what the body looks like.",
      "CARRIED-FORWARD ITEM 3 RESOLVED: the confirm-close route guards the actor — an arbitrary caller cannot finalize another cashier's session. Asserted over HTTP.",
      "CARRIED-FORWARD ITEM 4 RESOLVED: the sessions list route is exercised by at least one assertion.",
      "The 403 sweep is green over every route for a permission-less user, and the app.module.ts diff is EXACTLY the two named lines.",
      "Test counts quoted by EXACT path for apps/core/test/billing.e2e.test.ts; workspace total does not decrease; no test deleted.",
      "pnpm verify GREEN, DETACHED, exit VALUE quoted from a file.",
      "git status clean; mirror deleted; commit message EXACTLY the plan's Task 11 Commit line; SHA reported; no path outside the Files list; no frozen path beyond app.module.ts's two lines.",
    ],
  },
  {
    id: "t12",
    tier: "ROUTINE",
    model: "sonnet",
    wave: 6,
    deps: ["t11"],
    title: "Lifecycle e2e, docs, runbook - pipeline B capstone",
    body: "TASK T12 — The lifecycle e2e, docs, runbook.  PIPELINE B ENDS WITH THIS TASK.\n\n  RISK TIER: **ROUTINE**   →  no mutants required. The plan states this task OWES NO RED RUN\n  (it extends shipped surface, and an import-resolution red proves nothing — §12's lesson).\n  Say so in your report rather than manufacturing one.\n  Model: sonnet.\n\nPLAN SECTION TO FOLLOW IN FULL: \"### Task 12: The lifecycle e2e, docs, runbook\".\n\nFILES — EXHAUSTIVE. Anything outside this list is a HALT:\n  Create:  apps/core/test/billing-lifecycle.e2e.test.ts\n  Modify:  README.md  (repo ROOT — the billing section)\n\nCARRIED FORWARD FROM PIPELINE A — THE RUNBOOK MUST CAPTURE THESE FIVE GO-LIVE ITEMS.\nThey were found by pipeline A's gates and they have no other home:\n1. **`nextDocNo` pads to 6 digits unconditionally**, so serial 1,000,000 in a single FY renders\n   `INV/26-27/1000000` = 17 characters and silently breaches the GST 16-char ceiling. There is\n   no runtime guard. Related: seriesPrefixes values are validated as z.string().min(1) with no\n   maximum, so an admin patch to `{ invoice: \"INVOICE\" }` yields 20 chars and\n   validateBillingConfig still returns ok. Document both as go-live watch items.\n2. **`validate:billing` returns ok=true on a config with `caSigned: false`** — observed live in\n   pipeline A. D-17 presents that gate as the thing that blocks the first live invoice; today it\n   does not check the CA signature. The runbook must either stop claiming it or state the manual\n   check that substitutes.\n3. **The `billing_variance` approval carries no amountPaise** (the kernel requires amountPaise>0\n   plus patientId|payeeId, and a session variance is signed and neither patient- nor\n   payee-scoped). The variance value lives only in the event payload and the session row.\n4. **A cashier with ANY non-zero variance is locked out of all counter work** until a\n   billing_manager grants the approval — beginClose moves the session to `closing` and\n   requireOpenSession accepts only `open`. Correct by design, operationally surprising; it\n   belongs in the runbook.\n5. **The dev database `hmis_dev` already carries migrations 0011+0012 and a seeded\n   billing_config row** (applied by T3 through the shipped idempotent `pnpm db:migrate`).\n\nTASK-SPECIFIC NOTES\n- The lifecycle is ONE continuous story over HTTP, and every event-sequence assertion reads the\n  `events` table (name + correlationId), never internal state.\n- Every total in the daily-close and GSTR-1 stories is hand-summed IN COMMENTS from the story's\n  own numbers — not copied from what the code printed.\n- README: the ledger model in three sentences (receipts + allocations, settlement DERIVED), the\n  route table, permission grants per role, and the go-live runbook with each threshold's\n  statutory anchor (269ST ₹2L block / 114B ₹50k PAN / §170 rounding / GST 16-char serials).\n- Run the ROOT verify (whole repo) at the end, detached, exit VALUE read from a file.\n- Because this task ends pipeline B, your report must state the FINAL measured apps/core totals\n  and the final commit SHA, so pipeline C can be compiled against measured reality.",
    criteria: [
      "NO RED RUN IS OWED and the report says so plainly, with the reason (this task extends shipped surface; an import-resolution red proves nothing). Do not manufacture one.",
      "The lifecycle is one continuous story over HTTP covering, at minimum: new-visit pay→consult; the dues story (credit-extend → dues list → partial clear → clearance discount under approval → final clear → settled); the advance story (advance receipt → applied to a later invoice); the refund story (credit note → voucher request → approve → issue → pay bank_transfer above threshold with payee identity); the session story (open → collect → close with variance → SoD refusal on self-approval → manager approves → confirm); the EIE story; the recon story; the daily close; and GSTR-1 over the story's own invoices.",
      "EVERY event-sequence assertion reads the `events` table by name and correlationId — never internal state.",
      "Every total in the daily-close and GSTR-1 legs is HAND-SUMMED IN A COMMENT from the story's own numbers, not copied from what the code printed. The gate will re-derive at least one.",
      "The SoD refusal leg asserts an SoD-SPECIFIC signal (the refusal naming requester_approver, and the SoD event), never a bare status code — two different mechanisms produce a generic refusal identically.",
      "README gains the billing section: the ledger model in three sentences (receipts + allocations, settlement DERIVED, partial settlement first-class), the route table, recommended permission grants per role (cashier vs billing_manager), and the go-live runbook with each threshold's statutory anchor.",
      "THE RUNBOOK CAPTURES ALL FIVE CARRIED-FORWARD GO-LIVE ITEMS: (a) the 6-digit serial pad breaches the 16-char GST ceiling at 1,000,000 in one FY, and seriesPrefixes has no max length; (b) validate:billing returns ok=true even when caSigned is false, so D-17's claim that it blocks the first live invoice is not currently true; (c) the billing_variance approval carries no amountPaise; (d) any non-zero variance locks the cashier out of counter work until a manager approves; (e) hmis_dev already carries 0011+0012 and a seeded billing_config row.",
      "ROOT verify (whole repo) GREEN, run DETACHED with the exit VALUE read from a file and quoted.",
      "git status clean; mirror deleted; commit message EXACTLY the plan's Task 12 Commit line; SHA reported; no path outside the Files list.",
      "PIPELINE B COMPLETION REPORT: state the FINAL measured apps/core totals (suites and tests) and the final commit SHA, so pipeline C is compiled against measured reality rather than a predicted ladder.",
    ],
  },
]

function brief(t) {
  return [
    RULES,
    PLAN_REF,
    BASELINE,
    t.body,
    MIRROR,
    MUTANTS_FOR(t),
    FROZEN,
    HALTS,
    DEVIATIONS,
    FINISH,
  ].join(SEP)
}

function MUTANTS_FOR(t) {
  return t.tier === 'CRITICAL' ? MUTANTS_CRITICAL : MUTANTS_ROUTINE
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'files_changed', 'tests', 'interpretations'],
  properties: {
    outcome: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    interpretations: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'violations', 'corrections', 'tests'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    violations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'detail'],
        properties: {
          type: { type: 'string', enum: ['criterion-unmet', 'test-failure', 'scope-creep', 'overengineering', 'bad-interpretation', 'agent-error'] },
          detail: { type: 'string' },
        },
      },
    },
    corrections: { type: 'array', items: { type: 'string' } },
    retry_mode: { type: 'string', enum: ['reimplement', 'verify-only'] },
    findings: { type: 'array', items: { type: 'string' } },
    tests: {
      type: 'object', additionalProperties: false, required: ['ran', 'passed', 'failed'],
      properties: { ran: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' } },
    },
  },
}

const DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['findings', 'commits_read'],
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    commits_read: { type: 'array', items: { type: 'string' } },
    cross_task_risks: { type: 'array', items: { type: 'string' } },
    carried_forward_to_c: { type: 'array', items: { type: 'string' } },
  },
}

function coderPrompt(t, history) {
  let p = CODER_PERSONA + SEP + brief(t)
  p += '\n\nAcceptance criteria your work must meet:\n' + t.criteria.map(function (c) { return '- ' + c }).join('\n')
  p += '\n\nIf any part of the brief is ambiguous, choose the most reasonable interpretation, complete the task, and list every such choice in the interpretations field of your report. Never expand scope beyond the brief.'
  p += '\n\nIf a tool call is denied by the permission system, do not attempt the same change through another tool or shell command; stop and record the denial verbatim in the outcome field of your report.'
  if (history && history.length) {
    p += '\n\nA reviewer FAILED ' + history.length + ' previous attempt(s) at this task. Full failure history, oldest first:'
    history.forEach(function (v, idx) {
      p += '\nAttempt ' + (idx + 1) + ' violations: ' + v.violations.map(function (x) { return x.type + ' - ' + x.detail }).join('; ')
      p += '\nAttempt ' + (idx + 1) + ' corrections: ' + v.corrections.join('; ')
    })
    if ((history[history.length - 1] || {}).retry_mode === 'verify-only') {
      p += '\nThe reviewer judged the implementation itself CORRECT AND COMPLETE. Do not rewrite, re-generate, or re-commit the code. This attempt is verification only: re-run the required commands, capture their real output, and satisfy every correction with evidence. Do NOT manufacture a fail-first run by mutating shipped state - if a legitimate red run is impossible without mutating what already shipped, say so plainly in interpretations. If a prior attempt at THIS task already pushed the artifact, you may discharge a fail-first criterion by NAMING THAT COMMIT SHA.'
    } else {
      p += '\nThe files are currently in the state the most recent attempt left them. Apply every correction.'
    }
  }
  return p
}

function gatePrompt(t, report) {
  return GATE_PERSONA + SEP
    + 'Review one completed implementation task. Its risk tier is ' + t.tier + '.\n\nTask brief given to the coder:\n' + brief(t)
    + '\n\nAcceptance criteria:\n' + t.criteria.map(function (c) { return '- ' + c }).join('\n')
    + '\n\nCoder report (JSON):\n' + JSON.stringify(report)
    + '\n\nRead the changed files yourself, re-run the covering tests yourself, check every criterion one by one. Fail scope creep and overengineering. Rule on each flagged interpretation.'
    + '\n\nEVIDENCE DISCIPLINE (binding on you). (a) A test-name filter must ISOLATE and you confirm isolation from OUTPUT, never an exit code: use "pnpm --filter PKG exec jest --passWithNoTests PATH -t NAME" and read the "N skipped, 1 passed" line. (b) Never take a pipeline or wrapper exit status as a command verdict - read a captured exit file. (c) NEVER lower an evidence bar an earlier gate on this task already set. (d) Your own scratch lives under /opt/hmis or your local mirror and you DELETE all of it before returning; confirm the tree is clean of your residue. (e) Verify the Files list and the frozen-path list against "git show --stat" of the actual commit, not the coder summary. (f) Where the plan hand-derives a money value, RE-DERIVE it yourself. (g) A mutant that died at TYPECHECK proves nothing - this repo runs noUncheckedIndexedAccess; require expected-vs-received from the assertion itself.'
    + '\n\nYOU MAY AND SHOULD USE THE LOCAL MIRROR (AGENT-RULES rule 22) for reading the diff and the sources. Pull the tree once, read natively, and use SSH only for the test runs and git inspection you must do on the server.'
    + '\n\nRECORD WHAT YOU DISCOVER THAT DOES NOT FAIL THE TASK: an unprompted mutant that SURVIVED, a criterion claiming a proof its test cannot deliver, a latent defect outside scope, a false assumption in the brief, a defect shipped DORMANT that a later task will arm. Put each in the findings array and pass the task anyway if the criteria are met. findings is the only field that survives into the pipeline report.'
    + '\n\nIf you fail the task, set retry_mode: "verify-only" when the code is correct and your corrections only ask for evidence or cleanup; "reimplement" when code must change. Never write a correction that instructs rewriting published history, deleting anything in a working tree the user did not name for destruction, or weakening security-relevant code.'
}

function mechanicalPrompt(t, report) {
  return MECHANICAL_PERSONA + SEP
    + 'Mechanically verify one completed ROUTINE-tier task. You are NOT a design reviewer: you check objective facts and return a verdict.\n\n'
    + 'Task: ' + t.id.toUpperCase() + ' - ' + t.title + '\n\nIts Files list and acceptance criteria:\n'
    + t.body + '\n\nAcceptance criteria:\n' + t.criteria.map(function (c) { return '- ' + c }).join('\n')
    + '\n\nCoder report (JSON):\n' + JSON.stringify(report)
    + '\n\nRUN EXACTLY THIS CHECKLIST ON THE SERVER (root@62.238.106.231, /opt/hmis) AND REPORT WHAT YOU OBSERVED:\n'
    + '1. "pnpm verify" DETACHED with its exit code written to a file; read and quote the exit VALUE from that file. Never a piped or wrapped status.\n'
    + '2. "git show --stat <the task commit>" - every path must be inside the task Files list. Quote the stat.\n'
    + '3. Frozen-path check: confirm the commit touches nothing under apps/web/, packages/contracts/, .github/, apps/core/drizzle/, apps/core/src/kernel/, apps/core/src/modules/{tariff,patients}/, apps/core/test/helpers/db.ts, apps/core/package.json, pnpm-lock.yaml, jest.config.cjs, tsconfig*. OPD files are permitted ONLY for T10.\n'
    + '4. CI status for the commit SHA (gh run list --commit <sha>).\n'
    + '5. "git status --porcelain" is EMPTY and no "*.mutant.*" residue exists anywhere outside node_modules.\n'
    + '6. The commit message matches the plan Commit line for this task.\n'
    + '7. Each acceptance criterion: met / not met, one line each, from what you observed - not from the coder report.\n'
    + '\nFAIL the task if any of 1-6 fails or any criterion is unmet. Otherwise PASS. Put anything odd you noticed but that does not fail the task into findings.\n'
    + 'Delete every scratch file you create before returning, and say that you did.\n'
    + 'You may use the local mirror (AGENT-RULES rule 22) for reading; the commands above still run on the server.'
}

const results = {}
const failed = new Set()

// ==== RESUME, 2026-08-20 ====
// The first run of this pipeline was interrupted after wave 4. Verified on the build host
// before this script was launched (git log origin/main, and the absence of T11's files):
//   t7  b04ce1c  feat(core): credit notes - cumulative partial-refund arithmetic ...
//   t8  6da4f8f  feat(core): refund vouchers - approval-gated always ...
//   t9  1e04dc2  feat(core): tender reconciliation - statement upload ...
//   t10 e4b2836  feat(core): pay-before-consult gate via OPD guard registry ...
//   (plus d2d8371, a main-session repair commit that greened the baseline)
// NOTHING ELSE IN THIS FILE CHANGED. Every brief, the ladder, the review split, the halt
// conditions and the discovery prompt are byte-identical to the pre-flighted compile.
// The discovery reviewer still reads the WHOLE pipeline (its prompt scopes itself to every
// apps/core commit after a044ee1), so T7-T10 are reviewed across tasks exactly as compiled.
const RESUME_FROM_WAVE = 5
const ALREADY_SHIPPED = { t7: 'b04ce1c', t8: '6da4f8f', t9: '1e04dc2', t10: 'e4b2836' }
Object.keys(ALREADY_SHIPPED).forEach(function (id) {
  results[id] = { status: 'done', resumed: true, sha: ALREADY_SHIPPED[id], attempts: 0 }
})

async function runTask(t) {
  const unmet = t.deps.filter(function (d) { return (results[d] || {}).status !== 'done' })
  if (unmet.length) {
    results[t.id] = { status: 'skipped', reason: 'dependency not done: ' + unmet.join(',') }
    failed.add(t.id)
    return
  }
  const history = []
  // A rung advances ONLY on a real review rejection. Infrastructure failures retry the same
  // rung and never promote the tier.
  const LADDER = [
    { model: t.model, label: t.model + ':' + t.id },
    { model: t.model, label: 'retry:' + t.id },
    { model: 'opus', label: 'escalate:' + t.id },
  ]
  const MAX_INFRA = 3
  let infra = 0
  for (let rung = 0; rung < LADDER.length; ) {
    const a = LADDER[rung]
    const report = await agent(coderPrompt(t, history), { model: a.model, label: a.label + (infra ? '~' + infra : ''), phase: 'Wave ' + t.wave, schema: REPORT_SCHEMA })
    if (!report) {
      if (++infra > MAX_INFRA) {
        results[t.id] = { status: 'failed', reason: 'infrastructure: coder unavailable', attempts: rung + 1, history }
        failed.add(t.id)
        return
      }
      log(t.id + ': coder infra failure ' + infra + ' - same rung, tier unchanged')
      continue
    }
    // Review shape depends on the risk tier (EXECUTE-METHOD v2 section 4).
    const isCritical = t.tier === 'CRITICAL'
    const reviewModel = isCritical ? 'opus' : 'sonnet'
    const reviewLabel = (isCritical ? 'gate:' : 'check:') + t.id + '#' + (rung + 1)
    let verdict = null
    for (let g = 0; g <= MAX_INFRA; g++) {
      verdict = await agent(
        isCritical ? gatePrompt(t, report) : mechanicalPrompt(t, report),
        { model: reviewModel, label: reviewLabel + (g ? '~' + g : ''), phase: 'Wave ' + t.wave, schema: VERDICT_SCHEMA },
      )
      if (verdict) break
      infra++
      log(t.id + ': reviewer infra failure ' + infra + ' - re-judging the same work, no new coder attempt')
    }
    if (!verdict) {
      results[t.id] = { status: 'failed', reason: 'infrastructure: reviewer unavailable', attempts: rung + 1, history }
      failed.add(t.id)
      return
    }
    if (verdict.verdict === 'pass') {
      results[t.id] = { status: 'done', tier: t.tier, attempts: rung + 1, files: report.files_changed, tests: verdict.tests, interpretations: report.interpretations, findings: verdict.findings }
      log(t.id + ': PASS on rung ' + (rung + 1) + ' (' + a.model + ' coder, ' + reviewModel + ' ' + (isCritical ? 'gate' : 'check') + ')')
      return
    }
    history.push(verdict)
    log(t.id + ': rung ' + (rung + 1) + ' rejected - ' + verdict.violations.map(function (v) { return v.type }).join(',') + (verdict.retry_mode === 'verify-only' ? ' (verify-only retry)' : ''))
    rung++
  }
  results[t.id] = { status: 'failed', attempts: LADDER.length, history }
  failed.add(t.id)
}

const waves = [...new Set(TASKS.map(function (t) { return t.wave }))].sort(function (a, b) { return a - b })
let stalled = false
for (const w of waves) {
  if (w < RESUME_FROM_WAVE) {
    log('wave ' + w + ' shipped in the interrupted first run (' +
        TASKS.filter(function (t) { return t.wave === w }).map(function (t) { return t.id + '=' + ALREADY_SHIPPED[t.id] }).join(' ') +
        ') - not re-run')
    continue
  }
  phase('Wave ' + w)
  await parallel(TASKS.filter(function (t) { return t.wave === w }).map(function (t) { return function () { return runTask(t) } }))
  if (TASKS.filter(function (t) { return t.wave === w }).some(function (t) { return (results[t.id] || {}).status !== 'done' })) {
    log('wave ' + w + ' did not complete - the chain is sequential, so later waves will skip')
    stalled = true
    break
  }
}

// One DISCOVERY reviewer for the whole pipeline (EXECUTE-METHOD v2 section 4). Cross-task
// findings - a defect shipped dormant by one task and armed by another, a convention nothing
// tests - are structurally invisible to a per-task reviewer.
let discovery = null
if (!stalled) {
  phase('Discovery')
  discovery = await agent(DISCOVERY_PROMPT, { model: 'opus', label: 'discovery:pipelineB', phase: 'Discovery', schema: DISCOVERY_SCHEMA })
}

return {
  tasks: results,
  discovery: discovery,
  halted: [...failed],
  resumed_from_wave: RESUME_FROM_WAVE,
  already_shipped: ALREADY_SHIPPED,
  summary: Object.values(results).filter(function (r) { return r.status === 'done' }).length + '/' + TASKS.length + ' done',
}
