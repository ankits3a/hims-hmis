# session-method — how a session starts, what it reads, how a handoff works, what instruments exist, what has failed

Read-only survey, 2026-09-06 18:54 UTC. Repo paths are relative to the `main-ro` checkout (`origin/main` @ `b04cbd9`); `O/` = `/opt/hmis-lanes/.orchestrator/` (on disk, NOT in git); `M/` = `~/.claude/projects/-opt-hmis/memory/`. Every number under "measured" was produced by a command in this session; everything else is cited to a line.

## 0. The position, re-measured at write time — and it already disagrees with CONTEXT.md

- `origin/main` = `8de8fc0` (#140 merged 18:41 UTC). `main-ro` (`b04cbd9`) is already 1 behind; `/opt/hmis` is on `c11833d`, **91 commits behind** (`git rev-list --count HEAD..origin/main`).
- **Production is NOT on `c11833d`.** `docker image ls` shows `hmis-prod/server:latest` and `:399f92c` built `2026-09-06 12:35:00 UTC`, all nine `hmis-prod-*` containers "Up 6 hours" (db and node-exporter up 2 weeks). `O/BLOCKERS.md:8-30` explains: a mutation run of the commissioning lane's deploy-guard test executed `deploy.sh` for real; `399f92c` is on `lane/commissioning-t3/t5/t6`, **not on main**; there is no image rollback for that deploy. `M/deploy-sh-executed-by-a-test.md:13-25` is the lane's own account. `O/state/deployed-base.txt` still reads `c11833d0ed…`; `wf/CONTEXT.md:20` says "runs the deployed base `c11833d`". Both are now a remembered value.
- 23 open PRs (`gh pr list`): #117–#122 (11i T3/T5/T6/T7/T8/T9), 11 lims/radiology/pharmacy fix PRs from this afternoon, #73 the held hotfix. 20 PRs merged today.
- The `deploy-blocker` label **exists** (`gh label list`), although the newest handoff says "No `deploy-blocker` label exists yet" (`docs/superpowers/2026-09-06-HANDOFF-commissioning-lane-11i.md:44`).

## 1. A day in the life of a fresh session — its first ten minutes, today

1. The harness injects `CLAUDE.md` (64 lines) and `MEMORY.md` (19,871 B, an index over 102 memory files, symlinked into every lane by `tools/lane.sh:18-23,59-61`). The memory index carries status lines written on different days that contradict each other: `MEMORY.md:31` "Plan 18b … NOT DEPLOYED" vs `:99` "18a/18b/18c all DEPLOYED".
2. It is (usually) pasted a **THE PROMPT** block from a handoff doc. Seven of ten handoffs on main carry one (`2026-09-04-HANDOFF-lims-lane.md:9-34`, `…radiology-lane-18c-T6.md:185-210`, `2026-09-05-HANDOFF-radiology-lane.md:160-185`, `…FD25-screens.md:8-28`, `…FD25-next.md:199-230`, `2026-09-06-HANDOFF-commissioning-lane-11i.md:15-30`, `…fable-position-and-roadmap.md:12-37`). The prompt names the handoff FIRST, then `CLAUDE.md`, then named sections of a phase doc, and says what NOT to read — exactly the §5A.2 shape (`EXECUTE-METHOD-V3.md:133-146`). Three handoffs have no prompt and open with "Read `CLAUDE.md` first, then this. Nothing else." (`2026-09-04-HANDOFF-front-desk-FD11.md:3`).
3. It runs `tools/lane.sh new <name>` (or `cd`s into an existing worktree): worktree at `/opt/hmis-lanes/<name>/hmis`, branch `lane/<name>`, its own `TEST_DATABASE_URL`, memory symlink (`tools/lane.sh:37-73`). Then, if the handoff told it to, `lane-report.sh <lane> WORKING …` and `board.sh` (`2026-09-05-HANDOFF-radiology-lane.md:23-49`).
4. It re-measures, because every handoff tells it to: `git fetch && rev-parse origin/main`, `ls apps/core/drizzle/*.sql | wc -l`, `gh pr list --state open`, `git ls-tree -r c11833d …` (`2026-09-06-BRAINSTORM-BRIEF-position-and-roadmap.md:61-82`; `…HANDOFF-fable-position-and-roadmap.md:93-101`; `…HANDOFF-radiology-lane.md:51-69`). The deployed-base SHA it re-measures against is **given to it in prose** and is wrong tonight (§0).
5. It reads the handoff's "state in one paragraph" (`…commissioning-lane-11i.md:34-44`), which was true at `f211075` this morning and is now wrong on the deployed base, the pending count and the label.
6. If it is on the 11i lane it discovers the handoff itself lived on `origin/lane/roadmap` until #112 merged (`…commissioning-lane-11i.md:18-20`) and that a plain copy sits out of git at `/opt/hmis-context/handoffs/` (measured: one file, 09:42).
7. It has spent ~15–25k tokens of context and has three different answers to "what is deployed" (CONTEXT/handoff prose, `deployed-base.txt`, the docker daemon), and no way to know which lane owns what except by reading `git worktree list` and `O/state/*.status` — whose four heartbeats are 5.5 h, 13 h, 13 h and 36 h old (measured §4.F7).

That is the day. Nothing in it is a single command that prints "the milestones".

## 2. Rituals

### R1 · `tools/lane.sh new | drop | list | status | gc` (in git)
One worktree + branch + private test DBs per session (`tools/lane.sh:4-9`); `status` prints claude sessions on a tty, jest/vitest runners, free memory, and every worktree's `+ahead/-behind origin/main` and dirty count (`:97-113`); `gc` drops orphan `hmis_lane_*` databases (83 were found on 2026-09-02, `:116-118`). `drop` refuses over uncommitted or unpushed work (`:79-84`). **Measured now, not remembered** — it reads git and `ps`. Anyone can run it.

### R2 · The handoff document + THE PROMPT
`EXECUTE-METHOD-V3.md:133-146` (§5A.2): every task boundary ends with a handoff; the successor's prompt names it FIRST and says which phase-doc sections are not needed; measure the phase doc with `wc -c` at every close. Contents by convention: state in one paragraph, how to see it, what shipped, rulings, traps, open items in priority order, the prompt (`2026-09-05-HANDOFF-front-desk-FD23.md:10-156` headings). Handoffs now live in **three directories** — 10 in `docs/superpowers/`, 9 in `docs/superpowers/plans/`, 4 in `docs/superpowers/plans/reports/` (measured `ls | grep -ci handoff`) — plus the out-of-git copy. Supersession is by a prose banner at the top of the old file (`2026-09-05-HANDOFF-front-desk-FD25-next.md:3-9`) or by a line in `O/BRANCH-CENSUS.md:46-55` that says "a reader who greps `HANDOFF-pharmacy` gets two hits and no ordering". Hand-written; remembered.

### R3 · One document per phase, `§8 CLOSE` appended "as the phase runs"
`EXECUTE-METHOD-V3.md:26-49`: the phase doc holds why / spike / D-sections / tasks / CLOSE, and CLOSE "is the findings inbox and the gate report"; the fact rule (`:45-48`) says a SHA or measurement appears once. Measured: 11i's `## 8. CLOSE — filled at execution` is **empty on `origin/main`** after T0/T1/T2/T4 merged (#113–#116), and none of those four PRs touched any `docs/` file (`gh pr view N --json files`). The ritual exists; the four executing sessions did not perform it.

### R4 · Gate report / findings inbox / spike report (v3 retired them; 73 files remain)
`EXECUTE-METHOD-V3.md:40-43` retires them as separate artefacts. `docs/superpowers/plans/reports/` still holds 73 files, newest named `2026-09-01-*` (measured). The **relay note** of `2026-08-26-parallel-session-protocol.md:201-207` ("the only channel between sessions that survives") has had no new entry since 09-01; handoffs replaced it without anyone retiring the paragraph.

### R5 · The PR train (out of git)
`O/bin/train-driver5.sh` merges a given PR list in order under a `flock` — added after two drivers both reached #85 and GitHub's server-side lock was the only thing that prevented a double merge (`train-driver5.sh:8-20`); it refuses to start under a held lock (`:27-35`; measured `O/state/train-run3.log`, `train-run5.log`: "REFUSING to start"). It gates on `mergeStateStatus`, not on counting green rows (`O/bin/README-train-driver.md:5-19`), and refuses #73 by name (`train-driver5.sh:6`; `land-pr.sh:2-4`). A migration-`when` guard was added 2026-09-06 (`train-driver5.sh:38-70`). Baton state is prose in `O/MERGE-TRAIN.md` (`:29-45`). Branch protection's up-to-date rule makes every merge invalidate every open PR (`O/BLOCKERS.md:321-333`; `M/stacked-prs-under-branch-protection.md`). CI runs each commit twice (`.github/workflows/ci.yml:6-12`; `…HANDOFF-radiology-lane.md:44-48`) and an agent cannot `gh run rerun` (`…commissioning-lane-11i.md:123`).

### R6 · The S-gate and the seven gates
`2026-09-06-ROADMAP-v2.md:480-486` (§8): a phase closes when its stand-up path has been executed on UAT and the execution is dated in the runbook. `§3` (`:351-390`) defines G1–G7 per module with an artefact each: G1–G4 answered by `standup:check` (script), G5 a dated `## Executed` section in the runbook, G6 the harvest, G7 the `ops.config_validated` event. Rule 3 (`:376-377`): "Four runbooks exist; zero have run." Measured: no runbook under `docs/runbooks/` has an `Executed` section (grep for `executed|run on|date` found none of that shape); PR #122 (11i T6) is the first attempt and is open.

### R7 · Heartbeat + board (out of git)
`O/bin/lane-report.sh:13-15` overwrites `O/state/<lane>.status` and appends to `<lane>.log` with branch, drift, dirty and a free-text line; `O/bin/board.sh` prints memory, load, the test-lock holder, the four lanes' branch/drift/dirty/state, the merge train, and open PRs (`:5-30`). Push-based; nothing ages a stale row.

### R8 · `BLOCKERS.md` — "the owner's morning file" (out of git)
`O/ORCHESTRATOR-HANDOFF.md:57` names it; measured 184,912 B; its own map says "2600 lines and grew all night by appending … NOT in priority order and the newest are at the bottom" (`O/BLOCKERS.md:306-309`). It records the accidental deploy (`:8-30`), the settled baseline (`:402-425`), and that the pending count "has now been wrong on this page three times — 18, then 19, now 21" (`:414-416`).

### R9 · The orchestrator's own handoff and PRACTICES
`O/ORCHESTRATOR-HANDOFF.md:7-16` defines the role: holds no lane, writes no product code, serialises merges, arbitrates shared files, relays findings, executes privileged actions under its own user's approval; "Give lanes SEQUENCING, never AUTHORITY" (`:18-22`). Its primitives are listed with the admission "all in this directory, none of it in git — not backed up" (`:45`). `O/PRACTICES.md` is 322,818 B with 204 `##` headings (measured) — the same append-only shape as `EXECUTION-LESSONS.md` (476,650 B) that `CLAUDE.md:61` forbids reading.

### R10 · Memory
`MEMORY.md` + 102 files, shared across lanes by symlink (`tools/lane.sh:18-21`). It is where the sharpest lessons live (`M/written-diagnoses-go-stale.md:14-27`; `M/pnpm-build-does-not-exist.md:12-39`), and where status lines rot (`MEMORY.md:31` vs `:99`).

## 3. Instruments — what measures, where, who, and whether it is measured or remembered

| instrument | measures | lives | who runs | measured? |
|---|---|---|---|---|
| `tools/lane.sh status/list` | sessions, runners, free RAM, per-worktree drift/dirty | git | any session | yes |
| `O/bin/board.sh` | RAM/load, test-lock holder, 4 lanes' heartbeat rows, merge train, open PRs | disk | any session | half: git rows yes; STATE column is the heartbeat (remembered); **hard-codes four lane names** (`board.sh:13`) — commissioning, pharmacy-launch, roadmap, roadmap-v3 are invisible (9 worktrees measured) |
| `O/bin/test-lock.sh status` | who holds the jest/vitest mutex, since when | disk | any | yes (`test.holder`: front-desk mid-jest since 18:50) |
| `O/state/<lane>.status` | last self-reported state | disk | lanes write, orchestrator reads | **remembered** — see F7 |
| `standup:check <module\|all>` | G1–G4 census, three verdicts ok/RED/NOT MODELLED, through module loaders | `apps/core/scripts/standup-check.ts:23-79,126` | any DB owner; `deploy.sh:542-545` runs it non-fatally | yes — but only `hospital`, `lab`, `pharmacy`, `radiology` rows (`:128,210,322,361`) |
| `check:config-present` | rows modules throw without; aborts the deploy | `deploy.sh:514-523` | deploy | yes |
| `validate:config` | may the hospital leave commissioning (CA signature, tariff) — G7 | `apps/core/scripts/validate-config.ts` | owner | yes |
| `seed-roles` READY verdict | every role key held by a human | `deploy.sh` (per ROADMAP §3 G4 row) | deploy | yes |
| `restore-drill.sh` | census → backup → restore into scratch → migrator → census asserted back; exit code + `backup.drill_passed/failed` event | `docker/prod/drill/restore-drill.sh:1-35,192-195,338`; log `$DEPLOY_DIR/log/restore-drill.log` (`deploy.sh:691`) | cron Sat 22:00 UTC | yes — last PASSED 2026-09-05 22:00 UTC per `…commissioning-lane-11i.md:39-40` (not re-read here: `/opt/hmis-prod` is off limits to this survey) |
| `deploy.sh` refusals | dirty tree, HEAD ≠ origin/main, prod target with ALLOW_DIRTY | `deploy.sh:47-61` | owner | yes; but the **only record of a deploy** is docker tags (`:63-65`, T8's SHA tag visible as `:399f92c`) and `log/` — no ledger row, no event (grep `log\|record\|stamp\|deployed` found none) |
| CI (`ci.yml`) | typecheck/lint/relay tests, 2 core shards, web tests + `vite build` | `.github/workflows/ci.yml:15-102` | push + PR | yes, twice per commit |
| `pipelines/ci-watch-host.sh` | green/red/did-not-run per SHA over unauthenticated API | `docs/superpowers/pipelines/` | any | yes |
| `gh pr list`, `gh label list` | what is in flight; `deploy-blocker` | GitHub | any | yes |
| `git ls-tree <deployed-sha>`, `ls drizzle/*.sql \| wc -l` | what a base carries; migrations on main | git | any | yes, **given the right SHA** |
| `docker image ls hmis-prod/*` | when/what was last built for prod | daemon | root | yes — the second instrument the pharmacy lane used (`O/state/pharmacy.status`) |
| `O/BRANCH-CENSUS.md` recipe | unlanded work by CONTENT (diff vs main), not by PR list | `:1-11` | orchestrator | yes when run; the file is a remembered result |
| `O/state/deployed-base.txt` | the deployed SHA | disk | hand-written | **remembered — wrong tonight** |
| phase-doc tails, runbook status lines, handoff §1, `MEMORY.md`, `2026-08-11-phase1-plan-series.md` (175,685 B) | "CLOSED / CODE-COMPLETE / NOT DEPLOYED" | git + memory | hand-written | remembered |
| the position report | the measured position of 2026-09-06 morning | a claude.ai artifact URL (`…BRAINSTORM-BRIEF…:14-15`) | one session | remembered; not in the repo |

## 4. Failure modes observed — with evidence

**F1 · Three sessions wrote the same handoff in parallel.** `M/roadmap-v2-and-11i-2026-09-06.md:69-84`: two sessions wrote `2026-09-06-HANDOFF-commissioning-lane-11i.md` at the same path on different branches (`lane/roadmap` vs `docs/roadmap-brainstorm-brief`), a third added §10-I; hmis-c1 merged them by hand; two commit messages on the branch were wrong and corrected later. Lesson recorded: "check `origin/lane/*` and open PRs before writing a file another session may already own". No mechanism enforces it.

**F2 · Docs written on the wrong branch / a handoff that is not on main.** The 11i prompt itself says "until PR #112 merges it lives on `origin/lane/roadmap`, so … read it with `git show origin/lane/roadmap:<path>`" (`…commissioning-lane-11i.md:18-20`). `O/PRACTICES.md:326-350` (#24): pharmacy's predecessor handoff on `lane/pharmacy-handoff` never got a PR; radiology's only on a branch whose PR was CLOSED; "a handoff is not written until it is ON MAIN, or on a branch with an open PR that will land". Measured: the pharmacy worktree is checked out on `docs/roadmap-brief-pr` (`git worktree list`), i.e. a docs branch living in a code lane.

**F3 · Status lines that say NOT DEPLOYED for deployed things.** `docs/runbooks/lab-go-live.md:3` "CODE-COMPLETE and NOT DEPLOYED" while the lab has been deployed since `0046` (`2026-09-06-ROADMAP-v2.md:30`; `…phase1-11i…md:58`). `MEMORY.md:31` (18b NOT DEPLOYED) vs `:99` (18a/18b/18c all DEPLOYED). `O/ORCHESTRATOR-HANDOFF.md:121-123`: "the previous session got this wrong by inheriting NOT DEPLOYED from phase-doc tails". `2026-09-05-HANDOFF-radiology-lane.md:53-56`: the lane "wrote '18a, 18b and 18c are all undeployed' into a document for the owner … wrong on two of three". `…radiology-lane-18c-T6.md:171` says production is at 46 migrations; it was 56. Tonight every "`c11833d`" line joined this class (§0).

**F4 · "`pnpm build` does not exist" in three recipes.** `M/pnpm-build-does-not-exist.md:12-39`: root `package.json` has no `build` (measured: `typecheck`, `test`, `verify`, `lint` only); three memory recipes say to run it; a whole department was walked against a day-old `dist`; the harness's task notification said exit 0 while the pipeline printed 254. This is `AGENT-RULES.md:153-160` (rules 16–17) recurring in a new tool.

**F5 · The integration checkout is 91 behind.** Measured. `CLAUDE.md:9` calls `/opt/hmis` "the integration checkout [that] stays on `main`"; the 11i handoff already says "never from `/opt/hmis` — it is 79 commits behind" (`:63-66`). The orchestrator's own scripts fetch there (`land-pr.sh:20`, `train-driver5.sh:48`) but never fast-forward it, so `git -C /opt/hmis log` lies to anyone who trusts it.

**F6 · The deployed base is recorded, not measured, and it moved.** `O/state/deployed-base.txt` = `c11833d`; `wf/CONTEXT.md:20`; every handoff §1. Reality: image built 12:35 UTC from `399f92c` (§0). `O/BLOCKERS.md:1194-1217` (§3b) shows even the orchestrator "did not run" the applied-count query because production is off limits; `:402-425` shows the pending count wrong three times in one night.

**F7 · Heartbeats rot silently.** Measured: `front-desk.status` 2026-09-05T06:52 (36 h old) while `test.holder` shows front-desk running jest at 18:50 today; `pharmacy.status` 06:01 says "#109 opened" (merged 06:17); `radiology.status` 06:07 says "#110 open" (superseded, landed as #132 at 16:32); `lims.status` 13:14. `board.sh` prints the row's text with no age.

**F8 · The orchestrator asserted instead of measuring — six times in one night, by its own count.** `O/ORCHESTRATOR-HANDOFF.md:24-43` (three-dot diffs, contention from stale artefacts, an invented four-file collision, a stale flake story, a fabricated production emergency, clearing a lane on contention alone). Its board monitor recommended three merges that would have skipped a migration or folded a stacked PR (`:206-222`); session identity by socket address was wrong twice (`:225-253`); a second session claimed an owned module (`:255-260`). The lanes' own rule: "check what it tells you when it has not shown you the measurement" (`…HANDOFF-radiology-lane.md:36-40`).

**F9 · The phase doc's CLOSE is not filled, and supersession is prose.** §2 R3 (11i §8 empty after four merges). `O/BRANCH-CENSUS.md:46-55`: v1 pharmacy handoff "confidently wrong … in the directory a new session is told to read FIRST". `M/written-diagnoses-go-stale.md:14-27`: PR #51's title stayed true-then-false; "`af03335` is not deployed" became a fabricated emergency. `EXECUTION-LESSONS.md:183,247,459` recorded the same class in August ("a stated prevention is not a prevention until it is IN THE ARTIFACT"; "a commit that removes a behaviour retires every claim about it").

**F10 · Append-only owner files.** `BLOCKERS.md` 184 KB with its own "read this and stop" map at line 306 because the top 300 lines are an incident; `PRACTICES.md` 322 KB / 204 headings; `EXECUTION-LESSONS.md` 476 KB; the plan-series index 175 KB with one live status line per plan. The reading budget (`CLAUDE.md:59-64`) exists because these grew; `PRACTICES.md:4836` (#190) says it itself: "THE PRACTICES EXPLAIN THE FAILURES; THEY DO NOT PREVENT THEM".

**F11 · A test deployed production, and every status document became wrong at once.** `M/deploy-sh-executed-by-a-test.md:13-25`; `O/BLOCKERS.md:8-30`. The classifier saw `jest`, not `deploy.sh`. The legibility cost is the point here: no artefact in the repo changed when production changed, so nothing a new session reads knows.

**F12 · Method prose contradicts the live flow.** `AGENT-RULES.md:359-377` (§5 finish block) still ends with `git pull --rebase origin main` / `git push origin main` — the pre-lane flow that `CLAUDE.md:17-18` replaced with lane branch + PR + squash. `EXECUTE-METHOD-V3.md:42-43` seeds a session with "the phase document, `AGENT-RULES.md`, and the ledger's §5"; `CLAUDE.md:61` says do not read the ledger. Nobody swept the older file (`EXECUTION-LESSONS.md:183`'s own rule).

## 5. Gaps — what is missing for "every new session gets the milestones easily even when the owner is asleep"

- **G-a · No milestone instrument.** G1–G7 per module is a prose table (`ROADMAP-v2.md:351-390`). `standup:check` answers G1–G4 for four modules and prints to a deploy transcript nobody keeps; G5–G7 are dated runbook sections, harvest rows and one event with no reader. There is no command that prints "lab: G1 yes (399f92c, drill 09-05), G2 yes, G3 RED×3, G4 RED×2, G5 not executed, G6 –, G7 –".
- **G-b · No deployed-base instrument in the repo.** The truth is `docker image ls` + `select count(*) from drizzle.__drizzle_migrations` on prod, which lanes may not run (`O/BLOCKERS.md:1194-1200`); what they get instead is a hand-written SHA in five places.
- **G-c · A deploy writes no record the repo can read.** Only tags and a log directory (`deploy.sh:63-65,202,687-696`). The drill writes an event (`restore-drill.sh:24-30`); the deploy does not.
- **G-d · The orchestrator's tooling is outside git, unbacked, and hard-codes four lanes** (`O/ORCHESTRATOR-HANDOFF.md:45`; `board.sh:13`). A new orchestrator inherits a 29 KB handoff, a 184 KB blockers file and a 322 KB practices file — the same shape the reading budget was written against.
- **G-e · No single writer for status.** Any session can write any doc path on any branch; three did (F1). Supersession is a banner; there is no index the orchestrator alone owns.
- **G-f · The handoff prompt restates state by hand.** Every THE PROMPT re-types the SHA, the pending count, the label state, the deployed base — and each was stale within hours (F3, F6).
- **G-g · CLOSE §8 and the runbook `## Executed` section are filled by whoever remembers.** 11i's is empty after four merged tasks; zero runbooks have an executed section.
- **G-h · "What is in flight" has no age.** Heartbeats are push-only; `board.sh` prints them without a timestamp delta; half the worktrees are not on the board.
- **G-i · Status prose is duplicated across ~20 documents plus memory**, violating v3's own fact rule (`EXECUTE-METHOD-V3.md:45-48`), and nothing re-derives it.
- **G-j · The position report is a claude.ai artifact**, readable only by a session that can fetch it; the repo carries a URL.

## 6. The shortest path I can see to ONE source of truth for milestones — measured, orchestrator-owned, single-writer

**One script, one file, one writer, one age.**

1. **`tools/milestones.sh` (in git, read-only, idempotent)** prints a table and writes `docs/STATUS.md`. Per row it re-derives, never records:
   - *repo*: `origin/main` SHA + time; migrations on main; open PRs by head branch with `deploy-blocker` flagged; worktrees with branch/drift/dirty (from `git worktree list`, not a name list); heartbeat **age** per lane from `O/state/*.status` mtime.
   - *deployed base*: from `docker image inspect hmis-prod/server:latest` (created time + the SHA tag T8 now writes), then `git ls-tree` of that SHA for module dirs and migration count; the applied count from the owner's query when present in `$DEPLOY_DIR/log/` (G-c: have `deploy.sh` write `log/deploy-<sha>.json` with sha, time, applied-count, `standup:check` output — one `note` line becomes a file).
   - *G1–G4 per module*: read the last `standup:check all` output the deploy captured (above) — the same rows, the same three verdicts, no second census.
   - *G5*: `grep -l '^## Executed' docs/runbooks/*-go-live.md`; *G6*: harvest rows non-empty; *G7*: the `ops.config_validated` event (already defined).
   - *drill*: last verdict + date from the drill log (or the `backup.drill_*` event).
2. **Single writer.** The orchestrator runs it on a loop (it already holds `train.lock`; the same `flock` pattern in `train-driver5.sh:27-35`) and commits `docs/STATUS.md` alone, docs-only PR or direct to a `status` branch it owns. A CI test pins that the file's header hash equals a hash of its body, so a hand edit fails CI — the file cannot be written by two sessions because it cannot be written by a session at all, only generated.
3. **Age is part of the value.** The header carries `measured-at <sha> <utc>`; `CLAUDE.md` gains one line: *"read `docs/STATUS.md`; if `measured-at` is older than 2 h, run `tools/milestones.sh` instead."* That is PRACTICES #13/#15 (`O/PRACTICES.md:128-161,185-203`) made mechanical: re-read at the point of use, prefer the mechanism that re-derives.
4. **Handoffs stop restating state.** THE PROMPT becomes three lines — lane, handoff path, "state is in `docs/STATUS.md`" — and the handoff keeps only what the census cannot derive: traps, rulings, the next task. `docs/handoffs/<lane>/` becomes the one directory, and STATUS.md names the current file per lane, so "grep gets two hits" (F2/F9) ends.
5. **Milestones become artefacts the census can see, never sentences.** A phase closes by a dated `## Executed` section (G5), a merged PR with a label, a deploy record — things the script reads — so a session that wants to "mark it done" has to produce the artefact. That is ROADMAP §3 rule 3 (`:376-377`) and §8 applied to the process itself.
6. **Bring `O/bin` into `tools/`** and derive the board's lane list from `git worktree list`. The practices/blockers files stay out of the reading path; the census points at them by section when a row is RED.

What this does not need: a new database, a new service, or an owner ruling. It is a shell script, a generated markdown file, a CI pin, and one `deploy.sh` line. The owner asleep reads one file whose first line says when it was true.

## Facts

- `origin/main` = `8de8fc0` at 18:41 UTC; `/opt/hmis` = `c11833d`, 91 behind (measured).
- Production images built 2026-09-06 12:35 UTC from `399f92c` (a lane branch, not main); containers up 6 h (measured, daemon metadata; no container touched). `O/state/deployed-base.txt` and CONTEXT.md still say `c11833d`.
- 23 open PRs incl. #117–#122 (11i) and #73 (held); 20 merged today; `deploy-blocker` label exists (measured).
- 9 worktrees under `/opt/hmis-lanes` + `/opt/hmis` + an agent worktree; `board.sh:13` sees four.
- Heartbeat ages: lims 5.5 h, pharmacy 13 h, radiology 13 h, front-desk 36 h; test-lock held by front-desk since 18:50; train-lock held since 17:33 (`list=124 141 140 133 123`).
- `standup:check` covers `hospital`, `lab`, `pharmacy`, `radiology` (`standup-check.ts:128,210,322,361`); `deploy.sh:542-545` runs it non-fatally.
- 11i phase doc `## 8. CLOSE` is empty on `origin/main`; #113–#116 touched no `docs/` file.
- Handoff docs: 10 + 9 + 4 across three directories; one out-of-git copy at `/opt/hmis-context/handoffs/`.
- Sizes: BLOCKERS 184,912 B; PRACTICES 322,818 B (204 headings); EXECUTION-LESSONS 476,650 B; plan-series index 175,685 B; MEMORY.md 19,871 B over 102 files; ORCHESTRATOR-HANDOFF 29,647 B.
- Root `package.json` scripts: `typecheck`, `test`, `verify`, `lint` — no `build`.
- `AGENT-RULES.md:359-377` still pushes to `main` directly; `CLAUDE.md:17-18` says lane + PR.
- Relay notes (`reports/`) stopped 2026-09-01; the protocol's §10 still names them the surviving channel.

## Surprises

1. Production is not on `c11833d` and has not been since 12:35 UTC; the workflow's own CONTEXT.md, the orchestrator's `deployed-base.txt` and every handoff §1 are wrong on the single fact the S-gate hinges on.
2. The freshest instrument on the board (`test.holder`, 18:50) contradicts the lane's heartbeat (36 h old) — the push-based status is worse than no status because it reads as current.
3. `board.sh` cannot see the commissioning lane — the one that deployed production.
4. The `deploy-blocker` label exists though the handoff written this morning says it does not; the fix landed and no sentence moved.
5. The orchestrator needed a lock for its own merge driver only after two drivers raced (#85), while it had already imposed a jest mutex on everyone else (`train-driver5.sh:16-18`).
6. `AGENT-RULES` §5 was never updated for lanes; the "binding contract for every pipeline agent" tells an agent to push to main.
7. The v3 method's only phase-specific artefact (the phase doc) is exactly the one the four executing 11i sessions did not write to.
8. Even the read-only checkout made for this brainstorm was a commit behind within the hour.
