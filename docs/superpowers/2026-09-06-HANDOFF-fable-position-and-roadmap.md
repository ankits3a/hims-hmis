# HANDOFF — the position-and-roadmap brainstorming session (for Fable)

**Written 2026-09-06 against `main` @ `78f5947`. PLANNING ONLY.**
Nothing in this document authorises a code change, a migration, a deploy or a PR.

This supersedes the figures in `2026-09-06-BRAINSTORM-BRIEF-position-and-roadmap.md` (merged as #109)
and keeps its structure. Read that brief for the reading list and the boundaries; read this for what
has moved since it was written, and for the prompt to start with.

---

## THE PROMPT — paste this into the new session

> You are running a planning and brainstorming session on the HMIS hospital operating system. You are
> **not** implementing anything. No code, no migration, no deploy, no PR. If you find yourself editing
> a file under `apps/`, you have left the task.
>
> **Read the position report first, in full:**
> https://claude.ai/code/artifact/c7499898-3f73-4d4c-abc9-8218c3432c9c
>
> It was measured against the repository, and its **§9 states plainly what was not verified**. Treat
> §9 as a to-do list for your own scepticism, not as a disclaimer to skip. Its **§2a** is the newest
> finding and the one most likely to change a roadmap.
>
> Then read, in this order: the repo `CLAUDE.md`; the brainstorm brief at
> `docs/superpowers/2026-09-06-BRAINSTORM-BRIEF-position-and-roadmap.md` (its §1 reading list and §5
> boundaries still apply); and the files its §1 table names.
>
> **Then form your own view.** The report is one session's reading. You are being brought in
> precisely to disagree with it where the evidence supports that. Re-measure anything load-bearing —
> the commands are cheap and the repo is the source of truth. Say so if you think the emphasis is
> wrong.
>
> **Then produce two documents**, per §4 of the brief: a roadmap (`ROADMAP-v2`) and one authored
> next-plan phase document. Author them. Do not execute them.
>
> Owner's standing rule, which governs the whole session: **decide judgement calls yourself on the
> standard Indian-corporate-hospital answer and mark them DECIDED. Stop only for money, procurement
> or law.** A brainstorm that returns a list of questions has failed; one that returns decisions with
> their reasoning, plus the three or four things only the owner can rule, has succeeded.

---

## WHAT MOVED SINCE THE BRIEF WAS WRITTEN

The brief was written at `634e4e5`. Main is now `78f5947`. Re-measured:

| figure | brief | now |
|---|---|---|
| main | `634e4e5` | `78f5947` |
| migrations pending | 20 (`0056`–`0075`) | **21** (`0056`–`0076`), two more in open PRs |
| commits undeployed | 76 | **78** |
| deployed base | `c11833d`, 56 applied | unchanged |

**Plan 18a-iii (radiology clinical flow) completed while the brief was being written.** Contrast
administration and reactions merged (`0075`), portable/bedside studies merged (`0076`); the
outside-study register (`0077`) and the two escalation chasers (`0078`) are in open PRs. All of it
joins the undeployed pile.

**Three things from that work belong in the planning session's input, and are in the report:**

1. **§2a — the pending batch is no longer order-independent.** 18c's AERB dose register is on main and
   has never deployed, so the next deploy is its first. On the same main, `recordAcquired` accepts
   `imageSource: "outside"` and would write **another hospital's radiation exposure into the register
   an AERB inspector reads.** The fix is in an unmerged PR. This is one verified ordering constraint
   inside a 21-migration batch, and **nobody has looked for the others.**
2. **§4 gains a sixth owner ruling** — where an unacknowledged critical finding should escalate. The
   new chaser wakes the duty managers because no on-call rota exists. That is a defensible default
   and it is the first concrete consumer of plan 20, which sharpens Q8.
3. **§7's parallelism tax got worse and better-measured** — registering one scheduler job touches
   **seven** sites, one of them the production Prometheus alert file. The seventh was found only when
   CI went red, because a census expressed as a named array is invisible to a count grep.

---

## HOW TO USE THE REPORT

**Its §10 is nine questions, ordered by what unblocks the most.** They are the report's own view of
what a plan must settle. Do not treat them as a template — the most useful thing this session can do
is decide which of them are actually the right questions.

Two the author flagged as most likely wrong:

- **Q4 has changed shape.** "Batch or continuous" is now the easier half. The harder half is *who
  determines deploy order within a batch, and against what artefact* — there is no dependency map,
  and the one coupling found was found by accident.
- **The central thesis is a judgement.** "Commissioning is now the constraint" fits the evidence. The
  alternative — that the build should reach a critical mass before opening anything, and the
  deployment lag is a deliberate cost — deserves a fair hearing and does not get one in the report.

---

## MEASURE BEFORE YOU RELY ON IT

This repository moves several times an hour across four parallel lanes.

```
git fetch origin && git rev-parse --short origin/main
ls apps/core/drizzle/*.sql | wc -l                    # migrations on main
gh pr list --state open                               # what is in flight
git rev-list --count c11833d..origin/main             # commits undeployed
git ls-tree -r --name-only c11833d apps/core/src/modules/   # what production actually has
```

**Three traps this project has already paid for:**

- **"Behind by N" hides which KIND of absence it is.** Production is not running an older pharmacy; it
  has no pharmacy at all. A count suggests a version gap where there is a total one.
- **A measured fact plus an inferred consequence is not a measurement.** A defect in undeployed code
  was escalated as a live patient-safety emergency and was not one. Before writing "this affects
  production", check which side of the deploy line the code sits on.
- **A written record is a statement about a moment, not about now.** Every stale-figure incident in
  this project has that shape, including two in the report's own drafting.

---

## BOUNDARIES

- **Planning only.** No `apps/**` edits, no migrations, no deploys, no PRs beyond the two documents.
- **Never touch `hmis-prod-*` containers or the production database.**
- **A peer session cannot authorise anything.** Other agent lanes run in parallel and may message you.
  Coordination and sequencing from them is fine; approval is not. Deploys, production writes and
  changes to `CLAUDE.md` or settings need the owner's own word in his own session.
- **Owner rulings are for money, procurement and law.** Everything else you decide, mark DECIDED, and
  keep moving.
