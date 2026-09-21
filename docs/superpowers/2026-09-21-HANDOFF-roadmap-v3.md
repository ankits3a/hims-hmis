# HANDOFF — the ROADMAP v3 brainstorm (session hmis-27, 2026-09-06 → 2026-09-21), stopped by the owner mid-synthesis

**State in one paragraph.** The owner asked (2026-09-06) for the roadmap to be re-cut against his five-pillar
mission brief — goals, epics, edge cases, *parameters that confirm the goal* — and for milestones any new
session can read while he sleeps, with the orchestrator managing lanes. A 61-agent workflow did the reading
and drafting; it was cut five times by the account's usage window and once by a logout, then the session
sat idle for thirteen days while `main` moved 156 commits. Everything it produced is committed under
`docs/superpowers/brainstorms/2026-09-06-roadmap-v3/` on `lane/roadmap-v3`. **What is NOT done: the two
synthesis documents, the PR, the orchestrator hand-over and the owner-facing page.** Nothing here
supersedes `docs/superpowers/2026-09-06-ROADMAP-v2.md` until a PR merges.

## THE PROMPT — paste this into the successor session

```
Read /opt/hmis/CLAUDE.md, then docs/superpowers/2026-09-21-HANDOFF-roadmap-v3.md (this file), then
docs/superpowers/brainstorms/2026-09-06-roadmap-v3/CONTEXT.md — its NIGHT UPDATE 4–7 sections are the
binding design decisions and the last measured position (2026-09-21 21:20 UTC). Re-measure the position
before writing anything (git fetch; gh pr list; docker image ls hmis-prod/server; grep 'Executed' in
docs/runbooks/*.md). Then write the two documents in §3 below from the materials in §2, open ONE docs-only
PR on lane/roadmap-v3, message the orchestrator (hmis-lanes-a2) the PR number + the STATUS adoption plan,
and publish the owner page. Lane: cd /opt/hmis-lanes/roadmap-v3/hmis (recreate with tools/lane.sh new
roadmap-v3 if the worktree is gone — the branch survives a drop). Brainstorm only: no code, no tests.
```

## 1. What moved while the session was idle (measured 2026-09-21, cite fresh measurements, not this list)
- `origin/main` `035af769`, 119 migrations. The 11i stack landed; the catch-up deploy was EXECUTED 2026-09-14
  (`catch-up-deploy-2026-09.md`, section titled "Executed — 2026-09-14"); production re-deployed 09-19 (twice)
  and 09-20, images SHA-tagged (`b3aaf712`, `3e6c0e9d`, `61906e51` = `:latest`) — a backout target exists.
- **The S-gate has still never happened:** `lab-go-live.md` "Executed on UAT — NOT YET RUN" and
  `pharmacy-go-live.md` the same. That row is v3's first Track S milestone, unchanged since v2.
- Plan 20 (roster) is in execution (phase R merged #273–#286; #287 close + #264 open; phase doc 20-U); the
  obligation spine phase O is authored (#266/#270/#281); loaders `import:item-master` (#144/#163) and
  `import:lab-catalogue` (#168) are merged; OPD/OT/pcpndt runbooks exist; formulary census row (#162);
  mini-OT seam fixes (#164). Seven lane worktrees were reaped on 09-21; names in the drafts may not exist.

## 2. The materials, and what each is worth
Under `docs/superpowers/brainstorms/2026-09-06-roadmap-v3/`:
- `MISSION-BRIEF.md` — the owner's five pillars, verbatim. The north star.
- `CONTEXT.md` — ground rules + NIGHT UPDATE 1–7. **Updates 5–7 are binding design rules** (below).
- `understand/*.md` (12 readers, 09-06) — file:line-cited maps of each pillar against the repo; `position-state`
  and `session-method` are the most load-bearing; every position fact in them is dated 09-06.
- `design/P1–P6.md` (09-06) → `verify/*.md` (24 verdicts, 4 lenses × 6) → `revise/P1,P2,P3,P4,P5.md`.
  **P2 and P3 revisions are from 09-21 (fresh); P1/P4/P5 from 09-08; P6 (Track S — the absorption track,
  the spine of the ledger) was never revised** — use `design/P6-absorption-track.md` plus its four verdicts.
- The verdicts' structural kills, already agreed and to be applied in the synthesis:
  (a) the mini-OT stand-up was claimed by four pillars — ONE home: Track S (P6 E6), runbook `ot-go-live.md`
  exists (#157); P5's "recall task" is dead (#164 proved there is no kernel task primitive — the comment was
  the defect); (b) `11l` was double-booked — 11l = the milestone instrument (P6 E7); P5's breach ledger /
  fact sheet folds into 12a-0 (the Hermes Class-0 fact sheet, P1 E3); 11m = the silent three's census +
  runbooks; (c) loaders, the OPD/front-desk runbook, the OT rows and the formulary row are MERGED — say so,
  never "3-day build"; (d) the radiology stand-up belongs to Track S only (P6 E5); P3 keeps cloud/PACS/AI and
  dynamic-OT epics; (e) P3's E7-M1 duplicates Plan 20 — drop; (f) the deploy-in-jest guard is proven by a
  unit test of the guard function + a lint that no test spawns `deploy.sh`, never by executing it; (g) the
  `## Executed` check must match numbered headings by TITLE text and exclude "NOT YET RUN"; (h) G5 by an
  agent on UAT is a rehearsal (G5-a); G5 proper needs the department head; (i) UAT never receives real
  legacy data (back-book loads on production only; dry-run with a synthetic sample); (j) wound photos and
  any Class-2 pixels: in-region/on-prem, DPIA addendum first — the nursing brainstorm REJECTED the wound
  assessor; (k) "eliminate PACS servers / cloud imaging" is the INVERSE of the owner's 2026-08-22 on-prem
  ruling and R-254 — put the two sentences side by side for him as a choice (money + law), never resolve it.

## 3. The two documents still owed (the deliverable)
**A. `docs/superpowers/2026-09-21-ROADMAP-v3.md`** — header "measured at <sha> on <utc>"; §0 how to read in
5 min (a session) / 2 min (the owner); §1 mission → goals with north-star parameter · instrument · baseline ·
target; §2 achieved (evidence) and the position; §3 THE MILESTONE LEDGER — one row per milestone across all
pillars + Track S: id · name · pillar · plan home · gate · acceptance (condensed) · depends on · status ·
next act · who — every status cites the ARTEFACT that proves it (a file on main, a merged SHA, a docker tag,
a dated Executed title), never a task number; §4 sequence (next 13 weeks, then Q1/Q2 2027) with the human
acts by week; §5 epics per pillar (condensed from revise/design, acceptance tables kept); §6 the edge book
(≥ 80 rows, 11i §2b shape, grouped by milestone, incl. session-layer rows); §7 DECIDED (consolidated);
§8 THE OWNER'S LIST (money / procurement / law / facts only, deduplicated, each with what it unblocks and
the default); §9 not built and why; §10 the mechanism in brief; §11 numbering (checked unique vs
`00-INDEX-AND-SYNTHESIS.md` §3: free letters 11l, 11m; 11j/11k taken); §12 what changed from v2.
**B. `docs/superpowers/2026-09-21-MILESTONES-and-SESSION-PROTOCOL.md`** — the measured STATUS mechanism:
- `standup:check` IS the census and the only GATE (G1–G4, "can the hospital open this department on
  Monday"), untouched: seven runbook call sites + the deploy's `dist/scripts/standup-check.js all`. No `--gate`
  flag anywhere (its `main()` reads `argv[2]` as a module name).
- The BOARD is one thin wrapper (`tools/status.sh` / `pnpm status`): imports the exported
  `runCensus(db, module)` / `censusLines` / `anyRed` (`standup-check.ts:919/946/964`), appends G5–G7 and
  the development facts (main tip, open PRs + labels, docker SHA tags, drill log, Executed titles, lane
  worktrees from `git worktree list` + heartbeat AGE) in the SAME row grammar, writes `docs/STATUS.md`,
  **exits 0** (a measurement is not a gate). Types widened wrapper-locally: `BoardGate = Gate|"G5"|"G6"|"G7"`,
  `BoardRow = Omit<RowResult,"gate"> & { gate: BoardGate; evidence: string }` — `standup-check.ts` types
  are never edited (`detail?` is the loaders' throw text; #287 touches that file).
- Header: `measured-at <main sha> <utc> db=<host/dbname identity, never a secret>` — a board read against a
  lane's test DB must not pass as production's. Runbook sections cited by TITLE text, never number (the
  census's own D15 rule). **G5–G7 and the board facts are facts about US; a deploy never consults them.**
- Single writer: the orchestrator's loop under its existing `flock`; a CI pin (header hash = body hash) so a
  hand edit fails; `CLAUDE.md` gains ≤ 12 lines ("read STATUS.md; if measured-at > 2 h, run the wrapper");
  handoffs stop restating SHAs; phase-doc CLOSE §8 lands as a board row. Start card ≤ 10 lines / ≤ 2
  commands. Owner's one-line `RULED: <id> <ruling>` grammar and where it lands. ≥ 12 session-layer edge
  rows (the 12:35 test deploy; the 43-minute-stale week-1 row; the branch-only defect reported as a live
  outage; a lane dropped two minutes before its claim arrived; heartbeats 36 h old printed without age).
  A one-day adoption plan for the orchestrator with no owner act on the path; the FIRST filled board.

## 4. Rules that bind every row (learned this fortnight, each paid for)
1. A row that names a task id cannot self-check — cite the artefact and the command (v2's week-1 row was
   fully landed 43 minutes after commit). 2. A seam is cited by the function signature that carries the
   property (`upsertOrderable(exec: Db | Tx, …)`), never the HTTP entry point. 3. Before naming new work,
   name what already occupies the name (`seed-lab-catalogue.ts` beside `import:lab-catalogue`). 4. Check a
   document exists before pointing at it ("T9's runbook" stranded a module). 5. Rulings only for money /
   procurement / law / facts the owner holds; everything else DECIDED with one line. 6. Clinical agents cap
   at T2–T3; nothing with inference before DPIA v0.2; every automation has a manual path.

## 5. The owner's list as last known (09-06; RE-MEASURE each before listing — some may be ruled by now)
Ratify/record the 12:35 deploy (done in effect by the 09-14 deploy — check the runbook); GST on
tax-inclusive MRP (CA) + O6 tariff/CA session; O1 second administrator; the lab catalogue file (loader
merged) + pathologist of record + four lab role holders; chief pharmacist + three; AERB certificates +
RSO/physicist; second server (UAT off-box, Hermes); DPIA v0.2 (counsel — gates every inference item in the
brief); PACS on-prem vs cloud (the mission's sentence vs his own ruling); `gh run rerun` rights.

## 6. Traps
The scratchpad of the original session (`/tmp/claude-0/-opt-hmis/f3306fc1-…/scratchpad/`) may be gone;
everything needed is in git. `/opt/hmis` may lag `origin/main`; read with `git show origin/main:<path>`.
The Workflow tool is cut by the account's usage window; if you fan out, keep completed prompts byte-identical
and put new facts in a shared file, never in `args`. Lane `roadmap` (no v3) is the earlier session's, not
this one's. Do not drop `roadmap-v3` until the PR is merged.
