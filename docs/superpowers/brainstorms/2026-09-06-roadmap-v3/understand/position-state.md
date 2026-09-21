# position-state — achieved / in flight / blocked, measured 2026-09-06 ~19:00 UTC

Paths are relative to the read-only checkout `main-ro` (`b04cbd9`). Every measurement below was taken
in this session with read-only git, `gh`, `ls`, and `docker ps`/`docker images` (daemon metadata; no
`hmis-prod-*` container was touched). Memory files under `/root/.claude/projects/-opt-hmis/memory/`
are cited as `memory:<name>` and were written by other sessions the same day; where they claim a
production fact I re-measured it from the docker daemon and git rather than repeating it.

## 0. The one measurement that re-bases every other row: production is NOT at `c11833d`

- `docker ps`: `hmis-prod-api-1`, `hmis-prod-worker-1`, `hmis-prod-caddy-1` were created
  **2026-09-06 12:35:41 UTC**, image `hmis-prod/server:latest` = `ede6226225f5`, which also carries the
  tag **`hmis-prod/server:399f92c`** (`docker images`, built 12:35:00 UTC). Same for `hmis-prod/web:399f92c`.
- `399f92c` = `Merge remote-tracking branch 'origin/lane/commissioning-t7' into lane/commissioning-t3`
  (`git log -1 399f92c`, 11:28 UTC). It is **not an ancestor of `main`** (`git merge-base --is-ancestor`
  → no); it lives only on `origin/lane/commissioning-t3/-t5/-t6`. Its merge-base with `main` is
  `f211075` (#108, the last main commit before the 11i lane forked).
- `399f92c` carries **78 `.sql` migrations** (`0000`–`0077`; `git ls-tree 399f92c apps/core/drizzle`),
  and **all 14 module folders including `pharmacy` and `aerb`**.
- So production = `main@f211075` + eleven lane commits (`git log HEAD..399f92c`): T0 `ee7f38b`,
  T1 `384f2ad`, T4 `bd63bb0`, T2 `5d162d8`, T8 `6f397c9`, T9 `0e08ebe`+`1c5768f`, T7 `63f8e8a`,
  T3 `f7eb346`, plus two merges. The SHA-tagged images are T8's own feature, running on production
  before its PR (#117) is merged.
- How it happened: `memory:deploy-sh-executed-by-a-test` — a jest mutation run in the commissioning lane
  executed `deploy.sh` with the guard deleted; `DEPLOY_DIR` defaulted to `/opt/hmis-prod`; "22 migrations
  applied, nine containers restarted", ~88 s. `memory:prod-deploy-state` (§2026-09-06): "56 → 78
  migrations", "`/api/health` ok", "**No image rollback exists for it** — the previous image is gone
  from the daemon" (step 2b of the catch-up runbook, hand-tagging the running images, was never done).
- Consequence for `main` vs production: `git log 399f92c..HEAD` = **11 commits** production lacks
  (#111/#112 docs; #113–#116 = squash twins of lane commits already running; **#132 `0078`, #124
  `0079`, #135, #138, #141** are the real gap) → **2 pending migrations** (`0078_radiology_chasers`,
  `0079_lab_rerun_choice`), not 22. Remote `main` is one further commit ahead of `main-ro`: `8de8fc0`
  (#140, merged 18:41 UTC; `git ls-remote origin refs/heads/main`).
- Every document dated 2026-09-06 that says "deployed base `c11833d`, 56 applied, 22 pending" describes
  the state before 12:35 UTC: `wf/CONTEXT.md:20`, `ROADMAP-v2.md:96–99` (§0c), phase doc
  `2026-09-06-phase1-11i-the-stand-up-path.md:43,62`, `2026-09-06-HANDOFF-commissioning-lane-11i.md:36–37`,
  `2026-09-06-HANDOFF-fable-position-and-roadmap.md:48–53`, the catch-up runbook on
  `origin/lane/commissioning-t7:docs/runbooks/catch-up-deploy-2026-09.md:3–20` ("Status: NOT YET RUN"),
  and `/opt/hmis-lanes/.orchestrator/state/deployed-base.txt` (`c11833d…`, dated Sep 4).

## 1. LIVE since before 2 September (in `c11833d`, therefore in `399f92c`)

Source: `docs/PROJECT-BRIEF-2026-08-30.md:27–63` (§0.2), vocabulary at `:276`, summary at `:1382`.
Plans **01, 02, 03, 04, 05, 06/06.1/06.2, 07, 07a–07d (deployed 2026-08-29), 08, 08.5, 09/09a, 10,
11a/11c–11g, 13, 17 (order envelope, prod 43→46), 22c-A** — all `**LIVE**` at `:31–57`. **11h** ("in prod
via later deploys", `:44`), **14** and **15** (schema `0034`–`0037` in prod, behaviour unverified, `:46–47,60`),
**16a** (`0026`/`0027` below prod head, `:490`). Production has "never left `commissioning`" and has "exactly
one full administrator" (`:60`). `c11833d` itself is FD-1 T5 (#29, 2026-09-02 12:59 UTC), so **FD-1** and
**VD-2** (#15, `451458b`, ancestor of `c11833d` — measured) were in the 2 September deploy; 17/17a/17b
(`0046`) too — phase doc `:60` row 12: "the lab is deployed since `0046`".

## 2. DEPLOYED by the 12:35 UTC deploy (merged to `main` between `c11833d` and `f211075`)

Each row: PR(s), migration, evidence that it is in `399f92c` (ancestor check on the merge commit or the
`.sql` present at `399f92c`).

| plan | PRs (merged) | migration | state now |
|---|---|---|---|
| 16c OPD dispense counter | #4 doc, #18, #30, #31, #38, #39, #40, #41 (2026-09-02); closes #53, #62, #65, #66, #72 (09-03/04) | `0056_pharmacy_dispense` | **DEPLOYED, INERT** — `standup:check pharmacy`: store/definition/role ok, `pharmacy_item_present` RED, `pharmacy_batch_in_stock` RED (`memory:pharmacy-launch-2026-09-06:18–25`). `docs/runbooks/pharmacy-go-live.md:3` still says "NOT DEPLOYED" — false; fix is #128 (open) |
| 17c five LIMS seats | #2, #7, #11, #13, #24–#27, #37 (09-02) | — | deployed (all ≤ `f211075`) |
| 17d the Indian day | #54, #55, #58, #63, #64, #67, #68, #69, #71, #76 (09-03/04) | `0059` | deployed; 17d §9 close pass in phase doc `:509` |
| 17-E analyser interface T1–T6 | #88, #89, #95, #97, #103, #106 (09-05/06) | `0070`, `0071`, `0072`, `0074` | deployed; **T7a #124 (`0079`) merged 18:02 UTC, NOT deployed; T7b (`interface_down`) not started** (`memory:plan-17e-analyser-interface:10–12`) |
| 18a radiology core | closed 2026-09-01; in `c11833d` (`0047`–`0052`) | — | deployed since 09-02 (radiology handoff `:13`: "18a and 18b are deployed") |
| 18b DICOM seams | #3, #16, #17, #19, #20, #34, #35 (09-02) | `0053`, `0054` | deployed since 09-02 (≤ `0055`); `docs/runbooks/radiology-pacs-go-live.md:3` "NOT DEPLOYED" is false |
| 18c AERB registers | #52, #56, #57, #59, #60, #61, #79 (T6), #86, #93 (09-03/05) | `0060`–`0065` | **DEPLOYED 12:35 UTC; the ionising gate is live against an empty `aerb_licences`** (`memory:prod-deploy-state:279–280`; runbook `radiation-safety-go-live.md:12–17` describes exactly this) |
| 18a-iii clinical flow T1–T4 | #102, #105, #107, #108 (09-05/06) | `0073`, `0075`, `0076`, `0077` | deployed; **T5 #132 (`0078`) merged 16:32 UTC, NOT deployed**; zero web callers for T1/T2/T4 routes (PR #142 §8) |
| FD-2 | #36 | — | deployed (`2d24dd5` ancestor of `399f92c`) |
| FD-7 T1–T9 → FD-23 | #44–#50 | `0058`, `0064`–`0066` | deployed (`b738ddb` ancestor) |
| FD-24 printing | #70, #78 | `0069_print_jobs` | deployed (`1a752e0` ancestor) |
| FD-25 six screens + backlog | #92 (squash `54fb4de`, 09-05 19:35) | `0067` | deployed (ancestor); handoff `2026-09-05-HANDOFF-front-desk-FD25-next.md:19–45` |
| 11i T0/T1/T2/T4 | #113, #114, #115, #116 (main) | — | on `main` AND running on production as their lane twins |
| 11i T3/T7/T8/T9 | **open** #120/#119/#117/#118 | — | **running on production as lane commits** (`f7eb346`, `63f8e8a`, `6f397c9`, `0e08ebe`) — production carries code `main` does not |

## 3. MERGED to `main`, NOT deployed (the real pending set)

#132 18a-iii T5 chasers (`0078`), #124 17-E T7a rerun rule (`0079`), #135 (`/aerb/licences/gaps` 400),
#138 (refusal names the machine), #141 (RSO field), #140 radiology go-live runbook + census row (remote
tip `8de8fc0`, absent from `main-ro`), #111/#112 (docs). Nine commits, two migrations.

## 4. IN FLIGHT — 22 open PRs (`gh pr list --state open`), lanes and their branches

**commissioning** (`/opt/hmis-lanes/commissioning/hmis`, `lane/commissioning-t3` @ `489791f`, +19/−7,
clean): stacked chain #117 T8 (**CONFLICTING**, base main) → #118 T9 → #119 T7 → #120 T3 → #121 T5 →
#122 T6a. Post-incident commits not in any PR yet: `b91d841` "refuse HMIS_DEPLOY_ALLOW_DIRTY on the prod
target", `489791f` "correct two things this incident got wrong in writing".
**lims** (`lane/lims-reflex-refused` @ `6055e20`, +25/−2): eight stacked PRs #125 → #126 → #127 → #129 →
#130 → #131 → #134 → #137, all MERGEABLE, "the train was frozen pending the owner's ruling on the day's
production incident" (`memory:plan-17e-analyser-interface:12`). Orchestrator `lims.status` (13:14 UTC)
still names `lane/lims-17e-t7` — stale.
**pharmacy-launch** (`lane/pharmacy-launch` @ `20ede79`): #123 → #128 → #136 (demo seed; body: "The
pharmacy module is deployed and inert"). #123's `pull_request` twin run is red on a flake; rerun is
owner-only (`memory:pharmacy-launch-2026-09-06:90–96`).
**radiology** (`lane/radiology-18a-iv-plan` @ `7482609`): #133 seed-actor fix (base main), #139 walk
report, #142 correction (stacked on #139), **#143 Phase 18a-iv FOR APPROVAL** (phase doc only).
**front-desk** (`lane/front-desk-fd25`, LOCAL branch, no remote, +69/−20, **19 dirty files**, jest running
since 18:50 UTC per `.orchestrator/state/test.holder`): 17 commits beyond #92 with **no PR** — FD-26
(`44f49c5`, `0599d36`: `/registration`, `/appointment`, `/billing` ARE Desk One), FD-27 (`0f927d1`…`c8ae7d6`:
duplicate-invoice guard, papers/reprint, relay runbook), FD-28 (`336c741`…`fc855d0`: billing rail, history,
Save-as-PDF), plus `2cbc89e`/`b19a1f6`/`74e7dcd` (prescription sheet, doctor id). Untracked
**`apps/core/drizzle/0075_users_staff_code.sql`** — serial `0075` is already `0075_radiology_contrast_reactions`
on `main`; it must be renumbered at rebase (CLAUDE.md drizzle rule).
**roadmap** (`lane/roadmap` @ `9faf4db`, 7 commits): ROADMAP v2 + 11i + commissioning handoff — landed
via #112 squash; the branch itself is now history. **roadmap-v3** (`b04cbd9`, this brainstorm).
**pharmacy** worktree parked on `docs/roadmap-brief-pr` (#109 merged).
**#73** hotfix "DO NOT MERGE", CONFLICTING, built on `c11833d` — its base no longer runs anywhere and its
content is on `main` via #65; the handoff says it "closes as superseded on deploy" (`…commissioning-lane-11i.md:43`).
Not yet closed.

## 5. Phase 11i task ledger (phase doc `plans/2026-09-06-phase1-11i-the-stand-up-path.md`, tasks at `:208–373`)

| task | PR | merged | deployed | note |
|---|---|---|---|---|
| T0 pool values (11j steps 1–2) | #113 | yes 10:45 | yes (lane twin `ee7f38b`) | handoff `:86` |
| T1 `seed:lab` | #114 | yes | yes | the lab can now take an order on production |
| T2 `standup:check` | #116 | yes 12:18 | yes | census exists on production |
| T3 UAT target | #120 | **open** | yes (`f7eb346`) | `/opt/hmis-uat/.env` + `.uat-password` exist (12:31 UTC); **no `hmis-uat-*` container is running**; `hmis-preview-caddy` Exited 6 h ago (`:8443` freed); `hmis-aerb-demo-caddy` still up on `:8444` |
| T4 watermark guard | #115 | yes | yes | |
| T5 synthetic door + `seed:aerb-demo` | #121 | **open** | **no** | |
| T6a lab runbook corrected | #122 | **open** | no | `origin/lane/commissioning-t6:docs/runbooks/lab-go-live.md:425` "## 14. Executed on UAT — **NOT YET RUN**" |
| T6b execution on UAT (the S-gate) | — | — | — | **NOT RUN.** This is the only thing that closes 11i (ROADMAP `:480–486` §8) |
| T7 catch-up runbook + `deploy-blocker` label | #119 | **open** | doc in prod tree | label **exists** (`gh label list`: `deploy-blocker #B60205`); runbook "Status: NOT YET RUN" while the deploy it describes has happened, unrun, without its step 2b |
| T8 SHA tags + rollback + drill rehearsal | #117 | **open, CONFLICTING** | yes (`6f397c9`) | images are SHA-tagged (`:399f92c`) — T8 works in production before merge; no `c11833d` image to roll back to |
| T9 three redirects | #118 | **open** | yes (`0e08ebe`) | production serves the forwards |
| §8 CLOSE | — | — | — | empty: phase doc `:449` is the last line |

## 6. BLOCKED — on whom, for what act

| item | blocked on | act |
|---|---|---|
| Backout for the running deploy | **fact / owner acknowledgement** | there is no `c11833d` image (`memory:prod-deploy-state:276–278`); engineering cannot manufacture one (`deploy.sh` builds only `origin/main`). Owner accepts "no way back from this one", or names a fresh rehearsed tip |
| Confirm what the accidental deploy established on production | **owner query (fact)** | `study_types`/`device` rows, `LAB` definitions active, `aerb_licences` empty, `gst_config` rows — CLAUDE.md forbids a session reading `hmis-prod-*`; the radiology memory `:393–403` wrote the queries |
| 11i S-gate (T6b) | **engineering** (commissioning lane) | stand UAT up with T3 (`HMIS_TARGET=uat`), run `lab-go-live.md` §14 in a browser, date it |
| 11i merge train #117–#122 | **engineering / orchestrator** | rebase #117 (CONFLICTING), chase the stack; #113–#116 squash-merges are its conflict source |
| Pharmacy launch | **owner + CA (money/law)** | GST on tax-inclusive MRP: `priceForBatch` → `tariff/pricing.ts:103` adds CGST/SGST on top of the printed MRP; `pharmacy_exempt` is right by accident (`memory:pharmacy-launch-2026-09-06:32–53`). Blocks running #136's seed on production and runbook §2.2 |
| Pharmacy staffing | **owner (staffing fact)** | chief pharmacist + three pharmacists named (ROADMAP `:452–455`, week 4) |
| Lab opening on production | **owner (data + staffing)** | catalogue spreadsheet (week 3), pathologist of record + four role holders (week 3) — ROADMAP `:441–449,455`; phase doc `:441–447` |
| O1 second administrator | **owner (staffing)** | gates the IPD gate and Class-A two-key, **not the lab** (ROADMAP §0c.6 `:183–191`) |
| O6 CA session + real tariff | **owner (money/law)** | the only gate on leaving `commissioning` (ROADMAP `:443–446`); `getOperatingMode` has no caller outside `kernel/ops` (phase doc `:63` row 15) |
| Radiology opening | **owner (data + staffing + law)** | real AERB certificates by week 7; RSO + physicist named; whether to REFUSE an unappointed RSO (#141 left it: law) |
| 18a-iv ordering door | **approval** — #143 says "no owner ruling" needed; #142 says "the OWNER's scope call" | the orchestrator/owner approves #143's phase doc or does not; until then no screen places an imaging order |
| 18b-ii PACS | **procurement (11b) + DPIA** | R1 storage, R4 signed DPIA (`memory:plan-18c-radiation-safety:12–13`) |
| 11j step 3 (nesting) | **approval (engineering)** | `plans/2026-09-05-nesting-remediation-FOR-APPROVAL.md:3` "NOT APPROVED, NOT STARTED, NO PLAN NUMBER"; ROADMAP `:469–470` names it 11j |
| 17-E T7b `interface_down` | **engineering (LIMS lane)** | not started (`memory:plan-17e-analyser-interface:10`) |
| 16d / 16e / 16f | IPD cluster (41 unauthored) / dataset licence ₹8–12 L a year (**procurement**) / 30 days of live data | `.orchestrator/state/pharmacy.log` 09-04: "Idle by dependency" |
| Second server | **owner (money)** | UAT off-box + Hermes (ROADMAP `:440–441`) |
| Agent runtime 12a / Hermes Ops Copilot | **law (DPIA v0.2, counsel)** + second server | brainstorm `/opt/hmis/docs/superpowers/brainstorms/2026-09-01-hermes-ops-copilot/00-BRAINSTORM.md:2` "nothing authored, nothing executed", still **untracked** in `/opt/hmis` |
| CI re-runs on flaked twins | **owner (Actions: write)** | agents cannot `gh run rerun`; ~31 % of PRs blocked by a flake they did not cause |
| Front-desk FD-26/27/28 | **engineering (front-desk lane)** | commit the 19 dirty files, renumber `0075_users_staff_code.sql`, push, open PRs |
| #73 | **orchestrator** | close as superseded |

## 7. Runbook status lines vs measurement (`docs/runbooks/*.md` on `main`)

- `lab-go-live.md:3` "CODE-COMPLETE and NOT DEPLOYED" — false since 2 September (`0046`); corrected on the T6 branch (#122 open). §14 NOT YET RUN.
- `pharmacy-go-live.md:3` "CODE-COMPLETE and NOT DEPLOYED" — false since 12:35 UTC today; rewritten in #128 (open).
- `radiation-safety-go-live.md:12–17` — no status line; its §0 warning ("the CT, the DR units … all stop the moment the migration lands") is now the live state.
- `radiology-pacs-go-live.md:3` "CODE-COMPLETE and NOT DEPLOYED" — false since 2 September (`0053`/`0054`).
- `radiology-go-live.md` — merged as #140 to remote `main` `8de8fc0`; not in `main-ro`.
- **None of the five has an executed, dated section.** The four the ROADMAP counted (`:31` row 2) plus the fifth.

## 8. Brief §0.2 rows (`docs/PROJECT-BRIEF-2026-08-30.md:31–56`) that changed since 08-30

17a/17b "code-complete, NOT deployed; go-live blocked on a second admin" → deployed 09-02, second admin no
longer the lab's gate (§0c.6). 18a "paused at T1 of 9" → 18a/18b/18c/18a-iii T1–T4 all deployed. 14/15 →
still schema-only in prod, behaviour unverified. 16b, kernel-D, 22a, 22c-B…F → unchanged (authored). New rows
absent from the brief: 16c, 17c, 17d, 17-E, 18c, 18a-iii, FD-2…FD-28, 11i, 11j, VD-2, RC-1..4 (RC docs are in
`c11833d`: `git ls-tree c11833d docs/superpowers/plans | grep -c rc[234]` = 7).

## Facts

- `main-ro` tip `b04cbd9` (#141, 18:24 UTC); remote `main` `8de8fc0` (#140, 18:41 UTC). 80 `.sql` on `main` (`0000`–`0079`), journal 80 entries.
- Production: images `hmis-prod/{server,web}:399f92c`, containers up since 12:35:41 UTC, healthy. `399f92c` carries 78 `.sql`. **Prod is 2 migrations behind `main` and carries 11 lane commits `main` lacks.** Old base `c11833d` (2026-09-02 12:59 UTC) is 90 commits behind `main` — the figure CONTEXT.md quotes, now describing the wrong base.
- `git log c11833d..399f92c` = 90 commits; `git log 399f92c..HEAD` = 11; `git log HEAD..399f92c` = 11.
- 22 open PRs; merged PRs #1–#141 minus the 16 closed-unmerged (#5, #8–#10, #12, #14, #21–#23, #28, #33, #51, #74, #110 — #110's content re-landed as #132).
- 11i: T0/T1/T2/T4 merged (#113–#116); T3/T5/T6a/T7/T8/T9 open (#117–#122); T6b NOT RUN; §8 CLOSE empty; `deploy-blocker` label exists; `/opt/hmis-uat/.env` exists, no UAT containers.
- 8 lane worktrees (`ls /opt/hmis-lanes`): commissioning, front-desk, lims, pharmacy, pharmacy-launch, radiology, roadmap, roadmap-v3; 7 claude sessions on a terminal; 8 GB used / 6 GB available of 15.
- Box: `hmis-aerb-demo-caddy` up (`:8444`), `hmis-preview-caddy` exited, `hmis-db-1` (lanes' Postgres) up 3 weeks.

## Surprises

1. **Production is ahead of `main`, not behind it** — deployed by a mutation test at 12:35 UTC from a lane merge commit; CONTEXT.md, ROADMAP v2 §0c, the 11i phase doc §2, both 09-06 handoffs, the catch-up runbook and `deployed-base.txt` all still say `c11833d`/56/22-pending. The 13-week table's week-1 row ("the owner deploys production from the runbook at the end of the week", `ROADMAP-v2.md:333`) has been overtaken by an event no runbook governed.
2. **No backout exists for the running deploy** — the exact defect T8 was written to close (phase doc `:62` row 17) recurred on the deploy that shipped T8, because step 2b of the not-yet-run T7 runbook was never performed.
3. **Two never-deployed modules are live** — pharmacy serves 13 routes with an empty shelf; 18c's ionising gate refuses every X-ray/CT on an empty licence table. Both runbooks on `main` say "NOT DEPLOYED".
4. **11i T3/T7/T8/T9 are in production while their PRs are open**, so "merged" and "deployed" have decoupled in the wrong direction for four tasks.
5. **`hmis-prod/server:399f92c` proves T8 works** and the `deploy-blocker` label exists (§0c `:105–107` said absent) — two 11i artefacts real in production before 11i can close.
6. **The front-desk lane holds three whole phases (FD-26/27/28) with no PR and no remote branch**, 19 dirty files and a migration serial (`0075`) already taken on `main`.
7. `memory:plan-11i-execution:410` says T6 needs "a UAT stack that does not exist yet" — `/opt/hmis-uat/.env` was created at 12:31 UTC, four minutes before the accidental deploy, by the same session's UAT attempt; the stack is still not up.
8. #110 (18a-iii T5) is CLOSED-UNMERGED and re-landed as #132 to keep `0078`'s `when` above production's new watermark (`memory:radiology-commissioning-walk:306–307`) — the serial is decoration, the timestamp is what drizzle compares.
9. `pnpm build` does not exist (exit 254) and three lanes' stand-up notes say to run it; the radiology walk was driven against a day-old `dist` (PR #142 §7).
