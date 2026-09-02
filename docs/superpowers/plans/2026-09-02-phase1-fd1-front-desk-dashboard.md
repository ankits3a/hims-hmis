# Phase FD-1 — The front-desk dashboard (Front Desk series, 1 of n)

> **AUTHORED 2026-09-02, NOT APPROVED.** Cut so that every tile reads a rail that already exists.
> **No owner ruling gates this phase.** Runs after VD-2 (lane scope doc, same PR).

**Lane: LIGHT** (5 tasks, one PR each, `lane/front-desk`). **Zero migrations. Zero new permissions.
Zero kernel edits** (D3). **Stop-loss: 1,120,000** per §2.95: coding `1.5 × 90k × 5` = 675,000
(RC-4's measured per-task rate with seams handed over — every seam here is measured in §2) · recon
carry 40,000 · review **405,000** (three-quarters of RC-4's term: three of five tasks are server
providers with exhaustive unit tests and one consumer already in production; the assembly risk sits
in T4/T5). Record the balance at kickoff and at every task boundary (§2.141).

## 1. Why this phase, and what "the dashboard" is

The flow-3 EXECUTE prompt (`2026-08-29-EXECUTE-PROMPT-flow3-front-desk.md`) has no dashboard task
of its own; the front-desk dashboard is the **`Dashboard.dc.html` artboard** of the 30-Aug
registration-desk canvas that the same design series produced — *"your figures"*, reached from the
counter by one key and left by Escape. Measured against the app, **most of it already shipped in
07c and nobody has joined the halves**:

| the artboard says | state | where |
|---|---|---|
| period bar Day/Week/Month/3 mo/6 mo; *"142 registered against a median of 118"*; first-half/second-half drift | **BUILT** | `GET /me/brief`, `brief.ts` SPOKEN list, rendered on `/my-day` |
| *"a comparison needs a fortnight before it can be made honestly"* | **BUILT** | `MIN_BASELINE_DAYS = 14`, `brief.nothingToSay` |
| *Your day — PROVISIONAL*, print with signature line, Download CSV | **BUILT** | `GET /me/report`, one `.print-doc`, `/my-day` |
| today so far — registered, collected, receipts | **BUILT as cards** on `/` | `opd.myVisits`, `billing.myCollections` |
| **registration tile** — registered today, without a mobile, duplicates | **NOT BUILT** — `patients` has no desk provider | `ls apps/core/src/modules/*/desk-provider.ts` → billing, opd only |
| **appointments tile** — due today, checked in, no-shows, needs rebooking | **NOT BUILT** — the hall card counts queues, not bookings | `grep -n appointments apps/core/src/modules/opd/desk-provider.ts` → the booked-today fact only |
| **the drawer** — float, cash/UPI/card, *"cash the drawer should hold"* | **HALF** — collections by mode exist; float and expected cash do not reach any card | `cashier_sessions.opening_float_paise`, `expected_cash_paise` (`schema/billing.ts:293–296`) |
| *what came back* — 3 duplicates, 11 without a mobile, 8 amended within a week | **NOT BUILT** | no facts, no card |
| median time at the counter | **NOT BUILT, and not in this phase** — no timing rail exists; a fabricated figure is worse than none (D6) | — |
| a Desk One screen inside the seat, Esc back to the counter | **NOT BUILT** — `/my-day` is a registry-styled page outside `[data-seat]` | `grep -c data-seat apps/web/src/screens/my-day.tsx` → 0 |

So FD-1 is: **three tiles as desk-card providers** (the consumer, `desk.tsx`, renders whatever
`GET /me/desk` returns — it is already in production and does not change), **plus the figures
screen** inside the seat that composes the brief, the report and those tiles the way the artboard
draws them. Every rail is measured below; each task ships its rail with its consumer.

## 2. Spike — measured before authoring (inline, 0 subagents)

- **S1 — how a tile reaches the home screen.** `ModuleManifest.desk?: DeskProvider[]`
  (`kernel/modules/manifest.ts:50`); `collectDeskProviders` refuses a duplicate key or an undeclared
  permission. A card's stats carry `href`s and the screen makes them doors. **No web change is
  needed for a new card to appear** except its `desk.*` locale keys. A provider's one permission gates
  the whole card, so a second provider per module is the way to gate differently (T2).
- **S2 — registration facts.** `patients.created_by` + `created_at` (indexed together,
  `schema/patients.ts:133`); `phone` nullable by design (D-34); `patient_merge_requests`
  (`winnerId, loserId, status, requestedAt, executedAt`) — a duplicate *I* made is a request whose
  `loserId` I registered. Amendments: `patient.updated` is an event on the append-only log
  (`patients/events.ts:31`); `patients.updated_at` is the cheap approximation. **Measure at T1** which
  the log can answer in the provider's 250 ms budget (`DESK_PROVIDER_BUDGET_MS`); fall back to
  `updated_at − created_at ≤ 7 d`, and say which was used in the card's comment.
- **S3 — appointment facts.** `opd_appointments.status` ∈ booked · checked_in · cancelled · no_show
  · needs_rebooking · rescheduled, `service_date`, `slot_end`, `booked_by`. `listAppointments`
  filters by status and `needsRebooking`. **Measure at T2** whether anything writes `no_show`
  (`grep -rn "no_show" apps/core/src/modules/opd/*.ts`); if nothing does, "missed so far" is
  *booked with `slot_end` in the past*, derived on read, and the card says so.
- **S4 — the drawer.** `GET /billing/sessions/current` (`billing.session.own`); the row holds
  `openingFloatPaise`; `expectedCashPaise` is written at close. **Measure at T3** whether
  `sessions.ts` exposes the live expected-cash computation close uses; the tile must call THAT
  function, never a second formula (D5).
- **S5 — who sees what.** `front_office` holds `patients.register`, `opd.appointments.read`,
  `opd.queue.read` and **no `billing.*`**; `cashier` holds `billing.session.own`. Under the two-desk
  layout RC-4 decided, the clerk's home shows registration + appointments + hall, and the drawer
  card appears only for whoever holds a drawer. That is DD1 working, not a gap.
- **S6 — the seat's chrome.** `registration-counter.tsx:1006` header carries the title, `FlowPill`,
  `DrawerLine`; Escape is already the seat's exit key guarded by `isTypingTarget`; `[data-seat=
  "registration-counter"]` is the alias block (`styles.css:235`). The figures screen mounts inside it.

## 3. Design decisions — DECIDED here

- **D1 — Tiles are server cards; the home screen does not change.** A tile that needed a web
  layout would be the role-selected dashboard 07c DD1 rejected.
- **D2 — No card names a patient.** Stats are counts with doors (`/registration`, `/merge`,
  `/opd/appointments`, `/billing/session`); rows name doctors only (the hall-card rule). So no
  provider reads `getPatientSummaries` and no PHI-access row is written by a home screen.
- **D3 — "What came back" is a CARD, not a brief clause.** Adding a clause means editing
  `kernel/desk/brief.ts`'s SPOKEN list — a file that belongs to everyone. A `patients.cameBack`
  card windowed 30 days back from `ctx.date` needs no kernel edit and the figures screen renders its
  three stats as the artboard's three sentences.
- **D4 — One route: `/counter/seat/figures`**, appended; pin +1 at rebase. Opened from the seat
  header (*your figures*) and by Escape returned to the seat with the patient in hand untouched.
- **D5 — One money formula.** Expected cash on the tile is the function close uses (S4); if none is
  exported, T3 exports it from `sessions.ts` (internal to billing, not an `index.ts` change) and
  close is re-pointed at it in the same PR, with a test that the two agree.
- **D6 — No fabricated figure.** Counter timing is omitted, not estimated. The artboard's
  *"the slow ones are almost all minors"* is a sentence for the phase that measures time.
- **D7 — Print reuses `/my-day`'s document.** Exactly one `.print-doc`; the figures screen mounts
  the same report component, never a second printable node (07a finding).
- **D8 — Two clerks in every assembly test.** Clerk B's cards carry none of clerk A's counts.

## 4. Tasks — one PR each

### T1 — CRITICAL · the registration tile and "what came back" (`patients` provider)
New `patients/desk-provider.ts` registered on `patientsManifest.desk`, permission
`patients.register`. Card `patients.registration` (band *today*): registered by me today → `/registration`;
registered without a mobile today; merge requests pending on my registrations → `/merge`. Card
`patients.cameBack` (30 days): duplicates confirmed (requests **executed** whose loser I registered),
registered without a mobile, amended within a week (S2). `facts`: `patients.noMobile`,
`patients.duplicates` for the rollup (no clause — D3). `desk.patients.*` keys en + hi. **This touches
a hub module but changes no `index.ts` export and no shared type** — the manifest object gains a
field the kernel already declares optional. **Done when:** the provider's unit test pins each figure
against seeded rows; two actors; `collectDeskProviders` passes; `desk.test.ts` census unchanged.

### T2 — CRITICAL · the appointments tile (`opd` second provider)
`opdAppointmentsDeskProvider`, key `opd.appointments`, permission `opd.appointments.read` (a separate
provider so a clerk without `opd.queue.read` still gets it — S1). Card band *now*: due today,
checked in, missed so far (S3), needs rebooking → `/opd/appointments`; rows: doctors with
needs-rebooking counts (leave cascade), never patients. Topics: the day's doctor queue topics so
check-ins flip live. **Done when:** unit-tested against seeded bookings across the three statuses;
a doctor on leave produces a row; nobody else's bookings are counted.

### T3 — ROUTINE · the drawer on the billing card
Extend `billing.myCollections` with the open session: since when, float, cash · UPI · card, **cash
the drawer should hold** (D5), and *no drawer open* when there is none. Internal to
`billing/desk-provider.ts` + `sessions.ts`; **no `index.ts` export changes** — if D5 forces a new
export it goes in its own tiny PR first, named in the description. **Done when:** the tile's expected
cash equals what `close` computes on the same session in one test.

### T4 — CRITICAL · the figures screen inside the seat
`/counter/seat/figures` under `data-seat="registration-counter"`: the period bar and sentences from
`fetchBrief`; *today so far* from the day brief's `compared` clauses; the three tiles read through
`fetchDesk` (T1–T3) rendered as the artboard's sentences and drawer block; *Your day — PROVISIONAL*
with print (D7) and CSV from `fetchReport`/`downloadReportCsv`. Door in the seat header; Escape
returns. Keys under `registrationCounter.figures.*`. **Done when:** two clerks; period switch
re-reads; print mounts one `.print-doc`; Escape returns with the dossier intact (revert pair on the
in-hand carry, and the test goes red).

### T5 — ROUTINE · the assembly, end to end
One vitest file drives `/` for a `front_office` actor (three cards, no drawer), for a `cashier`
(drawer, no registration), then the seat → figures → print → Escape → seat with a patient in hand,
two clerks (D8). Then the clause-by-clause pass of `Dashboard.dc.html` against the screen, each
line met / not met. **Done when:** runs alone green first, then in the full web suite.

## 5. Verify
```
pnpm typecheck && pnpm lint
pnpm --filter @hmis/core exec jest -w 2 src/modules/patients/desk-provider src/modules/opd/desk-provider src/modules/billing/desk-provider src/kernel/desk
pnpm --filter @hmis/web exec vitest run src/screens/desk.test.tsx src/screens/counter-figures.test.tsx src/lib/i18n.test.ts
```
`tools/lane.sh status` before any full core run. CI is the full-suite instrument. Close per method
§5A: two passes, the revert on every guard, counts pasted.

## 6. Owner items
None. (Deletions of `/counter` and `/opd/vitals`, and RC-5's money rulings, are in the lane scope doc.)

## 7. Out of this phase, from the flow-3 brief, for the record
T2 symptom → department master (no table exists), T4 the combined 80 mm slip (the seat prints
`TokenSlip`; the receipt half is unbuilt), T7 the Hindi-first display board. Each is a phase of its
own with a design artboard already on the canvas.
