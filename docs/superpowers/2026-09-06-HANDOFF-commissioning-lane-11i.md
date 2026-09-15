# HANDOFF — the commissioning lane: execute Phase 11i (the stand-up path)

**Written 2026-09-06 against `origin/main` @ `f211075` (78 migrations `0000`–`0077`; deployed base
`c11833d`, 56 applied; 22 pending; 79 commits). For a fresh session (Opus) on a new lane.**

**Authorisation.** The owner, in his own session on 2026-09-06, instructed that this lane plan be
executed. That authorises **11i T0–T9 as written** in
`docs/superpowers/plans/2026-09-06-phase1-11i-the-stand-up-path.md` (branch `lane/roadmap`, PR #112).
It does **not** authorise: a production deploy (T7 writes the runbook; the owner runs it), any
write to `hmis-prod-*` or the production database, a migration, a change to `CLAUDE.md` or settings,
or anything in ROADMAP-v2 beyond 11i. The roadmap itself remains a proposal.

---

## THE PROMPT — paste this into the new session

> You are executing Phase 11i, the stand-up path, on the HMIS hospital operating system. Read
> `docs/superpowers/2026-09-06-HANDOFF-commissioning-lane-11i.md` first and follow its order —
> until PR #112 merges it lives on `origin/lane/roadmap`, so after `git fetch origin` read it and the
> phase doc with `git show origin/lane/roadmap:<path>`. Then
> read `CLAUDE.md` and the phase document's §2, §2b, §3 and §4 — skip its §1. You are building the
> half of a deploy that proves a module can be stood up: the lab's deploy seed, a readiness census,
> UAT as a deploy target, a migration watermark guard, the synthetic-data door, the drill's
> rehearsal mode and a backout, three redirects, and then you open the laboratory on UAT by
> executing its runbook with a browser, and write the catch-up deploy runbook the owner will run.
>
> One task, one PR, fail-first, mutants named in the task. Never touch `hmis-prod-*`. Never run the
> restore drill against production's backup repository from this lane. Evidence over assertion:
> paste counts. Decide judgement calls on the standard Indian-corporate-hospital answer and mark
> them DECIDED in the phase doc; stop only for money, procurement or law.

---

## 1. State, in one paragraph

Fourteen modules are merged and green; production last deployed on 2 September and is 22
migrations and two whole modules (pharmacy, AERB) behind. Four go-live runbooks exist and none has
run. The lab is deployed and cannot take an order, because `activateLabDefinitions` is called only
by a test helper. The weekly restore drill (`docker/prod/drill/restore-drill.sh`) **passed on
2026-09-05 22:00 UTC** — 498 events, 56 migrations, migrator run from a named image against a scratch
restore — and is the migration rehearsal this phase turns into a step. `deploy.sh` tags `:latest`
only and refuses any checkout but `origin/main`, so no backout exists. #108 (the AERB outside-study
fix) merged as `0077`; #110 is open and conflicting; #73 is a hotfix branch that closes as
superseded on deploy. No `deploy-blocker` label exists yet.

## 2. Read this, in this order — and nothing else at first

| what | why | how much |
|---|---|---|
| this file | order, traps, stop rules | all |
| `CLAUDE.md` | how a session works here | all |
| `docs/superpowers/plans/2026-09-06-phase1-11i-the-stand-up-path.md` | the phase | §2 ground truth · **§2b the Indian day** · §3 D0–D13 · §4 T1–T9 · §5 · §6. **Skip §1** |
| `docs/runbooks/lab-go-live.md` | T2's rows are its sentences; T6 executes it | all (320 lines) |
| `docker/prod/deploy.sh` lines 1–80 and 480–520 | the seed seam, the refusal at line 59, the tags at 63–65 | those lines |
| `docker/prod/drill/restore-drill.sh` lines 1–60 and 300–345 | the image override, the `>=` assertions, the T5 seam | those lines |
| `apps/core/test/deploy-parity.test.ts` around `SEED_STEP_SCRIPTS` (line 345) | the census you extend | that block |
| `apps/core/scripts/seed-pharmacy.ts` | the shape T1 copies | all (short) |

**Do not read:** `EXECUTION-LESSONS.md`; ROADMAP-v2 except §0c.1–§0c.3 if a decision's reasoning is
needed; the position report; the department brainstorm series. Nothing in them changes a task.

Read from `origin/main` (or your lane's fresh checkout), never from `/opt/hmis` — it is 79 commits
behind.

## 3. The lane

```
cd /opt/hmis && tools/lane.sh new commissioning     # worktree + branch lane/commissioning + own test DBs
cd /opt/hmis-lanes/commissioning/hmis && claude
tools/lane.sh status                                 # before any jest: who else is running
```

- One task = one branch stacked on the previous task's branch, one PR each, in the order below.
  Eight lanes and an up-to-date rule mean a PR cycles behind forever if you wait for each to merge
  first — stack them and chase with `gh pr update-branch` (see the memory note on stacked PRs).
- Commit by pathspec: `git commit -F - -- <paths>` with a quoted heredoc. **Never** backticks in a
  double-quoted `-m` or `--body` — they execute and vanish.
- Local tests only through the mutex: `/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run commissioning …`,
  `jest -w 2`, only the suites you touched. The full suite is CI's. Never `pnpm verify`.
- Docker builds go through the same mutex — a build is a builder.

## 4. Execution order — D11, with T0

| step | task | kind | shared files touched (coordinate) | verify |
|---|---|---|---|---|
| 0 | **T0 — 11j steps 1–2**: `kernel/db/client.ts` reads `DB_POOL_MAX` (API 20, worker 10) and `DB_POOL_CONNECT_TIMEOUT_MS` (10000) from env with those defaults. One file, one PR, its own test (a starved connect rejects within the budget instead of hanging). Decided in ROADMAP Q6; not money | ROUTINE | `kernel/db/client.ts` | `jest -w 2 src/kernel/db` |
| 1 | **T1** the lab's deploy seed (`seed:lab`) | ROUTINE | `deploy.sh`, `deploy-parity.test.ts`, `check-config-present.ts` | `jest -w 2 test/deploy-parity.test.ts src/modules/lab/definitions test/check-config-present.test.ts` |
| 2 | **T4** the watermark guard in `scripts/migrate.ts` | ROUTINE | `scripts/migrate.ts` | `jest -w 2 test/migrate-watermark.test.ts` + the existing migrate tests, count read |
| 3 | **T2** the readiness census `standup:check` — three verdicts `ok`/`RED`/`NOT MODELLED`; §2b's rows | CRITICAL | `deploy.sh`, `deploy-parity.test.ts` | `jest -w 2 test/standup-check.test.ts test/deploy-parity.test.ts` |
| 4 | **T8** drill rehearsal mode, SHA tags, rollback path, config snapshot, prune | ROUTINE | `deploy.sh`, `restore-drill.sh`, `kernel/retention/events.ts`, `deploy-parity.test.ts` | `jest -w 2 test/deploy-parity.test.ts src/kernel/retention`; the drill rehearsed with a scratch stanza (§5 of the phase doc) |
| 5 | **T9** the three redirects | ROUTINE | `apps/web/src/router.tsx`, `caddyfile-parity.test.ts` (read the count before and after) | `vitest run src/router`; `jest -w 2 test/caddyfile-parity.test.ts` |
| 6 | **T7** the catch-up deploy runbook — a document, plus `gh label create deploy-blocker` | ROUTINE | `docs/runbooks/catch-up-deploy-2026-09.md` | the reader is the test: every step is a command and an expected line |
| — | **STOP.** Hand the runbook to the owner. He deploys production. Do not proceed to step 7 until his session says the deploy is done, or he tells you to build UAT first regardless | | | |
| 7 | **T3** UAT as a deploy target, banner, `uat-reset.sh`, TZ parity | CRITICAL | `deploy.sh`, `docker-compose.uat.yml` (new), `deploy-parity.test.ts`, the web shell (banner) | `jest -w 2 test/deploy-parity.test.ts`; `HMIS_TARGET=uat HMIS_DEPLOY_DIR=/opt/hmis-uat bash docker/prod/deploy.sh` through the mutex |
| 8 | **T5** the synthetic-data door + `seed:aerb-demo` | ROUTINE | `seed-lab-catalogue.ts`, `seed-lab-demo.ts`, `deploy.sh`, `deploy-parity.test.ts` | `jest -w 2 test/deploy-parity.test.ts test/seed-lab-catalogue.test.ts` (or the seed's own suite) |
| 9 | **T6** the laboratory opens on UAT — executed, dated, corrected | CRITICAL | `docs/runbooks/lab-go-live.md` | a real browser (the playwright recipe in memory: `/opt/chromium`, private dev DB no longer needed — UAT is the target); the `## Executed` section is the artefact |

Then the close: EXECUTE-METHOD-V3 §5A (contract pass before the reviewer; the asymmetry scan beside
it; every fix proved by restoring the defect), two independent review passes, and **the S-gate**:
T6 executed and dated in the runbook is what closes this phase, not a green suite.

## 5. Traps — each has cost a day here already

- **`deploy.sh` refuses unless `HEAD == origin/main`** (line 59). T3's UAT target and T8's rollback
  path both go through this script; the refusal stays for the *build* path. Test the script's
  rendered text (the `caddyfile-parity` grep shape), not by running it against production.
- **The drill's T5 seam appends to the LIVE event log** (`restore-drill.sh:135`, `--network
  container:hmis-prod-db-1`). T8's rehearsal mode must append `backup.drill_rehearsed`, never
  `drill_passed`, and **you rehearse the drill only with `HMIS_DRILL_STANZA`/`HMIS_DRILL_REPO_PATH`
  pointed at a scratch prefix and a UAT database** — never with the defaults, which are production.
- **A census that builds its own view validates something the engine never sees.** Every T2 row
  reads through a module `index.ts` export or a kernel loader. `check-config-present.ts`'s header
  explains why; `seed-roles`' verdict explains why the deploy prints and does not obey.
- **A seed must never touch a CA-signed row.** T1 activates definitions and registers an approval
  type; it writes nothing to `gst_config`, `billing_config` or the tariff.
- **The synthetic door is additive.** `seed-lab-catalogue`'s `:5434` and `NODE_ENV` refusals stay;
  `HMIS_SYNTHETIC_DATA_OK=1` is a third door, not a replacement.
- **Pinned counts move when you add things**: `seed-roles.test.ts` (permissions), `caddyfile-parity`
  (routes — T9 adds none, redirects are not routes; read the count and state it), `deploy-parity`
  (seed list — T1 adds one). Read each count before and after; put both in the commit message.
- **Wall-clock budgets flake under lane load** (`accrual.test.ts` 300 ms; the scheduler suites).
  A red you did not touch: re-run CI, do not search your diff. You cannot `gh run rerun` here
  (fine-grained PAT) — push an empty commit or ask the orchestrator.
- **`lab.test.ts` mints `specimenNo` from `Math.random()` in [10,99]** — a 1-in-90 collision on
  CI. Known; not yours.
- **The web suite is 90 files in parallel with a shared timeout budget.** A heavy test you add can
  time out a peer's. Keep T9's router test light.
- **Backticks in `-m`/`--body` execute.** `-F -` with a quoted heredoc, always.
- **Written diagnoses go stale.** Everything above was true at `f211075` on the evening of
  2026-09-06. `git fetch && git rev-parse --short origin/main` before you rely on any of it; the
  four measuring commands are in the phase doc's §2 header and the roadmap's §0.

## 6. Decisions already made — do not re-open

D0–D13 in the phase doc §3, and §2b's two DECIDED rows (no fake clock for drill A; UAT never
restores a production backup). In particular: Class C definitions are established by the deploy
and Class A/B never are (D2); the census reports and only aborts on UAT (D3); the door is an
environment fact (D5); the drill is the migration rehearsal (D12); the backout is old code on the
new schema (D13). A new judgement call you meet: decide it on the standard Indian-corporate-hospital
answer, write it as D14+ with its reasoning, keep going.

## 7. What is the owner's, and when

| act | when | what blocks without it |
|---|---|---|
| deploy production from T7's runbook | after step 6 | nothing in this phase — T3/T5/T6 proceed on UAT; only the S-gate's *production* half waits |
| one line: any real patient registered on production? | before the deploy | the announcement wording and the hour of the window — not the order (D12) |
| the names: pathologist of record + four lab role holders | before T6's production stand-up (roadmap week 3) | T6 on UAT uses four accounts the lane creates at `/admin/users` on UAT — not a roster in git |
| the lab catalogue spreadsheet | week 3 | UAT runs on the golden catalogue behind the door |
| the AERB certificates | week 7 | UAT files `DEMO` certificates behind the door; production's ionising devices stay refused, recorded as a RED census row |

None of these blocks T0–T9 on UAT. **Do not ask the owner for anything else.** A question that is
not money, procurement or law is yours to decide.

## 8. Stop rules

Stop and write it in the phase doc's §8 rather than work around it when: a test cannot be made to
fail first against the code it guards; a task would weaken a guard, a permission check or an audit
write; any step would need a production credential or touch `hmis-prod-*`; a task passes its
stop-loss share (200,000 main-session tokens); a shared file (`kernel/**`, `app.module.ts`,
`router.tsx`, `deploy.sh`) needs more than the smallest diff the task names; a runbook step cannot
be performed as written (record it as a defect — fix the runbook or the code, never narrate around
it).

## 9. What to leave behind

- The phase doc's **§8 CLOSE** filled: per task the PR number, the fail-first evidence, the mutants
  and how each died, the counts read before and after.
- `docs/runbooks/lab-go-live.md` with its dated `## Executed on UAT` section and the corrections
  D10 names (status line, §1.1, §5, the duplicate §11, drill D).
- `docs/runbooks/catch-up-deploy-2026-09.md`, with the SHA it was written for and the rehearsal
  transcript expected.
- The next handoff: **11k** (the back-book and catalogue loaders, the pharmacy opening on UAT, the
  radiology census walk) — a paragraph of state, the seams, the traps, the open findings with owners.
  Under 12 KB. The successor's prompt names it first.

---

## 10. The edge catalogue — a second and a third pass, 76 rows beyond the phase doc's §2b

Written by the planning session (hmis-c1) against `f211075` and merged into this handoff so the
lane has one assertion book. **§2b of the phase doc holds the 24 rows of the Indian day at the
seats; these are the rows the box, the deploy, the doors, the roles, the drills, the 18c window and
the census itself add.** Columns: **the day** · **what must be true** · **task** · **closes with**
(T = a fail-first test · M = a named mutant · C = a census row · R = a runbook step · D = a
DECIDED line in the phase doc §3). Rows marked ★ were found by measurement. A row is closed when
its artefact exists, not when it has been read. Rows already covered by §2b (shared logins, Hindi
seats, the printers, night mode, IST, the UAT reset, the real-patient fact) are not repeated.

### A. The deploy and the box

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| A1 ★ | The owner runs the catch-up from a laptop on a phone hotspot; the SSH session drops at migration 12 of 22 | The runbook says `tmux new -s deploy` first (check `tmux` is installed, else `screen`). Re-running `deploy.sh` is safe: idempotent, and the watermark guard names what applied. T4 must have MEASURED whether drizzle wraps each migration or the batch in one transaction (`pg-core/dialect.js:60` is inside `session.transaction`) — the answer decides whether "re-run" or "inspect first" is the instruction. The drill rehearsal (D12) is where the answer is first seen on real data | T4, T7, T8 | T (txn shape by execution) · R |
| A2 | The docker build starts while radiology's full-suite run holds 6 GB; the build OOM-kills jest, or jest OOM-kills the build | Every build goes through `test-lock.sh` — a build is a builder. Runbook step 0 reads `board.sh` and refuses to start under a held lock. UAT deploys are a train step, not a lane habit | T3, T7 | R · D8 |
| A3 | `/var/lib/docker` fills with untagged layers after the fourth deploy; the fifth fails at `COPY` | Runbook pre-flight: `df -h /var/lib/docker` and `docker image prune -f` (dangling only, never `-a`); T8's SHA tags are pruned to the last three per name and the UAT tags are name-scoped so a prune cannot remove the running prod image | T3, T7, T8 | R · M (UAT prune removing a prod tag) |
| A4 ★ | The owner deploys from `/opt/hmis` while a peer left an untracked file there | `deploy.sh` refuses (measured: dirty check, `?? docs/` exempt). Never `HMIS_DEPLOY_ALLOW_DIRTY=1` on production; `git status` is the diagnostic; find the file's owner | T7 | R |
| A5 ★ | `/opt/hmis` is 79 commits behind or on a branch | Runbook step 0 names the SHA; `git -C /opt/hmis fetch && git checkout main && git pull --ff-only`; `git rev-parse HEAD` must equal the named SHA. `deploy.sh:59` refuses anything but `origin/main` for the build path (D13 keeps that) | T7 | R |
| A6 | `main` is red when the tip is cut | **DECIDED: a red `main` freezes deploys as it freezes merges.** The tip is the newest green commit with no open `deploy-blocker` PR; the runbook records the CI run id beside the SHA | T7 | R · D |
| A7 | The merge train lands a migration between the tip being named and the deploy starting | The deploy is built from the named SHA, not from `main`; a migration that lands afterwards waits for next week | T7 | R |
| A8 ★ | UAT and prod share an image tag; a UAT build replaces the image production restarts onto at 03:00 | T3's tags are target-scoped (`hmis-uat/server:<sha>`, `:latest`); the deploy-parity UAT census greps the rendered script for `hmis-prod` and finds none | T3 | T · M |
| A9 ★ | Port 8443 is held by `hmis-preview-caddy` | T3 stops the preview container first and says so; the AERB demo on 8444 stays until T7's 18c walk has used it, then stops; `ufw status` after | T3 | R |
| A10 ★ | Staff open UAT on an Android phone; Chrome refuses the `tls internal` certificate | **DECIDED: UAT keeps `tls internal`**; the runbook carries the one-screen "proceed anyway" for Chrome and the Caddy root-CA import for the owner's laptop. A hostname (`uat.hmis.crkmch.com`) is a one-line owner item that removes the step; blocks nothing | T3 | R · D |
| A11 ★ | Basic auth on UAT swallows the app's Bearer token (the preview Caddyfile records exactly this) | Basic auth only on the static SPA, never on `/api/*` — copy the preview's Caddyfile shape | T3 | T (caddyfile parity for the UAT file) |
| A12 | A power cut takes the box down mid-`compose up`; on restart UAT races prod for memory | **DECIDED: UAT compose has no `restart: unless-stopped`**; UAT is started by hand after prod is healthy. Runbook: "after a power cut — prod first, `docker ps`, then UAT" | T3 | D · R |
| A13 ★ | The restore-drill log is stale or red on deploy morning | Runbook step (2) reads `/opt/hmis-prod/log/restore-drill.log`'s last entry (read-only; last PASSED 2026-09-05 22:00 UTC). A failed or >8-day-old drill is the one thing the runbook refuses on; a rehearsal (`drill_rehearsed`) does not count as a drill (T8) | T7, T8 | R · M (a rehearsal counted as the weekly drill) |
| A14 | Two deploys in one day after a hot fix | Idempotent; the watermark guard passes; the seeds report `already`; the census is read twice; the second deploy also gets a `<sha>` tag so either can be the backout | T7, T8 | R |
| A15 ★ | The deploy seeds cursors at `max(seq)` for 18 scheduler jobs and every new consumer; the imaging critical chaser sweeps every minute from the first tick | On production with no imaging data nothing fires. Post-deploy check: `notifications` row count before and after — a burst is a cursor that was not seeded | T7 | R |
| A16 | The owner runs the UAT command with `HMIS_TARGET` unset | Unset means prod. **DECIDED: `deploy.sh` prints a 5-second banner — target, SHA, pending count, rollback target if any — on every run, aborting on Ctrl-C**; no confirmation variable, so the UAT train stays automatable | T3 | T · D |

### B. Data and the synthetic door

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| B1 ★ | UAT runs the production image, so `NODE_ENV=production`; both synthetic seeds refuse | The door is `HMIS_SYNTHETIC_DATA_OK=1` in `/opt/hmis-uat/.env` only; the seeds need the door AND keep their existing refusals; the prod target refuses to start with the key set | T5 | T · M (key set, prod target starts) |
| B2 | Someone copies `/opt/hmis-uat/.env` over `/opt/hmis-prod/.env` "to fix the database URL" | B1's prod refusal; `deploy-parity` asserts `docker/prod/.env.prod.example` lacks the key; and the census's radiology rows: **any licence number containing `DEMO` on a prod target is a hard RED** | T2, T5 | T · C |
| B3 | A UAT dump is restored into production "to get the demo catalogue" | Forbidden in the runbook; mechanically, UAT has no pgBackRest stanza and its DB name is never `hmis`; the census's `DEMO` row catches a licence; a synthetic patient is the one thing the census cannot see, so the words matter | T3, T7 | R · C |
| B4 ★ | The golden catalogue's `services` rows collide with the one synthetic CBC service production already carries | On UAT the same seed is idempotent. On production the owner's catalogue lands through `POST /lab/catalogue/*`; census row "investigation services with no orderable" reports the orphan; the runbook says deactivate, never delete (a service may be on an invoice) | T2, T6 | C · R |
| B5 | A provider is added to `kernel/notify` later and UAT starts sending "report ready" to demo mobiles | Today `notify` has console adapters only (§2b row 7), so nothing leaves. **DECIDED for the day a provider exists: `/opt/hmis-uat/.env` never carries a provider credential**, and `deploy-parity` pins the UAT env template against every provider key the adapters read. T6 also checks `seed-lab-demo`'s mobiles are in a non-allocated range and files a defect if not | T3, T5, T6 | T · R |
| B6 | Chasers and sweeps on UAT page "duty managers" every minute over synthetic overdue rows | B5 makes it harmless; the alert rows still accumulate. T6 reads the alerts list once and records that they are synthetic — the volume is itself a finding for Plan 20 | T6 | R |
| B7 ★ | `seed-lab-demo` "refuses unless asked twice" — nobody knows what the second ask is | T6 reads the script and writes the exact invocation into the lab runbook's `## Executed` section | T6 | R |
| B8 | The UAT reset script (§2b row 23) is run with the wrong project | `uat-reset.sh` refuses unless `PROJECT` is `hmis-uat`, by name, before any `down -v` | T3 | T · M (reset with the prod project) |
| B9 | Aadhaar-like or ABHA-like identifiers in demo data | Demo rows carry none; if the seed sets any, the value must fail the Verhoeff check. T6 verifies by reading the seed | T6 | R |
| B10 ★ | The demo seed runs at 23:50 IST; the "day" it creates is yesterday by the time anybody looks (the lab-reports D9 straddle, already paid for once) | The `## Executed` section records the IST time; the seed is not run between 23:30 and 00:30 IST. If the seed has no injectable clock, that is a defect to file, not to work around | T6 | R |

### C. People and roles

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| C1 ★ | Production has one administrator; the lab runbook §1.3 calls a second one a blocker | Per §0c.6 the lab opens under R-247 single-approver honesty mode; O1 stays on the IPD gate. The census row "≥ 2 users hold `admin`" is **informational** for the lab and RED for anything Class-A two-key; on UAT T6 creates `admin2` so the honesty-mode event can be seen once | T2, T6 | C |
| C2 | A role assigned at department scope, not hospital scope; the seat 403s unreadably | The census checks hospital scope specifically; its RED text names the scope | T2 | C · M (department-scope holder reads green) |
| C3 ★ | `seed-roles` prints NOT READY on production because nobody holds `pharmacy` or `phlebotomist` | Not fatal (measured in `deploy.sh`); the census repeats it per module with the screen to fix it; the runbook says "expected on the first deploy" | T2, T7 | R |
| C4 | UAT credentials: the lane needs accounts, the owner needs their passwords, nothing may go in git or in a file `seed-staff` would reject | **DECIDED: UAT accounts are created at `/admin/users`; their passwords go in a root-600 file under `/opt/hmis-uat/`, as the front-desk preview already does — acceptable for a synthetic environment only, named in the runbook so it is deleted with the environment, never for production** | T6 | D · R |
| C5 | The pathologist of record's registration number on production is a legal fact that prints on every report | The census checks non-empty (§2b row 20); the `fix` text says "from the certificate, not from memory"; on UAT the value is `DEMO-REG-…` | T2 | C |
| C6 | Nobody holds `billing_manager` on UAT; a HELD report cannot be released and walkthrough step 5 dead-ends | The lab's G4 census rows include the roles the lab runbook names outside the lab: `billing_manager` (release), `cashier` (the walk-in's bill). T6 creates both | T2, T6 | C · R |
| C7 | The bridge accounts (`lab_bridge`, `modality_bridge`) — should the census demand them? | Informational rows, never RED — and per §0c.2 the lab's rows gain the inverse: **RED if a `lab_instruments` row or a `lab_bridge` holder exists before 17-E T7 is in the deployed base** | T2 | C |

### D. The lab on UAT — the walk-through and the drills

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| D1 ★ | A walk-in with no OPD visit: `openVisitInTx` needs a `LAB` department with an active doctor in it | Census rows (department + doctor of record); T6 creates them through the OPD masters screen, never by SQL | T2, T6 | C · R |
| D2 ★ | One orderable has no price in the active tariff version; the desk refuses `tariff_item_missing` in front of a patient | Census row "every orderable priced"; **the walkthrough deliberately leaves one unpriced** to see the refusal and record its wording — the census must have predicted it | T2, T6 | C · R · M (unpriced orderable reads green) |
| D3 | The report is HELD against an unpaid walk-in line | C6's accounts; the walkthrough performs the release and reads the approval row | T6 | R |
| D4 | Drill A at 02:00 — the critical ladder rings everyone holding `pathologist` because there is no rota | Expected until Plan 20; the walkthrough records how many were paged (on UAT: the demo pathologist); the printed call list is the artefact (§2b row 6) | T6 | R |
| D5 | Drill B — a rejected tube on a billed walk-in; the credit note needs billing config and `billing.credit_note.issue` | Seeds present; the grant per runbook §3.4. If the credit note is refused, G4 was incomplete — add the census row, do not grant by hand | T2, T6 | C · R |
| D6 | The doctor's cockpit (07d) must show the signed result | The demo needs a consult under an OPD doctor; if `seed:lab-demo` makes a walk-in only, the walkthrough opens a consult by hand and records that the seed lacks it | T6 | R |
| D7 | The cashier's drawer: the walk-in's cash needs an open drawer session (`0055`) | The walkthrough opens one as the cashier (§2b row 13). **DECIDED: a drawer session is a shift fact, not a stand-up fact — no census row** | T6 | D |
| D8 | The five seats are walked by one person five times | Acceptable on UAT (the S-gate is about the path); on production the pilot (G6) is the department's. Say so in the `## Executed` section | T6 | R |
| D9 | The demo patients look like duplicates of each other (a known trait of the seeded set) | The registration seat's duplicate check fires; the walkthrough records the refusal path and the merge queue (§2b row 4) rather than choosing names that dodge it | T6 | R |

### E. The 18c window and radiology

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| E1 ★ | Production has zero registered ionising devices; the licence gate has nothing to refuse | The census reports the device count; the window step is SKIPPED and recorded as skipped. Do not declare `degraded` for nothing — every mode row is a ledger entry the owner reads | T2, T7 | C · R |
| E2 ★ | A certificate is entered with the wrong expiry year (chaos §8); 18c's only correction is `surrender`, which is terminal | The AERB-bench walk includes a deliberate wrong year and the documented safe path (a too-short window: file the next certificate from the day after). The runbook says "read the validity twice before filing"; the surrender question stays on the owner's 18c list | T7 | R |
| E3 | The RSO role has no holder on production; nobody can file | `seed:roles` mints it on the deploy; the census row says whom to assign; the owner assigns at `/admin/users` before the window step | T2, T7 | C · R |
| E4 | A CT is booked into the window | Radiology is unopened on production; if a booking exists the console sees `device_not_licensed` and the window note names it. The runbook says to read the day's imaging appointments before declaring | T7 | R |
| E5 ★ | The owner does not hold the certificates on deploy day | Devices stay refused after the window; the census shows RED on the radiology rows; it costs nothing while radiology is unopened (second reading) | T7 | R |
| E6 ★ | The AERB bench (`hmis_aerb_demo`) is on an old migration set | Two rehearsals, two instruments (D12): the restore drill rehearses the *migrations* on production's data; the AERB bench rehearses the *18c gate walk* (refuse → file → gaps empty). The bench is migrated to the tip first and the watermark guard runs there before it runs anywhere else | T4, T7, T8 | R |

### F. Money and paper, before the CA signs

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| F1 | Production holds dev placeholder GST and an unsigned tariff (O6); a pilot invoice prints with placeholder tax | The pilot is shadow with paper authoritative (runbook §9). The census's hospital-wide row "`validate:config` last ok" is informational and names O6; every receipt before O6 is a commissioning receipt and the cashier keeps the paper book | T2, T7 | C · R |
| F2 | The downtime kit's serial ranges are not registered on UAT; drill C has no serial to quote | `/ops/downtime-kit` before drill C; an informational census row "kit ranges registered" | T2, T6 | C · R |
| F3 | MRP vs tariff vs the NPPA ceiling at the pharmacy counter | Not this phase; the pharmacy seat drill (11k) meets it. Named in §6 so nobody looks for it here | — | §6 |

### G. The census itself

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| G1 ★ | The census must run on production, and this lane may not touch `hmis-prod-*` | Runbook steps (3) and (6) are the OWNER's: `compose run --rm api node dist/scripts/standup-check.js all`, exactly as the seeds run. The lane runs it on UAT, on the drill's scratch cluster (T8) and on the test DB only | T2, T7, T8 | R |
| G2 | A module renames a role key; the census keeps a string and reads green for a role nobody holds | Rows reference `ROLE_MODEL` keys from `seed-roles.ts`; the test asserts every key the census names exists in the model | T2 | T · M |
| G3 | A loader throws on an empty database; the census crashes instead of reporting | Every check is wrapped; a throw is RED with the loader's own message and the `fix` text | T2 | T · M (a throwing loader aborts the run) |
| G4 | A runbook gains a precondition and the census does not | The test pins one row set per `docs/runbooks/*-go-live.md` and counts the runbook's `## Preconditions` rows against the census's rows for that module — a mismatch fails. Blunt, cheap, and it is what makes the runbook and the script one document | T2 | T |
| G5 | The census is green and the seat still fails | Then the runbook was incomplete: T6 files the missing row (the walkthrough is the census's test) | T6 | R |

### H. The owner's day

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| H1 | The owner reads the runbook on a phone at 22:00 | Every step is one command and one expected line; no paragraph a thumb cannot scroll past. The mutant for a runbook is a reader | T7 | R |
| H2 | The owner asks "is it safe to deploy?" on a Sunday with a peer's stack half-merged | The runbook's answer is a procedure (A5–A7 and the `deploy-blocker` label), not a judgement; the lane's answer is `lane-report.sh` plus a message to the orchestrator, never "yes" | T7 | R |
| H3 | The one fact — a real patient on production — turns out to be true | Per D12 the order does not change; the announcement of the three deleted routes and the hour of the window do. The redirects (T9) make the announcement a courtesy rather than a rescue | T7, T9 | R |

### I. Third pass — rows the first two catalogues lack (hmis-c7, the owner's planning session)

Seventeen rows from a 43-row pass, kept only where §2b and A–H have no artefact. Same columns.

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| I1 ★ | **The census writes.** A row check routed through a read function that emits an audit event; the owner's "read-only" run on production leaves rows behind | A test runs `standup:check all` and asserts the audit and event tables' row counts are unchanged | T2 | T · M (a check through a writing reader) |
| I2 | A deactivated or locked account holding `admin` is counted as the second administrator | Role rows count **active** users only; the `fix` text says "a different person, not a second login" | T2 | C · M (a deactivated admin reads green) |
| I3 | A tariff version flagged active with an effective date next month; "priced" reads green today | "Priced" is evaluated against the version effective **now, in IST** | T2 | C · M (future-dated version counts) |
| I4 | An orderable priced at ₹0 — the same defect as no price, and it walks past "every orderable priced" | ₹0 is RED; a free test is a row with a reason, never a zero | T2 | C · M (₹0 reads green) |
| I5 | Potassium 6.8 at 02:00 and no critical limit on file — the ladder never fires and nobody knows it did not | Critical limits exist for a minimum set (K, Na, glucose, Hb, platelets, WBC, INR, troponin, Ca) or the row is RED | T2 | C · M (no limits reads green) |
| I6 ★ | A partner-billed walk-in (a TPA or corporate panel from `partners`, deployed): the invoice must go to the partner and the patient pays nothing at the desk | One walk-through case; the receipt and the partner receivable both read | T6 | R |
| I7 | The pilot's "seven empty harvest days" is met by a Sunday and two holidays with no orders at all | Runbook §9 counts only days with ≥ 20 orders as evidence; corrected in T6's PR | T6 | R |
| I8 | Drill C: a collection done on paper during the outage is backfilled with the backfill time, and the TAT lies | The backfill carries the real collection time; the walk-through reads it back | T6 | R |
| I9 | A test the lab does not perform is ordered — send-out to a reference laboratory is **not built** | Recorded as a GAP with the paper path; 17-family work, not this phase's; the fix list carries it | T6 | R |
| I10 | `seed:lab` re-activates a definition a `user` actor deactivated on purpose | The seed reports `inactive_by_choice` and leaves it; only a never-activated definition is activated | T1 | T · M (re-activation) |
| I11 | `seed:lab` on a database where a migration failed midway and the lab tables are absent | Exits non-zero naming the table; never `alreadyActive` by catching the error | T1 | T · M |
| I12 | The journal has fewer entries than the database has applied (a checkout behind the database) | The watermark guard refuses, naming both counts; an empty table (fresh UAT) passes | T4 | T · M |
| I13 ★ | **UAT mounts production's `pgbackrest.conf`** (the db image bakes pgBackRest in and reads config from the deploy directory) and archives UAT's WAL into production's repository under the same stanza | T3 mounts UAT's own file with archiving off (`archive_mode=off`, or `archive_command='/bin/true'` if the image forces the mode); B3's "no stanza" is asserted by a test, not assumed | T3 | T · M (prod conf mounted on UAT) |
| I14 ★ | The backout (D13) assumes old code tolerates the new schema — false for a NOT NULL column without a default on a table the old code inserts into | The runbook lists the result of grepping `0056`–`0077` for exactly that; step (9) says whether the backout is clean | T7, T8 | R |
| I15 | A role key renamed or removed between `c11833d` and the tip strands its holders after the deploy | The runbook diffs `seed-roles.ts`'s keys between the two commits and lists any drift with the users affected (measured tonight: none found, but the grep pattern may not match the file — measure again) | T7 | R |
| I16 | Someone adds a "force everyone to log in again" step after the deploy | Not needed: permissions are read per request (`hasPermission(db, …)`), sessions survive. Stated so nobody adds it | T7 | R |
| I17 ★ | The drill rehearsal (D12) migrates the restored copy and stops; the seeds, the config gate and the census are first run on production itself | After the migrate, the same run executes the seeds, `check-config-present` and `standup:check all` on the restored copy; its census output is the runbook's "before" list, and a gate refusal on a new required config row shows there | T8, T7 | R · T |

**Carried to 11k, with its spec kept here so it is not lost — the catalogue loader** (§2b rows 2
and 8 send it there): `load:lab-catalogue` takes CSV files the owner exports from Excel (analytes,
orderables, panels, reference ranges, critical limits, prices), **dry-run by default** with one line
per rejected row; `--commit` writes through the module's own catalogue functions, idempotent on
`code`; refuses an unknown unit (a fixed list — `mg/dL` and `mmol/L` are never coerced), a range
without a source, low ≥ high, a panel naming an unknown member, a duplicate code, a missing column;
never invents a row; prices land GST-exempt with SAC 9993 without asking. Mutants: a unit typo
coerced, a sourceless range accepted, a second `--commit` doubling rows, `--commit` as default, a
price row at 18 %.

**Decisions this section adds, to be written as D14+ in the phase doc when the task that uses them
runs:** A6 (a red `main` freezes deploys), A10 (`tls internal` on UAT), A12 (UAT never auto-restarts),
A16 (the banner, no confirmation variable), B5 (no provider credential on UAT, pinned), C4 (UAT
passwords in a root-600 file under `/opt/hmis-uat/`, never for production), D7 (a drawer session is
not a stand-up fact).
