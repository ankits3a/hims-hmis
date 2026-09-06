# Phase 11i — The stand-up path: UAT, the readiness census, and the laboratory opening first

**Lane: LIGHT** (9 tasks + the 11j pool PR, no new module, **no migration** — EXECUTE-METHOD-V3 §2).
**Stop-loss: 2,520,000** = main-session `9 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145, the repair term).
**Lane:** `tools/lane.sh new commissioning` (its own worktree and test DBs), task branches stacked from `origin/main` — this lane becomes the commissioning lane (roadmap §0b.2), and the lane that builds UAT is the lane that runs it. The LIMS lane takes 17-E T7 in parallel. **One task = one PR**: commit by pathspec, push, `gh pr create`; CI is the gate; locally only the touched suites, always through `test-lock.sh`. Docker builds go through the same mutex — a build is a builder.

**Status: AUTHORED 2026-09-06; REVISED the same day by a second session (execution order D11, the lane, the restore drill in T7); THIRD READING the same evening by a Fable session against `f211075` (D12 — the rehearsal on the restored copy; D13 — the backout; T8; §2 rows 10, 11, 14, 17 re-measured); **§2b (the Indian day, 24 rows) and T9 added the same evening on the owner's instruction to prepare the lane for execution. EXECUTION AUTHORISED BY THE OWNER IN HIS OWN SESSION 2026-09-06 (handoff: `2026-09-06-HANDOFF-commissioning-lane-11i.md`); the production deploy in T7 remains his hand. NOT STARTED.** Proposed by `2026-09-06-ROADMAP-v2.md` §7 as the first phase of the commissioning track. **Author it; do not execute it** was the brief's instruction to the session that wrote this.

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

## 2. Ground truth — measured 2026-09-06 at `origin/main` `3b35179`, re-measured at `78f5947`, third reading at `f211075` (deployed base `c11833d`)

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
| 10 | what runs on the box today | `hmis-prod-*` (9 containers, db limit 4 GB), `hmis-preview-caddy` (`:8443`, API from `/opt/hmis`'s build on `:3000`), `hmis-aerb-demo-caddy` (`:8444`, API `:3020`, DB `hmis_aerb_demo`), `hmis-db-1` (the lanes' Postgres). **15 GB total; 9.3 GB used with 5 GB of swap at the first reading, 7 GB used / 7 GB available at the second** — a moment either way; the demos retire regardless. A weekly `restore-drill.sh` host cron and its watcher rule are installed by `deploy.sh` step 7 (11c D11); its log had never been read by a runbook. **Third reading read it** (`/opt/hmis-prod/log/restore-drill.log`, a host file): the drill ran 2026-09-05 22:00 UTC and **PASSED** — full backup 33 s, restore 3 s, 498 events and 56 migrations restored and read back out of the scratch cluster. Its step 5 runs **the application's migrator from `hmis-prod/server:latest`** against the restored copy, and its two count assertions are `>=` (`restore-drill.sh:340,342`), so a candidate image that applies the pending journal passes them as the script stands. The image is a single env override (`HMIS_DRILL_SERVER_IMAGE`, line 49) | `docker ps`, `free -h`, `board.sh`, `deploy.sh:637`, `restore-drill.sh:49,317–343` | **T3 replaces the two demos; T7 reads the drill log; T8 makes the drill the rehearsal (D12)** |
| 11 | the migrator's skip rule | drizzle-orm 0.40.1 applies entries whose folder millis are **greater than** the single latest `created_at`; `hash` is written and never read. `main`'s journal is strictly monotonic (78 entries at `f211075`, checked three times); production's watermark is `0055`'s `when = 1788351286473`; 22 pending (`0056`–`0077`) | `scripts/migrate.ts`; `drizzle/meta/_journal.json` | **T4** |
| 12 | the lab runbook | 320 lines, in the deployed base. §0 role keys · §1 preconditions (1.3: a second administrator) · §2 `LAB` department + pathologist of record · §3 grants · §4 catalogue via `POST /lab/catalogue/*`, every orderable priced · §5 definitions + approval type · §9 pilot harvest · §10 drills A–C · §11 five-seat walk-through. **Status line says NOT DEPLOYED; the lab is deployed since `0046`.** Two sections are numbered 11 | `docs/runbooks/lab-go-live.md` | **T6 executes and corrects it** |
| 13 | the other three runbooks | pharmacy (119 lines; `seed-pharmacy` already establishes G2), radiation safety (303; **§0: ionising acquisition refuses `device_not_licensed` from the moment `0060`–`0065` land, and T6's filing screen ships in the same deploy**), PACS (140; bridge account + AE titles). None in the deployed base | `docs/runbooks/*` | **T2 reads them; T7 sequences 18c** |
| 14 | what production changes on the catch-up | +`pharmacy`, +`aerb` (never deployed); +6 routes (`/appointment`, `/counter/figures`, `/lab/reports`, `/pharmacy/counter`, `/pharmacy/items`, `/radiology/radiation-safety`); **−3 routes production serves today** (`/counter/seat`, `/counter/seat/figures`, `/opd/vitals/bay` — the last is a rename to `/opd/vitals`, so the diff is +7/−3); 22 migrations (`0056`–`0077`, `0077` being #108's outside-study register, merged 06:35 UTC); 79 commits | `git show c11833d:apps/web/src/router.tsx` vs `origin/main` | **T7** |
| 15 | the operating mode | `OPERATING_MODES = commissioning · ramp · normal · degraded · downtime`; `commissioning` is initial-only; the exit needs `validate:config` ok within 24 h (CA signature + active tariff). **No module reads the mode** — `getOperatingMode` has no caller outside `kernel/ops` | `kernel/ops/mode.ts:114`, `scripts/validate-config.ts` | **D7 — "open" is not the mode** |
| 16 | the pool | `new Pool({ connectionString: url })` — no `max`, no `connectionTimeoutMillis` | `kernel/db/client.ts:9` | **not this phase** — 11j step 1–2, one PR, decided in the roadmap Q6 |
| 17 | a way back from a bad deploy | **none.** `deploy.sh` tags the three images `:latest` only (`deploy.sh:63–65,183–187`) and **refuses to build unless `HEAD` equals `origin/main`** (`deploy.sh:59`). So the previous image is overwritten at build time, and a rebuild from the deployed base is refused by the script itself — which is why PR #73 exists as a branch that can never merge. Migrations are additive (CLAUDE.md), so old code on the new schema is the supported backout — but nothing can run it | `docker/prod/deploy.sh` | **T8 (D13)** |

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


## 2b. The Indian day the stand-up path must survive — 24 rows, each with its artefact

Measured against `f211075` on 2026-09-06. The third column says what the code models **today**;
the fourth is what this phase does about it, and where. A row the schema does not hold is answered
by the census's third verdict, **NOT MODELLED**, which prints the runbook section a human performs
instead — never silently green. `deploy-parity`'s shape applies: every NOT MODELLED row must name a
runbook section that exists, and the test pins it.

| # | the day | modelled today | 11i answer | task |
|---|---|---|---|---|
| 1 | A patient with one name, no surname; a name as spoken vs as on the ID; no mobile; one family mobile shared by five UHIDs | FD-25's registration (`0067`, 13 demographic columns) — accepts it or not, **untested by any census** | T6's seat-1 walk-through registers **three** patients on UAT: single-name, no-mobile, family-shared mobile; a refusal is a defect logged against FD-25, never worked around | T6 |
| 2 | The back-book: the hospital's existing paper patients arriving with an old file number | `patients.legacy_uhid` (D-43) exists | the runbook's §2 gains one line: the desk keys the paper number into the legacy field; the bulk loader for the back-book is **11k**, not this phase | T6 (runbook) |
| 3 | `0057` moves the UHID sequence to 11001 behind a guard on the sequence's current value — the first patient after the deploy gets a number from a different series | data-dependent migration | the rehearsal on the restored copy shows which branch runs (D12); the runbook announces the new series to the desk | T7 (2a), (5) |
| 4 | Duplicates minted during the paper-parallel pilot | `patient_merge` approval type, registered by `seed-patients` since 2026-08-26 | census G2 row: `patient_merge` registered; the runbook's §9 harvest gains "merges per day" | T2, T6 |
| 5 | A lab walk-in with an outside doctor's slip, or a self-request with no slip at all (routine in India) | the `V` visit under the pathologist of record (DD15 / S2) | census G3 row: `LAB` department active with a doctor of record whose `registration_no` is set | T2 |
| 6 | A potassium of 6.8 at 02:00 — whom does the bench ring? | `lab_critical_calls` records the call; **`opd_doctors` has no phone column** — the number is not in the system | census prints **NOT MODELLED → runbook §10 drill A**: a printed call list at the bench, refreshed weekly, is the artefact; the census does not pretend | T2, T6 |
| 7 | "Report is ready" on WhatsApp / SMS — the notice every Indian lab is asked for | `kernel/notify` has **console adapters only**; no provider, no TRAI DLT sender-id and template registration, no WABA template — all owner acts | census **NOT MODELLED → runbook §11**: no patient message leaves the building; T6 asserts the notice row is *queued and not sent* | T2, T6 |
| 8 | NABL asks where every reference range came from | the catalogue loader carries `source` per band (runbook §4.3) | census G3 row: every active analyte's bands carry a non-empty `source`, read through the catalogue loader | T2 |
| 9 | Lab services are GST-exempt; pharmacy items are not; the seeded slabs are `DEV PLACEHOLDER` until a CA signs | `seed-tariff` exempt categories with placeholders; `validate:config` is the CA gate (O6) | census G3 row: every lab orderable's tariff item sits in an **exempt** category; G7 is delegated to `validate:config`, never re-implemented | T2 |
| 10 | Going live in September: the invoice and receipt series are mid-financial-year | `nextDocNo` with IST FY roll (`series.test.ts`) — modelled | runbook step (6): the next invoice number read before and after the deploy, unchanged | T7 |
| 11 | A relative pays ₹2,10,000 in cash for a package | §269ST as CA-gated data (`billing/cash-law.ts`) — modelled | census G2 row: the cash-law config row present | T2 |
| 12 | DPDP: consent at the desk; a minor with a guardian | promotional consent + guardian `consent_note` at registration — modelled | T6 seat 1 registers one minor with a guardian; the consent text on the screen is the hospital's, read aloud once | T6 |
| 13 | The lab counter takes money: a cashier session must be open; the drawer closes at night | drawer sessions (`0055`), `cashier` role | census G4 row: `cashier` held; runbook §11 step 1 gains "open the session first" | T2, T6 |
| 14 | Label printer, A4 report printer, the receipt printer — three devices at three seats | `print_jobs` (`0069`) for server-side printing (ruled 2026-09-04); label printing is browser-driven today; **no destination registry** | census **NOT MODELLED → runbook §6**: one test print per device per seat recorded in T6's `## Executed` | T2, T6 |
| 15 | The label printer dies mid-morning | downtime kit (`label_source = 'downtime_kit'`), drill C | T6 runs drill C as written | T6 |
| 16 | The hospital's internet drops for fifteen minutes with a patient at the desk (the server is remote) | 11c's downtime kit and mode; nothing rehearses it at a seat | **drill D** added to the runbook: pull the desk PC's network mid-registration, wait, reconnect, finish — record what the screen did | T6 |
| 17 | Clocks: containers in UTC, the hospital in IST, the D9 flake at midnight | `Asia/Kolkata` in six kernel/module files — modelled | census G1 row: the API's reported IST offset is +05:30; T3 gives UAT the same `TZ` as production | T2, T3 |
| 18 | Drill A needs night mode (21:00–07:00 IST) | derived from the IST clock, no per-deployment switch (runbook §7) | **DECIDED: no fake clock.** T6 runs drill A after 21:00 IST or records it as *not performed*, dated | T6 |
| 19 | Four role keys, four humans — not one login passed around | DD11 refuses a self-verify; nothing detects shared logins | runbook §0 gains the sentence; T6 creates four accounts at `/admin/users` on UAT | T6 |
| 20 | The pathologist's NMC number prints on every report; the RSO's AERB approval; the pharmacist's council number | `opd_doctors.registration_no`; `aerb_persons`; the pharmacist's number **not modelled** | census G3 rows for the first two; the third is NOT MODELLED → pharmacy runbook §1.4 | T2 |
| 21 | Staff who read Hindi better than English | `hi.json` exists for the shell and the front desk | T6 runs one seat in Hindi and records any untranslated string as a defect | T6 |
| 22 | A receptionist registers a real patient on UAT because both tabs look the same | nothing distinguishes the two | T3: `HMIS_ENVIRONMENT_LABEL=UAT` in the API env, exposed on the existing public config endpoint, rendered by the shell as a fixed coloured banner and a different favicon; production's env never sets it; `deploy-parity` pins the absence | T3 |
| 23 | UAT is seen by trainees, vendors, the owner's phone — it must never hold a real person | D1/D5; the drill's restore is destroyed on every exit path | **DECIDED: UAT never restores a production backup** (DPDP); a `uat-reset.sh` drops and re-seeds UAT so each training day starts clean | T3 |
| 24 | Deploy day: bookmarks on the desk PCs point at `/counter/seat`; the SPA is cached | no redirects on `main` | T9: the three deleted paths redirect to their successors for one release; runbook step (5) says "hard refresh, then check the bookmark lands" | T9, T7 |

Three things the table does not do: it does not add a migration (no row needs one); it does not
model the notification provider, the doctor's phone or the printer registry — each is named as a
human artefact until the phase that owns it (22, 20, the printing phase); and it does not build
the back-book or catalogue loaders (11k).

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
- **D11 — EXECUTION ORDER: T1, T4, T2, T8 and 11j's two pool values land first; T7's runbook is written,
  its 18c rehearsal performed on the existing AERB bench and its migration rehearsal performed on the
  restore drill (D12); the owner deploys production; only then T3, T5, T6.** Production has never left `commissioning`, no department has opened on it, and
  the batch's one behaviour-changing step (18c's licence gate) already has a bench on `:8444`. UAT
  is for the pilots (G5), not a gate on a deploy into an empty hospital, and every week it gates
  adds two or three migrations to the batch (roadmap §0b.1). The one fact that reverses this — a real
  patient on production — is the owner's to state; under D12 it changes the *announcement and the window*, not the order —
  the rehearsal runs against production's own data either way.
- **D12 — THE MIGRATION REHEARSAL IS THE RESTORE DRILL POINTED AT THE CANDIDATE IMAGE, not UAT and
  not a synthetic database.** The drill (§2 #10) already restores last night's production backup into
  a scratch container, boots a second postmaster on it, runs the application's migrator from a named
  server image, reads the census back out of the restored data, and destroys the container on every
  exit path. With `HMIS_DRILL_SERVER_IMAGE` set to an image built from the catch-up tip, that is the
  22 pending migrations applied to a faithful copy of production — real data shape, real watermark,
  real journal, real image — in minutes, with nothing touched that production serves. UAT rehearses
  *people* (G5); the drill rehearses *the migration*. The first draft wanted UAT for this and the
  second dropped it; both missed that the rehearsal was installed on 2 September. Three things the
  drill does not do today and T8 adds: run the seeds and `check-config-present` after the migrator
  (a deploy is migrations *and* the rows its modules throw without); assert the restored migration
  count **equal** to the candidate's journal length (the `>=` that lets a rehearsal pass also lets a
  half-applied one pass); and label or withhold the `backup.drill_passed` event it appends to the
  LIVE event log (`restore-drill.sh:135`, the T5 seam) so a rehearsal never reads as a drill on the
  dashboard. The drill takes a real incremental backup first (its step 2); that is a feature.
- **D13 — A DEPLOY WITHOUT A BACKOUT IS NOT A DEPLOY RUNBOOK.** `deploy.sh` also tags each image
  with the short SHA it was built from (`hmis-prod/server:<sha>` beside `:latest`), and gains a
  `HMIS_DEPLOY_ROLLBACK_TO=<sha>` path that retags and restarts api/worker/caddy from an existing
  image **without building and without migrating**. The backout for the catch-up deploy is therefore
  the image built from `c11833d`, running on the migrated schema, which additive migrations permit
  by rule. The one thing a backout cannot undo is data written by the new code in the window — the
  runbook says so and names the window (T7 step 4). `deploy.sh:59`'s `HEAD == origin/main` refusal
  stays for the *build* path; the rollback path never builds. Before the catch-up deploy, T8 tags the
  currently running images `<c11833d>` by hand (a `docker tag` of what is already on the daemon), so
  the first deploy under this rule already has somewhere to go back to.

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
`opd_config`, ≥1 active doctor in ≥1 department, `cashier` and `front_office` held. **§2b rows 4–9, 11, 13, 17, 20 join the table** (the cash-law row, `patient_merge`, the doctor of record's
`registration_no`, band sources, exempt tariff category, `cashier` held, the IST offset, the RSO). Every check goes
through a module `index.ts` export or a kernel loader — never a raw select. Output: one line per
row, `ok`/`RED`/`NOT MODELLED` + `fix`; exit code = any RED. **A NOT MODELLED row carries the runbook
section a human performs** (§2b rows 6, 7, 14, 20) and the test pins that the section exists in the
named runbook; a fact the schema does not hold is never printed green. `deploy.sh` runs `standup:check all` after the gate,
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
in it — it is not, it lives in `/opt/hmis-preview`). **The environment banner** (§2b row 22): `HMIS_ENVIRONMENT_LABEL` read by the API and returned on
the existing public config route; the web shell renders a fixed banner and swaps the favicon when it
is set; `docker-compose.uat.yml` sets `TZ` identically to production (§2b row 17). **`uat-reset.sh`**
(§2b row 23): drops the UAT database, re-runs the migrate + seed half of the deploy and the two
synthetic seeds behind the door — refuses when `PROJECT` is `hmis-prod`. **UAT never restores a
production backup**, and `deploy-parity` pins that the UAT compose mounts no pgBackRest volume.
`deploy-parity.test.ts` learns the target: the
prod census unchanged; a UAT census asserting that with `HMIS_TARGET=uat` the script's effective
text references **no** `hmis-prod` project, image, directory or cron path (the caddyfile-parity
shape: grep the rendered script). **Mutants:** UAT writing `/etc/cron.d/hmis-prod-backup`; UAT
building `hmis-prod/server:latest`; the banner rendered with the label unset; `uat-reset.sh` running
with `PROJECT=hmis-prod`; UAT's compose sharing prod's network or volume names; the prod
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
B, C and **D** (§2b row 16). **The walk-through carries §2b's people**: three registrations (single
name, no mobile, a family-shared mobile), one minor with a guardian and the consent read aloud, one
seat run in Hindi, one test print per device per seat, the report-ready notice found *queued and
not sent*, and four accounts for four humans (§2b rows 1, 12, 14, 19, 21, 7). Drill A runs after
21:00 IST or is recorded as not performed (§2b row 18). Each step's output goes into a new dated `## Executed on UAT — 2026-09-…` section of
`lab-go-live.md`, and the runbook's known defects are corrected in the same PR (D10): the status
line, §1.1's migration number, §5 rewritten as "done by `seed:lab` on every deploy; verify with
`standup:check lab`", the duplicate §11 renumbered. **The mutant is the runbook itself:** a step that
cannot be performed as written is recorded as a defect and fixed in the runbook or the code, never
narrated around. **What this task must not do:** create a user by seed, put a credential in git,
or touch `hmis-prod-*`.

### T7 — ROUTINE · The catch-up deploy runbook for production — written in week 1, run by the owner (D11)
`docs/runbooks/catch-up-deploy-2026-09.md`, the ordered acts for the owner, each with its check:
(0) **the tip**: the deploy is cut from a `main` tip that includes 18a-iii T4 (#108, **merged 2026-09-06 06:35 UTC as `0077`** — so any tip at or after `f211075` satisfies this; until it merged, `recordAcquired` wrote an AERB dose row for an outside study on an ionising type) and every close-review fix the lanes have flagged as "must not deploy without" (the third reading's census of those is roadmap §0c); the runbook names the SHA, and the rule that generalises it — a lane that finds a must-not-deploy-without puts a `deploy-blocker` label on the fixing PR; no deploy takes a tip while one is open (roadmap §0 row 10); (0c) **the env diff**: the keys in `docker/prod/.env.prod.example` at the tip against the deployed
base, printed — none today (`f211075` vs `c11833d`), and the step exists so that the first tip
that adds one is not the first deploy that forgets it; (0d) `gh label create deploy-blocker` if it
does not exist (measured absent 2026-09-06); (1) the owner's applied-count query, expected 56, watermark `0055`; (2) the most recent weekly
restore-drill log read and its date recorded (`/opt/hmis-prod/log/restore-drill.log`, 11c D11;
last PASSED 2026-09-05 22:00 UTC, 498 events, 56 migrations) — a deploy onto a database whose
backups have not been proven to restore is the one thing this runbook refuses; **(2a) the migration
rehearsal (D12, T8)**: build the candidate images from the named SHA into `hmis-prod/server:<sha>`
(the build half of `deploy.sh`, no migrate, no restart), then run the drill with
`HMIS_DRILL_SERVER_IMAGE=hmis-prod/server:<sha> HMIS_DRILL_REHEARSAL=1` — expected transcript:
`migrations applied`, restored migrations **= 78** (the candidate's journal length, not `>= 56`), the
seeds and `check-config-present` green against the restored copy, `standup:check all` printed from
the restored copy (its RED rows are a preview of step 3), the scratch container destroyed; a
rehearsal that fails stops the runbook here and the failing migration is the lane's to fix on
`main`, never by hand on production; **(2b) the backout tag**: `docker tag hmis-prod/server:latest
hmis-prod/server:c11833d` (and web, db) before anything is rebuilt, and the runbook records that
`HMIS_DEPLOY_ROLLBACK_TO=c11833d` is the way back — old code on the new schema, additive by rule;
(2c) 18c's §0 rehearsal on the AERB demo bench that exists (`/opt/hmis-aerb-demo`): migrate without a
licence, start a CT, read `device_not_licensed`, run `file-demo.sh`, watch `GET /aerb/licences/gaps`
empty — recorded, not narrated; (3) `standup:check all` on production
**before** (read-only, through `compose run --rm api`, exactly as the seeds run) — the RED rows are
the to-do list, not blockers; (4) the **18c window**: declare `degraded` from `/ops/mode` with a
note naming radiology, deploy, then file every ionising machine's licence from the certificates at
`/radiology/radiation-safety` until `GET /aerb/licences/gaps` is empty, then `normal` — target under
one hour, and the window is the ledger's own record; if the owner does not yet hold the
certificates, the ionising devices stay refused after the window and that is recorded as a RED
census row, not a blocker, because radiology is not open; (5) the three deleted routes announced to
anyone who bookmarked them, with T9's redirects in the tip and "hard refresh, then follow the
bookmark" as the check (§2b row 24), and the new UHID series announced to the desk (§2b row 3);
(6) `standup:check all` **after** — the lab's G2 rows must have gone
green by the deploy alone; the `gst_config` row count and `updated_at` unchanged (a seed must never
touch a CA-signed row); the next invoice number unchanged (§2b row 10); (7) close PR #73 as superseded; (8) the post-deploy edge gate the script
already runs; (9) **the backout, written as a command and an expected line even if never run**:
`HMIS_DEPLOY_ROLLBACK_TO=c11833d bash docker/prod/deploy.sh` retags and restarts without building
or migrating; the edge gate runs again; what it cannot undo is any row the new code wrote inside the
window, and the runbook says which tables those could be (the 18c licence rows filed in step 4, any
`print_jobs`, any pharmacy row — none of which exist until a human acts). **Mutants** (for a runbook, the mutant is a reader): a step whose check the owner
cannot perform from his own session; a step that requires a lane to hold a production credential;
a step written as "should" rather than as a command and an expected line.

### T8 — ROUTINE · The rehearsal mode of the restore drill, and the backout tag (D12, D13)
`docker/prod/drill/restore-drill.sh` gains `HMIS_DRILL_REHEARSAL=1`: after the migrator (step 5) it
runs the same seed list and `check-config-present` that `deploy.sh` step 5 runs, from the same image,
against the scratch cluster, then `standup:check all` (T2) and prints it; step 6's migration assertion
becomes **equality** with the candidate image's journal length (read from the image, not typed); the
T5-seam event is appended as `backup.drill_rehearsed` — a new kind beside `drill_passed`/`drill_failed`
in `kernel/retention/events.ts`, so the Grafana rule that watches for a missed drill does not count
a rehearsal as one and a failed rehearsal never pages as a failed backup. `deploy.sh` tags every
image `<name>:<short-sha>` beside `:latest`, and `HMIS_DEPLOY_ROLLBACK_TO=<sha>` skips steps 1, 4 and
5 entirely, retags `:latest` from `<sha>`, restarts api/worker/caddy and runs the step-8 edge gate.
The drill is rehearsed the way it was built to be (`HMIS_DRILL_REPO_PATH` at a scratch prefix, a
throwaway stanza) — never against the production repository from a lane. Before overwriting the deploy directory's configs (step 2), `deploy.sh` copies the previous
`docker-compose.prod.yml`, `caddy/Caddyfile` and `prometheus/` into `<deploy_dir>/previous/`, and
the rollback path restores them with the images — a retag with the new Caddyfile is half a
rollback. SHA-tagged images are pruned to the last three per name. The drill's Saturday hour is
outside the lanes' test mutex by design (production must not depend on lane tooling); the UAT
deploy avoids 22:00–23:00 UTC Saturday and the runbook says so. `deploy-parity.test.ts`
pins: the rollback path contains no `docker build` and no `migrate`; the tag list; the new event
kind registered; the config snapshot taken before the copy. **Mutants:** the rehearsal asserting `>=` (a half-applied journal passes); the
rehearsal appending `drill_passed`; the rollback path reaching `migrate`; a `:latest` retag without
the `<sha>` image existing (must refuse by name, not fail inside compose).

### T9 — ROUTINE · The three deleted paths redirect for one release (§2b row 24)
`apps/web/src/router.tsx` (a shared file — coordinate, smallest possible diff): `/counter/seat` and
`/counter/seat/figures` redirect to `/counter` and `/counter/figures`; `/opd/vitals/bay` to
`/opd/vitals`. Each is a `redirect` in a `beforeLoad`, no screen, no locale key. The router test
asserts each old path lands on its successor with the query string preserved; `caddyfile-parity`'s
pinned route count is read before and after and the commit message states both numbers. Removed in
the release after the lab's G6 closes. **Mutants:** a redirect that drops the query string; an old
path that renders a blank screen instead of redirecting.

## 5. Verify

```
pnpm typecheck && pnpm lint
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run pharmacy \
  pnpm --filter @hmis/core exec jest -w 2 test/deploy-parity.test.ts test/seed-roles.test.ts \
    test/standup-check.test.ts test/migrate-watermark.test.ts test/caddyfile-parity.test.ts src/modules/lab/definitions
pnpm --filter @hmis/web exec vitest run src/router
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run pharmacy \
  bash -c 'HMIS_DEPLOY_DIR=/opt/hmis-uat HMIS_DRILL_STANZA=rehearsal HMIS_DRILL_REPO_PATH=/hmis-rehearsal \
           HMIS_DRILL_SERVER_IMAGE=hmis-uat/server:latest HMIS_DRILL_REHEARSAL=1 bash docker/prod/drill/restore-drill.sh'
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
- **The back-book and catalogue loaders** (§2b rows 2, 8): **11k**, the commissioning lane's next
  phase — per-file scripts for the owner's spreadsheets with a row-by-row rejection report and a
  dry run, never a generic import surface.
- **A notification provider, DLT registration, WABA templates, a doctor phone book, a printer
  registry** (§2b rows 6, 7, 14): named as human artefacts in the runbooks until Plans 22, 20 and
  the printing phase own them.
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

**None are needed to execute 11i.** **One fact, not a ruling, used to set the order (D11) and now sets
the announcement (D12):** whether any real patient exists on production. The evidence the third
reading could read without touching a container — 498 events in production's entire event log at
2026-09-05 22:00 UTC, restored and counted by the drill — says a hospital that has not registered
anyone in earnest; the owner's one-line confirmation is still asked for. If real patients exist, the
rehearsal (2a) is the same, the three deleted front-desk routes are announced to the people who use
them, and the window is declared at a quiet hour; the order does not change. D1 (UAT on this box), D2 (Class C by deploy), D4 (deploy-dark),
D5 (the door), D8 (cadence) are standard-hospital operability calls, marked DECIDED per CLAUDE.md.

**One money item shapes D1 without blocking it:** a second server (roadmap §6.1). If the owner
buys one, T3's `DEPLOY_DIR` and the Caddy IP change and nothing else does.

**Three acts of his are named by the census and dated by the roadmap**, so a slip is visible: the
second administrator (week 3), the lab catalogue spreadsheet (week 3), the AERB certificates
(week 7). The phase does not wait on any of them — UAT runs on the golden catalogue and `DEMO`
certificates behind the door.

## 8. CLOSE — filled at execution
