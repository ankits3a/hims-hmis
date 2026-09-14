# Staff reporting, starting at the front desk

**Date:** 2026-09-14 · **Lane:** `lane/staff-reports` · **Status:** brainstorm, two owner rulings taken

The owner asked for per-staff report generation with easy filtered export, beginning with the front
desk: new/revisit/renewal counts per user and per team, money collection bifurcation, which
department and doctor each act was for, a cumulative-plus-per-screen view, and an MRD patient
register.

## 1. What already exists, measured

This is not a greenfield build. Plan 07c built a staff reporting machine on owner ruling O-2, and
most of the asked-for plumbing is already load-bearing in production.

| Thing | Where |
|---|---|
| `/staff` screen, supervisor's view | `apps/web/src/screens/staff-reports.tsx` |
| `staff.reports.read`, `staff.reports.drill` | `apps/core/src/kernel/desk/manifest.ts` |
| `GET /staff`, `GET /staff/:id/brief`, `POST /staff/:id/drill` | `apps/core/src/kernel/desk/staff.controller.ts` |
| `user_day_facts` — per-user-per-day bag of named integers | `apps/core/src/kernel/desk/rollup.ts` |
| Brief periods + baseline/drift comparison | `apps/core/src/kernel/desk/brief.ts` |
| `DeskProvider.facts()` extension seam | `apps/core/src/kernel/desk/types.ts` |
| CSV writer (RFC 4180, BOM, CRLF) + server-side rupee formatting | `apps/core/src/kernel/report/` |

### 1.1 The actor is already on every act, and indexed

Every act the owner wants attributed already carries who did it, with an index sized for exactly
this query:

- `patients.created_by` — index `(created_by, created_at)`
- `opd_encounters.opened_by`
- `opd_appointments.booked_by` — index `(booked_by, booked_at)`
- `receipts.received_by` — index `(service_day, received_by)`
- `cashier_sessions.cashier_user_id`

### 1.2 new / revisit / renewal is already a stored column

`opd_encounters.visit_type` is `'new' | 'revisit' | 'renewal'`, auto-detected at open by
`classifyVisit` (`kernel/report/visit-type.ts`), and has been since Plan 08's fee branch. The
anchor is the patient's most recent COMPLETED consultation **in the same department**, with the
follow-up window that consult carries (default 7 days; a doctor may set 15/21/30):

- no anchor -> `new`
- within the window -> `revisit` (free follow-up)
- beyond the window -> `renewal` (a fresh consultation fee is due)

The owner's three buckets exist on every visit already. What is missing is that nothing SUMS them.

### 1.3 The facts that exist today

Per user, per day, summable over any window:

```
opd.visitsOpened          opd.patientsRegistered    opd.vitalsRecorded
opd.consultsCompleted     opd.appointmentsBooked    opd.prescriptionsIssued
billing.receipts          billing.collectedPaise    billing.invoicesIssued
billing.cashPaise         billing.upiPaise          billing.cardPaise
billing.invoicedPaise     patients.noMobile         patients.duplicates
```

## 2. Two words that mean two things each

Both of these will produce two reports that disagree in front of the owner if they are not settled
before anything is built.

### 2.1 "New patient"

| Reading | Means | Source |
|---|---|---|
| New registration | A brand-new UHID. Never been to this hospital. | `patients.created_by` -> `opd.patientsRegistered` |
| New visit | No completed consult in THAT DEPARTMENT before | `opd_encounters.visit_type = 'new'` |

A patient of ten years' standing walking into Cardiology for the first time is a new VISIT and not a
new REGISTRATION. The registration desk's headcount wants the first; the department/doctor report
and the consultation fee branch want the second.

**DECIDED (D1):** report both, always labelled. `New UHID` and `New to department`. The bare word
"new" never appears as a column heading anywhere in this feature.

### 2.2 "Department"

The owner used the word for two different things in one paragraph: "the whole department" (the five
people on the front desk) and "which OPD department" (Cardiology, Orthopaedics).

**DECIDED (D2):** they get different names, in the UI and in the code.

- **Team** — a group of STAFF. The front desk team.
- **Department** — a clinical OPD department. Always the clinical one.

**DECIDED (D3):** a team is derived, not stored — the set of active users holding a named role. No
new table, no second list to maintain, and a new hire appears in the team report the moment their
role is granted rather than when somebody remembers to add them to a group.

## 3. The gaps

| # | Ask | Status | Cost |
|---|---|---|---|
| G1 | 1-year period | `day/week/month/quarter/half` only | trivial |
| G2 | new/revisit/renewal counts | column exists, facts do not | cheap — JSONB bag, **no migration** |
| G3 | Team roll-up | missing; every route is one named user | new route |
| G4 | By clinical department / by doctor | data exists; the fact bag cannot hold dimensions | **the fork, §4** |
| G5 | Money bifurcation by service head | tender mode only | moderate |
| G6 | Per-screen split | **not recorded anywhere** | ruled out, §5 |
| G7 | Filtered export | CSV only on `/me/report.csv`, own day | moderate |

### 3.1 The backfill caveat on G2

`LOOKBACK_DAYS = 3` in `rollup.ts`. The nightly job re-rolls three days back, so a NEW fact key
populates going forward plus three days and reads as zero for all history before that.

A zero is indistinguishable from "this person did nothing", which `requireSubject`'s own comment
calls the one answer a supervisor must never be given by accident. So a year of history is not a
side effect of adding the keys — it is a one-off backfill runner over the range the owner wants,
and it is its own task with its own verification.

The source tables are intact and `rollupUserDay` is idempotent by construction (`(user_id, day)` is
the primary key, and A5's re-roll property means the same call over the same date produces the same
bag), so the backfill is safe to re-run. It is work, not risk.

## 4. The fork: where breakdowns live

`user_day_facts` was deliberately built FLAT. From `types.ts`:

> a module returns `{ "opd.visitsOpened": 46 }` and the rollup stores the bag; the kernel adds
> numbers and never learns what they mean.

and

> Keys are `<module>.<fact>` and STABLE — they are stored, so renaming one orphans the history that
> was written under the old name. A key is a schema decision wearing a string's clothes.

"How many patients did Sunita register for Cardiology, under Dr. Rao, as renewals" is
**dimensional** — user x department x doctor x visitType. It does not fit a flat bag.

**Option A — a key per dimension.** `opd.visitsOpened.dept.cardiology`. Cheapest and wrong: keys
grow without bound, and because keys are stored, renaming or retiring a department orphans its
history silently. It converts a clean seam into a schema nobody reviews.

**Option B — two instruments, deliberately.**

- `user_day_facts` stays the **pulse**: totals and trends, cheap, pre-aggregated, six-month and
  one-year windows, the brief and the desk cards.
- A new **range query path** goes live against `opd_encounters`, `opd_appointments` and `receipts`
  for any breakdown and any export, bounded by the date range the reader picked.

**DECIDED (D4): Option B.** The indexes listed in §1.1 already exist for exactly these filters,
breakdowns are read at human pace rather than on every desk render, and the fact bag stays what it
was designed to be.

**The cost of B, stated plainly:** two instruments that must agree. The same window must produce
the same total from the brief and from the range query, or the hospital gets "the dashboard says
214, the export says 211" and neither number is trusted again.

**DECIDED (D5):** a reconciliation test is part of this work, not a follow-up — it pins the brief's
summed facts against the range query's count over the same window, per fact, and reddens when they
diverge. This is the single highest-value test in the feature.

## 5. Owner ruling — the screen axis (G6)

**Asked:** if a clerk uses `/registration`, `/appointment` and `/billing` individually rather than
`/counter`, the owner wants a cumulative report AND a per-screen report.

**Measured:** the seat is recorded NOWHERE. No column on any table; `seat` appears in the schema
only inside comments. And FD-26 made `/registration`, `/appointment` and `/billing` projections of
the same `DeskOne({seat})` component — the same person doing the same act writes a byte-identical
row from either route.

**RULED 2026-09-14 — track the ACT, not the screen.** Registered / booked / billed are already
counted separately per user. A clerk who registers 12 and bills 9 reads identically whether they sat
on the wide counter or the three narrow screens, and the number means the same thing either way.
Adding a seat column would be a migration plus a write-path change in three modules to answer a
training question ("is my staff using the fast route?") dressed as a productivity one.

Not "no, never" — **no column, and revisit only if the act-level numbers turn out to leave a real
question unanswered.**

## 6. Owner ruling — the MRD register

**Asked:** patient name, guardian name, age, gender, address, UHID, for everyone registered with a
consultation done, with clinical department and doctor id, for MRD purposes.

Every field exists: `patients`, `patient_guardians`, `opd_encounters.consult_completed_at`,
`.department_id`, `.doctor_id`.

**This must not be a widening of the staff drill.** The staff brief is explicitly *what, not whom*;
`POST /staff/:id/drill` returns patient rows only with a second permission, a typed reason, an audit
row naming the supervisor — and **one day at a time**. Extending that route to date ranges would
quietly convert a supervision tool into a bulk PHI export, and every supervisor holding
`staff.reports.drill` would gain the register without anyone deciding to grant it.

**RULED 2026-09-14 — its own surface, its own permission, audited, no typed reason.**

- New permission `mrd.register.read`, granted to MRD staff and the owner.
- Every pull appends an audit event naming the reader, the range and the row count.
- **No typed reason.** MRD pulling the MRD register is their job. A reason box that gets "MRD" typed
  into it forty times a day is a control that is not one, and it trains people to treat the audit
  prompt as furniture — which weakens the staff drill's reason box, where it genuinely bites.
- Patient aliasing still applies. `DeskProviderCtx` already separates `actor` (whose rows) from
  `reader` (whose visibility) precisely so a confidential, VIP or staff-as-patient row is aliased
  against the PULLER's clearance. The register uses the same split.

## 7. Remaining decisions, taken on the standard Indian-corporate-hospital answer

- **D6 — the year period.** `Period` gains `"year"`, `SPAN.year = 365`. It carries DRIFT (window's
  own first half against its second half) like `quarter` and `half`, not a prior-period baseline;
  `brief.ts` already documents why, and already handles the odd-length split correctly. Reaching it
  needs `staff.reports.history.year` — see `02-history-horizon.md`.
- **D7 — arbitrary date ranges** live on the range instrument (§4 Option B), NOT on the brief. The
  brief's comparison is DEFINED by its span — an arbitrary window has no honest baseline, and
  07c DD8 already rules that a figure with no honest baseline shows none rather than a bad one.
- **D8 — collection is NET.** Gross receipts minus refunds and credit notes falling in the window.
  A "collection" figure that ignores `credit_notes` and `refund_vouchers` overstates the desk and
  will not reconcile against the day book that already exists.
- **D9 — the bifurcation axes**, in this order: tender mode (cash/UPI/card — already facts) ·
  service head (via `invoice_lines` -> tariff) · clinical department · payer
  (`intended_payer`: self/tpa/pmjay/corporate) · cashier session. Plus invoiced-vs-collected, which
  is the receivable and is already two facts.
- **D10 — export is CSV, and only CSV, for v1.** The kernel writer already handles the two things
  that matter here: RFC 4180 quoting (a patient's name containing a comma) and the BOM (Devanagari
  names in Excel on Windows). CSV opens in Excel and imports into Tally. No XLSX, no PDF.
- **D11 — every report surface exports on its own route and its own filters.** `.csv` on the same
  path with the same query parameters, so the file can never disagree with the screen above it by
  being built from a different query.

## 8. Shape of the work

**T0 — the history horizon** comes first and has its own doc: `02-history-horizon.md`. The owner
ruled 2026-09-14 that how far back a person may look depends on who they are — 3 months for
`front_office`, 1 year for `front_office_supervisor`, unbounded for `medical_superintendent`,
`staff_auditor` and `owner`. It carries D6's `year` period (same files), and it lands first because
every task below adds a surface that must call the check.

1. **T1 — the three visit-type facts.** `opd.visitsNew`, `opd.visitsRevisit`, `opd.visitsRenewal`
   in `opdFacts`. No migration. Redden first against the current provider.
2. **T2 — folded into T0.** The `year` period and the horizon touch the same files.
3. **T3 — the backfill runner.** One-off, idempotent, over an explicit range. §3.1.
4. **T4 — the range instrument.** The live query path of §4 Option B: filters (from, to, users,
   team, department, doctor, visitType, payer), breakdowns, and the reconciliation test of D5.
5. **T5 — the team roll-up.** Role-derived team (D3), totals plus a per-user breakdown table.
6. **T6 — money bifurcation.** D8's net rule and D9's axes.
7. **T7 — the MRD register.** New permission, new surface, audit event, aliasing, range export.
8. **T8 — CSV on every surface.** D10, D11.

T1 and T5 are on the existing pulse and are cheap. T4 is the architectural piece and everything
after it leans on it. T7 is independent of all of them and could fork to its own lane.

## 9. The roles already exist — both open items close

Measured in `apps/core/scripts/seed-roles.ts`:

- **The front-desk team is `front_office`** (with `front_office_supervisor` above it). D3's
  role-derived team needs no new role and no owner question.
- **`front_office_supervisor` ALREADY HOLDS `staff.reports.read`** — and deliberately not
  `staff.reports.drill`, which the file's own comment calls out as a separate string. So the team
  roll-up of T5 lands inside a grant that already exists: the front-desk supervisor can read their
  people's figures today, and gets the team total the moment the route ships. Nothing to grant.
- **`mrd_officer` already exists** and holds `patients.read`, `patients.update`, `patients.merge`,
  `patients.confidential.write`, `patients.deceased.write`. It is the natural and only holder of
  T7's new `mrd.register.read`.
- `staff_auditor` holds the read/drill pair, and `owner` is separate again.

### 9.1 The one coordination cost

`mrd.register.read` is a NEW permission string, and that touches two files CLAUDE.md names as
shared: `scripts/seed-roles.ts` and `test/seed-roles.test.ts`, which pins permission counts. T7
must therefore be sequenced against whatever else is editing those files, and its PR will move a
pinned count on purpose.

**T0 adds two more strings** (`staff.reports.history.year`, `staff.reports.history.full`) and moves
the same pinned count — see `02-history-horizon.md` §6.1. T0 and T7 must not be in flight against
each other. Everything else lives in `kernel/desk`, `kernel/report`, and the
`opd`/`billing`/`patients` providers.

## 10. Still open

- **How far back T3's backfill runs.** One year is the natural answer since the owner asked for a
  one-year period. A runtime argument, not a design decision — the runner takes a range.
