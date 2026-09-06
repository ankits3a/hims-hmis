# HANDOFF — the commissioning lane: execute Phase 11i, the stand-up path

**Written 2026-09-06 by the planning session that authored `2026-09-06-ROADMAP-v2.md` and
`plans/2026-09-06-phase1-11i-the-stand-up-path.md` (both on `docs/roadmap-brainstorm-brief` @ `680183b`).
For the session that will EXECUTE 11i. Read this file, then the two documents it names, then
`CLAUDE.md`. Nothing else until a task names it.**

**Status of the plan: AUTHORED, REVISED (second reading), NOT APPROVED.** The owner's one line
("execute 11i") is the gate. Until it is given, §3 step 0 is the only thing you do.

---

## THE PROMPT TO START WITH

> You are the commissioning lane for the HMIS project — the lane that turns merged code into a
> department the hospital can open. Your phase is **11i, the stand-up path**:
> `docs/superpowers/plans/2026-09-06-phase1-11i-the-stand-up-path.md`. Read
> `docs/superpowers/2026-09-06-HANDOFF-commissioning-lane-11i.md` first (this file), then the phase
> doc, then `docs/superpowers/2026-09-06-ROADMAP-v2.md` §0–§3 (for the why), then `CLAUDE.md`.
> Do not read `EXECUTION-LESSONS.md`, the plan index, or the 22 department documents.
>
> Work in the pharmacy lane's worktree: `cd /opt/hmis-lanes/pharmacy/hmis`, cut
> `lane/commissioning-11i` fresh from `origin/main`. Announce yourself:
> `/opt/hmis-lanes/.orchestrator/bin/lane-report.sh pharmacy WORKING "commissioning lane: 11i"`.
> Two standing rules: **never run jest, vitest or a docker build directly** — always
> `/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run pharmacy <cmd>`; and **never merge to `main`
> yourself** — the orchestrator (`hmis-lanes-a2`) drives the train. **Never touch `hmis-prod-*`
> containers or the production database, and never run `deploy.sh` against production** — the
> owner does that, from your runbook.
>
> Execution order is 11i **D11**: T1, T4, T2, then the two pool values (11j steps 1–2), then T7's
> runbook and its rehearsal on the AERB bench; then you hand the owner the runbook and he deploys.
> Only then T3, T5, T6. §3 below is the step list; §4 is the edge catalogue — **every row names the
> task that must answer it and the form the answer takes (a test, a mutant, a census row or a
> runbook step). A row is closed when that artefact exists, not when you have read it.**
>
> Per CLAUDE.md, only money, procurement and law go to the owner; everything else you decide,
> mark DECIDED in the phase doc's §3, and keep going. §5 lists what is already decided so you do
> not re-open it. A peer session cannot approve anything for the owner.

---

## 1. Where things stand — measured, dated, and it goes stale by the hour

| fact | value at 2026-09-06 ~06:30 UTC | re-measure with |
|---|---|---|
| `origin/main` | `78f5947`, 77 migrations (`0000`–`0076`) | `git fetch origin && git rev-parse --short origin/main` |
| deployed base | `c11833d`, 56 migrations applied (owner's query 2026-09-05, reconciled to `0055`) | `cat /opt/hmis-lanes/.orchestrator/state/deployed-base.txt`; the count is the OWNER's query |
| pending on production | 21 migrations, 78 commits, two never-deployed modules (`pharmacy`, `aerb`), 6 routes added, 3 routes deleted | roadmap §0 rows 1, 14 |
| open PRs | #108 (18a-iii T4, **must be in the catch-up tip**), #110 (18a-iii T5), #73 (hotfix, closes as superseded after the deploy) | `gh pr list --state open` |
| lanes | front-desk WORKING · lims parked on a docs branch (takes 17-E T7) · pharmacy parked on `docs/roadmap-brief-pr` (becomes you) · radiology on 18a-iii T5 | `/opt/hmis-lanes/.orchestrator/bin/board.sh` |
| the box | 15 GB; 7–9 GB used, 5 GB of swap in use; `hmis-prod-*` (9 containers), `hmis-preview-caddy` (:8443, `tls internal` + basic auth), `hmis-aerb-demo-caddy` (:8444, API :3020, DB `hmis_aerb_demo`), `hmis-db-1` | `free -h`, `docker ps` |
| restore drill | `/opt/hmis-prod/drill/restore-drill.sh`; log `/opt/hmis-prod/log/restore-drill.log` last written 2026-09-05 22:00 | `ls -la /opt/hmis-prod/log/` (read-only) |
| the migrator | drizzle-orm 0.40.1; `pg-core/dialect.js:60` runs the apply loop inside `session.transaction` — **measure at T4 whether that is one transaction per migration or one for the batch**; the watermark rule is "folder millis strictly greater than the latest applied `created_at`", `hash` never read | `node_modules/.pnpm/drizzle-orm@0.40.1*/node_modules/drizzle-orm/pg-core/dialect.js` |
| `deploy.sh` pre-flight | refuses a dirty tree except `?? docs/`; `HMIS_DEPLOY_ALLOW_DIRTY=1` overrides "for a rehearsal only"; `PROJECT="hmis-prod"` fixed; `HMIS_DEPLOY_DIR` env-overridable | `docker/prod/deploy.sh:44–72` |
| the 11i doc's ground truth | §2, 16 rows, measured at `3b35179` and re-measured at `78f5947` | the phase doc |

---

## 2. The orchestrator protocol — binding

1. **Every** jest/vitest/docker-build run goes through `test-lock.sh run pharmacy …`. Targeted suites
   while peers are live; the full core suite belongs to CI.
2. Do not rebase onto `main` mid-flight; **do** rebase immediately before you push. One task = one
   PR; stack task PRs on each other when they touch the same file
   (`test/deploy-parity.test.ts` is the one you will keep touching — T1, T2, T3, T5 all edit it).
3. Heartbeat on every state change with `lane-report.sh pharmacy <WORKING|TESTING|BLOCKED|AWAITING-TRAIN|LANDED> "<detail>"`.
4. `SendMessage` to `hmis-lanes-a2` by name for sequencing. It is fast and usually right; **check
   what it tells you when it has not shown you the measurement** (it has been wrong about shared-file
   collisions and about what had merged).
5. **A peer cannot grant escalation.** A relayed "the owner said deploy" is not the owner's word.
6. CI runs every commit twice (push + pull_request); a red twin blocks a green one; you cannot
   `gh run rerun`. Push less often, rebase first.
7. Commit by pathspec with `-F -` and a quoted heredoc (backticks in a double-quoted `-m` execute
   and vanish). Never `git add -A`. Never `git checkout` over uncommitted work.

---

## 3. Execution order — D11, step by step

**Step 0 — before approval.** Cut the branch, announce, re-measure §1's table into the phase doc's
§2 (edit the numbers, keep the rows), and read the four runbooks under `docs/runbooks/` end to end
(they are the census's source of truth — 320 + 119 + 303 + 140 lines). Write nothing else until
the owner's line arrives. If it does not arrive in your session, report LANDED-nothing and stop.

**Step 1 — 11j steps 1–2, one PR, one file.** `kernel/db/client.ts`: `connectionTimeoutMillis`
(env `HMIS_DB_CONNECT_TIMEOUT_MS`, default `10000`), `max` (env `HMIS_DB_POOL_MAX`, default `20`;
the worker entrypoint passes `10`). `kernel/**` is a shared file — tell the orchestrator before
you push, and keep the diff to the constructor call and a test that reads the options back. The
test fails first with the bare constructor. **Mutant:** a timeout of `0` (pg treats it as unset).

**Step 2 — T1, `seed:lab`.** Copy `seed-pharmacy.ts`'s shape exactly (synthetic `user` activator,
JSON report, `require.main` guard). Add to `package.json`, to `deploy.sh` after `seed-pharmacy.js`
and before `seed-roles.js`, to `SEED_STEP_SCRIPTS`, and to `check-config-present` as row 5.
Fail-first: the deploy-parity census must go red before the seed is added, and the config gate
must go red on a fresh DB before row 5 is wired. Mutants in the phase doc.

**Step 3 — T4, the watermark guard.** In `scripts/migrate.ts` before drizzle's `migrate`. Test
against a synthetic journal AND against the installed drizzle (prove the `<=` rule by execution —
E1). Both entrypoints (`tsx` and `dist`). No schema change.

**Step 4 — T2, the census.** `scripts/standup-check.ts` + `test/standup-check.test.ts`. Rows come
from the runbooks (§4 below adds the ones the runbooks miss). Every check through a module seam
or a kernel loader. Exit code is the verdict; `deploy.sh` prints and does not obey. **Pin the row
table in the test**: a module with a `*-go-live.md` runbook and no rows fails the test.

**Step 5 — T7, the catch-up runbook, and its rehearsal.** Write
`docs/runbooks/catch-up-deploy-2026-09.md` per the phase doc's step list (0–8, with 2, 2b). Then
**perform 2b on the AERB bench that exists** (`/opt/hmis-aerb-demo`, DB `hmis_aerb_demo`, API
:3020): migrate that DB to the tip without filing a licence, start a CT through the real route,
read `device_not_licensed`, run `file-demo.sh`, watch `GET /aerb/licences/gaps` empty. Paste the
transcript into the runbook. Then `lane-report.sh pharmacy AWAITING-TRAIN "T7 runbook ready; owner
deploys"` and message the orchestrator. **You do not deploy production.**

**Step 6 — while the owner decides: T3, T5, T6 in that order.** T3 (UAT target) and T5 (the
synthetic door) are code; T6 is the execution — the lab opens on UAT, dated in
`docs/runbooks/lab-go-live.md`. If the owner's deploy lands first, T6 runs against a UAT that
mirrors production; if not, T6 still runs (UAT is built from `main`) and its record is the S-gate
evidence for the deploy.

**Close.** Fill the phase doc's §8 per task (what was executed, counts read, mutants that died and
the one that did not, with reasons). Two review passes per `EXECUTE-METHOD-V3.md` §5A — the second
pass briefed at the FIXES, not the findings. The S-gate: the `## Executed on UAT` section exists
and is dated. Then `lane-report.sh pharmacy LANDED "11i closed"`.

**What you will NOT do in this phase** (phase doc §6): deploy production; retrofit 18c; build a
generic import framework; automate production deploys; create a user by seed; put a credential in
git; delete `/opt/hmis-preview` or `/opt/hmis-aerb-demo` (stop their containers, leave the dirs).

---

## 4. The edge catalogue — the days this lane must survive, in an Indian hospital on this box

Columns: **#** · **the day it happens** · **what must be true** · **task** · **the artefact that
closes it** (T = a test that fails first · M = a named mutant · C = a census row · R = a runbook
step · D = a DECIDED line in the phase doc's §3). Rows marked ★ were found by measurement today;
the rest are the standard day in a 200-bed Indian corporate hospital and on a 15 GB shared VM.

### A. The deploy and the box

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| A1 ★ | The owner runs the catch-up from a laptop on a phone hotspot; the SSH session drops at migration 12 of 21 | The runbook says `tmux new -s deploy` first (check `tmux` is installed; if not, `screen`; the classifier blocks `setsid` for sessions, not for him). Re-running `deploy.sh` is safe: idempotent, and the watermark guard names exactly what applied. T4 must have MEASURED whether drizzle wraps each migration or the whole batch in one transaction — the answer decides whether "re-run" or "inspect first" is the instruction | T4, T7 | T (drizzle txn shape, by execution) · R |
| A2 | The docker build starts while radiology's full-suite run holds 6 GB; the build OOM-kills jest, or jest OOM-kills the build | Every build goes through `test-lock.sh` — a build is a builder. The runbook's step 0 reads `board.sh` and refuses to start under a held lock. UAT deploys are a train step, not a lane habit | T3, T7 | R · D8 |
| A3 | `/var/lib/docker` fills with untagged `hmis-prod/server` layers after the fourth deploy; the fifth fails at `COPY` | Runbook pre-flight: `df -h /var/lib/docker` and `docker image prune -f` (dangling only, never `-a`); the UAT target uses its own tags so the prune cannot remove the running prod image | T3, T7 | R · M (UAT prune removing a prod tag) |
| A4 ★ | The owner deploys from `/opt/hmis` while a peer left an untracked file there | `deploy.sh` refuses (measured: dirty check, `docs/` exempt). The runbook says: never `HMIS_DEPLOY_ALLOW_DIRTY=1` on production; find the file's owner; `git status` is the diagnostic | T7 | R |
| A5 | `/opt/hmis` is on an old `main` or a peer left it on a branch | Runbook step 0 names the SHA; `git -C /opt/hmis fetch && git checkout main && git pull --ff-only`, then `git rev-parse HEAD` must equal the named SHA. A mismatch is a stop, not a warning | T7 | R |
| A6 | `main` is red when the tip is cut (a peer's twin failed) | **DECIDED: a red `main` freezes deploys as it freezes merges.** The tip is the newest green commit that contains #108; the runbook records the CI run id beside the SHA | T7 | R · D |
| A7 | The merge train lands a migration between the tip being named and the deploy starting | The deploy is built from the named SHA, not from `main`; the runbook's step 0 pins the checkout. A migration that lands afterwards waits for next week | T7 | R |
| A8 ★ | The UAT and prod stacks share an image tag; a UAT build replaces the image production restarts onto at 03:00 | T3's image tags are target-scoped (`hmis-uat/server:latest`); the deploy-parity UAT census greps the rendered script for `hmis-prod` and finds none | T3 | T · M |
| A9 ★ | Port 8443 is held by `hmis-preview-caddy`; UAT cannot bind | T3 stops the preview container as its first act and says so; the AERB demo on 8444 stays up until T7's rehearsal has used it (D11), then stops. UFW: `ufw status` shows 8443 open; 8444 closes with the demo | T3 | R |
| A10 ★ | Staff open UAT on an Android phone; Chrome refuses the `tls internal` certificate; the owner's laptop shows a red padlock | **DECIDED: UAT keeps `tls internal`**, and the runbook carries the one-screen "proceed anyway" instruction for Chrome and the Caddy root-CA import for the owner's laptop. A real hostname (`uat.hmis.crkmch.com` + a DNS record) is a one-line owner item that removes the step; not a blocker | T3 | R · D |
| A11 ★ | Basic auth on UAT swallows the app's Bearer token (the preview Caddyfile records exactly this) | Basic auth only on the static SPA, never on `/api/*` — copy the preview's Caddyfile shape, do not redesign it | T3 | T (caddyfile parity for the UAT file) |
| A12 | A power cut takes the box down mid-`compose up`; on restart prod comes up but UAT's containers race prod for memory | UAT compose has `restart: unless-stopped` OFF (DECIDED): UAT is started by hand after prod is healthy. The runbook's "after a power cut" paragraph: prod first, `docker ps`, then UAT | T3 | D · R |
| A13 ★ | The restore-drill log is stale or red on deploy morning | Step 2 of the runbook reads `/opt/hmis-prod/log/restore-drill.log`'s last entry (read-only). A failed or >8-day-old drill is the one thing the runbook refuses on. It was last written 2026-09-05 22:00 | T7 | R |
| A14 | Two deploys in one day after a hot fix | Idempotent by design; the watermark guard passes (nothing new); the seeds report `already`; the census is re-read. The runbook says "run it again; read the census twice" | T7 | R |
| A15 ★ | The deploy seeds cursors at `max(seq)` for 18 scheduler jobs and every new consumer; the imaging critical chaser sweeps every minute from the first tick | On production with no imaging data, nothing fires. The runbook's post-deploy check: `notifications` row count before and after — a burst is a cursor that was not seeded. On UAT with demo data see B6 | T7 | R |
| A16 | The owner runs the UAT command with `HMIS_TARGET` unset | Unset means prod. **DECIDED: `deploy.sh` prints a 5-second banner — target, SHA, pending-migration count — on every run, aborting on Ctrl-C**; no confirmation env var, so the orchestrator's UAT train stays automatable | T3 | T · D |

### B. Data, the synthetic door, and what must never cross it

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| B1 ★ | UAT runs the production image, so `NODE_ENV=production`; both synthetic seeds refuse | The door is `HMIS_SYNTHETIC_DATA_OK=1` in `/opt/hmis-uat/.env` only; the seeds need the door AND keep their existing refusals. Prod `deploy.sh` refuses to start with the key set | T5 | T · M (key set, prod target starts) |
| B2 | Someone copies `/opt/hmis-uat/.env` over `/opt/hmis-prod/.env` "to fix the database URL" | B1's prod refusal; plus the deploy-parity test asserts `docker/prod/.env.prod.example` lacks the key; plus the census's radiology rows: **any licence number containing `DEMO` on a prod target is a hard RED** | T2, T5 | T · C |
| B3 | A UAT database dump is restored into production "to get the demo catalogue" | The runbook forbids it in words; mechanically, pgBackRest is skipped on UAT (no stanza to restore from) and the census's `DEMO` row catches a licence; a synthetic patient is the one thing the census cannot see — so the runbook also says the UAT DB name is never `hmis` | T3, T7 | R · C |
| B4 ★ | The golden catalogue's `services` rows collide with the one synthetic CBC service production already carries | On UAT it is the same seed, idempotent. On production the owner's real catalogue lands through `POST /lab/catalogue/*`; the census row "investigation services with no orderable" reports the orphan and the runbook says deactivate it, never delete it (a service may be on an invoice) | T2, T6 | C · R |
| B5 | Demo patients' mobile numbers are routable; a demo "report ready" notice goes to a stranger's WhatsApp | **DECIDED: `/opt/hmis-uat/.env` carries NO SMTP, WhatsApp or SMS provider credential**; the outbox accumulates and the walkthrough asserts `queued`, never `sent`. The deploy-parity UAT census asserts the UAT env template lacks every provider key. Separately, T6 checks `seed-lab-demo`'s mobiles are in a non-allocated range and files a defect if not | T3, T5, T6 | T · R |
| B6 | Chasers and sweeps on UAT page "duty managers" every minute over synthetic overdue rows | B5 makes it harmless; the alert consumer's rows still accumulate. The walkthrough reads `/my-day` or the alerts list once and records that they are synthetic — the volume is itself a finding for Plan 20 | T6 | R |
| B7 ★ | `seed-lab-demo` "refuses unless asked twice" — nobody knows what the second ask is | T6 reads the script and writes the exact invocation into the lab runbook's `## Executed` section | T6 | R |
| B8 | UAT accumulates a month of synthetic patients; the owner asks to "start again" | **DECIDED: UAT reset = `compose down -v` + `deploy.sh` (uat) + the seeds**; T3 ships `docker/prod/uat-reset.sh` that does only that and refuses if `PROJECT` is not `hmis-uat` | T3 | T · M (reset script run with the prod project) |
| B9 | Aadhaar-like or ABHA-like identifiers in demo data | Demo rows carry none; if the seed sets any, the value must be syntactically impossible (fails the Verhoeff check). T6 verifies by reading the seed | T6 | R |
| B10 ★ | The demo seed runs at 23:50 IST; the "day" it creates is yesterday by the time anybody looks (the lab-reports D9 straddle, already paid for once) | The lab runbook's `## Executed` section records the IST time; the seed is not run between 23:30 and 00:30 IST. If the seed has no injectable clock, that is a defect to file, not to work around | T6 | R |

### C. People, roles and the two-hands problem

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| C1 ★ | The owner tests the lab alone and holds all four lab roles; DD11 refuses him verifying his own result | The walkthrough needs **two logins with PINs** and the fast-switch (`setPin`, Plan 02). T6 creates `pathologist` and `lab_technician` as separate accounts on UAT at `/admin/users`, sets PINs, and records the switch working — it is what a shared bench terminal will do in the real lab | T6 | R |
| C2 ★ | Production has one administrator; the lab runbook §1.3 calls a second one a blocker | On UAT create `admin2` and make the census row "≥ 2 users hold `admin`" green; on production it is O1 and the row stays RED until the owner names someone. The row's `fix` text says exactly that | T2, T6 | C |
| C3 | A role assigned at department scope, not hospital scope, and the seat 403s in a way nobody can read | The census checks hospital scope specifically; its RED text names the scope | T2 | C · M (department-scope holder reads green) |
| C4 ★ | `seed-roles` prints NOT READY on production because nobody holds `pharmacy` or `phlebotomist` yet | Not fatal (measured in `deploy.sh`); the census repeats it per module with the screen to fix it. The runbook says "expected on the first deploy" | T2, T7 | R |
| C5 | UAT credentials: the lane needs accounts, the owner needs their passwords, and nothing may go in git or in a file `seed-staff` would reject | **DECIDED: UAT accounts are created at `/admin/users` (or `seed:staff` via stdin); their passwords go in a root-600 file under `/opt/hmis-uat/` as the front-desk preview already does with `/opt/hmis-preview-password.txt` — acceptable for a synthetic environment only, never for production, and the file is named in the runbook so it is deleted with the environment** | T6 | D · R |
| C6 | The pathologist of record's registration number: on production it is a legal fact that prints on every report | The census cannot judge truth; the row checks non-empty and the `fix` text says "from the certificate, not from memory". On UAT the value is `DEMO-REG-…` | T2 | C |
| C7 | The phlebotomist reads Hindi only | The collection seat walkthrough is done once with the `hi` locale; a string that falls back to English on that seat is a defect filed against the front-desk lane's locale files (shared file — do not edit them here) | T6 | R |
| C8 | Nobody holds `billing_manager` on UAT; a HELD report cannot be released and the walkthrough's step 5 dead-ends | The lab's G4 census rows include the roles the lab's runbook names outside the lab: `billing_manager` (release), `cashier` (the walk-in's bill). T6 creates both | T2, T6 | C · R |
| C9 | The bridge accounts (`lab_bridge`, `modality_bridge`) — should the census demand them? | Informational rows, never RED: a machine account is created the day a machine is connected (17-E D2 says revoking it is the control) | T2 | C |

### D. The lab on UAT — the walk-through and the drills

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| D1 ★ | A walk-in with no OPD visit: `openVisitInTx` needs a `LAB` department with an active doctor in it | Census rows (department + doctor of record); T6 creates them through the OPD masters screen, never by SQL | T2, T6 | C · R |
| D2 ★ | One orderable has no price in the active tariff version; the desk refuses `tariff_item_missing` in front of a patient | Census row "every orderable priced"; **and the walkthrough deliberately leaves one unpriced** to see the refusal and record its wording — the census must have predicted it | T2, T6 | C · R · M (unpriced orderable reads green) |
| D3 | The report is HELD against an unpaid walk-in line; the counter asks the billing manager | C8's accounts; the walkthrough performs the release and reads the approval row | T6 | R |
| D4 | The "report ready" WhatsApp template is not approved; nothing is sent | Expected: `queued`. The walkthrough records the row and the runbook §0's owner action (template approval) stays on his list | T6 | R |
| D5 ★ | No label printer on UAT; print jobs queue for ever in the FD-24 outbox and drill C (downtime labels) is the only way to a tube | Drill C runs as the main path on UAT; the runbook records that the relay (`tools/print-relay`) is absent and the outbox depth. An informational census row: "print relay last heartbeat" | T2, T6 | C · R |
| D6 | Drill A at 02:00 — the critical call ladder rings everyone holding `pathologist` because there is no rota | Expected until Plan 20; the walkthrough records how many were paged (on UAT: the demo pathologist) | T6 | R |
| D7 | Drill B — a rejected tube on a walk-in that was billed; the credit note needs billing config and the cancel needs `billing.credit_note.issue` | Seeds present (deploy); the role grant per the runbook §3.4. If the credit note is refused, the census's G4 was incomplete — add the row, do not grant by hand | T2, T6 | C · R |
| D8 ★ | Night mode: between 21:00 and 07:00 IST a solo pathologist may sign their own result and the report prints PROVISIONAL | The walkthrough records the IST clock; the verify step is done once inside and once outside the window, and the `sod_violation` refusal and the `pathologist_review_pending` stamp are both read | T6 | R |
| D9 | The doctor's cockpit (07d) must show the signed result | The demo needs a consult under an OPD doctor; if `seed:lab-demo` makes a walk-in only, the walkthrough opens a consult by hand and records that the seed lacks it | T6 | R |
| D10 | The cashier's drawer: the walk-in's cash needs an open drawer session (`0055`) | The walkthrough opens one as the cashier; a census row for "drawer session open" is wrong (it is a shift fact, not a stand-up fact) — record the reasoning in §3 | T6 | D |
| D11 | The five seats are walked by one person five times, not by five people | Acceptable on UAT (the S-gate is about the path, not the head-count); on production the pilot (G6) is the department's. Say so in the `## Executed` section | T6 | R |

### E. The 18c window and radiology

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| E1 ★ | Production has zero registered ionising devices; the licence gate has nothing to refuse | The census reports the device count; the runbook's window step is SKIPPED and recorded as skipped. Do not declare `degraded` for nothing — every mode row is a ledger entry the owner reads | T2, T7 | C · R |
| E2 ★ | The certificate is entered with the wrong expiry year (chaos §8); 18c's only correction is `surrender`, which is terminal | Rehearsal on the AERB bench includes a deliberate wrong year and the documented safe path (a too-short window: file the next certificate from the day after). The runbook says "read the validity twice before filing"; the surrender question stays the owner's (it is already on his list from 18c) | T7 | R |
| E3 | The RSO role has no holder on production; nobody can file | `seed:roles` mints it on the deploy; the census row says who to assign; the owner assigns at `/admin/users` before the window step | T2, T7 | C · R |
| E4 | A CT is booked into the window | Radiology is unopened on production; if a booking exists the console sees `device_not_licensed` and the window note names it. The runbook says to read the day's imaging appointments before declaring | T7 | R |
| E5 ★ | The owner does not hold the certificates on deploy day | Devices stay refused after the window; the census shows RED on the radiology rows; the runbook says this costs nothing while radiology is unopened (second reading, already in the doc) | T7 | R |
| E6 | The AERB bench (`hmis_aerb_demo`) is on an old migration set and T7's rehearsal migrates it to the tip | That is the rehearsal. The watermark guard runs there first — the bench is the first real database the guard sees | T4, T7 | R |

### F. Money and paper, before the CA signs

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| F1 | Production still holds dev placeholder GST and an unsigned tariff (O6); a lab pilot invoice prints with placeholder tax | The pilot is shadow with paper authoritative (runbook §9). The census's hospital-wide row "`validate:config` last ok" is informational and names O6; the runbook says every receipt before O6 is a commissioning receipt and the cashier keeps the paper book | T2, T7 | C · R |
| F2 | MRP on a pharmacy batch versus tariff versus the NPPA ceiling — the price rule 16c ships | Not this phase; the pharmacy seat drill (weeks 4–6) will meet it. Note it in §6 so nobody looks for it here | — | §6 |
| F3 | The downtime kit's serial ranges are not registered on UAT; drill C has no serial to quote | `/ops/downtime-kit` before drill C; an informational census row "kit ranges registered" | T2, T6 | C · R |

### G. The census itself

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| G1 ★ | The census must run on production, and this lane may not touch `hmis-prod-*` | The runbook's step 3 and 6 are the OWNER's: `compose run --rm api node dist/scripts/standup-check.js all`, exactly as the seeds run. The lane runs it on UAT and on the test DB only | T2, T7 | R |
| G2 | A module renames a role key; the census keeps a string and reads green for a role nobody holds | Rows reference `ROLE_MODEL` keys from `seed-roles.ts`, and the test asserts every role key the census names exists in the model | T2 | T · M |
| G3 | A loader throws on an empty database; the census crashes instead of reporting | Every check is wrapped; a throw is RED with the loader's own message and the `fix` text | T2 | T · M (a throwing loader aborts the run) |
| G4 | A runbook gains a precondition and the census does not | The test pins one row set per `docs/runbooks/*-go-live.md`, and the runbook's `## Preconditions` table rows are counted against the census's rows for that module — a mismatch fails. Cheap, blunt, and it is the mechanism that makes the runbook and the script one document | T2 | T |
| G5 | The census is green and the seat still fails | Then the runbook was incomplete: T6 files the missing row (the walkthrough is the census's test) | T6 | R |

### H. Time, language and the owner's day

| # | the day | what must be true | task | closes with |
|---|---|---|---|---|
| H1 ★ | Every clock in the walkthrough is IST; the box is UTC; the runbook records times in IST with the UTC offset stated once | The `## Executed` section's header line | T6 | R |
| H2 | The owner reads the runbook on a phone at 22:00 | Every step is one command and one expected line; no paragraph a thumb cannot scroll past. The mutant for a runbook is a reader (phase doc T7) | T7 | R |
| H3 | The owner asks "is it safe to deploy?" on a Sunday with a peer's stack half-merged | The runbook's answer is a procedure (A5–A7), not a judgement; the lane's answer is `lane-report.sh` + a message to the orchestrator, never "yes" | T7 | R |
| H4 | The second reading's one fact — a real patient on production — turns out to be true | The order flips to UAT-first (phase doc D11); T3/T5/T6 precede the deploy; nothing else moves. Ask the owner the question in one line in your first report and proceed on "no" until told otherwise | all | D11 |

---

## 5. Already DECIDED — do not re-open

From the phase doc §3 (D0–D11) and the roadmap, plus the calls this handoff adds: A6 (a red
`main` freezes deploys), A10 (`tls internal` on UAT), A12 (UAT does not auto-restart), A16 (the
banner, no confirmation variable), B5 (no provider credentials on UAT), B8 (UAT reset script),
C5 (UAT passwords in a root-600 file under `/opt/hmis-uat/`, never for production), D10 (a drawer
session is not a stand-up fact). Add each to the phase doc's §3 as D12–D19 when you execute the
task that uses it, with the one-line reason from this table. Anything else you meet: pick the
standard Indian-corporate-hospital answer, write the D-line, keep going.

**What is the owner's, and the one line to ask each with:**
- "Execute 11i?" — the approval.
- "Has any real patient been registered on production?" — H4; assumed no.
- "May UAT get a hostname (`uat.hmis.crkmch.com`)?" — A10; removes a step, blocks nothing.
- The catch-up deploy itself, from T7's runbook, in his own session.
- Names: the second administrator (O1), the RSO, the pathologist of record — data, not decisions.

---

## 6. Traps this project has already paid for — the short list

- **A written record is a moment, not a state.** Every SHA and count in §1 is stale by the time you
  read it; re-measure at the point of use. A memory note said a build was never deployed and the
  image timestamp contradicted it.
- **"Not deployed" has two meanings.** Before saying anything "affects production", check whether
  the FEATURE exists at the deployed base, not only whether the fix does. A fabricated
  patient-safety emergency was escalated once on exactly this.
- **A test that passes against the unfixed code proves nothing.** Every task's test fails first;
  paste the red run, then the green one, with counts.
- **Pass 2 briefed at the findings found 15 of 16 fixes incomplete.** Brief it at the fixes.
- **Wall-clock budgets flake under lane load**; a `>=` where an exact number is knowable is the
  only tell visible on a green run. Do not write either.
- **An empty grep is evidence about the search.** Prove the file exists, then loosen the pattern.
- **`git diff main HEAD --stat` reads main's new files as your deletions.** Three dots, or `git show`.
- **Shared files:** `deploy-parity.test.ts`, `seed-roles.ts`, `router.tsx`, locales, `kernel/**`.
  Tell the orchestrator before you push a change to one; never `--ours` them in a merge.
- **The box:** 5 GB of swap in use is normal here and it is also why an unbounded `connect()` hang
  (step 1's reason) would be misread as "slow". Land step 1 first.

---

## 7. Verify and report

```
pnpm typecheck && pnpm lint
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run pharmacy \
  pnpm --filter @hmis/core exec jest -w 2 test/deploy-parity.test.ts test/seed-roles.test.ts \
    test/standup-check.test.ts test/migrate-watermark.test.ts src/modules/lab/definitions \
    src/kernel/db
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run pharmacy \
  bash -c 'HMIS_TARGET=uat HMIS_DEPLOY_DIR=/opt/hmis-uat bash docker/prod/deploy.sh'
```

Report at each `lane-report.sh` heartbeat and in the phase doc's §8: the counts you read, the
mutants that died and the one that did not, which edge rows closed (by number) and with what
artefact, and the exact question you are waiting on the owner for, if any. **Report a runbook
step you could not perform as a defect, never as a paragraph.** The close is the two review passes
plus the dated `## Executed on UAT` section in `docs/runbooks/lab-go-live.md`; without the third
the phase is not closed however green the suites are.
