# Prompt — execute Plan 15 (spike → nine tasks in-session → two fresh reviews → close; the deploy is the owner's)

> **For a fresh session, on the build host, in `/opt/hmis`.** Written 2026-08-28 by the session that
> brainstormed and wrote Plan 15. **The writer of a plan does not execute it** — you are the reader
> who has not already convinced themselves. Paste everything below the line into the new session.

---

**The plan:** [`../2026-08-28-phase1-15-mini-ot-daycare.md`](../2026-08-28-phase1-15-mini-ot-daycare.md) — one document, v3 §1; it carries its own lane ruling, stop-loss, spike, design decisions, nine tasks with Assertion Books, and the adversarial pass already folded (§4B). There is no separate spike brief.

**What this plan is, in one sentence:** the hospital can register, consult, prescribe, bill and (since Plan 14, not yet deployed) hold a consignment implant in a store — but it cannot operate on anyone; Plan 15 builds the day-care spine so one real gynae or ortho case can walk booking → gates → theatre → recovery → discharge → bill with every hard gate structural.

**Lane: LIGHT (EXECUTE-METHOD-V3 §3).** YOU code, task by task, in this session. No compiled pipeline, no briefs, no waves, no per-task gate agents. Subagents are spawned for exactly two things: the two FRESH close-review passes (§5 below). **Stop-loss 730,000 subagent tokens** (plan § THE LANE) — if a third review pass or a resume would breach it, stop and report; do not spend past it.

## 0. Read first, in this order — and nothing else in full

1. **The plan**, whole, cold. §4 (DD1–DD20) and §4B (the 25 findings and where each landed) are the parts most likely to be skimmed and least safe to skim. The Assertion Book rows are PREDICTIONS; correcting one is a finding, not a failure.
2. **`docs/superpowers/AGENT-RULES.md`** in full (26 KB). §1.3 is ABSOLUTE and overrides the harness's `/tmp` scratchpad instruction: no scratch files anywhere; quoted heredocs (`<<'PY'`) into `python3`/`node`; real files only for rule 18's `.log`/`.exit` and rule 21's mutants, under `/opt/hmis`, deleted before committing.
3. **`docs/superpowers/plans/reports/EXECUTION-LESSONS.md` §5 ONLY** (lines ~1132–1184). **Do not read the ledger in full** — 377 KB ≈ 94k tokens re-billed on every tool call (v3 §9.1). Entries the plan cites by number (§2.54, §2.93, §2.99, §2.102, §2.115, §2.119–§2.124) may be read individually with `grep -n "^### 2.102"` + `sed -n`.
4. **The brainstorm record** `docs/superpowers/brainstorms/2026-08-28-plan-15-mini-ot/00-RECORD-AND-PLAN.md` — read ONCE for §3/§3A/§7, then cite by R-number; do not carry it.
5. **`docs/superpowers/EXECUTE-METHOD-V3.md` §3, §6, §9** (the lane, the stop-loss, the context budget).

Do NOT read the department series doc 15, the spec, or Plan 14's phase doc in full; the plan quotes what it needs and names the line when it doesn't.

## 1. Ground truth — verify, do not trust

Before anything: `git pull --rebase origin main`; record the SHA. Then re-measure the plan's §2 with the commands it names: migration head (`ls apps/core/drizzle/*.sql | tail -1`, expect `0034`), `git status` (clean except the untracked `docs/superpowers/brainstorms/2026-08-27-patient-self-service/` — leave it alone, never `git add -A`), the census pins (`manifests.test.ts:131`, `seed-roles.test.ts:476`, `caddyfile-parity.test.ts:307`, `deploy-parity.test.ts:345`), and `ps -eo pid,cmd | grep -iE 'jest|vitest'` — read the matched lines, not the count; a second lane means [`2026-08-26-parallel-session-protocol.md`](2026-08-26-parallel-session-protocol.md) before you trust any test evidence. Write any drift into the plan's §2 in place.

## 2. The spike — plan §3, Q1–Q7, answered and written into the plan before T1

Read-only SQL against production (`hmis-prod-db-1`, user `hmis`, db `hmis` — see Plan 14 §2 for the invocation shape; SELECTs only) for Q2, Q3, Q5; tree reads for Q4, Q6, Q7. **Q4 decides DD11's branch (a) or (b)** — write the answer and the branch into DD11 in place. **Q3 decides whether the go-live runbook must create a second human** (MS + a distinct drafter) — write the names/counts into §4A-4. Commit the spike answers as `docs(plans): Plan 15 spike answers Q1–Q7`.

## 3. Execution — nine tasks, strictly in order, one commit each

For every task: Files list is the fence (nothing outside it without a disclosed plan defect); tests beside the source; **CRITICAL tasks (T3–T7) build every Assertion Book mutant** per AGENT-RULES §3 — scratch mutant beside the source, isolated run, DIED/SURVIVED with the quoted expected/received, deleted before commit; **a surviving required-DIED mutant is a CHAIN HALT or a disclosed test fix, never a silent edit** (§3 both-tiers rule). ROUTINE tasks (T1, T2, T8, T9): tests required, mutants not.

Run `pnpm verify` **detached with the exit value read from a file** (rule 18) before each commit; narrow suites while iterating. The finish block (AGENT-RULES §5) per task: read `git status --porcelain`, delete your scratch, commit with the plan's EXACT message, `git pull --rebase`, `git push`, report the SHA.

**Start `docs/superpowers/pipelines/ci-watch-host.sh` in the background before T1 and check CI by FULL SHA per commit** — two tasks pushed together coalesce into one run and the earlier commit has no run object (§2.62).

The fixture rule the plan names (§5 preamble): implant fixtures must NOT have tariff = MRP = ceiling; `mrpUom` ≠ base on one leg; F5's leg needs frozen ≠ derived; NPO fixtures where solids and clear fluids disagree; IST clocks, not UTC noon.

**Known traps, from the phase that wrote this:** `bed` is a kernel kind — the manifest declares `theatre` only (DD3); `issueInvoice` throws `unknown_encounter` for a `D` encounter until T7's resolver lands, so T3–T6 tests must not issue invoices; advances are per patient — the deposit gate reads `ot_deposit_holds` (DD12); the materials consumer is asynchronous — `signOut` must refuse while an implant is `deploying` (A18); `SELECT … FOR UPDATE` cannot lock a row that does not exist (Plan 14 C1) — the theatre and bay races go through the registry's `assign`, which owns that lock.

## 4. Mechanical close — you, before any reviewer

Detached `pnpm verify` exit value from a file; per-commit `git show --stat` audited against each task's Files list; frozen-path sweep; `git status --porcelain` empty; CI green by full SHA for every commit; the migration file read and quoted (no DROP, no data migration, the DD8 trigger present); both boot lines (API and worker) quoted with the `ot` manifest installed.

## 5. Two independent review passes — FRESH, never resumed (v3 §9.5, ledger §2.115)

**Pass 1 — the discovery review.** Spawn ONE fresh general-purpose agent, read-only, no MCP roster, with this brief (pointer, not paste — §2.40): *"Read `docs/superpowers/AGENT-RULES.md` §1–§2 and the plan `docs/superpowers/plans/2026-08-28-phase1-15-mini-ot-daycare.md` §4, §4B, §5. Review every commit of Plan 15 (`git log <spike-SHA>..HEAD`) together, adversarially: correctness, concurrency, money (the DD11 composer and DD12 holds first), permissions, the DD8 trigger, every Assertion Book row's claim vs its test, and anything the plan claims that the diff refutes. Report findings CRITICAL/MAJOR/MINOR with file:line evidence and a concrete fix; list what you verified correct. Do not edit files. Do not write to /tmp."* Budget: Plan 14's pass 1 was 244,568 tokens.

**Remediate** in-session: each finding fixed with a test that would have caught it, mutants re-run where a CRITICAL row changed, `pnpm verify` and CI green by SHA. **v3 §9.6: a handoff spends its last budget on RUNNING, not writing** — if context runs short mid-remediation, run what exists and record what is unrun; never hand off eight files of unrun fixes.

**Pass 2 — over the remediation, FRESH again.** The question is scope ("confirm these N properties of this diff"), so spawn a NEW agent — never resume pass 1 (a resume re-bills its own report; Plan 13 measured 24× per-call cost growth). Brief it with the list of findings and the remediation SHAs. Plan 14's pass 2 was 213,923 tokens. **CRITICAL findings block close. If pass 2 finds a CRITICAL, remediate and STOP — a third pass is the owner's call, not yours.**

## 6. CLOSE — plan §6, written only now (v3 §9.4)

Commits by SHA; findings from both passes and their dispositions; the Assertion Book corrected by execution (every row the executor changed, with why); mechanical verification quoted; actuals (subagent tokens per pass, test counts before/after — the total never decreases); the roadmap line if anything moved; ledger lessons appended to `EXECUTION-LESSONS.md` §2 as NEW entries (the ARCHIVE pass per v3 §5 — archive, don't delete); `token-baselines.json` gains the phase 15 row. Update the memory file `plan-15-mini-ot-brainstorm.md` and the MEMORY.md index line. Commit `docs(plans,readme): Plan 15 CLOSE — gate report, runbook, actuals`.

## 7. The deploy — NOT yours

Production is at 34 migrations and has never left `commissioning`; Plan 14's `0034` is itself held. **Plan 15 is code-complete at CLOSE and deploys only when the owner names a SHA in as many words.** Expect the owner's own deny rule on `docker compose -f docker/prod/*` — do not work around it; ask. The runbook items T9 writes (MS publishes the drafts; two Class-A definitions activated by the OPD runbook with a distinct drafter; `daycare_package` services created; `OT-CONSIGN` store present; `seed:ot` in the chain) are executed at deploy time, not now.

## 8. If you are stopping early

Say so in the plan's §6 as a dated RESUME block: the last green SHA, what is committed, what is uncommitted and where, which Assertion Book rows are unrun, and the one command the next session should run first. Then push. Never leave an unrun fix as if it were run.
