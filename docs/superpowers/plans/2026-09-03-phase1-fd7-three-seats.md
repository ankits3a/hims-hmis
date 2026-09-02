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
plus `identityAssurance: "abha_verified"`, which **any clerk can assert today** with no evidence.

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
