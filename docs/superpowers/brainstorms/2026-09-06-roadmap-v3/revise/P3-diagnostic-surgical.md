# P3 — Diagnostic & surgical orchestration (fibre-to-cloud radiology, AI annotation, 3D volumetrics; dynamic OT) — REVISED

**Measured at `91c34fc` on 2026-09-08 11:32 UTC**; at writing `origin/main` = `41a4be4` = `91c34fc` + #118 (11i T9, no migration). 82 migrations; production `399f92c` at 78 → **4 pending `0078`–`0081`**. #117/#118 MERGED; #119–#122 OPEN, no owner line recorded. Paths relative to `main-ro` (`git show origin/main:<path>` where behind). **REG** `…department-series/00-OWNER-RULINGS-REGISTER.md` · **RM** `docs/superpowers/2026-09-06-ROADMAP-v2.md` · **spec** `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md` · **doc01/15/19** department series · **18b/18c/18a-iii/18a-iv/P15/P20** = `docs/superpowers/plans/2026-09-02-…18b-dicom-seams-no-hardware.md`, `2026-09-03-…18c-radiation-safety-aerb.md`, `2026-09-05-…18a-iii-…`, `2026-09-06-…18a-iv-radiology-ordering-door.md`, `2026-08-28-…15-mini-ot-daycare.md`, `2026-09-06-…20-workforce-roster.md` · **DPIA** `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` — header "0.2 DRAFT, not yet signed" (:3,70-72): "DPIA v0.2" below means the *counsel-signed* one. "Deployed" = in `399f92c`.

## 0. The mission sentences this pillar serves, reconciled with the spec

**3a:** *"replace in-house PACS with fibre … to our cloud for instant AI annotation and 3D volumetric analysis"*. **3b:** *"analyse surgeon availability, OT capacity, procedure type, anaesthesia and equipment needs to auto-schedule and rebalance surgical timelines in real time"*.

1. **"Eliminate in-house PACS" inverts a standing owner ruling** — spec:22-33 (v4.7): on-prem is the end state; WAN-down relies on edge-local DICOM (`00-CROSS-MODULE-CHAOS.md:42`); 18b R1 = on-prem Orthanc (18b:88). **Reconciled:** cloud = offsite tier + AI tier, never the acquisition edge; only NEW-P3-1 (c) reverses v4.7. Stated once because no runbook does: **stage 1 is one Hetzner server outside India; "the DPDP posture for that window is a pre-pilot gate (§19)"** (spec:26,33-34) — E1-M5/E6-M4 inherit it.
2. **"Instant transfer" is procurement plus one parameter.** No link sizing anywhere in the repo; `fibre` appears only as a downtime cause (`apps/web/src/screens/lab-downtime.test.tsx:43`, doc05:369, doc16:369). HMIS measures acquisition→viewable (`modules/radiology/events.ts:66,105`); link and MWL licences are purchases (18b R2 :89).
3. **"AI annotation" is bought, T1 first, T2 forever.** R-008 (REG:20): *"None in 18a/18b; evaluate CXR-triage/stroke tools only as T1 nudges after PACS is stable; bought never built"* — the register's Blocks column says 18b, its text excludes 18b; the letter `18b-iv` is R-008's scope, not 18b's. spec:778 caps clinical at T2–T3; `SpeechClient` is the only inference seam (`kernel/inference/types.ts:32`); 12a excluded (RM:428).
4. **"3D volumetric" has no consumer.** MPR = viewer (OHIF, DECIDED 18b:90); measurement = a vendor product; consumers (40, 48) are behind the IPD gate (RM:398-410). HMIS's part: a provenance-stamped field (`schema/radiology.ts:434`) in a T2 draft a radiologist signs.
5. **The DPIA has never heard of an image** (0 hits). Design law: *"Class 2 never enters an inference request — any stage, any provider, ever"* (DPIA:20); §3-A (:33) is *"the law's single named exception"*. Pixels are Class 2 (header de-id, doc01 J5 :330, is not pixel de-id). **An imaging carve-out is a second exception — the owner's and counsel's, not an addendum's** (NEW-P3-3). R-262 (REG:274) supports per-module revisions; imaging is not on its list.
6. **"Auto-schedule and rebalance" = a rule and an agent.** doc15:468: Overrun Cascade (automation T1→T3, *proposal applied on in-charge accept*, per-agent kill switch, fail-open manual re-sequence); OT List Optimiser (agent T2, Plan 48). Routed to 15d by `docs/superpowers/brainstorms/2026-08-28-plan-15-mini-ot/00-RECORD-AND-PLAN.md:214`. spec:780: automations run under the harness (identity, kill switch, tier).
7. **Availability and equipment are substrates — corrected.** `usersHoldingRole` call sites: `kernel/alerts/consumer.ts:179,229,266,300,322`, `kernel/workflow/timers.ts:148,153`, `kernel/notify/consumer.ts:230` (P20:28); **`modules/ot/lists.ts:26` is a comment** (P20:29); RM:279-281's "five" counted it. The OT's seam is `publishList` refusing an item without an assigned anaesthetist (`lists.ts:24-31`, F18/F24g) and `signIn`'s substitution (`cockpit.ts:171-182`). `device` is **radiology's** kind (`modules/radiology/kinds.ts:51-56`: `available|in_use|down|qa_blocked|maintenance|retired`); `ot/kinds.ts:47-49` leaves it unclaimed; 18c's licence gate already covers the C-arm (`aerb/manifest.ts:9`, `aerb/units.ts:10-11`).
8. **Absorption binds harder than building.** Nine runbooks, **0/9 executed** (only `pharmacy-go-live.md:257` has `## Executed` — NOT YET RUN). #157 landed `docs/runbooks/ot-go-live.md` §0–§9 and six `ot_*` census rows (`scripts/standup-check.ts:460-522`); `docker/prod/deploy.sh:600` runs `seed-ot.js`, `:663` runs `standup-check.js all`. `radiology-go-live.md` = §0–§10, no Executed; `deploy.sh` never runs `seed:radiology` (`standup-check.ts:627-632`). The census prints and persists nothing (`:700-712`): a RED count exists only where a runbook's Executed line records it.

## 1. Goals — each with a north-star parameter

| # | goal | parameter · instrument | baseline (`91c34fc`) | target | reader |
|---|---|---|---|---|---|
| G-A | **Radiology opens through a door, not a curl** | `standup:check radiology` RED rows (`standup-check.ts:603-665`) · `radiology-go-live.md` `## 11. Executed on UAT` dated · `placedVia='reception'` on the `POST /radiology/orders` event (to add, 18a-iv T2 — `order.placed` has no channel, `kernel/orders/events.ts:48-58`; `actor_type` reads `user` for a curl); until then `grep -rl "/radiology/orders" apps/web/src --include=*.tsx --exclude=*.test.tsx` (a bare `/orders` grep matches `lab-api.ts:248`) | RED count persisted nowhere · 0 `/radiology/orders` callers; every walked study was curl (`plans/reports/2026-09-06-radiology-commissioning-walk.md:237`) · runbooks 0/9 | RED = 0 on production by wk 9, written in §11 · §11 dated on UAT by wk 6 · 100 % `placedVia='reception'` | S lane |
| G-B | **Instant transfer, measured** | p95 `received_at` (E2-M2, to add) → first `imaging_image_views.viewed_at` (`views.ts:14-37`); interim: console-typed `acquired_at` (`acquisition.ts:428`) → view, excluding `late_entry` · replica leg only once `replica` joins `IMAGE_VIEW_CHANNELS` (`schema/radiology.ts:589,605`; E3-M3) · "signed unopened": IST days with ≥ 1 `report_published` and 0 `image_viewed` · MWL `withheld` (`mwl.ts:95-97`) | not measurable: `pacs_settings` unpublished, 0 view rows, no Orthanc, `study_acquired` unconsumed (18b:21); every reporting day reads unopened | p95 ≤ 5 min in-house, ≤ 15 min replica · 0 unopened days after E2-M3 | radiology in-charge |
| G-C | **Every byte that leaves carries processor, DPA, de-id level** | refusals/month on `imaging_sendouts` insert as KPI; 0 ungoverned rows as the CHECK invariant · `backup.image_drill_passed{studiesRestored}` age (to add, E2-M4 — `backup.drill_passed` is a Postgres census, `kernel/retention/events.ts:120`, exporter `docker/prod/postgres-exporter/queries.yml:71`) · `imaging_cloud_region` NOT MODELLED until a processor row exists | no register (0 `sendout|teleradiology`); 0 studies leave; drill covers Postgres only | 0 ungoverned rows · image drill monthly once E2 is live · census green before the first send-out | owner as Data Fiduciary (DPIA:72) until a DPO exists (:63) |
| G-D | **A machine proposes, a human signs, the delta is counted** | `imaging_ai_flags{product, version, input_hash, output_hash}` agreed/dismissed/unacknowledged · per-field `provenance{author: human|model, model, version, input_hash, output_hash}` (E4-M1; today per-draft `{drafter, version, inputs, at}`, `drafter.ts:51-56`, written by nobody) | no flag table; 0 provenance rows | ≥ 90 % flags acknowledged in window · 0 `signed` versions with a model-authored `findings`/`impression` · per-field unchanged/edited/deleted per model version (R-006, REG:18) | radiologist of record |
| G-E | **The OT day is timed; delay is answered by a proposal** | `case.overrun_projected` → proposal ≤ 60 s · proposals accepted/edited/rejected per week · first-case on-time (`wheel_in` ≤ `planned_start`+15, LA-only included) | `list.resequenced{listDate, theatreResourceId, caseIdsInOrder, reason}` **exists** and `resequence` emits it (#164; `ot/events.ts:136-140`, `lists.ts:213`); `resequenceList` posts that shape (`ot-api.ts:123`) and **no screen calls it**; no `planned_start` (`schema/ot.ts:241-299`); LA-only never late (`lists.ts:258-281` reads only the NPO gate's typed start, `gates.ts:66-74`); no overrun/npo/theatre events (`OT_EVENTS` :236) | 100 % of post-15d cases carry `planned_start` · 100 % of +25 % overruns → proposal ≤ 60 s · first-case on-time ≥ 80 % | OT in-charge |

## 2. Epics

**E1 — The door and the opening (radiology G1–G6).** Home **18a-iv** (#143 MERGED as a DOC, "NOT APPROVED, NOT EXECUTED"; §7 "None" :119-123; code HELD for the owner's line) + `radiology-go-live.md` (#140) + **18a-v** (new letter: the contrast-reaction seat and the machines door — 18a-iv §6:108-113 excludes the reaction by name, *"the reaction is the one to schedule next"*; runbook §5:145-155: adding a machine is *"a deployment act, not a hospital one"*). Exists: 18a (`0047`, `0050`–`0052`), 18b seams (`0053`/`0054`), 18c live, 18a-iii T1–T4 (`0073`, `0075`–`0077`), chasers `0078`, `GET /aerb/licences/gaps` (`aerb.controller.ts:157`), `POST /radiology/contrast-reactions` (`radiology-acquisition.controller.ts:221`, 0 web callers), `/radiology/reception` (`router.tsx:809`). Build: 18a-iv T1–T4 + `placedVia`; **Class-C only** `seed:radiology` in `deploy.sh` (never the five-device fleet of `seed-radiology.ts:80-84`); `RAD-CD`/`RAD-FILM`; runbook `## 11`/`## 12`; 18a-v. Everyone-files: `deploy.sh`, `standup-check.ts` (S owns; after #158), `router.tsx` + `locales/*.json` (18a-v). Depends: the owner's 18a-iv line; 11i T3 (#120); the weekly deploy by his hand.

**E2 — The edge PACS the mission will not name (18b-ii).** Contents 18b §6:82-84; `radiology-pacs-go-live.md` §6. Exists: MWL with Form-F withholding (`mwl.ts:95-97`; regression pin `mwl.test.ts:166`), viewer door (`views.ts:14-37`), `pacs_settings`. Absent: any DICOMweb/STOW/WADO code, Orthanc/OHIF dependency, consumer of `study_acquired`. Build: Orthanc + worklist dir + bridge; reconciliation writing `received_at` + `study.unmatched`; dose SR with manual fallback; RBAC bridge; **Orthanc as an `interfaces` row, `kind: other`** (`INTERFACE_KINDS` = printer|scanner|other, `kernel/ops/interfaces.ts:46`; the bridge posts `POST /ops/interfaces/:id/heartbeat`, `ops.controller.ts:314`; `stale_after_ms ≤ 60000`, floor 30000 :58-59 — a row plus a poster, **no kernel change**, `registerInterface` :129); `backup.image_drill_passed` + exporter row + `alerts-backup.yml` leg; Forecaster T0; census `pacs_reachable`, `unmatched_today`, `bridge_role_clean`. Gates: 11b + 18b R1–R3 gate the **build** (E2-M2), not the authoring; E1-M4 dated. UAT cost (a second container pair on the 15 GB box) in E2-M1's ruling row.

**E3 — Cloud as the governed offsite (18b-iii, new letter).** "Our cloud" = an India-region object store for Tier 2/3 (doc01:184, O-9 :578); R-001 teleradiology proves the legal machinery. Exists in code: nothing. Build: **`imaging_processors{kind: store|teleradiology|ai, dpa_id, region, deid_level, status}` — its own table, NOT `partners.counterparties`** (a `payeeClass` commission book, CHECK `in ('channel_partner','staff_internal','external_rmp')`, `schema/partners.ts:59-81`; no dpa/region/deid column exists); `imaging_sendouts` (doc01:174) + `study.sent_out`/`external_reported`; permitted-region config row seeded `['IN']`; `replica`/`remote` in `IMAGE_VIEW_CHANNELS`; `imaging.sendout_sla_breached` from `sweepCriticalChaser`'s tick; remote reads in-app only; census `imaging_cloud_region`; offsite restore drill. Depends: **E1-M4 dated** (series content waits for the opening — RM §5:414, §0c.5:176-181); NEW-LAW-1; E2 for M3+.

**E4 — Machine reads as drafts (18b-iv, new letter).** T1: a bought CDSCO-licensed product's output = worklist hint + `imaging_ai_flags` row; T2: structured measurements as provenance-stamped draft fields. **Locus (D23): on-prem appliance behind Orthanc** (R-126 REG:138, R-254 :266 — Class 2 cannot default weaker than Class 1); a cloud processor additionally needs a DPA row. Even on-prem, pixels entering an inference request need the **carve-out to DPIA:20** (NEW-P3-3). **Shape: pull** — HMIS polls the appliance; kill = config flag `radiology.ai_flags_enabled` (the `retentionEnabled` precedent, `kernel/worker/jobs.ts:145,308,351`); push (processor as agent) waits on 12a (`guards.ts:98-101`: "agents hold no permissions yet"). Gates: E2 stable ≥ 90 d; DPIA v0.2 signed + NEW-P3-3; CDSCO; **0 production studies in the evaluation**; shadow before live (copilot:128, DPIA:48); owner approves T1→T2 (spec:789, DPIA:62).

**E5 — The list that knows the time (15d).** P15 DD18 :184; record :214. Exists: versioned lists + human publish (`lists.ts:103`); `resequence` emitting `list.resequenced` (#164); `flagLateSurgeons` at 60 s (`jobs.ts:260-262`); `onRelease: turnover` (`ot/kinds.ts:61`); `returnTheatreToService` for `blocked` only, in-charge only (`cockpit.ts:600-623`; `ot-cockpit.controller.ts:230-231`); `gate.overridden` + `ot.gates.override` (`ot/events.ts:168`; `ot-cases.controller.ts:25-27,213`); three `cArm: true` classes (`definitions.ts:93,500-510`); `theatre_fit` absent **and asserted absent** (`schema/ot.ts:88-90`; `schema/ot.test.ts:203`). Open defect: `registry.ts:475` admits `onRelease` for assignment, so `signIn` walks into an uncleared theatre. Build: `ot_list_items(planned_start, planned_min)`; `ot_resequence_proposals{list_date, theatre_resource_id, proposed_order, reason, status, actor_id, decided_by}` — **no `version`** (#164, `ot/events.ts:132-134`); events `case.overrun_projected`, `npo.at_risk`, `npo.extended`, `theatre.blocked/cleared`; the cascade **inside `flagLateSurgeons`' tick, module-local** (D24 — `jobs.ts`, `alerts.yml`, `alerts-parity.test.ts:160` untouched); `ot.cascade_enabled` config row, default off, evented; `clearTheatre` + `signIn` refusal (no `registry.ts` edit); `reason` on substitution; `theatre_fit` in its own migration; env block; two-actor evented override on the env block and the `turnover` clear. Tier: automation T1→T3 under the flag; no inference (DPIA:5's trigger unmet; RM:410).

**E6 — The mini-OT opens (Plan 15 G1–G6).** Exists after #157: runbook §0–§9, six `ot_*` rows, `deploy.sh` running `seed:ot` + census; `OT-1` + two bays (G2); Class-B seeds as drafts; six roles with zero holders (`ot/manifest.ts:35-37`). **The ceremony** (`ot-go-live.md` §2:65-99): `opd_admin` drafts (`workflow.definitions.draft` = `opd_admin` only); `medical_superintendent` + `owner` approve as two distinct *people*; **the owner activates** (`activate` = `owner` only) and **must not be the drafter** (`workflow_drafter_activator`, :57-62) — twice, for `daycare_case` and `ot_gate` (Class A, started by every booking: `booking.ts:178,280`). Production has two governance humans (`approval-types.ts:30`): **a third, holding `opd_admin` and not the owner, is a precondition** (F4). Residual: `## Executed`; rows `ot_incharge_held`, `daycare_coordinator_held`, `ot_nurse_held`, `recovery_nurse_held` (runbook §6 lists six; census checks two, :520-522), `ot_daycare_package_per_class`, `ot_recovery_bay_present`. Gates: R-170 approvers + O6 (G3); R-237 for gynae — **ortho first**; six names (G4). Depends: the owner's 11i line (T3/T5); F4.

**E7 — Availability into the list.** Home **15d**: the OT's consumer of P20's `whoIsOn(tx, roleKey, at)` (P20:95-96) — **NEW code, not "inside 20"** (P20 T3 :100-102 moves three kernel call sites, none in `ot`; P20 §6/§7 name no OT consumer). Exists: `surgeonId` checked only against privileges (`booking.ts:104-122`); F18 refusal; substitution; `opd_doctor_schedules` (`schema/opd.ts:92-107`). Build: publish-time roster check behind 20's flag honouring **P20 D2** (:68-70 — flag off *or no published roster covering the instant* → exactly today); mismatch → `roster.override{by, reason, expires}` by `ot_incharge`, evented (R-072's shape, REG:84) — **not a refusal**; `surgeon_clash` warning; on-call ladder as a config row; F3's 07:00 drill. Depends: the owner's Plan 20 line; 20 T2 merged + flag; E6-M3 dated.

## 3. Milestones

**Owner lines every row inherits:** (i) the **11i approval line** (lands #119–#122, hence UAT) — E1-M1, E1-M4, E6-M1, E6-M3; (ii) the **18a-iv approval line** — E1-M1; (iii) the **Plan 20 approval line** — E7. Ids `P3-diagnostic-surgical-E<n>-M<m>`; size = lane-days.

### E1 — the door and the opening
| id | name | gate | acceptance | depends_on | size | human act |
|---|---|---|---|---|---|---|
| E1-M1 | 18a-iv T1–T2 + `placedVia` | build | `/radiology/orders` `.tsx` callers ≥ 1 (0 today) · `imaging.study_scheduled` on UAT with `placedVia='reception'` · no-indication order refused (18a-iv D4 :70) | 11i T3 | 4 d | owner's 18a-iv line |
| E1-M2 | T3 walk-in; T4 census + runbook §11/§12; Class-C seed in `deploy.sh`; `RAD-CD`/`RAD-FILM` | G2 | fresh UAT deploy: `radiology_study_types_active` ok with no manual seed; `radiology_device_present` RED (no fleet seeded) · walk-in `scheduled` from reception · `## 11. Executed on UAT` (pharmacy's table, `pharmacy-go-live.md:259-262`) + `## 12. Harvest` with one SQL per row · `radiology-pacs-go-live.md:3` "NOT DEPLOYED" corrected | E1-M1 | 4 d | none |
| E1-M3a | G4 names | G4 | five keys (`seed-roles.ts:1067,1109,1141,1208,1226`) each `≥ 1 holder(s)` on its own line (`:1750`; READY is hospital-wide, `:1717-1725`, NOT READY while OT roles are empty) | weekly deploy with `0078`–`0081` | 1 d S | **owner names radiologist, RSO, physicist, radiographer(s), receptionist (F4, wk 4)** |
| E1-M3b | G3 certificates + prices | G3 | `GET /aerb/licences/gaps` = `[]` · `radiology_rso_appointed`, `radiology_definitions_active` ok · an active tariff prices `RAD-CD`/`RAD-FILM` (R-004) · 18c R3 entered by the RSO | E1-M3a | 1 d S | **owner files certificates (NEW-LAW-2, wk 7); rules R-004** |
| E1-M4 | Runbook executed on UAT (S-gate) | G5 | dated `## 11` with an event id per §9 step · drills: `critical_overdue` fired + acknowledged; `device_not_licensed` shown, cleared by a **human-filed UAT-only `aerb_licences` row prefixed `UAT-`** (no seed exists, `radiation-safety-go-live.md:57`); `gaps` = `[]` on UAT · `standup:check radiology` exit 0, count written in §11 | E1-M2, E1-M3a | 2 d | radiologist + radiographer sit the seats |
| E1-M5 | Pilot, paper authoritative | G6 | 7 days with the last three harvest rows empty: `image_source='no_pacs_images'` on a device with `aeTitle`; `acknowledged_at is null` at 07:00; `first_read_at is null` > 24 h ("studies with no order" dropped — impossible by `order_item_id notNull unique`, `schema/radiology.ts:149`) · spec:839 posture named | E1-M4, E1-M3b, E1-M6 | 10 d elapsed | department head reads the harvest |
| E1-M6 | 18a-v: reaction seat + machines door | build | `POST /radiology/contrast-reactions` web callers ≥ 1 · a `device` row created and `retired` from a screen (today `seed:radiology` is the only writer, `standup-check.ts:635-640`) · `router.tsx` + locale keys named in the PR | E1-M1 | 3 d | none |

### E2 — 18b-ii edge PACS
| id | name | gate | acceptance | depends_on | size | human act |
|---|---|---|---|---|---|---|
| E2-M1 | 18b-ii authored (authoring only) | build | phase doc on `main`; §7 names 11b/R1–R3 with the default + the UAT Orthanc's memory; no `docker/prod` diff | E1-M4 | 3 d | none |
| E2-M2 | Orthanc at the facility; MWL pulled; first study reconciles | G2 | **NEW-P3-1 + 18b R1–R3 ruled** · pull by a `modality_bridge`-only user with `withheld: 0, malformedAeTitle: []` · one `image_source='pacs'` study with `received_at` persisted · `study.unmatched` on an injected off-book study · `mwl.test.ts:166` still green | E2-M1, E1-M3b | 8 d | S racks the box; vendor engineer sets the AE title |
| E2-M3 | Viewer, dose SR, heartbeat, Forecaster | G3 | `image_viewed` ≥ 1 per drill shift · `pacs_not_configured` (`views.ts:70-73`) gone after `pacs_settings.enabled=true` (approval id) · dose SR on a CT; manual dose mandatory when absent · Orthanc `interfaces` row `kind='other'`, bridge heartbeats, `stale_after_ms=60000` → `interface.down` ≤ 2 min after stopping the bridge · parity unchanged at 18 · Forecaster headroom line | E2-M2 | 6 d | none |
| E2-M4 | Image-tier drill and the p95 | G1 | `backup.image_drill_passed{stanza, studiesRestored}` + exporter row + `alerts-backup.yml` leg · p95 `received_at → first image_viewed` ≤ 5 min over the pilot week (SQL) · `pacs_reachable`, `unmatched_today` green | E2-M3, E1-M5 | 3 d | radiologist reads in-system for a week |

### E3 — 18b-iii governed cloud
| id | name | gate | acceptance | depends_on | size | human act |
|---|---|---|---|---|---|---|
| E3-M1 | Outbound register built, empty, enforced | build | one migration: `imaging_processors` + `imaging_sendouts` + region config row seeded `['IN']` · `study.sent_out` refused without `dpa_id` or with a region outside the set (test asserts the seeded default) · `imaging_cloud_region` **NOT MODELLED** with no processor row; RED only when a row lacks `dpa_id` or has `region ∉ set` · 0 rows on production | E1-M4 | 4 d | none |
| E3-M2 | NEW-P3-3 signed; contracts | law + procurement | carve-out + addendum in `docs/compliance/` with a signed table (`[COUNSEL]`: 8 today → 0 there) · lawful basis mapped + **patient notice text on file** (DPIA §4 :37) · `dpa_id` on store and partner rows · retention row per tier | E3-M1 | 1 d draft | **counsel signs (NEW-LAW-1); owner accepts the Class-2 carve-out, signs store DPA + R-001** |
| E3-M3 | Tier 2/3 replica; offsite restore; remote reads | G1 | compose diff for the S3 plugin · one register row per tier move · offsite restore of one study (drill log) · WAN-cut drill: E2 parameters hold; `replica_lag_studies` = register rows with `tier_moved_at is null` > 15 min, > 0 then drains · `replica`, `remote` in `IMAGE_VIEW_CHANNELS` (migration) · remote reads in-app over VPN/MFA, watermarked, no device cache, `image_viewed{via:'remote'}` | E3-M2, E2-M3 | 5 d | none |
| E3-M4 | First send-out on UAT, then the dormant contract | G5 | `study.sent_out{deid_level}` → `study.external_reported` round-trip · `imaging.sendout_sla_breached` at 15 min from `sweepCriticalChaser`'s tick · cost per activation on the row · Red phone-back resolves the token in-house; the countersign is a **read** (doc01:83) | E3-M3 | 5 d | **duty manager activates on the pre-authorised trigger** |

### E4 — 18b-iv machine reads
| id | name | gate | acceptance | depends_on | size | human act |
|---|---|---|---|---|---|---|
| E4-M1 | Phase doc: T1 contract; product pinned; evaluation set named | ruling + law | doc on `main` · `imaging_ai_flags` shape (product, version, input + output hash) · per-field `provenance` contract · CDSCO status + version as a register row · evaluation set = UAT with public/synthetic DICOM **or** a counsel-approved de-identified retrospective set under a DPA; **0 production studies reach the evaluated product** | E2 stable 90 d (`interface.down` < 60 min/month ×3, minutes from `downSince`) | 3 d | **owner funds the evaluation (R-008); counsel confirms SaMD** |
| E4-M2a | Shadow: flags logged, never shown | DPIA | after every E4-M2 gate is signed (copilot:128 — shadow is after gates, never a pre-gate lane): flags written `shown=false`, scored against signed reports over ≥ N studies; calibration record on `main` | E4-M1, DPIA v0.2 signed + NEW-P3-3, CDSCO | 3 d + 30 d | radiologists read as today |
| E4-M2 | T1 nudge live | DPIA | `radiology.ai_flags_enabled=false` → 0 `ai_flag_raised` within one sweep (drill) · flag never writes `imaging_reports` (test) · appliance down → worklist unchanged (drill) · flag visible only on the radiologist worklist (per-role test) · acknowledgement ≥ 90 % · R-262 AI-assisted-care notice on file | E4-M2a | 6 d | **owner accepts the calibration record + notice** |
| E4-M3 | T2 structured measurements as drafts | IPD gate | every field carries `provenance{author, model, version, input_hash, output_hash}` · unchanged/edited/deleted per field per version · 0 `signed` versions with a model-authored `findings`/`impression` · a consuming clock reads the field (40 stroke; 48 implant) | E4-M2; 40 or 48 live | 8 d | **owner approves the T1→T2 promotion on the calibration record, evented**; radiologist signs under 2FA |

### E5 — 15d
| id | name | gate | acceptance | depends_on | size | human act |
|---|---|---|---|---|---|---|
| E5-M1a | Seam residue: the screen, the theatre that clears, the reason | build | `/ot/list` calls `resequenceList` (`.tsx` grep ≥ 1) · `signIn` on `turnover` refused `theatre_not_cleared`; `clearTheatre` writes `theatre.cleared` + history row `turnover → available`; two-actor evented override with evidence · `anaesthetist.substituted` + `signIn` carry `reason` · no `registry.ts` edit | E6-M3 | 3 d | none |
| E5-M1b | Planned starts | build | `ot_list_items` migration · `planned_start` non-null for 100 % of cases on lists published **after** the deploy (edge 30) · `surgeon.late_flagged` for an `npoRequired:false` class (test) | E6-M4 | 3 d | none |
| E5-M2 | Overrun Cascade T1→T3 under a flag | build | `ot.cascade_enabled` config row, default off, change evented · `case.overrun_projected` at +25 % of `planned_min` within 60 s inside `flagLateSurgeons`' tick; `alerts-parity.test.ts:160` unchanged at 18, count pasted · proposal `open` with a system `actor_id` + `npo.at_risk{basis:'projected'}` (no time) ≤ 60 s · accept → `resequence` → `list.resequenced{reason:'overrun'}` → `npo.extended` with a time; reject → `rejected` + reason · nothing `in_holding` or later moves (test) · flag off → 0 proposals; in-charge resequences by hand (drill) | E5-M1a, E5-M1b | 5 d | in-charge accepts/edits/rejects on the UAT drill |
| E5-M3 | Equipment and environment as blocks | G3 | `theatre_fit` in its own migration, `schema/ot.test.ts:203` flipped deliberately · gate open for `cArm: true` while the C-arm `device` is `down|qa_blocked|maintenance`; inherits `gate.overridden` · `theatre.blocked{env}` from a typed out-of-range reading; cleared after 30 min in-range + in-charge, or the two-actor override · R-168 warn 1 h, block 2 h, **armed by the first reading** (edge 28) | E5-M1b; E1-M6 (device door) | 5 d | OT nurse types readings until sensors (R-206) |
| E5-M4 | The charge side | ruling | bands priced from `ot_cases` timestamps (R-164) · opened-kit charged by attribution (R-165) · both evented; bill composes on UAT | E5-M1b | 4 d | **owner rules R-164/R-165** |

### E6 — the mini-OT opens
| id | name | gate | acceptance | depends_on | size | human act |
|---|---|---|---|---|---|---|
| E6-M1 | What #157 left: the Class A ceremony on UAT; six rows | G2, G3 | `daycare_case` + `ot_gate` **active on UAT** via §2 (drafter ≠ activator; two distinct approving people) — `ot_workflow_definitions_active` ok · `criteria` + `privileges` active (`ot_definitions_published` ok) · rows `ot_incharge_held`, `daycare_coordinator_held`, `ot_nurse_held`, `recovery_nurse_held`, `ot_daycare_package_per_class`, `ot_recovery_bay_present` on `main`, after #158 | 11i T3/T5 | 2 d | `opd_admin` (not the owner) drafts; MS + owner approve; **owner activates** |
| E6-M2 | Staffed and loaded (ortho first) | G3, G4 | six OT keys each `≥ 1 holder(s)` on its own line · one `daycare_package` per whitelisted ortho class (placeholders on UAT) · `mtp` absent from the enum (existing absence test) | E6-M1 | 2 d | **owner names the six + the `opd_admin` drafter + a night clearer (F4); R-170: owner + ortho HOD approve the whitelist before production activation** |
| E6-M3 | Seat drill on UAT (S-gate) | G5 | dated `## Executed on UAT` in `ot-go-live.md`: one synthetic case booking→discharge with every gate `satisfied`, one `timeout.halted`, one `count.mismatch`, one `late_entry.flagged`, one substitution — each with its event id · `standup:check ot` exit 0 | E6-M2 | 2 d | surgeon, anaesthetist, OT nurse, recovery nurse, coordinator sit the seats |
| E6-M4 | Production pilot | G6 | 7 days empty: `gate.overridden`, `bill_not_composable`/day (100 % until O6 — edge 31), `bay_occupied` refusals, `late_entry` > 10 % (substitutions-without-reason after E5-M1a) · spec:839 posture named | E6-M3; O6; R-170 approval ids | 10 d elapsed | department head reads the harvest |

### E7 — availability into the list
| id | name | gate | acceptance | depends_on | size | human act |
|---|---|---|---|---|---|---|
| E7-M1 | The OT's first read of 20's resolver | build | flag off, or no roster covering the instant: publish exactly as today (P20 D2; P20 T2's parity test named) · flag on + roster: a listed anaesthetist off the day's roster → `roster.override{by, reason, expires}` required, evented; the on-call named · F18's refusal unchanged | P20 T2 merged + flag; E6-M3 | 2 d | none |
| E7-M2 | Surgeon clash warning; on-call ladder as config | build | `surgeon_clash` on a booking overlapping an `opd_doctor_schedules` session (test) · re-review resolves `assigned → on-call → in-charge` from a config row · `escalation.triggered.fallbackExhausted` = 0 on the drill day | E7-M1, E5-M2 | 3 d | in-charge publishes a week's roster on UAT |
| E7-M3 | The 07:00 unreachable anaesthetist (doc15 F3) | G5 | drill: assigned unreachable → on-call rung → `anaesthetist.substituted{reason}` with the on-call id | E7-M2 | 1 d | two anaesthetists sit the drill |

## 4. Edge cases — the Indian day this pillar must survive (11i §2b shape)

| # | the day | expected behaviour | artefact | milestone |
|---|---|---|---|---|
| 1 | Certificates arrive wk 7 for CT + one DR; mammography renewal "filed, awaiting" | CT/DR acquire; mammo refuses `device_not_licensed` until a filed-renewal acknowledgement lifts it 90 d (R-007); MWL withholds and counts | `gaps` = 1 row; MWL `withheld: n` | E1-M3b |
| 2 | Paper slip "CT brain — ?stroke", no indication typed | the seat cannot order without an indication (D4) | refusal test | E1-M1 |
| 3 | Fibre cut 10:05 mid-CT | modality stores; Orthanc receives; in-house reads continue **through the viewer door** (a viewer talking to Orthanc directly is ungoverned and uncounted); replica lags; banner `uplink: down since 10:05` | `interface.down` for the store, not the PACS; `replica_lag_studies` > 0; `image_viewed` continues | E3-M3 |
| 4 | Vendor offers a non-India region at half price | `study.sent_out` refused `region_not_permitted`; census RED only because a processor row carries that region | refusal test; census row | E3-M1 |
| 5 | AI says "no ICH"; the radiologist finds one | flag row `disagreed`; the report is the radiologist's | `ai_flag_disagreed`; 0 model-authored `signed` fields | E4-M2 |
| 6 | AI result before any human read, 02:00, ED asks | **ED sees nothing from the machine**; a human prelim, if any, shows UNVERIFIED (R-011; `schema/radiology.ts:105`); the flag lives only on the radiologist worklist | per-role visibility test | E4-M2 |
| 7 | A DICOM study in Orthanc with no HMIS order | `study.unmatched` within one sweep; no report opens on it | event; `unmatched_today` | E2-M2 |
| 8 | The bridge is "temporarily" given `radiographer` | the pull works with `modality_bridge` alone; a bridge holding a clinical role is census RED | `bridge_role_clean` | E2-M2 |
| 9 | Partner phones back a Red finding on a tokenised name | token resolves in-house for the on-call radiologist; the partner never sees the UHID | `external_reported` + critical row | E3-M4 |
| 10 | Case 1 runs +40 %; case 3 patient NPO since 06:00, now 14:00 | `overrun_projected` at +25 %; proposal + `npo.at_risk{projected}` (no time); **`npo.extended` with clear-fluids-until only after the in-charge accepts**; dehydration flag at 8 h | 2 artefacts ≤ 60 s; the third after accept | E5-M2 |
| 11 | Surgeon 45 min late for an LA-only ganglion | `surgeon.late_flagged` +15/+30 from `planned_start` | events for an `npoRequired:false` class | E5-M1b |
| 12 | Re-sequence at 19:30; the ward holds the 18:00 printout | `list.resequenced` (the shipped name; doc19:215/spec:454 use older names); reprint prompt | event + `print_jobs` row | E5-M1a |
| 13 | Death on table 15:10 | theatre `blocked(incident)`; rest of list postponed `theatre_held`; in-charge clears with reason | `death.on_table_recorded`; `theatre.cleared` | E5-M1a |
| 14 | Cascade proposes moving case 4 forward; the patient is pre-medicated in holding | a case `in_holding` or later is immovable by any proposal | transition-guard test | E5-M2 |
| 15 | C-arm warm-up failure 08:40; two C-arm cases and one hernia listed | only `cArm: true` cases block; the hernia proceeds | gate rows per case | E5-M3 |
| 16 | AHU down, humidity 75 %, one case open | `theatre.blocked{env}`; the open case completes; next sign-in refused until 30 min in-range + in-charge, **or the two-actor override with evidence** | block row; override event | E5-M3 |
| 17 | 03:00 emergency insert; no duty manager for a T3 accept | on-duty anaesthetist is the dead-end for inserts (D21); the cascade proposes nothing without a human | ladder test | E7-M2 |
| 18 | **Session:** 15d merges the `turnover` refusal; nobody holds `ot_incharge` on production | rule 4: the clear route ships one deploy before the refusal, or `ot_incharge_held` is RED and the phase doc says which | phase doc §4 line; census row | E5-M1a / E6-M1 |
| 19 | **Session:** 18b-ii authored Sunday night; 11b unruled | stop at the ruling: §7 names 11b/R1–R3 with the default; no `docker/prod` diff before R1 (the `deploy-blocker` label exists) | §7 row; label | E2-M1 |
| 20 | **Session:** a lane reads `radiology-pacs-go-live.md:3` "NOT DEPLOYED" and plans a first deploy of `0053` | measure `git ls-tree <deployed sha> apps/core/drizzle` + the applied count; fix the line in the same PR | SHA in the report header | E1-M2 |
| 21 | **Session:** the weekly deploy carries `0078`–`0081`; production's `alerts.yml` (`399f92c`) lacks `sweepCriticalChaser`, `main`'s has 3 hits | rules and worker land in ONE deploy; `HmisSchedulerJobMissing` may fire during the restart and clears within one scrape | runbook line; alert transcript | E1-M3a |
| 22 | **Session:** a lane's untracked migration serial collides | serials at rebase; `0078` stays above the watermark (`migrate-watermark.test.ts`) | journal diff | E1-M3a |
| 23 | Night read from home over 4G | in-app over VPN/MFA only, `image_viewed{via:'remote'}`, watermark, no device cache, **never a messaging app** (spec:647 fix 35; doc01 J3 :328); a lossy preview is `preliminary` | `image_viewed{via}`; `prelim` | E3-M3 |
| 24 | `radiology_devices_licensed` ok with no devices | impossible: the row needs ≥ 1 device (`standup-check.ts:642-656`) | test name | E1-M2 |
| 25 | A processor returns a flag for a `study.unmatched` study | held, never shown | refusal test on `imaging_ai_flags` insert | E4-M2 |
| 26 | The seed's fleet vs the hospital's: `seed:radiology` would seed XR-1…MMG-1; the hospital owns no mammography unit | the deploy seeds Class C only; devices via 18a-v's door or the runbook; `radiology_device_present` RED names it | census row; seed diff | E1-M2 |
| 27 | The weekly deploy re-runs `seed:radiology` after the MS published v3 | `alreadyActive`; versions unchanged (#153/#166 fixed the re-draft; the class needs a row) | transcript | E1-M2 |
| 28 | The 15d deploy lands at 18:00; nobody types an env reading | R-168 arms on the **first** reading; until then `ot_env_reading_present` is NOT MODELLED and the phase doc states rule 4's choice | census row; phase doc line | E5-M3 |
| 29 | Three `cArm: true` classes on a production with no C-arm `device` row | `theatre_fit` satisfied-by-absence with `ot_carm_device_present` RED — never a refusal for a machine the system has never heard of | census row; gate test | E5-M3 |
| 30 | Lists published before 15d carry null `planned_start` | "+25 % of `planned_min`" computes only for post-migration lists; D8's NPO fallback is the artefact | SQL scoped to `published_at > deploy` | E5-M1b |
| 31 | First ortho discharge before O6 prices land | `bill_not_composable` (8 throws, `bill.ts`) is expected, not a defect; the harvest row reads 100 % until O6 | harvest note | E6-M4 |
| 32 | `interface.down` on a production with no Orthanc | benign: a row never `up` never goes down (`interfaces.ts:20-21`) | none | E2-M3 |
| 33 | `admin` drafts `daycare_case` because nobody else holds `opd_admin` | `activate` refuses `workflow_drafter_activator`; draft discarded; the phase doc names the third human first (`ot-go-live.md:57-62`) | refusal transcript | E6-M1 |
| 34 | 20's flag on; a Sunday with no roster row for the date | publish exactly as today (P20 D2); `escalation.triggered` names the missing roster | parity test | E7-M1 |

## 5. DECIDED — and RULINGS

**DECIDED (Indian-corporate-hospital standard):**
- D1 [E2/E3] **Standing ruling spec §1 v4.7 upheld**: cloud = offsite + AI tier; acquisition on-prem; reversal only by NEW-P3-1 (c).
- D2 [E3] The register is built before any contract; the permitted-region set is a **config row seeded `['IN']`** (spec:33-34 admits a non-India host at stage 1; R-254 unruled), never a literal.
- D3 [E4] T1 nudge then T2 field, never a sentence — **extends** R-008's "T1 nudges" default; spec:778.
- D4 [E4] "3D volumetric" = viewer MPR + vendor measurement as a provenance-stamped field; HMIS writes no pixel code.
- D5 [E5] The cascade needs no DPIA revision because **DPIA:5's trigger (a new agent class or data class) is unmet** — not because "deterministic ⇒ exempt" (DPIA:12 covered the deterministic Leakage Auditor).
- D6 [E5] Rebalance is a proposal accepted through `resequence`; publish stays human; nothing `in_holding` or later moves.
- D7 [E5] `signIn` refuses `turnover`; the in-charge clears with a reason; the same two-actor evented override as every gate.
- D8 [E5] LA-only cases carry `planned_start`; the late job reads `ot_list_items` first, the NPO gate as fallback.
- D9 [E6] Ortho before gynae — spec:838 narrows R-237 per class; P15 A5b (:284) makes `mtp`/`usg_*` unnameable.
- D10/D11 [E6] **Executed by #157** — no longer decisions.
- D12 [E7] Surgeon clash is a warning; a roster mismatch is an evented override, not a refusal (R-072's shape).
- D13 [E5] The C-arm is a **radiology `device` row** under 18c's licence gate; `theatre_fit` reads `down|qa_blocked|maintenance`; 15d declares no kind.
- D14 [E5] Env telemetry starts as a typed reading; R-168's fail-safe arms on the first reading; sensors (R-206) after.
- D15 [E1] `deploy.sh` runs `seed:radiology` for **Class C only**; devices through 18a-v's door or the runbook — a seed must not invent a fleet.
- D16 [E3/E4] Processors live in `imaging_processors` (18b-iii); `partners` is a commission book and stays one.
- D18 [E1] The reaction seat and the machines door are **18a-v**.
- D19 [E7] The roster read is 15d's consumer of 20's `whoIsOn` behind 20's flag; blast radius 3 kernel files (P20:28), none in `ot`.
- D20 [E3] The Extractor waits for 12a; the partner PDF is attached and the countersign is a **read** (doc01:83).
- D21 [E7] The on-duty anaesthetist is the dead-end for emergency inserts (doc15:97: an insert bypasses to `running`).
- D22 Thresholds are this file's: `planned_start`+15, ≥ 80 %, p95 ≤ 5/≤ 15 min, ≥ 90 %, warn 1 h/block 2 h (R-168 names no number).
- D23 [E4] Locus = on-prem appliance; shape = pull under a config flag; 12a needed only for push.
- D24 [E5] The cascade rides `flagLateSurgeons`' 60-s tick, module-local — the parity array stays at 18.
- D25 [E3] `imaging.sendout_sla_breached` rides `sweepCriticalChaser`'s tick for the same reason.

**RULINGS (money / procurement / law / facts the owner holds):**

| id | question | category | recommended default | unblocks |
|---|---|---|---|---|
| NEW-P3-1 | **11b as three priced options:** (a) 18b R1 as written; (b) R1 + Tier 2/3 in an India-region store from day one; (c) cloud-primary PACS, amending spec §1 v4.7 | procurement + money | **(b)**; (c) only by the owner's own amendment | E2, E3 |
| 18b R1–R3 (18b:88-90) | NVMe + nearline ≈ ₹2–3 L, offsite ≈ ₹8–15 k/mo; MWL licences (CT + DR); 3 MP monitor ≈ ₹4 L; **+ the UAT Orthanc's memory on a 15 GB box** | money + procurement | as recommended | E2-M2/M3 |
| 18c R3 (18c:82) | the investigation level — "policy, and it is the owner's to set" | law (the RSO's number) | 1 mSv/month pro-rated, entered by the RSO at E1-M3b | E1-M3b |
| R-170 (REG:182) | day-care whitelist — "owner + department heads approve before activation" | clinical, pre-pilot, owner's act | the ortho whitelist from `seed:ot`'s draft, approved by owner + ortho HOD, two approval ids | E6-M2/M4 |
| R-001 (REG:13) | teleradiology standby + DPA | procurement + law | dormant DPA-backed contract; duty-manager trigger | E3-M4 |
| NEW-P3-2 | India-region object-store contract + DPA | procurement + law | any India S3-compatible store; ₹1–1.5/GB-month (doc01:558) | E3-M3 |
| NEW-P3-3 | **The imaging carve-out to DPIA:20 (a second §3-A) + addendum:** re-identification, processing locations, DPDP §16, **lawful basis + patient notice (DPIA §4)** for replica, partner, appliance | law | owner accepts on §3-A's terms; counsel signs before one study leaves or one pixel is inferred on | E3-M2, E4 |
| NEW-LAW-1 (was "L1") | one counsel session: DPIA v0.2 signed + NEW-P3-3 + R-009 + R-254/R-126 | law | **owner books counsel by wk 4; session wk 4–8** | E3, E4 |
| NEW-LAW-2 (was "L2") | AERB certificates on file (+ e-LORA per device), PCPNDT §19, R-237 | law | file by wk 7 | E1-M3b, E6 gynae |
| R-254 / R-126 (REG:266,138) | residency for every outbound processor | law | India-region + DPA; on-prem default | E3, E4 |
| R-009 (REG:21) | retention incl. image tiers | law | adopt doc01:184; counsel confirms | E3-M3 |
| R-008 (REG:20) + NEW-P3-4 | image-AI product, CDSCO SaMD status, fee | procurement + money + law | one CXR-triage + one stroke appliance, evaluated on 0 production studies | E4-M1 |
| R-004 (REG:16) | film/CD prices | money | CD ₹150; film ₹250; MLC free | E1-M3b |
| 18c R1/R2/R4 (18c:80-83) | RSO + physicist names; TLD service; QA contract | fact + procurement | senior radiographer as RSO; visiting physicist | E1-M3a/b |
| R-164 / R-165 (REG:176-177) | theatre-time bands; opened-kit charge | money | 30-min bands after 60; attributable charges the patient | E5-M4 |
| O6 | `daycare_package` prices | money (CA) | placeholders on UAT; production after the CA session | E6-M4 |
| F4 (RM:452-455) | the names: radiologist of record, RSO, physicist, radiographer(s), receptionist; surgeon, anaesthetist ×2, OT nurse, recovery nurse, coordinator, in-charge; **the `opd_admin` drafter (not the owner); a night clearer** | fact | a row without a name reads unstaffed | E1-M3a, E6-M1/M2 |
| R-237 (REG:249) | MTP place + PCPNDT certificates | law | file; ortho opens first | E6 gynae |
| R-206 (REG:218) | env sensor kit with Modbus/MQTT output (no price in the repo) | procurement | after E5-M3 runs on typed readings | E5-M3 |

## 6. Not now

- **Not the literal mission:** no cloud-primary PACS, no deletion of the on-prem edge, until the owner amends spec §1 v4.7 himself.
- **Not 18b-ii's build this quarter unless 11b lands by wk 7** (RM:338,423); authoring waits on E1-M4 either way.
- **Not E3-M1 before radiology's S-gate is dated** — series content behind the opening (RM §0c.5).
- **Not E4 this quarter or next:** R-008's own condition, 12a excluded (RM:428), DPIA unsigned, no CDSCO product, no carve-out.
- **Not T2 volumetric fields until a department consumes them** (IPD gate, RM §4).
- **Not the OT List Optimiser (48), Op-Note Drafter, workstation feeds** — inference, IPD gate, medians the unit lacks.
- **Not 29 (BME), 31 (transport), 19a for the OT** (RM §5:414-418); E5-M3 uses radiology's `device` row and a manual clear so it does not wait.
- **Not 15b/15c inside this pillar** — D9 opens ortho first.
- **No `ot` realtime topic; no second theatre** (`theatreId()` picks the one by code, `booking.ts:323`); **no outside-study upload** (18a-iii:171).
- **Absorption before building:** E1 and E6 precede E2, E3, E5, E7; a build epic starts only when its opening epic's G5 section is dated.

## 7. Sequencing note

Weeks from RM §2 (Monday 2026-09-07). **R** radiology, **S** commissioning. The OT has no lane; E5/E6/E7 go to **R after Plan 20** and after RM's own R bookings (20 close review ×2 and 41 authored wk 7–9; pilot fixes wk 10–13 — RM:338-344).

| when | what starts | human act at the start |
|---|---|---|
| wk 1–2 | **E1-M1/M2** on R (8 d) | **owner's 11i line; owner's 18a-iv line**; the weekly deploy by his hand from `main` |
| wk 3 | **E6-M1** residual by S (2 d) beside the lab's stand-up; Plan 20 is already authored (#150) | **owner's Plan 20 line**; the `opd_admin` drafter named |
| wk 4–6 | R: Plan 20 built (~10 d) if the line arrived + **E1-M6** (3 d) = 13 of 15 d; S: **E1-M4** (2 d) + **E6-M2/M3** (4 d) beside pharmacy on UAT — plausible only because S = P + L + F by then (RM:337) | F4 names incl. the OT's (wk 4, with pharmacy's); **owner books counsel (NEW-LAW-1)**; NEW-P3-1 before wk 7 |
| wk 7–9 | R: 20 close review ×2 + 41 authored (RM) + **E3-M1** (4 d, after E1-M4) ≈ 15 d — **E5 and E2-M2 do not fit**; S: **E1-M3a/M3b/M5**, radiology opens on production (RM:338) | NEW-LAW-2 + RSO/physicist by wk 7; R-004; 18c R3; 18b R1–R3 if 11b ruled |
| wk 10–13 | R: **E7-M1/M2/M3** (6 d) + **E5-M1a** (3 d) after E6-M3 dated, beside pilot fixes; S: **E6-M4** ortho pilot if O6 + R-170 land | O6 CA session; R-170 approval ids |
| Q1 2027 | **E5-M1b/M2/M3/M4** after E6-M4's harvest; **E2-M2/M3/M4** if 11b + R1–R3 + an engineer; **E3-M2/M3/M4** once contracts + NEW-P3-3 signed; 18b-ii close review | NEW-P3-2 + R-001; R-164/R-165; the carve-out signed |
| Q2 2027 | **E4-M1** after E2's 90 stable days; **E4-M2a/M2** with DPIA v0.2 signed + CDSCO; **E4-M3** only with 40 or 48 live | R-008 funding; CDSCO; the T1→T2 promotion |

Everyone-files: `docker/prod/deploy.sh`, `scripts/standup-check.ts` (S; after #158); `router.tsx` + `locales/*.json` (18a-v). **Not needed:** `kernel/db/schema/index.ts` (`:22,:42,:66-76` re-export per module); `kernel/worker/jobs.ts`, `alerts.yml`, `alerts-parity.test.ts` (D24/D25); `kernel/resources/registry.ts` (D7). Serials at rebase; one migration per PR.

## 8. Changelog

**EC** exists-or-collides · **M** measurability · **AS** authority-and-safety · **SQ** sequencing-and-absorption. Every KILL/AMEND accepted except one citation fix (last row).

- EC-K1, M-R10, SQ-C2 → accepted → E6-M1 recut to what #157 left (Class A ceremony on UAT, `## Executed`, six new rows); §0.8, D10/D11, §7 wk 3 rewritten.
- EC-A1, M-R9, AS-E(#164), SQ-C3 → accepted → E5-M1 → M1a/M1b; `version` dropped from event + proposals; seam sentence deleted; G-E baseline restated.
- EC-A2, M-R17, AS-E(comment), SQ-C1 → accepted → §0.7 corrected; E7 homed in 15d as NEW code reading `whoIsOn`; flag-off leg → P20 D2 parity; D19 rewritten.
- EC-A3, SQ-B7, SQ-E4 → accepted → 18a-v opened (reaction seat + machines door); quote corrected; D18; E1-M6; edge 29.
- EC-A4, SQ-B2 → accepted → E1-M1's act = the owner's 18a-iv line.
- EC-A5 → accepted → D13 = radiology `device` under 18c's gate; `out_of_service` replaced.
- EC-A6, M-R12, SQ-E2 → accepted → `imaging_processors` (18b-iii) replaces the `partners` overload and M-R12's `partner_agreements` migration; NOT MODELLED semantics; D16.
- EC-A7, SQ-C4, M-N4 → accepted → re-pinned to `91c34fc` (+#118); "not in main-ro" struck; 0/9 runbooks; #143 merged as a doc.
- EC-A8/A9/A10, EC-N1..N13 → accepted → 18a = `0047`, `0050`–`0052`; "no link sizing"; `OT-1`+beds to G2; `docker/prod/deploy.sh`; 18a-iii :166/:171; P15 :454-455; spec:785 dropped; R-262 wording; blast radius 3; ₹40–80 k dropped; `list.resequenced` in edge 12; N11's seed gap kept in E1-M2.
- M-R1, M-R2 → accepted → `placedVia` in 18a-iv T2; interim `/radiology/orders` grep.
- M-R3, M-R4 → accepted → `received_at` (E2-M2), `replica` channel (E3-M3), interim p95 excludes `late_entry`; "unopened days" replaces rostered shifts.
- M-R5 → accepted → `backup.image_drill_passed` + exporter row + `alerts-backup.yml` leg (file exists) in E2-M4.
- M-R6, M-R7, M-R15 → accepted → `## 11`/`## 12`; "studies with no order" dropped; `RAD-CD`/`RAD-FILM`; `UAT-` licence row replaces `DEMO`.
- M-R8 → accepted → per-role holder lines; four `*_held` rows.
- M-R11, SQ-D2 → accepted, alternative chosen → cascade rides `flagLateSurgeons`' tick (D24); `theatre_fit` own migration + flipped absence test; everyone-files named per milestone; `registry.ts` untouched.
- M-R13, AS-C10 → accepted → per-field provenance with output hash; G-D restated.
- M-R14 → accepted → `reason` on substitution (E5-M1a); `bill_not_composable`/day replaces "cases without a package".
- M-R16 → accepted → the three Orthanc `interfaces` preconditions in E2-M3.
- M-R18 → accepted, alternative chosen → `sendout_sla_breached` rides `sweepCriticalChaser`'s tick (D25).
- M-R19, M-N1/N2/N3 → accepted → `replica_lag_studies` defined; refusals/month KPI; D22; `mwl.test.ts:166` = regression pin.
- AS-A1 → accepted → D17 removed; `18c R3` RULINGS row.
- AS-A2, SQ-B6, SQ-E9 → accepted → ceremony restated (owner activates; drafter ≠ activator per person); R-170 row; `opd_admin` drafter in F4; edge 33.
- AS-A3/A4/A5/A6 → accepted → D1 relabelled; region config row; D21; D9 cites spec:838 + P15:284; D20 countersign is a read.
- AS-B1, SQ-A3 → accepted → E2-M1 authoring-only after E1-M4; the ruling gates E2-M2.
- AS-B2 → accepted → `NEW-LAW-1`/`NEW-LAW-2` replace L1/L2.
- AS-C1/C2/C9/C11 → accepted → on-prem appliance, pull shape (D23); evaluation set + "0 production studies"; E4-M2a shadow; owner approves T1→T2; R-262 notice.
- AS-C3/C4 → accepted → `ot.cascade_enabled`, system `actor_id`, flag-off drill; D5 via DPIA:5; `npo.at_risk` on proposal, `npo.extended` after accept.
- AS-C5/C6/C7/C8 → accepted → roster mismatch = evented override; edge 6 rewritten; env block + `turnover` clear get the two-actor override; night clearer in F4.
- AS-D1/D2/D3/D5, AS-E → accepted → basis + notice in NEW-P3-3/E3-M2; edge 23 channel; stage-1 posture in §0.1 + E1-M5/E6-M4 + edge 3; G-C reader; DPIA "0.2 DRAFT unsigned" in the header; 18b-iv naming in §0.3; D3 "extends".
- SQ-A1 → accepted → E3-M1 after E1-M4. SQ-A2 → E5 split. SQ-A4 → E7 after E6-M3.
- SQ-B1/B3/B4/B5 → accepted → owner lines atop §3; Plan 20 line wk 3; E1-M3 → M3a names (wk 4) / M3b certificates (wk 7); counsel booked by the owner wk 4.
- SQ-E1 → accepted → D15 Class C only; edges 26/27. SQ-C5/D1/D3 → §7 re-summed (E5/E2-M2 leave wk 7–13; 41's authoring stays R's); UAT Orthanc memory in the 18b R1 row. SQ-E3/E5/E6/E7/E8 → edges 28/30/34/31/32. SQ-G1 "0078 → 0078–0081" → accepted.
- SQ-G1 "fix the 15d routing citation to `…00-RECORD-AND-PLAN.md:213`" → **rejected** → measured on `origin/main`: `grep -n '15d money'` = **line 214** of `docs/superpowers/brainstorms/2026-08-28-plan-15-mini-ot/00-RECORD-AND-PLAN.md` — the path and line the design already cites (its `…` elides `docs/superpowers/brainstorms/`, not `plans/`). Kept at :214.
