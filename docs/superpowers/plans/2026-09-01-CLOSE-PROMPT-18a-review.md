# EXECUTE PROMPT — Plan 18a's independent close review

**Paste the block below into a NEW Claude Code session in `/opt/hmis`.** It is written to be
self-contained: it names the one file that carries the full context, the one task, and the rails.

---

```
Run Plan 18a's independent CLOSE REVIEW in /opt/hmis, on the build host. All nine tasks are done
and pushed; the review is the only thing left.

SEED YOURSELF FROM, IN THIS ORDER:
  1. docs/superpowers/plans/reports/2026-09-01-plan-18a-CLOSE-HANDOFF.md  — read it IN FULL
  2. docs/superpowers/plans/2026-08-29-phase1-18a-radiology-core.md §9.2 (findings) and §6 (the CONTRACT)
  3. docs/superpowers/AGENT-RULES.md §3 and §5, and docs/superpowers/EXECUTE-METHOD-V3.md §9.6
You do NOT need the phase document's §0–§5.

YOUR TASK is §9.6 and §9.6.2 — two review passes, both FRESH, and then §9.7's actuals, which wait
on them by rule (v3 §9.4). Do NOT start new feature work and do NOT deploy.

WHAT TO REVIEW: everything this phase shipped. The tip is ec0aa8a. The diff is
  git diff d5abf6a..ec0aa8a -- apps/core/src/modules/radiology apps/core/src/modules/pcpndt \
    apps/core/src/kernel/db/schema/radiology.ts apps/core/src/kernel/db/schema/pcpndt.ts \
    apps/core/drizzle/0047_radiology_core.sql apps/core/drizzle/0050_form_f_completion.sql \
    apps/core/test/radiology.e2e.test.ts apps/core/test/helpers apps/web/src

START WITH THE CONTRACT PASS. Read the phase document's §6 clause by clause against the shipped
code. That instrument found TWO real defects in ten minutes at this phase's own close (F39, F40),
under 3,315 passing tests and thirty dead mutants, and neither had a failing test. Six defects in
total were found by READING after the suite was green. Reading beat testing here; start there.

THE FIVE PLACES MOST LIKELY TO BE WRONG, ranked, are in the handoff's §3. The FOUR FINDINGS ALREADY
OPEN AND AWAITING YOUR RULING — F19, F24, F35, F41 — are in its §4, with the concrete ask for each.

THREE RAILS, and the handoff's §6 has the detail:
  - COMMIT with a pathspec (`git commit -m "…" -- <paths>`) and read `git diff --cached --stat`
    against your own file list first. The checkout is SHARED; a peer lane swept 54 staged lines of
    another lane's work into its own commit on 2026-09-01.
  - NEVER run a bare `pnpm verify` — it OOMs the box. Sequential halves, its own database:
      TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_18a_review" \
        pnpm --filter @hmis/core exec jest --passWithNoTests
      pnpm --filter @hmis/web exec vitest run
      pnpm --filter @hmis/contracts test
    Coordinate the slot by message first (ListAgents, then SendMessage).
  - A red that is all `setupTestDb` HOOK timeouts with ZERO assertion diffs is the RUNNER, not the
    tree — count `grep -c "Received:"` before believing it. And if a suite is red today and was
    green yesterday with no diff between, suspect the CALENDAR before anything else (F28).

A full pass ran at ed754cc and is recorded (core 3314/3315, web 404, contention census zero). The
close commit ec0aa8a landed after it and its affected suites were re-run green, but NO full pass
over the final tip has been observed. Running one is a reasonable first act.

WHEN YOU FIND SOMETHING: record it in §9.2 with its own finding number (the next free is F45),
name its owner, and fix it in-task only if the fix is inside this phase's own files. If a fix
reaches outside them, report it as a plan defect with evidence rather than taking it — except where
the defect makes the phase unbuildable, which is the branch F25 took and disclosed.

DO NOT: deploy, start T-anything, or widen either error union without ruling on F41 first.
```

---

## Why this prompt is shaped this way

**It points at the handoff rather than restating it.** §2.40's lesson, applied: a prompt that pasted
the rules would cost the review's context before it began, and the handoff is one file the reviewer
reads once.

**It names the CONTRACT pass first and says why.** That is the single highest-yield instrument this
phase found, and a reviewer who starts with the test suite will start where six defects had already
hidden successfully.

**It names the four open findings by number with their asks**, so the reviewer rules rather than
re-discovers.

**It states the three rails that cost this phase real clock** — the shared index, the OOM, and the
two ways to misread a red — because every one of them was learned by losing time to it.
