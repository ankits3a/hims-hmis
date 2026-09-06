# Phase 11i — The stand-up path: UAT, the readiness census, and the laboratory opening first

**Lane: LIGHT** (7 tasks, no new module, **no migration** — EXECUTE-METHOD-V3 §2).
**Stop-loss: 2,120,000** = main-session `7 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145, the repair term).
**Lane:** the pharmacy lane's worktree, branch `lane/commissioning-11i` cut fresh from `origin/main` — this lane becomes the commissioning lane (roadmap §0b.2), and the lane that builds UAT is the lane that runs it. The LIMS lane takes 17-E T7 in parallel. **One task = one PR**: commit by pathspec, push, `gh pr create`; CI is the gate; locally only the touched suites, always through `test-lock.sh`. Docker builds go through the same mutex — a build is a builder.

**Status: AUTHORED 2026-09-06; REVISED the same day by a second session (execution order D11, the lane, the restore drill in T7); NOT APPROVED, NOT STARTED.** Proposed by `2026-09-06-ROADMAP-v2.md` §7 as the first phase of the commissioning track. **Author it; do not execute it** was the brief's instruction to the session that wrote this.

## 1. Why this phase

Fourteen modules are merged and green. Production was last deployed on 2 September and is now
**21 migrations and two whole modules** behind `main`. Four go-live runbooks exist under
`docs/runbooks/` and **none has ever been executed against any environment**. The lab's runbook —
the only one whose module is actually deployed — says in §5 *"Run `activateLabDefinitions`"*, and
that is a TypeScript function that no `seed:*` script, no deploy step and no screen calls: its only
caller is `test/helpers/lab.ts`. A lab order placed on production today throws
`no_active_definition` at `desk.ts`, in front of a patient.

That is one instance. The general shape is that **a module is called complete on merged code and a
green suite, and no artefact in the repository proves it can be stood up** — the runbooks describe
the path in prose, the seeds establish some of it, the config gate checks four kinds of row, and the
owner, when he wants to see a thing, gets a lane-built demo stack on a spare port (`:8443` for the
front desk, `:8444` for AERB) that is not production and not shared.

This phase builds the missing half of the deploy: a **UAT environment** that is the same deploy as
production with synthetic data behind a door production never opens; a **readiness census** that
turns each runbook's preconditions into a script whose red rows name the screen that fixes them; the
**lab's deploy seed**, so the two things its runbook hand-waves become a step the deploy runs; a
**watermark guard** in the migrator, so a regenerated migration cannot be skipped silently; and
then it **opens the laboratory on UAT** by executing the runbook, dating the execution in it, and
writing the catch-up deploy runbook the owner runs against production.

**The through-line: a phase is closed when its stand-up path has been executed, not when its code
compiles.** Nothing here weakens a guard, activates a Class A or B definition, or writes a synthetic
person anywhere production could read.

**Finish line:** `standup:check lab` is green on UAT after `deploy.sh`, the golden catalogue and
`seed:lab-demo`; five people (or one person five times) have walked the runbook's §11 in a browser
against UAT and the three drills passed; the lab runbook carries a dated `## Executed` section; the
catch-up deploy runbook exists with the 18c window in it; and §6 records what was deliberately not
built.

## 2. Ground truth — measured 2026-09-06 at `origin/main` `3b35179`, re-measured at `78f5947` (deployed base `c11833d`)

| # | what the stand-up needs | what exists today | where | 11i |
|---|---|---|---|---|
| 1 | the lab's two workflow definitions active | `activateLabDefinitions(db, activator)` — Class **C** by its own header, idempotent (a second call reports `alreadyActive`), activator must be a `user` actor. **Callers: `test/helpers/lab.ts:216` and nothing else** | `modules/lab/definitions.ts:42` | **T1** |
| 2 | the lab's approval type registered | `registerLabApprovalTypes(db, activator)` — idempotent; exported on the module seam; **no script calls it** | `modules/lab/approval-types.ts:78`, `lab/index.ts:15` | **T1** |
| 3 | the precedent for a deploy activating a Class C definition | `seed-pharmacy.ts` activates `pharmacy_dispense` with `const activator: Actor = { type: "user", id: "seed-pharmacy" }`, runs in `deploy.sh` before `seed-roles.js`. `seed-radiology.ts` activates `study_types` (owner ruling 2026-08-31). `seed-ot.ts` drafts and activates **none** (DD6, Class B) | `scripts/seed-pharmacy.ts:23,45`; `docker/prod/deploy.sh:484` | **T1 copies the shape** |
| 4 | the deploy's seed list, pinned | `SEED_STEP_SCRIPTS` in `test/deploy-parity.test.ts:345` — eleven scripts (ten configuration seeds plus `seed-roles.js`); asserts each exists in `scripts/`, runs before `check-config-present.js`, `seed-ops` before `seed-roles`, and that `seed-roles`' verdict does not abort the deploy | `test/deploy-parity.test.ts:391–470` | **T1, T3 edit the pin** |
| 5 | the deploy's hard gate | `check-config-present.ts` asks four questions through the modules' own loaders: `billing_config`, `gst_settings`, ≥1 `gst_config`, every approval type registered. It does not know a workflow definition exists | `scripts/check-config-present.ts:51–90` | **T1 adds row 5** |
| 6 | a readiness verdict that is a report, not an abort | `seed-roles.js` exits non-zero on "no user holds role X"; `deploy.sh:498` reads it, prints it, continues. `check-config-present` is the one that aborts | `deploy.sh:498–517` | **T2 follows both** |
| 7 | the golden catalogue on a non-production box | `seed-lab-catalogue.ts` refuses when `DATABASE_URL` contains `:5434` **or** `NODE_ENV === "production"`. The production image sets `NODE_ENV=production`; so does UAT if it runs the same image | `scripts/seed-lab-catalogue.ts:170` | **T5** |
| 8 | a lab day on a non-production box | `seed-lab-demo.ts` refuses `NODE_ENV=production`, "refuses to run without being asked twice", finds its actors by role and mints no credentials, writes through the real paths. Merged as #104. **Not in `SEED_STEP_SCRIPTS`, deliberately** | `scripts/seed-lab-demo.ts:284–306` | **T5, T6** |
| 9 | a second environment from the same deploy | `deploy.sh`: `DEPLOY_DIR` is env-overridable (`HMIS_DEPLOY_DIR`), but `PROJECT="hmis-prod"`, the three image tags, the cron file and the edge gate's hostname are fixed. Steps 4 (pgBackRest stanza), 7 (backup cron) and 8 (edge gate on the real hostname) are production-only by nature | `deploy.sh:44–72, 380–420, 645, 714` | **T3** |
| 10 | what runs on the box today | `hmis-prod-*` (9 containers, db limit 4 GB), `hmis-preview-caddy` (`:8443`, API from `/opt/hmis`'s build on `:3000`), `hmis-aerb-demo-caddy` (`:8444`, API `:3020`, DB `hmis_aerb_demo`), `hmis-db-1` (the lanes' Postgres). **15 GB total; 9.3 GB used with 5 GB of swap at the first reading, 7 GB used / 7 GB available at the second** — a moment either way; the demos retire regardless. A weekly `restore-drill.sh` host cron and its watcher rule are installed by `deploy.sh` step 7 (11c D11); its log has never been read by a runbook | `docker ps`, `free -h`, `board.sh`, `deploy.sh:637` | **T3 replaces the two demos; T7 reads the drill log** |
| 11 | the migrator's skip rule | drizzle-orm 0.40.1 applies entries whose folder millis are **greater than** the single latest `created_at`; `hash` is written and never read. `main`'s journal is strictly monotonic (77 entries, checked twice); production's watermark is `0055`'s `when = 1788351286473` | `scripts/migrate.ts`; `drizzle/meta/_journal.json` | **T4** |
| 12 | the lab runbook | 320 lines, in the deployed base. §0 role keys · §1 preconditions (1.3: a second administrator) · §2 `LAB` department + pathologist of record · §3 grants · §4 catalogue via `POST /lab/catalogue/*`, every orderable priced · §5 definitions + approval type · §9 pilot harvest · §10 drills A–C · §11 five-seat walk-through. **Status line says NOT DEPLOYED; the lab is deployed since `0046`.** Two sections are numbered 11 | `docs/runbooks/lab-go-live.md` | **T6 executes and corrects it** |
| 13 | the other three runbooks | pharmacy (119 lines; `seed-pharmacy` already establishes G2), radiation safety (303; **§0: ionising acquisition refuses `device_not_licensed` from the moment `0060`–`0065` land, and T6's filing screen ships in the same deploy**), PACS (140; bridge account + AE titles). None in the deployed base | `docs/runbooks/*` | **T2 reads them; T7 sequences 18c** |
| 14 | what production changes on the catch-up | +`pharmacy`, +`aerb` (never deployed); +6 routes (`/appointment`, `/counter/figures`, `/lab/reports`, `/pharmacy/counter`, `/pharmacy/items`, `/radiology/radiation-safety`); **−3 routes production serves today** (`/counter/seat`, `/counter/seat/figures`, `/opd/vitals/bay`); 21 migrations (`0056`–`0076`) | `git show c11833d:apps/web/src/router.tsx` vs `origin/main` | **T7** |
| 15 | the operating mode | `OPERATING_MODES = commissioning · ramp · normal · degraded · downtime`; `commissioning` is initial-only; the exit needs `validate:config` ok within 24 h (CA signature + active tariff). **No module reads the mode** — `getOperatingMode` has no caller outside `kernel/ops` | `kernel/ops/mode.ts:114`, `scripts/validate-config.ts` | **D7 — "open" is not the mode** |
| 16 | the pool | `new Pool({ connectionString: url })` — no `max`, no `connectionTimeoutMillis` | `kernel/db/client.ts:9` | **not this phase** — 11j step 1–2, one PR, decided in the roadmap Q6 |

Three measured facts that shape the design and would otherwise be guessed:

- **The lab runbook contradicts the deploy's own rule, and the deploy is right.** Plan 11g / DD2:
  *"the deploy establishes the rows its own modules throw without."* `startInstance` throws
  `no_active_definition`; the definitions are Class C (zero approvals, by ruling D-15). Pharmacy
  already does this. The runbook's *"not a deploy step"* predates 11g's rule reaching the lab and is
  superseded, not argued with (D2).
- **18c cannot be made deploy-dark without weakening it, and it need not be.** D3 of 18c is an
  offence-preventing guard by design. The runbook's own §0 asks for a staging rehearsal; UAT is
  that. Production takes it in a declared window (T7). The rule for *future* modules is D4.
- **UAT must run the production image, or it proves nothing** — and the production image sets
  `NODE_ENV=production`, which is exactly the value the two synthetic seeds refuse. So the door
  cannot be `NODE_ENV`; it has to be a fact about the environment that production's env file never
  carries (D5).

## 3. Design decisions — DECIDED; none is money, procurement or law

- **D0 — 11i before Plan 20, and before any other build.** The constraint has moved from building to
  absorbing (roadmap §0–§1); a lane is idle; this phase carries no migration and so cannot contend
  for a serial with the radiology stack. Plan 20 is authored in the same week by a different lane.
- **D1 — UAT is the owner's bench; production never holds a synthetic person.** `seed-lab-demo`'s
  own reasoning is the ruling: a synthetic patient is referenced by orders, invoices and results and
  cannot be deleted. UAT replaces the two ad-hoc demo stacks rather than joining them — the box
  cannot carry a third (§2 #10). It moves to a second server if the owner buys one (roadmap §6.1);
  nothing in this phase assumes he does.
- **D2 — Class C definitions and approval types are ESTABLISHED BY THE DEPLOY; Class A and B never
  are.** Pharmacy is the precedent, 11g/DD2 is the rule, `seed-ot`'s DD6 is the boundary ("a seed
  that activates a Class-B definition is the theatre the owner named"). The lab's seed activates
  with a synthetic `user` actor exactly as `seed-pharmacy` does, so `activateDefinition`'s
  user-actor refusal is respected rather than widened.
- **D3 — The readiness census READS THROUGH THE MODULES' OWN LOADERS and REPORTS; it aborts only on
  UAT.** `check-config-present`'s lesson (a gate that builds its own view validates something the
  engine never sees) and `seed-roles`' lesson (a verdict about staffing must not abort a migration)
  both apply. In `deploy.sh` it runs after the gate and its exit code is printed, not obeyed. As the
  UAT stand-up gate (T6) its exit code is the verdict. It is a *census*: every row it checks is
  declared in a table a test pins, and a module with a runbook and no census rows fails the test.
- **D4 — DEPLOY-DARK for every module from here: a guard that needs configuration ships inert until
  the configuration exists, OR its configuration surface ships one deploy earlier.** Each future
  phase doc states which it chose. 18c is the measured exception and is *not* retrofitted (§2's
  second fact); the catch-up runbook carries its window instead.
- **D5 — The synthetic-data door is an ENVIRONMENT FACT, not an argument.** `HMIS_SYNTHETIC_DATA_OK=1`
  lives in `/opt/hmis-uat/.env` and nowhere else. `seed-lab-catalogue` and `seed-lab-demo` require it
  *in addition to* their existing refusals (the `:5434` and `NODE_ENV` checks stay — a door is added,
  not swapped). `deploy-parity.test.ts` asserts the production env template does not carry the key,
  and `deploy.sh` refuses to start when `PROJECT` is `hmis-prod` and the key is set. The AERB demo's
  four `DEMO` certificates are filed on UAT through the real route (`file-demo.sh`'s shape), behind
  the same door.
- **D6 — The watermark guard REFUSES; it never repairs.** A journal entry whose `when` is at or below
  the database's latest applied `created_at` and whose tag is not among the applied hashes is a
  regenerated migration, and the migrator exits non-zero naming it. Renumbering is a human act at
  rebase (CLAUDE.md). An entry below the watermark that *is* applied is fine and says nothing.
- **D7 — "Open" is the seven-gate checklist (roadmap §3), not the operating mode.** No module reads
  the mode (§2 #15); the mode's exit is the hospital-wide O6 act. A department's opening is G1–G6 for
  that department, and this phase makes G1–G4 a script and G5 a dated section in the runbook.
- **D8 — UAT is deployed by the orchestrator after every green train batch, through the test mutex;
  production is deployed weekly by the owner's hand.** The build step is the expensive half and it
  contends for the same memory as jest; the mutex already serialises that. Nothing in this phase
  automates a production deploy — the classifier blocks it and that is correct.
- **D9 — The census is spoken in the runbook's words.** Each red row prints the screen or command
  from the runbook that turns it green (`/admin/users`, `POST /lab/catalogue/analytes`, "assign
  `pathologist` at hospital scope"). A census that says `lab_department_missing` and stops is a
  second document to reconcile; one that says *"§2: create department `LAB` with an active doctor
  in it"* is the runbook, executable.
- **D10 — The lab's runbook is CORRECTED in place, not rewritten.** Its status line, its §1.1
  migration number, its §5 (now a deploy step), its duplicate §11, and the new dated `## Executed`
  section. The drills and the walk-through are right and are what T6 runs.
- **D11 — EXECUTION ORDER: T1, T4, T2 and 11j's two pool values land first; T7's runbook is written
  and its 18c rehearsal performed on the existing AERB bench; the owner deploys production; only
  then T3, T5, T6.** Production has never left `commissioning`, no department has opened on it, and
  the batch's one behaviour-changing step (18c's licence gate) already has a bench on `:8444`. UAT
  is for the pilots (G5), not a gate on a deploy into an empty hospital, and every week it gates
  adds two or three migrations to the batch (roadmap §0b.1). The one fact that reverses this — a real
  patient on production — is the owner's to state; then T3/T5/T6 precede the deploy as the first
  draft had it.

## 4. Tasks — one PR each, fail-first, rail + consumer together

### T1 — ROUTINE · The lab's deploy seed
`scripts/seed-lab.ts` + `"seed:lab"` in `package.json`: calls `activateLabDefinitions` then
`registerLabApprovalTypes` with `{ type: "user", id: "seed-lab" }`, prints the JSON report both
already return, exits 0 on `alreadyActive`. Joins `deploy.sh` after `seed-pharmacy.js` and before
`seed-roles.js`; `SEED_STEP_SCRIPTS` gains the entry. `check-config-present` gains row 5: `lab_item`
and `lab_specimen` have an active definition (through `getActiveDefinition`, not a select) and
`lab_release_unpaid` is registered (already covered by row 4's loop once the type is declared —
verify by execution, not by reading). **Mutants:** a second run mints a second definition version
(the idempotence test reads the version count, not the exit code); the seed placed after
`seed-roles` (deploy-parity must fail); the gate green with no active `lab_item`; the activator
declared `system` (must be refused by `activateDefinition`, and the test proves the refusal).

### T2 — CRITICAL · The readiness census: `standup:check <module>`
`scripts/standup-check.ts` with a declared table `STANDUP_ROWS: Record<module, Row[]>` where each
`Row = { gate: "G1"|"G2"|"G3"|"G4", code, check: (db) => Promise<boolean>, fix: string }` and `fix`
is the runbook's own sentence. **Lab rows** (from `lab-go-live.md` §0–§6): department `LAB` active
with ≥1 active `opd_doctors` row in it; both definitions active; the approval type registered;
≥1 orderable; **every orderable's service priced in the active tariff version** (the runbook's
`tariff_item_missing` warning made a check); each of the four role keys held by ≥1 user at hospital
scope; ≥1 `resources` row of a lab bench kind; **the second administrator exists** (≥2 users hold
`admin`). **Pharmacy rows** (from `pharmacy-go-live.md` §1): `PHARM-OPD` store; `pharmacy_dispense`
active; `pharmacy` role held; ≥1 item; ≥1 batch with stock. **Radiology rows**: `study_types` active;
≥1 device; **when the `aerb` module is present, `unlicensedDevices` empty** (the 18c §0 condition,
read through the module's own read function). **Front desk rows**: `registration_config`,
`opd_config`, ≥1 active doctor in ≥1 department, `cashier` and `front_office` held. Every check goes
through a module `index.ts` export or a kernel loader — never a raw select. Output: one line per
row, `ok`/`RED` + `fix`; exit code = any RED. `deploy.sh` runs `standup:check all` after the gate,
prints, does not obey (D3). A test pins that every module with a `docs/runbooks/*-go-live.md` has a
row set, and drives a fresh test DB through: everything RED with a `fix` → after the seeds, exactly
the G2 rows green and nothing else. **Mutants:** an unpriced orderable reads green; a role held only
at a non-hospital scope reads green; a module with a runbook and no rows passes the census test;
`deploy.sh` obeying the exit code (deploy-parity must catch it, as it catches `seed-roles`).

### T3 — CRITICAL · UAT as a deploy target
`deploy.sh` reads `HMIS_TARGET` (`prod`, default, or `uat`): it sets `PROJECT`, the three image
tags, `DEPLOY_DIR`, the cron file, and **skips** step 4 (pgBackRest stanza), step 7 (backup cron) and
the real-hostname half of step 8 (UAT's edge gate is `https://<ip>:8443/api/health` through its own
Caddy, with the basic-auth the preview already uses). A `docker-compose.uat.yml` override: the same
db image with a **1 GB** limit, api `768m`, worker `512m`, no alertmanager/grafana/prometheus/
exporters, host ports `8443` only. `/opt/hmis-uat/` with its own `.env` (T5's door set), created by
the owner or the lane — the script refuses without it, as it does for prod. **Retire
`hmis-preview` and `hmis-aerb-demo`** in the same PR's runbook note (after T7's rehearsal has used the AERB bench — D11) (their Caddy containers stop;
their directories stay until the owner deletes them; `preview.sh` is deleted from the tree if it is
in it — it is not, it lives in `/opt/hmis-preview`). `deploy-parity.test.ts` learns the target: the
prod census unchanged; a UAT census asserting that with `HMIS_TARGET=uat` the script's effective
text references **no** `hmis-prod` project, image, directory or cron path (the caddyfile-parity
shape: grep the rendered script). **Mutants:** UAT writing `/etc/cron.d/hmis-prod-backup`; UAT
building `hmis-prod/server:latest`; UAT's compose sharing prod's network or volume names; the prod
target reading `HMIS_SYNTHETIC_DATA_OK` without refusing.

### T4 — ROUTINE · The migration watermark guard
`scripts/migrate.ts` (both entrypoints — `tsx` and `dist`) reads `drizzle.__drizzle_migrations`
before calling drizzle's `migrate`: `latest = max(created_at)`, `applied = set(hash)`. For every
journal entry with `when <= latest` whose migration-file hash is not in `applied`, exit non-zero
naming the tag, the `when`, the watermark, and the sentence *"renumber at rebase; never edit an
applied migration"*. An empty table is a fresh database and passes. Tested with a synthetic journal
+ a test database driven to a watermark: a regenerated `0060` below `0075` refuses; an applied
entry below the watermark passes; a fresh DB passes; the normal forward case is untouched (the
existing migrate tests still pass, count read). **Mutants:** the guard reading `idx` instead of
`when`; the guard comparing `<` where `<=` is the drizzle rule (an equal-millis entry is skipped by
drizzle — prove it against the installed 0.40.1, not the docs); the guard repairing by re-stamping.

### T5 — ROUTINE · The synthetic-data door
`HMIS_SYNTHETIC_DATA_OK=1` required by `seed-lab-catalogue.ts` and `seed-lab-demo.ts` in addition to
their existing refusals, with the refusal text naming the key and saying where it may be set (D5).
`deploy.sh` (prod target) refuses to start if the key is set in its env. `deploy-parity.test.ts`
asserts `docker/prod/.env.prod.example` does not carry it. The AERB demo's `file-demo.sh` shape becomes `scripts/seed-aerb-demo.ts` behind the same
door — four `DEMO` certificates through `POST /aerb/licences` — because UAT's catch-up rehearsal
must show the gaps list *emptying* (18c §0's own check), not just the refusal. **Mutants:** the
catalogue seed running with the key unset and `NODE_ENV` unset (both doors must be needed — the
`:5434` refusal stays); the demo seed writing a licence whose number lacks `DEMO`; the prod
target starting with the key set.

### T6 — CRITICAL · The laboratory opens on UAT — executed, dated, corrected
Not new code: **the execution**. `HMIS_TARGET=uat deploy.sh` from `origin/main` → `standup:check
lab` (read every RED) → `seed:lab-catalogue` → the four role holders created at `/admin/users` on
UAT (real screen, transcript kept, no roster in git) → `LAB` department + pathologist of record
through the OPD masters screen → `seed:lab-demo` → `standup:check lab` **green** → the runbook's §11
walk-through at all five seats in a real browser (the playwright recipe in memory), then drills A,
B and C. Each step's output goes into a new dated `## Executed on UAT — 2026-09-…` section of
`lab-go-live.md`, and the runbook's known defects are corrected in the same PR (D10): the status
line, §1.1's migration number, §5 rewritten as "done by `seed:lab` on every deploy; verify with
`standup:check lab`", the duplicate §11 renumbered. **The mutant is the runbook itself:** a step that
cannot be performed as written is recorded as a defect and fixed in the runbook or the code, never
narrated around. **What this task must not do:** create a user by seed, put a credential in git,
or touch `hmis-prod-*`.

### T7 — ROUTINE · The catch-up deploy runbook for production — written in week 1, run by the owner (D11)
`docs/runbooks/catch-up-deploy-2026-09.md`, the ordered acts for the owner, each with its check:
(0) **the tip**: the deploy is cut from a `main` tip that includes 18a-iii T4 (#108 — until it merges, `recordAcquired` writes an AERB dose row for an outside study on an ionising type) and every close-review fix the lanes have flagged as "must not deploy without"; the runbook names the SHA, and the rule that generalises it — a lane that finds a must-not-deploy-without puts a `deploy-blocker` label on the fixing PR; no deploy takes a tip while one is open (roadmap §0 row 10); (1) the owner's applied-count query, expected 56, watermark `0055`; (2) the most recent weekly
restore-drill log read and its date recorded (`/opt/hmis-prod/drill/`, 11c D11) — a deploy onto a
database whose backups have not been proven to restore is the one thing this runbook refuses;
(2b) 18c's §0 rehearsal on the AERB demo bench that exists (`/opt/hmis-aerb-demo`): migrate without a
licence, start a CT, read `device_not_licensed`, run `file-demo.sh`, watch `GET /aerb/licences/gaps`
empty — recorded, not narrated; (3) `standup:check all` on production
**before** (read-only, through `compose run --rm api`, exactly as the seeds run) — the RED rows are
the to-do list, not blockers; (4) the **18c window**: declare `degraded` from `/ops/mode` with a
note naming radiology, deploy, then file every ionising machine's licence from the certificates at
`/radiology/radiation-safety` until `GET /aerb/licences/gaps` is empty, then `normal` — target under
one hour, and the window is the ledger's own record; if the owner does not yet hold the
certificates, the ionising devices stay refused after the window and that is recorded as a RED
census row, not a blocker, because radiology is not open; (5) the three deleted routes announced to
anyone who bookmarked them; (6) `standup:check all` **after** — the lab's G2 rows must have gone
green by the deploy alone; (7) close PR #73 as superseded; (8) the post-deploy edge gate the script
already runs. **Mutants** (for a runbook, the mutant is a reader): a step whose check the owner
cannot perform from his own session; a step that requires a lane to hold a production credential;
a step written as "should" rather than as a command and an expected line.

## 5. Verify

```
pnpm typecheck && pnpm lint
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run pharmacy \
  pnpm --filter @hmis/core exec jest -w 2 test/deploy-parity.test.ts test/seed-roles.test.ts \
    test/standup-check.test.ts test/migrate-watermark.test.ts src/modules/lab/definitions
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run pharmacy \
  bash -c 'HMIS_TARGET=uat HMIS_DEPLOY_DIR=/opt/hmis-uat bash docker/prod/deploy.sh'
```
Full core belongs to CI. The UAT deploy is run through the mutex like a suite. **Nothing in this
phase runs against `hmis-prod-*`**; T7 is a document, and its execution is the owner's.

**Every task's test must fail first against the code it guards**, and the mutant is named in the
task. For T6 and T7 the "test" is the execution and the reader; a runbook step that was never
performed is a green test that was never run.

## 6. Out of scope — named so nobody infers them

- **A production deploy.** The classifier blocks it and CLAUDE.md forbids it; T7 writes the runbook
  and the owner runs it.
- **The nesting sites and the pool values.** 11j. The two values are decided in the roadmap (Q6)
  and land as their own one-file PR before this phase starts, because UAT under a docker build and
  four lanes is exactly where an unbounded `connect()` hang would first be seen and misread.
- **Retrofitting 18c to deploy-dark.** D4's exception; its guard is kept as designed.
- **A UAT on a second server.** D1; the owner's money. Everything here is target-parameterised so
  that a second box is a `DEPLOY_DIR` and an IP, not a rewrite.
- **The lab's real catalogue, the LAB department on production, the four humans, the second
  administrator.** G3–G4 on production are the owner's and the pathologist's acts; the census names
  them, this phase does not perform them.
- **Automatic production deploys, feature flags per module, a "release train" tool.** D8: UAT is
  continuous, production is a hand and a week.
- **Pharmacy and radiology opening on UAT.** Their runbooks exist and T2 gives them a census; their
  execution is the commissioning lane's next work (roadmap §2 weeks 4–9), not this phase's.
- **`validate:config`, the CA signature, the tariff.** G7 is hospital-wide and O6.
- **Deleting `/opt/hmis-preview` and `/opt/hmis-aerb-demo`.** T3 stops their containers and says
  so; the directories hold the owner's demo password and are his to remove.

## 7. Owner rulings

**None are needed to execute 11i.** **One fact, not a ruling, sets the order (D11):** whether any
real patient exists on production. Assumed not; if yes, T3/T5/T6 precede the deploy. D1 (UAT on this box), D2 (Class C by deploy), D4 (deploy-dark),
D5 (the door), D8 (cadence) are standard-hospital operability calls, marked DECIDED per CLAUDE.md.

**One money item shapes D1 without blocking it:** a second server (roadmap §6.1). If the owner
buys one, T3's `DEPLOY_DIR` and the Caddy IP change and nothing else does.

**Three acts of his are named by the census and dated by the roadmap**, so a slip is visible: the
second administrator (week 3), the lab catalogue spreadsheet (week 3), the AERB certificates
(week 7). The phase does not wait on any of them — UAT runs on the golden catalogue and `DEMO`
certificates behind the door.

## 8. CLOSE — filled at execution
