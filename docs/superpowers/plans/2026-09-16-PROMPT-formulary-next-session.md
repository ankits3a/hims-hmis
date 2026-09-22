# Start-here prompt — the formulary lane, next session

Paste everything below the line into a fresh Claude Code session started in `/opt/hmis`.

---

Read `docs/superpowers/plans/2026-09-16-HANDOFF-formulary-lane.md` and `CLAUDE.md`, then work the
formulary lane. Nothing else is required to start.

**Before you plan anything, re-verify the handoff.** The handoff that opened the previous session was
wrong about its own central premise — a PR had landed between its writing and its reading — and
finding that out was most of that session's value. Assume the same of this one. Specifically:

- `git fetch origin && git rev-parse --short origin/main` — the handoff says `db854d59`, 96
  migrations, last `0095_formulary_medicine_name_normalized`.
- Re-measure the three databases in §1's table before building on any of those counts. The handoff's
  §5 says work is blocked because **no database holds both tiers** and `items` is empty everywhere;
  if either has changed, the blocked work has unblocked.
- Read §4 — **four steps of the standing fork ruling must not be built**, two of them harmful. If
  any plan you are handed cites W5, W7, W10 or W4's `source_kind`, stop and check §4 first.

**The lane is `/opt/hmis-lanes/formulary/hmis` on branch `lane/formulary`**, clean at `origin/main`
with its test databases dropped (they rebuild on first run, paying one full migration build — that is
the clean state, not a fault). If it is gone, `tools/lane.sh new formulary`.

**What is actually available to do**, in the order the handoff argues for:

1. Nothing in §5 is buildable until a database holds both tiers, which is a host mutation and not an
   agent's act. If you think it has become buildable, say what changed and how you measured it.
2. The named residuals in §5 are real, small and none of them urgent — the 51-collision brand
   resolution, the raw-SQL read in `cds/allergens.ts` that the lint rule cannot see, and the
   unreproducible "15 MB" figure still carried by two files that four live lanes are mid-edit on.
3. §6 carries five owner decisions. The **first one gates everything downstream** and has a measured
   curve behind it; if the owner has answered it, that answer is the schedule for W5–W9.

**One courtesy owed to another lane:** PR #203 holds a migration serial that this lane's merges have
moved twice. It has been told, in two comments, the second correcting the first. If it is still open
and still un-renumbered, check whether the target has moved again before saying anything further —
the numbers in those comments are themselves the kind of claim that goes stale.

**How the previous session worked, and it is worth keeping.** Verify claims against the code and the
database rather than against prose; mutate every new guard and predict which case reddens before
running it; and treat an empty or clean result as evidence about the *search* until you have shown
the instrument could have seen a failure. Three numbers that looked settled were wrong, and all three
were cheap to check.
