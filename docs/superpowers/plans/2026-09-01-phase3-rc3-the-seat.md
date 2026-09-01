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

**Status: CODE-COMPLETE, NOT DEPLOYED.** Production has never left `commissioning` and the series-wide
prohibition held — nothing in RC-1, RC-2 or RC-3 has been deployed anywhere. Written across two
sessions: T1–T3 in the first, T4/T5 and this close in the second.

### 5.1 What shipped

| task | commit | what it actually is |
|---|---|---|
| T1 | `9dee2bd` | The quote panel renders the CONTEST — winner applied, losers greyed with their reason, never summed. A payer-ineligible instrument is absent-with-a-note, never a losing chip (RC-2 T3 emits no candidate; drawing one claims a contest that never ran). The quote's silent truncation aligned with the invoice's hard cap. |
| T2 | `4a58f45` | The dossier as a RENDERING of `usePatientInHand`, never a second store, and DD2's three lawful exits lifted verbatim from `counter-desk.tsx` with its header quoted rather than paraphrased. |
| T3 | `03fd081` | **M3 discharged.** `queue.fee_settled` → `queue.fee_status_changed`, `status` widened to all four `EncounterFeeStatus` values, and the three un-settle writers (`reverseAllocation`, `markEnteredInError`, `issueCreditNote`) given the hook. The board flips BOTH ways. |
| T4 | `956dc9b` | `matchedOn` declared in a web type for the first time and rendered as REASONS, never a score. Search-first made a GUARD: the register-new door does not exist until a query has come back empty. The wait model, `~N min · H:MM`. |
| T5 | `bcc8309` | The alias layer scoped to `[data-seat="registration-counter"]`, the key map as a testable function, the queues overlay, and the route `/counter/seat` (44 → 45). |
| close | `4ccc8ed` | The two contract-pass findings below, and the stale event pin a peer lane's full run caught. |

### 5.2 The measurement that deleted half of T4

The phase doc told T4 to expose `avgConsultMinutes` on `queues/summary` **if unexposed — MEASURE
first**. Measured: `summaryByDoctor` already batches the department read and fills it
(`opd/queue.ts:293-306`), and `opd-queue.controller.ts:109` returns `DoctorSummary[]` with no
serializer between. The number had been leaving the server on every request since RC-1. **T4 needed
no core change at all** — only a web type that had stopped being narrower than its producer. §1's
eight-rails finding in its smallest possible form, and the reason the doc said measure rather than
write.

### 5.3 The eight rails, re-measured at close — AND CORRECTED BY THE REVIEW

**The first version of this table was wrong and the correction belongs in it, not in a footnote.**
It claimed five of eight wired. Review pass 2 re-measured by grep and found **three**.

| rail | consumer after RC-3 |
|---|---|
| `matchedOn` | **WIRED** — `patients-api.ts:45`, rendered as reason chips |
| `freeReason` | **WIRED** — reached through the assembled seat |
| `avgConsultMinutes` | **WIRED** — the wait line and the queues overlay |
| `feeSettled` / the board flip | **UNWIRED on the web.** `feeStatus` exists on core's `QueueEntryView`; `apps/web` contains zero occurrences of `feeStatus` or `feeSettled`, and nothing subscribes to `queue.fee_status_changed`. T3 made the event flip both ways and no screen reads it |
| `counter_sequence` / `token_lane` | **UNWIRED** |
| `join-queue` | **UNWIRED** — the seat opens no visit |
| `couponCodes` | **NOT SENT.** The only call in the tree is `reprice([])`. There is no coupon input on any screen, and `billing-api.ts` was not touched by this phase at all. The screen's own comment said "This is the first sender"; it is not a sender |
| `attributionCode` | **NOT SENT** — `reprice`'s second argument is `undefined` at its only call site |

**Five of eight are still unwired.** I had counted the DOOR being open as the rail being wired. A
door with no room behind it is the §1 defect wearing a different coat, and writing "wired" against
it in the close would have handed RC-4 a table that lied in the one direction that matters.

### 5.4 What the CONTRACT PASS found, over 33 green tests and 13 dead mutants

Reading the phase doc's clauses against the shipped code — 18a's technique, adopted by this lane at
T1 — found **two clauses this phase had written and not done**. Neither had a failing test.

1. **D2's "the column accretes … the live bill".** The assembled seat was handing `quote={null}`
   into the panel T1 built. `QuotePanel`, `useQuote`, `freeReason`, `intendedPayer` and the whole
   BEST SINGLE BENEFIT contest had **no consumer on the screen** — inside the phase whose §1 finding
   is that eight rails shipped with no consumer. The task written to close that defect reproduced it
   in its own assembly step. **Why 33 tests missed it is 18a's diagnosis word for word: every
   assertion that touched it handed `QuotePanel` a quote DIRECTLY.** The component was tested
   exhaustively and never once reached through the screen that mounts it.
2. **T2's assertion book, second half — "…and confirming releases the token".** There was no
   confirmation on the seat at all. `counter-desk.tsx`'s `reset()` ends with `release()`, so
   acknowledging a patient is served is the same act as clearing the desk; the seat had that bound
   to `Esc` and to nothing a clerk could see.

And the fix itself proved §1 a third time: wiring the quote put `reprice` in an effect's dependency
list, and T1 had shipped it as a plain function — correct for a click handler, an infinite refetch
loop in an effect. **Nothing was wrong with the rail until something used it.**

### 5.5 Mutants — thirteen built, thirteen applied to the tree and run, thirteen dead

| | mutant | result |
|---|---|---|
| M1 | `matchReasonKeys` drops the empty fallback | 1 failed / 19 passed |
| M2 | `WaitLine` hardcodes the schema default 6 | 2 failed / 18 passed |
| M3 | the clock loses the IST offset | 3 failed / 17 passed |
| M4 | reason chips replaced by a confidence percentage | 1 failed / 19 passed |
| M5 | the register-new door rendered unconditionally | 2 failed / 20 passed |
| M6 | the alias tokens declared globally in `:root` | 1 failed / 31 passed |
| M7 | `data-seat` hoisted onto a second file | 1 failed / 31 passed |
| M8 | the typing guard dropped from `seatKey` | 1 failed / 31 passed |
| M9 | the seat rebinds Ctrl+K | 1 failed / 31 passed |
| M10 | 1/2/3 drifts to cash/card/upi | 3 failed / 29 passed |
| M11 | the seat passes null into its own quote panel | 3 failed / 33 passed |
| M12 | confirming does not release | 1 failed / 35 passed |
| M13 | `reprice` loses its `useCallback` | 1 failed / 35 passed |

M13's kill has to be a CALL COUNT: with an unstable identity the screen renders, fetches, sets
state, re-renders and fetches again, and **the rendered output of an infinite refetch is identical
to the rendered output of one**. Every other assertion in the file still passes.

### 5.6 Two instrument lessons this phase paid for

**A revert is a write, and a write to a file with uncommitted work is a deletion you did not type.**
(The sentence is the 18a lane's, on hearing this one.) Cleaning up mutant M7 with
`git checkout -- apps/web/src/router.tsx` restored the *committed* file and silently discarded T5's
uncommitted route mount — and the suite went green again immediately, because the census that mutant
kills reads the router and the reverted router is innocent. **A green run over a tree that had lost
half the task, and nothing in the output said so.** The other twelve mutants were reverted from
scratch copies and were never at risk.

**The census guard earned its keep on its first run.** §2.49 says pin the census before comparing
anything against it, and it fired: the CSS parser reported 13 blocks with `:root` not among them —
the long docstring above `:root` was itself being matched as a selector running to the next `{`.
Every "no Desk One hex outside the seat" assertion would have been evaluated over a list that did
not contain the block it was about, and the seat's own block only "matched" because its docstring
quotes its own selector. **A test passing for a reason unrelated to what it tests.**

### 5.7 The red this phase left on `main`, and how it was found

`apps/core/test/billing-lifecycle.e2e.test.ts:216` still pinned `queue.fee_settled` after T3's
rename. Confirmed by grep to be the **only** stale reference in the repository — the source was
fully renamed. It survived because T3's evidence batch was scoped to
`billing`/`opd`/`membership`/`partners` and this is a top-level `test/` e2e, one hop outside all
four. **The pin was added by RC-1's own CLOSE** (`9bcc05f`, "the one red in a 3268-test full pass")
and then sat outside the next lane's scope — §2.138's shape exactly, a census file in no task's
Files list. **Found by a peer lane's full run, not by this one's**, which is the argument for the
phase-end full pass in one line.

### 5.8 The seat is REACHABLE, and one deliberate omission

`/counter/seat` carries a NAV entry with `opd.visits.open` — the same permission `/counter` carries,
so both links are visible to exactly the same people, which is what makes the comparison the owner
is being asked to make a fair one. It is **the only NAV row with no module-manifest counterpart, on
purpose**: RC-4 deletes one of the two counters and §6's second ruling is WHICH, so declaring it
server-side now would put a permanent declaration behind a screen scheduled for a decision.
`nav-parity.test.ts`'s own docstring names this case as legitimate.

### 5.9 The closing verify

Run at `52f34c6`, on the build host, after the 18a lane released the box — verified free with a
check that matches `processChild` WORKERS and not only supervisors, which is the instrument lesson
this box has now taught three lanes.

| | |
|---|---|
| web `vitest run`, FULL | **67 files / 432 tests, exit 0** |
| core `jest test/billing-lifecycle.e2e.test.ts` (`hmis_rc3_scratch`) | **1 suite / 9 tests, exit 0** |
| core `jest test/caddyfile-parity.test.ts test/nav-parity.test.ts` | **2 suites / 9 tests, exit 0** |
| `pnpm typecheck` (workspace) | **exit 0** |
| `eslint` on every changed source file | **exit 0** |

No full core batch was run by this lane and that is stated rather than glossed: T4 and T5 touched no
core source at all (T4's measurement removed the only planned core change; T5's core edit is one
integer in a parity pin), and T3's core work was evidenced in its own session at 97 suites / 920
tests. The one core file this close changed is a test, and it was run.

### 5.10 THE TWO CLOSE REVIEWS — what they found over a green tree

Both passes ran fresh on `52f34c6`: pass 1 on correctness/money/PHI/state, pass 2 on
contract-versus-code and reachability. Over a tree with **36 green tests, 13 dead mutants, clean
typecheck and clean lint**, they returned **2 CRITICAL + 5 MAJOR + 7 MINOR** and **1 CRITICAL +
7 MAJOR + 11 MINOR**, overlapping heavily. Every finding below was verified against the code before
being accepted; none was taken on the reviewer's word.

| | finding | fixed in |
|---|---|---|
| **CRITICAL** | **The bill outlived the patient.** `useQuote` held a bare quote; neither the early return nor the `catch` cleared it. One counter cycle — price A, clear the desk, pick B (whom `takePatient` puts in hand with `encounterId: null`) — and the dossier rendered **A's bill under B's name**: A's chips, A's review-window reason (a doctor's name and dates, PHI), and "Collect ₹400" from someone who owed nothing | `325c003` |
| **CRITICAL** | **A collect order the seat could not justify.** The seat hard-coded `issued={null}`, and `feeQuote` is a PRICE quote that reads nothing about settlement — so the guard reduced to "is this chargeable", true whether or not it had been paid. Bill at `/counter`, switch to the seat, and it says collect ₹400 again | `325c003` |
| MAJOR | **The winner was drawn as its own loser.** `candidates.filter(c => c !== winner)` — correct in-process, where `winner` is a reference into `candidates`; **JSON does not carry references.** Every real quote printed "Member benefit — ₹100 off" and, below it in grey, "Member benefit — not applied" | `325c003` |
| MAJOR | **An errored search read as an empty one.** `retry: false`, so a 403 offered the REGISTER-NEW door — the screen whose purpose is "a duplicate stopped here costs nothing" inviting one at the moment it could not tell | `325c003` |
| MAJOR | **Dismissing the command palette released the patient.** Its Escape is a React `onKeyDown` with `preventDefault` and no `stopPropagation`; React 18 dispatches below `window`, where the seat listens | `b3310f7` |
| MAJOR | **Ctrl+N was dead where it was needed** — below the typing guard, with an `autoFocus` search box. (And it is a Chrome-reserved chord regardless: §6.) | `b3310f7` |
| MAJOR | **The alias layer had no consumer.** Eighteen aliases, and the screen carried not one `className`. "Changes no colour on any OTHER screen" was true because it changed no colour on ANY screen | `b3310f7` |
| MAJOR | **The cap alignment had no assertion at any level** and the `?referral=` half was never aligned at all — T1 fixed the coupon parser and left the identical silent drop five lines below | held, see §5.12 |
| MAJOR | **A test whose NAME claimed what it never asserted** — "a full-value credit note un-flips it too" asserted only `via`, and the claim is FALSE: `settlementState` counts credit notes toward coverage, so a credit note can only move a fee status settled-ward | `8fd05a2` |
| MINOR | The rename rewrote its own history; dev scaffolding printed `upi` on the counter; "start again" left the search box full; `Ctrl+Enter`'s documented fall-through was unasserted; the CSS leak census was narrower than its own docstring | `b3310f7`, `8fd05a2` |

**Both passes reached the same diagnosis independently, and it is 18a's sentence:** *every assertion
that touched a defect checked a state where the right and the wrong behaviour agree.* A fixture
sharing an object reference JSON cannot produce; a harness stubbing only successes; a `Dossier`
reached with props passed by hand rather than through the screen; a seat mounted without the
providers it lives inside; a stylesheet asserted for leakage and never for consumption; a screen
never driven through a second patient.

### 5.11 THREE OF MY OWN CHECKS COULD NOT FAIL — found by running the revert

Every fix above was reverted and re-run to prove the new test goes red against the original defect.
That practice caught three checks of mine that were worthless, all in one session:

1. **The reverted router** (§5.6) — `git checkout` on a file with uncommitted work, and the suite
   went green over a tree that had lost half a task.
2. **The refused-refetch test** — it stubbed a fee-quote that always fails and asserted no panel,
   but with no prior SUCCESS there was never a stale quote to leave standing. It held whether or not
   the `catch` cleared anything. Rewritten to drive success-then-failure.
3. **The alias-consumer test** — it grepped the SOURCE for `bg-background`, so stripping the seat
   root's classes left it green: the utility still appeared on the search input. It asserts the
   RENDERED element's `className` now.

**The pattern the reviewers named, occurring three times inside the work of fixing it.** Before
trusting a check, ask what it would report if the thing you are looking for were absent — and if the
answer is "the same", it is not a check.

### 5.12 Held, not done — and why

**F6's referral-cap fix and its assertions are written and NOT committed.** `test/billing.e2e.test.ts`
boots the whole Nest app, which imports the radiology module, and the 18a lane's in-flight close
remediation does not compile — so **every top-level e2e in the repository is unrunnable right now**,
not only mine. An assertion nobody has executed is not evidence. It lands when their tree compiles.
(That fact was worth passing to them: they had cleared me on the grounds that my tests import no
radiology, which is true of a unit test and false of any test that stands up the app.)

### 5.13 Carried to RC-4, with named owners

- **`lab/lab-desk.controller.ts:183` is an instrument oracle.** Same shape RC-2 MAJOR 4 closed on
  billing's preview: no `@CurrentActor()`, `patientId` a required body field, so `lines[].candidates`
  leaks membership status, plan tier and literal coupon codes for any patient, outside
  `visiblePatientIds`. Pre-existing (Plan 17's route), latent while `MEMBER_BENEFITS_ENABLED` is off.
  **This is the owner-visible note §3's DECIDED paragraph promised**; it was deliberately not fixed
  as a drive-by in a UI phase.
- **`MEMBER_BENEFITS_ENABLED` arms HOSPITAL-WIDE, not counter-wide.** `lab-desk.controller.ts:183`
  and `ot/bill.ts` both pass `patientId` and so resolve instruments. Whoever flips that `.env` should
  know.
- **CRITICAL (inherited, Plan 09): nothing in shipped code ever creates an `entitlement_counters`
  row.** A `kind='package'` plan with no counter prices as unlimited free consults, for ever. The
  granting step has no owner in any plan.
- **`issueInvoice` never checks `encounter.patientId === input.patientId`** (RC-2 review MAJOR 6).
- **§2.154's open question** — RC-1 T3's join-queue race mutant died on an *unwarmed* connection
  pool, where a right kill and a lucky interleaving are indistinguishable. Warm and re-run.
- **Four declarations of one patient-search shape.** `patient-picker.tsx:17`,
  `registration-desk.tsx:16` and `merge-review.tsx:8` each declare a private, identical `SearchHit`,
  all three missing `matchedOn`; T4 added `WirePatientHit` in `lib/patients-api.ts` as a fourth,
  deliberately, because D1 freezes those screens. **The obvious remedy — "hoist `SearchHit` into
  contracts" — cannot be performed literally: `packages/contracts/src/search.ts:58` already exports a
  `SearchHit`, and it is a different concept (the command palette's cross-entity hit).** The
  migration target is `WirePatientHit` and the three copies must be RENAMED, not moved. (Found by the
  VD-1 lane, cross-session.)
- **Three of the eight rails are still unwired** — see §5.3.

## 6. OWNER RULINGS NEEDED

1. **Is a plan-bundled coupon a BEARER instrument?** RC-2's pass 2 found that a coupon with a `planId`, presented by a stranger, resolves with `instanceId: null` and **permanently spends the member's single-use coupon** — `couponUnusableReason` never checks that a bundled coupon is held by the bill's patient, and the redemption's uniqueness is `(coupon_id, cycle_no)` with no patient term. A leaflet coupon SHOULD be bearer. A coupon bundled with a paid membership probably should not. **This is money and it is the owner's call, not an industry-standard default.**
2. **Does the seat replace `/counter` or sit beside it?** D1 keeps both for one phase deliberately. RC-4 deletes one — which. **Practical consequence already taken:** `/counter/seat` is the one NAV row in the app with no module-manifest entry, precisely so that a permanent server-side declaration is not made behind a screen scheduled for deletion. Ruling this closes that too.

3. **Should a fully-refunded consult put the token back to UNPAID on the board?** Found by the close review, and it is a real design question rather than a defect. `settlementState` computes `covered = credited + allocated`, so a credit note counts TOWARD coverage: on an already-settled invoice, even a full-value refund leaves the fee status `settled`. **A credit note can only ever move a fee status settled-ward** — confirmed by execution, not argument. D4 claimed the opposite ("a full-value one can take an encounter straight back out of settled") and the test asserting it checked only `via`. Both readings are defensible — nothing is outstanding and the refund lives in the voucher lane, versus the patient did not pay for this visit — and the answer changes what a clerk sees on the board after a refund. **Not mine to default; it is money and it is patient-visible.**

4. **What chord replaces `Ctrl+N` for "new walk-in"?** The design specifies it and **Chrome does not deliver it to the page** — it is on the non-overridable list (new window), and Firefox opens a window regardless of `preventDefault`. The handler is correct and the chord is unreliable in the browser the hospital runs. The two doors that DO work today are the global `F2` and the on-screen `Register new` button, both reaching the same `?new=true`. Choosing a different chord (or ruling that `F2` is the only keyboard door) is a design decision, so it is here rather than invented at close.

---

## 7. NOT FIXED, DELIBERATELY — the review findings this phase declined to absorb

Recorded so RC-4 inherits a list rather than a surprise. Each was verified and each was left.

- **`issueCreditNote` emits an event announcing a change that did not happen** (`status:"settled", via:"credit_note"`). Fixing it means either dropping the call site or changing what `settlementState` means — and the second is a repo-wide settlement-semantics change that has no business happening in a close remediation. Gated on §6.3.
- **The leaving direction has no pharmacy discriminator.** `queue.ts` bails on `unsettled` only for ARRIVING vias. Voiding a receipt against a pharmacy-only invoice, on an encounter whose consult fee was never paid, emits `{status:"unsettled"}` on a token that was already UNPAID — RC-1's M1 case in the mirror, and the symmetric guard was never written. Noise, not incorrectness.
- **The un-settle event is gated on a LIVE queue entry.** A credit note or a reversal at day-close or reconciliation usually happens after the consult completes, when no live entry exists — so M3's event is not emitted on the common timeline. Defensible (there is no board row to flip) but the guard's stated justification was written for the arriving direction and was never revisited. All four new tests seed a live token, which is the one state where present and absent agree.
- **The dossier renders a raw patient UUID.** D2 says the column accretes "identity"; `patient-in-hand.tsx` stores ids *because* "everything displayed is read live from the id", and the seat displays the id and reads nothing. A clerk cannot verify `9f3c…` against the person in front of them. Real, and it needs a patient read the seat does not yet make.
- **`QuotePanel` renders only `lines[0]`** while printing the whole draft's total. Correct for today's single-line consult fee; a second line would produce a total no chip explains.
- **`reverseAllocation` re-reads an invoice it already holds under lock** (`receipts.ts`), and the `invoiceId !== null` guard beside it is unreachable. One extra query per reversal.
- **D2's remaining nouns — flow steps and the token — are not on the seat at all.** The seat opens no visit, so there is no token to draw. RC-4's.
- **Radix portals escape the alias layer.** A shadcn `Dialog` or `Select` opened from the seat renders at `document.body`, outside `[data-seat]`, and reads the greyscale values. Recorded in `styles.css` itself; RC-4 either passes the attribute onto the portal container or accepts neutral modals — on purpose, rather than by discovery.
