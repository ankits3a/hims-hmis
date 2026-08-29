# Plan 07c — My Desk: a home for every person, and their own day, exportable

**Status:** AUTHORED 2026-08-28, NOT APPROVED FOR EXECUTION.
**Depends on:** Plan 07b T1 (the patient-in-hand context) and **Plan 07a** (the read gate — a desk that
surfaces patient rows must not ship before the confidentiality hole behind them is closed).
**Design:** https://claude.ai/code/artifact/b747b39d-30c5-41fa-ba79-0d0e684db508 (interactive, persona-switchable)
**Next free migration: 0039 — this phase takes it, once, for T6.** (07a takes `0038` for the PHI access log.)

**What changed in my thinking, stated plainly.** Plan 07b treated the counter as a *screen to fix*.
That was too small. The counter is not a destination — it is one thing a person launches from their
home, and **the app has no home at all**: `/` redirects every authenticated user, doctor and cashier
and administrator alike, to the patient registration desk. 07b remains correct and ships first;
07c is the frame it belongs in, and it carries the requirement 07b never addressed — *every person
can see and export their own day*.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Nine tasks, five CRITICAL. The CRITICALs are not clinical — they are an authority
boundary (a self-scoped report), a data-egress surface (the app's first export), a boot-time
collector, and a screen that becomes the front door for every user in the hospital.

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA;
reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **730,000 tokens**

- **Per-task rate — 20,178** (Plan 16a; [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). Same bias runbook **O3** records.
- **Task term:** `1.5 × (20,178 × 9) = 272,403`.
- **Review term — TWO FRESH passes: `244,568 + 213,923 = 458,491`** (Plan 14 actuals).
- **Total: 730,894 → 730,000.**

**Escalation:** if the first pass finds a CRITICAL in **T2 or T3** — the self-scoping of the report
and the export path — stop and get owner authorisation for a third fresh pass. Those are the two
places a defect leaks patient data rather than merely showing a wrong number.

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 8,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

### 1.1 The point

Three facts, measured at `69dde01`, not assumed:

1. **There is no home.** `router.tsx`'s index route is an unconditional
   `throw redirect({ to: "/registration" })`. A doctor, a cashier and an administrator all land on
   the patient registration desk. Role changes only which nav links are hidden.
2. **There is no export anywhere in the application.** Zero occurrences of `Content-Disposition`,
   zero file generation, no `pdf`/`xlsx`/`csv-writer` dependency in either package. Every CSV path
   in the codebase is *inbound* — pasted into a `<textarea>` for reconciliation or import. A report
   download would be the **first the app has ever had**.
3. **There is no per-person record of a day.** `dayBook` is whole-hospital and **takes no actor
   filter**. `billing-session.tsx` — one cashier's own drawer — is the only self-scoped screen in
   the entire app.

The data, however, is already there. Every OPD write table stamps its actor, and
`workflow_transitions` holds a per-state-change actor and timestamp for every encounter.
**The daily report is a query nobody has written, not a data-capture project.**

### 1.2 THE SLICE — ruled at write time

**In:** the desk-provider seam, the desk screen at `/`, the self-scoped daily report, the export
pattern, print rendering, queue-session attribution, semantic tokens + the dark-mode wiring.

**Out, and named:** cross-staff analytics and league tables, KPI formula registry (Plan 21 owns it —
§4 DD8), charts of any kind (§4 DD7), kiosks/displays/PBX (Plan 22), scheduled or emailed reports.

---

## 2. Ground truth — measured 2026-08-28 at `69dde01`, **re-measure at kickoff**

| measured | value | where |
|---|---|---|
| Index route | unconditional redirect to `/registration` | `router.tsx` |
| Outbound export paths | **0** | no `Content-Disposition` anywhere in the tree |
| Per-actor report functions | **0** | `dayBook(exec, day)` takes no actor |
| Self-scoped screens | 1 | `billing-session.tsx` |
| Chart libraries | **0** | `--chart-1..5` tokens defined, unused, and greyscale |
| `Card` primitive usage | **0 screens** | every screen hand-rolls `rounded border p-2` |
| Dark mode | CSS complete, **never applied** | no code adds the `.dark` class |
| Locale keys | 1,250 × 2 (en, hi), parity load-bearing | `locales/` |
| Indexes on actor columns | **0**, on all eight tables | none of `opened_by`/`recorded_by`/`issued_by`/`booked_by`/`created_by`/`received_by` |
| Indexes on `receipt_tenders` | **0** — not even its own FK | `kernel/db/schema/billing.ts` |
| Rollup / materialized view precedent | **0** | `daily_closes` is an idempotency claim, not a cache |
| 6-month row volume at target | ~2.5–3 M across the eight tables | 2,000 visits/day; spec asks load tests at 3× |

**Attribution that exists** — `patients.created_by` · `opd_encounters.opened_by` + `service_date`
(already an IST date string) · `opd_vitals.recorded_by` + `danger_flags` ·
`opd_appointments.booked_by` · `opd_prescriptions.issued_by` · `receipts.received_by` +
`cashier_session_id` · `invoices.issued_by` · `workflow_transitions(actor_id, from_state, to_state, at)`
· `workflow_timers(due_at, fired_at)` for SLA.

**Attribution that does NOT exist** — `opd_queue_entries` has **no actor column at all** (no
`called_by`/`skipped_by`); `opd_queue_sessions` has **no actor column AND emits no event**, so
*"who opened Dr Rao's queue this morning"* is unanswerable from any table. T6 closes the second.

**`events` carries an actor on every row and has NO INDEX on `actor_id`.** A per-person daily
report driven off the event log would be a partition scan on every page load. **DD3.**

---

## 3. Spike — answered at kickoff, recorded in §6.3

**S1 — the per-cashier tender split.** `dayBook` sums `receipt_tenders` hospital-wide. Measure the
per-actor slice (`receipts.received_by` → `receipt_tenders.mode`, excluding `entered_in_error_marks`
exactly as `dayBook` does) against a seeded day. **It must reconcile to `dayBook` when summed across
all cashiers** — if it does not, the report is wrong and the phase stops.

**S2 — one request or several.** Measure `GET /me/desk` with every provider a `front_office` +
`cashier` holder unlocks. Budget: **p95 under 300 ms**, matching the CI pin already on patient
search. If a provider cannot meet it, that provider ships lazily behind its own fetch and says so —
the budget is not negotiated downward.

---

## 4. Design decisions

**DD1 — Cards are composed from permissions, never selected by role.** Roles combine; a
role-selected dashboard would need redesigning for every combination and would still be wrong for
the fourth. The desk renders the union of cards the caller's permissions unlock — the same
projection `NAV.filter(can)` already uses. A `front_office` + `cashier` holder gets one desk with
both bands, not a picker.

**DD2 — The desk seam is the manifest's third, not a new pattern.** `ModuleManifest` already carries
`search?: SearchProvider[]` and `resourceKinds?`, each collected at boot with a refusal on a
declaration naming an undeclared permission. `desk?: DeskProvider[]` is collected by
`collectDeskProviders` the same way, refusing the same way. A module owns its own card, so when
pharmacy lands its card ships with it and the kernel learns nothing about pharmacy.

**DD3 — The report reads tables, not the event log.** Attribution exists on the primary tables;
`events` has no `actor_id` index and is partitioned monthly, so aggregating it per person would
scan partitions on every load. Note that the primary tables are **not indexed on their actor
columns either** — DD13 adds those indexes, which is precisely why the report belongs on tables we
can index rather than on an append-only log we should not reshape. `workflow_transitions` supplies
per-transition timing and actor — which the encounter row's last-writer-wins `updated_by` cannot,
since a doctor who starts a consult and a doctor who completes it collapse to one column.

**DD4 — `GET /me/report` takes no `userId`, by construction.** Self-scoping is structural, not a
check that can be forgotten: there is no parameter to tamper with. A supervisor reading across staff
is a **different card behind a different permission**, not an argument on this route.

**DD5 — The export is one model rendered three ways.** One server-computed `DailyReport`
(`{ header, sections: [{ title, columns, rows, totals }] }`) renders on screen, to `.print-doc`, and
to CSV. Screen, paper and spreadsheet cannot disagree because there is one source. Paper is not the
afterthought: a shift report is printed, signed and filed, and the print isolation already exists.

**DD6 — The first export sets the pattern every module inherits, so its governance ships with it.**
Rows carry patient identity → rendered through `patientLabel()`, so confidential/VIP/staff-as-patient
stay aliased (L2). Every export appends `report.exported { actorId, date, scope, rowCount }` —
"who took the patient list home" is asked after an incident, and the DPDP register needs it. The CSV
writer lives in the kernel, escaped and tested once, not re-hand-rolled per module.

**DD7 — No charts.** There is no charting library and the `--chart-*` tokens are greyscale. A
counter dashboard's job is worklists and figures, both of which are better as rows. Bars where a
split needs showing are CSS. Adding a charting dependency for this phase would be scope bought on
credit.

**DD8 — No metric without an honest baseline.** Every figure carries a comparison to the person's
own trailing median, or it ships as a plain count until fourteen days of history exist. **No
targets are invented.** Metric *definitions* belong to Plan 21's KPI registry when it lands; this
phase registers nothing and hard-codes nothing that would collide with it.

**DD9 — A metric the data cannot support is not shipped.** "Average time from arrival to payment,
per clerk" is **deliberately absent**: registration and collection are usually two different actors,
and `receipts` carries no `encounter_id` at all — only `patient_id` — so for a patient with two
visits in one day the join is ambiguous by construction. A plausible wrong number is worse than a
missing one.

**DD10 — Colour means state and nothing else.** The theme is achromatic apart from one destructive
red. This phase adds exactly four semantic tokens — waiting, danger, settled, live — spent only on
state. It also *uses* the `Card` primitive that ships in the kit and that no screen imports, and
wires the dark theme that is fully defined in CSS and never applied.

**DD11 — A stale number must announce itself.** `RealtimeClient` already exposes connection status.
On disconnect the live indicator changes and counts grey out. A dashboard that silently shows a
dropped socket's last value is worse than one showing nothing.

**DD12 — A brief is written, and the sentence is generated, never authored by a model.** Five
periods — day, week, month, 3 months, 6 months — each opening with one deterministic sentence built
from typed facts and thresholds: what changed, against what baseline, caused by what. Templates, so
every clause is testable and no brief can invent a figure. Precedent: the digest writer sits at T0
for exactly this reason. Short periods carry **comparison** (day vs same weekday, week vs prior
week); long periods carry **drift**, which is the only thing six months tells you that one day
cannot.

**DD13 — The long briefs are served from a nightly rollup, because live aggregation is not viable.**
Measured: there is **no index on any actor column** — `opened_by`, `recorded_by`, `issued_by`,
`booked_by`, `created_by`, `received_by` — alone or paired with a date, on any of the eight tables a
brief touches. `receipts` and `invoices` carry nothing beyond a unique document number and
`receipt_tenders` has **no index at all, not even on its own foreign key**. At the 2,000-visit/day
target a six-month window holds ~2.5–3 M rows across those tables, and the spec asks for load tests
at 3×. There is no materialized view, rollup or cache anywhere to lean on (`daily_closes` is an
idempotency claim, not a stored aggregate). So: composite `(actor, date)` indexes **and** a nightly
per-user fact table. Today is read live and marked provisional; every historical window sums the
rollup. The scheduler is ready — daily IST jobs, advisory-locked, heartbeated, idempotent by
construction, with a pinned census test that makes adding one deliberate.

**DD14 — What, not whom (O-2's constraint).** A supervisor's view of a named staff member shows
counts, money, timings, overrides and exceptions. It does **not** list the patients. Drilling from
"3 credit-extended" to *which three* is available, requires a stated reason, and writes a
`staff_report.drilled` row naming the supervisor — so the audit trail covers the auditor. This is
one decision rather than two features fighting: staff activity is hospital work product, patient
identity is not.

---

## 4A. ROUTED TO THE OWNER

**O-1 (carried from 07b, still open):** who covers a single staffer's drawer-lockout.

**O-2 — RULED 2026-08-28: yes.** A supervisor may see a named staff member's daily report. Folded
as **DD14** below, with the one constraint that keeps it lawful as well as useful: the report shows
*what* the person did, not *whom* they did it to, until someone opens a row — and opening one is
itself logged and reason-tagged.

---

## 5. Edge-case pass (owner standing rule)

| # | Case | Ruling |
|---|---|---|
| E-1 | User holds no desk-card permission at all | The desk renders a named empty state, not a blank page or a 403 |
| E-2 | User holds every role (admin) | Cards are capped and ordered; the desk is not an eighteen-card wall |
| E-3 | Confidential / VIP patient in a worklist or an export | `patientLabel()` everywhere, screen and file alike (DD6) |
| E-4 | Report requested for a day before the user existed | Empty sections with zeroes, not an error |
| E-5 | Report requested for today, mid-shift | Allowed and marked **provisional** on screen and on paper; the day is not closed |
| E-6 | Export of a very large day | Streamed, row-capped with an explicit "truncated at N" line — never a silent partial file |
| E-7 | Socket drops mid-shift | DD11 — indicator changes, counts grey, no silent staleness |
| E-8 | Two tabs on one shared terminal | Desk is read-only state; the patient-in-hand stays tab-scoped per 07b DD3 |
| E-9 | Clocks and the IST day boundary | Every day cut uses the existing IST helpers (`service_date` where stamped); no new date math |
| E-10 | Degraded / downtime mode | The existing mode banner shows and the desk marks figures as possibly stale |
| E-11 | A doctor's queue opened by nobody | Until T6 lands this is unanswerable; after T6 it is a supervisor signal |
| E-12 | Retention drops an old month | Reports read tables, not events (DD3), so they are unaffected |

---

## 6. Tasks

Seven. **Four CRITICAL.**

### T1 — The desk-provider seam — **CRITICAL**

`ModuleManifest.desk?: DeskProvider[]`; `kernel/desk/registry.ts` with `collectDeskProviders`
mirroring `collectProviders`; `GET /me/desk?date=` running only the caller's providers, in parallel.

| # | Assertion | Mutant |
|---|---|---|
| A1 | A provider whose permission no manifest declares **fails at boot** | Let it through → a card that answers nothing forever, silently |
| A2 | Only providers the caller holds are executed | Run all and filter the output → work done and data read for cards the caller may not see |
| A3 | One provider throwing degrades that card only | Let it reject the response → one module's bug blanks every person's home |

### T2 — The daily report model — **CRITICAL**

`GET /me/report?date=` → typed `DailyReport`. Per-actor slices for registrations, visits opened,
vitals + danger flags, consults + durations, and the per-cashier tender split from S1.

| # | Assertion | Mutant |
|---|---|---|
| A1 | The route accepts **no** `userId` and reports only the caller | Add the parameter → any holder reads any colleague's day |
| A2 | Per-cashier tenders sum to `dayBook` across all cashiers (S1) | Drop the entered-in-error exclusion → the report disagrees with the day book, and the day book is right |
| A3 | A day with no activity returns zeroed sections, not an error | Throw on empty → every new joiner's first day is a crash |
| A4 | Today's report is marked provisional | Present it as final → a mid-shift figure gets filed as the close |

### T3 — Export, the first one in the app — **CRITICAL**

Kernel CSV writer (escaping, BOM, `Content-Disposition`), a client download hook, aliased identity,
and the `report.exported` event.

| # | Assertion | Mutant |
|---|---|---|
| A1 | A field containing a comma, quote or newline round-trips exactly | Naive join → a patient name with a comma shifts every column after it |
| A2 | Restricted patients export as their alias | Export `name` → the confidentiality rule holds on screen and breaks in the file, which is the copy that leaves the building |
| A3 | Every export appends `report.exported` | Skip the event → the DPDP register cannot answer who exported what |
| A4 | CSV rows equal the printed rows for the same day | Build the file from a second query → paper and file disagree and both are defensible |

### T4 — The desk screen, and `/` stops redirecting — **CRITICAL**

Three bands (Now · Today · Close), permission-composed cards, drill-through on every figure,
realtime counts with the DD11 stale indicator, keyboard focus into the primary action.

| # | Assertion | Mutant |
|---|---|---|
| A1 | `/` renders the desk for every authed user | Keep the redirect → the phase's premise is undone |
| A2 | Every figure links to the rows behind it | Render bare numbers → decoration, per DD1's whole argument |
| A3 | A disconnected socket visibly degrades the counts | Leave them bright → silent staleness at a live counter |

### T5 — Print rendering — **ROUTINE**

The report as one `.print-doc` with a signature line, reusing the existing isolation (one printable
node at a time — the constraint `opd-desk.tsx` already documents).

### T6 — Queue-session attribution — **ROUTINE** · **migration `0038`**

`opened_by` / `closed_by` on `opd_queue_sessions`, plus `queue_session.opened` / `.closed` events.
`setSessionStatus` is currently the only writer and appends **no event at all**. Without this the
silent-lateness signal — a session opened late with no delay declared — cannot be computed, and it
is the single most useful thing a supervisor's desk can show.

| # | Assertion | Mutant |
|---|---|---|
| A1 | Opening and closing a queue records actor and time | Stamp time only → "who" stays unanswerable and the migration was wasted |
| A2 | Both events are declared in the OPD catalogue | Emit undeclared names → the event-name parity test is the thing that catches it |

### T7 — Semantic tokens and the dark wiring — **ROUTINE**

Four state tokens added to the shadcn set; the `.dark` class finally driven by a toggle and
persisted; locale keys for the new screen added to **both** `en.json` and `hi.json` (parity is
load-bearing), avoiding the reserved `count` interpolation name that `billing-office.tsx` documents.

---

### T8 — The five-period brief, the indexes and the rollup — **CRITICAL** · DD12, DD13

Composite `(actor, date)` indexes on the six actor columns; `user_day_facts` written by a nightly
scheduled job after the daily close; the deterministic narrative generator; five period windows.

| # | Assertion | Mutant |
|---|---|---|
| A1 | Every brief window sums the rollup to the same total the live query returns for that window | Let them drift → the brief and the report disagree and both look authoritative |
| A2 | The rollup job is idempotent — a second run the same day changes nothing | Append instead of claim → every retry doubles a person's day |
| A3 | Today's brief is computed live and marked provisional | Serve today from an unwritten rollup → a mid-shift brief reads as zeroes |
| A4 | A narrative clause with no honest baseline is omitted, not invented | Emit "0% vs median" on day one → a fabricated comparison, which is DD8 broken |
| A5 | A backfilled or corrected day re-rolls | Skip → the brief is permanently wrong for that day with no way to fix it |

### T9 — The supervisor's named-staff view — **ROUTINE** · DD14

Named daily/period briefs for staff the supervisor oversees; drill-through gated on a stated reason.

| # | Assertion | Mutant |
|---|---|---|
| A1 | The staff brief carries no patient identity until a drill | List patients inline → DD14 gone, and the supervisor holds a patient list they never asked for |
| A2 | A drill records the supervisor, the reason and the rows revealed | Log the read only → "who looked and why" is the whole point |
| A3 | The route is permission-gated, not self-scoped | Reuse `/me/report` → any holder reads any colleague |

---

## 7. CLOSE

- [ ] Ground truth §2 re-measured at kickoff and corrected in place
- [ ] S1 reconciliation proven against `dayBook`; S2 budget measured and met, or the lazy provider named
- [ ] Every Assertion Book row has a passing test and a killed mutant
- [ ] `nav-parity` and `caddyfile-parity` green; the index route change is deliberate and pinned
- [ ] Locale parity: 1,250 + new keys in both files
- [ ] An export opened in Excel **and** in Tally's importer without mangling a comma or a Devanagari name
- [ ] Named in the close report, not hidden: **DD9** (the metric deliberately absent), **DD7** (no charts),
      **O-2** if still unanswered, and `opd_queue_entries`' remaining actor gap
- [ ] Rollup reconciles to live for all five windows (T8 A1), measured on a seeded 6-month dataset
- [ ] Index impact measured before/after — the brief query is not a sequential scan
- [ ] Stop-loss not exceeded, or the T2/T3 escalation taken explicitly
