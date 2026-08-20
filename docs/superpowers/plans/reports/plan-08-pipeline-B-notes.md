# Plan 08 pipeline B (T7–T12) — outcome notes

**Result: 6/6 shipped.** The first pipeline run under [EXECUTE-METHOD v2](../../EXECUTE-METHOD.md).
Final commit `4329d93`. Measured at HEAD by the main session, detached, exit VALUE read from a
file: **apps/core 118 suites / 742 tests**, apps/web 21 files / 80 tests (untouched),
packages/contracts 3 suites / 7 tests (untouched). CI green.

| task | tier / model | commit | review |
|---|---|---|---|
| T7 credit notes | CRITICAL / opus | `b04ce1c` | opus gate |
| T8 refund vouchers | CRITICAL / opus | `6da4f8f` | opus gate |
| T9 recon + degraded mode | CRITICAL / sonnet | `1e04dc2` | opus gate |
| T10 consult gate, charge rules, daily close | CRITICAL / opus | `e4b2836` | opus gate |
| — | *main-session repair* | `d2d8371` | — |
| T11 module surface (31 routes) | ROUTINE / opus | `e705b06` | sonnet check |
| — | *main-session repair* | `d3074fa` | — |
| T12 lifecycle e2e, runbook | ROUTINE / sonnet | `4329d93` | sonnet check |
| all eight commits together | — | — | opus discovery review |

**The run was interrupted after wave 4** and resumed in a later session. The resume ran from a
copy of the compiled script with the shipped waves seeded as done and every brief, the ladder,
the review split and the discovery prompt byte-identical
([`pipelines/plan-08-pipeline-B.resume.js`](../../pipelines/plan-08-pipeline-B.resume.js), and
its own pre-flight, which passed with both negative controls observed failing). Nothing was
recompiled. On resuming, the first thing done was to establish ground truth from the host rather
than from any session's memory: T11 had not started — none of its five files existed — and the
only residue was one green baseline-check log.

---

## 1. Independent verification (main session, not agent self-report)

Every item EXECUTE-METHOD §5 requires, done by the session, not read off a report.

| check | result |
|---|---|
| detached `pnpm verify` at HEAD, exit VALUE from a file | **0** — 118/742, 21/80, 3/7 |
| per-commit `git show --stat` against each task's Files list | T7–T12 all exact |
| T10's OPD carve-out | exactly its four named files; no fifth OPD file |
| frozen-path audit over `a044ee1..4329d93` | **no frozen path touched** |
| third-migration halt condition | **zero** `drizzle/` changes in the whole range |
| CI green by SHA | green `d2d8371` → `4329d93` |
| server tree clean, `*.mutant.*` residue | clean; none |
| `stash@{0}` (obsolete, overruled design) | untouched, as instructed |

**CI was RED for T7–T10 and nobody noticed until this session.** `36592a6` — the pipeline's own
compile commit — added `plan-08-pipeline-B.preflight.js` under `docs/`, and `pnpm lint` failed
on it (`no-require-imports` ×2, `no-unused-vars` ×1). Every commit from `36592a6` through
`e4b2836` inherited that red. The shipped billing code was never the cause. `d2d8371` fixed it
by ignoring `docs/**`. Four tasks passed their gates while CI was red because **`gh` is not
installed on the build host and the repo is private**, so the CI item of the mechanical
checklist is unrunnable from where the pipeline runs. It was discharged this session from a
machine with `gh` authenticated. See EXECUTION-LESSONS §2.11.

---

## 2. The two main-session repair commits

Both are follow-up commits, never amends (rule 15 held). Both are disclosed in their own
messages. Neither is a precedent pipeline C may read as permission.

**`d2d8371` — greened the baseline.** Two defects predating T11, outside every task's Files
list. (a) the lint failure above. (b) `daily-close.test.ts` was **date-dependent**:
`issuePaidInvoice`/`issuePaidInvoiceByTender` called `issueInvoice` with three arguments, so
`now` defaulted to `new Date()` and the suite's pinned `DAY` was ignored — observed `2 failed /
6 passed` the morning after T10 shipped. T10 shipped a suite that was green only on the day it
was authored, and its opus gate did not catch it.

**`d3074fa` — the consult gate refuses with 409, the status D8 specifies.** **This was an
owner-ratified frozen-path exception, scoped to one line.** The plan's D8 (line 93) states the
gate throws `OpdError("consult_gate_refused")` **(409)**. T10 added the code to `OpdErrorCode`
but not to `OPD_CONFLICT_CODES` in `opd-masters.controller.ts:35`, so `opdStatus` fell through
to `return 400` — "your request was malformed" for what is a state conflict, and unlike every
sibling OPD refusal (`session_closed`, `slot_taken`, `not_your_patient`).

That file is byte-frozen for this pipeline and named in **no task's Files list — not T10's,
not T11's**. So no task could have fixed it and no retry could have either. T11 did exactly the
right thing: asserted the 400 it actually observed, recorded the gap in the suite, and carried
it forward instead of editing a frozen file. Its mechanical check then correctly failed the task
on the criterion as literally worded, with `retry_mode: verify-only` and corrections that said
in as many words that a T11 retry could not satisfy them. **The ladder was held rather than
advanced** — a rung whose only outcomes are "fail again" or "violate a frozen path" is not worth
spending — the owner ratified the exception, and the repair landed as its own commit. T12 was
then dispatched against the corrected behaviour and wrote its lifecycle story against 409.

---

## 3. The discovery review — what one pass over eight commits found

The per-pipeline discovery reviewer is EXECUTE-METHOD v2's replacement for per-task opus gates
on ROUTINE work. **On its first outing it paid for itself several times over**, with executed
evidence rather than hand-walks: two probes, one surviving mutant, and a re-derivation.

### 3.1 Money defects — both measured, both BLOCKING for pipeline C

> **STATUS: BOTH FIXED, 2026-08-20, on the owner's order to close them before pipeline C compiles.**
> `44c8b86` — the EIE guard and the session cash filter. `7769c4b` — the SECOND DOOR into (a),
> found by `44c8b86`'s own gate. Both shipped CRITICAL-tier with mutants, measured races and an
> independent gate; verify green at 118 suites / 750 tests. See section 6.

**(a) `advanceOf` can go NEGATIVE, and the next real advance silently absorbs it.**
`receipts.ts` + T8's vouchers + T11's `POST /billing/eie` route combine into a path nobody owns.
Executed probe: bank a 10,000p cash advance → issue an approved advance-refund voucher for the
full 10,000 (balance 0, correct) → mark the receipt entered-in-error. The receipt leaves the live
set but the voucher subtraction stands, so `advanceOf` returns **−10,000**, `patientBalance
.advancePaise` serves that verbatim over `GET /billing/patients/:id/balance`, and the patient's
next, unrelated **100,000p advance reads back as 90,000p**. The hospital keeps 10,000p of a
patient's money with no document naming it. Pipeline A carried this as item 5 and named
`refund_exceeds_advance` as T8's discharge; T8 discharged only the forward direction, and the
reverse was never disclosed as deferred.

**(b) Voiding a mis-keyed cash receipt manufactures a phantom variance and locks the cashier
out.** `dayBook` (T10) filters entered-in-error receipts — its own docstring says money never
really received cannot appear in the cash the drawer is reconciled against. `sumCashTendersPaise`
(T4) carries **no such filter**. Executed probe: open with a 100,000p float, take 50,000p cash,
mark that receipt entered-in-error. The drawer physically holds exactly 100,000p and the day book
agrees (cash 0) — but `beginClose` computes expected 150,000, reports a **−50,000 variance**,
moves the session to `closing` and files a `billing_variance` approval. Per pipeline A's item 18
the cashier is then locked out of all counter work until a `billing_manager` grants it. There are
now **three** readers of "cash taken" with three different EIE policies; only one was disclosed.

### 3.2 A dormant defect armed one pipeline ahead of where it will fire

`billing.module.ts`'s `feeGate` wrapper is the only thing keeping **seven shipped OPD tests**
green, for a reason that has nothing to do with OPD. `AppModule` imports `BillingModule`, whose
`OnModuleInit` registers the fee gate, so the gate is live in every suite that boots the app.
Neither OPD e2e suite seeds a `billing_config` row (grep returns nothing), yet between them they
drive `consult/start` seven times. They pass **only** because `loadBillingConfig` throws
`billing_not_configured` and the wrapper converts that one code to `{ ok: true }`. The moment any
later task seeds billing into an OPD fixture, seven OPD tests go red with a stack trace naming
OPD and a cause three commits earlier in billing. This is the Plan 07 T8→T9 shape exactly.

Also on that wrapper: `fee_unsettled` is pinned from both sides, but `fee_not_applicable` — the
only other reachable `BillingError` — has no test on the gate path, and a non-`BillingError`
would be rethrown into an OPD route as a 500, which the plan's own self-review item 5 says must
never happen.

### 3.3 A duplicate that disagrees, proven by a surviving mutant

`refunds.ts:225` carries a private `feeServiceIdFor` that **disagrees** with the canonical
`feeServiceFor` in `charge-rules.ts:31`: the canonical `switch` throws `fee_not_applicable` on an
unknown visit type; the copy silently treats it as `new`. T8 wrote the copy because its Files
list could not create `charge-rules.ts`; T10 shipped the canonical version afterwards and left
the copy standing. **Mutant M-D1** (a byte copy of `refunds.ts` with only the renewal branch
drifted) ran isolated against the shipped suite: `Tests: 14 passed, 14 total` — **SURVIVED
14/14**. Nothing anywhere drives a `renewal` encounter through `guardFlagsFor`, so guard 3 is
computed by an untested branch on every renewal-consultation refund. Pipeline A's accepted
duplication has become two, and the second was never disclosed.

### 3.4 A PAN exposure behind a permission the README hands to cashiers

`billing.controller.ts:413` (`GET /billing/receipts`) returns the **raw `receipts` row**, which
includes `panNumber` — the Rule 114B PAN captured above the ₹50,000 threshold. It is guarded by
`billing.invoice.read`, which the README's own role table grants to **both** cashier and
billing_manager, so every cashier can enumerate every patient's PAN with one unfiltered GET.
`GET /billing/refunds` similarly returns raw `payeeName`/`payeeIdType`/`payeeIdRef`, though at
least behind the manager-only `billing.reports.read`. Every service-layer reader on this surface
takes an actor and routes names through `getPatientSummaries`; these two take no actor and apply
no projection. `receiptList` is touched by nothing in the repo except the 403 sweep's path row —
no test ever reads its body.

### 3.5 The 403 sweep proves less than it is credited with

**Nothing in pipeline B binds a route to the *right* permission.** The sweep drives every route
with a user holding **no roles at all**, so a route decorated with any existing-but-wrong
permission answers 403 identically and passes. Every positive-path test uses one cashier granted
**all fourteen** billing permissions at once. So the route-to-permission map in `manifest.ts` and
the controller decorators is entirely unasserted — and it is exactly the assertion that would
have caught §3.4. Pipeline C's four screens are built directly on that unasserted map.

### 3.6 Two more, lower severity

- **Duplicate settlement refs silently reconcile one arbitrary tender.** `recon.ts:150`'s
  candidate query has no `ORDER BY` and no uniqueness guard, then takes `candidates[0]`;
  `ref_text` has no unique constraint. T9's `duplicate_ref` guard protects only within one CSV.
  Measured: two tenders share a ref, one is reconciled, the other stays `captured` forever,
  `unmatchedRefs` is **empty**, and no counter, event or worklist row records that a choice was
  made. The feature that makes hand-typed refs likely (degraded mode) shipped in the same commit.
- **`runDailyClose` reads its totals outside the claim transaction.** The day book and orphan
  scan are computed, then persisted inside an `ON CONFLICT DO NOTHING` claim. Anything committing
  in that window is permanently absent from the stored close and no re-run can repair it — the
  second run returns `claimed: false` with fresh totals it never writes. Harmless while the sweep
  is hand-invoked; a real window once Plan 11 schedules it on pg-boss.

### 3.7 The clearance-discount lane is dead by default, and the runbook does not say so

`credit-notes.ts:340` treats an absent `manualCaps[category]` as a cap of **zero**, so any
positive ask is refused `over_cap`. `seed-billing.ts` seeds **no** tariff adjustment-rule cap
rows at all — the `CAP-CHARITY` rule that makes T7's tests pass is seeded only by the test
helper. Fail-closed is the right default; shipping it undocumented in front of two pipeline-C
screens is not.

### 3.8 Threads the review closed rather than opened

**T12's correlationId fallbacks are correct, not a weakness.** The plan's Global Constraint says
`correlationId` is the invoice id "where one exists". Every emission site was checked: the three
movements that fall back (standalone advance, session lifecycle, recon) genuinely have no invoice
to name. The fallback assertions are exact ordered `toEqual` over the whole per-patient or
per-actor event list, not `arrayContaining`, so an extra, missing or reordered event fails. One
real residue: `advance.received` carries a correlationId from `issueInvoice` (overpayment
surplus) and none from `recordReceipt` (standalone) — same event name, two envelopes.

**The carried-forward ledger from pipeline A**, item by item: items 1, 2, 3 and 7 **discharged**
and asserted; item 4 (`listSessions`) **partially** — now exercised, but its ordering is asserted
nowhere, and T11 quietly promoted it to an authorization primitive (`requireOwnSession` does
`.some(s => s.id === sessionId)` over it), which is safe today but turns into a 403 on legitimate
old sessions the moment anyone adds a `LIMIT`; item 5 **not discharged** (§3.1a); item 6 fine —
every new caller routes through the boundary belt.

---

## 4. Carried forward into pipeline C — put these in the briefs

1. ~~**BLOCKING before any dues/advance screen ships.**~~ **FIXED — `44c8b86` + `7769c4b`** (see
   section 6). What T14 must still carry: `eie_advance_refunded` and `allocation_exceeds_advance`
   are **terminal refusals by design**. Once an advance-refund voucher has returned a receipt's
   money, that receipt can never be marked entered-in-error and its money can never be allocated.
   The screen must render both as a dead end with **no remedial action offered** — there is no
   correction path, deliberately, because a paid voucher is cash that physically left the drawer
   and cannot be un-paid. Both refusals answer 409 and carry
   `{ askedPaise?, wouldBeAdvancePaise, refundedPaise }`.
2. ~~**BLOCKING for T15 (cashier session screen).**~~ **FIXED — `44c8b86`.** `sumCashTendersPaise`
   now excludes entered-in-error receipts and agrees with `dayBook`. Nothing for the screen to
   warn about. Note the test that pins the agreement compares 0 to 0 (it discriminates the mutant,
   but does not prove agreement on a NON-ZERO figure) — if T15 touches that surface, strengthen it
   with a live cash receipt alongside the voided one.
3. **Permission binding.** Each brief must assert, for the routes its screen calls, that a user
   holding the *other* role's README grants is refused. Start with `GET /billing/receipts`
   (raw `panNumber` under a cashier-visible permission) and `GET /billing/refunds` (raw payee
   identity refs). Neither should reach a screen as a raw row.
4. **The clearance lane is dead by default** on a freshly seeded environment. Either add the
   missing runbook step or render `over_cap` as a configuration message, not a money refusal.
5. **Do not add a third copy of the fee branch.** There are two and they disagree (§3.3); read
   it over HTTP from `GET /billing/visits/:encounterId/fee-quote`.
6. **Known and accepted — do not "fix":** `GET /billing/receipts` and `GET /billing/sessions`
   have no date window and no pagination (same seam as `listDues`); `advance.received` has two
   envelope shapes; the back-office day-book screen should read `dayBook` live rather than the
   stored `daily_closes.totals` where it can.
7. **Compile-time tripwire:** every date-sensitive suite must thread the fixture's pinned `now`
   through the helpers rather than relying on `new Date()` — `d2d8371` exists because one did not.
8. **`d3074fa` is not a precedent.** It edited a byte-frozen OPD file as an owner-ratified,
   one-line, disclosed follow-up. Pipeline C briefs must not read it as permission to touch
   frozen OPD or web files.

---

## 5. Method notes — v2's first run

**What v2 got right.** The tiering call was honest: T11 and T12 were genuinely ROUTINE and the
sonnet mechanical checks caught what they were meant to (T11's check failed the task on a real
criterion, with a correction precise enough to identify that no retry could satisfy it). The
discovery reviewer found six things no per-task gate could have — every one of them cross-task —
and did it with probes and a mutant rather than assertions. The disclose-don't-work-around habit
held again: T11 refused to edit a frozen file and reported a plan defect instead, which is what
turned a silent 400 into a ratified one-line fix.

**What v2 got wrong, and it is in the template not the plan.** The mechanical-check prompt is
built from persona + task body + criteria + checklist and **carries no pointer to
AGENT-RULES.md**, unlike the coder and gate prompts. The pre-flight's shared-block assertion runs
over `coders.concat(gates)` — checks are excluded from that guarantee by construction, so it
could not have caught the omission. Observed consequence: T12's mechanical checker wrote its
scratch to **`/tmp` on the build host**, which rule 3 forbids absolutely. It cleaned up after
itself, and it was never told the rule. See EXECUTION-LESSONS §2.10.

**Harness friction worth recording.** The `Workflow` tool was blocked by the permission
classifier, so the waves were driven through the Agent tool with the rendered briefs passed by
file path — same briefs, same ladder, same review split, sequencing held by the main session.
Separately, **every agent was denied permission to delete its own local mirror** (`rm -rf`), and
so was the main session; four mirrors remain under the job's tmp directory. They are local
scratch, never git-operated, outside `/opt/hmis`, so no commit was contaminated — but rule 22(f)
is currently unsatisfiable on this host, and briefs should say so rather than making every agent
report the same denial.

---

## 6. The two money defects, fixed (2026-08-20)

The owner ordered §3.1's two defects fixed before pipeline C compiles. Both went through the
repo's own CRITICAL-tier discipline — mutants built as separate scratch files, measured races,
fail-first quoted, an independent opus gate — because that is what the method demands of money
arithmetic, and because the discovery review had already shown that hand-walking this code is how
the defects got here.

### 6.1 `44c8b86` — the EIE guard and the session cash filter

`markEnteredInError` now refuses with a new `eie_advance_refunded` when the mark would drive the
patient's advance below zero, under the same single ordered patient-wide receipt lock T8's advance
lane takes. `sumCashTendersPaise` excludes entered-in-error receipts via an inline `NOT EXISTS`
and now agrees with `dayBook`.

**`advanceOf` was deliberately NOT floored**, against the discovery review's own recommendation.
A floor is theatre: with `total(live)=0, refunded=10,000` it clamps −10,000 to 0, but the
patient's next 100,000p advance then computes `100,000 − 10,000 = 90,000`, which is positive, so
the floor never bites and **the absorption — the actual harm — survives untouched**. The guard
carries the fix and the reader stays honest. The reasoning is in the source docstring, not only
here.

**The brief was wrong about the lock, and the coder corrected it with evidence.** The brief
asserted the new patient-wide lock is what serializes the guard against the advance-refund lane.
It is not: the receipt being marked is always inside that lane's lock set, so the shipped
single-row `lockReceipt` already served that pair. The patient-wide statement is load-bearing
against **two concurrent marks on two DIFFERENT receipts of one patient**, where each mark locks a
different row and neither waits. The coder added that as a second race leg unprompted; under
shipped code it failed — 2 marks fulfilled instead of 1, advance −10,000. The defect had a second
manifestation the discovery review never reached.

### 6.2 `7769c4b` — the second door, found by the gate

**`44c8b86`'s gate went past its brief and reproduced the identical harm through a writer the
Files list never named.** `allocateReceipt` guards two things — the invoice's outstanding and the
receipt's unallocated remainder — and neither subtracts `advanceRefundedPaise`. Its probe, shipped
writers only, against the already-fixed commit:

```
bank 50,000p advance -> approved advance-refund voucher for the full 50,000 (advance correctly 0)
                    -> allocateReceipt that same receipt's 50,000 onto a dues invoice
OBSERVED: { afterAllocate: -50000, nextAdvance: 50000, servedAdvancePaise: 50000 }
```

This mattered immediately: the plan's Task 13 step 1 item (5) is *"apply advance: POST
/billing/receipts/:id/allocations from an EXISTING receipt row"* — pipeline C's first screen walks
straight through that door.

The follow-up added the same invariant at that door with a code of its own,
`allocation_exceeds_advance` — deliberately **not** a reused `over_allocation`, because two
mechanisms behind one signal is the non-discriminating-assertion class this project keeps finding
late, and because a caller that cannot tell "this bill has no room" from "this money already went
back to the patient" cannot tell the cashier what to do.

**The third writer is safe by construction, and that was proven rather than assumed.**
`issueInvoice`'s allocation (`invoices.ts:563`) applies a receipt `insertReceiptWithTenders`
created in the SAME transaction, and `allocatedPaise = Math.min(receiptTotal, netPayable)`, so its
net effect on the balance is `receiptTotal - allocated >= 0` — it can only RAISE an advance. That
is a stronger statement than "a new receipt carries no voucher", and it is asserted on the hardest
patient for it: one whose advance a voucher has already emptied to zero.

### 6.3 Verification (main session, independent)

| check | result |
|---|---|
| detached `pnpm verify` at `7769c4b`, exit VALUE from a file | **0** — apps/core 118/750, web 21/80, contracts 3/7 |
| `git show --stat` on both commits vs their Files lists | exact; 5 paths then 3 paths |
| frozen paths | none touched |
| migrations | none — both fixes are queries |
| `Math.max` floor anywhere in billing source | **none** (checked repo-wide, not just the diff) |
| shipped tests rewritten to match the fix | **none** — the 23 pre-existing tests in the touched suites pass unedited |
| CI | green at `44c8b86` |
| the amend the second coder disclosed | `4f72e98` is contained in no remote branch — unpublished history only, rule 15 held |

### 6.4 Nits recorded, not fixed

- The docstring above `allocateReceipt` calls the new check "THE THIRD GUARD ... `markEnteredInError`'s
  advance invariant at the OTHER door", which reads as though it describes the other function. The
  meaning is right and the code is right; the sentence is not worth a verify cycle on its own.
  Fold it into the next commit that touches the file.
- The §3.1(b) agreement test compares 0 to 0 (see §4 item 2).
