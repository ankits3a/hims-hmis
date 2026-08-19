# Plan 08 pipeline A (T1–T6) — outcome notes

**Read this before compiling pipeline B.** The full gate report for Plan 08 lands at
`plan-08-gate-report.md` only after all three pipelines; this file is the interim record
pipeline B's compile depends on.

**Status: 6/6 done, every task on rung 1 — no retry, no escalation.**
Run 2 of pipeline A (run 1 halted at T1 on a plan defect; see §4 and EXECUTION-LESSONS §2.20).

| task | tier | commit | files | outcome |
|---|---|---|---|---|
| T1 schema + migrations 0011/0012 | opus | `e3d0093` | 13 | done, rung 1 |
| T2 money core + Fixture Book | opus | `c56d11e` | 17 | done, rung 1 |
| T3 series/config/events/approval types | sonnet | `597670b` | 12 | done, rung 1 |
| T4 cashier sessions | sonnet | `c70bbf5` | 6 | done, rung 1 |
| T5 issueInvoice + cash law | opus | `0a4e0ef` | 5 | done, rung 1 |
| T6 receipts/allocations/advances/EIE | opus | `a044ee1` | 4 | done, rung 1 |

**Cost:** 12 agents (6 coder + 6 gate), 2,452,674 subagent tokens, 920 tool calls, ~5h44m
wall clock. Budget was 2.2–2.6M — landed inside it. Run 1's wasted ~934k is *not* included.

---

## 1. Independent verification (main session, not agent self-report)

- **`pnpm verify` DETACHED, exit VALUE read from a file = 0.** `apps/core` **110 suites / 665
  tests**, `apps/web` 21 files / 80 tests (untouched), `packages/contracts` 3/7 (untouched).
  110/665 is exactly the recomputed ladder row for T6.
- **Per-commit `git show --stat` against each task's Files list:** every commit's file set is
  inside its list. Two tasks touched *fewer* files than listed — see §3.1.
- **Frozen-path audit over `4eea5cc..a044ee1`:** CLEAN. Nothing under `apps/web/`,
  `packages/contracts/`, `.github/`, `modules/tariff|patients|opd/`, `kernel/realtime/`,
  `app.module.ts`, `jest.config.cjs`, `tsconfig*`, `.env*`, or `pnpm-lock.yaml`. The only
  `kernel/` touches are the three permitted files: `schema/billing.ts`, `schema/billing.test.ts`,
  `schema/index.ts` (+1 line).
- **CI by SHA:** all six commits `completed/success`.
- **Server tree clean**; `stash@{0}` (run 1's overruled db.ts edit) untouched and unpopped.
- **Ruling R5 implemented as specified:** the three `patients` FKs are present on
  `invoices`/`receipts`/`refund_vouchers`, and `truncateAll` still holds its original number of
  statements — the fourteen billing names went *into* the existing patients/OPD statement.
- **`apps/core/package.json`** gained exactly the two script lines; `pnpm-lock.yaml` unchanged.

## 2. Mutation evidence

Every required-DIED mutant the Assertion Book names for T1–T6 was built and died, and several
gates built **unprompted** mutants that strengthened rows the plan had marked weaker:

- **K4 correction independently confirmed.** The T1 gate built M-T1 itself and ran both legs:
  DIED 3/3 at the corrected instant `2026-03-31T18:30:00Z`; at the instant the *old* K4 row
  named, the mutant PASSES — the correction was necessary, not cosmetic.
- **K2 got a negative control nobody asked for.** The T1 gate proved the immutability
  assertions observe *the trigger* rather than a blanket refusal, by driving the identical
  drizzle UPDATE path against `receipt_tenders` (deliberately mutable) and reading back the
  new value — plus confirming `pg_trigger` holds exactly six non-internal triggers on exactly
  the six named tables.
- **K10 upgraded from *measure* to discriminating.** T3's gate built a series mutant the plan
  did not require, and it died.
- **K15 re-measured at a higher bar** than the coder's: 25 concurrent-open races, 25/25 one
  winner, raw `23505` correctly mapped to `session_already_open`, 0 anomalies.
- **§3.28 deepened by execution (T6, the run's sharpest finding).** The lock-observation leg's
  lock *mode* is load-bearing, not stylistic: rebuilt with the outside holder taking
  `select … for update` instead of the shipped `for no key update`, the leg stops
  discriminating against a serializer-less mutant. This is a new, concrete instance of the
  §3.21→§3.25→§3.28 family and is now EXECUTION-LESSONS §3.39.

## 3. Deviations, all disclosed and gate-ratified

### 3.1 The `settlement.ts` plan defect (hit twice, T5 and T6)

The plan assigns SQL readers (`outstandingOf`, `invoiceSettlement`, `advanceOf`) to
`settlement.ts` — but T2's shipped `billing-purity.test.ts` lists `settlement.ts` in
`PURE_FILES` and sweeps it for `from "../../kernel` and `await `. The two requirements are
mutually exclusive. Both coders reported it as a plan defect rather than relaxing the purity
test, kept `settlement.ts` byte-pure, and placed the readers in the files that own the rows:
`outstandingOf`/`invoiceSettlement` in `invoices.ts`, `advanceOf` in `receipts.ts`. Both gates
ratified. **Standing resolution for the rest of the plan: ledger readers live in the writer
file that owns their rows; `settlement.ts` stays pure.**

### 3.2 Other accepted deviations

- **T1** committed `drizzle/meta/0012_snapshot.json` — the `--custom` generator emits it, and
  the gate diffed it against `0011_snapshot.json` (id/prevId stripped): byte-identical, exactly
  what a schema-neutral migration produces. `0012` carries the house
  `--> statement-breakpoint` markers; that is the migrator's file *format*
  (`readMigrationFiles` splits only on it), not extra SQL — the SQL text is byte-identical to
  the plan's block.
- **T1** added a `patients` insert to `immutability.test.ts`'s `seedLedger` — a direct
  consequence of R5's FKs.
- **T5** reordered the credit gate before the invoice INSERT — forced, because
  `credit_extended`/`reason`/`approval_id` are columns on an immutable row.
- **T5**'s happy-path test uses three lines where the plan said two, and it is *strictly
  stronger*: line heads 2701 + 2702 = 5403 differs from **both** available invoice-level
  recomputes (8404 and 5404); the plan's two-line fixture would only have caught one shape.
- **T6**'s `advanceOf` implements D1's full three-term formula including the voucher
  subtraction, because T8's Files list cannot edit `receipts.ts` and omitting it would have
  left T8 structurally unable to enforce `refund_exceeds_advance`.

---

## 4. Carried forward into pipeline B — put these in the briefs

**Blocking / must be handled by a named task:**

1. **T11 (controller):** `updateBillingConfig` throws a raw `ZodError` with no billing error
   code, because T1's closed `BillingErrorCode` union has no `invalid_config` and `errors.ts`
   was outside T3's Files list. `PUT /billing/config` must either map it or T11 must extend the
   union. Decide in the brief, do not leave it to discovery.
2. **T11:** `BillingError`'s constructor ships `message` as optional with `super(message ?? code)`,
   so a code-only throw renders `message === code` in the ratified OPD-shaped body. Confirm the
   HTTP body is still `{ statusCode, message, code, detail? }` with a useful message.
3. **T11:** `confirmClose` performs **no actor check** — any actor may finalize a `closing`
   session once the variance approval is granted. Harmless while module-internal; the route
   must guard it.
4. **T11:** `listSessions` ships with **zero test coverage** and orders by `openedAt` alone
   (`cashier_sessions` has no `seq` column, so it cannot honour the global recency rule).
5. **T8 (refunds):** `advanceOf` is **not floored at zero** and `markEnteredInError` does not
   consider advance-refund vouchers already drawn against the receipt. D1's "never negative"
   is T8's `refund_exceeds_advance` to enforce.
6. **T8:** the exported `insertReceiptWithTenders` does **not** itself `assertPaise` tender
   amounts — the belt lives in `issueInvoice`'s boundary. Any new caller must carry its own.
7. **T10 (GSTR-1 / K35):** the discriminating fixture **already exists** — `b09` was built so
   the merged row's stored-head sum (1133 + 1133 = 2266) differs from a group-level recompute
   (`taxHead(37750, 1200)` = 2265). Use it; do not author a new one.

**Known-and-accepted, record in the brief so nobody "fixes" them:**

8. `creditShare` and `cash-math.ts` guard inputs with the **tariff** module's `assertPaise`, so
   a bad amount throws `TariffError("invalid_paise")` out of a billing entry point even though
   `BillingErrorCode` has its own `invalid_paise`. Inherited pattern, consistent across T2/T4.
9. `billing-purity.test.ts` is weaker than the shipped OPD purity test by exactly one token
   (`process.`), and its kernel-import check is **quote-style dependent** (greps
   `from "../../kernel`, double quotes only; nothing in `pnpm verify` enforces quote style).
10. `CASH_DENOMINATIONS_PAISE` is a hardcoded ten-entry list in `cash-math.ts`, not
    `billing_config` data. **T15's denomination grid must match it key-for-key.**
11. `listDues` with no `patientId` filter selects every invoice ever issued — no date window,
    no pagination, no SQL-side outstanding predicate — then filters in memory. Scale seam,
    fine at Phase-1 volumes, must not grow a UI that assumes pagination exists.
12. `episodeCashPaise` (C-2) has **no entered-in-error filter**: voiding a mis-keyed cash
    receipt does not restore that patient's §269ST headroom for the day. Counter-workflow
    surprise worth a UAT note.
13. T5's `cash_threshold.blocked` event is appended in a **second transaction** after the issue
    transaction rolls back (deliberate — an audit event that only survives when the money was
    accepted is no audit trail). Untested path.
14. T6's `markEnteredInError` computes its ordered-lock id list from a snapshot taken *before*
    the receipt row is locked; a concurrent `allocateReceipt` committing inside that window
    adds an allocation the mark will not reverse. Narrow, disclosed.

**Go-live items this pipeline created (for the gate report's carried list):**

15. `nextDocNo` pads to 6 digits unconditionally, so serial 1,000,000 in one FY renders a
    **17-character** doc number and silently breaches the GST 16-char ceiling. No runtime
    guard exists. Related: `seriesPrefixes` values are validated as `z.string().min(1)` with no
    maximum, so an admin patch to `{ invoice: "INVOICE" }` yields 20 chars and
    `validateBillingConfig` still returns ok.
16. **`validate:billing` returns `ok=true` on a config with `caSigned: false`** — observed live.
    D-17 presents the gate as the thing that blocks the first live invoice; today it does not
    check the CA signature. Either the gate gains the check or the runbook stops claiming it.
17. The `billing_variance` approval carries **no `amountPaise`** (the kernel requires
    `amountPaise > 0` plus `patientId|payeeId`; a session variance is signed and neither
    patient- nor payee-scoped). The variance value survives only in the event payload and the
    session row, not on the approvals row.
18. A cashier with **any** non-zero variance is locked out of all counter work until a
    `billing_manager` grants the approval — `beginClose` moves the session to `closing`,
    `requireOpenSession` accepts only `open`. Correct by design; an operational surprise that
    belongs in the runbook and in T15's screen copy.
19. The dev database `hmis_dev` now carries migrations 0011+0012 and a seeded `billing_config`
    row (applied by T3 through the shipped idempotent `pnpm db:migrate`; nothing was generated
    or abandoned, so halt condition 8 does not apply).

**Cosmetic, do NOT fix by rewriting history:** T5's commit carries a `Co-Authored-By` trailer
and T6's does not — each followed the commit line its brief gave it. Both are pushed.
