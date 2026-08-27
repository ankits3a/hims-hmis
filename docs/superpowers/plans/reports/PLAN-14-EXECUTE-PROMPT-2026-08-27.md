# Plan 14 execute-prompt — Materials core

**Written 2026-08-27, immediately after the phase document was committed at `5c69950`.** Paste the fenced block below into a fresh Claude Code session **on the build host**, model Opus. It is an EXECUTION prompt: the session it starts codes the nine tasks of the phase document, task by task, and closes the phase. It does not re-plan.

**Its ground-truth block is written to be RE-MEASURED, not trusted.** Plan 13's launch prompt was wrong about three numbers within a day of being written, and its kickoff re-measure recorded that nothing had moved — both outcomes are worth the two minutes. Read the numbers yourself before you write one into a commit.

---

```
Plan 14 — Materials core: item & vendor masters, stores, and the stock ledger. EXECUTE THE PHASE
DOCUMENT. You are on the build host, in /opt/hmis, the checkout that produces evidence.

═══ THE SEED (EXECUTE-METHOD-V3 §1) — three reads, then execute ═══

  1. docs/superpowers/plans/2026-08-27-phase1-14-materials-core.md — the phase document. ALL of it,
     once: THE LANE, §1–§5, and §6.6. It is ~79 KB / ~20k tokens and it is the only phase-specific
     artifact. Every design decision, every Files list, every Assertion Book row and every exact
     commit message is in it. Do not re-derive any of them and do not re-open a DD marked RULED.
  2. docs/superpowers/AGENT-RULES.md (24 KB) — the execution contract, in full. Rules 14–21 are the
     ones with no exceptions: evidence from this host only, exit values read from files, mutants
     built as separate scratch files and run isolated, never fix a surviving mutant silently,
     never amend or force-push, migrations are irreversible host mutations (§6).
  3. docs/superpowers/plans/reports/EXECUTION-LESSONS.md — **§5 ONLY (lines ~1081–1095, "What is
     working")**. DO NOT READ THE LEDGER IN FULL: it is 362 KB / ~90k tokens and is re-billed on
     every tool call (v3 §9.1). Cite entries by number; if the phase document names one you need,
     `grep -n "^### 2.54"` and read that entry alone.

═══ THE LANE, THE STOP-LOSS, AND THE ONE REVIEWER ═══

  LIGHT (v3 §3): YOU code, task by task, sequentially, T1 → T9, in this session. No pipeline, no
  briefs, no coder subagents. Five tasks are CRITICAL (T3, T4, T5, T6, T7) and carry inline
  Assertion Books: build every mutant they name, beside the source, isolated, quote DIED/SURVIVED
  with expected-vs-received, delete scratch before committing. ROUTINE tasks (T1, T2, T8, T9) need
  tests, not mutants.

  Stop-loss 675,000 tokens (phase doc, THE LANE). It is a tripwire: crossing it halts the phase for
  an owner decision. Track your subagent spend; main-session cost is unmeasurable from inside
  (runbook O3) — say so in CLOSE rather than estimating it.

  ONE independent reviewer, after T9, fresh context, restricted tool set, no MCP roster. It reads
  every commit of the phase together. Its CRITICAL findings block close; its MAJORs are fixed and
  the fix is REVIEWED AGAIN — a remediation is unreviewed code on the same path (09a and 13 both
  found their best defect there). THE RESUME RULE (v3 §9.5, ledger §2.115): resume the reviewer
  only when the question needs what it REMEMBERS ("is the fix for the defect YOU found correct?");
  spawn FRESH when the question is scope ("confirm these N properties of this diff"). A resumed
  reviewer costs ~1.3× its previous invocation and the per-call cost climbs 24× by the third pass.

  CI is watched, not assumed: run pipelines/ci-watch-host.sh in the background for the duration
  and record green-by-full-SHA per COMMIT (§2.62 — two commits coalesced into one push leave one
  with no run object; check each). For a red you cannot explain from the diff, `gh auth status &&
  gh run view <id> --log-failed` before calling it a flake (§2.100).

═══ KICKOFF, BEFORE T1 — WRITE THESE INTO THE PHASE DOCUMENT IN PLACE ═══

  a. Re-measure phase doc §2 (AGENT-RULES §6). Expected at write time, 2026-08-27:
       · migration head 0033_worried_salo.sql, 34 .sql files → this phase generates 0034
         (`ls apps/core/drizzle/*.sql | tail -1` AND `git status` for one someone generated
         but did not commit — two open phases contended for a number twice on 2026-08-26)
       · ALL_MANIFESTS = 13; worker leg 3 = exactly four (ops, membership, formulary, resources)
       · permission census 78 declared = 64 held + 14 not-yet-modelled (seed-roles.test.ts:453,
         :527, :544, :802, :810; README tables at lines ~281 and ~594)
       · SPA routes 25 (caddyfile-parity.test.ts:304) · deploy seeds 11 (deploy-parity.test.ts:398)
       · workerConsumers returns THREE handlers · worker.module.ts does NOT call collectResourceKinds
       · suites: apps/core 219 files / apps/web 43 / packages/contracts 4
       · `grep -rli vendor apps/core/src --include=*.ts` (non-test) = zero files
     Append a "RE-MEASURED AT KICKOFF" block under §2 whether or not anything moved.
  b. Answer Spike Q1–Q5 read-only against production (`docker exec hmis-prod-db-1 psql -U hmis -d
     hmis -Atc "…"`) and write each answer under its question. Q6 is answered at T2. Q4: if
     operating_mode_changes shows `live`, the deploy at the end is an operational act on a working
     hospital and the owner authorises it as one.
  c. Parallel-work fence: `ps -eo pid,cmd | grep -iE 'jest|vitest'` — READ the matched lines, never
     count them. Another lane means reports/2026-08-26-parallel-session-protocol.md before any test
     evidence is trusted. Several idle claude sessions are normal on this host; a running suite is not.

═══ PER TASK — the finish block, every time ═══

  · Build to the task's Files list. If a file you must touch is NOT in the list (a census pin, a
    truncate statement, a parity test), that is a PLAN DEFECT: add it, record it as a finding in
    CLOSE, do not work around it silently (AGENT-RULES: disclose-don't-work-around).
  · A discriminating input that turns out NOT to discriminate is a finding, not a failure — correct
    the row in the phase document and say so (Plan 13 corrected four).
  · `pnpm verify` detached, exit value read from a file, BEFORE push. Narrow suites while iterating;
    the FULL workspace suite runs ONCE, at T9 (AGENT-RULES §2.8). Workspace test total may not
    decrease; no test deleted (§4).
  · `git status --porcelain` read before any `git add`; no *.mutant.* residue; commit with the EXACT
    message from §5; `git pull --rebase origin main`; `git push origin main`; report the SHA.
  · Generate 0034 only when ready to carry it to T1's commit (AGENT-RULES §6). Read the generated
    SQL — `materials.test.ts` pins five CHECKs through pg_constraint because the generator can drop
    one silently.

═══ THINGS THIS PHASE IS MOST LIKELY TO GET WRONG — read the DD before the task ═══

  · T2 moves FOUR censuses (manifests 13→14, permissions 78→measured, deploy seeds 11→12, the
    per-module declared block) AND fixes the worker's missing collectResourceKinds call (DD2). The
    manifest is installed in BOTH processes, so leg 3 stays at four — say so in the (1e) comment.
  · T2 ships `subscriptions: []`. T7 adds the ONE subscription and its workerConsumers handler in
    the SAME commit — a declared subscription with no handler is a worker boot error.
  · T5's concurrency rows (A8, A9) need two connections and a barrier; give the test a budget an
    idle host cannot pass by luck (09a: a race test 9s inside a 15s budget was green idle, red busy).
  · T6 rule 6 is `<`, not `<=` (A15): mrp EQUAL to cost passes; free goods (cost 0) never trigger.
  · T7 A20: the obvious fixture cannot discriminate — the balance must be kept ≥ 1 by a second OWNED
    batch so only the LOT check can refuse.
  · Every NEW MaterialsError code reaches a controller: walk `toHttp` through the SHARED mapper
    (Plan 13 M-class: a kernel refusal escaped an OPD controller as a 500, introduced by the fix).
  · For every fixture, the coinciding fields are listed in §5's standing note (qty_in_uom =
    qty_base, mrp = cost, occurred_at = recorded_at, one store, one batch, ownership = owned):
    write one leg where each differs (§2.102).

═══ CLOSE (phase doc §6) ═══

  Findings as they arrive · the Assertion Book corrections · the reviewer's report and every pass's
  token count · mechanical verification (detached `pnpm verify` exit 0, per-commit `git show --stat`
  against Files lists, clean tree, CI green by full SHA per commit) · the actuals row — NOT before the
  reviewer has returned (v3 §9.4) · lessons bound for the ledger · the ledger ARCHIVE pass (v3 §5) ·
  run pipelines/token-audit.js and follow the token-audit skill · the roadmap amendment (§6.6 already
  carries the slice; append the CLOSED line).

═══ THE DEPLOY — OWNER-AUTHORISED, IN AS MANY WORDS ═══

  One deploy, after T9 and after the reviewer has passed. Do NOT run docker/prod/deploy.sh on the
  strength of a green suite. Ask the owner for authorisation naming the commit SHA, the migration
  (0034, additive, no data migration) and `seed:materials` in the seed chain. Then deploy, verify
  `to_regclass('items')` etc. non-NULL and `seed-materials` idempotent on the live box, and record
  it in CLOSE.

═══ THE HARD STOPS ═══

  · Stop-loss crossed → halt, report, owner decides.
  · A surviving required-DIED mutant whose fix is outside your Files list → CHAIN HALT (AGENT-RULES §3).
  · A reviewer CRITICAL → fix, re-review, and only then close.
  · Never touch /opt/hmis-prod except through deploy.sh under owner authorisation. Never hand-edit
    drizzle/meta/_journal.json. Never amend or force-push.
```

---

## Two notes for whoever pastes it

**The phase document is the contract; this file is only the seed.** If the two disagree, the phase document wins and the disagreement is a finding for CLOSE.

**Opus and the context budget.** The whole point of v3 §9 is that an agent pays its full context on every tool call. This prompt points at ~27k tokens (phase doc + AGENT-RULES + ledger §5). The single most expensive thing the executing session can do is `cat` the ledger, a whole brainstorm document, or `/opt/hmis-context/` — none of which it needs. Read files with `sed -n` ranges and `grep -n`, not whole.
