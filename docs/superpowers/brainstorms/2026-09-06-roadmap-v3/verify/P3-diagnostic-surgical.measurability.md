# VERIFY — P3 diagnostic & surgical · lens: MEASURABILITY

Target: `wf/design/P3-diagnostic-surgical.md` (unchanged since 2026-09-06 21:40; header says `b04cbd9`). **Measured at `91c34fc` on 2026-09-08 11:32 UTC** (CONTEXT NIGHT UPDATE 3) with `git grep`/`git show origin/main:` — main-ro's checkout (`ff07cbc`) is 16 behind. A prior pass at `3f596e4` existed; this one re-measured every instrument independently and adds what moved since: **#157 (OT runbook + 6 census rows), #164 (`list.resequenced` + the resequence shape), #158, #143/#142/#140/#132/#150 all MERGED.** Design line numbers were checked against `b04cbd9` where they mattered (`deploy.sh:542-545` correct there; `:663-667` now).

Verdict: **needs-amendment.** No parameter is unmeasurable in principle; nineteen instruments are vacuous on the current schema, already satisfied before the work starts, cannot discriminate what they claim, or point at a mechanism that does not exist. Nothing reduces to "owner is satisfied"; two reduce to "tests pass" and are acceptable under CLAUDE.md's evidence rule.

## 0. REAL instruments (verified at `91c34fc`; no refutation)

| instrument | where |
|---|---|
| `standup:check <module|all>`; `exitCode=1` on any RED; `NOT MODELLED` is a third verdict defined to avoid permanent reds; **prints only — no `appendEvent`, no table** | `apps/core/scripts/standup-check.ts:48-57, 85, 700-712` |
| radiology census rows: `radiology_definitions_active` (G3, Class A — "three named humans"), `radiology_study_types_active` (G2, `activeStudyTypes(db).length > 0`, fix = `seed:radiology`, "deploy.sh does not run it"), `radiology_device_present`, `radiology_devices_licensed` (needs ≥1 device), `radiology_rso_appointed` (`personRole === "rso"`) | `standup-check.ts:603-665` |
| OT census rows, SIX: `ot_approval_types_registered`, `ot_theatre_present` (G2), `ot_workflow_definitions_active`, `ot_definitions_published` (G3), `ot_surgeon_held`, `ot_anaesthetist_held` (G4) | `standup-check.ts:460-522` (#157) |
| `deploy.sh` runs `seed-ot.js` (:600), `seed-roles.js` (:626), `standup-check.js all` (:663); **0 hits for `radiology`** — `seed:radiology` never runs; no deploy log file (`tee|deploy.log` = 0) | `docker/prod/deploy.sh` |
| runbooks NINE; **`## Executed` heading only in `pharmacy-go-live.md:257` (NOT YET RUN)**; harvest tables only in `lab-go-live.md:214` and `pharmacy-go-live.md:246`; `radiology-go-live.md` = §0–§10 (§9 nine steps, §10 drills A–C), no Executed, no harvest; `ot-go-live.md` = §0–§9, no Executed | `docs/runbooks/*` |
| `imaging.study_scheduled / gate_evaluated / study_acquired / report_published / critical_flagged / critical_acknowledged / image_viewed{via} / contrast_reaction / outside_study_registered / critical_overdue{category,overdueMin} / report_unread{unreadHours}` | `modules/radiology/events.ts:35-170` |
| `events.actor_type` untyped text from `input.actor.type`; the only CHECK is on `order_item_transitions` | `schema/events.ts:30`; `kernel/events/append.ts:37`; `schema/orders.ts:39,293` |
| `order.placed{orderId, orderNo, kind, patientId, encounterNo, groupId, itemIds}` — no channel field | `kernel/orders/events.ts:48-58` |
| `acquiredAt = input.acquiredAt ?? now`; `lateEntry` derived at 30 min | `modules/radiology/acquisition.ts:249, 428-429` |
| `IMAGE_VIEW_CHANNELS = ["external_pacs"]`, CHECK `imaging_image_views_via_ck`; `imaging_studies.order_item_id notNull().unique()`; `imaging_reports.provenance jsonb`; `imaging_critical_findings.acknowledged_at`; `imaging_report_delivery.first_read_at`; `pacs_settings.enabled` published through `requestApproval` → `{approvalId}` | `schema/radiology.ts:149, 434, 503, 589-605, 896-900`; `modules/radiology/definitions.ts:145, 247-262` |
| `provenance` shape today: `{drafter, version, inputs, at}` — per DRAFT, not per field | `modules/radiology/drafter.ts:51-56, 159-166` |
| MWL `{withheld, malformedAeTitle}`; withholds unlicensed ionising devices; **test exists**: "18c T1 — an ionising study is withheld from a machine whose AERB licence is gone" | `modules/radiology/mwl.ts:95-97, 238`; `mwl.test.ts:166` |
| `GET /aerb/licences/gaps`; `POST /radiology/contrast-reactions` (0 web callers — verified; `radiology-api.ts` paths listed, none) | `aerb.controller.ts:157`; `radiology-acquisition.controller.ts:221` |
| `interface.down{interfaceId, kind, name, lastSeenAt, staleAfterMs}` / `interface.restored{…, seenAt, downSince}`; `INTERFACE_KINDS = ["printer","scanner","other"]` (zod enum); floor 30 s, default 180 s, sweep 60 s; `POST /ops/interfaces/:id/heartbeat` | `kernel/ops/events.ts:131-165`; `kernel/ops/interfaces.ts:47, 58-59, 67`; `kernel/config.ts:145`; `ops.controller.ts:314` |
| `backup.drill_passed/failed{stanza, censusEvents, restoredEvents, assertedEventId, backupSeconds, restoreSeconds}`; exporter `max(recorded_at) where name='backup.drill_passed'`; drill = pgbackrest Postgres restore; cron log `$DEPLOY_DIR/log/restore-drill.log` | `kernel/retention/events.ts:110-121`; `postgres-exporter/queries.yml:66-79`; `drill/restore-drill.sh:21,85`; `deploy.sh:819` |
| `escalation.triggered{instanceId, defKey, state, rung, role, resolvedUserIds, fallbackExhausted}` — a WORKFLOW timer event | `kernel/workflow/events.ts:35-45`; `timers.ts:150-168` |
| `lab.sla_breached` from `sweepLabSla` — the house precedent for a partner SLA | `modules/lab/events.ts:277`; `kernel/worker/jobs.ts:401` |
| OT events: `list.published`, **`list.resequenced`** (#164), `surgeon.late_flagged`, `anaesthetist.substituted{caseId, plannedAnaesthetistId, actualAnaesthetistId}` (no reason), `timeout.halted`, `count.mismatch`, `gate.overridden{…reason}`, `death.on_table_recorded`, `late_entry.flagged{…reason}`; NONE of `case.overrun_projected`, `npo.extended`, `theatre.blocked/cleared` | `modules/ot/events.ts:149-191` |
| `resequence` appends `listResequenced` (:213); `resequenceList` posts `{listDate, theatreResourceId, caseIdsInOrder, reason?}` (`ot-api.ts:123`) — **0 screen callers**; server `resequenceBody {caseIdsInOrder, reason?}` | `modules/ot/lists.ts:181-220`; `ot-cases.controller.ts:92-95, 230` |
| `flagLateSurgeons` (60 s) reads ONLY the NPO gate's typed `plannedStart` → LA-only never late; `ot_cases` has `wheel_in…wheel_out`, `package_service_code notNull`, **no `planned_start`**; `ot_lists` exists, no `ot_list_items`; `OT_GATE_KIND_VALUES` = nine, `theatre_fit` absent AND asserted absent | `lists.ts:258-281`; `jobs.ts:260`; `schema/ot.ts:90-93, 242-275, 300`; `schema/ot.test.ts:203` |
| `onRelease: "turnover"`; `registry.ts:475` admits `onRelease` for assignment; `cArm: z.boolean()`; `in_holding` state; `bill_not_composable` (8 throws); `OT-1` by `seed:ot`, two bays | `kinds.ts:61`; `registry.ts:475`; `definitions.ts:93`; `cockpit.ts:131`; `bill.ts:144-255`; `booking.ts:329`; `seed-ot.ts:20-28` |
| `alerts-parity.test.ts` pins the exact sorted job array, `toHaveLength(18)`, and `legs.toHaveLength(2)`; `alerts.yml` names `sweepCriticalChaser` ×3 and `HmisSchedulerJobMissing` | `test/alerts-parity.test.ts:101-166`; `prometheus/alerts.yml:3 hits, :69` |
| `seed-roles` READY = whole-hospital (`unheld` over every declared role → `ready` → `exitCode`); per-role line `… · N holder(s)`; radiology keys `radiologist, radiographer, radiology_receptionist, radiation_safety_officer, modality_bridge` | `scripts/seed-roles.ts:1717-1725, 1750, 1813; 1067, 1109, 1141, 1208, 1226` |
| `agents.kill_switch` + `setKillSwitch()` — a kill switch EXISTS on main | `schema/auth.ts:97`; `kernel/auth/agents.ts:17-26` |
| `/orders` in `apps/web/src`: `lab-api.ts:248` (`/lab/desk/orders`) + `lab-desk.test.tsx`; 18a-iv names the door `POST /radiology/orders` | `apps/web/src/lib/lab-api.ts:248`; `…18a-iv-radiology-ordering-door.md:24-25, 94` |
| No roster/shift/duty table (only `scheduler_heartbeats` matches); Plan 20 :33 says "none"; `opd_doctor_schedules{doctor_id, weekday, start_time, end_time, room_id}` IS the OPD session | `schema/*`; `…phase1-20-workforce-roster.md:33, 92`; `schema/opd.ts:93-107` |
| `partners.ts` tables `partner_agreements`, `partner_ref_map` — **no `dpa`/`region`/`deid` column** | `schema/partners.ts:100, 158` (grep 0) |
| `migrate-watermark.test.ts` (11i T4 guard); DPIA `[COUNSEL]` = 8, `image|dicom|pixel|radiolog` = 0 | `apps/core/test/migrate-watermark.test.ts:15-23`; `docs/compliance/…dpia…v0.1.md` |
| 0 hits in non-test `apps/core/src` for: `sendout`, `teleradiology`, `study.unmatched`, `theatre_not_cleared`, `surgeon_clash`, `replica_lag`, `unmatched_today`, `pacs_reachable`, `bridge_role_clean`, `imaging_cloud_region`, `DEMO`, `planned_start`, `planned_min`, `case.overrun`, `npo.extended`, `theatre.blocked`, `theatre.cleared`, `imaging_ai_flags`, `ai_flag`, `deid`, `fibre|bandwidth|Mbps`, `OHIF|dicomweb|STOW|WADO|C-STORE`, `clearTheatre`, `Forecaster` — consistent with the design's "to build" | grep |

## 1. Refutations

### R1 · G-A "100 % user-actor orders from opening day" — the instrument cannot tell a door from a curl · **amend**
`actor_type` is whatever the session's principal is (`append.ts:37`); a curl with a user token writes `user`. `order.placed` carries no channel (`kernel/orders/events.ts:48-58`); `imaging.study_scheduled` is appended with the route's `actor`. So the threshold was **already 100 % on PR #142's all-curl walk** — it measures nothing about a door. Same defect in E1-M1's "`imaging.study_scheduled` … `actor.type='user'`". Nearest real: `imaging.image_viewed.via` (CHECK-listed channel, `schema/radiology.ts:605`). Minimal add: `placedVia: 'reception'|'api'` on the `POST /radiology/orders` route's event/audit row — **18a-iv T2** (`…18a-iv…md:94`).

### R2 · E1-M1 "`/orders` callers in `apps/web/src` ≥ 1 (grep)" — already satisfied by the lab · **amend**
`lab-api.ts:248` posts `/lab/desk/orders`. The threshold is met with no radiology screen. 18a-iv's own ground truth (`:24-25`, measured at `e32598b`) is stale for the same reason. Must read: `grep -rl "/radiology/orders" apps/web/src --include=*.tsx --exclude=*.test.tsx ≥ 1`.

### R3 · G-B p95 "acquisition→viewable" starts at a console-typed instant; the replica leg has no discriminator · **amend**
`acquiredAt = input.acquiredAt ?? now` (`acquisition.ts:428`) is typed after the scan; `imaging.study_acquired` has no consumer outside the module (grep: `acquisition.ts`, `events.ts` only; 18b:21 row 2). Nothing on main stores a DICOM receive time (18b §6 excludes reconciliation). "≤ 15 min replica": `IMAGE_VIEW_CHANNELS = ["external_pacs"]` is CHECK-enforced (`schema:589,605`), so a replica view is indistinguishable from an in-house one. Amend: (i) E2-M2's reconciliation persists `received_at` — name the column there; (ii) E3-M3 adds `replica` to `IMAGE_VIEW_CHANNELS` (a migration); (iii) until then the p95 is console→viewer and must exclude `late_entry = true`.

### R4 · G-B "0 rostered shifts with 0 views" — no roster exists · **amend**
No roster/shift/duty table on main (Plan 20 :33: "none"); Plan 20 is FOR APPROVAL (#150 merged as a doc), unbuilt, and the design homes it under E7 only. Nearest real now: IST days with ≥1 `imaging.report_published` and 0 `imaging.image_viewed` — "signed without opening the images", the negative-space row doc01:598 actually describes. Baseline: 0 view rows, so every reporting day reads positive today; say so.

### R5 · G-C "image-tier drill pass age (`backup.drill_passed`)" — the metric cannot see tiers · **amend**
The payload is a Postgres census (`retention/events.ts:110-121`); the exporter takes `max(recorded_at)` over ANY `backup.drill_passed` (`queries.yml:71`); `restore-drill.sh` restores a cluster from pgbackrest (`:21,85`). The weekly Postgres pass keeps the age green while no image drill ever ran. 11i T8 split the REHEARSAL out of `drill_passed` for exactly this reason (`events.ts:124-134`). Amend: `backup.image_drill_passed{…, studiesRestored}` + its own exporter row + an `alerts-backup.yml` leg, built in **E2-M4**; "image drill monthly" then has an instrument.

### R6 · E1-M5 harvest — one row is impossible by CHECK and the runbook has no harvest table · **amend**
"studies with no order": `imaging_studies.order_item_id` is `.notNull().unique()` (`schema:149`) — empty forever; the off-book signal is `study.unmatched` (E2-M2). `radiology-go-live.md` has §0–§10 and **no harvest table, no `## Executed`** (only pharmacy `:257` and lab `:214`/pharmacy `:246` have them). Amend: E1-M2 adds `## 11. Executed on UAT` (pharmacy's table shape `:259-262`: `# | act | who | done (date/initials) | what you saw`) and `## 12. Harvest` with one SQL per row: `image_source='no_pacs_images'` on a device carrying `aeTitle` (`mwl.ts:50`); `imaging_critical_findings.acknowledged_at is null` at 07:00 IST; `imaging_report_delivery.first_read_at is null` > 24 h; `study.unmatched` count (E2).

### R7 · E1-M3 "film/CD priced" — no service row exists to price · **amend**
`seed-radiology.ts` creates `XR-1, USG-1, CT-1, MRI-1, MMG-1` (`:80-84`), runbook §6 "sets no prices"; `film|cd` = 0 in `seed-tariff.ts` and `modules/tariff`. Amend: E1-M2 adds `RAD-CD`/`RAD-FILM` service rows; the parameter becomes "an active tariff version prices both (R-004: ₹150/₹250)". Or move the line into the R-004 ruling row.

### R8 · E1-M3 / E6-M2 "…held by named humans (`seed-roles` READY)" — READY is the wrong granularity · **amend**
READY is hospital-wide (`unheld = outcomes.filter(o => o.holders === 0)` → `problems` → `exitCode`, `seed-roles.ts:1717-1725, 1813`). Six OT roles hold zero on production (`ot/manifest.ts:35-37`), so radiology's E1-M3 reads NOT READY until E6-M2 fills them, and vice versa. The OT census covers only `surgeon`/`anaesthetist` (`standup-check.ts:520-522`), not six. Amend: per-role holder lines (`:1750`) for the five radiology keys (`:1067,1109,1141,1208,1226`) and the six OT keys; or add `ot_incharge_held`, `ot_nurse_held`, `recovery_nurse_held`, `daycare_coordinator_held` rows in E6-M1 (edge #18 already wants `ot_incharge_held`).

### R9 · G-E baseline + E5-M1 acceptance are stale after #164 — a fail-first test cannot fail first · **amend**
On `91c34fc`: `list.resequenced` EXISTS, `resequence` appends it (`lists.ts:213`), `resequenceList` posts `caseIdsInOrder` + `reason` (`ot-api.ts:123`) and the server wants exactly that (`ot-cases.controller.ts:92-95`). G-E's baseline "`resequence` writes no event" and E5-M1's first three acceptance lines describe merged work. What remains true: **0 screen callers** of `resequenceList`; no `planned_start`; LA-only never late; `registry.ts:475`. Amend the baseline row and cut E5-M1 to: `planned_start` 100 %; `/ot/list` calls `resequenceList` (grep ≥ 1); `signIn` on `turnover` refused; `clearTheatre`; `surgeon.late_flagged` for an `npoRequired:false` class.

### R10 · E6-M1 acceptance is already met on main after #157 · **amend**
`docs/runbooks/ot-go-live.md` exists with §0 (`:15`); `standup:check ot` = 6 rows (`:460-522`); `deploy.sh` runs `standup-check.js all` (`:663`) and `seed-ot.js` (`:600`). §0.8's "no OT runbook exists" and "`standup:check` has no `ot` section" were true at `b04cbd9` and are false now. What remains: an `## Executed` section (absent), `ot_workflow_definitions_active` + `ot_definitions_published` ok on UAT (the Class-A ceremony, `:493-518`), and the four missing role rows (R8). Re-cut E6-M1 to that; E6-M3/M4 cite the census codes by name.

### R11 · E5-M2 "alerts-parity count unchanged" contradicts a new 60-s job; E5-M1 "one additive migration" is one short · **amend**
`alerts-parity.test.ts:101-160` pins the exact sorted array and `toHaveLength(18)`; registering the cascade job changes both by construction. Amend: "parity green with the array grown by exactly one name and `alerts.yml`'s interval leg naming it — paste the diff" (E2-M3's "unchanged" is correct: `sweepInterfaceHeartbeats` is already at `jobs.ts:371`). `theatre_fit` (E5-M3) is not in `OT_GATE_KIND_VALUES` (`schema/ot.ts:90-93`) and `ot.test.ts:203` asserts its ABSENCE — a second migration (one per PR) and a deliberately flipped absence test; say both.

### R12 · E3-M1 "`imaging_cloud_region` RED with no partner" — a permanent RED the census forbids; and `partners` has no column to check · **amend**
`standup-check.ts:48-57` defines `NOT MODELLED` precisely so a row is not RED from wk 1–2 to Q1 2027. `partners.ts` (`partner_agreements`, `partner_ref_map`) has no `dpa`/`region`/`deid` column (grep 0), so D16's "all `partners` rows with `dpa_id, region, deid_level`" is a migration E3-M1 must name. Amend: `NOT MODELLED` (→ the store contract section) until a partner row of the image-store kind exists; RED only when such a row lacks `dpa_id` or `region ≠ IN`.

### R13 · G-D "0 machine sentences in `signed`" vs "signed unchanged vs edited" — the schema cannot tell a sentence from a field · **amend**
`provenance` today is `{drafter, version, inputs, at}` per DRAFT (`drafter.ts:51-56`), not per field. A T2 draft signed unchanged (E4-M3) IS machine content in a `signed` version, so "0" is either contradicted or hangs on a distinction nothing encodes. Amend: per-field `provenance{author: 'human'|'model', model, version, input_hash}` (E4-M1's contract); the parameter becomes "0 `signed` versions whose `findings`/`impression` author is a model; per-field signed-unchanged / edited / deleted counts per model version" — R-006's own 90-d edit-distance condition (REG:18). E4-M2's "flag never writes `imaging_reports` (test)" is the T1 form and is sound.

### R14 · E6-M4 "substitutions without reason" reads 100 % forever; "cases without a package" reads 0 forever · **amend**
`anaesthetist.substituted` carries no reason (`ot/events.ts:149-151`); `signIn` derives it and records none (`cockpit.ts:161-182`). `package_service_code` is `.notNull()` (`schema/ot.ts:264`); the real signal is the `bill_not_composable` refusal at discharge (`bill.ts:144-255`; P15 §6.3). Amend: add `reason` to `signIn` + event in **E5-M1**, then harvest it; replace "cases without a package" with "`bill_not_composable` refusals per day".

### R15 · E1-M4 "`device_not_licensed` shown then cleared with `DEMO`"; "dated `## Executed`" — neither mechanism exists · **amend**
`DEMO` = 0 in src/runbooks; `radiation-safety-go-live.md:57`: "There is no seed and no placeholder". The only way to clear the gate on UAT is a human filing an `aerb_licences` row at `/radiology/radiation-safety`. Amend: "a UAT-only row, licence number prefixed `UAT-`, filed by the RSO seat; `GET /aerb/licences/gaps` = [] on UAT". The `## Executed on UAT` section does not exist in `radiology-go-live.md`; E1-M2 adds it (R6).

### R16 · E2-M3 "`interface.down` ≤ 2 min after stopping Orthanc" — three unstated preconditions · **amend**
(a) `INTERFACE_KINDS = ["printer","scanner","other"]` is a zod enum (`interfaces.ts:47,67`) — the PACS row is `other` or the enum is edited; (b) Orthanc never calls HMIS — the bridge must `POST /ops/interfaces/:id/heartbeat` (`ops.controller.ts:314`), so the instrument measures the BRIDGE's liveness; (c) detection ≤ `stale_after_ms` + 60 s sweep: default 180 s gives up to 4 min; ≤ 2 min needs `stale_after_ms ≤ 60 000` (floor 30 000, `interfaces.ts:58-59`; `config.ts:145`). State all three on the row.

### R17 · E7-M1 "`ot/lists.ts` behind 20's flag; flag off: existing `lists` tests green" — `lists.ts` never calls the resolver · **amend**
`usersHoldingRole` appears in `lists.ts` only in a comment (`:26`); Plan 20 :29 says so in as many words. §0.7's "measured" `grep -rln` matched that comment. The OT seam is `publishList`'s anaesthetist assignment (F18/F24g refusal, `lists.ts:24-31`), and Plan 20 T2's parity test is the instrument (`…20-workforce-roster.md:95-96`). Amend: name the seam and that test. E7-M2's "published OPD session" is `opd_doctor_schedules{weekday, start_time, end_time}` (`schema/opd.ts:93-107`) — name the table.

### R18 · E3-M4 "SLA miss → `escalation.triggered` at 15 min (F1)" — that event needs a workflow instance · **amend**
`escalation.triggered{instanceId, defKey, state, rung, …}` is the workflow timer's (`workflow/events.ts:35-45`; `timers.ts:150-168`); a send-out row has none. Nearest real: `lab.sla_breached` from `sweepLabSla` (`lab/events.ts:277`; `jobs.ts:401`). Amend: `imaging.sendout_sla_breached` from a sweep (another parity-array edit), or a send-out workflow definition — say which.

### R19 · E3-M3 "`replica_lag_studies` > 0 then drains" — no source named · **amend**
Nothing on main or in the design says where the number comes from. The design's own register ("each tier move a register row") can supply it: rows with `sent_at` null (or `returned_at` null) per tier. Name that query, or the metric has no producer.

### N1 · G-C "0 ungoverned rows ever" is vacuous once D2 holds · **note**
A table whose CHECK refuses rows without `dpa_id`/`region=IN` always reads 0. The measurable thing is the refusal count (edge #4 names `region_not_permitted`); keep 0 as the invariant and add "refusals per month" as the KPI.

### N2 · Thresholds that are the design's own, unmarked · **note**
"`planned_start`+15", "≥ 80 %", "p95 ≤ 5 / ≤ 15 min", "≥ 90 % acknowledged", "warn at 1 h" (R-168, REG:180, says only "warning before" — no number). All numbers, none "owner is satisfied"; mark each DECIDED.

### N3 · Parameters that reduce toward "tests pass" · **note**
E7-M1 "count pasted" and E6-M2 "`mtp` still absent from the enum" (an existing absence test, P15 §6.3 A5b) — acceptable under CLAUDE.md's evidence rule; flagged so nobody widens them. E2-M2 "unlicensed device absent from MWL (test name)" is **already green** (`mwl.test.ts:166`) — it is a regression pin E2's bridge must keep, not a build; say so.

### N4 · Baseline drift ledger (design → `91c34fc`) · **note**
Header `b04cbd9` → `91c34fc`; "runbooks executed 0/4" → 0/9; `radiology_definitions_active` IS on main (`:603`); #143 MERGED as a doc, so E1-M1's "orchestrator approves #143" is now the owner's/orchestrator's line to BUILD 18a-iv, not a PR approval; a kill switch EXISTS (`agents.kill_switch`, `auth/agents.ts:25`) — E4-M2's "12a's kill switch" has a real precursor: an AI processor registered as an `agents` row is killable today; G-A's "RED count on production not readable": `standup-check` prints and persists nothing, `deploy.sh` writes no log — the count exists only in a terminal transcript, so the north star's "RED = 0 on production by wk 9" needs the `## Executed` line to record it (or a `census.checked` event in 11i).

## 2. Instruments checked and found sound
- E1-M1 D4 refusal test — 18a-iv D4 `requiresIndication` (`…18a-iv…md:70`). Hypothetical, correctly homed.
- E1-M2 `radiology_study_types_active` "ok with no manual seed" — the row's check is `activeStudyTypes(db).length > 0` and its fix is `seed:radiology` (`standup-check.ts:626-637`): Class C, seedable; honest once D15 lands.
- E1-M3 `GET /aerb/licences/gaps` = [] (`aerb.controller.ts:157`); `radiology_rso_appointed` (`:657-665`); the five role keys are real.
- E2-M3 dose SR + manual fallback — `imaging_studies_dose_ck` (`schema:286`) and `dose_manual` provenance (`:276`); `pacs_settings` publish returns an `approvalId` (`definitions.ts:247-262`).
- E4-M1 "`interface.down` < 60 min/month ×3" — `downSince` on `interface.restored` (`ops/events.ts`) makes minutes computable.
- E5-M2 "+25 % of `planned_min` within 60 s" — derivable from `incision` once `planned_min` exists; `in_holding` is a real state (`cockpit.ts:131`).
- E6-M2 `OT-1` + two `daycare_recovery` beds — `seed:ot` (`seed-ot.ts:20-28`; `booking.ts:329`).
- E6-M3/M4 — `timeout.halted`, `count.mismatch`, `late_entry.flagged{reason}`, `gate.overridden{reason}`, `bay_occupied` all real.
- E7-M2 `escalation.triggered.fallbackExhausted = 0` — real (`timers.ts:154`).
- E3-M2 "no `[COUNSEL]` marks" — 8 today; falsifiable; add the baseline number.
- Edge #21 (3 `sweepCriticalChaser` hits + `HmisSchedulerJobMissing` `alerts.yml:69`), #22 (`migrate-watermark.test.ts`), #24 (`radiology_devices_licensed` needs ≥1 device, `:642-656`), G-E's "LA-only never late" (`lists.ts:258-281`) — sound.

## 3. Minimal adds, by home plan
| add | where | unblocks |
|---|---|---|
| `placedVia` on the `POST /radiology/orders` event/audit row | 18a-iv T2 | G-A, E1-M1 (R1) |
| `## 11. Executed on UAT` + `## 12. Harvest` (SQL per row) in `radiology-go-live.md`; `RAD-CD`/`RAD-FILM` in `seed:radiology` | 18a-iv T4 / E1-M2 | E1-M3/M4/M5 (R6, R7, R15) |
| per-role holder lines as the instrument; four OT `*_held` rows | E1-M3, E6-M1 | R8, edge #18 |
| `received_at` on reconciliation; `replica` in `IMAGE_VIEW_CHANNELS` | 18b-ii E2-M2; 18b-iii E3-M3 | G-B (R3) |
| `backup.image_drill_passed` + exporter row + alert leg | 18b-ii E2-M4 | G-C (R5) |
| PACS `interfaces` row: `kind`, heartbeat writer, `stale_after_ms ≤ 60000` | 18b-ii E2-M3 | R16 |
| `partner_agreements.{dpa_id, region, deid_level}` migration; `imaging_cloud_region` as NOT MODELLED until a row exists; `imaging.sendout_sla_breached` sweep | 18b-iii E3-M1/M4 | R12, R18, R19 |
| per-field `provenance{author, model, version, input_hash}` | 18b-iv E4-M1 | G-D (R13) |
| `reason` on `signIn` substitution + event; `theatre_fit` migration + flipped absence test; parity array +1 | 15d E5-M1/M3/M2 | R14, R11 |
| re-cut E5-M1 and E6-M1 to what #164 and #157 left undone | design §1 G-E, §3 | R9, R10 |
