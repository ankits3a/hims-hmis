# Phase FD-7 — three seats on one desk (front-desk series)

> **AUTHORED 2026-09-03, NOT APPROVED.** Four owner rulings taken the same day are folded in (§3).
> The design (`docs/design/2026-09-03-front-desk-three-seats/`, canvas
> `d49d5608-76af-4579-bc81-ce14b0077202`) is approved **in shape**, and the owner's 03-Sep flow
> correction **re-cuts its Registration artboard** — see D1. Read that artboard knowing it is wrong
> in exactly one way: it draws the doctor and the complaint *inside* the registration form.

**Lane: LIGHT** (7 tasks, one PR each, `lane/front-desk`). **Two migrations, in two PRs** (T3, T6),
numbered at rebase. **One new route** (`/appointment`) → caddyfile census +1, taken at rebase, never
predicted. **Stop-loss: 1,820,000** — RC-3's measured 118k/task: coding `1.5 × 118k × 7` = 1,239,000 ·
recon 40,000 · review **543,000** (RC-3/RC-4's actual two-pass term, and not a place to save). Record
the balance at every task boundary (§2.141).

**Parallel-lane state:** lims, pharmacy, radiology lanes open; all append to `router.tsx` and
`locales/{en,hi}.json` — resolve tail conflicts by keeping **both sides**, never `--ours` (§8 of the
handoff). Locale namespaces: **`registrationSeat`**, **`appointmentSeat`**, **`billingSeat`**,
**`abdm`**. `registrationCounter` belongs to the shipped seat and is not renamed.

## 1. Why this phase

FD-2…FD-6 made `/counter` a working seat and proved its blind spots by loading 10,000 patients. What
is left is not polish: **no child can be registered anywhere except the old `/registration` screen**
(`POST /opd/walk-in` → 400, *a minor's registration must include a guardian*, D-31/DPDP §9), ~19% of
the seeded book are minors, and the owner has ruled the old screen goes. The appointment and the
money each need a seat of their own. And the routing model — three rules, wait in minutes and a
clock — is **computed today and rendered nowhere**.

## 2. Spike — measured 2026-09-03, inline, 0 subagents

Re-run rather than trust (RC-3 §5.3 is what an unre-measured rails table costs).

| rail | server | web consumers (counted by `grep -rl` in `apps/web/src`) |
|---|---|---|
| `GET /opd/slots` → `Slot[]` | `opd-visits.controller.ts:176` · `opd.appointments.read` | **1** (`opd-appointments.tsx`, the book) |
| `POST /opd/appointments`, `/:id/reschedule`, `/:id/cancel`, `/:id/check-in` | same controller `:200–239` | **1** each, all the book |
| `waitEstimate(waitingCount, avgConsultMinutes, now)` | web-side, `registration-counter.tsx:572` | **1** — the seat imports it and **renders no clock time** |
| `WireDoctorSummary.{waitingCount,avgConsultMinutes,nowServing,roomCode}` | `GET /opd/queues/summary` | typed everywhere, **the three routing rules consume none** |
| `couponCodes` on the fee quote | `billing-api.ts` | **1** (`registration-counter.tsx`) — **posted, never collected from the clerk** |
| `attributionCode` on the fee quote | `billing-api.ts` + `partners-api.ts` | **2** — the seat (posts) and `/partners/receivables` (reads) — **no capture field on either** |
| `entitlement_counters` (`granted_qty` int) / `entitlement_movements` / `consumeEntitlements` / `restoreEntitlements` | `membership/entitlements.ts` | **0** |
| `couponRedemptionStates` / `redeemCoupons` / `releaseRedemptions` | `membership/redemptions.ts` | **0** |
| `billing/benefit-sources` | `billing` | **0** |
| `POST /membership/instruments/enrol`, `GET recognition` | `membership.controller.ts:247,259` | `/counter/instruments`, `/counter/reconcile` only |
| `components/invoice-print.tsx` · `counter-slip.tsx` | built FD-2 | **3** and **2** — FD-2 wired both; `/billing` (`billing-counter.tsx`) already prints. **The paper is not this phase's gap** |
| guardian block · `PhotoCapture` · `abhaAddress`/`abhaNumber` · `isConfidential`/`sensitiveContext` · `legacyUhid` | `POST /patients` | **`registration-desk.tsx` ONLY** — the counter's inline `RegisterPanel` has four fields |

**S1 — the duplicate contract is one line from being usable.** `nearMatches` (`opd/walk-in.ts:78`)
already calls `searchPatients`, whose hits carry `phone`, `dob`, `administrativeGender`,
`isConfidential`; it then **throws all of it away** into `{id, uhid, name}`. §4b of the handoff is a
widening of that literal plus `WireDuplicateCandidate` (`opd-api.ts:401`). No migration.

**S2 — packages already exist as a KIND, not as a unit.** `membership_plans.kind` is
`'membership'|'package'|'card'` and `entitlement_counters.granted_qty` is an **integer count**.
Session draw-down is built. **Value draw-down is not** — it needs the discriminator (D6) and is the
phase's second migration.

**S3 — no ABDM anything exists.** `grep -ril abdm apps/core/src` → 0. ABHA is three free-text columns
plus `identityAssurance: "abha_verified"`.

> **CORRECTED 2026-09-03 (T9's measurement).** S3 originally added "which **any clerk can assert
> today with no evidence**". That is WRONG and it is worth striking out rather than quietly editing,
> because it appears in T2's merged commit message and PR too. `upgradeAssurance`
> (`patients/identity.ts:208`) already refuses non-user actors, refuses any non-increasing move, and
> **requires an `evidenceRef` for `id_verified` and above — which includes `abha_verified`** — with a
> close review having added the `"upgrade"` event so the ladder is audited. The residual risk is only
> that the evidence reference is unverified text, which is the ordinary trade in a staff-operated
> system. **Deferring the ABDM integration therefore leaves no open hole**, which is what the owner
> needed to know when they deferred it on 03-Sep.

**S4 — to measure at T5, not assume:** whether `checkInAppointment` opens the visit through the same
`openVisitInTx` the walk-in uses (it returns `OpenVisitResult`, so probably yes) — if it does, the
seat's arrival door and its walk-in door converge on one state and the screen has one shape.

## 3. Owner rulings, 2026-09-03

- **R1 — Full ABDM integration now.** Ruled after being told it needs a registered HIP, client
  credentials and a consent artefact. Built as T3; **go-live inputs are §7 and are the owner's**.
  The code ships and is tested against a recorded gateway; the switch is configuration.
- **R2 — the 20-minute rule.** *"If the wait time exceeds 20 minutes, highlight the user about the
  delay and suggest lower wait time based doctor."* Continuity still wins; the delay is **shown**,
  the alternative is **named**, and the clerk chooses. It never re-routes on its own (D4).
- **R3 — packages draw down BOTH ways, chosen per package.** Migration + D6.
- **R4 — the channel-partner slip is captured at REGISTRATION and editable at BILLING.**

**DECIDED here, not escalated** (CLAUDE.md: rulings are for money, procurement and law):
**the continuity window is 6 months** — the standard follow-up horizon for an Indian corporate OPD;
past it the episode is a new complaint and rule 2 serves the patient better. A doctor on leave, off
schedule or with no session today **drops out of rule 1** to rule 2 rather than blocking.

## 4. Design decisions

- **D1 — REGISTRATION ENDS AT THE UHID.** Owner, 03-Sep. The search box is the desk: a returning
  patient is *found*, a new one goes through **`F4` / "Register New" → `/registration`**, a screen of
  its own. It collects identity and nothing else, and finishes with the card, the UHID and the
  handover. **No doctor field, no complaint field, no "register and open the visit" button.** This
  supersedes the Registration artboard's Tab 9 / Tab 10 rows.
- **D2 — the appointment is a SEPARATE SCREEN, opened by permission.** On a successful registration
  the seat navigates to `/appointment` **iff** the caller holds `opd.appointments.manage`; a clerk
  without it lands on the card, done, and someone else books. Same composition rule the dashboard
  already uses (FD-1 DD1) — the union of what the caller's grants unlock, from one piece of code.
- **D3 — `/appointment` defaults to WALK-IN and offers FUTURE.** One toggle, walk-in selected. Future
  reveals a date and `GET /opd/slots`; the commit is `POST /opd/appointments` instead of
  `POST /opd/walk-in`. A booked patient arriving is the same screen's third door, `check-in` (S4).
- **D4 — the three rules, named on the proposal, plus R2.** Continuity (6 months, this department) →
  shortest wait → the department queue with nobody named. The card says *which rule fired*. If the
  proposed doctor's `waitEstimate` exceeds **20 minutes**, the card carries the delay in red **and**
  names the shortest-wait doctor in that department with one key to switch. Wait always reads as
  **minutes AND a clock time**. It never seats silently.
- **D5 — `/registration` is REPLACED IN PLACE, then the old file is deleted (T4).** Not a second
  route: a second name for one screen is how the owner ended up on the wrong counter (FD-2). The old
  `registration-desk.tsx` dies only once T2+T3 carry **all four** of guardian, photo, ABHA,
  confidential — and `AttachDialog` / `PatientPhoto`, which `patient-detail.tsx` also imports, move
  to `components/` before the delete, not with it.
- **D6 — the package unit is a COLUMN, not a convention.** `entitlement_counters.unit` (`'count'`
  default, `'paise'`) + `membership_plans.entitlements` declaring it. A count counter reads
  *"consult 3 of 8"*; a paise counter reads *"₹4,200 of ₹10,000 left"*. `consumeEntitlements` grows
  one branch; the movement log's signed identity `remaining = granted + Σ delta` is **unchanged** —
  which is why this is additive and not a rewrite.
- **D7 — the partner slip is one field in two places (R4).** Captured on `/registration` into the
  encounter's attribution, pre-filled and editable on `/billing`, and **the bill records which
  surface last wrote it**. `POST /partners/attributions` already exists; the void path is the edit.
- **D8 — two patients in every assembly test.** RC-3's lesson, unchanged: a component proves nothing
  about the screen that mounts it. Every task's closing assertion drives the **assembled** seat
  through two people, and the second must not inherit the first's desk.
- **D9 — assert separation and visible text, never presence alone.** FD-2's 117 green tests on
  `Ramesh KumarCRK123450139876543210same name`. Every row this phase adds is asserted as separate
  nodes with a readable separator.
- **D10 — inside the alias layer.** Each seat carries `data-seat="…"` with a block in `styles.css`
  beside `[data-seat="registration-counter"]`, sharing Desk One's tokens read **out of**
  `docs/design/2026-08-31-registration-counter/desk-one.html` — never re-invented. Radix portals
  escape the layer (RC-3 §7); nothing a clerk reads goes through one.

## 5. Tasks — one PR each, rail + consumer together

### T1 — the duplicate warning can be told apart (§4b)
`nearMatches` keeps `phone`, `administrativeGender`, `dob` (→ age) and `isConfidential` from the hits
it already has; `WireDuplicateCandidate` widens; the seat's warning list renders them as separate
nodes (D9). **Done when:** five "Ramesh Kumar" rows differ on screen, a confidential candidate shows
no phone, and the revert pair (drop the widening) turns the assertion red.

### T2 — CRITICAL · `/registration`, the new screen, ending at the UHID (D1)
Replaces `registration-desk.tsx` in place. Search-first header, Desk One identity (D10), the identity
form with **guardian (D-31, appearing on a minor and inserting itself into the Tab order at
position 5), photo capture + attach confirmation, ABHA fields, `isConfidential`/alias +
`sensitiveContext`, `legacyUhid`, promotional opt-in never pre-checked**, the partner slip (D7), the
widened duplicate warning from T1, and the finish: the card, the UHID, and the handover to
`/appointment` **by permission** (D2). `AttachDialog`/`PatientPhoto` move to `components/`.
**Done when:** an 8-year-old is registered end to end from this screen and lands on `/appointment`;
the same clerk without `opd.appointments.manage` lands on the card; two patients, no bleed (D8).

### T3 — CRITICAL · ABDM, real (R1) · **migration 1 of 2**
New leaf module `modules/abdm`: config-driven `clientId`/`clientSecret`, gateway session, **v3
enrolment** (Aadhaar OTP and mobile-OTP routes), **login/verify demographic fetch**, the
**asynchronous callback controller** the ABDM gateway calls back on, and the **consent artefact**
recorded before any fetch (DPDP §6 notice + the ABDM artefact) with a transaction ledger table. A
verified fetch — and **only** a verified fetch — may write `abhaVerificationStatus` and raise
`identityAssurance` to `abha_verified`; the free-text path may not (S3 is a live hole). Screen:
**Fetch by ABHA** and **Create ABHA** with the consent dialog and the OTP step. Tested against a
recorded gateway; **credentials are §7**. **Done when:** both flows run green against the recorded
gateway, a refused consent writes nothing, and a hand-typed ABHA number leaves assurance untouched.

### T4 — delete the old screen, repoint the chord (D5)
`registration-desk.tsx` and its test are deleted — **deleted, not redirected**. `F4`/"Register New"
and the nav row point at the new screen. **Done when:** `grep -rn registration-desk apps/web/src`
returns nothing, the route census is re-run (not predicted), and the four carried things are each
asserted present on the new screen by a named test.

### T5 — CRITICAL · `/appointment`, the seat (D2, D3, D4, R2)
New route, nav row on `opd.appointments.manage`, `appointmentSeat` keys (en + hi, parity pinned by
`lib/i18n.test.ts`). Answer **S4** first and record it. Two doors — a doctor by name, or the
complaint → a department. Walk-in default; the future toggle revealing date + `GET /opd/slots`; the
arrival door (`check-in`). The three rules in order, **each proposal naming the rule that fired**,
the 20-minute delay highlight with the named alternative (R2), and wait as **minutes and a clock**
from `waitEstimate` — its first real consumer. Confirm, or overrule. **Done when:** a returning
patient with a 5-month-old consult routes back to that doctor over a longer line; at 7 months they do
not; a 25-minute wait shows the delay and the alternative and does **not** switch by itself; a future
slot books; and the revert pair on the rule-order turns the ordering test red.

### T6 — CRITICAL · `/billing`, the scheme rail · **migration 2 of 2** (D6, D7, R3)
The cashier's seat — `billing-counter.tsx` rebuilt on `/billing`, **not a second route** (D5's rule):
the quote with its benefit lines, **coupon entry** (`couponCodes` finally collected,
`couponRedemptionStates` shown, `redeemCoupons` on settle, `releaseRedemptions` on void),
**entitlement counters** rendered *"consult 3 of 8"* and *"₹4,200 of ₹10,000 left"* behind the new
`unit` column, instrument recognition, the partner slip pre-filled and editable (D7), tender and
change. `invoice-print.tsx` is **already** wired here (§2) and stays wired — the gap on this seat is
the scheme rail, not the paper. **Done when:** a package patient settles with the counter
decrementing by count and another by value; a voided invoice restores both; a coupon that fails its
rule says which rule; and the bill still prints.

### T7 — the keyboard, in line with the 03-Sep ruling (§4d of the handoff)
`Ctrl+N` and `Ctrl+K` out of the map, the legend and the palette; **F4** new patient, **F7** the
book, **F8** take payment, **F9** reprint, **F2** still reserved and still going nowhere; `Esc` back
to the search box, again clears the desk; `Ctrl+⏎` commits; bare `1/2/3` tender only outside a
field; `↑ ↓` move a list. **Per-seat Tab order** as drawn on the Keymap artboard, with the guardian
block's insertion (T2) covered by a test that Tab **never stops at a field that is not on screen and
never skips one that is**. **Done when:** a named test asserts every chord this desk binds is outside
the browser's reserved set, and the two overturned chords have a test stopping them growing back.

## 6. Verify

`pnpm typecheck && pnpm lint` on every task. The touched suites while iterating; **the full pass
belongs to CI** (`tools/lane.sh status` before any local full run — 2026-09-01 burned four of five
passes to peers mid-edit, none to code). Known flakes are the handoff's §8: `partners/accrual.test.ts`
F11(a)'s 300 ms wall-clock budget, and any fixture dated "today" — **compute the date, never write it
down**. Re-run; do not hunt them in this diff.

## 7. Blocked on the owner — T3 only, and it does not hold the other six

R1 is ruled and T3 is written against it, but the gateway cannot be switched on from here. Needed:

1. **ABDM client credentials** (`clientId` / `clientSecret`) for the facility, sandbox then production.
2. **HFR registration** — the facility present in the Health Facility Registry, and the signed ABDM
   participant agreement.
3. **A public HTTPS callback URL** — the ABDM gateway is asynchronous and calls back; `hmis.crkmch.com`
   must expose the callback routes and its egress IP must be allowlisted.
4. **The DPDP §6 consent notice text**, in English and Hindi, as the hospital will actually show it.

Until those land T3 ships behind config and every ABHA button says *not configured* rather than
failing. **T1, T2, T4, T5, T6, T7 are blocked by nothing.**

## 8. CLOSE

Two review passes, fresh readers, the second briefed **at the fixes** — pass 2 briefed that way found
15 of 16 fixes incomplete on 18a, and this series' own pass 2 returned a WRONG fix twice. Pointed
first at **the assembly**, not the components: every CRITICAL in RC-3 and RC-4 was in the screen that
mounted the parts, never in a part. Then the money path (T6) and the consent path (T3). Findings, the
counts, and the token balance land in this doc.

## 9. Execution log

**T1 — DONE** (PR #44, merged). Widening the candidate exposed a second defect it had been hiding:
`nearMatches` probes twice and the bare `Map.set` kept the LAST probe, so the person matching on both
phone and name — the likeliest duplicate — was labelled "same name" and never "same mobile". Lanes
are now unioned. The 409 lane had never been rendered in a test before this.

**THE TASK ORDER CHANGED AT T2, and measuring is what changed it.** §5 ordered registration before
the appointment seat. But D2's hand-off has registration navigate to `/appointment` **by permission**,
so building registration first means shipping either a dead link or a placeholder route — and a
placeholder is the rail-without-a-consumer pattern §1 says this codebase already has too much of.
`/appointment` depends on nothing (it takes a patient in hand and books), so it goes first and
registration hands over to a screen that exists. **New order: T1 → T2 `/appointment` → T3
`/registration` → T4 delete the old screen → T5 ABDM → T6 `/billing` → T7 the keymap.**

**T2 — DONE.** Three things were measured that the design could not have known:

- **S4 ANSWERED.** `checkInAppointment` returns `OpenVisitResult`, the same shape the walk-in returns,
  so the arrival door and the walk-in door converge on one state and the seat has one shape.
- **THE CONTINUITY RAIL DID NOT EXIST, at all.** `visitsQuery` has no `patientId` — there was no way
  to ask what a patient's history was. `GET /opd/continuity` is new: both ids required, one department
  per question, its own PHI surface (`opd.continuity`), and a 6-month window the client cannot widen.
- **RULE 3 CANNOT OPEN A VISIT.** `visitOpenBody` requires `doctorId` (`opd-visits.controller.ts:80`),
  so "join the department queue naming nobody" is not a thing the server can do. The seat therefore
  does not offer a confirm it could not honour: it says nobody is sitting and sends the clerk to the
  future lane. **This is a real gap between the drawn design and the system, and it is the owner's to
  rule if they want a doctor-less department queue — it would need a schema change.**

Two clauses were deleted because mutants proved no test could kill them: the id-comparison in the
alternative picker (strict `<` already excludes self) and, in an earlier draft of the continuity
query, one of two null-sensitive filters. `status = 'completed'` stayed and is **documented as
untested**, with the measurement in the code, rather than counted as covered.

**Mutants run at T2: 19, all dead** — 4 on the continuity query, 9 on the routing rules, 6 on the
assembled seat.

**T3 — DONE, AND T4 FOLDED INTO IT.** §5 made deleting the old screen its own task. That was wrong:
`/registration` is one route, so a "new screen" and an "old screen" cannot both serve it — the delete
and the rebuild are the same act. `registration-desk.tsx` → `registration-screen.tsx`, one file, one
route, the old name gone (a second name for one screen is how the owner ended up on the wrong counter).

**T3 was much smaller than §5 assumed, and measuring is why.** The old screen ALREADY had the right
stages — search → form → card — and already ended at the UHID card. All four of §4a's carried things
(guardian, photo + attach confirmation, ABHA fields, confidential/sensitive) were already there and
are untouched. **The artboard was the thing that was wrong**, not the shipped screen: it drew the
doctor and the complaint inside the form. So the real gap was one thing — **the card handed over to
nothing**, dropping the clerk back into an empty search box having just created a patient. It now
takes them in hand and navigates to `/appointment`, by permission.

`PatientPhoto` moved to `components/patient-photo.tsx` (D5's precondition): three surfaces were
importing a whole SCREEN, and its router hooks, to render one `<img>` — a coupling two test files
already carried workarounds for. Both of those comments were corrected rather than left saying
something no longer true.

**R4's registration half is BLOCKED and is moved to T6, with the reason.** The partner slip cannot be
captured here yet: `POST /patients` has no field for it, and **nothing in the repository ever writes
`attribution_ids.state = 'claimed'`** — the state exists in the schema and in `PRESENTABLE_STATES`
and has no writer. `GET /partners/attributions/:code` also needs `partners.receivable.operate`, which
the front desk does not hold. Shipping a field that silently persists nothing would be worse than not
shipping it.

> **CORRECTED at T9.** This paragraph also said "no route binds a slip code to a patient". That is
> WRONG: `attribution_ids.patient_id` is populated by `issueAttribution` at ISSUE time and RC-2's
> review MAJOR 5 already added the binding check — one slip used to discount unlimited bills for
> unlimited patients, and does not any more. What is actually missing is different and narrower, and
> T9 states it properly: `attributionCode` is a **per-request parameter with no durable home**, so a
> code captured before billing has nowhere to live between the two screens.

**Mutants at T3: 3, all dead** (the permission gate, `takePatient`, the navigation target).

**T7 — DONE, and it fixed a chord that had never worked.** `keyboard.tsx`'s own comment already said
Chrome does not deliver `Ctrl+N` (non-overridable, new window) — so the new-patient chord FD-3 bound
at the owner's request had never reached the page in the browser this hospital runs, and `Alt+N` was
bolted on beside it as the half that did. One door, two names, one of them dead. Now **`F4`**, one key.
**`Ctrl+K` is out of the palette opener**, not merely off the legend. **`F7`** opens the book.

`/` **stays**, and the exception is reasoned rather than overlooked: Chrome does not claim it, and
Firefox's Quick Find — unlike `Ctrl+N` — is suppressible by the page. That is the distinction the
whole ruling turns on: a key the page can still claim is safe to claim; a key the browser takes
before the page sees it is not.

**`F8` and `F9` are NOT bound.** §4d assigns them take-payment and reprint, but those are seat
ACTIONS and — unlike `F4` and `F7` — they are not a re-mapping of something that already works: "take
payment" as a keystroke exists nowhere. Binding a global key to an action nothing implements would
put a dead key on the legend, which is the exact mistake `F2` is kept off the legend to avoid. They
belong to T6, with the actions.

The rule is now a **predicate**, `browserSafeKey`, not a comment — because §4d's kind of rule decays,
and the next task to want a shortcut reaches for `Ctrl+<letter>` because that is what applications do.
Two tests keep the overturned chords dead, in both files that asserted them, rather than deleting the
rows: FD-3's phase doc still records `Ctrl+N`/`Ctrl+K` as the owner's own instruction, so something
has to say out loud that they were overturned.

**Mutants at T7: 6, all dead.**

### Still open after this session

- **T5 (ABDM)** — code not started; blocked on §7's four owner deliverables.
- **T6 (`/billing` + the scheme rail)** — not started. It also now carries R4's registration capture
  and the `attribution_ids` claim rail (see T3), and `F8`/`F9` (see T7).
- ~~**Rule 3's server limit**~~ — **RULED AND CLOSED at T8**: the department queue *is* the
  shortest-wait assignment, so there is no doctor-less queue to build and no schema change. See §10.

## 10. T8 — the department queue auto-assigns (owner ruling, 2026-09-03)

> "when the user joins patient to the department queue, then system would automatically assigns the
> patient to the doctor which has least waiting time (with some edge case exception like, what will
> happen if the doctor goes on leave in between his duty). sort this out"

**This ruling COLLAPSES rule 3 rather than needing the schema change T2 flagged.** There is no
doctor-less department queue: the department door *is* the shortest-wait assignment, which
`proposeWalkIn` rule 2 already does. The only case left for the third branch is a department where
genuinely nobody is working, and there the seat offers the future lane — the honest answer.

**The edge case turned out to be a live defect, and worse than described.** `summaryByDoctor` derived
`scheduledToday` from `opd_doctor_schedules` **alone and never consulted `opd_doctor_leaves`**.
`availableSlots` and `bookAppointment` have checked leave since Plan 07; the queue side never did. So:

- a doctor on approved leave sat on the board all day reading "scheduled, 0 waiting";
- the desk's "session not opened" alert nagged about someone who was away;
- and — the one that reaches a patient — **an empty queue is the shortest queue.** Under this very
  ruling the absent doctor would win the auto-assign comparison every time, so the router would have
  sent every arriving patient to the one person in the building guaranteed not to see them.

`scheduledToday` now means *working today*, which is what all five of its readers already assumed, and
`onLeaveToday` says why somebody is not — "not scheduled today" is a shrug where "on leave today" is
an answer a clerk can give the patient in front of them.

**The mid-duty leave: reported, not cascaded, and that is a decision.** `scheduleDoctorLeave` now
returns `strandedEntryIds` — the live queue entries inside the leave window. It does **not** move
them. Moving a patient to a different doctor without asking is exactly what `transferQueue`'s consent
guard (E2) exists to prevent, and a leave is not a reason to weaken a guard: the patient chose that
doctor, and the choice in front of them is another doctor or coming back tomorrow. So the server
reports, `/opd/desk` shows "on leave today — N still waiting; transfer them", and the existing
transfer — consent and reason included — re-seats them with **their original eligibility preserved**,
so nobody loses their place in the line.

**Mutants at T8: 9, all dead** — 5 on the server (leave ignored, cancelled leave counted, the window
opened, the stranded scope, the live-status filter) and 4 on the web (the two desk sentences merged,
the count dropped, the availability filter, the on-leave reason).

## 11. T6 — the scheme rail gets a cashier · **migration 0058**

**The scheme engine was already complete server-side and had no way in.** `couponCodes` and
`attributionCode` have been on the issue body and the preview helper since RC-2 and on the server
since T2 — and **nothing on `/billing` could set either**. Memberships, coupon rules, entitlement
counters, redemptions and their reversal were reachable only by a caller writing JSON by hand. That
is this codebase's characteristic defect (§1) in its largest instance yet: not a rail with one
missing consumer, but a whole subsystem with none.

**R3's value lane, built where the model already had room for it.** `entitlement_counters` was a
count of whole units and the file says in as many words that "a counter unit is not divisible" — fine
for a membership granting eight consultations, useless for a ₹10,000 prepaid package. Migration 0058
adds `unit` (`'count'` default, `'paise'`), additive and defaulted, with a CHECK constraint so a
typo'd third lane cannot be stored and silently drawn down as one visit.

The narrowing is where the design earns itself: a count counter answers *is there another visit left*
and a boolean is the whole of it, but ₹4,200 against a ₹5,000 benefit is neither exhausted nor
available in full. So a paise counter **narrows `capPaise`** — the cap the plan's own benefit terms
already carry, that the pricing engine already honours and the contest already explains — rather than
introducing a second mechanism beside it. **Nothing divides anywhere**, which is the property this
file's header asks every change to preserve.

**And the reversal needed NO CODE AT ALL.** `restoreEntitlements` negates `-movement.delta` without
knowing which unit it is in, so a value draw-down reverses correctly by construction. A test now pins
that, because the obvious "simplification" back to `+1` would be silent and would hand money back
wrong.

**`balances` is a NARROW projection, deliberately.** `previewInvoice` withholds the benefit context
on purpose — its docstring says the resolved instruments carry card codes and plan ids the route does
not gate — so this does not widen that return. What crosses is key, title, unit, granted and
remaining; what does not is the card code, the plan id and the instance id. A balance is not an
identity, and the priced lines already name the winning benefit.

**Deferred, and named rather than quietly dropped:**

- **R4's registration half** stays blocked for the reason T3 recorded: nothing in the repository ever
  writes `attribution_ids.state = 'claimed'`, no route binds a slip code to a patient, and the lookup
  needs `partners.receivable.operate`, which the front desk does not hold. The **billing half is
  built** — the slip reaches the money, which is the half that matters most — and the capture needs
  its own task with a permission and a write.
- **`F8` / `F9`** stay unbound: they are still actions rather than re-mappings (T7's reasoning).

**Mutants at T6: 11, all dead** — 6 on the entitlement engine (the cap not narrowed, the cap widened,
`delta` back to `-1`, the count lane treated as money, the zero guard removed, the count lane capped)
and 5 on the cashier (codes off the preview, codes off the invoice, blanks sent as empty, the two
units merged into one sentence, the panel always shown).

## 12. T9 — the partner slip gets a home · **migration 0059**

**R4's other half, and three corrections to how this doc described the problem.** T3 and T6 both
deferred the capture saying "no route binds a slip code to a patient". That was wrong:
`attribution_ids.patient_id` is populated by `issueAttribution` at ISSUE time and RC-2's review
MAJOR 5 already compares it. The real gap is narrower and more interesting — **`attributionCode` was
a per-request parameter with no durable home**. `charge-rules.ts` said in its own comment that "the
clerk attaches the slip during registration, long before billing is opened", and there was no column
anywhere to attach it TO. The slip died between the desk and the cashier unless it was re-typed off
paper that had by then been put away.

**Where it is captured, and why not on `/registration`.** The owner ruled "at registration, editable
at billing". Their OTHER ruling — registration ends at the UHID — moved the earliest moment a visit
exists to the walk-in. A slip is one per VISIT (V6), so the capture sits on `/appointment`, one screen
later, which is still the desk and still while the patient is holding the paper. **If the owner wants
the field on the registration form itself, it needs a home on the PATIENT, and that is a different
decision about what a slip belongs to.**

**Stored unvalidated, on purpose.** Billing owns the check that a code binds to this patient
(RC-2 MAJOR 5); duplicating it at the desk would put one money rule in two places and stall a counter
on a typo. The desk records what the paper says; the money decides what it is worth.

**The pre-fill is not a nicety, it is the correctness half.** With the quote falling back to the
stored code, a billing screen with a blank slip field would show a price a stored slip had already
discounted and then issue an invoice carrying no code — the RC-2 quote/invoice disagreement arriving
from the opposite direction. `FeeQuote` therefore RETURNS `attributionCode` on **both branches**
(a free review visit still carries the partner's slip — the accrual hangs off the slip, not off
whether this visit was charged for), and the cashier's field seeds from it once per encounter. Any
edit, **including clearing it**, is then an explicit act that travels.

**Mutants at T9: 12, and two of them mattered.** The first draft's six left `no_fallback` and
`opts_ignored` ALIVE — every assertion read the reported field and none read the MONEY, so a stored
slip that showed up in a response and changed no price would have passed. Fixing that needed a real
partner fixture (counterparty + agreement + issued slip, and `new PartnersModule()` to arm the
benefit-source provider, without which a referral silently prices as no discount). `free_branch`
survived a later round for the same reason and got its own row. **One guard is recorded as UNTESTED**:
the "do not re-seed the SAME encounter" half of the pre-fill, because the suite cannot make the quote
refetch. The encounter KEY is tested; the refetch guard is documented in the code rather than counted.
