# Phase RC-4 — The counter that finishes a patient (Registration Counter series, 4 of 6)

> **AUTHORED, NOT APPROVED.** The three-phase cut this belongs to is proposed in
> `2026-09-01-SCOPE-registration-counter-remainder.md` and the owner has not ruled on it. **T5 is
> additionally gated** on §6.1. T1–T4 are blocked by nothing.

**Lane: LIGHT** (5 tasks). **This is a WIRING phase, and it is the third in a row** — see §1.
**Stop-loss: 1,280,000**, from RC-3's *measured* actuals per §2.95 (per-task rate × this phase's task count, never a previous phase's total):
`1.5 × (93,000 measured per-task coding rate × 5)` = **697,500** · recon carry **40,000** (the spike below is already paid for, inline, so this is a fraction of RC-3's 100,000) · task-subagent term **0** (LIGHT) · review **543,000** (RC-3's two passes cost 419,272 and its remediation ~124,000 — that sum, not a multiplier on a guess).
**The review term is not a place to save.** On RC-3 it found **3 CRITICAL + 12 MAJOR over thirteen dead mutants, clean typecheck, clean lint and a full green web suite** — and every CRITICAL was in the assembly.
**Session token balance at kickoff: record it** (§2.141), and a delta at every task boundary.
**Parallel-lane state:** the 18a radiology lane closed its remediation at `4ffe5b9`; the VD-1 vitals lane is code-complete and VD-2 unstarted. Locale namespace `registrationCounter` is this lane's; VD-2 takes `vitalsBay`.

## 1. Why this phase — the same finding, for the third time

RC-3's §1 measured **eight rails shipped with zero web consumers**. Its close re-measured and found **five still unwired**. This phase's own spike (§2, run inline before authoring) found the pattern again, and the two sharpest cases are almost comic:

| rail | shipped | web consumers | how it reaches the wire |
|---|---|---|---|
| `feeStatus` — the PAID stamp | RC-1 T3 | **0** | **already on the wire.** `QueueEntryView.feeStatus` is filled at `opd/queue.ts:92` and `GET /opd/queues` returns it with **no serializer** (`opd-queue.controller.ts:148`). Two screens read that route today and neither type declares the field |
| `join: "defer"` + `POST /opd/visits/:id/join-queue` | RC-1 CLOSE M2 | **0** | the web type `WireWalkInDeferredResult` **exists**, and its own docstring says *"the shipped counter never sends `join`"*. `grep -rn '"defer"\|join-queue' apps/web/src` returns only the declaration and its comments |
| `counter_sequence` / `token_lane` | RC-1 T2 | **0** | `PATCH` fields on `opd-masters.controller.ts:174-182` |

**So RC-4 is not "build the rest of the counter". It is "make the seat finish a patient using rails that already exist."** That sets the risk profile: almost nothing here is new server behaviour, and almost everything is a **first consumer** — the condition under which a rail's design assumptions are tested for the first time. RC-1's CRITICAL and every one of RC-3's three were exactly that class.

**And the method now names the trap this phase will walk into.** §5A.3: RC-3 killed thirteen mutants at the component level and the reviewers found three CRITICALs in the *assembly*. **RC-4 assembles more than RC-3 did.** Every task below owes an assertion over the assembled screen driven through a full cycle — two patients, not one.

## 2. Spike — answered by reading, before authoring (inline, 0 subagents)

- **S1 — can the seat open a visit at all?** Yes. `walkIn(body, idempotencyKey)` (`opd-api.ts:353`) posts `/opd/walk-in` and accepts either an existing patient (`{ existingId }`) or a four-field registration (`{ register: { name, sex, phone? } }`) — `counter-desk.tsx:135-150` is the working reference and its duplicate-acknowledgement path (`acknowledgedDuplicates`) is part of it. **DECIDED: lift it, do not re-derive it**, the way RC-3 T2 lifted DD2's three exits. It is a proven money path and a reviewer must be able to see that half is unchanged.
- **S2 — what does bill-first actually need?** `join: "defer"` on the walk-in body returns `WireWalkInDeferredResult` with **null token, session and entry**, and `POST /opd/visits/:id/join-queue` fills them afterwards. Both exist; neither has ever been called. **This is the highest-risk task in the phase** precisely because RC-1's own CLOSE wrote the type and no caller has ever exercised it.
- **S3 — the flow pill.** ~~`counterSequence` and `tokenLane` are department-masters fields, patched through `opd-masters.controller.ts`. So the pill READS the department the seat is working under and the switch is a masters PATCH — which means it is **supervisor-permissioned by construction** (`opd.masters.manage`), not by a new gate.~~ **WRONG, corrected at T4 (see D5):** they are two columns on `opd_config`, hospital-wide, and the write is `PUT /opd/config/counter-flow` under `opd.counter.flow.manage`.
- **S4 — the PAID stamp.** `feeStatus` is `"free" | "settled" | "credit" | "unsettled" | null` on core's `QueueEntryView` and is **absent from web's `WireQueueEntryView`**. Identical to RC-3 T4's `avgConsultMinutes`, which the phase doc told that task to *measure first* and which turned out to need **no core change at all**. **MEASURE before writing anything here too** — the answer is probably a one-field widening, and if it is, say so rather than inventing work.
- **S5 — does the flip reach the browser live?** `queue.fee_status_changed` is emitted in the settling transaction (RC-3 T3) and `realtime.ts` is the existing push seam. **MEASURE whether the event already reaches the web push channel** before building a subscription.

## 3. Design decisions

- **D1 — The seat REGISTERS in place; it no longer navigates away.** RC-3's `Register new` button calls `onRegisterNew`, which leaves for `/registration?new=true` — and leaving is the defect the seat exists to remove (the dossier, the search, the whole in-hand session are abandoned to open a form). Four fields, inline, `usePatientInHand` intact across it.
- **D2 — The walk-in call and its idempotency key are LIFTED from `counter-desk.tsx`, not re-derived.** Per S1 and RC-3's D1 precedent. The old screen's header is quoted rather than paraphrased.
- **D3 — Bill-first is a DEFERRED JOIN, and the token is born PAID.** The flow pill's `Register → Bill → Appointment` sequence (the pill's own words are `Register → Bill → Queue` — demo 3's "Appointment" is the queue join, F10(B)) sends `join: "defer"`, takes the money, then the visit joins. The alternative — issuing a token and flipping it — is what `token_lane` exists to avoid, and demo 3's wording is explicit: *"their token leaves the printer already PAID."* **AMENDED AT CLOSE (F1, CRITICAL): the join happens WHERE THE MONEY LANDS — inside the settling transaction, server-side (`queueFeeStatusHook` → `joinQueueInTx`) — and the seat's own `join-queue` call is the idempotent second reader, not the only caller.** A join that lived only in the seat's component state stranded a paid patient on every road that lost that state.
- **D4 — The PAID stamp is rendered from `feeStatus`, never re-derived on the client.** `encounterFeeStatuses` is the one projection; a screen that recomputed "is this paid" from an invoice would be a second truth function that can disagree with the board. RC-3's F4 is the same lesson from the other side: the seat could not see settlement and so must not claim it. **This task is what finally lets the seat claim it.**
- **D5 — The flow pill wears the setting openly, and it is ONE setting for the hospital.** **As first written this said "the department the seat is working under" and a masters PATCH under `opd.masters.manage`; both halves were wrong**, measured while writing the T3 handoff and fixed at T4 rather than inherited. `counterSequence` and `tokenLane` are two columns on `opd_config` (`kernel/db/schema/opd.ts:36`, read by `modules/opd/config.ts:189-202`) — hospital-wide, one setting for every counter. The write is `PUT /opd/config/counter-flow` (`opd-masters.controller.ts:229`) under **`opd.counter.flow.manage`**, RC-1 T2's deliberately narrower permission, whose body is EXACTLY the two flow keys. A clerk sees which sequence the counter is in; the front-office supervisor changes it. The pill polls the server and the walk-in re-reads the server at the moment of opening, so a stale pill can never reach the wire.
- **D6 — `/counter` is deleted LAST, in its own task, after the seat demonstrably finishes a patient.** Not first, and not as a side effect. The honest moment to delete a proven money path is when its replacement has been shown to do the same job — which is T1–T4's output. Gated on §6.1.

## 4. Tasks

### T1 — CRITICAL · the seat opens a visit, and registers in four fields without leaving — **DONE, `8c2a953`**
**Files:** `apps/web/src/screens/registration-counter.tsx`, its test.
Per D1/D2. Lift `walkIn` + the idempotency key + `acknowledgedDuplicates` from `counter-desk.tsx`; the register form replaces the navigate-away.
**Assertion book:** assertion — registering a new patient from the seat opens a visit, puts them in hand, and the dossier fills **without a navigation**; mutant — the register path drops `acknowledgedDuplicates`, so a duplicate-suspected refusal becomes a dead end; kill — a clerk who cannot proceed past a near-match.
**Assembly clause (§5A.3):** drive the screen through **two patients** and assert nothing of the first survives — this is the exact defect RC-3's F1 shipped.

### T2 — CRITICAL · the deferred join, its first consumer since RC-1 wrote it — **DONE, `891bc01`** (ran after T3, see §4A)
**Files:** the screen, `apps/web/src/lib/opd-api.ts`, tests.
Per D3. `join: "defer"` → bill → `POST /opd/visits/:id/join-queue`.
**Assertion book:** assertion — a bill-first walk-in has **null token, session and entry** until the money is taken, then joins with a token that is already PAID; mutant — the join fires before settlement; kill — an UNPAID token on the board in a lane whose entire purpose is that it never appears.
**This is the phase's highest-risk task** (S2) and it gets fail-first treatment.

### T3 — CRITICAL · the PAID stamp on the board — **DONE, `bcb1397`. D7 RULED: the board.**
**Files:** `apps/web/src/lib/opd-api.ts` (declare `feeStatus` — **MEASURE first**), the screen, `realtime.ts` if S5 says so, tests.
Per D4.
**Assertion book:** assertion — a settled encounter's token renders PAID and an unsettled one does not, from the server's `feeStatus` alone; mutant — the client re-deriving paid-ness from an invoice; kill — a board that disagrees with `encounterFeeStatuses` after a reversal, which is precisely what RC-3 T3 made the event able to report.

### T4 — ROUTINE · the flow pill, worn openly — **DONE, see §4B**
**Files:** the screen, `apps/web/src/lib/opd-api.ts`, tests.
Per D5 (as corrected).
**Assertion book:** assertion — the pill shows the hospital's current `counterSequence`, and a clerk without `opd.counter.flow.manage` cannot change it; mutant — the pill rendered from client state rather than the server's value; kill — two counters showing different sequences for one hospital.

### T5 — ROUTINE · `/counter` is deleted — **GATED on §6.1**
**Files:** `apps/web/src/router.tsx`, `apps/core/test/caddyfile-parity.test.ts` (45 → 44), `counter-desk.tsx` (deleted), the NAV row, `nav.counterDesk`/`nav.counterSeat` locale keys.
Per D6. **Do not start this task before the ruling**, and do not start it before T1–T4 are green.
**Assertion book:** assertion — `caddyfile-parity` counts 44 and `nav-parity` still agrees on every surviving path; mutant — the route removed and its NAV row left behind; kill — a permission-gated link to a screen that no longer exists.

**Verify economy:** T1–T4 are web (`vitest`, ~30s for all 68 files, no database, no box slot). T3 may touch core; if it does it owes a scoped core batch. `pnpm typecheck && eslint` before every launch — **vitest strips types, so a green web suite can sit over code that does not compile.** A full core+web pass at phase end. **Never a bare `pnpm verify`** (§2.151).

## 4A. T1 IS DONE, AND WHAT MEASURING FOR T2 FOUND — the remaining tasks are RE-ORDERED

**T1 shipped at `8c2a953`.** The seat registers in four fields in place, opens a visit, takes the
patient in hand, and the route no longer hands down a navigation. Four mutants applied and killed;
full web 68 files / 454 tests, exit 0. The design's fourth field (`ageYears`) turned out to be
accepted by `registerBody` all along — the same shape as every other rail in this series.

Then T2's own measurement, run before writing a line of it, moved two things:

**FINDING 1 — `joinQueue` has NO settlement gate, and that is CORRECT rather than a hole.**
`encounters.ts:joinQueue` checks actor, encounter existence, `status === "registered"`, service
date, responsible doctor and no live entry. It does not consult the money at all. That looked like a
gap in "the token leaves the printer already PAID" until the rest of the derivation is read: the
stamp is **derived** from `encounterFeeStatuses`, never stored, so a token joined after payment
reads PAID and one joined before reads UNPAID — *both correctly*. Nothing needs a gate. **T2's
mutant is therefore not "an unpaid token is mis-stamped" but "the join fires before the money", and
the kill is an UNPAID token appearing in the one lane whose entire purpose is that it never does.**

**FINDING 2 — the seat cannot read its own patient's fee status, and this RE-ORDERS T2 AND T3.**
`GET /opd/visits/:id` returns `queueEntries: QueueEntryRow[]` — **raw rows, no `feeStatus`**. The
field lives on `QueueEntryView`, which only `GET /opd/queues?doctorId=…` returns. So the seat cannot
know an encounter is settled from the route it would naturally read, and **T2 depends on T3**: a
bill-first flow that waits for the money needs a surface that can see the money.

**T3 THEREFORE RUNS BEFORE T2**, and it inherits a design decision this doc did not anticipate:

> **D7 — WHICH SURFACE WEARS THE PAID STAMP? — RULED (`bcb1397`): the BOARD, `opd-desk.tsx`.**
> A UI surface choice is not money, procurement or law, so the standing rule makes it mine to
> decide rather than escalate. It is literally what the demo calls "the board", it already reads
> the route, and it needed **no core change** — `feeStatus` had been on the wire since RC-1 T3 with
> no type declaring it, the third rail in three phases with that shape. The seat separately renders
> the `tokenNo` it already holds from the walk-in result, closing D2's "token" noun for free. The
> options as originally written: Three candidates, and they are not equivalent.
> (a) **`opd-desk.tsx`**, which already reads `/opd/queues` and is what demo 1 most plausibly means
> by "the board" — a one-field wire widening plus a render, no core change, but it edits a screen
> outside this seat. (b) **The seat's own dossier**, which is where D2's unbuilt "token" noun
> belongs and where the clerk is actually looking — but it needs a `doctorId`-keyed queue read the
> seat does not currently make. (c) **Both.** DECIDE THIS BEFORE T3, and prefer (a) if the demo's
> "board" is taken literally, because it is the smaller change and the wire widening is shared.

**Neither finding was reachable from the phase document.** Both came from reading the server before
writing the client — which is the third time this series has been paid for doing that, after RC-3
T4's `avgConsultMinutes` and this phase's own §2.

## 4B. T2 AND T4 — DONE. What T2 turned out to contain, and what T4 corrected

**T2 (`891bc01`)** was authored as "defer → bill → join" and the middle word was the whole task.
The seat did not take money — RC-3's F4 established that it could not see settlement, so it
priced and did not collect — and a bill-first flow with nobody to take the money between the
register and the join is not a flow. What resolves it is not new sight but new AUTHORSHIP: for a
visit the seat opened itself, moments ago, it knows there is no invoice yet as surely as
`/counter` does, because that is `/counter`'s own model. So the tender block and `settle` were
lifted from `counter-desk.tsx` and `canCollect` is true for exactly that case — the seat's own
visit, in this session, with the drawer open. Every other patient in hand still gets F4's answer.

Three more things fell out of measuring:
1. **The existing patient's door was missing.** `takePatient` puts a search hit in hand with
   `encounterId: null` and the workspace went blank there; `walkInBodyFor`'s `existingId` branch
   was exported, unit-tested and consumed by nothing — §1's finding, inside T1's own output.
2. **The drawer gate had to move before the walk-in.** Under bill-first a deferred visit with no
   money is a patient nobody calls; `/counter` learned the same thing at the payment step (07b DD5).
3. **`token_on_payment` has a dossier meaning.** RC-1 D3 says the lane is "printing and stamps
   only"; the dossier's number is the slip, so it is held back until the money.

**The join is a pure predicate (`shouldJoinNow`)** and the effect only carries its answer to the
wire — so the mutant the assertion book names was applied to one function and killed at the unit
and at the assembly (an order on the wire: the invoice, then the join). Eight revert pairs
(R22–R29); **two could not fail on the first run** (R26/R27 — the encounter-keyed accessors),
because the two-patient test went through `Escape` and `clearDesk` did the same work. The keying
protects the road that does not pass `clearDesk` — another surface taking a patient in hand under
a mounted seat — and a third test now drives that road through a sibling component. That is
§5A.4 paying for itself a fourth time in this series.

**T4** corrected D5 (above) and shipped `FlowPill` + `useCounterFlow`: polled at the ops-mode
cadence, controls only under `opd.counter.flow.manage`, one flow key per write, and the pill shows
what the server RETURNED — the mutant test has the server answer a different value than was asked.
Five revert pairs (R30–R34), all red first time. **Evidence at T4:** full web `vitest run` 68 files
/ 479 tests, exit 0 (T3 stood at 459); `pnpm typecheck` exit 0; eslint clean over `src`. **No core
source touched in T1–T4; no test database used.**

## 5. CLOSE — 2026-09-01, code-complete, NOT deployed

**Tip: the second-remediation commit (§5.5).** T1–T4 done; **T5 gated on §6.1 and not started.** Nothing else open in T1–T4.

### 5.1 What the close review found, over a green tree — for the fourth phase running

Two FRESH read-only reviewers over `891bc01` + `2870f8d`, briefed at the operands (§9.7) and forbidden
to run anything (the peer lane held the box). **Pass 1: 1 CRITICAL, 4 MAJOR, ~8 MINOR**, over a full
green web suite (479), clean typecheck, clean lint, and thirteen revert pairs that all went red.

**The CRITICAL was in the assembly again, and it was a road the assertion book did not name.** The
deferred visit's "still owes a join" lived only in the seat's component state. A reload; a trip to
`/billing/session` to open the drawer; an Escape while the settle POST was in flight; the palette
taking patient B under A's unpaid visit; the money taken at `/billing` instead of the seat — every
one left a PAID patient with **no token and no surface in the system able to give them one**. The
server was ready (`joinQueue` is idempotent) and had exactly one ephemeral caller. Both reviewers
found it independently, and reviewer A's fix was the one taken: **join where the money lands.**

The other MAJORs were the same lesson from three sides: `canCollect` was memory ("the seat opened
it moments ago") with no time bound, so an invoice issued at `/billing` in between left "Collect
₹400" on screen; the bill-first drawer gate read a cache while the flow beside it was read live;
`useQuote`'s error had no consumer, so a deferred visit whose quote 403'd was silently priceless.

### 5.2 The remediation (`8614ef1`), and the one core change of the phase

- **CORE** — `joinQueue`'s body is `joinQueueInTx`; `queueFeeStatusHook` joins a never-joined,
  registered, today's visit **inside the settling transaction** when its fee status is settled,
  credit or free. The deferred proxy is *no queue entry at all* (a queue-first token that LEFT is
  not re-entered by a payment — that is `re-enter`'s act). `unsettled` cannot reach the branch by
  construction: arriving, it returned above; leaving needs money that would already have joined
  the visit. **R37 proved a guard there could not fail, so the guard is a comment**, and a
  free-revisit pin replaced it (free is money done here as at the seat).
- **WEB** — `useEncounterOnServer` reads `GET /opd/visits/:id` and `GET /billing/invoices?
  encounterId=` for every encounter in hand, polled; the dossier shows the server's token when it
  exists; a registered, never-joined, money-done visit is offered the join — never an unpaid one.
  `canCollect` needs the invoice read to have SUCCEEDED and found none; unknown does not collect.
  The drawer has five states and says which (`forbidden` for the seeded `front_office`, who holds
  no `billing.session.own`; `closing` with O-1's cover line). Escape and Next agree while a join or
  a settle is in flight. The bill-first gate reads the drawer live, beside the flow.
- **DECIDED at close, not escalated:** under `queue_first` the seat opens a visit WITHOUT a drawer
  — a registration desk prices and the billing counter collects, which is the two-desk layout the
  role model already encodes (`front_office` has no `billing.*`). `bill_first` needs the drawer.

### 5.3 Evidence at close

| instrument | result |
|---|---|
| web full `vitest run` (no box slot) | **68 files / 501 tests, exit 0** (T3: 459 · T4: 479 · pass 1: 496) |
| core `jest -w 2` on `hmis_rc4_scratch`: fee-status, encounters, walk-in, queue, join-queue, opd/billing/opd-lifecycle/billing-lifecycle e2e | **pass 1: 9 suites / 106 tests, exit 0 · pass 2: see §5.5's commit** |
| `pnpm typecheck` workspace · eslint web `src` + the three core files | exit 0 · clean |
| locale parity en/hi (set arithmetic, no runner) | no diff either way |
| assembly-render ratio (§5A.3) at close | **25 seat renders : 13 part renders** (RC-3's was 2 : 14) |
| revert pairs this phase | **R22–R50, twenty-nine**; **five could not fail on first run** (R26, R27, R37, R48, R50) — four were re-cut until they did, and R37's "could not fail" was a fixture gap the pass-2 reviewer turned into a MAJOR (§5.5) |
| phase doc | `wc -c` = see git; under 50k tokens |

### 5.4 Cost

Session balance at kickoff **14,958k** (handoff read, orientation) · T2 boundary 14,801k (Δ 157k
incl. orientation) · T4 boundary 14,781k (Δ 20k) · pass-1 reviewers **159,551 + 185,784 = 345k**
· remediation + core batch + pass-2 brief ~145k · pass-2 reviewer **170,526** · second remediation ~90k. **Reviewers: 516k against the 543k term; phase total ≈ 1.05M of 1,280,000 (82%).** **Coding for T2+T4 came in
at ~180k against a 697k coding term — the handoff's measured seams did that.** The review term
(543k) is where the phase's money went and where its CRITICAL came from, again.

### 5.5 Pass 2 — briefed at the fixes: ONE WRONG, TWO INCOMPLETE, eight CORRECT

**Pass 2 exists to catch the fix, not the phase — and this one caught a fix that would have minted
an unpaid token.** An INCOMPLETE means the fix works and the dimension is still open; a WRONG means
the fix would have shipped a defect that was not there before. This series had never returned a
WRONG until now, and it was on a money path, in the fix for the CRITICAL.

A fresh reviewer, given `8614ef1` and the findings with what each fix claimed, verdict per fix
(method §9.10). **F1's CORE half was WRONG.** The first remediation deleted the hook's status guard
on the argument that `unsettled` could not reach the branch — and R37 had stayed green because no
fixture built the road. The reviewer built it from another module: a **lab invoice** on a deferred
visit settles (arriving via, fee still `unsettled`, returned by the A-b guard), then its receipt is
**voided** (leaving via, fee still `unsettled`, the direction check no longer stops it) — four
guards pass and an **UNPAID token is minted in the bill-first lane**. N1, MAJOR, in the fix for the
CRITICAL. Ledger §2.166 is rewritten around it.

Also from pass 2: **N2** — "an invoice exists" was the wrong money predicate in both directions (an
entered-in-error fee invoice refused collection forever and OFFERED the join door; a lab invoice
did the same); **N3** — polling `GET /opd/visits/:id` wrote a PHI-access row every 15 s per seat and
shipped vitals, prescriptions and the diagnosis to a screen that reads a token number, and answered
404 for a sealed patient — F1's dimension, blind; **N4/N5/N6/N7** minor (hold-back bypassed on
reload; `isError` unconsulted so a failed re-read kept a stale "unsettled"; a test named 403 that
exercised 404 and an assertion true regardless; a misleading comment).

**Second remediation (this commit):**
- CORE — the guard is back (`if (status === "unsettled") return;`) with N1's road as a test that is
  red without it (R46). **`GET /opd/visits/:id/counter-state`**, purpose-built: status, `feeStatus`
  from `encounterFeeStatuses` (the ONE projection the board reads — D4), `everJoined`, `tokenNo`;
  no patient, no clinical payload, no PHI log, the seat's own permission, and a sealed patient's
  visit answers like any other.
- WEB — `useEncounterOnServer` reads only that; `isError` is UNKNOWN; `canCollect` needs
  `feeStatus === "unsettled"` (so a voided fee invoice lets the seat collect again, and a lab
  invoice does not open the join door); the settle's refusal is said OUTSIDE the panel (the panel
  unmounts on unknown, and its message vanished with it); the hold-back is applied from the current
  flow on the server road; **today's visit is RESUMED, not duplicated** (`useTodaysVisit`, one read
  of the day's list per patient in hand) — which closes F1's road (a) and F7(A) together.
- Revert pairs **R46–R50**, all red then green; R48 and R50 could not fail on first run and got
  their tests (N5's exact road; N4's reload).

### 5.5a The red the peer's full pass found AFTER the close — a race, not a shared-checkout artefact

18a's clean closing pass (HEAD `2152f07` at start and finish, zero dirty under `apps/`) ran the
web suite under a full core jest and found **one red: this phase's own F6(A) test**, Escape during
an in-flight join. Three isolated runs and two concurrent full web suites could not reproduce it;
the mechanism is a RACE the test could only lose under load. `clearDesk` closed over `busy`, and the
`window` keydown listener is re-attached by a passive effect whenever `clearDesk` changes identity —
so between the token's commit and that effect, the listener answering Escape was the stale one that
still believed the join was in flight. Fixed by reading `busy` through a ref assigned during render
(`busyRef`), so an event between a commit and its effects sees the committed state; R51 red without
the check, restored 99/99, full web 68 / 501. **The last commit of a close is the one least likely
to be fully verified** (the peer's words): this test was written after the verification plan was
made, was green in this lane's own full run, and only a run under a different load found it.

### 5.6 Declined at pass 2, with reasons
- **F5 midnight** — stands (a billing ruling). **N7** — comment corrected in the same edit.
- **Contention, not deadlock** — the reviewer traced lock order (invoices → receipts → encounter
  `FOR UPDATE` → session row) and found no inversion; the hook holds the encounter and session rows
  for the remainder of the billing transaction. Accepted: that is the price of "joined with the
  money", and a concurrent second invoice serialises on the encounter lock to one token.

## 7. Findings deliberately NOT fixed in this phase — each verified, each with its reason

1. **F5 — midnight.** `joinQueue` refuses a visit whose `serviceDate` is not today, permanently,
   and a deferred visit opened at 23:58 and paid at 00:03 has its money taken and no way to a
   token from this seat. The server's message names the day. Carrying the fee to a fresh visit is
   a **billing ruling** (a credit note cannot un-settle — RC-3 §6.3), so it is not decided here.
2. **F7(A) — a second same-day visit for an in-hand patient.** `visitsQuery` carries no
   `patientId` term, so the door cannot cheaply ask; `/counter`'s picker has the same hole. RC-5.
3. **F9(B) — `billing-session.tsx` invalidates `["billing-session"]`, not this seat's key.** The
   seat now polls at 15 s, which bounds it; unifying the key is a `/billing` change.
4. **A doctor deactivated between open and join** still gets a session — `joinQueueInTx` does not
   re-check `doctor.active`. Server-side, pre-existing, out of phase.

## 6. OWNER RULINGS NEEDED

1. **Does `/counter` go, and does it go in this phase?** RC-3 §6.2, restated with the ordering this phase proposes: delete it in T5, **after** T1–T4 have shown the seat finishing a patient. Both consequences are already staged — `/counter/seat` is the only NAV row with no manifest entry, and the route-count pin's comment already says 45 → 44.
2. **Is the three-phase cut right?** `2026-09-01-SCOPE-registration-counter-remainder.md`. This doc assumes it.

*(The two MONEY rulings still open from RC-3 §6 — the bundled-coupon bearer question and whether a full refund un-flips the board — gate **RC-5**, not this phase.)*
