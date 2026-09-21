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
| **the stop-loss is RAISED and the phase runs R1 → R10** (owner, 2026-09-20, asked at R1's close when R1's measured cost projected R1–R9 at ~1.3–1.5 M against the prompt's 900 k). The tripwire is lifted, not re-derived; the actuals table in §9.7 still records what it cost | owner 2026-09-20 |
| **the State is BIHAR** — the college and the hospital are in Bihar (owner, 2026-09-20, answering stress test §5.4). Every `roster_rules` row whose `authority` is `'state'` is written against Bihar; until R8 seeds one there are none, and no rule row anywhere else in this plan is a placeholder | owner 2026-09-20 |

---

## 1. Ground truth to re-measure at kickoff (record answers in §9)

| # | fact | how | value on 2026-09-20 |
|---|---|---|---|
| G1 | newest migration on `origin/main` | `ls apps/core/drizzle/*.sql \| tail -1` | **RE-MEASURED 2026-09-20 at kickoff: `0107_pharmacy_authorisations.sql`, unmoved.** R1 wrote `0108_roster_masters.sql`; re-checked at rebase before the PR |
| G2 | `usersHoldingRole` runtime call sites | `grep -rn "usersHoldingRole(" apps/core/src --include=*.ts \| grep -v test` | **RE-MEASURED TWICE. The plan's FILE LIST was right and my first correction was not — see §9.4 F22.** SIX files hold runtime call sites, and there are **14** of them, not eleven: `kernel/alerts/consumer.ts`(**8**, not 5 — this is the only part of the first correction that stands), `kernel/workflow/timers.ts`(2), `kernel/notify/consumer.ts`(1), `kernel/desk/staff.controller.ts`(1), `modules/materials/counts.ts`(1), `modules/materials/transfers.ts`(1). `kernel/workflow/roles.ts` holds the **DEFINITION** — R6 must not "migrate" it. `modules/ot/lists.ts` mentions it **in a doc comment**, exactly as the plan said: no import, no call |
| G3 | department rows | `opd_departments` seed in `modules/opd/config.ts` | **CONFIRMED 2026-09-20: 12 (MED…PHY)**, no anaesthesia, radiology, pathology, community medicine, forensic, casualty, nursing. R1's `org_departments` seeds **24**: those twelve (linked by code) + the eleven of §2.1 + **Respiratory Medicine, which §2.1 omits** — see §9.4 F1 |
| G4 | manifests / permissions / pairs pins | run `test/seed-roles.test.ts`, `src/kernel/modules/manifests.test.ts`, `test/standup-check.test.ts` red and **read the numbers off the failure** | **CONFIRMED as the pre-R1 values, all five.** After R1, read off the failing run and never predicted: manifests **22 → 23**; declared permissions **175 → 178**; model pairs **355 → 359**; model permissions **155 → 158**; held **155 → 158**; `heldPermissions()` **161 → 164**; `NON_TABLE_PAIRS` **169 → 173**; per-role grants `owner` 16 → 17, `medical_superintendent` 15 → 18 |
| G5 | `standup-check` classification | `test/standup-check.test.ts` "every manifest is classified as a department or not" | **CORRECTED: `DEPARTMENTS` / `NOT_DEPARTMENTS` are in `test/standup-check.test.ts`, NOT in `scripts/standup-check.ts`.** `roster` is classified NOT a department (done, R1). **And a second constraint the plan did not carry, found by running it red: every census MODULE except `hospital` owes a `docs/runbooks/*-go-live.md`** — so R1's RED row lives under `hospital`, not under a `roster` key. See §9.4 F2 |
| G6 | DB session timezone | `docker exec hmis-db-1 psql … -c 'show timezone'` | **CONFIRMED 2026-09-20 on `hmis_lane_roster_r1_test_1`: `Etc/UTC`.** Every IST test in this plan — V12 above all — is evidence only because of this |
| G7 | `btree_gist` | `select extname from pg_extension` on a lane test DB after R1 | **CONFIRMED: absent before, present after.** The lane test DB now reads `btree_gist, pg_trgm, plpgsql, unaccent` — `pg_trgm` and `unaccent` are 0021's, the precedent. Asserted in `schema/roster.test.ts`, which is the only thing that knows 0108 created it |
| G8 | T1's code to port | lane `roster`, commit `29f5159d` | `kernel/db/schema/roster.ts`, `modules/roster/*`, `schema/roster.test.ts` — the tests are ported, the schema is regenerated |
| G9 | lanes touching shared files now | `tools/lane.sh status` | **RE-MEASURED 2026-09-20: 25 lanes exist**, `copilot`, `desk-upcoming` and `front-desk-fd25` among them, all with 0 dirty files at kickoff. R1 touched one file any of them might: `modules/opd/index.ts`, one additive `export` line (§9.4 F3). **R4 and R6 must re-read this before they start** — it is a snapshot, and the lock, not this row, is what makes a test run safe |

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

### 9.1 Commits by SHA
| task | branch | commit | PR |
|---|---|---|---|
| R1 | `lane/roster-r1` | `fe53ab8c` → merged `a5e41562` | [#273](https://github.com/ankits3a/hims-hmis/pull/273) |
| R2 | `lane/roster-r2` (stacked on R1) | `6b7ab715` → merged `c485fcec` | [#275](https://github.com/ankits3a/hims-hmis/pull/275) |
| R3 | `lane/roster-r3` (stacked on R2) | `d7757844` → merged `9d7c0527` | [#276](https://github.com/ankits3a/hims-hmis/pull/276) |
| R4 | `lane/roster-r4` (stacked on R3) | `27a98688` → merged `70eebfdb` | [#277](https://github.com/ankits3a/hims-hmis/pull/277) |
| R5 | `lane/roster-r5` (stacked on R4) | *(filled at commit)* | *(filled at open)* |
| — | `lane/roster-clock-core` | `66b4a2e8` | [#272](https://github.com/ankits3a/hims-hmis/pull/272) — **not a phase-R task**: a clock time bomb that turned `main` red at IST midnight on 2026-09-21, diagnosed from R1's full suite and fixed so the phase could merge at all |

### 9.2 Kickoff re-measurement (§1), 2026-09-20

Every row of §1 was re-run with the command in its `how` column and **§1 is corrected in place**;
the three that MOVED are G2, G5 and G9, and one more (G3) grew a consequence. In summary:

- **G1 unmoved** — `0107_pharmacy_authorisations.sql` is still the newest on `origin/main`; R1 wrote
  `0108_roster_masters.sql` and re-checks the serial at rebase, never at start.
- **G2 was wrong about a COUNT and my first correction was wrong about the FILES** (F22). The
  settled measurement: six files, fourteen call sites, `kernel/alerts/consumer.ts` holding eight of
  them rather than five. `kernel/workflow/roles.ts` is the DEFINITION; `modules/ot/lists.ts` is a
  doc comment, as the plan always said.
- **G3 confirmed at 12**, and it forced F1 below.
- **G4 confirmed** as the pre-R1 values; every post-R1 number was read off a failing run.
- **G5 WAS WRONG about the file**, and carried an unstated second constraint — F2 below.
- **G6 confirmed `Etc/UTC`** on `hmis_lane_roster_r1_test_1`. Every IST assertion in this plan,
  V12 above all, is evidence only because of this.
- **G7 confirmed** absent before / present after: the lane test DB now reads `btree_gist, pg_trgm,
  plpgsql, unaccent`.
- **G8** — T1's module scaffolding is ported (`manifest`, `index`, `roster.module`, `errors`,
  `access`); its schema is NOT, and its `0108` is not carried.
- **G9 re-measured at 25 lanes.** R1 touched one file another lane might: `modules/opd/index.ts`.

### 9.3 Spike answers
*(none owed by R1)*

### 9.4 Findings and their disposition

| # | task | finding | disposition |
|---|---|---|---|
| **F1** | R1 | **§2.1's department list is one short of what §0 requires.** §0 rules the establishment is `5/5/3/3/4/2/2/1/1` **plus Respiratory Medicine as its own one-unit department** — 27 units — and R3 seeds *"the 27 units, one per department per §0"*. §2.1's list is the twelve OPD rows + eleven named departments, and **Respiratory Medicine is not among them**, so R3 would have had 26 departments to hang 27 units on. 20-U §2 records why it is easy to miss: UG-MSR 2023's final table has no Respiratory row at all (its faculty count under Medicine, FAQ Q8). | **FIXED IN R1**, additively: `ORG_DEPARTMENTS` seeds **24** rows — the twelve linked clinics, §2.1's eleven, and `RESP` Respiratory Medicine. Recorded in `masters.ts`' own header so R3 does not re-derive it. |
| **F2** | R1 | **A census module owes a go-live runbook, and the plan's §4 R1 asked for a `roster` module key that could not have one.** `test/standup-check.test.ts` holds an invariant the plan never carried: *every key of `STANDUP_ROWS` except `hospital` must have a `docs/runbooks/*-go-live.md`*. Adding `roster: [...]` turned it red (`withoutRunbook: ["roster"]`). The roster is classified NOT a department in the same file, so a runbook would have documented a go-live day that does not exist — and the alternative, a second hard-coded exemption, weakens the guard that caught the missing OPD rows. | **R1's RED row is filed under `hospital`**, whose declared exemption is that it holds *"the rows every department's opening rests on"* — which `org_departments` and `roster_positions` literally are. No guard was weakened and no exemption added. **R3 and R7 inherit this**: their rows go under `hospital` too, unless the S-series has by then given the roster a real go-live day and a runbook of its own. |
| **F3** | R1 | **The census that proves the roster covers every OPD clinic could not be written**: the lint rule (spec §4) forbids a module reaching into another module's internals, and `DEFAULT_DEPARTMENTS` lived only in `modules/opd/config.ts`. Transcribing the twelve codes into the roster would have been a copy that goes stale the first time somebody adds a thirteenth — the exact defect the census exists to catch. | `DEFAULT_DEPARTMENTS` is re-exported from `modules/opd/index.ts`, **additively and read-only**, one line. `modules/opd` is a file everyone imports, so R1 rebases immediately before its PR. |
| **F4** | R1 | **The plan's "hospital-scope fallback" would have been dead code.** §4 R1 asks for the permission checked at department scope *"with a hospital-scope fallback"*. `kernel/auth/permissions.ts` already grants any required scope to a HOSPITAL-scoped holding (`if (h.scopeType === "hospital") return true`), so a second call would never have changed an answer — and would have looked load-bearing to the next reader, who would widen it. | **No fallback call written.** `requireRosterAct` asks at `department` when the act names one and at `hospital` when it does not; the asymmetry (a department holding does NOT satisfy a hospital check) is asserted in `access.test.ts`. The reason is written into `access.ts` so it is not "fixed" later. |
| **F5** | R1 | **`events.ts` is in §4 R1's file list and R1 emits no event.** T1's two events are about periods, which arrive in R2; shipping them in R1 would be an event catalog with no writer (`readers-without-writers`, one direction over), and the V9 schema walk would be vacuous over an empty or unused list. | **Deferred to R2**, which owns the events, the writers and V9 together. R1 ships no `events.ts`. |

| **F6** | R2 | **`array_length('{}', 1)` is NULL, and a CHECK whose expression is NULL PASSES.** `roster_periods_covers_ck`, written the obvious way as `array_length(covers_positions, 1) >= 1`, accepted exactly the row it exists to refuse — a roster answering for no position at all. Found by the red run of the schema census, not by reading. | `coalesce(..., 0) >= 1`, with the reason written into the constraint's own comment. 0109 was re-cut and the lane test DBs dropped (`drizzle-when-silently-skips` trap 2). |
| **F7** | R2 | **`amend` inserted its new rows already live, so the exclusion constraint fired before the sentence did.** A ward sister recording a 02:00 cover would have been shown `conflicting key value violates exclusion constraint "roster_assignments_no_double_presence_excl"` instead of the name of the person already on. `publishPeriods` did not have this defect because drafted rows are inserted not-yet-effective. | The amendment now inserts `effective: false`, runs `presenceClashes`, and flips to live only after — with the constraint kept as the backstop it was always meant to be, wrapped and translated. |
| **F8** | R2 | **The plan's V7 (*"superseded rows keep every original value except `live_to`/`effective`; `updated_by` untouched by supersede"*) was violated by the first draft of both writers**, which stamped the publisher over `updated_by`. Written before the invariant table was re-read. | Both writers now set `effective` and `live_to` only. The reason — that a supersede closes a knowledge window and does not edit a duty, so the senior resident who wrote it must still be named on it two years later — is in the code at both sites, and asserted by a test that plants a different author and reads it back. |
| **F9** | R2 | **Drafting from a base COPIES its slots**, and three of this task's own tests then added the same person to the same window again and read the resulting refusal as a defect in the gate. A test defect, not a code one — but it is recorded because the next reader will make it too. | The tests now either rely on the copy or `unassign` it first, and `copiedAssignments` is asserted where it matters. The cross-unit swap test models what a human does: take the copied person off, put the other one on. |

| **F10** | R3 | **An emptiness check reads GREEN on an empty box, and this file had already learned it once.** The `roster_units_confirmed` census row, written the obvious way as *"nothing is unconfirmed"*, was green on a fresh database: `unconfirmedTeams` returns `[]` when nothing is seeded, and an empty list satisfies "none outstanding". It is the same defect `radiology_devices_licensed` was fixed for one module over, in the same file, with the reason written beside it. | The row now requires the units to EXIST before their confirmation is evidence of anything. **Found by `standup-check.test.ts`'s fresh-database leg** — the guard written for that exact lesson, doing exactly its job, which is the argument for keeping it. |
| **F11** | R3 | **A delegation mapped to a PERMISSION rather than an ACT is a hole.** All six roster authorities are gated on `roster.periods.publish` today, so the natural implementation — *"a delegation grants the permission it corresponds to"* — would let a head who delegated **leave approval** find their deputy publishing the month's rota. | `ACT_AUTHORITIES` maps act → the authorities that satisfy it (`publish` ← `publish`; `accept_warning` ← `override_rule`; `declare` ← `declare_holiday`/`declare_mode`), and mutant M3 widens it to prove the narrowing is load-bearing. Two further narrowings recorded in `access.ts`: the delegation path runs only after the ordinary check fails, and only after `rosterActPolicy` — so **no delegation can ever put a machine through the `never` column**. |
| **F12** | R3 | **`access.ts` needed the delegation read and `delegations.ts` needed `access.ts`'s permission check** — a require cycle that happens to work under the CommonJS ts-jest emit, because both bindings are only touched at call time, and would stop working the day the module is loaded any other way. | `delegations-read.ts`: a ten-line file that makes the dependency a DAG instead of a bet. |
| **F13** | R3 | **A delegation test that does not separate the ACTOR from the DELEGATOR only ever sees the first check.** The first version expected `delegation_not_held` and got `not_permitted`, because the actor recording the delegation was also the person whose authority was being handed on. | The test now uses the superintendent's office as the recorder and the HOD as the delegator, and asserts BOTH refusals in their order. A test defect, recorded because the two checks are genuinely distinct and the next reader will conflate them too. |

| **F14** | R4 | **A decided-pair CHECK refuses the cancel of an approved record.** `(status in ('approved','rejected')) = (decided_at is not null)` is the obvious reading and is wrong in the ordinary case: a consultant's approved leave is called off, the status becomes `cancelled`, and the row still carries who approved it — as it must, because that approval happened. **Found by the OPD projection test**, whose cancel path exercises an APPROVED row; `absences.test.ts` had only ever cancelled a REQUESTED one, so the gap was in the test, not the reading. | The CHECK is a `case` on the status; 0111 was re-cut and the lane test DBs dropped. The missing leg was added to `absences.test.ts` — cancelling an approved absence keeps `approved_by` — and mutant M2 covers the segregation beside it. |
| **F15** | R4 | **`request_absence` is an act stress test §4 does not have.** The document is about acts on a ROSTER; being absent is a fact about a person's own life. | Added to the matrix rather than assumed, with every actor kind decided in writing, and the transcription in `policy.test.ts` marked as R4's own row rather than §4's. `user: open` (you may always file your own; somebody else's additionally needs `roster.periods.manage`, enforced in the function because a matrix cannot say "your own"); **`copilot: never`**, because the reason is the most sensitive string this phase stores and the person can file it themselves in as many taps. |
| **F16** | R4 | **The OPD leave screen has its own authority and cannot be made to hold a roster string.** `opd_admin` has scheduled consultants' leave since long before the roster existed; requiring `roster.periods.publish` would break that act, and the realistic repair would be granting the OPD admin every rota in the hospital. | `recordAbsenceUnchecked`, whose NAME is the control, with the checked `recordAbsence` as the front door everything else uses — and a test that pins its call sites **by name** (`modules/opd/leaves.ts` and the front door itself), so a third cannot appear quietly. |
| **F17** | R4 | **`opd_doctor_leaves.absence_id` cannot be a real foreign key.** `org_departments` references `opd_departments` and `roster.ts` references `org.ts`, so an FK from opd to roster closes the loop `opd → roster → org → opd` — and a cycle between drizzle table modules resolves to `undefined` at load time rather than failing loudly. | Plain text, as `opd_doctors.user_id` three columns up already is, with the reason written at the column. |
| **F18** | R4 | **The export census's fixpoint could only see EXPORTED functions**, so `approveAbsence` — which delegates to a private `decide` that carries the check — read as dangling. The census would have forced a worse design to satisfy itself. | The scan now walks every function in the module, exported or not. The fixpoint is unchanged; only its population grew. |

| **F19** | R5 | **A DEPARTMENT-scoped roster did not answer a question about a TEAM inside it.** The first `periodsAnswering` matched a team question only against periods whose own `team_id` was that team — so a department-pooled night, published at department scope, came back `static` for every unit in the department. That is the S4 shape failing in the one place S4 is about: the pooled night exists *precisely* so that no unit publishes it. | The reach now includes "a period for this team's department that names no team". Mutant M2 covers the slot-level half. |
| **F20** | R5 | **The worker manifest question the plan (§5) left to this task.** | **DECIDED: the worker does NOT install it.** R6 moves the worker's alert and timer consumers onto `whoIsOn`, which is a FUNCTION over tables — the worker already has the same database, so what it needs is the tables, not the manifest. A manifest carries permissions, a menu and SUBSCRIPTIONS; the roster declares none until R7's nightly job and R9's monthly draft, each named in the scheduler census by the task that adds it. The reasoning is written into `manifests.test.ts` (1j) so the absence does not later read as an oversight. |
| **F21** | R5 | **My own scoping test proved less than its name claimed.** *"A Medicine question never answers with Surgery's resident"* passed with the slot-level `reaches` stubbed to `true` — because in that fixture Medicine had published nothing, so the answer was `static` whatever the scoping did. It was exercising the PERIOD filter and nothing else. Found by mutant M2 killing only one test instead of two. | A leg added where BOTH departments have published, which is the state a real hospital is in; and the pooled-night test now says in its own comment that it is the one exercising a slot's cover scope. **The mutant's job was to grade the assertion, and it did.** |

| **F22** | R5 | **MY OWN GROUND-TRUTH CORRECTION WAS WRONG, and R6's work list depended on it.** At kickoff I re-measured G2 with `grep -rn "usersHoldingRole(" … \| grep -v test` and reported *"EIGHT files and 16 call sites"*, calling `modules/ot/lists.ts` *"a real call site, not a comment"*. It is a comment — line 26 of a doc block, with no import of `workflow/roles` anywhere in the file. **`grep -v test` excludes test FILES; it does not exclude COMMENTS**, and a mention of a function name inside prose reads exactly like a call to a line-oriented search. I had corrected a correct row into an incorrect one, and R6 would have been sent to edit a leaf module that does not call the function. | Re-measured a third time, by reading the matched lines rather than counting them (AGENT-RULES 20's own instruction, which is written about `pgrep` and applies here word for word). §1 G2 now records six files and fourteen call sites, and says which of my two claims survived: only `alerts/consumer.ts` having **eight**. Caught before R6 started, by re-reading the evidence rather than the number. |

### 9.5 Mutant tally

| task | mutant | built as | result |
|---|---|---|---|
| R1 | `rosterActPolicy` lets a named `system` job publish (`MATRIX.publish.system = open`) | `policy.mutant.ts` + `policy.mutant.test.ts` | **DIED**, 2 failed / 0 passed. `the matrix agrees with stress test §4, cell for cell` → `- "system": "n"` / `+ "system": "y"`; `NOTHING but a person publishes` → *Expected constructor: RosterError / Received function did not throw* |
| R1 | the positions seed inserts nothing (`for (const p of [])`) | `masters.mutant.ts` + `masters.mutant.test.ts` | **DIED**, 2 failed / 0 passed. `seeds both lists, and a SECOND run adds nothing` → `- "added": 17, "present": 0` / `+ "added": 0, "present": 17`; the standup row's own question → `Expected: "green: true" / Received: "green: false"` |

| R2 | **M1** — the supersede leaves the old version's rows in effect until AFTER the new ones enter it (the un-effecting moved out of step 3 to after step 5) | `periods.M1-….mutant.ts` + spec | **DIED**, 4 failed / 26 passed. `RosterError: kavita.rao would have to be in two places at once` on the supersede, the cross-unit swap, the stale-base and the event-log legs — which is precisely the failure the ordering exists to prevent |
| R2 | **M2** — the V3 stale-base check removed | as above | **DIED**, 2 failed / 28 passed. `Expected: "stale_base"` / `Received: "presence_overlap"` — the lost update stops being refused for the reason a human could act on |
| R2 | **M3** — the V4 content-hash check removed | as above | **DIED**, 1 failed / 29 passed. `expected a RosterError, got: null` — the publish of a roster that moved after the head read it simply succeeds |
| R2 | **M4** — the advisory lock never taken | as above | **DIED**, 1 failed / 29 passed. `Expected: 1` / `Received: 0` from `pg_locks` inside the transaction — which is why the lock is ASSERTED rather than raced for (a race test flakes on a busy box and proves nothing on an idle one) |

| R3 | **M1** — `teamMembers` ignores officiating rows | `teams-officiating-ignored.mutant.ts` + spec | **DIED**, 1 failed / 14 passed. `Expected: "head"` / `Received: "faculty"` — the head on leave is the one whose phone gets rung |
| R3 | **M2** — `nightPoolFor` counts every member whatever place they hold | `teams-night-pool-ignores-retention.mutant.ts` + spec | **DIED**, 1 failed / 14 passed, on the leg that a rotation which did NOT keep its nights leaves the pool |
| R3 | **M3** — any delegated authority satisfies any act (F11's hole, restored) | `access-delegation-widened.mutant.ts` + spec | **DIED**, 2 failed / 7 passed. `expected a RosterError, got: null` — a delegated leave approval publishes the rota |
| R3 | **M4** — the intern extension is served wherever the year starts, not where the absence happened | `interns-extension-misplaced.mutant.ts` + spec | **DIED**, 3 failed / 9 passed. `Expected: "PED"` / `Received: "COMM"` — V17's second half |

| R4 | **M1** — D6 redaction removed: the reason travels to every reader | `absences-redaction-removed.mutant.ts` + spec | **DIED**, 3 failed / 14 passed. `Received: "my father is in ICU at Patna"` where a stranger's read must be null |
| R4 | **M2** — the requester/approver segregation removed | `absences-self-approval-allowed.mutant.ts` + spec | **DIED**, 2 failed / 15 passed, on "the person who ASKS is not the person who ALLOWS" |
| R4 | **M3** — the attendance projection counts absence OUTSIDE the term | `absences-projection-unclipped.mutant.ts` + spec | **DIED**, 2 failed / 15 passed. `Expected: 30` / `Received: 120` — four months of maternity leave counted against a term that had one of them in it |
| R4 | **M4** — the OPD inclusive→half-open conversion off by one day | `opd-leave-window-off-by-one.mutant.ts` + spec | **DIED**, 2 failed / 2 passed. `Expected: "2026-08-20T18:30:00.000Z"` / `Received: "2026-08-19T18:30:00.000Z"` — the doctor left rostered on the last day of their own leave |

| R5 | **M1** — the flag ignored, so the resolver is always on | `resolve-flag-ignored.mutant.ts` + spec | **DIED**, 2 failed / 15 passed. `Expected: "static"` / `Received: "published"` — "off" stops meaning parity |
| R5 | **M2** — a slot's cover scope dropped: every slot reaches every question (Plan 20 T2's actual defect) | `resolve-scope-dropped.mutant.ts` + spec | **DIED**, 1 failed / 16 passed, on the pooled-night leg — **and the single kill is what produced F21** |
| R5 | **M3** — an undeclared position treated as declared | `resolve-undeclared-treated-as-declared.mutant.ts` + spec | **DIED**, 1 failed / 16 passed. `Expected: "static"` / `Received: "published"` — a hole starts reading as "nobody is on" |
| R5 | **M4** — approved absence not subtracted | `resolve-absence-not-subtracted.mutant.ts` + spec | **DIED**, 1 failed / 16 passed, on V13 — the phone of somebody on leave |

Every mutant module and spec was deleted before the counts; `git status --porcelain` carried no
`*.mutant.*` in any task.

**One thing the R4 mutant runs surfaced about the instruments themselves:** three of the four
reddened `recordAbsenceUnchecked`'s call-site census as well, because a mutant file is a COPY of
`absences.ts` and therefore contains a genuine extra call site. That is the census answering
correctly about the tree it was given, not a defect — but it is worth knowing before reading a
mutant run, because it adds one expected failure to every mutant of that file.

### 9.6 The two review passes
*(filled at R10)*

### 9.7 The token actuals row (`/token-audit`)
*(filled at R10)*
