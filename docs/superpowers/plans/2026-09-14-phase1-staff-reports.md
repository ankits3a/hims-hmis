# Phase — Staff reporting, front desk first

**Authored 2026-09-14 in lane `staff-reports`. FOR APPROVAL. NOT EXECUTED.**

Brainstorm: `docs/superpowers/brainstorms/2026-09-14-staff-reports/` — `01-front-desk-reporting.md`
(the gap analysis) and `02-history-horizon.md` (the owner's per-role history ruling). Everything in
§2 was measured at `origin/main` on 2026-09-14.

**Task numbering** supersedes the brainstorm's. `01` §8 listed T1–T8 with T2 later folded away; this
plan renumbers T0–T8 with no gap, and the plan is authoritative.

---

## 1. Why this phase

The owner asked for per-staff reports at the front desk: how many patients each of five clerks
registered, how many were new, revisiting or renewals, how much money each collected and in what
form, for which department and which doctor — filtered, exportable, and over windows from a day to a
year. Plus a patient-level MRD register.

**Most of the machine already exists and nobody is using it.** Plan 07c shipped `/staff`,
`user_day_facts`, the brief, the audited drill and the CSV writer on owner ruling O-2.
`opd_encounters.visit_type` has recorded `new | revisit | renewal` on every visit since Plan 08. The
actor is on every act with an index sized for exactly these queries.

So this phase is a gap-fill with one architectural decision in it, not a build. What changes is that
a question the hospital already asks every month — *"who did what, and what did it earn?"* — starts
having an answer the owner can export.

---

## 2. Ground truth — measured 2026-09-14 at `origin/main`; re-measure at kickoff

| fact | measured |
|---|---|
| **staff reporting machine** | **already shipped.** `/staff` screen, `GET /staff`, `GET /staff/:id/brief`, audited `POST /staff/:id/drill`, `user_day_facts`, `kernel/report/csv.ts` |
| **`visit_type`** | **already a column.** `opd_encounters.visit_type` = `'new'\|'revisit'\|'renewal'`, set by `classifyVisit` at open. Nothing sums it |
| **actor columns, all indexed** | `patients.created_by` `(created_by, created_at)` · `opd_encounters.opened_by` · `opd_appointments.booked_by` `(booked_by, booked_at)` · `receipts.received_by` `(service_day, received_by)` · `cashier_sessions.cashier_user_id` |
| **existing fact keys** | 15. `opd.` ×6, `billing.` ×7, `patients.` ×2 |
| **periods** | `day, week, month, quarter, half`. **No year.** `SPAN = {1, 7, 30, 91, 183}` |
| **`LOOKBACK_DAYS`** | **3.** A new fact key reads ZERO for all history before it |
| **`user_day_facts` retention** | **never pruned.** Nothing in `kernel/retention` or the worker touches it |
| **the baseline fetch** | **fetched for every period, used by `day` and `week` only.** A 3-month brief reads 182 days and shows 91 |
| **`/me/brief`, `/me/report`** | **ungated.** No `@RequirePermission` — DD4 self-scoping: no `userId` in the path |
| **`front_office` grants** | **holds NO staff-report permission.** Its route is `/me/…` |
| **`owner` grants** | **holds NO staff-report permission either.** The owner cannot open `/staff` |
| **`staff.reports.read` holders** | exactly 3: `front_office_supervisor`, `medical_superintendent`, `staff_auditor` |
| **`mrd_officer`** | **exists.** Holds `patients.read/update/merge/confidential.write/deceased.write` |
| **CSV export** | **one route only** — `GET /me/report.csv`, own day. Nothing on the staff brief, the drill, or any range |
| **pinned permission counts** (`test/seed-roles.test.ts`) | `allPermissions` **161** (asserted twice) · `modelPairs` **308** · `modelPermissions` **141** · `heldPermissions` **147** · `NOT_YET_MODELLED` **14** · held + not-modelled = **161** |
| **the README is pinned too** | the root `README.md` carries **two markdown tables the test agrees with cell-for-cell, BOTH DIRECTIONS**, plus **19 named non-table sets**, each authorised by a **README prose line quoted, not paraphrased** |
| **`STAFF_REPORT_PAIRS`** | a non-table set of exactly 2: `front_office_supervisor/staff.reports.read`, `medical_superintendent/staff.reports.read` |

**The count deltas in T0 and T7 are ARITHMETIC, not measurements.** They are derived from the
figures above and are internally consistent (held + not-modelled must equal allPermissions at every
step: 149+14=163 after T0, 150+14=164 after T7). **Read the real numbers off a red test at
execution and correct this plan if they differ** — a predicted count that gets pasted into an
assertion without being run is the defect `evidence over assertion` exists to stop.

### 2.1 Two measurements that changed the design

**The baseline fetch.** Both controllers do `Promise.all([factsForWindow(window), factsForWindow(baseline)])`
unconditionally, and `buildBrief` consumes the baseline only for `day` and `week` — the long periods
carry drift computed from the window itself. Had that stayed, a clerk capped at 3 months would
silently read 6, the cap would need enforcing against the oldest day READ, and the clamping rule
would collide with 07c DD8. **Deleting the unused fetch is a performance fix and the reason the
horizon needs no clamping rule at all.**

**The README is part of the permission schema.** `seed-roles.test.ts` parses the root `README.md`,
agrees with it in both directions, and requires a quoted prose sentence to authorise any grant that
sits outside the two tables. So adding a permission is not `seed-roles.ts` + a count — it is
`seed-roles.ts` + the count + **a sentence of English in the README that the test quotes back**. T0
and T7 each owe one.

---

## 3. Spike — answered by reading at kickoff, 0 subagents

1. **Does `my-day.tsx` share `BRIEF_PERIODS` with `staff-reports.tsx`?** If one constant feeds both
   pickers, the horizon filter is written once. `staff-reports.tsx` already calls
   `useAuth().can(...)`, so the client can filter on `can("staff.reports.history.year")` — read
   whether `my-day.tsx` has the same hook in scope.
2. **What does `loadReport` already return for the front-desk providers?** T7's MRD register must
   not duplicate a section the drill already produces. Read the `report()` implementations before
   writing new SQL.
3. **Is `receipts.service_day` or `receipts.created_at` the money axis?** A receipt taken at 00:30
   for the previous service day answers differently. The existing `receipts_day_cashier_idx` is on
   `(service_day, received_by)`, which is a strong hint — but `billing.collectedPaise` must be read
   to see which one it actually used, because the reconciliation test of T3 fails on this and
   nothing else will explain why.
4. **Does a tariff service carry a CATEGORY?** T5's service-head bifurcation needs one. If it must be
   derived from the service name, that is a different task and the owner should see it named.

---

## 4. Design decisions — DECIDED; none is money, procurement or law

Carried from the brainstorm, restated so this doc stands alone.

- **D1 — "New" never appears bare.** Two figures, always labelled: **New UHID** (`patients.created_by`)
  and **New to department** (`visit_type = 'new'`). A ten-year patient's first Cardiology visit is
  the second and not the first, and one word for both is how two reports disagree in front of the
  owner.
- **D2 — "Team" is staff; "Department" is clinical.** Both words, everywhere, in UI and in code.
- **D3 — A team is derived from a role, not stored.** `front_office`. No new table, and a new hire
  appears when their role is granted rather than when somebody remembers a group.
- **D4 — Breakdowns do NOT go in the fact bag.** It is deliberately flat and its keys are stored, so
  a key per department orphans history on a rename. Two instruments: `user_day_facts` stays the
  pulse; a live range query serves every breakdown and every export. **Reconciled by test (T3).**
- **D5 — The history horizon is a PERMISSION, not a `Record<roleKey, horizon>`.** Roles combine —
  `kernel/desk/types.ts` says so in its own header — and a role map needs a `max()` across the
  caller's roles that will be written without one the first time. Permissions union for free.
- **D6 — Over-horizon REFUSES.** `history_horizon_exceeded`, naming the caller's cap. Never a
  truncated window, never an empty brief: empty reads as *"this person did nothing"*, which
  `requireSubject`'s own comment calls the one answer a supervisor must never be given by accident.
- **D7 — Collection is NET.** Gross receipts minus credit notes and refund vouchers in the window.
  A collection figure that ignores them overstates the desk and will not reconcile against the day
  book that already exists.
- **D8 — Export is CSV and only CSV.** The kernel writer already handles RFC-4180 quoting (a name
  with a comma) and the BOM (Devanagari names in Excel). No XLSX, no PDF.
- **D9 — Every surface exports on its own route with its own filters**, so the file cannot disagree
  with the screen above it by being built from a different query.
- **D10 — The MRD register is uncapped by the horizon.** Statutory retention runs to years;
  `mrd.register.read` is the control, the date range is not.
- **D11 — No seat column** (owner ruling 2026-09-14). FD-26 made the three narrow routes projections
  of one component; the act is already counted separately.

---

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T0 — CRITICAL · The history horizon, and the year period
Owner ruling 2026-09-14. They are one task because they are one edit to `brief.ts`.

- Delete the unused baseline fetch for `month`/`quarter`/`half`/`year` in **both** controllers (§2.1).
- `Period` gains `"year"`, `SPAN.year = 365`; it carries DRIFT like the other long periods.
- Two permission strings in `kernel/desk/manifest.ts`: `staff.reports.history.year`,
  `staff.reports.history.full`. A lattice — `.full` implies `.year` implies the floor (3 months).
- **Five grants:** `front_office_supervisor` +`.year`; `medical_superintendent` +`.full`;
  `staff_auditor` +`.full`; **`owner` + `staff.reports.read` AND +`.full`** — the owner holds no
  staff-report permission today and cannot open `/staff`, which is a live defect this ruling
  exposed. `owner` does **not** get `staff.reports.drill`.
- **A README prose sentence** recording the ruling, quoted by the test (§2.1). Extend
  `STAFF_REPORT_PAIRS` or add a named set; move the pinned counts: `allPermissions` 161 → **163**,
  `modelPairs` 308 → **313**, `modelPermissions` 141 → **143**, `heldPermissions` 147 → **149**.
- One `horizonFor(actor)` + `assertWithinHorizon(oldestDay, horizon)`, called at **six doors**:
  `/me/brief`, `/me/report`, `/me/report.csv`, `/staff/:id/brief`, `/staff/:id/drill`, and T3's
  range route when it lands. **Computed from the CALLER's permissions, never the subject's.**
- **A census test in `ist-clock-parity.test.ts`'s shape** pinning the set of routes that read
  historical days, reddening when a new one appears without the check. A control that depends on the
  next author remembering is not a control.

**The floor narrows an existing capability.** `/me/brief` is ungated and offers all five periods to
everyone today; afterwards a `front_office` clerk stops at `quarter`. **It goes in the release note.**

### T1 — CRITICAL · The three visit-type facts
`opd.visitsNew`, `opd.visitsRevisit`, `opd.visitsRenewal` in `opdFacts`, counted on
`opd_encounters.opened_by` like `opd.visitsOpened`. **No migration** — facts are a JSONB bag.

Fail-first against the current provider. The three must sum to `opd.visitsOpened` for the same
`(actor, date)`, and that is the test.

### T2 — CRITICAL · The backfill runner
`LOOKBACK_DAYS = 3`, so T1's keys read ZERO for all prior history — indistinguishable from a person
who did nothing. A one-off idempotent runner over an explicit `--from`/`--to`.

Safe by construction: `(user_id, day)` is the primary key and A5's re-roll property means the same
call over the same date produces the same bag. It is work, not risk. **Depth is a runtime argument**
— one year is the natural answer since the owner asked for a one-year period.

### T3 — CRITICAL · The range instrument, and the reconciliation test
D4's second instrument. A live query path over `opd_encounters`, `opd_appointments` and `receipts`
using the indexes in §2, with filters (`from`, `to`, users, team, department, doctor, visitType,
payer) and breakdowns. Bound by T0's horizon on `from`.

**The reconciliation test is the point of this task, not a follow-up.** It pins the brief's summed
facts against the range query's counts over the same window, per fact, and reddens on divergence.
Without it the hospital gets *"the dashboard says 214, the export says 211"* and stops trusting both.

### T4 — ROUTINE · The team roll-up
D3's role-derived team. Totals plus a per-user breakdown. **`front_office_supervisor` already holds
`staff.reports.read`**, so this lands inside an existing grant and adds none.

### T5 — ROUTINE · Money bifurcation
D7's net rule, and the axes in order: tender mode (already facts) · service head · clinical
department · payer (`intended_payer`) · cashier session. Gated on spike 4.

### T6 — ROUTINE · CSV on every surface
D8 and D9. `.csv` on the same path with the same query parameters, built from the same call the
screen renders — 07c's own rule, for the reason it gives: a second query disagrees silently.

### T7 — ROUTINE · The MRD register
Owner ruling 2026-09-14: its own surface, not a widening of the staff drill.

- New permission `mrd.register.read`, granted to `mrd_officer` — plus its own README prose sentence.
  Counts move again: `allPermissions` 163 → **164**, `modelPairs` 313 → **314**,
  `modelPermissions` 143 → **144**, `heldPermissions` 149 → **150**.
- Columns: patient name, guardian name, age, gender, address, UHID, clinical department, doctor id,
  registration date, consultation-completed date.
- **Audited**: an event naming reader, range and row count, appended BEFORE the rows are returned —
  `kernel/search/audit.ts`'s rule, because a log of the exports that finished cannot answer for the
  ones that did not. **No typed reason** (ruling): MRD pulling the register is their job, and a
  reason box filled with "MRD" forty times a day trains people to treat the staff drill's reason box
  as furniture too.
- **Aliasing applies.** `DeskProviderCtx` already separates `actor` (whose rows) from `reader` (whose
  visibility) precisely so a confidential, VIP or staff-as-patient row is aliased against the
  PULLER's clearance. Use the same split; do not collapse them.
- **Uncapped by the horizon** (D10).

### T8 — ROUTINE · The front-desk reports screen
The surface that ties T1–T6 together: filters, the new/revisit/renewal split, the money bifurcation,
the department and doctor breakdown, and the export button. The period picker renders only what the
caller may ask for — **convenience, not the control; the server refuses regardless** (T0).

### 5.1 Order and coupling
T0 first — every later task adds a surface that must call the horizon check, and adding it afterwards
means finding them all again. T2 depends on T1. T3 depends on T0; T5, T6 and T8 depend on T3. T4
depends on T0 and T1.

**T0 and T7 both move the pinned permission counts and both edit `README.md`, `scripts/seed-roles.ts`
and `test/seed-roles.test.ts` — three files CLAUDE.md lists as everyone's. They must not be in
flight against each other.** T7 is otherwise independent and could fork to its own lane once T0 has
landed.

---

## 6. Out of scope — named so nobody infers them

- **A seat column** (D11). Ruled out, not deferred pending someone's second thoughts.
- **XLSX and PDF export** (D8).
- **A reporting line.** `staff.reports.read` still means *any* active user's figures; the manifest
  records why a fabricated hierarchy would be worse than an explicit grant. The horizon narrows HOW
  FAR BACK, not WHOSE.
- **Staff reports for the lab, radiology, pharmacy and theatre.** Their fact keys mostly exist and
  the brief already sums whatever a provider contributes; what this phase does not build is their
  SCREENS. Front desk first, as asked.
- **Attendance, leave, payroll.** A report says what a person did, not whether they were rostered —
  that is Plan 20's substrate and a different set of laws.
- **Localising the reports.** The refusals and section headings follow whatever the house does at
  execution time; this phase does not open the English-server-prose question.

---

## 7. Owner rulings — money, procurement, law

**None blocks T0–T8.** Three rulings were taken during the brainstorm (no seat column; MRD its own
uncapped permission; the three history tiers) and are DECIDED above.

**One law-adjacent item is flagged and does not block:** T7's register is a bulk PHI export under
DPDP. The permission, the audit row and the aliasing are the controls this plan builds. Whether an
exported file additionally carries a retention obligation, a purpose annotation or a watermark is a
question about the hospital's DPDP posture rather than about this code, and it can be answered after
the register exists without changing its shape.

---

## 8. CLOSE

### T0 — DONE 2026-09-14

**Verified:** `pnpm typecheck` exit 0 · `pnpm lint` exit 0 (3 warnings, all pre-existing and in
files this task did not touch) · full core **423 suites / 4407 tests, exit 0** · full web
**107 files / 930 tests, exit 0**. Desk suites went 4/40 to 7/78; `seed-roles` 16/16;
`staff-reports.e2e` 8 to 13; `me.e2e` 12 to 13; `my-day` 11 to 14.

**Counts, read off a red run and not from the plan's arithmetic** — every predicted figure held:
`allPermissions` 161 → 163 · `modelPairs` 308 → 313 · `modelPermissions` 141 → 143 ·
`heldPermissions` 147 → 149 · `NON_TABLE_PAIRS` 134 → 139 · `first.held` 141 → 143.

**Two things found while building that were not in the plan.**

**1. The `day` period's same-weekday comparison could never fire.** `baselineWindowFor("day")`
returned a ONE-DAY window — yesterday — and `sameWeekdayBaseline` filters that to days sharing
today's weekday, which yesterday never is. The sample was always empty and `medianOf(sample, 4)`
always null, so the comparison `brief.ts` spends a paragraph justifying was unreachable in
production. It survived because `baselineWindowFor` was exercised for `"week"` only and the
day-period tests hand `buildBrief` a baseline array they build themselves — **a test that calls the
function with an input the real caller never produces cannot detect that the real caller produces a
different one.** Fixed here because T0 was already deciding what each period reads: the day baseline
is now eight weeks, giving eight same-weekday candidates against a floor of four, so one missed
Tuesday no longer costs a clerk their comparison for a month. 56 days sits inside the 3-month floor,
so the shortest-horizon caller keeps it.

**2. Two fixed-date e2e tests were about to expire.** `staff-reports.e2e.test.ts` anchors on
`2026-08-17` while the horizon measures from the real today, so a 91-day window from a date 28 days
past reaches 119 days back — those assertions would have started failing roughly a week after they
were written, for a reason nobody would have connected to this commit. Resolved by saying which
question each test asks: DD14's tests are about WHAT a supervisor may see and now hold
`history.full` so they are time-independent; the horizon's own tests use relative dates. The same
correction was applied to `me.e2e`'s A3 test, whose `2020-01-01` is no longer an empty day but a
refusal.

**What changes for a user — the release note.** `/me/brief`'s period picker offered all five periods
to every signed-in user; a `front_office` clerk could pull six months of their own day and now stops
at three. **This is the only capability in the phase that narrows**, and it is the ruling working as
intended rather than a regression. `front_office_supervisor` gains a year, the three hospital-level
roles are unbounded, and **the `owner` role — which held no staff-report permission at all and could
not open `/staff` — gains the read.**

### T1–T8 — filled at execution end
