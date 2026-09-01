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
- **S3 — the flow pill.** `counterSequence` and `tokenLane` are department-masters fields, patched through `opd-masters.controller.ts`. So the pill READS the department the seat is working under and the switch is a masters PATCH — which means it is **supervisor-permissioned by construction** (`opd.masters.manage`), not by a new gate.
- **S4 — the PAID stamp.** `feeStatus` is `"free" | "settled" | "credit" | "unsettled" | null` on core's `QueueEntryView` and is **absent from web's `WireQueueEntryView`**. Identical to RC-3 T4's `avgConsultMinutes`, which the phase doc told that task to *measure first* and which turned out to need **no core change at all**. **MEASURE before writing anything here too** — the answer is probably a one-field widening, and if it is, say so rather than inventing work.
- **S5 — does the flip reach the browser live?** `queue.fee_status_changed` is emitted in the settling transaction (RC-3 T3) and `realtime.ts` is the existing push seam. **MEASURE whether the event already reaches the web push channel** before building a subscription.

## 3. Design decisions

- **D1 — The seat REGISTERS in place; it no longer navigates away.** RC-3's `Register new` button calls `onRegisterNew`, which leaves for `/registration?new=true` — and leaving is the defect the seat exists to remove (the dossier, the search, the whole in-hand session are abandoned to open a form). Four fields, inline, `usePatientInHand` intact across it.
- **D2 — The walk-in call and its idempotency key are LIFTED from `counter-desk.tsx`, not re-derived.** Per S1 and RC-3's D1 precedent. The old screen's header is quoted rather than paraphrased.
- **D3 — Bill-first is a DEFERRED JOIN, and the token is born PAID.** The flow pill's `Register → Bill → Appointment` sequence sends `join: "defer"`, takes the money, then calls `join-queue`. The alternative — issuing a token and flipping it — is what `token_lane` exists to avoid, and demo 3's wording is explicit: *"their token leaves the printer already PAID."*
- **D4 — The PAID stamp is rendered from `feeStatus`, never re-derived on the client.** `encounterFeeStatuses` is the one projection; a screen that recomputed "is this paid" from an invoice would be a second truth function that can disagree with the board. RC-3's F4 is the same lesson from the other side: the seat could not see settlement and so must not claim it. **This task is what finally lets the seat claim it.**
- **D5 — The flow pill wears the setting openly and switching it is a masters PATCH.** Per S3. A clerk sees which sequence the counter is in; only `opd.masters.manage` can change it.
- **D6 — `/counter` is deleted LAST, in its own task, after the seat demonstrably finishes a patient.** Not first, and not as a side effect. The honest moment to delete a proven money path is when its replacement has been shown to do the same job — which is T1–T4's output. Gated on §6.1.

## 4. Tasks

### T1 — CRITICAL · the seat opens a visit, and registers in four fields without leaving
**Files:** `apps/web/src/screens/registration-counter.tsx`, its test.
Per D1/D2. Lift `walkIn` + the idempotency key + `acknowledgedDuplicates` from `counter-desk.tsx`; the register form replaces the navigate-away.
**Assertion book:** assertion — registering a new patient from the seat opens a visit, puts them in hand, and the dossier fills **without a navigation**; mutant — the register path drops `acknowledgedDuplicates`, so a duplicate-suspected refusal becomes a dead end; kill — a clerk who cannot proceed past a near-match.
**Assembly clause (§5A.3):** drive the screen through **two patients** and assert nothing of the first survives — this is the exact defect RC-3's F1 shipped.

### T2 — CRITICAL · the deferred join, its first consumer since RC-1 wrote it
**Files:** the screen, `apps/web/src/lib/opd-api.ts`, tests.
Per D3. `join: "defer"` → bill → `POST /opd/visits/:id/join-queue`.
**Assertion book:** assertion — a bill-first walk-in has **null token, session and entry** until the money is taken, then joins with a token that is already PAID; mutant — the join fires before settlement; kill — an UNPAID token on the board in a lane whose entire purpose is that it never appears.
**This is the phase's highest-risk task** (S2) and it gets fail-first treatment.

### T3 — CRITICAL · the PAID stamp on the board
**Files:** `apps/web/src/lib/opd-api.ts` (declare `feeStatus` — **MEASURE first**), the screen, `realtime.ts` if S5 says so, tests.
Per D4.
**Assertion book:** assertion — a settled encounter's token renders PAID and an unsettled one does not, from the server's `feeStatus` alone; mutant — the client re-deriving paid-ness from an invoice; kill — a board that disagrees with `encounterFeeStatuses` after a reversal, which is precisely what RC-3 T3 made the event able to report.

### T4 — ROUTINE · the flow pill, worn openly
**Files:** the screen, `apps/web/src/lib/opd-api.ts`, tests.
Per D5.
**Assertion book:** assertion — the pill shows the department's current `counterSequence`, and a clerk without `opd.masters.manage` cannot change it; mutant — the pill rendered from client state rather than the department's own value; kill — two counters showing different sequences for one department.

### T5 — ROUTINE · `/counter` is deleted — **GATED on §6.1**
**Files:** `apps/web/src/router.tsx`, `apps/core/test/caddyfile-parity.test.ts` (45 → 44), `counter-desk.tsx` (deleted), the NAV row, `nav.counterDesk`/`nav.counterSeat` locale keys.
Per D6. **Do not start this task before the ruling**, and do not start it before T1–T4 are green.
**Assertion book:** assertion — `caddyfile-parity` counts 44 and `nav-parity` still agrees on every surviving path; mutant — the route removed and its NAV row left behind; kill — a permission-gated link to a screen that no longer exists.

**Verify economy:** T1–T4 are web (`vitest`, ~30s for all 68 files, no database, no box slot). T3 may touch core; if it does it owes a scoped core batch. `pnpm typecheck && eslint` before every launch — **vitest strips types, so a green web suite can sit over code that does not compile.** A full core+web pass at phase end. **Never a bare `pnpm verify`** (§2.151).

## 5. CLOSE

*(written at close)*

## 6. OWNER RULINGS NEEDED

1. **Does `/counter` go, and does it go in this phase?** RC-3 §6.2, restated with the ordering this phase proposes: delete it in T5, **after** T1–T4 have shown the seat finishing a patient. Both consequences are already staged — `/counter/seat` is the only NAV row with no manifest entry, and the route-count pin's comment already says 45 → 44.
2. **Is the three-phase cut right?** `2026-09-01-SCOPE-registration-counter-remainder.md`. This doc assumes it.

*(The two MONEY rulings still open from RC-3 §6 — the bundled-coupon bearer question and whether a full refund un-flips the board — gate **RC-5**, not this phase.)*
