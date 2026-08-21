# Plan 08 pipeline C (T13–T16) — execution notes

**Run:** 2026-08-20/21, EXECUTE-METHOD v2, driven by the `Workflow` tool (the permission block that
forced pipeline B onto the Agent tool is gone). Baseline `ce8b6e7` → HEAD `b9b75a7`.
**Result: 4/4 tasks done, every one PASSED BY ITS OPUS GATE ON THE FIRST RUNG.** Nine agents,
0 errors, 0 skips, 2.20M subagent tokens, 768 tool calls, 4 h 37 m wall clock.

**Plan 08 ends here.**

---

## 1. Independent verification (main session, not agent self-report)

| check | result |
|---|---|
| detached `pnpm verify` at `b9b75a7`, exit VALUE read from a file | **0** |
| apps/web | **29 files / 133 tests** (baseline 21 / 80) |
| apps/core | **118 suites / 755 tests** — unchanged, as designed (no pipeline-C task touches it) |
| packages/contracts | **3 suites / 7 tests** — unchanged |
| `git show --stat` per commit vs its Files list | exact, 4/4 — 19, 5, 7, 6 paths |
| frozen-path audit over the WHOLE range | **clean** — 28 unique paths, none in `apps/core`, `packages/`, `.github`, `components/ui`, `lib/opd-api.ts`, `package.json`, `pnpm-lock`, `tsconfig`, `jest.config` |
| CI green by FULL SHA, all four | 32394035042 · 32398985550 · 32406885800 · 32411297202 — all **success** |
| server tree | `git status --porcelain` **empty**; no `*mutant*` / `*.control.*` / `*.stub.*` residue anywhere under `/opt/hmis` |
| migrations | none — pipeline C is web-only |
| commit messages | byte-exact to the plan's Task 13/14/15/16 Commit lines, no `Co-Authored-By` trailer |

Per-commit mechanical check (main session, after every task, per EXECUTE-METHOD v2 §4):

| task | commit | Files list | frozen | msg | CI |
|---|---|---|---|---|---|
| T13 counter + components | `7015fbc` | 19/19 | none | exact | green |
| T14 dues & advances | `b81e127` | 5/5 | none | exact | green |
| T15 session + absorbed | `c505b48` | 7/7 | none | exact | green |
| T16 back office + docs | `b9b75a7` | 6/6 | none | exact | green |

**Sequencing note.** The `pnpm verify` leg was deliberately NOT run concurrently with a task's own
gate: rule 20 / §2.10 (the per-worker DB name derives from `JEST_WORKER_ID` and collides across
agents) makes a concurrent run corrupt both measurements. The safe legs ran per task as commits
landed; CI-by-SHA is a genuine per-commit full-suite run, so no task went unverified in the interim.

---

## 2. THE MEASUREMENT §2.35 OWED — and the verdict

EXECUTION-LESSONS §2.35 replaced the plan's *"3× each"* for all eleven pipeline-C mutants with
**one kill run + one CONTROL run**, and required this file to record *whether any kill was
ambiguous in a way a third run would have resolved.*

**No kill was ambiguous. §2.35 STANDS; 3× does not come back.**

Every kill in the run carried its passing control, and every kill quoted the ASSERTION's own
failure (never a bare exit code, never a typecheck death — §2.26):

| mutant | kill evidence (expected vs received) | control |
|---|---|---|
| W-1 keydown lane | `expected [] to have a length of 1 but got +0` ×2 + missing `data-search-input` | pass |
| W-2 tender strings | posted-body assertion | pass |
| W-3 refetchInterval | `expected 1 to be greater than 1` | pass |
| W-4 `.print-doc` | class absent | pass |
| W-5 full-outstanding | `- "amountPaise": 30000, + "amountPaise": 45000` | pass |
| W-6 clearance category | `- "discountCategory": "scheme"` absent | pass |
| W-7a/W-7b denomination ×100 | `Expected ₹7,100.00 / Received ₹71.00`; deep-equal on the keys | pass |
| W-8 consult shortcuts | `expected [] to have a length of 1` ×3 | pass |
| W-9 stale age band | `Expected: Adult / Received: Child (1-5)` | pass |
| W-10 day-book recompute | `Expected ₹12,500.00 / Received ₹12,000.00` | pass |
| W-11 recon body shape | whole-body `toEqual` | pass |

Plus **nine unprompted mutants** the gates and the discovery reviewer built without being asked —
four of which SURVIVED and became the run's most valuable findings (§3 below).

**The one ambiguity that did arise was resolved by DIAGNOSIS, not repetition, which is §2.35's own
argument.** T14's gate's first full `pnpm verify` exited 1 with three failures in
`opd-lifecycle.e2e.test.ts`. Three identical re-runs would have reproduced it identically for about
thirty minutes and then stopped — repeating the ambiguity exactly as §2.35 predicts. What resolved
it was `git diff --stat 7015fbc b81e127 -- apps/core packages/` being empty plus the suite's own
docstring naming the window. See §4 item 1: the cause is real and it is now proven in CI.

**Net cost:** 33 prescribed isolated runs → 22, with strictly stronger evidence, and the control
run again earned its keep — every gate used it to prove the failure was the assertion and not the
harness.

---

## 3. The discovery review — the cross-task pass, and one correction to it

The per-pipeline discovery reviewer read all four commits together plus three ancestors. It
produced 12 findings, 8 cross-task risks and 12 carried-forward items, with executed probes and
five rebuilt mutants rather than hand-walks. **It is again the highest-value agent in the run.**

### 3.1 BLOCKING — every money button in all four screens is re-entrant

Probe against **shipped** `billing-dues.tsx` (no mutant — the real code): open the dues-clear lane,
type ₹300, click `clear-submit` twice before the round trip settles →
`AssertionError: expected 2 to be 1` on the count of `POST /billing/receipts`. **One physical
payment, two receipt rows.**

`grep -rn 'submitting|isPending|busy|inFlight|disabled={'` across all four billing screens returns
**nothing at all**. Every write is the same bare idiom, `<Button onClick={() => void handler()}>`:
`submit-invoice`, `clear-submit`, the take/apply-advance lanes, `open-submit`, `close-submit`,
confirm-close, `pay-submit`, `eie-confirm-submit`, the recon upload.

The server offers no idempotency key on `POST /billing/invoices` or `POST /billing/receipts`, so
the duplicate is a real second document: a duplicated cash receipt inflates the patient's advance
and **manufactures exactly the drawer variance `44c8b86` was written to eliminate**; a duplicated
invoice POST issues a second invoice number against one encounter.

This is the shared-idiom class the discovery pass exists to find: **no single task shipped it
wrong, all four shipped it the same way, and no per-task gate could see that it is universal.**
None of the 33 tests these four commits added asserts single-submit under a double click.

### 3.2 The 15 s polling convention has ZERO teeth on the one screen with three polled worklists

§3.34 recurring, one plan after it was written into the ledger. The reviewer built the convention
mutant for all four billing screens (`sed '/refetchInterval: POLL_MS,/d'`) and ran each screen's own
shipped spec against it:

- `billing-counter.tsx` (T13, K39/W-3) — **DIED**, `expected 1 to be greater than 1`
- `billing-dues.tsx` (T14) — **DIED**
- `billing-session.tsx` (T15) — **DIED**
- **`billing-office.tsx` (T16) — SURVIVED, `Tests 11 passed (11)`, exit 0**, with all three
  `refetchInterval` lines deleted (refund worklist, mismatch worklist, day book)

`billing-office.test.tsx` has no polling assertion at all — its header says *"`useFakeTimers` is
only needed to drive timers, and this file drives none"* — while `README.md`'s new
"Polling, not push" section, shipped in the same commit, promises by name that the back office's
worklists refresh on the convention. Code correct, criterion met, suite green, README asserting it,
and deleting the whole thing fails nothing.

Two useful secondary results: T13's K39 genuinely owns the teeth (its 14 s negative control is the
only assertion in the repo separating "the interval fired" from "something re-rendered"), and
T14's/T15's self-labelled "presence only" assertions are **honest but conservative** — both do kill
removal of `refetchInterval`, they simply cannot attribute the second GET to the interval, which is
exactly what their comments claim.

### 3.3 A terminal refusal was handed off in a source comment and never received

`billing-dues.tsx:51` states: *"The ledger's OTHER terminal refusal, `eie_advance_refunded`, is
raised by `markEnteredInError` and is unreachable from this screen — the EIE lane lives in the back
office, which owns it."* T16 then built that lane and never picked it up:
`grep -rn 'eie_advance_refunded' apps/web/` returns exactly one hit — that comment.

T14 discharged its own half properly (`TERMINAL_CODES` at line 54, the dead-end branch at 177, a
test at `billing-dues.test.tsx:374` with an `over_allocation` not-over-broad companion). T16 renders
`eie_advance_refunded` as an ordinary inline alert with the receipt id and reason retained, inviting
the operator to retry a 409 that can never succeed. Pipeline B §4 item 1 was explicit that BOTH must
be dead ends. **The guard `44c8b86` cost ~380k tokens to add reaches the operator as a retryable
error.**

### 3.4 CORRECTION: the reviewer's finding 4 is a FALSE POSITIVE, and the real cause is worse

The reviewer reported that the tree behind `c505b48` and `b9b75a7` carried seven untracked scratch
files — two of them vitest-collected FAILING tests — and concluded that AGENT-RULES §5 step 0 was
not honoured at T14 and that *"the local `pnpm verify` behind those two commits could not have been
green."* It flagged its own uncertainty honestly and could not exclude an alternative.

**The main session verified this and the conclusion is wrong. The files were never on the server.**

Evidence, all gathered directly:

1. The seven files are in the **shared session scratchpad mirror**, at
   `…/c3d4d251-…/scratchpad/mirror/apps/web/src/screens/billing-dues.{stub,w5.*,w6.*}.tsx`.
2. The build host has none of them: `find /opt/hmis -name '*mutant*' -o -name '*.control.test.*'
   -o -name '*.stub.tsx'` returns **empty**, and `git status --porcelain` is empty.
3. **The counts settle it.** The gates measured `apps/web` on the SERVER at 26 files (T13), 28
   (T15) and 29 (T16). The contaminated tree yields 33 files with 2 failing — which is precisely
   what the reviewer's own reconstruction produced. Its reconstruction was accurate; its
   attribution was not.
4. T15's gate independently hit the same seven phantoms, found `git status --porcelain` empty and
   `find` empty **seconds later in the same batch**, re-pulled into a clean tree and md5-verified
   the sources. Two agents, same seven files, same session.

**The real cause is a defect in AGENT-RULES rule 22 itself.** 22(a) says put the mirror in *"your
session scratchpad directory"* — but every agent in a session **shares one scratchpad**. 22(b) says
author in the mirror. 22(f), amended 2026-08-20, says never delete it. Together: T14's coder
authored its mutants in the mirror (correctly), and `tar xzf -C <mirror>` for every later agent
extracts **over** that directory without removing files absent from the archive. So every agent
after the first inherits every earlier agent's local scratch, and rule 22(f) guarantees it persists.
The mirror mtimes confirm the sequence: T14's scratch at 23:02 IST, T15's `billing-session.test.tsx`
extracted into the same directory at 00:36 IST.

**This is the most serious process finding of the run**, because its failure mode is not a wasted
paragraph — it caused a careful reviewer to state, with executed evidence, that an agent had broken
a hard rule when that agent had not. A contaminated mirror makes every negative conclusion drawn
from it unsound.

### 3.5 The rest, in brief

- **`MoneyInput` flashes a money refusal on the decimal point.** `RUPEES = /^\d{1,13}(\.\d{1,2})?$/`
  rejects the intermediate `112.`, so every rupees-and-paise entry on every billing screen shows a
  red `role="alert"` for one keystroke and fires `onChange(undefined)`, dropping the amount out of
  the parent's form state mid-entry. All three of its tests type the complete string and assert only
  the settled state. The component's own docstring reasons about *"rewriting `112.` to `112.00`
  under the cashier's fingers"* — above a regex that rejects `112.` outright.
- **`paiseToRupeeText` is dead code and will misbehave when armed.** No caller passes a defined
  `value`; when one does, `paiseToRupeeText(-172000)` yields `"-1720.00"`, which `parseRupees`
  rejects — so the first seeded negative (T15's variance is the obvious candidate) produces a
  permanently-invalid field.
- **Flag ⑧ has no discharging assertion, and the deep link it describes does not exist.**
  `billing-counter.test.tsx` mocks `@tanstack/react-router` outright, so it proves the screen
  consumes whatever `useSearch` returns and nothing about `router.tsx:163`'s `validateSearch`.
  Worse, the producer is missing: no OPD screen references `/billing` at all, so D8's
  pay-before-consult loop has no navigation from the refusal to the counter. §3.30's class, second
  occurrence (Plan 07's flag ⑯ is identical).
- **K47 and flag ⑨ state the wrong body shape.** Both say `{ csv }`; the shipped server requires
  `{ csv, source }` (`recon.ts:122`, `z.enum(["upi","card"])`). T16 read the source rather than the
  prose and shipped correctly — a coder trusting the Assertion Book would have shipped a tab whose
  only write 400s every time, with a green suite behind it because the test stubs the path the
  screen calls. §3.37's class.
- **The "shared wire contract" is only T13's half.** Sixteen `Wire*` types live privately in the
  other three screens; `const POLL_MS = 15_000` is now declared eleven times.
- **The lift ADDED copies rather than replacing any** — authorised by self-review 17, except that
  `patient-picker.tsx` was NOT frozen (T13 rewrote 67 lines of it) and still keeps its private
  `useDebounced`. One of the four copies could have been collapsed at zero frozen-path cost.
- **README doc defect, shipped** (T16 gate finding 1): the new section says `/billing/office`
  writes through permissions *"none of which a cashier holds"*, contradicting README's own table 90
  lines above, which grants `billing.refund.request` and `billing.refund.pay` to cashier. Verified
  against the controller. The runbook tells the reader the opposite of the truth.
- **The reviewer disclosed a rule-2 slip of its own**: two read-only `git` commands against the
  owner's Windows checkout before switching to server-side git. Nothing was written. It is how it
  discovered the owner's checkout was two commits behind the host — which is itself the reason the
  rule is absolute.

---

## 4. Carried forward — put these in the next plan's briefs

Ordered by severity. Items 1–3 want an owner ruling before a live counter.

1. **BLOCKING: re-entrancy on every money button** (§3.1). One shared in-flight idiom across
   `submit-invoice`, `clear-submit`, take/apply-advance, `open-submit`, `close-submit`,
   confirm-close, `pay-submit`, `eie-confirm-submit`, recon upload. **Assert it with two synchronous
   clicks and a call count, not with a `disabled` attribute** — a disabled button proves the DOM,
   not the handler. Decide at the same time whether `POST /billing/invoices` and
   `POST /billing/receipts` should take an idempotency key; a client guard does not survive a reload.

2. ~~**The cashier session screen re-posts a stale float, and the consequence is a lockout.**~~
   **FIXED — `80fa9a3`, on the owner's order, immediately after the pipeline. See §6.**
   `billing-session.tsx:195` renders `<MoneyInput id="open-float" onChange={setFloatPaise} />` with
   no `value` and no `key`; `floatPaise` (`:98`) is never reset in `land()`. `MoneyInput` seeds its
   text once in a `useState` initializer, and its own comment states the contract: *"Parents that
   need to reset remount with a `key`."* After a zero-variance close the field remounts EMPTY while
   the parent still holds the old value, the `undefined` guard at `:130` passes, and Open posts the
   previous float. Gate probe: `POST /billing/sessions bodies:
   ["{\"floatPaise\":100000}","{\"floatPaise\":100000}"]`, the second never typed. A float the
   cashier never entered anchors `expectedCashPaise` → manufactured variance → `billing_variance`
   approval → **cashier locked out of all counter work** (pipeline A carried item 18). One line
   fixes it. **No pipeline-C task's Files list contains `billing-session.tsx`.**

3. **`eie_advance_refunded` must render as a dead end in `billing-office.tsx`** (§3.3). Give the
   owning task its own `TERMINAL_CODES` set, a test driving a 409 carrying
   `{ wouldBeAdvancePaise, refundedPaise }`, and a not-over-broad companion proving an ordinary EIE
   refusal still leaves the lane open.

4. **`apps/core/test/opd-lifecycle.e2e.test.ts` makes `pnpm verify` AND CI non-deterministic for
   the last 30 minutes of every IST day.** Three legs fail at `test:245 expect(slot).toBeDefined()`;
   `bookAndCheckIn` needs a slot >20 min out and the day's last bookable slot is 23:50 IST — the
   suite's own docstring names the window. **Proof needs no interpretation: the docs-only commit
   `f76f82e`, which changed zero code, went CI RED** (run 32402284687), pushed 18:16:32Z = 23:46
   IST. Every other commit in this range was pushed outside the window and is green. §3.41's class,
   already shipped, in a file frozen to pipeline C. Fix: inject the clock (the plan's own Global
   Constraint). Until then, never read a red in that window as a task failure, and never push in it.

5. **The 15 s polling convention must be OWNED once, with teeth, at a level covering every screen**
   (§3.2). Either lift `POLL_MS` into one shared module and assert its consumption once, or make
   "this screen's polled reads carry the interval" a per-screen criterion **with a mutant**.
   Repeating a convention in N briefs produces N implementations and zero tests — §3.34, now with a
   second specimen one plan later.

6. **Add a vitest `exclude` for mutant scratch.** `apps/web/vite.config.ts` declares no
   `test.include`, so the default pattern collects `*.mutant.test.tsx` and `*.control.test.tsx`.
   Excluding `**/*.mutant.*` and `**/*.control.*` makes the leftover-scratch class structurally
   impossible instead of depending on every agent's finish block. A belt, **not** a replacement for
   §5 step 0.

7. **`MoneyInput` needs two fixes before the next money screen mounts it** (§3.5). (a) Accept the
   trailing-dot intermediate (`/^\d{1,13}(\.\d{0,2})?$/`) — assert keystroke-by-keystroke, which is
   why three existing tests miss it. (b) Either make `value` genuinely controlled or delete it and
   `paiseToRupeeText`.

8. **A surviving unprompted mutant on the plan's most load-bearing money assertion.** K41's fixture
   separates "posts the typed allocation" from "posts the invoice outstanding" (W-5 dies) but NOT
   from "posts the TENDER TOTAL" — that mutation SURVIVED, because in both legs the typed amount
   equals the tender sum (300/300, 800/800). Since `TenderEditor` deliberately permits
   over-tendering, a cashier taking ₹500 for a ₹300 partial clear would allocate ₹500 under that
   mutation. **One extra keystroke closes it**: tender ₹500 while typing ₹300. §3.44's class.

9. **The PAN projection has no test teeth.** `toReceiptRow` is asserted only by
   `expect(queryByText(/ABCDE1234F/)).toBeNull()`; replacing the five-field projection with
   `return { ...row }` still passes, because nothing on the screen renders arbitrary fields. Assert
   the parsed OBJECT, not the render.

10. **The cashier cannot search the service catalogue.** `GET /tariff/services` is guarded by
    `tariff.read` (`tariff.controller.ts:143`); README's role table and `seed-billing.ts` give the
    cashier fourteen `billing.*` permissions and no tariff permission. On a runbook-seeded
    deployment every "Add service" search 403s and only the pre-filled fee line can be billed.

11. **Correct the web count ladder before quoting it again.** T13's Files list wrongly called
    `apps/web/src/components/patient-picker.test.tsx` a **Create**; it was added in Plan 07
    (`26d7429`). True rungs are 26 → 27 → 28 → 29 files, not 27 → 30. Measured at `b9b75a7`:
    **29 files / 133 tests**. The +6 tests reconcile exactly and are honest overshoots the briefs'
    own criteria required. Under v2 the ladder is a sanity reference, yet T13–T16's per-task
    criteria still carried file/test pairs **none of them could satisfy**.

12. **Fix the stale CARRIED item 4 and the two criteria derived from it** (§5 item 2 below).

13. **Smaller, recorded so they are not re-found:** the `/tariff` dev-proxy line is still owed;
    no counter READ has an error surface (a 403 or `billing_not_configured` leaves the screen inert);
    D7's cash-law WARN never reaches the wire (`invoices.ts:478` ships only `outstanding_cap`);
    `GET /billing/refunds` and `listMismatches` are two more unpaginated routes, both polled every
    15 s, and `listMismatches` resolves patient names this screen never renders; the back-office
    digit shortcuts and Alt+B ship with zero tests; `lib/keyboard.tsx` has no test file at all;
    the refund affordance is an `<a href>` in a router app; the apply-advance `<select>` labels
    options with the receipt TOTAL, not its remainder; the clearance lane has no approval sub-lane;
    the session screen's `KNOWN_DENOMINATIONS_PAISE` is a hand transcription of `cash-math.ts` that
    nothing pins (the ₹2000 note being retired is the realistic breaker); README's `/billing/office`
    permission sentence is factually wrong.

**Plan-text corrections owed:** T13 step 3 item 6 (`credit_approval_required` carries no approval
id); T15 step 1 item 1 ("running collections by mode from `GET /billing/sessions/current`" is
unbuildable — the route returns no per-mode totals and the only source is manager-gated); T14's
cap-warn banner (unbuildable from `patientBalance`) and its PAID badge (unreachable — `listDues`
filters `outstandingPaise > 0`); K47 and flag ⑨ (`{ csv, source }`).

---

## 5. Method notes — v2's second run, and its first under the Workflow tool

**What worked.** All four tasks passed their opus gate on the first rung, which is now 26
consecutive tasks without a rejection. The gates are unambiguously earning their cost as
DISCOVERERS (§2.31): 13 + 10 + 16 + 10 = **49 findings across four tasks**, including four surviving
unprompted mutants, three executed latent defects and two plan defects — none of which failed a
task. Every gate rebuilt at least one mutant itself and chose the one whose survival would be least
visible, as instructed. The disclose-don't-work-around habit held on every task.

**The Workflow tool removed the injection point, and §2.16 recurred because of it.** T13's gate
warned, specifically and correctly, that `TenderEditor` takes a required `payablePaise` and that
T14's take-advance lane — which has no invoice — must not be built against `0`; it asked for that to
go into T14's brief. **It could not**: the brief was compiled hours earlier and T14's coder was
already running when the finding arrived. `billing-dues.tsx:522` now reads `payablePaise={0}`, so
every legitimate advance renders "Payable: ₹0.00 / Over by ₹\<the whole advance\>". Non-blocking
(`tender-editor.tsx` documents "OVER IS NOT AN ERROR") and no money is wrong, but it is a misleading
label on a money screen and nothing tests it.

In pipeline B the main session drove waves by hand with the Agent tool and **sat between them**, so
such a finding could have been consumed. Under the Workflow tool the waves run back-to-back
autonomously. **The finding was correct, specific, actionable, and arrived with no mechanism able to
absorb it.** This is §2.16's rule ("a recommendation is not a task") with a new and structural
cause. Options for the next compile: a between-wave hook that lets the main session amend the next
brief, or a standing instruction that a gate finding naming a later task is written to a file the
next coder is told to read.

**The mirror is not authoritative, and rule 22 needs amending** (§3.4). This produced a false
accusation of rule-breaking against a compliant agent. Minimum fix: give each agent a UNIQUE mirror
directory (`<SCRATCH>/mirror-<taskid>-<role>`), or, as T15's gate proposed, run
`git status --porcelain` on the server immediately after pulling and delete from the mirror anything
it does not know. Rule 22(d) guards the PUSH direction; nothing guards the PULL.

**Two acceptance criteria demanded a falsehood.** The shared CARRIED block states as item 4 that
`GET /billing/receipts` returns the raw row including `panNumber`, and as item 9, in the same brief,
that this was FIXED in `30a272d`. Item 9 is true — verified in `billing.controller.ts:444-469`,
which selects explicitly and returns `panCaptured: sql<boolean>(panNumber is not null)` with the
docstring *"the PAN is not even read out of the database."* T14's and T16's criteria nonetheless
required the report to *"RESTATE that the exposure is UNFIXED."* Both coders refused and both gates
upheld the refusal — the right outcome, paid for twice. **This is §2.38 exactly, in an artifact
whose own header comments cite §2.38**: the correction was ADDED as a new item instead of applied to
the old one and to the criteria derived from it.

**A criterion worded as an absolute nearly convicted a correct task.** T13's *"the opd-desk edit is
deletion-only (diff shows only removals)"* is not literally met — 4 removals, 3 additions — because
the docstring above the deleted line was rewritten. Leaving it would have made the comment FALSE
(it said "PatientPicker carries no such attribute", which that commit falsifies), i.e. §2.38's
failure mode. Both the main session and the discovery reviewer independently judged intent honoured.
**Write criteria against the property, not the diff shape** (§3.12's lesson, third occurrence).

**Cost.** 2.20M subagent tokens for four CRITICAL tasks with full opus gates and a discovery pass,
against pipeline B's comparable run. The mirror workflow held: the coders navigated locally and
used SSH for evidence only.

---

## 6. The session float fix (`80fa9a3`, 2026-08-21)

The owner ordered §4 item 2 fixed as soon as the pipeline finished. It went through CRITICAL-tier
discipline — fail-first quoted, mutants built as separate scratch files with a passing control,
every measurement on the build host — because that is what the method demands of a money path, and
because this defect reached the operator through a screen that four reviews had already passed.

### 6.1 What was wrong

`openForm` is rendered only while `live === null || live.status === "closing"`, so `MoneyInput`
unmounts for the life of an open drawer and remounts with an EMPTY box after the close — while
`floatPaise` survived in the parent, because `land()` reset `closeLane`, `counts`, `note` and
`closed` but not the float. Pressing Open without typing then posted a float the cashier never
entered. That float anchors `expectedCashPaise`, so her real drawer closes on a **manufactured
variance**, files a `billing_variance` approval, and locks her out of all counter work (pipeline A
carried item 18) — the same lockout shape `44c8b86` was written to remove.

### 6.2 Why the fix is two lines and not one

The invariant is **the float that gets POSTED is the float the cashier can SEE**, and it takes both
halves:

- `setFloatPaise(undefined)` in `land()` — the load-bearing half. Clears the value.
- `key={closed?.id ?? "new"}` on the `MoneyInput` — clears the VISIBLE box on the one transition
  where this form does **not** unmount: a drawer confirmed out of `closing`, because both branches
  of `live === null || live.status === "closing"` keep it mounted. `MoneyInput` seeds its text once
  in a `useState` initializer and its own docstring says parents needing a reset must remount with
  a `key`.

Without the second line the box would show the finished drawer's float while the value behind it
was already cleared — safe, but a money screen showing a number it will not post. **Each half has
its own killing assertion** (§6.3); a fix whose second line nothing tests is §3.34's defect.

### 6.3 Evidence (all on the build host, nothing taken on trust)

| step | result |
|---|---|
| fail-first, isolated, exit **VALUE** 1 from a file | `Tests 1 failed \| 6 skipped (7)` — and the DOM dump shows a second drawer **actually open at the stale ₹1,000 float** (`session-float ₹1,000.00`), not merely a missing element |
| **M1** — `setFloatPaise(undefined)` deleted (one line, `diff`-verified) | **DIED**, `Tests 2 failed \| 6 skipped (8)`, both legs at `Unable to find an element by: [data-testid="open-error"]` — it posted instead of refusing |
| **M2** — `key={closed?.id ?? "new"}` deleted (one line, `diff`-verified) | **DIED**, `Tests 1 failed \| 1 passed \| 6 skipped (8)`, at the assertion itself: `Expected the element to have value: <empty> / Received: 1000`. Only the confirm-close leg fails — exactly as predicted, since the other path unmounts anyway |
| **CONTROL** — byte-identical spec, import repointed at the shipped module | **PASS**, `Tests 2 passed \| 6 skipped (8)`, exit 0 |
| not-over-broad (§3.44) | a freshly typed float still opens the next drawer at the **NEW** figure (₹2,500, asserted on the posted body); the ordinary first open is unchanged |
| `pnpm verify` detached, exit **VALUE** from a file | **0** — apps/web **29 files / 135 tests** (+2), apps/core 118/755, contracts 3/7 |
| scratch | all five scratch files and ten log/exit files deleted with plain `rm -f`; `git status --porcelain` empty; `find` finds no residue |
| host content vs the tested tree | md5 identical after the pull — the committed bytes are the bytes that produced the evidence (the local checkout is CRLF via `core.autocrlf`, so every transfer was LF-normalised and checksummed both ways) |

### 6.4 Notes

- **The fixture separates what it claims to.** The second float (₹2,500) differs from the first
  (₹1,000), and the assertions are on the POSTED BODY and the POST COUNT — never on the rendered
  box, which is empty under the defect too. That emptiness is the whole trap: an assertion on the
  box alone would pass against the broken screen.
- **§2.35 again held.** Two mutants, two kills, one shared control, no ambiguity; both kills quote
  the assertion's own expected-vs-received rather than an exit code, and neither died at typecheck
  (§2.26).
- Carried item 4 (the IST wall-clock window) was respected: every run was taken at ~09:25 IST,
  nowhere near 23:30–00:00.
