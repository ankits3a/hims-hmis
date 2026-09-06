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
