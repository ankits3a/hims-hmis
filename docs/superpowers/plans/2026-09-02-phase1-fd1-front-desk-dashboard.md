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
needs-rebooking counts (leave cascade), never patients. ~~Topics: the day's doctor queue topics so
check-ins flip live.~~ (CLOSE pass 1: no topics — `queue:*` needs `opd.queue.read`.) **Done when:** unit-tested against seeded bookings across the three statuses;
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

## 5A. CLOSE — 2026-09-02, T1–T5 done, code-complete, NOT deployed (review passes below when run)

**PRs, one per task, stacked:** #21 T1 · #22 T2 · #23 T3 · #28 T4 · T5 (this commit). Zero migrations,
zero permissions, zero kernel edits, zero index exports.

### 5A.1 The Dashboard artboard, clause by clause, against the shipped screen

| the artboard says | verdict |
|---|---|
| "CRK Registration · Ramesh Kumar · your figures" header, "Back to the counter · Esc" | **met** — the actor id, the date, Escape outside a field returns (T4) |
| period bar Day / Week / Month / 3 months / 6 months, the range | **met** — `BriefPanel` re-read with `period=` |
| "your week in sentences, not tiles — a median is a comparison and a comparison is a sentence" | **met** — the brief's `compared`/`drift`/`plain` clauses (07c) |
| "a comparison needs a fortnight of history before it can be made honestly" | **met** — `brief.nothingToSay` |
| "Median 1 m 24 s at the counter. The slow ones are almost all minors" | **NOT met, by decision (D6)** — no timing rail exists; nothing is estimated |
| what came back: 3 duplicates → urgent merges, "all three already had that mobile on file", See all three | **met** as the three sentences from `patients.cameBack`; "already had that mobile on file" is NOT computed (it needs the merge snapshot's phone) — recorded |
| 11 records with no mobile, six SMS bounced, four missed a follow-up | **met** for the count; SMS bounces and missed follow-ups are **NOT built** (no SMS rail) |
| 8 amended within a week — "almost all a spelling, off an ID at the second visit" | **met** for the count (the `patient.updated` event inside seven days) |
| "this is your own account and nobody else's; your supervisor sees the same counts under Staff reports" | **met** — self-scoped rails; `/staff` is 07c's |
| today so far: 38 (median 31) registered, ₹1,900 · 38 receipts, 1 m 24 s median | **met** for registered and money (the day brief's `compared` clause and the collections card); timing omitted |
| the drawer: opening float, cash / UPI / card, "cash the drawer should hold", "a variance is a conversation" | **met** — `liveExpectedCashPaise` (T3), the close's own formula; UPI/card by mode were 07c's |
| "Your day — PROVISIONAL … Print · Download CSV", signature and received-by lines | **met** — one `.print-doc`, `/me/report` |

### 5A.2 Evidence at T5
| instrument | result |
|---|---|
| web full `vitest run` | **75 files / 562 tests, exit 0** (T4) · desk.test 7/7 with the three tiles (T5) |
| core `jest -w 2`: patients/desk-provider, opd/desk-appointments, opd/desk-provider, billing/desk-provider, billing/sessions, kernel/desk, me.e2e, nav-parity, seed-roles, caddyfile-parity | green in every task's run; me.e2e **12/12** with the two FD-1 assemblies (a registration clerk's desk: five cards, no drawer; a cashier's: the drawer, no registration tile) |
| `pnpm typecheck` · eslint | 0 · clean |
| revert pairs | **R64–R81**: all red on first or second run; three needed fixture fixes to be falsifiable (R64 the merge winner another clerk's; R70 a last-week rebooking row; R76 an over-tender with change declared — receipts are append-only) |
| assembly | `me.e2e` drives the REAL providers over the real roles; the web renders the server's cards through the unchanged home screen; the figures screen composes three rails with two clerks |

### 5B. Pass 1 — two fresh reviewers over the green tree: 1 CRITICAL, 10 MAJOR — for the sixth phase running

| # | finding | fix | revert pair |
|---|---|---|---|
| **C1** (B) | the query client outlives a logout and the keys carried only the date: the next clerk on the same counter tab read the last clerk's figures for up to five minutes and could print them over her own signature line | the ACTOR is in every `/me/*` key (figures, my-day, desk); a test with one client and two logins | R85 red |
| M1 (A) | "amended within a week" counted photo attaches and QR reissues (both append `patient.updated`) | the predicate reads `changes[].field`; `recorded_at` bounded for partition pruning | R82 red |
| M2 (A) | the appointments card named `queue:*` topics its own permission cannot subscribe to (silent refusal on the web); bookings are not realtime names anyway | no topics — the tile is as live as the poll, honestly | R84 red |
| M3 (A) | the drawer moved three unindexed scans onto every home-screen load; past the 250 ms budget the whole collections card vanishes | `receipts(cashier_session_id)` and `refund_vouchers(cashier_session_id)` indexed — **migration 0055**, taken at rebase; the tile's three sums in one transaction | — (a budget pin is not written; recorded) |
| M4 (B) | a failed `/me/report` printed as an honest empty day | said, never printed; print disabled until the report arrives; the brief says when it fails | R86 red |
| M5 (B) | a missing came-back stat was spoken as "0 of your registrations…" (D6) | a sentence only for a figure the server gave | R87 red |
| M6 (B) | a cleared date box sent `?date=` and 400'd three routes at once | the box asks nothing until it holds a date | R88 red |
| M7 (B) | every door was a full page load, against the router's own rule | figures and the seat's door are client-side navigations handed in by the route wrappers; the anchor keeps its href | R89, R90 red |
| M8 (B) | the round trip seat → figures → Escape → seat was untested | tested under the real router with the patient in hand | — |
| M9 (B, inherited) | the print is one fixed page repeated for a long screen | **NOT fixed** — 07a's `.print-doc` model; the figures sections are `display:none` on print, so the page count is the document's; a 40-row day is the evidence to gather |
| MINOR (A) | merged losers counted as "without a mobile"; the appointments card is hospital-wide (D8 unmet for it); the tile's reads were not one snapshot | excluded (R83 red); **DECIDED hospital-wide** and a second clerk asserted equal; one transaction |
| MINOR (B) | Escape with the palette open navigated | the seat's F7 guard |

**Assertions pass 1 named in-band, and the answer:** "not.toContain('Kamla')" and `rows === undefined` are D2 tripwires, kept; the 7-day and 30-day EDGES are still untested (2 d / 12 d and 16 d / 38 d) — recorded; the real-clock suite can flake at 00:00 IST — recorded; the cashier e2e's "float equals expected before any sale" is in-band under a formula ignoring tenders, and the billing unit test's over-tender is the discriminator.

### 5C. Evidence after pass 1
| instrument | result |
|---|---|
| web full `vitest run` | **75 files / 567 tests, exit 0** |
| core `jest -w 2`: patients/desk-provider, opd/desk-appointments, billing/desk-provider, billing/sessions, me.e2e (over migration 0055) | **5 suites / 36 tests, exit 0** |
| `pnpm lint` · `pnpm typecheck` | 0 errors (2 warnings in other lanes' kernel tests) · exit 0 |
| revert pairs | **R64–R90**: 24 red on first or second run; three needed a fixture (R64, R70, R76) |
| migrations · permissions · kernel · index exports | **1 (0055, two indexes)** · 0 · 0 · 0 |

### 5D. Pass 2 — briefed at the fixes (one fresh reviewer, 102k): 7 CORRECT, 4 INCOMPLETE, NO WRONG

| # | pass-2 finding | fix | revert pair |
|---|---|---|---|
| C1 INCOMPLETE | the ROOT was untouched: `logout()` never touched the query client, so every other per-person key (the seat's drawer line, `/billing/session`, the doctor's identity, alerts) still painted for the next login | `logout()` clears the query client — the class, not three consumers (`lib/auth.tsx`, a shared file: the one change outside this lane's screens, named here). A boot-time clear on a stale token was tried and REMOVED: screens fetch before `/auth/me` answers and three GRN tests proved it | R91 red |
| M4 INCOMPLETE | a report that was there and then failed to refetch stayed printable under "nothing is printed" | the print doc and the button follow `!report.isError` too | R92 red |
| M3 INCOMPLETE | "one snapshot" was READ COMMITTED with two extra round trips | the transaction is gone and the comment is honest: three reads, the close's transaction is the figure of record | — |
| MINOR | "today so far" mixed my figures with everyone's bookings under one heading | the bookings are labelled "everyone's bookings" in their own scope | R93 red |
| MINOR | the phase doc's T2 still promised live check-ins; a stray blank line in the schema | corrected |

**No pass 3.** The two passes are run; what a third would look at is recorded: the fixed-page print model (07a's) with a forty-row day, and the 7-/30-day window edges.

### 5E. Evidence after both passes
| instrument | result |
|---|---|
| web full `vitest run` | **76 files / 570 tests, exit 0** |
| core `jest -w 2`: patients/desk-provider, opd/desk-appointments, billing/desk-provider, billing/sessions, me.e2e over migration 0055 | **5 suites / 36, exit 0** (pass 1) · billing/desk-provider 7/7 (pass 2) |
| `pnpm lint` · `pnpm typecheck` | 0 errors (2 warnings in other lanes' kernel tests) · exit 0 |
| revert pairs, whole phase | **R64–R93**: 27 red; three needed a fixture to be falsifiable |
| review cost | pass 1 A 124k + B 108k · pass 2 102k = **334k** against the 405k term |
| migrations · permissions · kernel · index exports | **1 (0055, two indexes)** · 0 · 0 · 0 |

## 7. Findings deliberately NOT fixed — each with its reason
1. **The fixed-page print** (`styles.css` `.print-doc { position: fixed }`, 07a): a long screen prints its first page repeatedly; the figures sections are `display:none` on print so the page count is the document's, but a forty-row day is the evidence to gather on a real printer. A print-model change is every printable screen's, not this phase's.
2. **The 7-day and 30-day window edges** are untested (2 d / 12 d and 16 d / 38 d only); the real-clock suite can flake across 00:00 IST.
3. **"Already had that mobile on file"**, SMS bounces and missed follow-ups (the artboard's sentences) need rails that do not exist (the merge snapshot's phone; an SMS log).
4. **Counter timing**: no rail; nothing is estimated (D6).
5. **A provider budget pin** for the drawer under load: the indexes are there; an EXPLAIN pin is not.

## 6. Owner items
None. (Deletions of `/counter` and `/opd/vitals`, and RC-5's money rulings, are in the lane scope doc.)

## 7. Out of this phase, from the flow-3 brief, for the record
T2 symptom → department master (no table exists), T4 the combined 80 mm slip (the seat prints
`TokenSlip`; the receipt half is unbuilt), T7 the Hindi-first display board. Each is a phase of its
own with a design artboard already on the canvas.
