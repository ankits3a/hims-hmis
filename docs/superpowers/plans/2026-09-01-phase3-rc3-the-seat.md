# Phase RC-3 — The seat (Registration Counter series, 3 of 4)

**Lane: LIGHT** (5 tasks). This is a WIRING phase wearing a UI phase's clothes — see §1.
**Stop-loss: 1,250,000**, derived from RC-2's measured actuals rather than RC-1's:
`1.5 × (84,000 measured per-task main rate × 5)` = **630,000** · inline-recon carry **100,000** · task-subagent term **0** (LIGHT) · review **510,000** (RC-2's two passes cost 202,946 + 187,415 = 390,361 and its remediation ~120,000; that sum, not a multiplier on a guess).
**The review term is NOT optional and is not a place to save.** RC-2 closed at 62% of stop-loss only once its review was paid for, and that review found 2 CRITICAL + 6 MAJOR over a tree with 3337 green tests, three died mutants and clean typecheck/lint.
**Session token balance at kickoff: ~15.0M** (§2.141; the RC-2 session's measurement went discontinuous on a context refresh — record deltas at each task boundary and say so if it happens again).
**Parallel-lane state at kickoff:** the **18a radiology lane** is running its closing full pass and has just landed T1–T9 plus migration `0050`; the **VD-1 vitals-desk lane** is code-complete through T5. Both share this checkout. §2.152 **and its amendment**: commit with a pathspec AND check nobody else holds the same file dirty — a pathspec commits the WORKING TREE, so it captures a peer's uncommitted edits to a path you name. Test DB `hmis_rc3_scratch`; box slot by message.

## 1. Why this phase — and the finding that reshapes it

The EXECUTE prompt told this series to *"check first for counter rails built server-side but never wired — that was the 07-diagnosis pattern; wire before you build."* Measured this session, RC-1 and RC-2 shipped **eight rails with zero consumers**:

| rail | shipped by | web screens | web wire type |
|---|---|---|---|
| `matchedOn` (why a patient matched) | RC-1 T4 | 0 | **not even declared** |
| `freeReason` (why a visit is ₹0) | RC-1 T5 / RC-2 T1 | 0 | declared, unrendered |
| `avgConsultMinutes` (the wait model) | RC-1 T2/T5 | 0 | not declared |
| `counter_sequence` / `token_lane` (the flow lock) | RC-1 T2 | 0 | not declared |
| `feeSettled` (the PAID stamp) | RC-1 T3 | 0 | not on `WireQueueEntryView` |
| `join-queue` (bill-first's deferred join) | RC-1 T3 | 0 | not declared |
| `couponCodes` at the counter | RC-2 T1/T2 | 0 | declared, unsent |
| `attributionCode` (the partner slip) | RC-2 T2 | 0 | declared, unsent |

**So RC-3 is not "build the seat". It is "wire eight rails and render them in the shape the owner signed off."** That distinction sets the task cut, the risk profile and the review brief: almost nothing here is new server behaviour, and almost everything here is a first consumer — which is the condition under which a rail's design assumptions get tested for the first time. RC-1's C1 (a deferred visit crashed `recordVitals`) was exactly that class, found only when something finally used the state.

The seat is Desk One (`docs/design/2026-08-31-registration-counter/desk-one.html`, signed off 2026-08-31). **No deploy** — production has never left `commissioning`.

## 2. Spike — answered by reading, before authoring

- **S1 — extend `counter-desk.tsx` or replace it?** Read this session. The shipped screen (413 lines, 07b T3) is a LINEAR three-phase flow: `Phase = "find" | "opened" | "done"`, one walk-in start to finish, ending at payment by owner ruling R-1. Desk One is not a longer version of that; it is a PERSISTENT DOSSIER with a workspace beside it, where the patient stays in hand across register → queue → bill → appointment. **DECIDED: a NEW screen, and `counter-desk.tsx` stays until the new one is proven.** Reason: the shipped screen's three exits (settled / credit-extended / free revisit, DD2) and its idempotency-key discipline are correct and must be carried across verbatim — rewriting them in place would put a proven money path and an unproven layout in one diff, and a reviewer could not tell which half a defect came from. The old screen is deleted in RC-4, not here.
- **S2 — what does `usePatientInHand` already carry?** `InHand = { patientId: string; encounterId: string | null }` with `takePatient` / `takeEncounter` / `release`, provider-scoped, already surviving route changes (`patient-in-hand.tsx:33`). **The dossier column is a RENDERING of this, not a new store** — the EXECUTE prompt says so and the code agrees. What it does NOT carry is the quote, the benefits or the token; those are per-encounter server reads and stay that way.
- **S3 — the ₹0 branch.** `feeQuote.free === true` with `draft: null`, and RC-2 T5 put `intendedPayer` on BOTH branches precisely so the free branch can still say "bill to panel". `freeReason` names the review window. The seat renders the reason and shows **no tender buttons** — the design's demo 2.
- **S4 — the theming mechanism.** The owner ruled ALIAS LAYER (2026-08-31). Desk One's tokens are measured from the design: `--paper:#f4f7f4 --card:#fff --ink:#132420 --line:#dfe7e1 --dim:#5c6f66 --faint:#8ea69a --wash:#eef3ef --green:#0e6b4e --gold:#dd8f1c --red:#b23a30`. **The alias layer maps these ONTO the shipped shadcn variables scoped to the seat's root**, so no other screen changes and the seat needs no forked components.
- **S5 — what does M3 actually need?** RC-1's CLOSE recorded the brief: `emitFeeSettled` has two call sites (`invoices.ts` at issue, `receipts.ts` at allocation); the three writers that move an encounter OUT of settled — `reverseAllocation` (receipts.ts:555), `markEnteredInError` (:659), `issueCreditNote` (credit-notes.ts:282) — reach neither. The stamp is stale in the OPTIMISTIC direction (PAID shown after the money reversed). **It needs an EVENT, not just call sites**, and the rename `queue.fee_settled` → `queue.fee_status_changed` must happen now, while it still has no consumer — RC-3 is the phase that gives it one.

## 3. Design decisions

- **D1 — A new screen, `registration-counter.tsx`, mounted on its own route; `counter-desk.tsx` untouched.** Per S1. The three lawful exits and the idempotency-key discipline are LIFTED verbatim, with the old screen's header comment cited rather than paraphrased.
- **D2 — The dossier is a rendering of `usePatientInHand`.** No new session store, no duplicated patient state. The column accretes identity → flow steps → benefit chips → token → live bill, and the bill reprices from the first chip because the QUOTE already composes benefits (RC-2's finding) — the seat re-fetches, it does not compute money.
- **D3 — The alias layer is scoped to the seat's root, not global.** A `[data-seat="registration-counter"]` block maps paper-and-pine onto the shadcn variables. Other seats adopt by adding the attribute; nothing is restyled by default. This is the owner's ALIAS-LAYER ruling made mechanical, and it is what lets RC-4 adopt without a second theming project.
- **D4 — `queue.fee_settled` is RENAMED to `queue.fee_status_changed` and gains a direction, in the same commit as its first consumer.** M3's carry. The three un-settle writers get the hook; the payload carries `settled: boolean` so the board can flip both ways. Renaming now costs one event with no consumers; renaming later costs a migration of meaning.
- **D5 — BEST SINGLE BENEFIT is rendered as a contest, not a total.** `PricedLine.candidates[]` + `.winner` already travel (RC-2 S2). The seat shows the winning chip and the losing chips greyed with their reason — `rejected.detail` where present, otherwise "a bigger benefit won". **A payer-ineligible instrument shows as absent-with-a-payer-note, never as a losing chip** — RC-2 T3 deliberately emits no candidate for it, and rendering one would claim a contest that never ran.
- **D6 — `matchedOn` renders as REASONS, never a score.** The owner's design ruling: "same mobile", "same name", "same UHID" — never a percentage. The web wire type does not declare it yet; RC-3 adds it.
- **D7 — Wait is `waitingCount × avgConsultMinutes`, rendered as `~N min · H:MM`.** The arithmetic is client-side by RC-1 D7; the seam is the column, so a future pace model replaces a read and not the wire.
- **DECIDED — the three RC-2 review carries are NOT silently absorbed here.** The lab-desk instrument oracle is Plan 17's route and gets an owner-visible note, not a drive-by fix in a UI phase; the bundled-coupon bearer question is an OWNER RULING (§6); the quote/invoice cap mismatch is fixed in T1 because the seat is what makes it reachable.

## 4. Tasks

### T1 — CRITICAL · the quote panel: benefits, the contest, the payer, and the ₹0 reason
**Files:** `apps/web/src/screens/registration-counter.tsx` (new), `apps/web/src/lib/billing-api.ts` (send the codes), `apps/web/src/screens/registration-counter.test.tsx` (new).
Renders `candidates`/`winner`/`freeReason`/`intendedPayer`; sends `couponCodes` and `attributionCode`; aligns the quote's silent truncation with the invoice's hard cap (RC-2 review NEW-4 — the seat is what makes the divergence reachable).
**Assertion book:** assertion — a quote with a winning membership and a losing referral renders ONE applied chip and one greyed chip carrying its reason, and the total equals the winner alone; mutant — render summing all candidates; kill — a stacked total the owner's ruling forbids.

### T2 — CRITICAL · the dossier column over `usePatientInHand`, and the three lawful exits
**Files:** the screen, `apps/web/src/lib/patient-in-hand.tsx` (read-only), the test.
Per D1/D2. The exits are lifted verbatim from `counter-desk.tsx` with its DD2 reasoning cited.
**Assertion book:** assertion — a free revisit shows the named reason and NO tender buttons, and confirming releases the token; mutant — the free branch falling through to the tender panel; kill — tender buttons on a ₹0 bill.

### T3 — CRITICAL · the board flips BOTH ways — M3 discharged
**Files:** `apps/core/src/modules/opd/events.ts`, `queue.ts`, `apps/core/src/modules/billing/{settle-hooks,receipts,credit-notes}.ts`, the screen, tests.
Per D4. Rename + direction + the three un-settle writers.
**Assertion book:** assertion — `reverseAllocation` on a settled encounter emits `queue.fee_status_changed{settled:false}` and the stamp clears; mutant — the hook on the settle path only; kill — PAID still shown after the money reversed. **This is the money-visible direction and it gets fail-first treatment.**

### T4 — ROUTINE · search-first find with match reasons, and the wait model
**Files:** `apps/web/src/lib/patients-api.ts` (declare `matchedOn`), the screen, `apps/core/src/modules/opd/queue.ts` (expose `avgConsultMinutes` if unexposed — MEASURE first), tests.
Per D6/D7.

### T5 — ROUTINE · the alias layer, the keyboard map, and the queues overlay
**Files:** `apps/web/src/styles.css`, the screen, tests.
Per D3. Ctrl+K · Ctrl+N · Q · 1/2/3 tender · Ctrl+⏎ · Esc.
**Assertion book:** assertion — the alias block changes NO computed colour on any other screen; mutant — the tokens declared globally; kill — a shadcn screen turning green.

**Verify economy:** T1/T2/T5 are web (`vitest`, cheap); T3 touches core and owes a core batch; a full core+web pass at phase end. `pnpm typecheck && pnpm lint` before every launch. **Tree frozen during any launched run**, and never widen a batch into a directory another lane is working in (RC-2's cost: a batch that reached into `src/modules/opd` inherited a peer's unrun code).

## 5. CLOSE

*(written at close)*

## 6. OWNER RULINGS NEEDED

1. **Is a plan-bundled coupon a BEARER instrument?** RC-2's pass 2 found that a coupon with a `planId`, presented by a stranger, resolves with `instanceId: null` and **permanently spends the member's single-use coupon** — `couponUnusableReason` never checks that a bundled coupon is held by the bill's patient, and the redemption's uniqueness is `(coupon_id, cycle_no)` with no patient term. A leaflet coupon SHOULD be bearer. A coupon bundled with a paid membership probably should not. **This is money and it is the owner's call, not an industry-standard default.**
2. **Does the seat replace `/counter` or sit beside it?** D1 keeps both for one phase deliberately. RC-4 deletes one — which.
