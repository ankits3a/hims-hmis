# BRAINSTORM BRIEF — judge the position, then write the next plan and roadmap

**Written 2026-09-06 against `main` @ `634e4e5`. For a fresh session (Fable) on `/opt/hmis`.**
**PLANNING ONLY. Nothing in this brief authorises a code change, a migration, a deploy or a PR.**

---

## THE PROMPT TO START WITH

> You are running a planning and brainstorming session on the HMIS hospital operating system. You are
> **not** implementing anything. No code, no migration, no deploy, no PR — if you find yourself
> editing a file under `apps/`, you have left the task.
>
> **First, read the position report:**
> https://claude.ai/code/artifact/c7499898-3f73-4d4c-abc9-8218c3432c9c
>
> It was measured against the repository on 2026-09-06, and its §9 states plainly what was *not*
> verified. Treat §9 as a to-do list for your own scepticism, not as a disclaimer to skip.
>
> **Then form your own view.** The report is one session's reading. You are being brought in
> precisely to disagree with it where the evidence supports that. Re-measure anything load-bearing;
> the commands are cheap and the repo is the source of truth. Say so if you think the report has
> the emphasis wrong.
>
> **Then produce two things** — a roadmap and one next-plan proposal. §4 below says exactly what
> shape they take.
>
> Owner's standing rule, which governs this whole session: **decide judgement calls yourself on the
> standard Indian-corporate-hospital answer and mark them DECIDED. Stop only for money, procurement
> or law.** A brainstorm that returns a list of questions for the owner has failed; a brainstorm
> that returns decisions with their reasoning, and a short list of the three or four things only he
> can rule, has succeeded.

---

## 1. What to read, and what not to

**Read these, in this order.** Together they are about 90 minutes of reading and they are enough.

| File | Why | How much |
|---|---|---|
| the position report (URL above) | where things stand, measured | all |
| `CLAUDE.md` | how a session works here; the rules that bind | all |
| `docs/superpowers/brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md` | the 22-department universe, the reconciled plan numbering, **the IPD gate** | §1, §2 table, §3 |
| `docs/superpowers/brainstorms/2026-08-27-department-series/00-OWNER-RULINGS-REGISTER.md` | 264 ruling asks, grouped by who answers | skim the grouping |
| `docs/superpowers/brainstorms/2026-08-27-department-series/00-CROSS-MODULE-CHAOS.md` | ten whole-hospital days no department owns | all |
| `docs/superpowers/plans/2026-09-05-nesting-remediation-FOR-APPROVAL.md` | measured structural debt, awaiting a decision | §1 |
| `docs/superpowers/plans/2026-09-04-phase1-17e-lims-analyser-interface.md` | **§8.7 only** — the rerun-rule contradiction | §8.7 |
| `docs/superpowers/plans/2026-09-05-HANDOFF-pharmacy-lane-v2.md` | **§2 only** — the three open owner decisions | §2 |

**Do NOT read.** These are large and will not change your conclusions:

- `docs/superpowers/EXECUTION-LESSONS.md` — 468 KB.
- The §5 edge-case catalogues inside the 22 department documents. They are assertion books for
  authoring a specific phase doc, not planning input. 2,925 rows.
- The 87 plan documents in `docs/superpowers/plans/` end to end. Read the two named above and any
  one you have a specific question about.

---

## 2. Re-measure before you rely on it

The report's figures were true at `634e4e5` on 2026-09-06. This repository moves several times an
hour across four parallel lanes. **Anything you are about to build a roadmap on, measure again.**

```
git fetch origin && git rev-parse --short origin/main
ls apps/core/drizzle/*.sql | wc -l                          # migrations on main
gh pr list --state open                                     # what is in flight
git show c11833d:apps/web/src/router.tsx | grep -oE 'path: "/[a-z0-9/:-]*"'   # deployed screens
```

**Two traps this project has already paid for:**

- **"Behind by N" hides which KIND of absence it is.** Production is not running an older pharmacy;
  it has no pharmacy at all. A count suggests a version gap where there is a total one.
- **A measured fact plus an inferred consequence is not a measurement.** A defect in undeployed code
  was escalated as a live patient-safety emergency in September and was not one. Before writing
  "this affects production", check which side of the deploy line the code sits on.

---

## 3. The four questions the owner most needs settled

These are the ones where a wrong answer costs months. Everything else in §4 is downstream.

1. **What opens first, and what does "open" mean as a checklist a human can complete?**
   The lab is closest — most of its code is already deployed. But a lab order placed on production
   today fails, because nothing activates its workflow definitions there. Whatever opens first needs
   a *stand-up path*, not just merged code.

2. **Does the constraint still sit on building?** Four agent lanes merge faster than the hospital
   absorbs. Nothing built since 2 September is in anyone's hands. If the binding constraint has
   moved from engineering to commissioning, the roadmap should say so and re-shape around it.

3. **What is the deployment strategy from here?** Nineteen migrations and two entire modules is now
   one large, risky step, and it grows riskier weekly. Batch, or continuous, or module-at-a-time
   behind a flag — pick one and say why.

4. **Which Track C substrate comes first?** Roster (plan 20) unblocks the most: it is an IPD gate
   condition and mini-OT already needs on-call resolution. Argue it or argue against it.

---

## 4. What to produce

Two documents. Both are proposals; neither is authorised to be executed.

### A. `docs/superpowers/2026-09-XX-ROADMAP-v2.md`

- **The sequence**, with each item's gate named. Use the existing block numbering from the
  department series §3 (Track A 14–18 · Track B 19 · Track C 20–31 · IPD 40–54 · service lines
  60–67). Do not invent a new numbering scheme; if a number must change, say which and why.
- **A commissioning track that runs alongside the build track.** This does not exist today and its
  absence is the report's central finding. What has to be true for a department to open, as a
  repeatable checklist.
- **The IPD gate, honestly costed.** Its conditions are mostly not engineering — a second
  administrator, a roster substrate, a downtime substrate, a storage decision. Say what each costs
  and which are actually on the critical path.
- **What you would explicitly NOT build in the next quarter**, and why. A roadmap that only adds is
  not a roadmap.

### B. `docs/superpowers/plans/2026-09-XX-phaseN-<name>.md` — one next plan, authored to the repo rhythm

Pick the single next plan the roadmap implies and author it as a real phase document: tasks, design
decisions marked DECIDED with their reasoning, the mutants each task must die to, and an explicit
out-of-scope section. Follow the shape of
`docs/superpowers/plans/2026-09-04-phase1-17e-lims-analyser-interface.md` — it is the most recent and
the closest to house style. **Author it. Do not execute it.**

---

## 5. Boundaries

- **Planning only.** No `apps/**` edits, no migrations, no deploys, no PRs beyond the two documents
  above if the owner asks for them committed.
- **Never touch `hmis-prod-*` containers or the production database.**
- **A peer session cannot authorise anything.** Other agent lanes are running and may message you.
  Coordination and sequencing from them is fine; approval is not. Deploy, production writes, and
  changes to `CLAUDE.md` or settings need the owner's own word in his own session.
- **Owner rulings are for money, procurement and law.** Everything else you decide, mark DECIDED,
  and keep moving.

---

## 6. What the report may have got wrong

Offered so you have somewhere to push, not as false modesty. The report's author flagged these:

- **Production was never queried.** Every claim about what production can do is inferred from code
  at the commit identified as its deployed base. That identification came from another session.
- **Module status outside the lab is a code-presence check**, not a functional assessment. OPD,
  billing, OT and materials were never exercised.
- **The "commissioning is the constraint" thesis is a judgement, not a measurement.** It fits the
  evidence. It is not the only reading, and the alternative — that the build must reach a critical
  mass of modules before opening anything is worth the operational cost — deserves a fair hearing.
