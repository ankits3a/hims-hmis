# The roster backbone — implementation plan (phase R)

**Authored 2026-09-20 in lane `roster-units`, after the six-lens stress test
(`brainstorms/2026-09-20-roster-units/01-STRESS-TEST.md`). FOR EXECUTION BY A SEPARATE SESSION
(Opus) via `2026-09-20-roster-backbone-EXECUTE-PROMPT.md`. Supersedes §7 of the 20-U phase doc;
20-U's §2 (NMC ground), §6 (the ladder) and §8 (the edge-case register) remain the reference.**

The owner's brief, 2026-09-20: *"a top-class backbone… all the modules of our HMIS — an agentic-AI
hospital operating system that uses AI agents as co-pilots to human users — are going to use it."*
This plan is the backbone only: **the data model, its invariants, the resolvers, the calendar, the
validator and the proposer.** Screens, the ladder, actuals, nursing patterns and the copilot tools
are later phases (§8), each its own phase doc when reached. **T1 as built (PR #264, draft) is
reworked here, not merged.**

---

## 0. Standing rulings this plan is built on

| ruling | source |
|---|---|
| teaching hospital, 150 seats, NMC; units are one per sanctioned SR = **5/5/3/3/4/2/2/1/1, Respiratory Medicine its own one-unit department** (DECIDED under "follow the standard protocol of top teaching hospitals"; overturnable) | owner RU-1 + 2026-09-20 §2 |
| **no ERP is bought**; leave, teaching, actuals are ours | owner RU-2 |
| office timings **09:00–17:30**; default night rule **department-pooled 12-hour nights, 12 h rest, ≤ 1 night in 3, one weekly off**; the 24-hour-duty pattern ships as a template a HOD may choose | owner 2026-09-20 + stress test S4 |
| the roster grants **no permission** (D7 stands; duty-scoped grants rejected for this plan) | stress test §2 |
| a posting/slot never tells an external LLM a name, a phone or a leave reason | stress test A-4/L-13 |
| the system proposes; a human publishes, approves, overrides, acknowledges | Plan 20 D4; matrix in stress test §4 |
| screens gated on the four boards (approved "as of now") — **out of this plan** | owner RU-6 |

---

## 1. Ground truth to re-measure at kickoff (record answers in §9)

| # | fact | how | value on 2026-09-20 |
|---|---|---|---|
| G1 | newest migration on `origin/main` | `ls apps/core/drizzle/*.sql \| tail -1` | `0107_pharmacy_authorisations.sql` — **R1 takes the next free serial at rebase time, never at start** |
| G2 | `usersHoldingRole` runtime call sites | `grep -rn "usersHoldingRole(" apps/core/src --include=*.ts \| grep -v test` | 6 files: `kernel/alerts/consumer.ts`(5), `kernel/workflow/timers.ts`(2), `kernel/notify/consumer.ts`(1), `kernel/desk/staff.controller.ts`(1), `modules/materials/counts.ts`(1), `modules/materials/transfers.ts`(1); `modules/ot/lists.ts` mentions it in a comment |
| G3 | department rows | `opd_departments` seed in `modules/opd/config.ts` | 12 (MED…PHY); no anaesthesia, radiology, pathology, community medicine, forensic, casualty, nursing |
| G4 | manifests / permissions / pairs pins | run `test/seed-roles.test.ts`, `src/kernel/modules/manifests.test.ts`, `test/standup-check.test.ts` red and **read the numbers off the failure** | 22 manifests; 175 permissions; 355 pairs; 161 held; 169 non-table pairs |
| G5 | `standup-check` classification | `test/standup-check.test.ts` "every manifest is classified as a department or not" — `DEPARTMENTS` / `NOT_DEPARTMENTS` in `scripts/standup-check.ts` | **T1 failed CI here**: `roster` must be classified NOT a department |
| G6 | DB session timezone | `docker exec hmis-db-1 psql … -c 'show timezone'` | `Etc/UTC` — every IST test in this plan relies on it |
| G7 | `btree_gist` | `select extname from pg_extension` on a lane test DB after R1 | absent before R1; created by R1's migration (0021's `pg_trgm` is the precedent) |
| G8 | T1's code to port | lane `roster`, commit `29f5159d` | `kernel/db/schema/roster.ts`, `modules/roster/*`, `schema/roster.test.ts` — the tests are ported, the schema is regenerated |
| G9 | lanes touching shared files now | `tools/lane.sh status` | `copilot` (kernel/copilot), `desk-upcoming`, `front-desk-fd25` (opd) — coordinate before R6/R7 |

---

## 2. The data model — what R1–R4 build

Conventions: ULID text ids via `newId()`; text + CHECK vocabularies, never PG enums; `[starts_at,
ends_at)` instants, **never a date column** except where a human-declared calendar day is the fact
(holidays, IST dates on cycles); `site_id text default 'main'`; the four audit columns; every table
appended to `truncateAll`'s reach by construction (it scans) and pinned by a schema census test.

### 2.1 Masters (R1)
- **`org_departments`** — `id, code (uq), name, kind ('clinical'|'para_clinical'|'support'|'nursing'|'admin'), admitting bool, opd_department_id → opd_departments.id NULL UNIQUE, active, valid_from, valid_to`. Seeded from the 12 OPD rows (linked) + Anaesthesiology, Radiodiagnosis, Pathology, Microbiology, Biochemistry, Community Medicine, Forensic Medicine, Casualty, Nursing, Pharmacy, Administration. **`opd_departments` is not altered.** Creating an OPD department later does not auto-create an org row (a finding on `standup:check` instead).
- **`roster_positions`** — `key (pk), label, cadre ('faculty'|'senior_resident'|'junior_resident'|'intern'|'medical_officer'|'nurse'|'technician'|'pharmacist'|'admin'|'support'), ladder_rank int, eligible_role_key → roles.key NULL, default_mode, max_presence_hours int, counts_toward_requirements bool, active`. Seeded: `unit_head, faculty_on_call, unit_sr, ward_jr, night_jr_pool, night_sr_pool, casualty_mo, intern, duty_manager, radiologist_on_call, pathologist_on_call, anaesthetist_on_call, blood_bank_mo, pharmacist_counter, staff_nurse, ward_incharge, night_nursing_supervisor`. **`eligible_role_key` is the ONLY link to RBAC** and it is an eligibility check at assignment, never a grant.

### 2.2 Periods, slots, amendments (R2 — the T1 rework)
- **`roster_periods`** — T1's columns, plus: `department_id → org_departments NULL`, `team_id NULL` (FK in R3), `covers_positions text[] NOT NULL` (the positions this period answers for — fallback applies only to an undeclared position), `based_on_period_id → roster_periods NULL`, `content_hash text NULL` (SHA-256 of the canonical slot list, set at publish), `origin ('human'|'machine')`, `drafted_by_actor_type`, `human_touched_at timestamptz NULL`. Constraints kept from T1 plus: `EXCLUDE USING gist (site_id WITH =, scope_type WITH =, (coalesce(scope_id,'')) WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status = 'published')`; `CHECK (superseded_at IS NULL OR superseded_at >= published_at)`; period bounds are IST midnights (domain check, not DB).
- **`roster_assignments`** — T1's columns with **`role_key` replaced by `position_key → roster_positions.key`**, `user_id` **nullable** (a vacant position slot), and added: `department_id NOT NULL`, `team_id NULL`, `cover_scope ('team'|'department'|'location'|'hospital') NOT NULL default 'team'`, `call_tier smallint NULL` (1 = first on call), `supernumerary bool default false`, `shift_def_id NULL` (FK in R7), `kind` gains `'off'` with `off_kind ('WO'|'NO'|'DO'|'CO'|'PH'|'RH') NULL`, `live_from timestamptz NOT NULL`, `live_to timestamptz NULL`, `amendment_id → roster_amendments NULL`, `lineage_id text NOT NULL` (copies keep it; a new row sets it to its own id), `proposed_by_actor_type, proposed_by_actor_id, proposal_run_id NULL`, `confirmed_by_user_id, confirmed_at NULL`. `effective` stays the single denormalised truth: **true iff the period is published AND `live_to IS NULL`**; writers: `publishPeriod`, `amend`, `supersede`. The presence EXCLUDE is unchanged (`WHERE effective AND mode='presence'`). DB checks: presence window ≤ 36 h, any window ≤ 35 days, `kind='off' ⇒ mode IS NULL AND user_id IS NOT NULL`. Indexes: gist `(position_key, tstzrange(starts_at, ends_at)) WHERE effective`; btree `(user_id, starts_at)`; `(period_id)`; `(lineage_id)`.
- **`roster_amendments`** — `id, period_id, kind ('swap'|'cover'|'float'|'withdrawal'|'correction'|'hold_over'), reason text (≤ 500), requested_by, approved_by, approved_at, after_the_fact bool, applied_at (DB clock), superseded_count, added_count`. One amendment = one transaction: close the old rows (`live_to = applied_at`, `effective = false`), insert the new ones (`live_from = applied_at`, same `lineage_id`), re-run `presenceClashes` and the requirement check for every person and location touched, emit `roster.duty_changed` per person.

### 2.3 Teams and people (R3)
- **`roster_teams`** — `id, kind ('clinical_unit'|'ward_team'|'service'|'pool'), department_id NOT NULL, code (uq per site), name, home_location_resource_id → resources NULL, lead_user_id NULL, unit_number int NULL, sanctioned_beds int NULL, valid_from, valid_to, active`.
- **`roster_team_memberships`** — `id, team_id, user_id, position_key, grade text ('professor'|'associate_professor'|'assistant_professor'|'senior_resident'|'jr1'|'jr2'|'jr3'|'intern'|'medical_officer'|'nurse_grade_1'…; text + CHECK), role_in_team ('head'|'faculty'|'senior_resident'|'junior_resident'|'intern'|'member'|'lead'), kind ('parent'|'rotation'|'float'), retains_parent_nights bool default false, supernumerary_until timestamptz NULL, pattern_offset int NULL, starts_at, ends_at NULL, source`. EXCLUDE: one **parent** membership per user at a time; one **head** per team at a time (kind='parent', role='head').
- **`roster_officiating`** — `id, team_id, user_id, role ('head'|'hod'|'lead'), starts_at, ends_at, reason, approved_by`. EXCLUDE one per (team, role) at a time. Resolvers prefer an officiating row while it is in force; the head's own membership is untouched.
- **`roster_delegations`** — `id, delegator_user_id, delegate_user_id, authority ('publish'|'approve_swap'|'override_rule'|'approve_leave'|'declare_holiday'|'declare_mode'), scope_type, scope_id, starts_at, ends_at, reason`. `rosterActPolicy` consults it.
- **`roster_bed_allotments`** — `id, team_id, resource_id, starts_at, ends_at NULL`. NMC return and default placement only.

### 2.4 Absences and credentials (R4)
- **`staff_absences`** — `id, user_id, kind ('CL'|'EL'|'ML'|'maternity'|'paternity'|'comp_off'|'night_off'|'duty_off'|'deputation'|'academic'|'study'|'abstaining'|'unauthorised'), starts_at, ends_at, status ('requested'|'approved'|'rejected'|'cancelled'), requested_by, approved_by, decided_at, reason text NULL (visible to approver only — D6), aebas_entered_at NULL, aebas_entered_by NULL, source`. **System of record for every member of staff.** `modules/opd`'s `scheduleLeave` keeps its API and calls `recordAbsence` in the same transaction, so `opd_doctor_leaves` becomes a projection (opd → roster import through `index.ts`; the roster reaches into no module).
- **`staff_credentials`** — `id, user_id, credential_key ('nmr'|'smr'|'nursing_council'|'pharmacy_council'|'bls'|'acls'|'nrp'|'ventilator'|'chemo'|'pcpndt_registered'|'aerb_rso'|…), reference, valid_from, valid_to NULL, verified_by, verified_at`.

### 2.5 Calendar, requirements, rules (R7–R8)
- **`roster_shift_defs`** — `id, code ('take'|'opd'|'ot'|'ward'|'night'|'M'|'E'|'N'|'G'|…), label, department_id NULL, start_minute, duration_minutes, handover_minutes, counts_as_night, default_mode, max_presence_hours`.
- **`roster_cycles`** — `id, department_id, cycle_days, anchor_ist_date, version, status draft|published|superseded, effective_from`; **`roster_cycle_entries`** — `cycle_id, day_index, team_id, activity ('opd'|'elective_ot'|'ward_teaching'|'take'|'post_take'|'backup'|'minor_ot'|'special_clinic'), start_minute, duration_minutes`; **`roster_cycle_overlays`** — the Sunday/holiday sequence per department, with its own anchor.
- **`roster_holidays`** — `ist_date, kind ('gazetted'|'restricted'|'declared'|'local'), applies_to text[] (staff classes), pattern ('as_sunday'|'opd_short'|'opd_off_ot_proceeds'), declared_by, declared_at`. **A declared holiday never advances the overlay sequence.**
- **`roster_duty_windows`** — materialised: `department_id, team_id, activity, starts_at, ends_at, cycle_id, overlay_index int NULL, source ('cycle'|'overlay'|'amendment'), superseded_at NULL`. EXCLUDE: take windows per department may not overlap (live rows). Materialised on a **rolling 90 days** at cycle publish and by a nightly job; the no-gap check is an invariant on every write and a `standup:check` row.
- **`roster_requirements`** — `id, scope_type ('location'|'team'|'department'), scope_id, position_key, shift_def_id NULL, day_class ('weekday'|'saturday'|'sunday'|'holiday'|'any'), min_count, max_count NULL, credential_key NULL, basis ('fixed'|'per_occupied_bed'), ratio_n NULL, authority, citation, valid_from, valid_to`. R-067 and R-182 become rows; "a take window needs ≥ 1 SR + 1 JR present and 1 faculty on call" becomes rows, not code.
- **`roster_rules`** — `key, label, severity ('block'|'warn'|'info'), authority ('nmc'|'nmc_recommended'|'central_law'|'central_directive'|'court'|'accreditation'|'state'|'institution'), citation, applies_to (cadres[]), params jsonb, active`; **`roster_rule_profiles`** — dated per-department parameter overrides ("lean period"), approved once, evented. **`roster_findings`** — `period_id, assignment_id NULL, user_id NULL, rule_key, severity, params jsonb, accepted_by, accepted_at, accept_reason, cleared_at`.

---

## 3. Invariants — each is a test, named here so the reviewer can grep for it

| id | invariant | where enforced |
|---|---|---|
| V1 | one person, one place: no two **live presence** windows of one user overlap | DB EXCLUDE + `presenceClashes` sentence |
| V2 | at most one **published** period per scope per instant | DB EXCLUDE on periods |
| V3 | a draft publishes only if its `based_on_period_id` is the live version (or there is none and it has no base) | `publishPeriod` → `stale_base` |
| V4 | what the human reviewed is what goes live | `publishPeriod(expectedContentHash)` → `draft_changed_since_review` |
| V5 | `effective ⇔ period.status='published' ∧ live_to IS NULL` | a repair query in `standup:check` finds zero rows; unit tests on every writer |
| V6 | `published_at`, `superseded_at`, `live_from/to`, `applied_at` come from the database clock; `superseded_at ≥ published_at` | DB defaults/CHECK; no exported function takes `now` for a stamp |
| V7 | nothing published is deleted; superseded rows keep every original value except `live_to`/`effective` | absence test: no `delete` on assignments outside `status='draft'`; `updated_by` untouched by supersede |
| V8 | a machine actor never edits a draft a human has touched, never publishes, never overrides | `rosterActPolicy` + an absence test enumerating every exported acting function against stress test §4 |
| V9 | every event payload is ids, codes and instants — a test rejects any free-text string field | `events.test.ts` schema walk |
| V10 | every refusal has one code, `params`, and a fallback sentence in **IST**; no UTC ISO string in a `message` | `errors.test.ts` |
| V11 | take windows of one department never overlap, and never gap inside `[go-live, horizon)` | DB EXCLUDE + continuous check |
| V12 | **07:59 and 08:00**: the take resolver flips exactly at the handover instant with the DB in UTC | `calendar.test.ts` (G6) |
| V13 | the resolver returns *slots − approved absence − inactive users − closed memberships*, and an empty answer is not an error | `resolve.test.ts` |
| V14 | flag off, or position undeclared ⇒ `whoIsOn` equals `usersHoldingRole(eligible_role)` — same ids, same order (Plan 20 T2 parity) | `resolve.test.ts` |
| V15 | `expandCycle()` is pure and the only generator: fallback and materialised windows agree on every instant of a 90-day sample | `calendar.test.ts` |
| V16 | a supernumerary slot never satisfies a requirement; a vacant slot is a hole | `validator.test.ts` |
| V17 | the intern year generated from the CRMI table sums to 52 weeks and repeats an over-limit absence in the department where it occurred | `interns.test.ts` |

---

## 4. Tasks — one PR each, one migration each, fail-first, rail + first consumer together

Tier per task as marked. CRITICAL tasks build their mutants as `*.mutant.ts` and record the kill in
§9.5. **Every task re-runs the pinned censuses** (`seed-roles`, `manifests`, `standup-check`,
`caddyfile-parity` when a route is added, the schema census) and reads the counts off the red run.

### R1 · CRITICAL · Masters and the seam — `org_departments`, `roster_positions`, the module, the census
- Migration (next free serial at rebase). `btree_gist` created here.
- `kernel/db/schema/org.ts` (departments) and `roster.ts` (positions only, this task).
- `modules/roster/{manifest,index,roster.module,errors,access,policy,events}.ts` ported from T1 with: one error code per cause; `rosterActPolicy(actor, act)` (stress test §4) replacing `requireRosterPermission`'s `actor.type !== "user"` refusal; permission checked at **department scope** (`hasPermission(..., "department", {department})`) with a hospital-scope fallback.
- Seeds: departments (2.1), positions (2.1). `standup:check`: `roster` classified NOT a department; a RED row "no positions seeded".
- Permissions unchanged from T1 (manage / publish / read; MS all three, owner read); README prose already carries the sentence — verify it survives.
- **Tests:** schema census; policy matrix absence test (V8 — enumerates exports); seed idempotence; `standup-check` green.
- **Mutants:** policy allows `system` to publish → matrix test red; positions seed dropped → census red.

### R2 · CRITICAL · Periods, slots, amendments — the T1 rework, and the gate v2
- Migration: 2.2's three tables (T1's 0108 is **not** carried; the lane test DBs are dropped after rebase — `drizzle-when-silently-skips` trap 2).
- `periods.ts` ported and extended: `draftPeriod` (records `based_on_period_id`, `origin`, copies with lineage), `assign` (position eligibility; vacant slots; the 36 h / position cap), `unassign`, `publishPeriod(tx, actor, periodId, { expectedContentHash })` with the advisory lock `pg_advisory_xact_lock(hashtext('roster.publish'))`, the DB clock, V3, V4, V1 sentence; **`publishPeriods(ids[])`** for a same-night cross-scope swap; `amend(tx, actor, periodId, { kind, reason, close: [ids], open: [slots], afterTheFact })`; `asKnownAt(scope, T)`; `contentHash(periodId)`.
- Events: `roster.period_drafted`, `roster.period_published` (+hash), `roster.period_superseded`, **`roster.duty_changed { userId, periodId, added: [ids], removed: [ids], amendmentId }`** per person per publish/amend, `roster.amendment_applied`. V9 test.
- **Tests:** T1's 37 ported (the schema suite writes underneath the code, as before), plus: V2 overlap refused; **publish v3 then stale v2 → `stale_base`**; hash mismatch → `draft_changed_since_review`; same-night cross-unit swap via `publishPeriods` succeeds where two single publishes cannot; amendment closes and opens in one transaction and `asKnownAt` answers both "as known" and "as corrected"; superseded rows keep `updated_by`; concurrent publish (two transactions) — one waits, neither 500s.
- **Mutants:** supersede after take-effect; `based_on` check removed; hash check removed; advisory lock removed (race test flakes → the test must be deterministic: assert the lock is taken via `pg_locks` inside the tx).

### R3 · CRITICAL · Teams, memberships, officiating, delegations; the unit seed; the intern year
- Migration: 2.3's five tables; `roster_periods.team_id` and `roster_assignments.team_id` gain their FK.
- Domain: `teams.ts` (create/close; the two EXCLUDEs surfaced as sentences), `memberships.ts` (parent/rotation/float; `retains_parent_nights`; `supernumerary_until`; membership judged **at slot start**), `officiating.ts`, `delegations.ts` (consulted by `rosterActPolicy`), `interns.ts` — **the CRMI generator**: batch start date, sub-batches, 1–7-week blocks, Community Medicine and DRP as external sites, extension posting in the department where the over-limit absence occurred (V17).
- Seed: the 27 units as **draft teams** (`active=false` until a HOD confirms; a `standup:check` row lists unconfirmed units), one per department per §0.
- CSV import of memberships, validated whole before the first write (`seed:staff`'s posture).
- **Tests:** V-exclusions; officiating preferred by `teamMembers`; delegation honoured by policy; intern year sums to 52; a rotation with `retains_parent_nights` keeps the person in the parent pool.

### R4 · CRITICAL · Absences and credentials; OPD leave becomes a projection
- Migration: `staff_absences`, `staff_credentials`.
- Domain: `absences.ts` (request/approve/reject/cancel; `abstaining` and `deputation` bulk acts; the 75 % projection as a *finding*, window configurable; `aebas_entered_at` mark), `credentials.ts` (record/verify; expiry findings).
- **Coordinate:** `modules/opd/leaves` — `scheduleLeave` calls `recordAbsence`; `opd_doctor_leaves` written in the same transaction; the OPD `needs_rebooking` cascade subscribes to `roster.absence_approved`. Touches a module everyone imports: **rebase first, one commit, run `src/modules/opd` suites.**
- **Tests:** an OPD leave and a roster absence agree; a JR (no `opd_doctors` row) can have an absence; approver sees the reason, others do not (D6); credential expiry inside a period is a finding.

### R5 · CRITICAL · The resolvers (Plan 20 T2, scoped) and the coverage declaration
- `resolve.ts`: `whoIsOn({ position, departmentId?, teamId?, locationId? }, at)`, `whoIsAt(locationId, at)`, `dutiesOf(userId, from, to)`, `teamMembers(teamId, at)` (memberships + officiating), `calloutList(departmentId, at)` (call tiers), `asKnownAt`. Contract V13. Flag `ROSTER_RESOLVER_ENABLED`; parity V14. Look-back bounded by the 35-day DB cap. Clock **injected by the caller**, never defaulted.
- Read model for the board: `onDutyNow(departmentId, at)` returns `{ source: 'published' | 'pattern' | 'static' }` so a screen can say **UNPUBLISHED — pattern**.
- **Tests:** V13, V14, scoping (a Medicine alert never resolves to Surgery's resident), officiating, vacant slot skipped, look-back bound, 2,000-row timing assertion is a *budget written in the quiet regime* (see memory `bounds-sized-in-the-quiet-regime`: assert order, not milliseconds).

### R6 · CRITICAL · The six call sites behind the flag (Plan 20 T3 + T5) — kernel files that belong to everyone
- `kernel/alerts/consumer.ts`, `kernel/workflow/timers.ts`, `kernel/notify/consumer.ts`, `kernel/desk/staff.controller.ts` move to `whoIsOn` with an explicit instant; `modules/materials/*` stay static (custody is a question about the roll). The escalation destination becomes a configuration row (`roster_escalation_targets`: `alert_kind → position, department scope`), duty manager the rung never removed. **Rebase immediately before; one commit; coordinate with any lane on those files (G9).**
- **Tests:** each call site's existing suite green with the flag off (parity) and on (a published roster changes the recipient).

### R7 · CRITICAL · The calendar — shift definitions, cycles, holidays, windows, `unitOnTake`
- Migration: 2.5's calendar tables; `roster_assignments.shift_def_id` FK.
- `calendar.ts`: `expandCycle()` pure (V15); publish a cycle → materialise 90 days; nightly extension job (**scheduler census +1, named in the PR**); the overlay with persisted `overlay_index`; `declareHoliday` two-step (MS pattern → per-HOD confirmation deadline → messages); `unitOnTake(dept, at)`, `backupUnit(dept, at)` with `source`; the continuous no-gap invariant (V11) and its `standup:check` row; E6 blocks only at ≥ 3 units.
- Template gallery as **seed data** (stress test H): 2-unit alternate days; 3-unit fixed twice-weekly; 4-unit OBG + labour-room pool; 5-unit weekly-fixed with rotating Saturday; 5-unit rolling N = 5; single-unit daily OPD + take by call; the sequence Emergency → post-emergency → OT → ward/teaching.
- **Tests:** V11, V12 (**07:59 / 08:00**), V15, holiday declared at 19:30 withdraws OPD and elective windows for the date and nothing else, overlay never advanced by a declared holiday, a cycle version with `effective_from` mid-period (E17).

### R8 · CRITICAL · Requirements, rules, the validator, `simulate()`
- Migration: `roster_requirements`, `roster_rules`, `roster_rule_profiles`, `roster_findings`.
- `validator.ts`: pure `validate(period | hypothetical) → findings[]` with `ruleCode`, `authority`, `params`; rules seeded from the stress test's list (12 h rest; ≤ 1 in 3 for PG; weekly off **warn with reason** (PGMER "subject to exigencies"); ≥ 2 JR per unit (`nmc`); one SR per unit; PG surgical two theatre days; tenure/age expiry; 74 h / 24 h (`nmc_recommended`); 12 h / 48 h (`central_directive`, sub judice, warn); a planned slot > 24 h **block**; requirement shortfalls; credential missing/expiring; location-based lone-worker rule; supernumerary and vacant handling (V16); template feasibility in **hours per week and residents per unit**). `simulate(base, deltas[]) → { findings, candidates, excluded[] }` — no writes; **`excluded[].reason` is a rule code, and an absence is reported as `unavailable`, never its kind.**
- Skeleton mode v2 (D4): declared by MS/delegate, **expires daily**, bulk `abstaining`, ladder re-roots at the first staffed rung (consumed by the later ladder phase), withdrawals as a checklist.
- Publish gate consults the validator: any `block` finding not accepted → refusal listing codes.
- **Tests:** every seeded rule has a red case and a green case; feasibility for a 3-JR unit under unit-only nights is red and under pooled nights is green (S4); `simulate` is pure (same input, same output, no rows written); a block finding stops publish, an accepted warn does not.

### R9 · ROUTINE · The proposer and the monthly draft; the evaluation harness
- `proposer.ts`: strategies `unit_split` (rules as data per team) and `pooled_nights` (department pool, 1-in-N balance, rest, weekly off), fairness counters (nights / Sundays / holidays per person per term); the monthly job on the 20th (**scheduler census +1**) drafting `origin='machine'` periods; nudges on the 25th/28th are events only (the ladder phase sends them).
- Harness `test/roster-sim/`: golden scenarios from 20-U §8 and brainstorm §9, a month replayed with seeded sick calls; assertions: never publishes, never worsens the finding count, deterministic under a fixed seed.
- **Tests:** a drafted month has zero `block` findings for every seeded template at NMC-minimum staffing; the harness runs in CI under the same lock rules.

### R10 · ROUTINE · Close — Plan 20 T7's census row, the doc's §9, the two-pass review (EXECUTE-METHOD-V3 §5A)

**Order:** R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9 → R10. R3 and R4 may be built in parallel
by one session only if its context allows; they do not share files.

---

## 5. Coordination — files that belong to everyone, and what this plan does to them

| file | task | rule |
|---|---|---|
| `kernel/db/schema/index.ts` | R1, R2, R3, R4, R7, R8 | one `export *` line each; rebase first |
| `kernel/modules/manifests.ts` + test | R1 | 23rd manifest, app-only "eight"; **R5 decides whether the worker installs it** (resolver is a function, not a capability) |
| `scripts/seed-roles.ts`, `test/seed-roles.test.ts`, `README.md` | R1 (only if a grant changes) | the four-edit recipe; counts read off the red run |
| `scripts/standup-check.ts` + test | R1, R3, R7 | classification; the three RED rows |
| `app.module.ts`, `worker.module.ts` | R1, R5, R7, R9 | inert seam in R1; worker install decided in R5; jobs in R7/R9 named in the scheduler census |
| `kernel/alerts/consumer.ts`, `kernel/workflow/timers.ts`, `kernel/notify/consumer.ts`, `kernel/desk/staff.controller.ts` | R6 | one commit, rebased minutes before |
| `modules/opd/*` (leaves) | R4 | one commit; run OPD suites |
| `kernel/copilot/*` | **not in this plan** (copilot lane is active) | the tool contract v2 is the copilot phase's first task |
| `apps/web/*` | **not in this plan** | screens are the S-series |

**Frozen:** `kernel/auth/*` (no new permission after R1; no agent grants), `packages/contracts/*`
(the `Actor` union is not widened), `opd_departments` and `opd_doctor_schedules` columns, the
`resources_kind_ck` vocabulary, `kernel/copilot/*`.

---

## 6. Edge cases this plan owes tests for (from 20-U §8 and brainstorm §9; the ids are stable)
E1 E2 E3 E4 E5 E6 E7 E8 E9 E10 E12 E13 E14 E15 E17 E20 E21 E22 · I1 I2 I5 I7 I8 I9 I11 I12 I13
I23 I25 I26 I28 I29 · S1–S4 of the stress test · plus the stress test's named scenarios: stale base;
same-night cross-unit swap; officiating head; vacant intern slot on the 20th; supernumerary JR-1 on
a take night; declared holiday at 19:30 with OT proceeding; 07:59/08:00.

---

## 7. Out of scope — deliberately, and where it went

Screens (S-series, gated on boards) · the ladder L1–L6 incl. lateral rung, busy provider, `call_tier`
consumption, phone verification and the DPDP notice (L-series) · actuals and the muster (A-series) ·
nursing shift patterns, ward boards, the employee statutory rule gate (N-series; **non-doctor
rostering stays off until N1 seeds the rows**) · OPD reading the calendar, the inspection pack, the
clinical activity extract, the AEBAS list (X-series) · copilot tools and the tool contract v2 (the
copilot phase) · duty-scoped permissions (rejected) · `roster_now` cache (measure first) · agent
grants (`kernel/auth`, later) · Plan 41's admission attribution (`unitOnTake` proposes; the
admission carries a reason).

---

## 8. Phases after R, in order — each authored when reached
**S** screens (Roster / Who is on now / My duties, swaps) → **L** the ladder → **X** OPD + inspection
pack + extract + AEBAS list → **A** actuals → **N** nursing → the copilot phase (tool contract v2,
staff masking, roster tools) → Plan 41 consumers.

---

## 9. CLOSE — filled at execution
9.1 commits by SHA · 9.2 kickoff re-measurement (§1) · 9.3 spike answers · 9.4 findings and their
disposition · 9.5 the mutant tally per CRITICAL task · 9.6 the two review passes · 9.7 the token
actuals row (`/token-audit`).
