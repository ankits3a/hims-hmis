# P6 absorption track — MEASURABILITY verification

Lens: measurability. Target: `wf/design/P6-absorption-track.md`. Measured at `41a4be4` on 2026-09-08 (origin/main fetched in `main-ro`; the checkout's HEAD is `ff07cbc`, so every repo cite below is `git show origin/main:<path>` unless a lane branch is named). Since P6 was written (`b04cbd9`, 09-06 21:40): #117 (11i T8) merged as `91c34fc`, #118 (T9) as `41a4be4`; 82 migrations (`0000`–`0081`); open PRs are #119–#122 + #73 only; nine files under `docs/runbooks/` (8 `-go-live.md` + `lab-catalogue-template.md`).

**Verdict: needs-amendment.** Every parameter can be made measurable, but 14 must change instrument or threshold, and four of those are load-bearing: (a) the `## Executed` grep can never match the headings that exist; (b) pharmacy's G6 closing criterion reads "empty" by construction because two of its three closing rows are thrown errors nothing records; (c) `pharmacy_gst_treatment_ruled` has no column to read; (d) `roster_credentials_rotated` reads a flag that clears itself on first login. Nothing reduces to "owner is satisfied"; two parameters reduce to "a test passes" and one is fixed below.

---

## 1. North-star parameters (§1)

### G-A — departments open behind the seven gates

| # | claim in P6 | finding | severity |
|---|---|---|---|
| A1 | G5 instrument: `grep -l '^## Executed' docs/runbooks/*-go-live.md` | **Matches nothing today and nothing after execution.** The only executed sections in the tree are NUMBERED headings: `## 6. Executed on UAT — **NOT YET RUN**` (`docs/runbooks/pharmacy-go-live.md:257`, origin/main) and `## 14. Executed on UAT — **NOT YET RUN**` (`origin/lane/commissioning-t6:docs/runbooks/lab-go-live.md:443`). Anchored `^## Executed` never matches `## 6. Executed`; an unanchored `Executed` matches the NOT YET RUN sections and reads G5 as done. The date is a table cell, not part of the heading (PH:262 `| # | act | who | done (date / initials) |`). Instrument must be a dated-heading regex, e.g. `grep -lE '^## ([0-9]+\. )?Executed on (UAT\|production) — 20[0-9]{2}-[0-9]{2}-[0-9]{2}'`, and the runbooks' NOT YET RUN headings must be rewritten to that form when executed. Baseline "G5 0 of 5" is now 0 of 8. | amend |
| A2 | Baseline: "G1–G4 printed once by the 12:35 deploy into `/opt/hmis-prod/log/` (DS:542-546)" | **No file was written.** `deploy.sh` at those lines (`b04cbd9:docker/prod/deploy.sh:542-546`; origin/main `:663-668`) runs `compose run --rm api node dist/scripts/standup-check.js all` to the script's own stdout. The only writes to `$DEPLOY_DIR/log/` in the whole script are the two cron lines (`:810` backup.log, `:819` restore-drill.log); there is no `tee`/`exec >` redirect (grep empty). The 12:35 transcript went to a jest process's stdout, captured nowhere. Baseline should read "no census transcript exists for the deployed base" — which is E7-M1's `log/deploy-<sha>.json` argument, stated wrongly. | amend |
| A3 | G6 = "the harvest's last three rows empty seven days" (LAB:207-218) | Real for the lab, false-by-construction for the pharmacy. LAB §9 (`lab-go-live.md:214-225`) closes on rows 4–6: open `lab_critical_calls` at 07:00 (table `lab.ts:662`), `absurd_overridden_by` (`lab.ts:472`), and `tariff_item_missing` — which is a `validate:tariff`/`validate:config` ERROR code (`modules/tariff/context.ts:107`), not a counter refusal, so it is read from that script's output. All three computable. PH §5 (`pharmacy-go-live.md:246-255`) closes on rows 4–6: `batch_expired_before_collection` refusals, `short_stock` refusals, `material.consumed` vs `stock_balances`. **The first two are THROWN `PharmacyError`s** (`modules/pharmacy/handover.ts:179-183`, `pick.ts:104-108`) and no event records a refusal — `dispense.line_declined` is appended only in `verify.ts:270`, a different act; PH:243 itself says "nothing in the system reads any of them". So two of the pharmacy's three closing rows are empty whatever happens at the counter, and pharmacy G6 cannot close honestly on the criterion as written. Nearest real: rewrite PH's closing three to rows the spine records (`dispense.queued` vs `dispense.handed_over`, `dispense.line_declined` by reason, `dispense.cancelled` with expiry reason, `material.consumed` vs `stock_balances`), or add one `pharmacy.refused{code}` event in 16c's plan home (E4's Build says "nothing new in the module" — that line is wrong if G6 is to be measurable). | amend |
| A4 | Every SC line cite | Stale by ~85 lines after #157/#158/#162: SC:341-346 → `:426-431`; SC:369 → `:603`; SC:249/261 → `:334/:346`; SC:161 → `:171`; SC:173 → `:229`; SC:201-206 → `:286-291`; SC:306-316 → `:391-401`; SC:402-445 (the runner) → `:667-712`. The instrument itself is real: `standup:check <module\|all>` (`SC:33`, `:667-712`), three verdicts (`:85`), summary line `rows= red= not_modelled=` (`:711`), exit 1 on RED (`:712`). | note |

### G-B — production tracks `main` weekly, with a way back

| # | claim | finding | severity |
|---|---|---|---|
| B1 | `backup.drill_rehearsed` "(T8; `main` has only `drill_passed/failed`)" and E1-M4 "`backup.drill_rehearsed{sha}` for the tip" | **Stale and mis-keyed.** The event EXISTS on origin/main (`kernel/retention/events.ts:142-150`, #117 → `91c34fc`). Its payload identifies the tip by `candidateImage: string` (`:148`), not `sha`; `restore-drill.sh:49` defaults `HMIS_DRILL_SERVER_IMAGE` to `hmis-prod/server:latest` and `:153,:199` copy it verbatim into the event. A rehearsal run without the SHA-tagged image writes `candidateImage=hmis-prod/server:latest`, which identifies no tip. Parameter must read "`backup.drill_rehearsed` with `outcome=passed` and `candidateImage` ending `:<sha>` ≤ 48 h before", and the deploy runbook must invoke the rehearsal with `HMIS_DRILL_SERVER_IMAGE=hmis-prod/server:<sha>`. | amend |
| B2 | "the runbook's §11 row (`origin/lane/commissioning-t7:docs/runbooks/catch-up-deploy-2026-09.md:361`)" | Real on the lane (`:361` `## 11. Executed on — **NOT YET RUN**`; census before/after sections `:208`, `:269`) — **absent on `origin/main`** (`git cat-file -e` fails; #119 open and FROZEN). On main there is no deploy record of any kind. G-B's Monday check has no on-main artefact until #119 lands or E7-M1's `log/deploy-<sha>.json` exists; say which. | amend |
| B3 | "days since the last governed deploy" | No date source named. Nearest real: `docker image inspect hmis-prod/server:latest --format '{{.Created}}'` (build time on the daemon; SHA tags at `deploy.sh:247-250`, kept 3 deep `:88,:118-130`), or the `at` of the newest `backup.drill_rehearsed`. Name one. | amend |
| B4 | "the owner's applied-count query" | Real but unnamed: `select count(*) from drizzle.__drizzle_migrations` (`lab-go-live.md:33`, `pharmacy-go-live.md:29`, `restore-drill.sh:291`). Journal length = 82 entries in `apps/core/drizzle/meta/_journal.json` at `41a4be4`. Write the query and the journal path. | note |
| B5 | Baseline "governed deploys 0 (four hand runs to 56, then the accident)" | Memory-sourced; no record in the repo or on the daemon can confirm "four" — which is G-B's own thesis. State it as "unrecorded; believed four" rather than as measured. | note |
| B6 | "or an open `deploy-blocker` saying why not" | Real: the label exists; `gh pr list --label deploy-blocker --state open` is the instrument. Name it. | note |

### G-C — a fresh session reads the milestone state from one measured file

| # | claim | finding | severity |
|---|---|---|---|
| C1 | "count of hand-typed state facts in THE PROMPT blocks"; threshold "≤ 3 state lines"; baseline "seven of ten handoffs restate SHA + pending count by hand" | **Not falsifiable as written: "state line" is undefined.** Ten HANDOFF files exist under `docs/superpowers/` on origin/main. Counting lines with a 7-hex SHA: 11, 2, 0, 14, 2, 1, 4, 1, 5, 6 → files with ≥1 = 9/10; counting lines with "pending" → 4/10. Neither reproduces "seven of ten". Define the instrument: a delimited `THE PROMPT` block, a regex (`\b[0-9a-f]{7}\b\|\bpending\b\|\bdeployed\b\|\bmigrations?\b.*\d`), and the command; then the baseline is whatever that prints. | amend |
| C2 | "STATUS.md ≤ 2 h old whenever a lane runs" | The header (E7-M1) records age; nothing enforces it. The CI pin (E7-M2) checks header-hash = body-hash, not age; the CLAUDE.md line is a practice. Name a mechanical check (`tools/lane.sh status` prints the header age and exits non-zero > 2 h) or downgrade the threshold to a practice. | amend |
| C3 | "board rows carry an age and list every worktree"; baseline `board.sh:13` hard-codes four lanes | Verified outside git: `/opt/hmis-lanes/.orchestrator/bin/board.sh:13` `for l in front-desk lims pharmacy radiology`; `state/*.status` mtimes 2026-09-05/06 → "heartbeat age from mtime" is a real instrument. `docs/STATUS.md`, `tools/milestones.sh`, `docs/handoffs/` all ABSENT on main (`git cat-file -e`). Hypothetical by design; E7 builds them. | note |

### G-D — the hospital leaves `commissioning` once

| # | claim | finding | severity |
|---|---|---|---|
| D1 | `validate:config` ok=true within 24 h; `operating_mode_changes` row; the gate; `POST /ops/mode`; baseline never green | **Sound.** `validate-config.ts:28-32` prints `scope <s>: ok=… caSigned=…` and `config-validation: ok=…`; exit 1 on red (`:39`). `ops.config_validated` defined at `kernel/ops/events.ts:92`, appended by `ops.controller.ts:232-242` and the script. `operating_mode_changes(from_mode,to_mode,note,report_id,actor_id,at)` (`kernel/db/schema/ops.ts:55-68`); `getOperatingMode` zero rows = commissioning (`mode.ts:61-68`); the gate rides every exit from commissioning (`mode.ts:187-191`); `POST /ops/mode` at `ops.controller.ts:213`. Baseline: `gst_settings.ca_signed` default false (`schema/tariff.ts:140`), `billing_config.ca_signed` default false (`schema/billing.ts:57`), `tariff_versions.status='activated'` is the "active tariff" predicate (`schema/tariff.ts:36-37`). | sound |
| D2 | E8-M1 "`validate:config` prints `caSigned=true` for every scope" | `caSigned` is printed only when non-null (`validate-config.ts:28`); scopes without a CA concept print none. Say "for every scope that prints it". | note |

---

## 2. Acceptance parameters (§3)

### E1 — 11i finishes
- **E1-M1** (note): `gh pr list` real. Baseline stale — #117 and #118 merged; the threshold is now "none of #119–#122 open". "§11 carries a dated row" → B2 (lane-only file).
- **E1-M2** (amend): every instrument is contingent on #120 (lane t3). `HMIS_ENVIRONMENT_LABEL` = 0 hits on origin/main; on lane t3 it is `kernel/config.ts:76,:313` and `apps/web/src/components/environment-banner.tsx:26`. `hmis-uat-*` container names come from `PROJECT="hmis-uat"` (`t3:docker/prod/deploy.sh:73-86`; compose yields `hmis-uat-db-1` etc.). "0 `hmis-prod` strings in the rendered script" IS a real assertion on t3 (`t3:apps/core/test/deploy-parity.test.ts:714` "says `hmis-prod` NOWHERE when the target is uat"). Health returns `{status, db, worker}` with `status` "ok"\|"degraded" (`health/health.controller.ts:24,:37`) — `{status:"ok"}` is checkable. Write "depends on #120".
- **E1-M3** (amend): "drills A, B, C, D" — main's LAB has A, B, C only (`lab-go-live.md:231,:242,:251`); D and the `## 14. Executed on UAT` table with rows for three registrations (`:487`) and drill D (`:496`) exist only on lane t6 (`:316`, `:443`). Depends on #122. `standup:check lab` exit 0 real (`SC:700-712`). 11i §8 CLOSE at `plans/2026-09-06-phase1-11i-the-stand-up-path.md:449` is empty ✓.
- **E1-M4** (sound, with B1): `gst_config.updated_at unchanged` is a valid deploy-vs-CA discriminator — `seed-tariff.ts:16-30` is skip-if-present ("a deploy must never be able to overwrite a corrected money or tax value"), while the module upserts set `updatedAt: new Date()` (`modules/tariff/gst-config.ts:45-54`). "80 at `fbe8fc4`" → 82 at `41a4be4`. Both images present via `docker image ls` ✓.
- **E1-M5** (amend): "0 deploys without a §11 row" — the weekly runbook does not exist and §11 is one section of the lane-only catch-up runbook. Count with `log/deploy-<sha>.json` (E7-M1) or the dated rows of the weekly runbook once written; name it.

### E2 — 11k loaders
- **E2-M1** (amend, collision): `load:lab-catalogue --dry-run` **already exists under another name and flag**: `import:lab-catalogue` (#168; `apps/core/package.json:43`; `scripts/import-lab-catalogue.ts:17` `--analytes a.csv --ranges r.csv [--apply]`). Dry-run is the DEFAULT and `--apply` writes; verdicts `create|update|unchanged|refuse` (`:203-208`); "every refusal the write path can raise is mirrored HERE, read off `catalogue.ts`" (`:220-223`). The acceptance is met by the existing script today; the milestone's residue is the owner's FILE (F3) and the two census rows (`lab_orderables_priced` `SC:334`, `lab_range_sources_present` `SC:346`). Rewrite the parameter to the real name and "REFUSE 0 without `--apply`".
- **E2-M2** (amend, collision): `load:pharmacy-items` collides with `import:item-master` (#144/#163; `scripts/import-item-master.ts:39` "Without `--apply` it writes nothing"; `:235` refuses apply with any refusal; `:257` one `withTx`). "0 `stock_batches` written" real (`schema/materials.ts:427`). `pharmacy_items_priced_within_ceiling` is measurable: `ceiling_paise` on the regulated-price table (`schema/materials.ts:284`). The gap is sale registration + NPPA, not the item load; name the existing script.
- **E2-M3** (note): `patient_merge` — `SC:171 patient_merge_registered` checks the approval TYPE (`patients/approval-types.ts:60`); "count printed" is a count of approval instances of type `patient_merge` (`patients/merge.ts:14`) — write the query. `0057_uhid_floor_11000.sql` exists; "0 UHIDs below the floor" = `select min(uhid)`.

### E3 — front desk + billing + lab on production
- **E3-M1** (amend, collision): **a front-desk runbook and its census rows already exist.** `docs/runbooks/opd-go-live.md` (#155) is mapped to census module `front-desk` (`test/standup-check.test.ts:136-141`), and `SC:237` declares `"front-desk": [` with five rows (`opd_config_present`, `opd_visit_definition_active`, `active_doctor_in_a_department`, `cashier_held`, `front_office_held`, `SC:239-291`). The key is `front-desk`, not `front_desk`; "6 files" is stale (8 `-go-live.md` on main). A new `front-desk-go-live.md` would be a second runbook for one module (the test permits it with a mapping line, `:130`, but it is a duplicate). Rewrite: fold `README.md:62` (patients) and `:645` (billing) into `opd-go-live.md` or a billing runbook; threshold "`front-desk` rows ≥ 5 (already) + the billing rows".
- **E3-M2** (amend): "`LAB` department with `registration_no` set" — the column is on `opd_doctors` (`schema/opd.ts:14-20`), not departments; the row is `lab_doctor_registration_no` (`SC:307`). **`roster_credentials_rotated` cannot read `must_change_password`:** the flag is set at creation/admin reset and CLEARED by `POST /auth/change-password` (`schema/auth.ts:28-30`), so after the human's first login it is false again and indistinguishable from never-rotated; the census would go RED the moment O2 succeeds. Nearest real: `users.updated_at` (`auth.ts:32`) later than the 11e roster's creation for every roster username, or a `password_changed_at` column (a migration). `seed:staff` transcript real (`scripts/seed-staff.ts:1-2`, stdin roster). NOT MODELLED = 3 for lab real (`SC:391-401`).
- **E3-M3** (amend): "0 `tariff_item_missing` in the walk" — that code is a `validate:tariff` ERROR line (`tariff/context.ts:107`), not a counter refusal; the instrument is "`validate:tariff` prints 0 `tariff_item_missing` for the lab's orderables before the walk". "One test print per device recorded" is a runbook-table fact (printer destinations are NOT MODELLED, `SC:401`) — acceptable for G5, say so.
- **E3-M4** (amend, the deepest one): `pilot:harvest`, `paper_vs_system`, `pilot.harvest_read` = 0 hits each (`git grep` over the tree). `paper_vs_system` needs a HUMAN-typed paper count — it can only ever be a runbook-table fact, never a query; say so. `pilot.harvest_read` "with a reader": a script/cron run appends with actor `system` (the `restore-drill.sh:190` precedent), which proves the script ran, not that a head read it. To carry a reader it must be an HTTP read by a named user (e.g. `GET /lab/harvest` under a lab permission, the event carrying `actor.id`) — name that in Plan 17's home, or change the parameter to "harvest printed ≥ 7 days AND the head's initials on seven runbook rows". Edge 10 stands or falls with this.

### E4 — pharmacy
- **E4-M1** (amend): "11 refusals each seen once" — PH §4 now reads "all 33 codes" (`pharmacy-go-live.md:202-206`; 23 table rows) and says the drill "provokes several of the missing ones". "11" is the pre-#128 count. Rewrite: "every code the §3 seat drill provokes, quoted in the §6 table". `seed:pharmacy-demo` real (`package.json:39`).
- **E4-M2** (amend): "the CA session writes the tax-inclusive rule into `gst_config`" — **`gst_config` has no column that can hold it**: `category, sac_code, exempt, rate_bps, special_rule, threshold_paise, updated_by, updated_at` (`schema/tariff.ts:124-133`). `pharmacy_gst_treatment_ruled` would have nothing to read → NOT MODELLED, or a migration. Nearest real without a migration: `special_rule` (free text, today only `room_rent_daily_threshold`) set to `mrp_inclusive` on the four `pharmacy*` rows (`seed-tariff.ts:85-100`), and the row reads that. The ₹100 slab test is "a test passes"; pair it with a production fact: one real dispense line with `price_winner='batch_mrp'` (`schema/pharmacy.ts:151`) whose net equals the printed MRP.
- **E4-M3** (amend): "`invoice_not_settled` refusals quoted" — thrown at `pharmacy/handover.ts:74`, unrecorded; measurable form is "0 dispenses handed over with `invoice_id is null`" or a human-typed line. `dispense.handed_over ≥ 1/day` real (`pharmacy/events.ts:57`). Pharmacy G6: A3.

### E5 — radiology + AERB
- **E5-M1** (sound): rows real (`SC:626-635`); `deploy.sh`'s seed list has no `seed-radiology.js` (`deploy.sh:520-626`; `deploy-parity.test.ts:364-396`) → "+1" falsifiable.
- **E5-M2** (amend): `file-demo.sh` lives at `/opt/hmis-aerb-demo/file-demo.sh` OUTSIDE git (`docs/superpowers/2026-09-05-HANDOFF-radiology-lane.md:84`; RM:62); 11i:284 says its shape "becomes `scripts/seed-aerb-demo.ts`" — which exists only on lane t5 (#121, `apps/core/scripts/seed-aerb-demo.ts:13`; DEMO asserted in every licence number `:157-160`). Name `seed:aerb-demo`. `/aerb/licences/gaps` real (`aerb/aerb.controller.ts:157`); `dev-radiology-standup.ts` real on main; `device_not_licensed` real (11 hits). "`## Executed on UAT` in RS, PACS, RAD · 3" — none of the three has any such section yet; A1's regex applies.
- **E5-M3** (sound): `workflow_definitions.drafted_by`/`activated_by` (`schema/workflow.ts:16-17`) + `workflow_definition_approvals.approver_id` (`:35`, unique per definition+approver `:41`) → `count(distinct …) ≥ 3` is a real query; accession format `X2608300001` (`radiology/events.test.ts:113`). Edge 18's "distinct approvers = 2 + activator ≠ drafter" ✓.
- **E5-M4** (sound): DEMO is in `licence_no` (lane t5 `:157`) → `like '%DEMO%'`; a `degraded` row needs a note (`mode.ts:24`) and its length is the next row's `at` − its own (`schema/ops.ts:60-65`).

### E6 — the silent three
- **E6-M1** (amend, stale): **OT rows and runbook already exist** — `SC:458-522` (six rows incl. `ot_definitions_published`, `ot_surgeon_held`, `ot_anaesthetist_held`, added 2026-09-07 `SC:447`) and `docs/runbooks/ot-go-live.md` (#157). Only `materials.*`/`membership.*` are new (0 hits as census keys). "8 runbook files" is stale: 8 `-go-live.md` exist; adding two makes 10. Threshold: "`materials.*`, `membership.*` ≥ 3 rows each; 10 `-go-live.md`; `standup-check.test.ts:212-250` green".
- **E6-M2** (amend): "`ot_definitions.status='active'` ≥ 3" — `OT_DEFINITION_KIND_VALUES` has FOUR kinds (`schema/ot.ts:96`: criteria, privileges, deposit_policy, pacu_thresholds) and `ot_definitions_published` requires EVERY kind active (`SC:509-518`), `privileges` included, which no seed even drafts. "≥ 3" leaves the census RED. Threshold = 4 = the row ok.
- **E6-M3** (sound): `membership_plans` (`schema/membership.ts:61-62`) count > 0.

### E7 — 11l
- Hypothetical by design; each acceptance is falsifiable once built. `tools/lane.sh` has `new|drop|list|status|gc` only (`tools/lane.sh:136-140`) → `stale` is new. No `JEST_WORKER_ID`/`NODE_ENV` guard in `deploy.sh` on main or lane t3 (grep empty both) → E7-M3 is genuinely new; the guard the mutation deleted was `HMIS_DEPLOY_ALLOW_DIRTY` on prod and the fix was test-side (`memory:deploy-sh-executed-by-a-test:13-40`).
- **E7-M3** (amend): "`lane.sh stale` lists the front-desk lane today" — "today" is not a stable fixture (that lane has since pushed and cleaned); use a synthetic one (a worktree with a back-dated `.status` and one unpushed commit).
- **E7-M4** (amend): "≤ 3 state lines" → C1.

### E8 — G7
- **E8-M1/M2** (sound): D1. "0 visits `in_consult` at the instant" — `in_consult` is a bench status (`modules/opd/bench.ts:68`); nothing in `kernel/ops` reads it (0 hits) — a human query until E8's transition guard exists; the Build names the guard, so acceptable.

---

## 3. Edge-case artefacts that have no instrument

- **Edge 27** (amend): "Caddy 404 counts on the three paths" — `docker/prod/Caddyfile` has no `log` directive (grep for `log|access|output` empty), so Caddy writes no access log and there are no counts. Nearest real: add a `log` block one release before removing the redirects (covered by `test/caddyfile-parity.test.ts`), or count the api's own 404s.
- **Edge 10** → E3-M4. **Edge 16/5** ("refusals quoted") → E4-M3. **Edge 19** → E3-M2. **Edge 17** (`ot_definitions_published` reads `status='active'`) — already true on main (`SC:509-518`); the edge is closed, not pending.

## 4. Does anything reduce to "tests pass" or "owner is satisfied"?

No parameter reduces to the owner's satisfaction; every human act names an artefact. Two reduce to a test: E4-M2's slab test (fixed above by pairing with a production line) and E7-M2/M3's mutant runs (appropriate — the epic builds instruments). G-A's week targets are calendar-falsifiable once A1 is fixed.

## 5. Baseline honesty

Honest where measured, stale in five places (A2, A4, B1, E1-M1, E6-M1) and unmeasurable in one (B5). The most consequential stale line is B1: P6 argues from "main lacks `drill_rehearsed`" for work that has landed.

## 6. The amendments, in order of weight

1. A1 — replace the `## Executed` grep with a dated-heading regex; rewrite NOT YET RUN headings to that form on execution.
2. A3 — pharmacy G6: rewrite PH §5's closing three to recorded rows, or add one `pharmacy.refused{code}` event (16c); E4's "nothing new in the module" is false if G6 is to be measurable.
3. E4-M2 — `gst_config` has no inclusive/exclusive column; use `special_rule='mrp_inclusive'` or declare the row NOT MODELLED; pair the slab test with a real `price_winner='batch_mrp'` line.
4. E3-M2 — `roster_credentials_rotated` cannot read `must_change_password`; read `users.updated_at` vs the roster date or add `password_changed_at`.
5. B1/E1-M4 — `backup.drill_rehearsed.candidateImage` must end `:<sha>`; the rehearsal is invoked with the SHA tag.
6. E2-M1/E2-M2 — rename to the existing `import:lab-catalogue` / `import:item-master`; dry-run is the default, `--apply` writes.
7. E3-M1 — the front-desk runbook and `front-desk` census rows exist (`opd-go-live.md`, `SC:237-291`); fold patients/billing into them.
8. E6-M1/E6-M2 — OT rows + runbook exist; threshold 10 files; `ot_definitions` active = 4, not ≥ 3.
9. E3-M4 — `paper_vs_system` is a human-typed fact; `pilot.harvest_read` needs an HTTP reader with an actor or becomes "printed + initialled".
10. A2 — the 12:35 census went to a jest stdout, not `log/`; baseline "no transcript exists".
11. B2/E1-M1/E1-M5 — the §11 row is lane-only (#119 FROZEN); name `log/deploy-<sha>.json` as the on-main deploy record.
12. C1/E7-M4 — define "state line" by regex + block delimiter; the baseline is whatever it prints (9/10 by SHA, 4/10 by "pending").
13. C2 — name the mechanical age check or downgrade to a practice.
14. E5-M2 — `file-demo.sh` is an out-of-git script; the in-repo instrument is `seed:aerb-demo` (#121).
15. Edge 27 — Caddy has no access log; add `log` or count api 404s.
16. Notes: B3 (date source), B4 (write the applied-count query), D2 (`caSigned` only where printed), E4-M1 (33 codes, not 11), E3-M3 (`tariff_item_missing` is a validator code), E2-M3 (the merge-queue query), A4 (SC line cites), E1-M2/E1-M3 (contingent on #120/#122), E7-M3 (fixture, not "today").
