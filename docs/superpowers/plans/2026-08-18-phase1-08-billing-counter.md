# Phase 1 / Plan 08 — Billing Counter: Invoices, Tenders, Cashier Sessions, Refunds · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the money spine — the third domain module (`apps/core/src/modules/billing/`) and the third UI plan. Backend: immutable invoices persisted from Plan 06's `PricedLine[]` verbatim (line-head sums, never recomputed — stress-test §15), the **receipts + allocations ledger** (owner ruling 2026-08-18: dues and patient advances are ONE mechanism — append-only receipts carrying mixed tenders, append-only allocations receipt→invoice, settlement state DERIVED and never stored), credit notes with hand-derived partial-refund arithmetic (the pro-ration rule Plan 06 left to this plan), approval-gated refund vouchers with the four legacy refund guards in their 2026 renderings, cashier sessions with denomination close and SoD-guarded variance approval, C-2 cash-law thresholds as CA-gated config, degraded-tender mode (E-24), tender lifecycle states with statement-upload UPI reconciliation (E-25/26), the pay-before-consult gate wired into OPD via a registered guard (dependency-inverted, no module cycle), the daily close (day book + charge-orphan scan + GSTR-1 grouping from line heads), and the five Plan 04 approval consumers going live. Frontend: four keyboard-first screens — billing counter, dues & advances, cashier session, back office — plus the absorbed Plan 07 web debt (wedge-scanner QR lane, `fmtIst`/`useDebounced` lift, `data-search-input`, three unasserted properties).

**Architecture:** One new module folder, **two migrations, both in T1** (`0011_*` generated once via `db:generate`; `0012_billing_immutability` custom SQL for the BEFORE UPDATE/DELETE triggers — drizzle-kit cannot emit triggers, and grant-revocation would not bind because the app role owns its tables, so the trigger is the only *provable* structural immutability; this is a stated, owner-approved deviation from the one-generated-migration convention), fourteen tables in one self-contained truncate statement, zero new dependencies, zero env vars, ~20 event names. Pricing stays load → price purely → persist: `loadPricingContext(db)` outside the transaction (it takes `Db`, not `Tx` — §14.5), `priceInvoiceLines` pure, then ONE `withTx` that allocates document numbers, persists invoice + lines, records the receipt with its tenders, allocates, files/verifies approvals (all check-on-execute — the dispatcher stays unscheduled until Plan 11), and appends events. The pinned `tariff_version_id` is stamped on the invoice (supersession caveat documented). Settlement state is a pure function over allocations + credit notes; a `SELECT … FOR UPDATE` on the invoice row serializes concurrent allocations (locking an immutable row is legal — the trigger forbids UPDATE, not locks); advance-balance writes serialize on the patient's receipt rows locked in id order (the Plan 06.1 single-ordered-lock lesson). Every document series is per-fiscal-year (Apr–Mar IST) via a row-locked counter — GST needs consecutive serials ≤ 16 chars per FY, and `bigserial` cannot reset.

**Tech Stack:** Existing only — TypeScript strict, NestJS ^11, drizzle-orm ^0.40 / drizzle-kit ^0.30, zod ^4, pg ^8, Jest + ts-jest; React 19 + Vite 7 + Tailwind 4 + shadcn/ui + TanStack Router/Query + react-hook-form + i18next + Vitest. **Zero new dependencies in any workspace. Zero env vars. Zero CI edits.**

**Owner rulings folded in (2026-08-18, in-conversation):**
1. **Dues + advances = receipts & allocations** (one ledger instrument; partial settlement by construction; clearing dues needs no special permission — taking money is always safe; the two sensitive acts are issuing unpaid and shrinking the receivable).
2. **Credit extension = caps + approval above** (permission `billing.credit.extend`, mandatory reason, loud event; config per-invoice cap, Plan 04 approval `billing_credit_extension` (urgent) above it; per-patient outstanding cap config warn/block, default warn).
3. **All four refund guards, 2026 renderings** — refund ≤ money actually received (structural invariant); terminal-encounter refunds escalate to approval (never hard-blocked); delivered-lines-don't-refund generalization with `consultation.completed` as Phase 1's delivery signal; `reasonClass: mistake | genuine` + mandatory note verbatim.
4. **TCS/cess/RCM out with documented reasons** (TCS: §206C(1H) omitted by Finance Act 2025 — §19 CA gate confirms; cess: no hospital supply carries it — a future levy is a tariff-engine revision; RCM: inward-supply machinery, parked to procurement phase). **B2B = two nullable invoice columns now** (`buyer_gstin`, `buyer_legal_name`), e-invoicing/IRP deferred to the corporate phase.
5. **Counters use USB/Bluetooth keyboard-wedge scanners** — the PatientPicker QR lane gains a buffered-keystroke + Enter lane (T13).
6. Prior rulings this plan implements: `rounding_paise` column (2026-08-14) · `flat_paise` whole-line, pro-ration stated here (D4) · discount-at-clearance is a CREDIT NOTE on the adjustment side of §7's "the two never mix" seam, reusing the engine's `ManualCaps` (one discount-governance table in the hospital, not two).

**Ruling R5 (2026-08-19, after pipeline A's first run halted at T1).** The FKs `invoices.patient_id`, `receipts.patient_id` and `refund_vouchers.patient_id` → `patients.id` **STAY**. T1's original Step 5 was factually wrong about Postgres `TRUNCATE` (it checks FK constraint *existence*, not row counts or statement order), which made this plan's own Step 1 schema and Step 5 truncate shape mutually unsatisfiable — the contradiction cost ~934k tokens and delivered nothing. The resolution is to change the *truncate*, not the *schema*: the fourteen billing names go INTO the existing patients/OPD statement in `test/helpers/db.ts` (a modified statement, not an added one), and the "exactly one ADDED statement" wording is retired. **Rationale: database-level referential integrity on money documents outranks the cosmetic shape of a test-helper diff.** A billing document must not be able to name a patient id that never existed or was merged away — the alternative (plain-text `patient_id`, no FK) moves that guarantee into application code and into consuming tasks that T1 cannot test (EXECUTION-LESSONS §3.38). Affected rows corrected the same day: T1 Step 5, T1's Files list, T1's acceptance criteria, the "Additive-only" constraint, the DB-kernel consumed-surface bullet, Assertion Book K1 and K4, Self-review item 8, and the test-count ladder.

---

## Design (the decisions this plan makes — read before the tasks)

### D1. The ledger: receipts + allocations; settlement state DERIVED

- **`receipts`** are money in: header (patient, cashier session, PAN/Form-60, degraded flag) + child **`receipt_tenders`** rows (mode cash|upi|card, amount, ref, E-25 lifecycle state). A receipt taken against a bill and an "advance receipt" are the same row — the difference is allocation state.
- **`allocations`** are append-only rows `(receiptId, invoiceId, amountPaise > 0, kind 'apply' | 'reverse', reversalOfId?)`. Effective allocation = Σ apply − Σ reverse. Reversals reference the row they reverse; nothing is ever deleted or updated.
- **Settlement state** (`unpaid | partial | settled`) is computed by `settlementState(net, credited, allocated)` — pure — where `credited` = Σ non-EIE credit-note nets against the invoice and `allocated` = effective allocations. `outstanding = netPayable − credited − allocated`, floored at 0 for display; `settled ⇔ outstanding ≤ 0`. **No status column exists on `invoices`** — that is what keeps the immutability triggers total.
- **Advance balance**(patient) = Σ receipt totals − Σ effective allocations of those receipts − Σ advance-refund vouchers (issued or paid). Never negative: enforced under the ordered receipt-row lock (D6).
- **Concurrency:** allocation writes `SELECT id FROM invoices WHERE id = $1 FOR UPDATE` first (serializes per invoice; over-allocation is then a plain in-tx sum check → `over_allocation`). Advance-refund issue and allocation of advance receipts lock the patient's receipt rows `ORDER BY id FOR UPDATE` (single ordered lock — the 06.1 C1 lesson; never row-then-set).

### D2. Invoice issue is ONE transaction, and unsettled-without-credit cannot be persisted

`issueInvoice(db, actor, input, now?)`: input carries `patientId`, optional `encounterId`, optional `buyerGstin`/`buyerLegalName`, `lines: InvoiceLineInput[]`, `tags`, optional `receipt { tenders[], panNumber?, form60? }`, optional `credit { reason, approvalId? }`, and `discountApprovals: Record<lineId, approvalId>` for engine candidates with `requiresApproval`.

Order of operations (frozen; the Book pins it):
1. Outside any tx: resolve encounter (visit type / intendedPayer / fee branch — D8), `loadPricingContext(db, { at: now, tags })`, **`assertPaise` on every `manualDiscount.value`** (M3 — this plan is exactly the non-controller caller the stress test warned about), `priceInvoiceLines`, `totalInvoice` (D3).
2. `withTx`: allocate `invoiceNo` (D5) → verify every `requiresApproval` winner has a granted approval with matching subject + patient + amount (`discount_approval_missing` / `approval_subject_mismatch`) → insert invoice + lines (PricedLine persisted verbatim, `candidates` JSONB = the D-8 contest record) → if `receipt` present: `requireOpenSession(tx, actor)`, C-2 checks (D7), insert receipt + tenders + a single `apply` allocation of `min(receiptTotal, netPayable)` → compute remainder = netPayable − allocated.
3. **Remainder > 0 ⇒ the credit lane or a refusal.** No `credit` block ⇒ `unsettled_issue_refused`. With credit: `hasPermission(db, actor.id, "billing.credit.extend", "hospital")` required; remainder > `creditCapPaise` additionally requires a granted `billing_credit_extension` approval (subject-checked); outstanding-cap check (config warn ⇒ response flag, block ⇒ `outstanding_cap_exceeded`). Sets `credit_extended = true` + reason + approvalId on the invoice row at insert (immutable thereafter).
4. Events: `invoice.issued` always; `invoice.credit_extended` on the credit lane; `receipt.recorded` / `payment.received` (per apply allocation) / `advance.received` (receipt remainder left unallocated); `cash_threshold.warned/.blocked` as hit.
5. Receipt overpayment (tenders > netPayable) is NOT an error: the surplus stays unallocated on the receipt — it IS the change-due/advance lane; the response reports `unallocatedPaise` and the counter screen shows it as change or banked advance (cash change is normally handed back and the cashier enters net cash; the model does not force that workflow).

### D3. `totalInvoice` — sum the line heads; round once; group for GSTR-1 (pure)

```ts
export type TaxSummaryRow = { sacCode: string; rateBps: number; exempt: boolean; taxableBasePaise: number; cgstPaise: number; sgstPaise: number };
export type InvoiceTotals = {
  grossPaise: number; discountPaise: number; taxableBasePaise: number;
  cgstPaise: number; sgstPaise: number;               // Σ of line HEADS — never recomputed (§15.1/§15.2)
  taxableTurnoverPaise: number; exemptTurnoverPaise: number; // Rule 42/43 split (net of line discounts)
  taxSummary: TaxSummaryRow[];                        // grouped by (sacCode, rateBps, exempt), GSTR-1 grain
  rawTotalPaise: number;                              // Σ line netPaise
  netPayablePaise: number; roundingPaise: number;     // §170: roundTotalToRupee(rawTotal), applied ONCE
};
export function totalInvoice(lines: PricedLine[]): InvoiceTotals
```
Every field is a fold over `PricedLine` values already computed by the engine. The two §15 numbers are Book fixtures with named mutants (B-01, B-02). `roundTotalToRupee` is applied exactly once, to the invoice raw total — never per line, never on credit notes' internal arithmetic (a credit note gets its own single rounding of its own total, D4).

### D4. Credit notes and the partial-refund arithmetic (the rule Plan 06 left here)

- A credit note is the ONLY way an issued invoice's receivable shrinks. `kind: 'refund' | 'clearance_discount' | 'correction'`. Lines reference original `invoice_line_id`s with a `qty` (or a whole-line flag for correction).
- **Pro-ration is CUMULATIVE, derived from the stored line, never re-priced:** for a line with original qty *n*, after previously crediting qty *p*, a new credit of qty *k* takes, for each money field F ∈ {gross, discount, taxableBase, cgst, sgst}: `share = divHalfUp(F_orig × (p + k), n) − divHalfUp(F_orig × p, n)`. This is the **remainder-to-last invariant**: cumulative credits never exceed and exactly exhaust the line (naive per-refund `divHalfUp(F × k, n)` leaks paise — Book B-05's mutant). `flat_paise` discounts pro-rate identically (whole-line at pricing, share by qty on refund). Credit qty beyond remaining ⇒ `credit_exceeds_line`.
- `clearance_discount` (the legacy Dues Clear discount, on the adjustment side of the seam): carries a D-8 `discountCategory`, is cap-checked against the engine's own `ManualCaps` from `loadRuleConfig(db, at)` — `maxBps` of the ORIGINAL invoice's rawTotal, `over_cap` refused; above `approvalAboveBps` requires a granted `billing_clearance_discount` approval. One governance table for discounts, at-pricing and at-clearance alike.
- `correction` requires a granted `billing_refund`-family approval? No — corrections are `entered-in-error` grammar for invoices: a full-value credit note with `kind 'correction'` and a mandatory reason; permission `billing.credit_note.issue` + approval `billing_clearance_discount` NOT required (it prices nothing); the D-8 record is the original invoice's own contest. The Book pins that a correction must cover the FULL remaining value (partial "corrections" are refunds or clearance discounts by definition — `correction_must_exhaust`).
- Credit notes against money already received create refundable surplus (`credited + allocated > netPayable`) — the voucher path (D6) pays it out. Credit notes never touch allocations.

### D5. Document series — per-FY, row-locked, ≤ 16 chars

`document_series(series_key, fy, next_no)` PK `(series_key, fy)`; `nextDocNo(tx, seriesKey, prefix, at)` = `INSERT … ON CONFLICT DO NOTHING` then `UPDATE … SET next_no = next_no + 1 … RETURNING` (single-winner; the OPD token precedent). FY = Indian fiscal year of the IST date (Apr 1–Mar 31), rendered short: `INV/26-27/000001` (16 chars — the GST serial ceiling; a race test measures, tripwire 21). Four series: `INV`, `RCP`, `CN`, `RFV` (prefixes config).

### D6. Refund vouchers and the four guards

- Every voucher requires a **granted `billing_refund` approval** (spec §7: approval-gated always). `requestRefund` files it with the guard flags in the payload; `issueRefundVoucher` is check-on-execute (granted + subject match); `payRefundVoucher` is a single-winner `issued → paid` UPDATE, session-bound when method is cash, `bank_transfer` REQUIRED above `refundBankTransferAbovePaise` (never cash above it — `bank_transfer_required`).
- **Guard 1 (structural):** `kind 'invoice_refund'` draws on a credit note's surplus: Σ vouchers against the invoice ≤ Σ effective allocations (money actually received) — checked under the invoice-row lock; `refund_exceeds_received`. `kind 'advance_refund'` draws on the patient's advance balance under the ordered receipt lock; `refund_exceeds_advance`.
- **Guards 2+3 (flags, not blocks):** at request time compute `guardFlags`: `terminal_encounter` (the invoice's encounter status ∈ {completed, abandoned} via `getEncounter`) and `delivered_line` (any refunded line's service is the encounter's consult-fee service AND `consult_completed_at` is set). Flags ride the approval payload and the voucher row — the approver sees WHY it is escalated; nothing is auto-blocked.
- **Guard 4:** `reasonClass: 'mistake' | 'genuine'` + non-empty `reason` on every voucher (Plan 12's Fraud Sentinel dimension).
- Refund-to-payer (spec §7): `payeeName` + `payeeIdType/payeeIdRef` mandatory at pay time; signature is the printed voucher's ink line (print carries signed QR).

### D7. Cash law (C-2), degraded mode (E-24), tender lifecycle + recon (E-25/26)

- **C-2:** before accepting cash tenders: `episodeCashPaise = Σ cash tenders on the patient's receipts this IST day` (advances included — cash is cash). `+ incoming ≥ warn` ⇒ `cash_threshold.warned` + response flag; `≥ block` ⇒ `cash_threshold_blocked` refusal. `+ incoming > panThresholdPaise` ⇒ receipt must carry `panNumber` or `form60: true` (`pan_required`). All three thresholds CA-gated config, seeded warn ₹1,50,000 / block ₹2,00,000 / PAN ₹50,000 — **defaults are DATA the CA revises; nothing is a constant**.
- **Degraded mode (E-24):** `billing_config.degraded_tender` toggled by `PUT /billing/degraded` (`billing.degraded.toggle`, evented `degraded_mode.changed`). While on, UPI/card tenders require a manually-typed ref and the receipt is stamped `degraded: true`; recon prioritizes degraded receipts; the day book breaks them out.
- **Tender lifecycle (E-25):** `captured → reconciled | mismatched` (conditional UPDATEs — the two mutable columns in the module are tender state and voucher status). **Recon (E-26):** `POST /billing/recon/upload` takes CSV rows `{ ref, settledPaise, feePaise?, settledOn }`; match by ref against captured upi/card tenders; `expectedNetPaise = amount − divHalfUp(amount × feeBps[mode], 10000)` (feeBps config, UPI default 0, card default 150); |settled − expectedNet| ≤ tolerance config ⇒ `reconciled`, else `mismatched` + `tender.mismatched` + a mismatch row for the worklist. Unmatched refs are reported, never guessed. No PSP API — statement upload only, this plan.

### D8. The pay-before-consult gate and the fee branch

- **OPD-side hook (dependency-inverted, no cycle):** T10 makes the plan's ONLY edit to shipped OPD code — `consultation.ts` gains a keyed guard registry, checked in `startConsultation` after `requireTreatingDoctor`:
```ts
export type ConsultStartGuard = (db: Db | Tx, encounter: EncounterRow) => Promise<{ ok: true } | { ok: false; code: string; detail?: unknown }>;
export function registerConsultStartGuard(key: string, guard: ConsultStartGuard): () => void; // keyed ⇒ idempotent across test modules in one jest worker; returns unregister
```
A not-ok verdict throws `OpdError("consult_gate_refused")` (409) carrying the guard's `{ code, detail }` — OPD owns the error shape, billing supplies the data (the `AdjustmentSource`/E-32 hook pattern). OPD's own tests are untouched: no guard is registered unless billing's module init runs.
- **Billing's guard:** for encounters with `visit_type ≠ 'revisit'` (revisit is FREE — spec:224, Plan 07 owner decision) there must exist a non-EIE invoice for this encounter containing the mapped fee line that is **settled or credit-extended**; otherwise `{ ok: false, code: 'fee_unsettled' }`.
- **Fee branch:** `billing_config.charge_rules = { opdConsult: { new: serviceId, renewal: serviceId } }` (validated against `services` by `validate:billing`). `GET /billing/visits/:encounterId/fee-quote` returns the branch + a preview priced via `loadPricingContext` (pure, nothing persisted) — the counter screen's one-keystroke flow.
- **Orphan scan (§11.11):** inside `runDailyClose` — encounters opened that IST day (from `opd_encounters`, not the event log — same data, indexed) with `visit_type ≠ 'revisit'` and no non-EIE fee-line invoice ⇒ `charge.orphan_flagged` per hit. The safety net for the interactive counter; nothing auto-charges (the dispatcher is unscheduled until Plan 11, and money should never be minted by a sweep anyway).

### D9. Cashier sessions, variance, the daily close

- `openSession(db, actor, floatPaise)` — one open session per cashier (`session_already_open`); receipts and cash voucher payments require the ACTING cashier's open session (`no_open_session`).
- `beginClose(db, actor, { denominations, note? })`: `countedCashPaise` = Σ denomination × count (the JSONB is `{ "50000": 3, … }` paise-denomination → count); `expectedCashPaise = openingFloat + Σ cash tenders − Σ cash vouchers paid` in-session; `variancePaise = counted − expected`. Zero variance ⇒ `closed` directly. Non-zero ⇒ status `closing`, `variance.flagged`, and a `billing_variance` approval FILED BY THE CASHIER in the same tx — **so the kernel's `REQUESTER_APPROVER_PAIR` SoD makes variance-approver ≠ cashier structural, for free**; the Book pins the refusal.
- `confirmClose` — check-on-execute against the granted approval; single-winner `closing → closed`.
- `runDailyClose(db, day?)` — the module's ONE unscheduled sweep (the sixth; Plan 11 registers it): claims `daily_closes(day)` via `ON CONFLICT DO NOTHING` (idempotent — second run is a no-op), computes the day book (receipts by mode, invoices issued, credit notes, vouchers paid, degraded breakout), runs the orphan scan (D8), appends `day.closed` with totals. `GET /billing/day-book?day=` serves the same query live.

### D10. What this plan deliberately does NOT build (stated)

IGST / inter-state (Phase-1 exclusion, recorded) · e-invoicing / IRP (corporate phase; `buyer_gstin`/`buyer_legal_name` columns are the whole Phase-1 provision) · TCS / cess / RCM (owner ruling 4 — reasons in the header) · corporate/TPA contract billing (dues here are PATIENT dues) · PSP APIs (statement upload only) · dunning/collections beyond the dues worklist (D-33 deceased suppression is a DOCUMENTED SEAM — `patients` has no deceased column yet; the dues worklist notes the predicate for the plan that adds it) · accrual-ledger consumption of `payment.received` (Plan 09) · pg-boss registration (Plan 11) · deposit POLICY engine (IPD phase — the advance INSTRUMENT ships now; OPD→IPD carry-forward is a future allocation, no new machinery) · auto-charging consumers (charges are minted at the counter; the sweep only reports orphans) · `registerPatient`'s wall-clock `dob` defect (routed to a plan owning `modules/patients/` — NOT absorbed here).

---

## Consumed shipped surfaces (scout-verified against `/opt/hmis` at `c110b58`, 2026-08-18 — this session, transcribed from source)

- **Tariff module (`modules/tariff/index.ts` — byte-frozen this plan):** `priceInvoiceLines(ctx: PricingContext, lines: InvoiceLineInput[]): PricedLine[]` (`pricing.ts:8`, pure) · `loadPricingContext(db: Db, opts: { at: Date; tariffVersionId?: string; allowDraft?: boolean; tags?: string[] }): Promise<PricingContext>` (`context.ts:20` — Db, NOT Tx; explicit `tariffVersionId` wins and must be `activated` unless `allowDraft`) · `loadRuleConfig(db, at)` (`rules.ts:121` — the engine's OWN caps loader; the M1 lesson says never build caps from `listAdjustmentRules`) · money: `assertPaise(n, what)`, `divHalfUp(n, d)` (half-up, integer-only), `percentAmount(gross, bps)`, `taxHead(base, rateBps)` = `divHalfUp(base × rateBps, 20000)` (ONE head — cgst and sgst each), `roundTotalToRupee(totalPaise): { roundedPaise, roundingPaise }` (`money.ts`) · types: `PricedLine` (lineId, serviceId, serviceName, category, qty, unitPaise, grossPaise, regulatedClamp, candidates, winner, discountPaise, taxableBasePaise, gst { sacCode, rateBps, exempt, exemptReason, cgstPaise, sgstPaise }, netPaise), `InvoiceLineInput` (lineId, serviceId, qty, supplyContext?, manualDiscount?), `ManualDiscountInput`, `AdjustmentCandidate` (`requiresApproval: boolean` — "Plan 08 enforces against the approvals engine"), `ManualCaps` (`Partial<Record<DiscountCategory, { maxBps, approvalAboveBps }>>`), `DiscountCategory = "charity" | "scheme" | "negotiated_corporate" | "employee"`, `TariffError` / `TariffErrorCode` (`types.ts`, `errors.ts`). Golden harness precedent: `src/modules/tariff/golden/fixtures/g01…g14.json` + `golden.test.ts` (manifest of names, `workings` mandatory, schema-parsed at load).
- **OPD module (`modules/opd/index.ts`):** `getEncounter(db: Db | Tx, id): Promise<EncounterRow | null>` (`encounters.ts:126`) · `EncounterRow = typeof opdEncounters.$inferSelect` — columns this plan reads: `visitType 'new'|'revisit'|'renewal'` (`schema/opd.ts:192`), `intendedPayer 'self'|'tpa'|'pmjay'|'corporate'` (`:193`), `status`, `patientId`, `departmentId`, `doctorId`, `consultCompletedAt`, `openedAt` · `classifyVisit` (not needed — `visit_type` is stamped at open) · `loadOpdConfig(db | tx)` (`config.ts:90`) · `startConsultation(db, actor, encounterId, now?)` (`consultation.ts:69` — T10's guard lands after `requireTreatingDoctor(db, actor, current)` at `:74` and the `status !== "waiting"` check at `:75`) · `OpdError(code, msg)` + closed union `OpdErrorCode` (`errors.ts` — T10 adds `consult_gate_refused`) · events consumed by name only: `consultation.completed`.
- **Approvals kernel:** `requestApproval(tx: Tx, requester: Actor, input: ApprovalRequestInput): Promise<{ approvalId, instanceId }>` (`requests.ts:30` — runs on the CALLER'S tx, its docstring names Plan 08; `amountPaise` integer paise > 0 and needs `patientId|payeeId`; `actFirst` needs type capability + note) · `getApproval(db, approvalId): Promise<ApprovalRow | null>` (`worklist.ts:84` — `ApprovalRow = typeof approvals.$inferSelect`: `status 'pending'|'granted'|'rejected'`, `typeKey`, `subjectType`, `subjectId`, `patientId`, `amountPaise`) · `registerApprovalType(tx, spec: ApprovalTypeSpec)` (`types.ts:55` — go-live runbook data + test helper, the `tariff_revision`/`patient_merge` precedent) · `approveRequest/rejectRequest(db, actor, { approvalId, note })` (`decisions.ts:92/:96` — note REQUIRED; `REQUESTER_APPROVER_PAIR` SoD enforced in decisions) · `cumulativeAmount(tx, q)` + `istDayWindow(now)` (`cumulative.ts:18` — IST_UTC_OFFSET_MINUTES 330; C-12 report-only helper).
- **Auth/RBAC:** `RequirePermission(permission, scope)` / `CurrentActor()` decorators · `hasPermission(db, userId, permission, "hospital")` · e2e bootstrap = `createUser` + `createSession` + `createRole` + `grantPermissionToRole` + `assignRole` + `syncPermissions` (`test/patients.e2e.test.ts:49-68` precedent) · `seedSodPairs(db)` seeds `requester_approver`.
- **Events kernel:** `defineEvent(name, module, zodSchema)` → `.make({ actor, payload, patientId?, encounterId?, correlationId? })` · `appendEvent(tx, input)` · events table columns per `kernel/db/schema/events.ts`.
- **DB kernel:** `Db`, `Tx`, `withTx(db, fn)`, `createDb(url)` (`kernel/db/client.ts`) · schema barrel `kernel/db/schema/index.ts` (9 re-exports; T1 adds `./billing`) · `truncateAll` (`test/helpers/db.ts` — seven statements; **T1 MODIFIES the patients/OPD statement at `:64-69`, adding the fourteen billing table names to its list** — corrected 2026-08-19, ruling R5. `invoices`, `receipts` and `refund_vouchers` FK into `patients` (real FKs, kept), and `TRUNCATE` refuses whenever a constraint POINTS AT a target regardless of row counts or statement order, so a separate earlier statement does NOT satisfy Postgres — §3.12, re-proven by execution as §3.35. Everything else billing references is text — see T1 Step 5) · migration journal at idx 10 (`0010_silent_victor_mancha`), 11 applied; next generated tag is `0011_*`, then the custom `0012_billing_immutability` · precedents: `bigserial("seq", { mode: "number" })` non-PK (`tariff.ts:83`), partial `uniqueIndex().where(sql...)`, jsonb columns, `date(…, { mode: "string" })` round-trips `'YYYY-MM-DD'` (Plan 07 flag ① discharged).
- **Patients module:** `getPatientSummaries(db, actor, ids): Promise<PatientSummary[]>` (confidential-safe: `alias` + `restricted: true` when the caller may not see the name) · `resolvePatientId(db, id)` (merge-chain) · `PatientRow` has NO deceased column (verified — D-33 stays a seam) · `searchPatients` (the picker's existing backend).
- **Module framework & HTTP:** `ModuleManifest { key, title, menu, permissions, subscriptions: [] }` · `AppModule` installs manifests in `MODULE_REGISTRY` + imports the Nest module (`app.module.ts` — T11's two edits) · controller pattern = zod `parsed()`, `toHttp`, literal routes before `:id`, `@Controller("billing")` · **error body: the OPD convention `{ statusCode, message, code, detail? }`** (billing is a NEW module; the owner-ratified `code: message` prefix stays on patients/tariff — do not "align" either way, both are ratified) · unannotated POST returns 201 (Plan 07 E5); this plan annotates nothing.
- **Scripts:** `package.json` scripts block — T3 adds `seed:billing` + `validate:billing` lines (the `seed:opd` / `validate:tariff` precedents; tsx runner; error-exit convention per Plan 05).
- **Web scaffold:** `api<T>(method, path, body?)` (`lib/api.ts`) · `renderWithProviders`, `stubFetch(routes)` (`test-utils.tsx`; non-2xx = direct `vi.stubGlobal("fetch", …)`; `stubFetch` answers 200 — a screen must never branch on exact 2xx, §3.32) · `lib/opd-api.ts` exports `todayIst()`, `opdErrorMessage(e)`, `WireEncounter`, `WirePatientSummary` (billing screens import these, and T13 adds `lib/billing-api.ts` beside it) · `PatientPicker` (`components/patient-picker.tsx` — scan lane `onPaste` at `:98`, `data-search-input` applied from OUTSIDE by `opd-desk.tsx:259`, the wrapper T13 deletes) · `keyboard.tsx` (`[data-search-input]` focus at `:25`, global Alt shortcuts, `goUnregistered()` cast note) · router: code-based routes under the authed layout · locales `en.json`/`hi.json` + key-parity test · `.print-doc` isolation in `styles.css` · shadcn components present incl. table, tabs, dialog, select · vite proxy has `/opd` + `/ws` (billing rides `/billing` — T13 adds ONE proxy line).
- **Jest/vitest:** jest `testMatch` src+test, `testTimeout: 15000`; vitest confined to `apps/web`; fake-timer facts from Plan 07 §9 (waitFor cannot drive vitest fake timers; `vi.setSystemTime` without `useFakeTimers` pins Date; order `useRealTimers → useFakeTimers → setSystemTime`).

## Global Constraints (from spec v4.5 + roadmap standing rules + owner rulings 2026-08-18)

- TypeScript strict; no `any` anywhere.
- **Catalog discipline: exactly TWENTY names (D-Events below), all `module: "billing"`,** envelope via `defineEvent(...).make(...)` + `appendEvent`; `patientId` on every patient-scoped emission; `encounterId` whenever the document references one; `correlationId` = the invoice id on invoice-scoped emissions (receipt/allocation/credit-note/voucher events carry their invoice's id where one exists). Nothing else emits.
- **Module isolation (spec §4):** all billing code under `src/modules/billing/`; imports from `modules/tariff` and `modules/opd` ONLY through their `index.ts`; patients via `modules/patients/index`. **Billing reads no OPD or patient or tariff table directly — every cross-module read goes through exported functions.** The ONE OPD write-path edit is T10's guard hook (three OPD files, named exhaustively). Tests and AppModule import only `modules/billing/index`.
- **Additive-only over shipped code.** Files modified outside `modules/billing/`, exhaustively: `kernel/db/schema/index.ts` (one re-export, T1) · `test/helpers/db.ts` (ONE MODIFIED statement — the patients/OPD statement at `:64-69` gains the fourteen billing names; ruling R5, 2026-08-19) · `apps/core/package.json` (two script lines, T3) · `src/modules/opd/consultation.ts` + `src/modules/opd/errors.ts` + `src/modules/opd/index.ts` + `src/modules/opd/consultation.test.ts` (T10, the guard hook — exhaustive) · `src/app.module.ts` (T11) · root `README.md` (T12, T16). Every kernel folder byte-frozen; `modules/tariff/**` byte-frozen; `modules/patients/**` byte-frozen; `packages/contracts/**` byte-frozen; `.github/workflows/**` untouched (tripwire 10).
- **Migrations: exactly TWO, both in T1** — `0011_*` generated once via `db:generate` (never hand-edited, full output set in T1's Files list) and `0012_billing_immutability` created via `db:generate -- --custom --name billing_immutability` and hand-filled with ONLY the trigger function + six `CREATE TRIGGER` statements (D-Immutability). Any later schema need = CHAIN HALT + plan-defect report. No CHECK constraints. The custom migration is the plan's stated deviation from the one-migration convention, owner-approved with this plan.
- **Immutability is structural AND proven:** `billing_forbid_mutation()` raises on UPDATE or DELETE of `invoices`, `invoice_lines`, `credit_notes`, `credit_note_lines`, `receipts`, `allocations`. T1's tests EXECUTE an UPDATE and a DELETE against each protected table and assert the raise (six executed reds — never "the trigger exists"). Mutable columns in the module, exhaustively: `receipt_tenders.state/settledPaise/reconciledAt/mismatchNote`, `refund_vouchers.status/paidBy/paidAt/cashierSessionId`, `cashier_sessions.*` lifecycle columns, `document_series.next_no`, `billing_config.*`, `daily_closes` claim row. Everything else is INSERT-only.
- **No new env vars, no new dependencies.** Every threshold is `billing_config` DATA with `ca_signed` (D-17 pattern): C-2 warn/block/PAN, refund bank threshold, credit cap, outstanding cap + mode, fee bps by mode, recon tolerance, series prefixes, charge rules. A missing config row hard-fails every billing write with `billing_not_configured`; `validate:billing` (T3) is the go-live gate and builds its view from the SAME loaders the runtime uses (the M1 lesson).
- **Money is integer paise (`bigint` mode number) everywhere;** `assertPaise` at the module boundary on every externally-supplied amount (tender amounts, discount values, float, denominations, credit-note asks, voucher amounts); all arithmetic through `divHalfUp` — a grep for `Math.round|toFixed|parseFloat|\* 0\.` over `modules/billing` returns nothing (T2's purity+float test).
- **Sum line heads; never recompute.** `totalInvoice` folds `PricedLine` values; no code path applies `taxHead`/`percentAmount` to an invoice-level base except `roundTotalToRupee` on the raw total (B-01/B-02 pin it). Credit-note arithmetic derives from STORED lines (D4), never re-prices.
- **`newId()` is never an ordering key** (ledger §3.26): every table that needs arrival order carries `seq bigserial`; recency = timestamps + `seq` tie-break.
- **Single-winner discipline:** series counters (`UPDATE … RETURNING`), voucher pay, session transitions, tender state moves are conditional UPDATEs; allocation/advance writes serialize on ordered row locks (D1); race tests enumerate loser codes and are MEASURED (tripwire 21; §3.22 — race budgets are measured, not predicted; §3.28 — lock-observation tests hold a row OUTSIDE the target's own write path).
- **Pure cores, purity-grepped:** `totals.ts`, `credit-share.ts`, `settlement.ts` (the state fn), `fy.ts`, `cash-math.ts` (denominations) import nothing from `kernel/`, never await, never read a clock (T2 extends the purity test).
- **IST is the hospital clock;** FY per D5; every clock-reading service takes `now: Date = new Date()`.
- **Fail-first discipline (§3.5/§3.23):** every backend task's failing tests precede implementation and compile against unmodified shipped code (steps name the deployed subset where needed); T12's lifecycle e2e is red at 404 before T11? No — T11 ships the controllers; T11's OWN e2e is written red-first at 404 within T11; T12 extends over shipped surface and owes no red (stated). Fail-first evidence is owed by the ORIGINAL attempt (§2.3); every fail-first criterion carries the §2.8 fallback.
- **Two audits + tripwire 21:** every fixture value hand-derived in this document; every Book row names its mutant; the shipping task BUILDS it as separate scratch (`*.mutant.ts` + self-contained spec), runs isolated, records DIED/SURVIVED with counts, deletes scratch before counts and commit; §2.12 branches apply verbatim.
- **Confidential/VIP:** dues/advances worklists render names via `getPatientSummaries` (alias + restricted when gated); printed money documents carry the name the summary returns; no billing surface orders or prioritizes on identity.
- **i18n:** every user-facing string through `t()` with en + hi; parity test green; printed invoice/receipt/voucher use `.print-doc`; every printed document carries a signed QR (`kernel/crypto` HMAC — payload `bil1.<docType>.<docId>.<sig>`, the Plan 05/07 pattern).
- Build/test on the server; briefs carry EXECUTION-LESSONS §1 tripwires 1–21 verbatim at top; baseline = previous task's commit (§2.6); per-suite counts measured before each compile beat this document (§2.9).

## File Structure (locked by this plan)

```
apps/core/
  src/kernel/db/schema/billing.ts                    T1  fourteen tables — the module's schema
  src/kernel/db/schema/index.ts                      T1  + export * from "./billing"
  drizzle/0011_<generated>.sql                       T1  generated once
  drizzle/0012_billing_immutability.sql              T1  custom SQL: trigger fn + six triggers (hand-filled, D-Immutability)
  drizzle/meta/0011_snapshot.json + _journal.json    T1  generator output (journal gains idx 11 and 12)
  test/helpers/db.ts                                 T1  ONE MODIFIED statement — the patients/OPD statement at :64-69 gains the fourteen billing names (R5)
  src/modules/billing/errors.ts                      T1  BillingError + closed BillingErrorCode union (every code T2–T12 throw)
  src/modules/billing/time.ts                        T1  pure: fyOf(at) → { fy: "2026-27", fyShort: "26-27" }, istDay(at)
  src/modules/billing/totals.ts                      T2  totalInvoice (pure, D3)
  src/modules/billing/credit-share.ts                T2  creditShare (pure, cumulative pro-ration, D4)
  src/modules/billing/settlement.ts                  T2  settlementState (pure) + outstandingOf/advanceOf (SQL readers, T6 fills)
  src/modules/billing/golden/fixtures/b01…b10.json   T2  the Billing Fixture Book (workings mandatory, manifest asserted)
  src/modules/billing/golden-billing.test.ts         T2  harness (tariff golden.test.ts pattern)
  src/modules/billing/series.ts                      T3  nextDocNo (per-FY row-locked counter, D5)
  src/modules/billing/config.ts                      T3  loadBillingConfig · updateBillingConfig · validateBillingConfig (D-17)
  src/modules/billing/events.ts                      T3  the 20 defineEvent calls
  src/modules/billing/approval-types.ts              T3  the five ApprovalTypeSpec constants + registerBillingApprovalTypes(tx)
  scripts/seed-billing.ts                            T3  config row + roles cashier/billing_manager + approval types — idempotent
  scripts/validate-billing-config.ts                 T3  the go-live gate (exit 1 on any error; M1 lesson: engine loaders only)
  test/helpers/billing.ts                            T3  seedBillingBase · mkCashier · openSessionFor · issuePaidInvoice (grows T4–T8)
  src/modules/billing/sessions.ts                    T4  openSession · requireOpenSession · beginClose · confirmClose · listSessions
  src/modules/billing/cash-math.ts                   T4  pure: denomination sum, expected-cash fold
  src/modules/billing/cash-law.ts                    T5  episodeCashPaise · assertCashAccepted (C-2, D7)
  src/modules/billing/invoices.ts                    T5  issueInvoice (D2) · getInvoice · listInvoices · previewInvoice (fee-quote core)
  src/modules/billing/receipts.ts                    T6  recordReceipt (advance lane) · allocateReceipt · reverseAllocation · patientBalance · listDues · markEnteredInError
  src/modules/billing/credit-notes.ts                T7  issueCreditNote (three kinds, D4) · listCreditNotes
  src/modules/billing/refunds.ts                     T8  requestRefund · issueRefundVoucher · payRefundVoucher · guardFlagsFor (D6)
  src/modules/billing/recon.ts                       T9  uploadSettlement (CSV parse + match, D7) · listMismatches · setDegraded
  src/modules/billing/charge-rules.ts                T10 feeServiceFor(encounter, config) · feeQuote (uses previewInvoice)
  src/modules/billing/gate.ts                        T10 the ConsultStartGuard billing registers (D8)
  src/modules/billing/daily-close.ts                 T10 runDailyClose · dayBook · gstr1Summary (D9)
  src/modules/opd/consultation.ts                    T10 guard registry + check in startConsultation (D8 — exhaustive OPD edit 1/3)
  src/modules/opd/errors.ts                          T10 + "consult_gate_refused" (edit 2/3)
  src/modules/opd/index.ts                           T10 + registerConsultStartGuard/ConsultStartGuard exports (edit 3/3)
  src/modules/opd/consultation.test.ts               T10 + three guard tests (the OPD-side contract)
  src/modules/billing/manifest.ts                    T11 billingManifest (permissions, menu)
  src/modules/billing/billing.module.ts              T11 Nest module + OnModuleInit gate registration
  src/modules/billing/billing.controller.ts          T11 the 31 routes (one controller — counter + back office)
  src/modules/billing/index.ts                       T11 THE cross-module interface
  src/app.module.ts                                  T11 billingManifest + BillingModule
  test/billing.e2e.test.ts                           T11 counter flow over HTTP (red-first at 404)
  test/billing-lifecycle.e2e.test.ts                 T12 dues → clear → advance → apply → refund → session close over HTTP
  (repo ROOT) README.md                              T12 (billing module + runbook) · T16 (web)

apps/web/
  vite.config.ts                                     T13 + "/billing" proxy line
  src/lib/format.ts (+ .test.ts)                     T13 fmtIst + fmtPaise (₹, Indian digit grouping) + useDebounced — the lift
  src/lib/billing-api.ts                             T13 wire types + fetchers for the four screens
  src/components/money-input.tsx (+ .test.tsx)       T13 paise-safe input (rupee display, integer paise value)
  src/components/tender-editor.tsx (+ .test.tsx)     T13 mixed-tender rows, mode/ref/amount, running sum vs payable
  src/components/patient-picker.tsx                  T13 wedge-scan lane + data-search-input ON the input (absorbed debt)
  src/screens/opd-desk.tsx                           T13 delete the setAttribute wrapper (absorbed debt)
  src/screens/billing-counter.tsx (+ .test.tsx)      T13 the flagship counter screen
  src/screens/billing-dues.tsx (+ .test.tsx)         T14 dues & advances (one ledger view)
  src/screens/billing-session.tsx (+ .test.tsx)      T15 open/close/denominations/variance
  src/screens/opd-consult.test.tsx                   T15 + Alt+K/S/Enter assertions (absorbed debt)
  src/screens/opd-vitals.test.tsx                    T15 fixture reorder: hidden row after the 3-year-old (absorbed debt)
  src/screens/billing-office.tsx (+ .test.tsx)       T16 refund/CN worklist · recon upload · day book · GSTR-1 view
  src/components/invoice-print.tsx (+ .test.tsx)     T13 printed invoice/receipt (.print-doc, signed QR)
  src/router.tsx · src/lib/keyboard.tsx · locales    T13–T16 (each task lists its edits)
```

**Fourteen tables (T1):** `billing_config` · `document_series` · `invoices` · `invoice_lines` · `credit_notes` · `credit_note_lines` · `receipts` · `receipt_tenders` · `allocations` · `refund_vouchers` · `cashier_sessions` · `entered_in_error_marks` · `recon_batches` · `daily_closes`.

**D-Events — the twenty names (all `module: "billing"`):** `invoice.issued` · `invoice.credit_extended` · `receipt.recorded` · `payment.received` (per apply-allocation — Plan 09's accrual grain) · `advance.received` · `allocation.reversed` · `credit_note.issued` · `refund_voucher.issued` · `payment.refunded` (voucher paid — spec §7's reversal signal) · `cashier_session.opened` · `cashier_session.closed` · `variance.flagged` · `cash_threshold.warned` · `cash_threshold.blocked` · `tender.reconciled` · `tender.mismatched` · `degraded_mode.changed` · `document.entered_in_error` · `charge.orphan_flagged` · `day.closed`.

**Not touched, deliberately:** every kernel folder (both T1 edits are the barrel + truncate lines) · `modules/tariff/**` · `modules/patients/**` · `modules/opd/**` except T10's four named files · `kernel/realtime/**` (billing screens POLL; no billing topics this plan — a deliberate scope line: money worklists refresh on the 15 s convention) · `qr.test.ts` · `jest.config.cjs` · `tsconfig*` · `.github/workflows/**` · `apps/web/src/components/ui/**` · the five Plan 05 screens (T13 touches `opd-desk.tsx` ONLY to delete the wrapper lines) · `packages/contracts/**`.

**Sequencing:** three pipelines, strictly sequential within each: **A = T1–T6** (schema/triggers → money core + Fixture Book → series/config/events/scripts → sessions → issue → receipts/allocations), **B = T7–T12** (credit notes → refunds → recon/degraded → gate + daily close → HTTP surface + e2e → lifecycle e2e + docs), **C = T13–T16** (counter + components + absorbed picker debt → dues & advances → session screen + absorbed assertions → back office + web docs). B consumes A's services; C consumes B's HTTP surface.

---

## Tasks

Sixteen tasks in three pipelines (A = T1–T6, B = T7–T12, C = T13–T16), ≤ 6 per Workflow, strictly sequential within each. Every brief carries EXECUTION-LESSONS §1 tripwires 1–21 verbatim at the top, the mutant-discipline block from Pipeline Notes, and the deviations-not-to-fix list.

---

### Task 1: Schema — fourteen tables, migrations 0011 + 0012 (immutability triggers), the truncate statement, errors, FY time  *(opus coder — the plan's only migrations)*

**Files:**
- Create: `src/kernel/db/schema/billing.ts`, `src/modules/billing/errors.ts`, `src/modules/billing/time.ts`, `src/modules/billing/time.test.ts`, `src/kernel/db/schema/billing.test.ts`, `src/modules/billing/immutability.test.ts`
- Create (generated): `drizzle/0011_*.sql`, `drizzle/meta/0011_snapshot.json`; (custom) `drizzle/0012_billing_immutability.sql` + its journal entry
- Modify: `src/kernel/db/schema/index.ts` (+ `export * from "./billing"`), `test/helpers/db.ts` (the EXISTING patients/OPD statement at `:64-69` gains the fourteen billing table names — a modified statement, not an added one; ruling R5)

- [ ] **Step 1: The schema.** `billing.ts` — fourteen tables, every money column `bigint(…, { mode: "number" })`, every id `text` from `newId()` at insert sites, `seq: bigserial(…, { mode: "number" })` on `invoices`, `receipts`, `allocations` (arrival order — never `ORDER BY id`):

```ts
export const billingConfig = pgTable("billing_config", {
  id: text("id").primaryKey(), // 'main'
  cashWarnPaise: bigint("cash_warn_paise", { mode: "number" }).notNull(),
  cashBlockPaise: bigint("cash_block_paise", { mode: "number" }).notNull(),
  panThresholdPaise: bigint("pan_threshold_paise", { mode: "number" }).notNull(),
  refundBankAbovePaise: bigint("refund_bank_above_paise", { mode: "number" }).notNull(),
  creditCapPaise: bigint("credit_cap_paise", { mode: "number" }).notNull(),
  outstandingCapPaise: bigint("outstanding_cap_paise", { mode: "number" }).notNull(),
  outstandingCapMode: text("outstanding_cap_mode").notNull().default("warn"), // 'off'|'warn'|'block'
  feeBps: jsonb("fee_bps").notNull(),               // { upi: 0, card: 150 } — E-26 expected-net
  reconTolerancePaise: bigint("recon_tolerance_paise", { mode: "number" }).notNull(),
  seriesPrefixes: jsonb("series_prefixes").notNull(), // { invoice:"INV", receipt:"RCP", creditNote:"CN", voucher:"RFV" }
  chargeRules: jsonb("charge_rules").notNull(),     // { opdConsult: { new: serviceId, renewal: serviceId } }
  degradedTender: boolean("degraded_tender").notNull().default(false),
  caSigned: boolean("ca_signed").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
export const documentSeries = pgTable("document_series", {
  seriesKey: text("series_key").notNull(), fy: text("fy").notNull(),
  nextNo: bigint("next_no", { mode: "number" }).notNull().default(1),
}, (t) => [primaryKey({ columns: [t.seriesKey, t.fy] })]);
export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(), invoiceNo: text("invoice_no").notNull().unique(),
  patientId: text("patient_id").notNull().references(() => patients.id),
  encounterId: text("encounter_id"),                 // plain text — no FK into OPD (house precedent)
  tariffVersionId: text("tariff_version_id").notNull(), // the pin (§14.5)
  intendedPayer: text("intended_payer").notNull().default("self"),
  buyerGstin: text("buyer_gstin"), buyerLegalName: text("buyer_legal_name"), // ruling 4
  grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
  discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
  taxableBasePaise: bigint("taxable_base_paise", { mode: "number" }).notNull(),
  cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),  // Σ line heads (§15)
  sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
  rawTotalPaise: bigint("raw_total_paise", { mode: "number" }).notNull(),
  roundingPaise: bigint("rounding_paise", { mode: "number" }).notNull(), // owner 2026-08-14
  netPayablePaise: bigint("net_payable_paise", { mode: "number" }).notNull(),
  creditExtended: boolean("credit_extended").notNull().default(false),
  creditReason: text("credit_reason"), creditApprovalId: text("credit_approval_id"),
  issuedBy: text("issued_by").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  serviceDay: date("service_day", { mode: "string" }).notNull(), // IST day — day book / orphan grain
  seq: bigserial("seq", { mode: "number" }),
});
export const invoiceLines = pgTable("invoice_lines", {
  id: text("id").primaryKey(), invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  lineNo: integer("line_no").notNull(),
  serviceId: text("service_id").notNull(), serviceName: text("service_name").notNull(), category: text("category").notNull(),
  qty: integer("qty").notNull(), unitPaise: bigint("unit_paise", { mode: "number" }).notNull(),
  grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
  regulatedClamp: jsonb("regulated_clamp"), candidates: jsonb("candidates").notNull(), winner: jsonb("winner"),
  discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
  taxableBasePaise: bigint("taxable_base_paise", { mode: "number" }).notNull(),
  sacCode: text("sac_code").notNull(), rateBps: integer("rate_bps").notNull(),
  exempt: boolean("exempt").notNull(), exemptReason: text("exempt_reason"),
  cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(), sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
  netPaise: bigint("net_paise", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("invoice_lines_invoice_line_no").on(t.invoiceId, t.lineNo)]);
```
  `credit_notes` (id, creditNoteNo unique, invoiceId FK→invoices, kind, discountCategory?, reason, approvalId?, issuedBy/issuedAt, the seven money columns of invoices incl. rounding + netPaise) · `credit_note_lines` (id, creditNoteId FK, invoiceLineId FK, qty, the five money shares) · `receipts` (id, receiptNo unique, patientId FK→patients, cashierSessionId FK→cashier_sessions, receivedBy/receivedAt, serviceDay date-string, totalPaise, panNumber?, form60 bool, degraded bool, note?, seq bigserial) · `receipt_tenders` (id, receiptId FK, mode, amountPaise, refText?, state default 'captured', expectedNetPaise?, settledPaise?, reconciledAt?, mismatchNote?) · `allocations` (id, receiptId FK, invoiceId FK, amountPaise, kind 'apply'|'reverse', reversalOfId?, reason?, actorId, at, seq bigserial) · `refund_vouchers` (id, voucherNo unique, patientId FK, kind, creditNoteId?, invoiceId?, amountPaise, method, payeeName?, payeeIdType?, payeeIdRef?, reasonClass, reason, guardFlags jsonb, approvalId notNull, status default 'issued', requestedBy/issuedAt, paidBy?/paidAt?, cashierSessionId?) · `cashier_sessions` (id, cashierUserId, status default 'open', openedAt, openingFloatPaise, denominations?, countedCashPaise?, expectedCashPaise?, variancePaise?, varianceApprovalId?, closeNote?, closedAt?; partial uniqueIndex `(cashier_user_id) WHERE status IN ('open','closing')` — one live session per cashier, the arbiter) · `entered_in_error_marks` (id, docType, docId, reason, markedBy, markedAt; uniqueIndex (docType, docId)) · `recon_batches` (id, uploadedBy/uploadedAt, source, rowsTotal, rowsMatched, rowsMismatched, rowsUnmatched) · `daily_closes` (day date-string PK, closedAt, totals jsonb).
- [ ] **Step 2: `errors.ts`** — `BillingError(code, message, detail?)` with the closed union: `billing_not_configured | invalid_paise | unsettled_issue_refused | credit_permission_required | credit_approval_required | outstanding_cap_exceeded | discount_approval_missing | approval_subject_mismatch | unknown_invoice | unknown_receipt | unknown_line | over_allocation | allocation_reversed_already | no_open_session | session_already_open | session_state_conflict | variance_approval_required | pan_required | cash_threshold_blocked | tender_ref_required | credit_exceeds_line | correction_must_exhaust | over_cap | clearance_approval_required | clearance_requires_outstanding | refund_exceeds_received | refund_exceeds_advance | bank_transfer_required | voucher_state_conflict | approval_not_granted | unknown_series | eie_already_marked | recon_parse_failed | unknown_encounter | fee_not_applicable | duplicate_ref`. `time.ts` — pure `fyOf(at)` (IST instant → FY label pair; Apr 1 boundary at IST midnight) + `istDay(at)` (the OPD `istDate` arithmetic, module-local copy — cross-module internals are not importable, noted).
- [ ] **Step 3: Fail-first (§3.23 subset deploy).** `time.test.ts` (4): Mar 31 23:59 IST → fy "2025-26"; Apr 1 00:00 IST → "2026-27" (both from UTC instants — hand-derived: `2026-03-31T18:29:59Z` is IST Mar 31 23:59:59; `2026-03-31T18:30:00Z` is Apr 1); fyShort "26-27"; istDay of `2026-08-31T18:30:00Z` = `"2026-09-01"`. `billing.test.ts` (8): the fourteen tables insert/select round-trips (spot: invoices money columns come back as numbers; jsonb candidates round-trips), the two partial/unique arbiters (one-live-session index: second open 23505; invoice_lines (invoiceId, lineNo) 23505), seq bigserials populate ascending, K1's truncate red (run FIRST with the patients/OPD statement at its SHIPPED content — every test dies at `beforeEach` with `cannot truncate a table referenced in a foreign key constraint`, because `invoices`/`receipts`/`refund_vouchers` reference `patients`; then add the fourteen names to that statement and go green). `immutability.test.ts` (8): for each of the six protected tables, an `UPDATE` raises with message containing `billing_immutable`; two `DELETE` samples (invoices, allocations) raise likewise — all eight EXECUTED, red before 0012 exists, green after.
- [ ] **Step 4: Generate.** `pnpm --filter @hmis/core db:generate` → `0011_*`; inspect: fourteen `CREATE TABLE`, the partial index predicate present (STOP if dropped — never hand-edit). Then `pnpm --filter @hmis/core db:generate -- --custom --name=billing_immutability` → empty `0012_billing_immutability.sql`; hand-fill EXACTLY:
```sql
CREATE FUNCTION billing_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing_immutable: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();
CREATE TRIGGER credit_notes_immutable BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();
CREATE TRIGGER credit_note_lines_immutable BEFORE UPDATE OR DELETE ON credit_note_lines FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();
CREATE TRIGGER allocations_immutable BEFORE UPDATE OR DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();
```
  (Flag ①: the `--custom` flow and the migrator applying hand SQL are verify-by-execution — the immutability suite going green through `migrate()` IS the discharge.)
- [ ] **Step 5: Truncate — ONE MODIFIED statement, corrected 2026-08-19 (owner ruling R5).** The fourteen billing table names are added **into the EXISTING patients/OPD statement** (`test/helpers/db.ts:64-69`, the one ending `… patients, registration_config`), immediately before `patient_merge_requests`. It is a **modified** statement, not an added one — the diff is one statement's table list growing by fourteen names.
  **Why the original Step 5 was wrong, proven by execution (EXECUTION-LESSONS §3.35):** this step previously specified a separate statement placed before the patients statement, on the rationale that "Postgres only requires FK-parents truncated in the same statement as their children when the PARENT is being truncated". That is false. `TRUNCATE` refuses whenever **any** table carries an FK constraint *pointing at* a truncate target, and it checks constraint **existence** — never row counts, never statement order. Measured on the build host: the separate billing statement ran first and truncated `invoices` successfully, and the very next statement (the shipped patients one) still failed with `cannot truncate a table referenced in a foreign key constraint`, detail `Table "invoices" references "patients"`. This is the identical fact §3.12 already records from Plan 04, paraphrased into its inverse here.
  **Do NOT resolve this by dropping the FKs.** Owner ruling R5 (2026-08-19) keeps `.references(() => patients.id)` on `invoices`, `receipts` and `refund_vouchers`: database-level referential integrity on money documents outranks the cosmetic "exactly one ADDED statement" shape this plan originally asked for. A billing document must not be able to reference a patient id that never existed or was merged away.
- [ ] **Step 6: Mutant.** M-T1 (`fyOf` computed from the UTC calendar date — the Mar 31 23:59 IST boundary test flips to "2026-27") → 3×, required DIED; scratch deleted.
- [ ] **Step 7: Run to pass.** Core **96 suites / 556 tests** (from 93/536: +time 4, +schema 8, +immutability 8 — one schema test is the K1 red converted). Verify green.
- [ ] **Step 8: Commit** — `feat(core): billing schema — fourteen tables, migrations 0011+0012 (immutability triggers), FY helpers, truncate group` → pull → push.

**Acceptance criteria:** 20/20 new tests + K1's executed red quoted; migrations exactly `0011_*` (generated, unedited) + `0012_billing_immutability.sql` (the six triggers, byte-matching the block above); all eight trigger raises EXECUTED; journal gains idx 11 AND 12; schema barrel +1 line; **`truncateAll`'s patients/OPD statement gains exactly the fourteen billing names and no statement is added or removed (R5)**; the three `.references(() => patients.id)` FKs present in the generated `0011`; **core 96/556** (the enumeration governs — 4 + 8 + 8 = 20 new tests across three new suites; the ladder's old 95/552 was arithmetically inconsistent with this task's own Step 3); verify green; clean tree.

---

### Task 2: The money core — `totalInvoice`, `creditShare`, `settlementState`, and the Billing Fixture Book  *(opus coder — the golden-authoring analog)*

**Files:**
- Create: `src/modules/billing/totals.ts`, `src/modules/billing/credit-share.ts`, `src/modules/billing/settlement.ts`, `src/modules/billing/totals.test.ts`, `src/modules/billing/credit-share.test.ts`, `src/modules/billing/golden/fixtures/b01…b10.json` (ten), `src/modules/billing/golden-billing.test.ts`, `src/modules/billing/billing-purity.test.ts`

- [ ] **Step 1: Fail-first.** `totals.test.ts` (10) and `credit-share.test.ts` (9) written against the signatures (red: module absent). Key hand-derived pins (each also a Fixture Book entry):
  - **B-01 (sum line heads — §15.1):** three lines, each taxableBase 18875, rate 1200. Per line `taxHead(18875,1200) = divHalfUp(22_650_000, 20000) = ⌊(45_300_000+20_000)/40_000⌋ = ⌊1133.0⌋ = 1133`. Totals pin `cgstPaise 3399` AND `sgstPaise 3399`. Mutant M-B01 (recompute one head from Σbase 56625: `taxHead(56625,1200) = ⌊(135_900_000+20_000)/40_000⌋ = ⌊3398.0⌋ = 3398`) → 3398 ≠ 3399 → DIED.
  - **B-02 (heads, never total-then-split — §15.2):** one line base 33333 rate 500. `taxHead = ⌊(33_333_000+20_000)/40_000⌋ = ⌊833.825⌋ = 833` per head; GST total pinned **1666**. Mutant M-B02 (`percentAmount(33333,500) = ⌊(33_333_000+10_000)/20_000⌋ = ⌊1667.15⌋ = 1667`, split 834/833) → DIED on both the head and the sum.
  - **B-03 (round once):** two lines net 5617 + 5616 = 11233 raw. `roundTotalToRupee(11233)` = `divHalfUp(11233,100)·100` = `⌊(22_466+100)/200⌋·100 = ⌊112.83⌋·100 = 11200`; `roundingPaise −33`, `netPayable 11200`. Mutant M-B03 (round per line then sum: 5600+5600 = 11200 — same! pick lines 5651+5582: per-line 5700+5600 = 11300 vs raw 11233 → once = 11200) → the discriminating pair is **5651/5582**; fixture uses it. (Authoring rule 2 applied: the first candidate pair was NON-discriminating; recorded so nobody "simplifies" it back.)
  - **Tax summary grouping:** two lines same (sacCode, rate, exempt) merge; a third differing only in `exempt` does not; turnover split nets discounts (exempt line gross 10000 − discount 1000 ⇒ exemptTurnover 9000).
  - **creditShare cumulative rule (B-05):** F=100, n=3: cum(1)=`divHalfUp(100,3)=33`; credit₂ = `divHalfUp(200,3)−33 = 67−33 = 34`; credit₃ = `100−67 = 33`; Σ=100 exact. Mutant M-B05 (per-refund `divHalfUp(100·k,3)` = 33 each, Σ=99) → the exhaustion test (Σ shares === original after full qty) → DIED.
  - **B-06 (full worked partial refund):** line qty 3, gross 10000, discount 1000, base 9000, rate 1200 ⇒ per head `taxHead(9000,1200) = ⌊(21_600_000+20_000)/40_000⌋ = 540`, net 10080. Refund qty 1: gross 3333, discount 333, base 3000, cgst `divHalfUp(540,3)=180`, sgst 180, net 3360. Refund qty 2 (cumulative): gross 6667−3333=3334, discount 667−333=334, base 3000, heads 360−180=180 each, net 3360; final qty-3 remainder nets 10080−3360−3360 = **3360**. Line exhausts exactly.
  - `settlementState`: (net 10000, credited 0, allocated 0) → unpaid; (…, allocated 4000) → partial, outstanding 6000; (credited 2000, allocated 8000) → settled; over-collection (allocated 11000) → settled, outstanding 0 (never negative).
- [ ] **Step 2: Implement** the three pure files. `creditShare(orig: { grossPaise, discountPaise, taxableBasePaise, cgstPaise, sgstPaise, qty }, prevQty, addQty)` returns the five shares via the cumulative rule; throws `credit_exceeds_line` when `prevQty + addQty > qty`; `assertPaise` on every input.
- [ ] **Step 3: The Fixture Book harness.** Ten fixtures `b01…b10` (B-01/02/03/05/06 above + b07 mixed-mode totals with exempt+taxable, b08 zero-discount identity `rawTotal = Σnet`, b09 GSTR-1 B2B grouping input (buyerGstin set — carried in fixture meta, asserted by T10's gstr1 test against the same fixture), b10 single-line rupee-exact total: rounding 0). JSON schema mirrors the tariff golden pattern: `{ name, workings (≥ 20 chars, the hand derivation), lines | creditSteps, expected }` — parsed with zod at load, count replaced by a NAME MANIFEST (the tariff §13 residual-gap lesson), every `expected` value from THIS document, never from running the code.
- [ ] **Step 4: Purity.** `billing-purity.test.ts` (2): the grep test over `totals.ts`, `credit-share.ts`, `settlement.ts`, `time.ts`, `cash-math.ts` (T4 adds it to the list — the file names an array the later task extends): no `kernel/` import, no `await`, no argless `new Date()`, no `Math.random`; float grep over ALL of `modules/billing/`: no `Math.round|toFixed|parseFloat|\* 0\.|z.coerce` (the tariff sweep pattern).
- [ ] **Step 5: Mutants** (scratch, isolated, delete before counts): M-B01, M-B02, M-B03, M-B05 as above — 3× each, required DIED.
- [ ] **Step 6: Run to pass.** Core **100 suites / 589 tests** (+10 +9 +12 +2). Verify.
- [ ] **Step 7: Commit** — `feat(core): billing money core — totalInvoice (line-head sums, GSTR-1 grouping, §170 single rounding), cumulative creditShare, settlementState; Billing Fixture Book b01–b10` → pull → push.

**Acceptance criteria:** 33/33 + red-first; every fixture value matches this document's derivations (gate re-derives B-01, B-03, B-06 by hand); manifest asserts the ten names; mutants M-B01/02/03/05 all DIED 3/3; purity + float greps green; core 100/589; verify green; clean.

---

### Task 3: Series, config + validate gate, events, approval types, seeds, the shared helper  *(sonnet coder)*

**Files:**
- Create: `src/modules/billing/series.ts` (+ `.test.ts`), `src/modules/billing/config.ts` (+ `.test.ts`), `src/modules/billing/events.ts` (+ `.test.ts`), `src/modules/billing/approval-types.ts` (+ `.test.ts`), `scripts/seed-billing.ts`, `scripts/validate-billing-config.ts`, `test/helpers/billing.ts`
- Modify: `apps/core/package.json` (two script lines: `seed:billing`, `validate:billing`)

- [ ] **Step 1: Fail-first tests** (red: modules absent): `series.test.ts` (7): sequential 1,2,3 within (key, fy); independence across keys and across FYs; format `INV/26-27/000001` (16 chars, zero-padded 6); rollover — `nextDocNo` at IST `2027-03-31T23:59` uses `26-27`, at `2027-04-01T00:00` starts `27-28` at 1 (instants hand-derived as in T1); **the race: 6 concurrent `nextDocNo` in separate txs → exactly {1..6}, no duplicate — MEASURED 10× isolated (tripwire 21/§3.22; the single-winner `UPDATE … RETURNING` is the structural defense; report the observed rate, do not engineer)**; unknown prefix config → `unknown_series`. `config.test.ts` (8): load hard-fails `billing_not_configured` on a missing row; round-trip; patch validates through the same schemas (bad `outstandingCapMode` refused); `validateBillingConfig` returns `ok:true` on the seeded config and one error each for: chargeRules serviceId absent from `services` · a fee-branch service that is INACTIVE · warn ≥ block (threshold inversion) · seriesPrefixes missing a key — **each check built on `loadBillingConfig` + tariff `listServices`, the SAME loaders the runtime uses (M1 lesson pinned by a test that breaks the config through the public API and watches the gate catch it)**. `events.test.ts` (2): exactly 20 defineEvent calls exported, all `module: "billing"`, every name in the D-Events list (manifest-style array assertion, not a count). `approval-types.test.ts` (2): `registerBillingApprovalTypes(tx)` registers the five (`billing_credit_extension` urgent · `billing_discount` routine · `billing_clearance_discount` routine · `billing_refund` urgent · `billing_variance` routine; approver role `billing_manager`; `actFirstAllowed: false` on all five), idempotent on second call.
- [ ] **Step 2: Implement.** `nextDocNo(tx, cfg, series, at)`: `INSERT … ON CONFLICT DO NOTHING` + `UPDATE … SET next_no = next_no + 1 WHERE series_key=$1 AND fy=$2 RETURNING next_no` → `${prefix}/${fyShort}/${String(n).padStart(6,"0")}`. Config loader/patcher (the OPD `loadOpdConfig`/`updateOpdConfig` shape); events per D-Events; approval types via kernel `registerApprovalType`.
- [ ] **Step 3: Scripts + helper.** `seed:billing` — config row (warn 15_000_000 / block 20_000_000 / PAN 5_000_000 / refund-bank 1_000_000 / credit cap 500_000 / outstanding cap 2_000_000 warn / feeBps `{upi:0,card:150}` / tolerance 100 / prefixes / chargeRules pointing at two seeded `OPD-CONSULT-NEW`, `OPD-CONSULT-RENEWAL` services it creates through the tariff API if absent), roles `cashier` + `billing_manager`, the five approval types — idempotent, run twice in the task and both outputs quoted (flag ②). `validate:billing` prints errors and exits 1 (D-17). `test/helpers/billing.ts`: `seedBillingBase(db)` (config + roles + types + a tariff context: one activated version with the two consult services + one generic service at 50000 paise, GST category exempt healthcare + one taxable 1200bps category — built through the tariff module's public API, the Plan 06 e2e registration pattern), `mkCashier(db, username)` (user + role + session token), `openSessionFor(db, cashier, floatPaise)` (direct once T4 lands — until then inserts the row, disclosed shaping).
- [ ] **Step 4: Run to pass.** Core **104 suites / 608 tests** (+7+8+2+2). Verify.
- [ ] **Step 5: Commit** — `feat(core): billing series (per-FY row-locked), config + validate:billing gate, 20-event catalog, five approval types, seed:billing, test helper` → pull → push.

**Acceptance criteria:** 19/19 + red-first; race measured 10× isolated with output-confirmed isolation; validate gate catches all four breaks THROUGH the runtime loaders; seed idempotency quoted twice; both package.json lines; core 104/608; verify green; clean.

---

### Task 4: Cashier sessions — open, require, denomination close, variance approval  *(sonnet coder)*

**Files:**
- Create: `src/modules/billing/sessions.ts` (+ `.test.ts`), `src/modules/billing/cash-math.ts` (+ `.test.ts`)
- Modify: `test/helpers/billing.ts` (`openSessionFor` goes real), `src/modules/billing/billing-purity.test.ts` (add `cash-math.ts` to the pure list)

- [ ] **Step 1: Fail-first.** `cash-math.test.ts` (4): denomination fold (`{ "50000": 3, "10000": 2, "500": 4 }` → 172000 — hand: 150000+20000+2000); rejects a non-integer count / unknown key / negative; empty = 0; assertPaise on outputs. `sessions.test.ts` (11): open emits `cashier_session.opened` + returns row; second open → `session_already_open` (the partial index arbiter — race MEASURED 5×: two concurrent opens, one 23505 mapped to the same code); `requireOpenSession` throws `no_open_session` for a user without one and returns the session for its owner; `beginClose` with zero variance → `closed` + `cashier_session.closed` (expected-cash fold: float 100000 + cash tenders 172000 − cash vouchers 0 = 272000 — receipts/tenders SHAPED by direct insert against T1 schema, disclosed, until T6 ships the real writer); non-zero variance → status `closing`, `variance.flagged` (payload `variancePaise` signed), a `billing_variance` approval filed with the CASHIER as requester, `varianceApprovalId` stored; `confirmClose` before grant → `approval_not_granted`; after `approveRequest` by a `billing_manager` → `closed`; **the cashier approving their OWN variance → the kernel's `sod_violation` (seeded `requester_approver` pair) — the SoD ruling made structural, asserted through the real kernel path**; `beginClose` on a `closing` session → `session_state_conflict` (single-winner conditional UPDATE); voucher outflow term covered in T8's suite (stated, not owed here).
- [ ] **Step 2: Implement** per D9. `expectedCash` reads this session's receipts' cash tenders and this session's cash-paid vouchers (the term is zero until T8 — the query is still written now, against T1 schema).
- [ ] **Step 3: Mutants:** M-S1 (variance approval filed with requester = a SYSTEM actor instead of the cashier — SoD test's refusal vanishes) → sessions SoD test → DIED; M-S2 (`beginClose` recomputes counted from denominations but IGNORES the stored expected — variance always 0 → straight to closed) → the non-zero-variance test → DIED. 3× each.
- [ ] **Step 4: Run to pass.** Core **106 suites / 623 tests** (+11+4). Verify.
- [ ] **Step 5: Commit** — `feat(core): cashier sessions — one-live arbiter, denomination close, SoD-guarded variance approval` → pull → push.

**Acceptance criteria:** 15/15 + red-first; the SoD refusal exercised through the kernel (not a local check); open race measured; mutants DIED 3/3; shaping disclosed; core 106/623; verify green; clean.

---

### Task 5: `issueInvoice` — the one-transaction issue, cash law, settlement readers  *(opus coder — the module's core transaction)*

**Files:**
- Create: `src/modules/billing/invoices.ts` (+ `.test.ts`), `src/modules/billing/cash-law.ts` (+ `.test.ts`)
- Modify: `src/modules/billing/settlement.ts` (add `outstandingOf(tx|db, invoiceId)`, `invoiceSettlement(db, invoiceId)` readers), `test/helpers/billing.ts` (`issuePaidInvoice`)

- [ ] **Step 1: Fail-first.** `cash-law.test.ts` (6): episode sum spans the patient's SAME-IST-DAY receipts (two receipts yesterday+today: only today counts — boundary instant hand-derived), advances INCLUDED; warn at `Σ+incoming ≥ warn` (14_999_999+1 boundary: incoming that lands exactly ON warn warns); block refusal `cash_threshold_blocked`; PAN: incoming pushing past 5_000_000 without pan/form60 → `pan_required`, with form60 passes; non-cash tenders never count. `invoices.test.ts` (15): (1) happy path — two lines through the REAL tariff context from `seedBillingBase`, full cash receipt: invoice row persists `totalInvoice` outputs verbatim + pinned `tariffVersionId` + serviceDay; lines persist `PricedLine` fields incl. `candidates` jsonb; allocation `apply` for netPayable; events `invoice.issued` + `receipt.recorded` + `payment.received` (correlationId = invoice id); (2) settlement reader says `settled`; (3) **no receipt + no credit → `unsettled_issue_refused`, NOTHING persisted** (tx atomicity asserted: zero invoices after); (4) partial receipt + credit lane: cashier WITHOUT `billing.credit.extend` → `credit_permission_required`; (5) with the permission and remainder ≤ cap: `credit_extended true`, reason stored, `invoice.credit_extended` emitted, state `partial`; (6) remainder > cap without approval → `credit_approval_required`; (7) with a granted `billing_credit_extension` approval (filed via `requestApproval` in the test, subject `{ type: "billing_credit", id: <the client-supplied draft id> }`) → issues; wrong-subject approval → `approval_subject_mismatch`; (8) outstanding-cap block mode: a patient already carrying dues past the cap → `outstanding_cap_exceeded`; warn mode → response `warnings: ["outstanding_cap"]`; (9) `requiresApproval` winner (manual discount above `approvalAboveBps` from the seeded caps) without `discountApprovals[lineId]` → `discount_approval_missing`; with a granted `billing_discount` approval whose `amountPaise` === the winner's → issues, contest recorded; (10) `assertPaise` belts: fractional `manualDiscount.value` → `invalid_paise` BEFORE any pricing (M3 pinned at OUR boundary); (11) overpayment: tenders 60000 on netPayable 50000 → allocation 50000, response `unallocatedPaise 10000`, `advance.received` emitted; (12) UPI tender without ref → `tender_ref_required`; (13) receipt requires MY open session (`no_open_session`); (14) `previewInvoice` returns totals + branch and persists NOTHING; (15) buyerGstin round-trips onto the row. Every expected money value in tests 1/5/11 is hand-derived in the test file's comments from the seeded tariff (service 50000, discount ask 10000 charity under cap 2500bps? — NO: 10000/50000 = 2000bps < 2500 cap, no approval; the test-9 ask is 20000 = 4000bps > approvalAboveBps 3000 — seed caps: charity maxBps 5000, approvalAboveBps 3000; all seeded in T3 and restated here).
- [ ] **Step 2: Implement** per D2's frozen order; `issueInvoice` composes `loadPricingContext` → belts → `priceInvoiceLines` → `totalInvoice` → `withTx`. The invoice-row `FOR UPDATE` lock is taken by ALLOCATION writers (T6) — issue inserts fresh rows and needs no lock; state it in a comment.
- [ ] **Step 3: Mutants:** M-I1 (skip the granted-approval subject check — test 7's wrong-subject leg) → DIED; M-I2 (compute invoice cgst as `taxHead(Σbase, rate)` — the B-01 class INSIDE persistence: test 1's row assertion) → DIED; M-I3 (credit lane skips `hasPermission`) → test 4 → DIED; M-I4 (C-2 counts non-cash tenders — cash-law test 6) → DIED. 3× each.
- [ ] **Step 4: Run to pass.** Core **108 suites / 644 tests** (+15+6). Verify.
- [ ] **Step 5: Commit** — `feat(core): issueInvoice — one-transaction issue with receipts, credit lane (caps+approval), discount approval check-on-execute, C-2 cash law, settlement readers` → pull → push.

**Acceptance criteria:** 21/21 + red-first; atomicity of test 3 asserted from row counts; all four mutants DIED 3/3; every money expectation hand-derived in comments; core 108/644; verify green; clean.

---

### Task 6: Receipts, allocations, advances, entered-in-error  *(opus coder — the ledger's concurrency core)*

**Files:**
- Create: `src/modules/billing/receipts.ts` (+ `.test.ts`), `src/modules/billing/allocations.test.ts`
- Modify: `src/modules/billing/settlement.ts` (`advanceOf(db|tx, patientId)`), `test/helpers/billing.ts`

- [ ] **Step 1: Fail-first.** `receipts.test.ts` (12): `recordReceipt` standalone (advance lane — no invoice): receipt + tenders persist, `receipt.recorded` + `advance.received`, C-2 checks apply (cash advance counts into the episode — asserted); session required; `patientBalance` = { advancePaise, outstandingPaise, dues: [...] } assembled from the readers; `listDues` returns unsettled invoices oldest-first by `seq` with outstanding amounts + a `restricted` name via `getPatientSummaries` (confidential patient fixture — alias rendered); `allocateReceipt` (dues clear): partial allowed, `payment.received` emitted per apply, over-allocation → `over_allocation`; allocating from a receipt with insufficient unallocated remainder → `over_allocation` (receipt side); `reverseAllocation` appends the reverse row + `allocation.reversed`, double-reverse → `allocation_reversed_already`; `markEnteredInError` on a receipt: reverses its live allocations in the SAME tx + `document.entered_in_error` + the mark row; second mark → `eie_already_marked`; EIE'd receipt's money leaves `advanceOf`/settlement (reader asserts both before/after). `allocations.test.ts` (9): **race 1 — two concurrent allocations of 6000 each against outstanding 10000: exactly one `over_allocation`, final allocated ≤ 10000 — MEASURED 10× isolated (the invoice-row `FOR UPDATE` serializes; §3.28: the lock row is the INVOICE — outside allocations' own insert path — so a lock-observation leg holds it from a raw client and watches the second tx block)**; race 2 — two concurrent advance-refund-sized allocations draining one receipt: one `over_allocation` (ordered receipt locks); cumulative math: three partial allocations then settlement `settled`; reversal restores `advanceOf`; allocation against an EIE receipt refused; allocation to a settled invoice → `over_allocation` (outstanding 0); `seq` ordering asserted (never id).
- [ ] **Step 2: Implement** per D1/D6-guard-1: allocation = `SELECT id FROM invoices WHERE id=$1 FOR UPDATE` → outstanding check → receipt remainder check under `SELECT id FROM receipts WHERE id=$1 FOR UPDATE` (single receipt — no multi-row order needed here; the PATIENT-level order lock lives in T8's advance refunds and is stated there) → insert.
- [ ] **Step 3: Mutants:** M-A1 (drop the invoice `FOR UPDATE` — race 1's lock-observation leg stops blocking; the outcome leg may still pass via re-check — the OBSERVATION leg is the discriminator, §3.28) → measured; M-A2 (EIE skips reversing allocations — settlement still counts the dead receipt) → the before/after reader test → DIED; M-A3 (`listDues` orders by id) → seeded out-of-order seq fixture → DIED. 3× each (M-A1 10×).
- [ ] **Step 4: Run to pass.** Core **110 suites / 665 tests** (+12+9). Verify. **Pipeline A ends here.**
- [ ] **Step 5: Commit** — `feat(core): receipts, allocations, advances, entered-in-error — the patient money ledger with measured serialization` → pull → push.

**Acceptance criteria:** 21/21 + red-first; both races measured 10× with output-confirmed isolation; the lock-observation leg holds the invoice row from a raw client; M-A1 observation discriminates; M-A2/A3 DIED 3/3; core 110/665; verify green; clean.

---

### Task 7: Credit notes — refunds' paper, clearance discount, correction  *(sonnet coder — pipeline B opens)*

**Files:**
- Create: `src/modules/billing/credit-notes.ts` (+ `.test.ts`)
- Modify: `test/helpers/billing.ts`

- [ ] **Step 1: Fail-first.** `credit-notes.test.ts` (12): (1) `kind 'refund'`, partial qty via `creditShare` — the B-06 worked numbers land as ROWS (gross 3333 / discount 333 / heads 180+180 / net 3360), CN totals get their OWN single `roundTotalToRupee`, `credit_note.issued` with correlationId = invoice id; (2) second partial then final — cumulative shares match B-06's 3334/3360 step and the line EXHAUSTS exactly (Σ CN nets = line net); (3) qty beyond remaining → `credit_exceeds_line`; (4) settlement: a settled invoice + full CN → refundable surplus visible (`credited + allocated − net`), reader asserted; (5) `kind 'clearance_discount'`: D-8 category mandatory; cap check vs the ENGINE's `loadRuleConfig` caps — ask ≤ maxBps of the invoice `rawTotalPaise` passes, over → `over_cap` recording the ASKED paise in the error detail (the M2 lesson); (6) above `approvalAboveBps` without approval → `clearance_approval_required`; with granted `billing_clearance_discount` (subject = invoice id) → issues; wrong subject → `approval_subject_mismatch`; (7) clearance discount reduces OUTSTANDING dues by definition — on a settled invoice it would be a disguised refund, so a clearance CN on an invoice with outstanding 0 → `clearance_requires_outstanding` (in T1's union), and a clearance ask beyond outstanding is capped-refused the same way; (8) `kind 'correction'` must exhaust the invoice's full remaining value — partial → `correction_must_exhaust`; (9) correction on a partially-refunded invoice covers the REMAINDER exactly; (10) CN against unknown invoice → `unknown_invoice`; (11) money asserted: `assertPaise` on the clearance ask; (12) events: exactly one `credit_note.issued` per CN (no double-emit — appended inside the same tx after the inserts).
- [ ] **Step 2: Implement.** Clearance caps: `loadRuleConfig(db, at)` → `manualCaps[category]`; percent of `rawTotalPaise` via `percentAmount`; approval check-on-execute (granted + typeKey + subject invoice id).
- [ ] **Step 3: Mutants:** M-C1 (per-refund shares instead of cumulative — test 2's exhaustion) → DIED; M-C2 (cap check reads `listAdjustmentRules` instead of `loadRuleConfig` — an INACTIVE cap row: the M1 shape; the fixture seeds an inactive charity cap row through the tariff API and the mutant honours it) → DIED; M-C3 (correction accepts partial) → test 8 → DIED. 3× each.
- [ ] **Step 4: Run to pass.** Core **111 suites / 677 tests** (+12). Verify.
- [ ] **Step 5: Commit** — `feat(core): credit notes — cumulative partial-refund arithmetic, clearance discount under the engine's own caps, exhausting corrections` → pull → push.

**Acceptance criteria:** 12/12 + red-first; B-06's numbers land verbatim as rows (gate re-derives); M-C1/2/3 DIED 3/3; the ASKED amount in `over_cap` detail; core 111/677; verify green; clean.

---

### Task 8: Refund vouchers — the four guards, approval-gated always, refund-to-payer  *(sonnet coder)*

**Files:**
- Create: `src/modules/billing/refunds.ts` (+ `.test.ts`)
- Modify: `test/helpers/billing.ts`

- [ ] **Step 1: Fail-first.** `refunds.test.ts` (12): (1) `requestRefund(db, actor, { kind: 'invoice_refund', creditNoteId, amountPaise, reasonClass, reason })` computes `guardFlagsFor` and files `billing_refund` with flags in the payload + `patientId` + `amountPaise` (C-12 aggregation feeds free) — approval row asserted; (2) `issueRefundVoucher` before grant → `approval_not_granted`; after grant → voucher row `issued`, `refund_voucher.issued`, guard flags stored; (3) **guard 1: voucher total against an invoice capped by money RECEIVED** — invoice net 50000, allocated 30000 (dues!), CN full: vouchers beyond 30000 → `refund_exceeds_received` (the legacy "refund inherits the bill's state", structural); (4) `kind 'advance_refund'` draws on `advanceOf` under the ordered receipt locks — beyond balance → `refund_exceeds_advance`; race: two concurrent advance refunds of 6000 against balance 10000 → exactly one `refund_exceeds_advance`, MEASURED 5× (the locks are `SELECT id FROM receipts WHERE patient_id=$1 ORDER BY id FOR UPDATE` — the single ordered lock, 06.1 C1's lesson cited in code comment); (5) guard flags: terminal encounter (completed fixture via the OPD helper) → `terminal_encounter` present; consult-fee line refunded after `consult_completed_at` → `delivered_line` present; a waiting encounter → both absent; (6) `reasonClass` outside the enum / empty reason → zod refusal at the boundary; (7) `payRefundVoucher`: method cash requires MY open session; `payment.refunded` emitted; single-winner `issued → paid` — double pay → `voucher_state_conflict`; (8) amount above `refundBankAbovePaise` with method cash/upi → `bank_transfer_required`; bank_transfer passes and needs `payeeName` + `payeeIdType/Ref` (refund-to-payer identity — zod-required at PAY time for every method); (9) session's expected-cash now subtracts cash vouchers (the T4 term goes live — close math asserted with one paid cash voucher); (10) voucher `amountPaise` runs `assertPaise` at the boundary (fractional → `invalid_paise`); (11) events correlationId = invoice id (or null for advance refunds — patientId carried); (12) approvals SoD: the requester paying… no — the REFUND approver ≠ requester comes free from the kernel; asserted once (requester tries to approve → `sod_violation`).
- [ ] **Step 2: Implement** per D6. `guardFlagsFor(db, invoiceId | creditNoteId)` reads the encounter through `getEncounter` (OPD index) — no OPD table reads.
- [ ] **Step 3: Mutants:** M-R1 (guard 1 compares against invoice NET instead of allocated — test 3: dues bill refunds full) → DIED; M-R2 (bank threshold checks `>` vs `≥`… no — M-R2: pay skips the threshold entirely — test 8) → DIED; M-R3 (guardFlags always `[]` — test 5) → DIED. 3× each; race measured 5×.
- [ ] **Step 4: Run to pass.** Core **112 suites / 689 tests** (+12). Verify.
- [ ] **Step 5: Commit** — `feat(core): refund vouchers — approval-gated always, refund≤received structural guard, terminal/delivered flags, refund-to-payer, bank threshold` → pull → push.

**Acceptance criteria:** 12/12 + red-first; guard-1 test built on a genuinely partially-paid (dues) invoice; advance race measured; M-R1/2/3 DIED 3/3; core 112/689; verify green; clean.

---

### Task 9: Tender lifecycle, degraded mode, statement-upload reconciliation  *(sonnet coder)*

**Files:**
- Create: `src/modules/billing/recon.ts` (+ `.test.ts`)
- Modify: `test/helpers/billing.ts`

- [ ] **Step 1: Fail-first.** `recon.test.ts` (9): (1) CSV parse — `ref,settledPaise,settledOn` with optional `feePaise`; malformed row → `recon_parse_failed` naming the line number, batch NOT persisted; (2) match by ref over CAPTURED upi/card tenders: settled within `reconTolerancePaise` of `expectedNetPaise` → `reconciled` + `tender.reconciled` + `reconciledAt`; (3) outside tolerance → `mismatched` + `tender.mismatched` + `mismatchNote` carrying both numbers; (4) `expectedNetPaise` stamped at CAPTURE time (T5 writes it): upi fee 0 ⇒ expected = amount; card 150bps on 50000 = `percentAmount(50000,150) = divHalfUp(7_500_000,10000) = 750` ⇒ expected 49250 (hand-derived); (5) unmatched statement refs land in the batch's `rowsUnmatched` and the response, never guessed onto a tender; (6) an already-`reconciled` tender is not re-matched (conditional UPDATE `WHERE state='captured'` — second upload idempotent); (7) `setDegraded(db, actor, on, reason)` flips config + `degraded_mode.changed`; while on, a receipt recorded through `recordReceipt` is stamped `degraded: true` (refText for upi/card is already unconditional — `tender_ref_required` — so the stamp is degraded's whole additional effect, asserted here where the flag lives); (8) `listMismatches` returns open mismatches with receipt/patient context; (9) duplicate ref within one upload → `duplicate_ref`.
- [ ] **Step 2: Implement.** Matching in one tx per batch; per-tender conditional UPDATEs; batch row persisted with counts.
- [ ] **Step 3: Mutants:** M-N1 (tolerance compare uses settled vs AMOUNT not expected-net — test 4's card case: 49250 settled on 50000 amount flips verdicts) → DIED; M-N2 (re-match overwrites reconciled — test 6) → DIED. 3× each.
- [ ] **Step 4: Run to pass.** Core **113 suites / 698 tests** (+9). Verify.
- [ ] **Step 5: Commit** — `feat(core): tender reconciliation — statement upload, expected-net matching, mismatch worklist; degraded-tender mode` → pull → push.

**Acceptance criteria:** 9/9 + red-first; expected-net hand-derivation in comments; M-N1/N2 DIED 3/3; core 113/698; verify green; clean.

---

### Task 10: The pay-before-consult gate (the OPD edit), charge rules, daily close + day book + GSTR-1  *(opus coder — the plan's only shipped-code edit)*

**Files:**
- Create: `src/modules/billing/gate.ts` (+ `.test.ts`), `src/modules/billing/charge-rules.ts` (+ `.test.ts`), `src/modules/billing/daily-close.ts` (+ `.test.ts`)
- Modify (exhaustive, the D8 hook): `src/modules/opd/consultation.ts`, `src/modules/opd/errors.ts` (+ `consult_gate_refused`), `src/modules/opd/index.ts` (+ 2 export lines), `src/modules/opd/consultation.test.ts` (+3 tests)

- [ ] **Step 1: The OPD side, red-first.** Three tests appended to `consultation.test.ts` (they compile against shipped code — the registry does not exist yet, so the suite is RED on the missing import, §3.23 noted): (1) with no guard registered, `startConsultation` behaves exactly as shipped (the regression pin — full happy path re-asserted); (2) a registered guard returning `{ ok: false, code: "x", detail: { y: 1 } }` → `OpdError` `consult_gate_refused` and the encounter stays `waiting` (nothing moved); (3) re-registering under the same key REPLACES (idempotent across jest workers/testing modules), and the returned unregister fn restores pass-through. Then the implementation:
```ts
export type ConsultStartGuard = (db: Db | Tx, encounter: EncounterRow) => Promise<{ ok: true } | { ok: false; code: string; detail?: unknown }>;
const consultStartGuards = new Map<string, ConsultStartGuard>();
export function registerConsultStartGuard(key: string, guard: ConsultStartGuard): () => void {
  consultStartGuards.set(key, guard);
  return () => { consultStartGuards.delete(key); };
}
// inside startConsultation, after requireTreatingDoctor and the status check, before any write:
for (const [key, guard] of consultStartGuards) {
  const verdict = await guard(db, current);
  if (!verdict.ok) throw new OpdError("consult_gate_refused", `consult start refused by ${key}: ${verdict.code}`, { guard: key, ...verdictDetailOf(verdict) });
}
```
- [ ] **Step 2: Billing's guard + charge rules, red-first.** `charge-rules.test.ts` (4): `feeServiceFor` — visit_type new → chargeRules.opdConsult.new; renewal → .renewal; revisit → null (FREE); unknown mapping → `fee_not_applicable`. `gate.test.ts` (4): unpaid new visit → `{ ok:false, code:'fee_unsettled' }` and over the REAL OPD path `startConsultation` throws `consult_gate_refused` (integration through the registered guard — billing registers in the test via `registerConsultStartGuard`, the same call `billing.module.ts` makes in T11); settled fee invoice → passes; credit-extended unpaid → passes; revisit with NO invoice at all → passes. `feeQuote` (in charge-rules.ts) composes `feeServiceFor` + `previewInvoice`.
- [ ] **Step 3: Daily close, red-first.** `daily-close.test.ts` (8): claim idempotent (second `runDailyClose` same day: no second `day.closed`, no duplicate orphan events — the `ON CONFLICT DO NOTHING` claim asserted); day book totals by mode (cash/upi/card sums from a seeded day: hand-summed), CN + voucher totals, degraded breakout; orphan scan: a `new`-visit encounter with no fee invoice → `charge.orphan_flagged` (payload encounterId, patientId, expected serviceId); a `revisit` encounter with none → NOT flagged; an EIE'd fee invoice → FLAGGED (EIE excluded from cover); `gstr1Summary(db, from, to)`: groups by (sacCode, rateBps, exempt) SUMMING STORED LINE HEADS (the B-09 fixture's invoice issued through the real path; expected values from the Book), B2B rows keyed by `buyer_gstin` separate from B2C; credit notes NET OUT of the summary (a CN'd line reduces the period's heads — asserted).
- [ ] **Step 4: Mutants:** M-G1 (guard checks `visit_type` on the INVOICE's existence only — revisit test 4 breaks: revisit demands an invoice) → DIED; M-G2 (orphan scan forgets the EIE exclusion — the EIE'd-cover test) → DIED; M-G3 (gstr1 recomputes heads from grouped bases — B-09's 3399/3398 discriminator AT THE REPORT LAYER) → DIED. 3× each.
- [ ] **Step 5: Run to pass.** Core **116 suites / 717 tests** (+8 +4 +4, +3 in the OPD suite). Verify.
- [ ] **Step 6: Commit** — `feat(core): pay-before-consult gate via OPD guard registry (dependency-inverted), fee branch, daily close — day book, orphan scan, GSTR-1 line-head summary` → pull → push.

**Acceptance criteria:** 19/19 + the OPD suite's red quoted on the missing registry import; OPD edits are EXACTLY the four named files; guard test 1 proves shipped behaviour unchanged; M-G1/2/3 DIED 3/3; gstr1 sums stored heads (mutant-proven); core 116/717; verify green; clean.

---

### Task 11: Module surface — manifest, module, THE controller (31 routes), index, AppModule, first e2e  *(opus coder — the wire contract every screen consumes)*

**Files:**
- Create: `src/modules/billing/manifest.ts`, `src/modules/billing/billing.module.ts`, `src/modules/billing/billing.controller.ts`, `src/modules/billing/index.ts`, `test/billing.e2e.test.ts`
- Modify: `src/app.module.ts` (billingManifest + BillingModule — the two named lines)

- [ ] **Step 1: e2e red-first at 404** — `billing.e2e.test.ts` (11) written against the route table below before the controller exists: (1) full counter flow: seed → open session → `POST /billing/invoices` (fee quote via `GET /billing/visits/:encounterId/fee-quote` first) with receipt → 201, body carries invoice + settlement + unallocated; (2) OPD integration over HTTP: `/opd/.../consult/start` 409 `consult_gate_refused` unpaid → pay → 201 start (billing module registered ⇒ the guard is LIVE in the app — the e2e is the proof the module init wiring works); (3) dues: issue credit-extended (permission granted), `GET /billing/patients/:id/dues` lists it, `POST /billing/receipts` + `POST /billing/receipts/:id/allocations` clears it, settlement flips; (4) advances: standalone receipt, `GET /billing/patients/:id/balance`, allocation to a later invoice; (5) credit note + refund voucher through approval (grant via the shipped `/approvals` routes) + pay → `payment.refunded`; (6) session close with variance through approval; (7) 403 sweep: every route refuses a permission-less user (loop over the manifest — the Plan 05 pattern); (8) validation: fractional paise → 400 with the OPD-convention body `{ statusCode, message, code }`; (9) recon upload CSV → mismatch listed; (10) day book + gstr1 GETs return the T10 shapes; (11) config GET/PUT + degraded PUT evented. **Routes (27, all under `@Controller("billing")`, literal before `:id`):** `POST /billing/invoices` · `POST /billing/invoices/preview` · `GET /billing/invoices` · `GET /billing/invoices/:id` · `GET /billing/invoices/:id/print` · `POST /billing/invoices/:id/credit-notes` · `GET /billing/invoices/:id/credit-notes` · `GET /billing/visits/:encounterId/fee-quote` · `POST /billing/receipts` · `GET /billing/receipts` · `POST /billing/receipts/:id/allocations` · `POST /billing/allocations/:id/reverse` · `POST /billing/eie` · `GET /billing/patients/:patientId/balance` · `GET /billing/patients/:patientId/dues` · `POST /billing/refunds/request` · `POST /billing/refunds` · `POST /billing/refunds/:id/pay` · `GET /billing/refunds` · `POST /billing/sessions` · `GET /billing/sessions/current` · `POST /billing/sessions/:id/close` · `POST /billing/sessions/:id/confirm-close` · `GET /billing/sessions` · `POST /billing/recon/upload` · `GET /billing/recon/mismatches` · `GET /billing/day-book` · `GET /billing/gstr1` · `GET /billing/config` · `PUT /billing/config` · `PUT /billing/degraded` — **31 routes; the table IS the contract** (the e2e's 403 sweep iterates it, so a dropped route fails by count and by name).
- [ ] **Step 2: Manifest + module.** Permissions (14): `billing.invoice.issue/.read`, `billing.credit.extend`, `billing.receipt.record`, `billing.allocation.reverse`, `billing.credit_note.issue`, `billing.refund.request/.pay`, `billing.session.own/.read`, `billing.recon.upload`, `billing.reports.read`, `billing.config.write`, `billing.eie.mark`. Menu: Counter `/billing`, Dues & Advances `/billing/dues`, Session `/billing/session`, Back office `/billing/office`. `billing.module.ts` `OnModuleInit` → `registerConsultStartGuard("billing_fee_gate", feeGate(dbFromDI))`. `index.ts` exports: manifest, module, `issueInvoice`, `previewInvoice`, `recordReceipt`, `allocateReceipt`, `issueCreditNote`, `requestRefund/issueRefundVoucher/payRefundVoucher`, `patientBalance`, `invoiceSettlement`, `totalInvoice`, `creditShare`, `runDailyClose`, `registerBillingApprovalTypes`, `BillingError`/`BillingErrorCode`, `* from "./events"` — the Plan 09/11 contract (accrual consumes `payment.received`; pg-boss registers `runDailyClose`).
- [ ] **Step 3: Print payloads.** `GET /billing/invoices/:id/print` returns letterhead (from `loadOpdConfig` — the ONE shipped letterhead, spec: one hospital), patient summary (alias-safe), lines, totals, settlement, QR payload `bil1.invoice.<id>.<sig>` (kernel HMAC).
- [ ] **Step 4: Run to pass.** Core **117 suites / 728 tests** (+11). Verify.
- [ ] **Step 5: Commit** — `feat(core): billing module surface — manifest, guard-registering module, controller (route table), index contract, counter e2e` → pull → push.

**Acceptance criteria:** 11/11 with the red-first 404 run quoted; route table implemented verbatim; 403 sweep green over every route; the OPD 409→pay→start leg green over REAL HTTP; app.module edits are the two named lines; core 117/728; verify green; clean.

---

### Task 12: The lifecycle e2e, docs, runbook  *(sonnet coder — pipeline B capstone; owes NO red run — extends shipped surface)*

**Files:**
- Create: `test/billing-lifecycle.e2e.test.ts`
- Modify: root `README.md` (billing section)

- [ ] **Step 1: The lifecycle** (9): one continuous story over HTTP — register patient (Plan 05 routes) → open OPD visit (Plan 07 routes) → fee-quote shows the `new` branch → issue+pay at the counter → consult starts (gate passes) → complete → SAME patient revisit tomorrow (time pinned via the service `now` params where routes accept dates; the visit-type derivation is Plan 07's — the e2e drives real days via appointment-free walk-ins on separate `serviceDay`s)… scope honestly: the lifecycle covers (1) new-visit pay→consult; (2) dues story: credit-extend → dues list → partial clear → clearance discount (approval) → final clear → settled; (3) advance story: advance receipt → applied to a later invoice → `advance.received`/`payment.received` sequence asserted from the events table; (4) refund story: CN → voucher request → approve → issue → pay bank_transfer (above threshold) with payee identity; (5) session story: open → collect → close with variance → SoD refusal (cashier self-approve) → manager approves → confirm; (6) EIE story: mark a receipt → allocations reversed → day book excludes it; (7) recon story: upload → one reconciled one mismatched; (8) daily close: `runDailyClose` invoked directly (service call — it is unscheduled), `day.closed` totals hand-summed from the story's own numbers; (9) GSTR-1 over the story's invoices matches hand-derived heads. Every event-sequence assertion reads the `events` table (name + correlationId), never internal state.
- [ ] **Step 2: Docs.** README: module overview, the ledger model (receipts/allocations/derived settlement — three sentences), route table, permission grants per role (cashier vs billing_manager recommended table), go-live runbook: `seed:billing` → CA reviews `billing_config` (every threshold named with its statutory anchor: 269ST ₹2L block / 114B ₹50k PAN / §170 rounding / GST 16-char serials) → `caSigned` flip → `validate:billing` must print ok=true before the first live invoice (D-17) → register the five approval types (or confirm seed did) → grant roles → variance/dues/refund screens per role. The FY-series note: series reset per FY automatically; the first April invoice proves it (a go-live-week check item).
- [ ] **Step 3: Run to pass.** Core **118 suites / 737 tests** (+9). Root verify (whole repo). **Pipeline B ends here.**
- [ ] **Step 4: Commit** — `feat(core): billing lifecycle e2e — dues, advances, refunds, sessions, recon, daily close over HTTP; billing runbook` → pull → push.

**Acceptance criteria:** 9/9 (no red owed — stated); every total in stories 8–9 hand-summed in comments from the story's own numbers; README section present with the statutory-anchor table; core 118/737; verify green; clean.

---

### Task 13: The billing counter — flagship screen, shared money components, the picker's wedge lane, the lib lift  *(opus coder — pipeline C opens)*

**Files:**
- Create: `apps/web/src/lib/format.ts` (+ `.test.ts`), `apps/web/src/lib/billing-api.ts`, `apps/web/src/components/money-input.tsx` (+ `.test.tsx`), `apps/web/src/components/tender-editor.tsx` (+ `.test.tsx`), `apps/web/src/components/invoice-print.tsx` (+ `.test.tsx`), `apps/web/src/components/patient-picker.test.tsx`, `apps/web/src/screens/billing-counter.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/patient-picker.tsx` (wedge lane + `data-search-input` on its own input), `apps/web/src/screens/opd-desk.tsx` (DELETE the `setAttribute` wrapper — the only edit), `apps/web/src/screens/opd-appointments.tsx` + `registration-desk` imports? NO — frozen; `fmtIst`/`useDebounced` are LIFTED as new exports in `lib/format.ts` and the OPD/registration copies stay (deleting them would touch frozen files; recorded as accepted residual duplication until a task owns those screens), `apps/web/src/router.tsx` (route `/billing`), `apps/web/src/lib/keyboard.tsx` (Alt+B), `en.json` + `hi.json` (`billing`, `nav.billing`), `apps/web/vite.config.ts` (+ `/billing` proxy line)

- [ ] **Step 1: The lift + components, red-first.** `format.test.ts` (3): `fmtPaise(1123350)` → `"₹11,233.50"` (Indian grouping: `fmtPaise(123456789)` → `"₹12,34,567.89"`), `fmtIst` matches the opd-desk behaviour (transcribed, not imported), `useDebounced` fires once after the window. `money-input.test.tsx` (3): typing `"112.33"` yields integer `11233` paise in form state (never a float — asserted via the submitted value); blank → undefined; a fractional-paise entry `"112.335"` is refused inline. `tender-editor.test.tsx` (4): add/remove rows; running Σ vs payable renders short/exact/over states; upi/card rows require ref; the ONCHANGE value is `{ mode, amountPaise, refText? }[]` with integer paise (asserted). `invoice-print.test.tsx` (3): letterhead + patient summary (alias when restricted) + lines + totals + settlement + rounding line + QR svg from `qrPayload`; root carries `.print-doc`; the DUES stamp renders when outstanding > 0 (the legacy four-state enum reduced to a derived banner — asserted from settlement, not a stored status).
- [ ] **Step 2: The wedge lane, red-first** (`patient-picker.test.tsx`, 3): (1) rapid keystrokes into the scan input (fake timers; < 30 ms apart) ending in Enter fire the SAME verify call the paste lane fires (K37's mutant deletes the keydown lane); (2) slow typing + Enter also fires (a human pasting by keyboard or typing a UHID — the buffer is an accumulator, not a timer gate; Enter is the trigger, the speed heuristic only AUTO-CLEARS a stale buffer after 500 ms idle); (3) the input itself carries `data-search-input` (the wrapper is gone — `opd-desk.test.tsx` keeps passing untouched, which is the deletion's regression pin).
- [ ] **Step 3: The counter screen, red-first** (`billing-counter.test.tsx`, 7): (1) picker → visit context loads `GET /billing/visits/:encounterId/fee-quote` (deep-link `?encounterId=` too — flag ⑧) and renders the branch badge (`new` shows the fee, `revisit` shows FREE); (2) lines editor: fee line pre-filled from the quote; add service lines (search `GET /tariff/services`); manual discount per line (category select + value + reason) — the preview call `POST /billing/invoices/preview` renders totals incl. the contest outcome and any `requiresApproval` flag with its approval-request lane; (3) `refetchInterval: 15_000` on the queue-of-unbilled… the screen's ONE polling read (the fee-quote/dues sidebar) — **asserted with fake timers: a second GET after 15 s (K39 — the §3.34 convention absorbed: this task OWNS the polling assertion)**; (4) tender capture via `TenderEditor`; submit posts `POST /billing/invoices` with integer paise throughout (K38's mutant posts strings), `pan`/`form60` fields appear when the response/preview warns `pan_required`; (5) a 409 `cash_threshold_blocked` and a 400 `pan_required` render inline (OPD error-body convention via a `billingErrorMessage` mirroring `opdErrorMessage`); (6) credit lane: remainder shown, reason mandatory, above-cap prompts the approval-wait state (`credit_approval_required` rendered with the approval id); (7) success renders `InvoicePrint` + `window.print()` available; `unallocatedPaise > 0` renders the change-due/advance banner.
- [ ] **Step 4: Wire-up.** Route `/billing` under authed; Alt+B in `keyboard.tsx`; nav; locales (en + hi, parity green); vite proxy `/billing`.
- [ ] **Step 5: Mutants.** W-1 keydown lane deleted → picker test 1 → DIED. W-2 tender amounts posted as strings → counter test 4 → DIED. W-3 `refetchInterval` removed → counter test 3 → DIED. W-4 `.print-doc` dropped from InvoicePrint root → print test → DIED. 3× each; delete.
- [ ] **Step 6: Run to pass.** Web **27 files / 103 tests** (+3+3+4+3+3+7). Verify.
- [ ] **Step 7: Commit** — `feat(web): billing counter — fee-quote flow, live preview with contest, mixed tenders, credit lane, printed invoice; wedge-scanner QR lane; fmtPaise/fmtIst/useDebounced lift` → pull → push.

**Acceptance criteria:** 23/23 + red-first; wedge lane proven with fake-timer keystrokes; polling OWNED here (W-3 died); every posted money value integer paise (W-2 died); opd-desk edit is deletion-only (diff shows only removals); parity green; web 27/103; verify green; clean.

---

### Task 14: Dues & advances — one ledger, one screen  *(sonnet coder)*

**Files:**
- Create: `apps/web/src/screens/billing-dues.tsx` (+ `.test.tsx`)
- Modify: `router.tsx` (route `/billing/dues`, nav), `en.json` + `hi.json` (`billingDues`)

- [ ] **Step 1: Tests first** (7): (1) patient search (the picker) → `GET /billing/patients/:id/balance` renders advance balance AND dues list (outstanding per invoice, oldest first, restricted names as alias); (2) **Dues Clear**: select an invoice → receipt form (TenderEditor) + allocation — posts `POST /billing/receipts` then `POST /billing/receipts/:id/allocations` with `{ invoiceId, amountPaise: <the PARTIAL amount the cashier typed> }` (K41's mutant always sends the full outstanding) — partial settlement is a first-class lane; (3) clearance-discount lane: category + reason mandatory, posts `POST /billing/invoices/:id/credit-notes { kind: "clearance_discount", … }` (K42), an `over_cap` 409 renders the asked-vs-cap detail; (4) take advance: receipt with no allocation — balance refreshes; (5) apply advance: `POST /billing/receipts/:id/allocations` from an EXISTING receipt row (no new money) — the two lanes share the allocation call and the test asserts no receipt POST fires; (6) refund-advance button routes to the office screen's refund flow (link asserted — no duplicate flow built); (7) `refetchInterval 15_000` present (each screen polls; T13 owns the convention's teeth, this one is a plain presence assertion — stated honestly).
- [ ] **Step 2: The screen.** Left: search + balance header (advance green, outstanding red, cap-warn banner when the response flags it); right: dues table (invoice no, day, payable, paid, outstanding, PAID/DUE/CREDIT badge) + the three action lanes. Keyboard-first: `/` focuses search, Enter opens the selected invoice's clear lane.
- [ ] **Step 3: Mutants.** W-5 (allocation always posts full outstanding) → test 2 → DIED. W-6 (clearance posts without category) → test 3 → DIED. 3× each.
- [ ] **Step 4: Run to pass.** Web **28 files / 110 tests**. Verify.
- [ ] **Step 5: Commit** — `feat(web): dues & advances — one-ledger view, partial dues clear, clearance discount, advance take/apply` → pull → push.

**Acceptance criteria:** 7/7 + red-first; partial-amount body asserted; W-5/W-6 DIED 3/3; parity green; web 28/110; verify green; clean.

---

### Task 15: The cashier session screen + the absorbed Plan 07 assertions  *(sonnet coder)*

**Files:**
- Create: `apps/web/src/screens/billing-session.tsx` (+ `.test.tsx`)
- Modify: `router.tsx` (route `/billing/session`, nav), `en.json` + `hi.json` (`billingSession`), `apps/web/src/screens/opd-consult.test.tsx` (+3: Alt+K, Alt+S, Alt+Enter — Plan 07 §8 gateX4's survivors become required-DIED), `apps/web/src/screens/opd-vitals.test.tsx` (fixture reorder: the hidden-404 row selected AFTER the 3-year-old so the adult-band fallback half of criterion 6 discriminates — Plan 07 V5's named fix)

- [ ] **Step 1: Session screen tests first** (6): (1) no session → open form (float via MoneyInput) posts and renders the open session (opened at, float, running collections by mode from `GET /billing/sessions/current`); (2) close flow: denomination grid (2000/500/200/100/50/20/10/5/2/1 rupee rows — paise keys ×100), counted Σ computed client-side and ASSERTED against the same fold the server uses (K43's mutant sums note-count × face value wrong — e.g. drops the ×100); (3) zero variance → closed state; (4) non-zero → `closing` state renders variance signed + approval-pending banner; (5) confirm-close after approval → closed + day summary; (6) a second open while `closing` renders `session_state_conflict` inline.
- [ ] **Step 2: The absorbed assertions.** opd-consult: three keydown tests (Alt+K posts skip, Alt+S posts start, Alt+Enter posts complete — mirroring the shipped handlers; K44 re-runs Plan 07's surviving gateX4 as the killing mutant and it must now DIE). opd-vitals: swap the fixture order only — the existing assertions now discriminate (K45's mutant: previous patient's age leaks into the band → renders the 3-year-old's band for the hidden row → the reordered test fails).
- [ ] **Step 3: Mutants.** W-7 (denomination fold drops the paise ×100) → test 2 → DIED. W-8 (the three consult shortcuts deleted — a COPY of opd-consult with handlers stripped) → the three new tests → DIED. W-9 (vitals band from the previously-selected patient) → the reordered test → DIED. 3× each.
- [ ] **Step 4: Run to pass.** Web **29 files / 119 tests** (+6 session, +3 consult; vitals net 0). Verify.
- [ ] **Step 5: Commit** — `feat(web): cashier session screen — float, denominations, variance approval flow; consult shortcuts + vitals band fallback assertions absorbed from Plan 07` → pull → push.

**Acceptance criteria:** 9/9 new + red-first (session file); the two absorbed fixes land as EXECUTED kills (W-8, W-9 died — closing Plan 07 §10.9's ledger items); W-7 died; parity green; web 29/119; verify green; clean.

---

### Task 16: Back office — refunds & credit notes, recon, day book, GSTR-1; nav + web docs  *(opus coder — pipeline C capstone)*

**Files:**
- Create: `apps/web/src/screens/billing-office.tsx` (+ `.test.tsx`)
- Modify: `router.tsx` (route `/billing/office`, nav complete), `en.json` + `hi.json` (`billingOffice`), root `README.md` ("Web app: billing screens" section)

- [ ] **Step 1: Tests first** (8): (1) tab Refunds: request form (invoice/CN picker, amount, reasonClass select mistake|genuine, reason) posts `/billing/refunds/request`; the worklist shows pending approvals with guard-flag chips (`terminal_encounter` / `delivered_line` rendered as warnings); (2) issue + pay lanes: pay form enforces payee identity fields client-side mirror (server is authority — stated) and renders `bank_transfer_required` from a stubbed 400; (3) tab Recon: CSV textarea/file → posts `{ csv }` to `/billing/recon/upload`; result renders matched/mismatched/unmatched counts and the mismatch worklist rows with both numbers; (4) tab Day book: `GET /billing/day-book?day=` renders mode totals + degraded breakout + CN/voucher lines — **every rupee figure through `fmtPaise`, and the API's numbers rendered VERBATIM (K46's mutant recomputes a client-side Σ over rows and renders that — the test's fixture carries an intentionally inconsistent row so recompute ≠ verbatim, the §3.33 fixture-can-violate discipline)**; (5) tab GSTR-1: date range → B2B/B2C groups by GSTIN with head sums rendered verbatim (same fixture discipline); (6) day-book date defaults to `todayIst()`; (7) EIE lane: mark a receipt with reason → posts `/billing/eie`, confirm dialog names the cascade (allocations reverse); (8) permission-less 403s render the shared error state.
- [ ] **Step 2: The screen** — four tabs, worklists with `refetchInterval 15_000`, keyboard nav between tabs (1/2/3/4).
- [ ] **Step 3: Docs.** README "Web app: billing screens": routes, roles per screen (cashier: counter/dues/session; billing_manager adds office/config), the wedge-scanner note (the picker lane works with keyboard-wedge scanners — UAT item closed), the polling convention, the degraded-mode operating note.
- [ ] **Step 4: Mutants.** W-10 (day book client-side recompute) → test 4 → DIED. W-11 (recon upload posts the raw textarea without the `{ csv }` wrapper) → test 3 (body asserted) → DIED. 3× each.
- [ ] **Step 5: Run to pass.** Web **30 files / 127 tests**. ROOT verify (whole repo). **Pipeline C and the plan end here.**
- [ ] **Step 6: Commit** — `feat(web): billing back office — refund worklist with guard flags, recon upload, day book, GSTR-1 view; billing web docs` → pull → push.

**Acceptance criteria:** 8/8 + red-first; K46's inconsistent-fixture discipline visible in the test file; W-10/W-11 DIED 3/3; nav complete in both locales; README section present; web 30/127; whole-repo verify green; clean.

---

## Assertion Book — predictions until executed; the verdict column is filled by the shipping task

Per tripwire 21, "Kills" are HAND-DERIVED PREDICTIONS until the named mutant is BUILT and RUN (separate scratch, self-contained spec, isolated run, verdict + count recorded). "= pre-fix red" means the shipped state before the task's fix IS the mutant and the observed red is the executed evidence. *measure* rows authorise an honest SURVIVED with the observed rate (§3.22); the structural defence is named. §2.12 branches apply verbatim.

| # | Task | Assertion | Kills (mutant → predicted wrong observable) | Executed verdict | Notes |
|---|---|---|---|---|---|
| K1 | T1 | the fourteen billing names are load-bearing in `truncateAll`s patients/OPD statement | = pre-fix red: run the suite with the patients/OPD statement at its SHIPPED content (names absent) → `cannot truncate a table referenced in a foreign key constraint` in every `beforeEach`, because `invoices`/`receipts`/`refund_vouchers` reference `patients` | | §3.12 executed; ROW REWRITTEN 2026-08-19 under ruling R5 — the property is that removing the names breaks the suite, not that any particular statement was *added* (§3.36) |
| K2 | T1 | six tables refuse UPDATE and DELETE | = pre-fix red ×8: suite red before `0012` exists, green after migrate | | the migration IS the mechanism |
| K3 | T1 | one live session per cashier | (structural pin: second open 23505 → `session_already_open`) | | index-arbitrated |
| K4 | T1 | FY flips at IST Apr 1, not UTC | M-T1 (fy from UTC date) → **at `2026-03-31T18:30:00Z`** (IST Apr 1 00:00, UTC still Mar 31) correct is `2026-27` and the mutant returns `2025-26` | | pure boundary. ROW CORRECTED 2026-08-19: the previous wording named `Mar 31 23:59 IST` (`2026-03-31T18:29:59Z`), whose UTC calendar date is ALSO Mar 31 — the mutant agrees there and the row did not discriminate (§3.37) |
| K5 | T2 | B-01: invoice cgst = Σ line heads = 3399 | M-B01 (recompute from Σ base) → 3398 | | §15.1 |
| K6 | T2 | B-02: GST total 1666, heads never split from total | M-B02 (total-then-split) → 1667 | | §15.2 |
| K7 | T2 | B-03: §170 rounding applied once (5651/5582 pair) | M-B03 (round per line then sum) → 11300 vs 11200 | | pair chosen FOR discrimination (self-review 5) |
| K8 | T2 | creditShare is cumulative; lines exhaust exactly | M-B05 (per-refund shares) → Σ 99 ≠ 100 on the 100/3 fixture | | the pro-ration rule |
| K9 | T2 | B-06 worked refund steps (3360/3360/3360) | (derivation; M-B05 is the discriminator for the rule; values gate-re-derived) | | derivation row |
| K10 | T3 | series: 6 concurrent → {1..6} unique | *measure 10×* — structural defence: single-winner `UPDATE … RETURNING` | | §3.22 |
| K11 | T3 | rollover: new FY restarts at 1, old FY unaffected | (behavioural; K4's mutant covers the boundary; both FYs asserted) | | declared |
| K12 | T3 | validate:billing catches the four breaks through runtime loaders | = pre-fix reds (each break added, gate observed catching) | | M1 lesson |
| K13 | T4 | variance approval is FILED BY the cashier (SoD structural) | M-S1 (system-actor requester) → self-approve refusal vanishes | | the free SoD, pinned |
| K14 | T4 | variance = counted − expected, non-zero → closing | M-S2 (variance always 0) → straight to closed | | |
| K15 | T4 | open race: one winner | *measure 5×* — defence: partial unique index | | |
| K16 | T5 | refused issue persists NOTHING | (tx atomicity; row-count zero asserted) | | declared |
| K17 | T5 | discount approval subject/amount binding | M-I1 (skip subject check) → wrong-subject approval accepted | | M10's lesson, our side |
| K18 | T5 | persisted invoice heads are line sums | M-I2 (taxHead at invoice level in persistence) → 3398-class row | | B-01 inside the tx |
| K19 | T5 | credit lane needs the permission | M-I3 (skip hasPermission) → permission-less credit issues | | |
| K20 | T5 | C-2 counts CASH only | M-I4 (counts all tenders) → UPI pushes past block | | |
| K21 | T6 | concurrent allocations cannot overpay | M-A1 (invoice FOR UPDATE dropped) — *measure 10×* + a lock-OBSERVATION leg from a raw client (§3.28: the held row is the invoice, outside allocations' insert path) | | the ledger's core race |
| K22 | T6 | EIE reverses live allocations in-tx | M-A2 (mark without reversal) → settlement still counts dead money | | |
| K23 | T6 | dues order by seq, never id | M-A3 (order by id) → seeded out-of-order fixture flips | | §3.26 |
| K24 | T7 | CN shares cumulative at the row level | M-C1 → exhaustion test leaks a paise | | B-06 as rows |
| K25 | T7 | clearance caps from `loadRuleConfig`, not `listAdjustmentRules` | M-C2 → an inactive cap row honoured | | M1's shape, clearance side |
| K26 | T7 | corrections exhaust | M-C3 (partial correction accepted) → | | |
| K27 | T8 | refund ≤ money RECEIVED (dues bill refunds partially) | M-R1 (cap vs invoice net) → dues bill refunds in full | | legacy guard 1, structural |
| K28 | T8 | bank transfer forced above threshold | M-R2 (threshold skipped) → cash voucher above ₹10k | | |
| K29 | T8 | guard flags computed (terminal/delivered) | M-R3 (flags always []) → | | legacy guards 2+3 |
| K30 | T8 | advance-refund race: one loser | *measure 5×* — defence: ordered receipt locks | | 06.1 C1's shape |
| K31 | T9 | recon compares settled vs EXPECTED-NET | M-N1 (vs gross amount) → card 49250 flips verdicts | | E-26 |
| K32 | T9 | re-upload cannot rewrite a reconciled tender | M-N2 (unconditional update) → idempotency test | | |
| K33 | T10 | revisit passes the gate with NO invoice | M-G1 (existence check for all types) → revisit demands an invoice | | the FREE branch pinned |
| K34 | T10 | orphan scan ignores EIE cover | M-G2 → EIE'd invoice suppresses the flag | | |
| K35 | T10 | GSTR-1 sums STORED heads | M-G3 (recompute at report layer) → B-09's 3399/3398 at the report | | layer-distinct from K18 |
| K36 | T11 | wire contract: 404-red, 403 sweep, OPD 409→pay→start | (e2e over mutant-tested services; red-first at 404) | | declared |
| K37 | T13 | wedge keystrokes + Enter fire the scan lane | W-1 (keydown lane deleted) → only paste fires | | owner ruling 5 |
| K38 | T13 | tender bodies are integer paise | W-2 (strings) → | | §3.19 class |
| K39 | T13 | the 15 s polling convention has teeth | W-3 (refetchInterval removed) → no second GET under fake timers | | Plan 07 §10.9(a) closed |
| K40 | T13 | invoice print `.print-doc` + alias-safe | W-4 → class missing | | |
| K41 | T14 | dues clear posts the PARTIAL amount typed | W-5 (always full outstanding) → | | partial settlement is real |
| K42 | T14 | clearance lane requires category + reason | W-6 → posts without category | | |
| K43 | T15 | denomination fold ×100 correct | W-7 → drops the paise factor | | |
| K44 | T15 | Alt+K / Alt+S / Alt+Enter tested | W-8 (handlers stripped copy) → three tests fail | | Plan 07 gateX4 closed as required-DIED |
| K45 | T15 | vitals 404 adult-band half discriminates | W-9 (stale age band) → reordered fixture fails | | Plan 07 V5 closed |
| K46 | T16 | day book renders API sums verbatim | W-10 (client recompute) → inconsistent fixture diverges | | §3.33 fixture discipline |
| K47 | T16 | recon upload body shape `{ csv }` | W-11 → raw string posted | | |

**Reading the Book honestly:** K10, K15, K21, K30 are *measure* rows; K3, K9, K11, K12, K16, K36 declare their evidence with reasons; every other row is a required DIED — 36 required builds across 47 rows.

## Verify-by-execution flags (each names its owning task and discharging assertion; the list may be incomplete, §3.20)

① `drizzle-kit generate -- --custom --name=billing_immutability` produces an empty journaled migration, and `migrate()` applies hand-written trigger SQL — T1: the immutability suite red→green through the real migrator (STOP and report if the CLI flag differs in this drizzle-kit version; do NOT hand-edit `_journal.json` beyond what the generator writes). ② `seed:billing` idempotent — T3 runs it twice, both outputs quoted. ③ drizzle emits the `cashier_sessions` partial unique index WITH its predicate — T1 inspection + the 23505 test. ④ pg `bigint mode number` round-trips crore-scale paise (10¹²) — T1 schema test pins one. ⑤ the Plan 06.2 contention pattern (raw client on the shipped `pool` holding a row lock) works against `invoices` FOR UPDATE — T6's observation leg. ⑥ `ON CONFLICT DO NOTHING` + `UPDATE … RETURNING` under concurrent FIRST-ever insert of a series row — T3's race includes the cold-start case (six racers, no pre-seeded row). ⑦ jsdom `KeyboardEvent` timing under vitest fake timers drives the wedge buffer — T13 probes before the test is written (Plan 07 §9 family; the idle-clear uses the fake clock). ⑧ TanStack Router `validateSearch` for `/billing?encounterId=` — T13. ⑨ Nest accepts the `{ csv: string }` JSON body at the shipped body-parser config — T11's recon e2e leg (no multipart anywhere).

## Self-review — what this plan's own passes caught before commit

**Pass 1 (design → blocks):**
1. **Any cashier could mint dues by issuing without payment** — closed by D2's invariant: unsettled-without-credit cannot be PERSISTED (`unsettled_issue_refused`), pinned by K16's atomicity test.
2. **Naive per-refund `divHalfUp` leaks paise** on partial refunds (100/3 → 33+33+33 = 99); the cumulative rule with remainder-to-last is the fix and K8's fixture is chosen so the leak is visible.
3. **The first B-03 rounding pair (5617/5616) was NON-discriminating** — per-line rounding also lands 11200. Replaced with 5651/5582 (per-line 5700+5600 = 11300 ≠ 11200). The two-audit rule caught its own fixture.
4. **The guard registry as an array would double-register across jest testing modules in one worker** — keyed Map, idempotent, unregister returned (T10's test 3 pins it).
5. **A billing error thrown inside an OPD route would 500** — the guard contract returns a verdict; OPD owns the thrown error (`consult_gate_refused`), billing supplies only data.
6. **Overpayment is not an error** — the surplus is the change-due/advance lane (`unallocatedPaise`), or the counter takes exact net; forcing exactness would have made every real cash transaction a refusal.
7. **C-2 must count advance receipts** — cash is cash under 269ST; the aggregation reads receipts, not invoices (K20's mutant guards the tender-mode edge, the test fixture includes an advance).
8. ~~**The billing truncate statement must precede the patients statement** (invoices FK patients); placed before it and self-contained — verified against the shipped six-statement order.~~ **WRONG, AND EXECUTION PROVED IT (2026-08-19).** Ordering is irrelevant: `TRUNCATE` checks FK constraint *existence*, not row counts and not statement order, so a separate earlier billing statement leaves `invoices → patients` pointing at `patients` and the patients statement still fails. This authoring pass re-derived, in its own words, the inverse of the fact EXECUTION-LESSONS §3.12 already recorded from Plan 04 — which is why §3.35 now says a plan's DDL rationale must quote the ledger rather than paraphrase it. Corrected by ruling R5: the FKs stay, and the fourteen names go INTO the existing patients/OPD statement (T1 Step 5). Cost of the error: pipeline A's first run, ~934k tokens, 0 of 6 tasks delivered.
9. **Clearance discount on a settled invoice is a disguised refund** — `clearance_requires_outstanding` added to the union and T7's test 7.
10. **GST's 16-char serial ceiling** forces the `INV/26-27/000001` format — 16 exactly; the format test pins length.
11. **The variance SoD is free ONLY if the cashier files the approval** — a system-actor requester would silently disarm it; K13's mutant is exactly that regression.
12. **`expectedNetPaise` is stamped at CAPTURE** — stamping at recon would let a fee-config change rewrite what "expected" meant for old tenders; K31 tests the compare, T5 writes the stamp.
13. **The report layer can reintroduce the recompute bug independently of persistence** — K18 (persist) and K35 (report) are deliberately two rows, two mutants, two layers.
14. **`patients` has no deceased column** (scout-verified) — the roadmap gloss implied a D-33 read; it is recorded as a documented seam in D10 instead of code that references a phantom column.
15. **drizzle-kit cannot emit triggers** — surfaced the 0011+0012 two-migration decision instead of letting T1 discover it mid-pipeline; flag ① proves the custom-migration flow by execution.
16. **Route count**: the prose said 27, the table holds 31 — the table is the contract; counted twice, prose corrected (§2.9's spirit applied to authoring).
17. **`fmtIst`/`useDebounced` cannot be deleted from their OPD/registration copies** — those files are frozen; the lift creates the shared export and the duplication is recorded as accepted residue, not silently left.

**Pass 2 (numbers re-derived):**
18. B-01: `taxHead(18875,1200) = ⌊(45,300,000+20,000)/40,000⌋ = ⌊1133.0⌋ = 1133`; ×3 = 3399. Invoice-level: `taxHead(56625,1200) = ⌊(135,900,000+20,000)/40,000⌋ = 3398.0 → 3398`. ✓ discriminates by exactly one paise.
19. B-02: `taxHead(33333,500) = ⌊(33,333,000+20,000)/40,000⌋ = ⌊833.825⌋ = 833`; ×2 = 1666. `percentAmount(33333,500) = ⌊(33,333,000+10,000)/20,000⌋ = ⌊1667.15⌋ = 1667`. ✓.
20. B-03: `divHalfUp(11233,100) = ⌊(22,466+100)/200⌋ = ⌊112.83⌋ = 112 → 11200`, rounding −33; per-line 5651→5700, 5582→5600, Σ 11300. ✓.
21. B-06: `taxHead(9000, 1200) = divHalfUp(10,800,000, 20,000)`; the quotient is 540 EXACTLY (no half to round), so heads are **540 each**, shares 180/180/180 per refund step, nets 3360/3360/3360 — the line exhausts. Authoring caution recorded: the half-up formula's intermediate `⌊(2n+d)/(2d)⌋ = ⌊540.5⌋` shows a midpoint that is the formula's OFFSET, not the quotient — this pass initially misread it as a rounding case. Derive from the quotient, then apply the formula; never reason from the intermediate.
22. Card expected-net: `percentAmount(50000,150) = divHalfUp(7,500,000,10000) = ⌊(15,000,000+10,000)/20,000⌋ = ⌊750.5⌋ = 750` — 7,500,000/10,000 = 750 exactly; expected 49250. ✓.
23. Denominations: `{50000:3, 10000:2, 500:4}` → 150,000 + 20,000 + 2,000 = 172,000 paise = ₹1,720. ✓.
24. Ladders re-summed from the task test lists: core 536 → 552 → 585 → 604 → 619 → 640 → 661 → 673 → 685 → 694 → 713 → 724 → 733 (deltas 16/33/19/15/21/21/12/12/9/19/11/9 — each matches its task's enumerated tests). Web 80 → 103 → 110 → 119 → 127 (23/7/9/8). ✓.
25. Every consumed signature transcribed from this session's scout output, not recalled — `loadPricingContext(db, { at, tariffVersionId?, allowDraft?, tags? })`, `requestApproval(tx, requester, input)`, `getApproval(db, id)`, `registerApprovalType(tx, spec)`, `approveRequest(db, actor, { approvalId, note })`, `getEncounter(db|tx, id)`, `startConsultation(db, actor, encounterId, now?)`, `loadOpdConfig(db|tx)`, `getPatientSummaries(db, actor, ids)`, `hasPermission(db, userId, permission, "hospital")`, `roundTotalToRupee`, `taxHead`, `divHalfUp`, `assertPaise`, `percentAmount`.
26. Frozen paths audited against every Files list — the OPD touches are exactly T10's four files + T13/T15's three web test/screen files named in their tasks; nothing touches kernel folders, tariff, patients, contracts, workflows, ui/, or the five Plan 05 screens beyond opd-desk's deletion.

**Pass 3 (stress reading as compiler/agent):**
27. T3's helper `openSessionFor` needs sessions before T4 ships them — the helper INSERTS the row directly until T4 replaces it (disclosed shaping, named in both tasks).
28. T4's expected-cash query reads receipts/tenders that no writer creates until T5/T6 — the tests SHAPE rows against T1's schema (disclosed); the query is written once, against the final shape.
29. T5's discount-approval test needs seeded caps with `approvalAboveBps` BELOW `maxBps` (3000 < 5000) so an ask can be both grantable and approval-gated — the seed values are stated in T3 and restated in T5.
30. T10's gate integration test registers the guard itself rather than importing the Nest module (unit-level), and T11's e2e proves the module-init registration — two layers, both stated, no gap where neither tests the wiring.
31. T12 owes no red run and says so (the §12 lesson from Plan 07 — extending shipped surface produces import-resolution reds that prove nothing).
32. The web tasks never assert on exact 2xx codes (§3.32 — `stubFetch` answers 200; all four billing screens read bodies, not statuses; T11's e2e owns status codes).

## Test-count ladder (per workspace; baseline measured 2026-08-18 at `c110b58` — measurement beats this document)

`apps/core` (**re-summed 2026-08-19**; the row below replaces the original ladder, which put T1 at 95/552 — arithmetically inconsistent with T1s own Step 3 enumeration of 4 + 8 + 8 = 20 tests across THREE new suites, and off by +1 suite / +4 tests at every later rung): 93 suites / 536 tests → **T1** 96/556 → **T2** 100/589 → **T3** 104/608 → **T4** 106/623 → **T5** 108/644 → **T6** 110/665 → **T7** 111/677 → **T8** 112/689 → **T9** 113/698 → **T10** 116/717 → **T11** 117/728 → **T12** 118/737. `apps/web`: 21 files / 80 tests → **T13** 27/103 → **T14** 28/110 → **T15** 29/119 → **T16** 30/127. `packages/contracts` 3/7 unchanged throughout. Per-suite deltas for the two touched OPD web suites (`opd-consult` +3, `opd-vitals` ±0) and the OPD core suite (`consultation.test` +3) are stated as deltas — the pre-compile scout measures absolutes.

## Pipeline Notes (for /execute compilation — do not compile before owner approval)

- **Three pipelines: A = T1–T6, B = T7–T12, C = T13–T16 — strictly sequential within each; A → B → C.** Read A's report before compiling B, B's before C; re-measure per-suite counts with ONE scout immediately before each compile (§2.9) and paste them into the briefs.
- **Tier map:** A: T1 opus (migrations + triggers) · T2 opus (the Fixture Book) · T3 sonnet · T4 sonnet · T5 opus (the core transaction) · T6 opus (the ledger races) · B: T7 sonnet · T8 sonnet · T9 sonnet · T10 opus (the OPD edit + report layer) · T11 opus (31 routes + the wiring e2e) · T12 sonnet · C: T13 opus (flagship counter + picker surgery) · T14 sonnet · T15 sonnet · T16 opus (four-tab office + fixture-discipline tests). **Opus gate on every task regardless of coder tier.**
- **Cost calibration (Plan 07 actuals applied):** backend ~300k mean × 12 = 3.6M; **web screens at the MEASURED ~550k × 4 = 2.2M** (two consecutive plans under-predicted this class; this plan budgets the measured rate); infrastructure contingency 0.3–0.4M per pipeline ≈ 0.9–1.2M. **Total ≈ 6.7–7.0M budget; band 6.4–7.4M; expected midpoint ~6.8M.** Wall clock ~3.5–4.5 h per pipeline ⇒ 11–13 h.
- **Frozen paths while the pipelines run:** every kernel folder (T1's two one-line edits excepted); `drizzle/**` T1 only; `modules/tariff/**`, `modules/patients/**`, `packages/contracts/**` byte-frozen; `modules/opd/**` except T10's four named files; `kernel/realtime/**`; `qr.test.ts`; `test/helpers/db.ts` after T1; `jest.config.cjs`; `.env.example`; `tsconfig*`; `.github/workflows/**`; `apps/web/src/components/ui/**`; the five Plan 05 screens (T13's `opd-desk.tsx` deletion-only edit excepted); both `package.json`s and `pnpm-lock.yaml` except T3's two script lines. **Nothing in any pipeline installs anything.**
- **Migration rule:** exactly TWO, both in T1 (`0011` generated + `0012` custom triggers). Any later schema need anywhere = **CHAIN HALT + plan-defect report** (owner halt condition).
- **Compile rules (EXECUTION-LESSONS):** §1 tripwires 1–21 verbatim at the TOP of every brief (and every scout brief with the §2.11 output protocol) · briefs point at this committed plan on the server and never restate its code · baseline = current `origin/main` (§2.6) · per-suite counts from the pre-compile measurement beat this document (§2.9) · no count criterion pinned to a path regex a later file could match (§2.5 — note `billing` matches `billing-counter`, `billing-dues`, `billing-session`, `billing-office`, `billing-purity`, `golden-billing`: every web/count criterion names the EXACT file) · FINISH block = commit → `git pull --rebase origin main` → `git push origin main` (§3.8), with a `git status --porcelain` check BEFORE any `git add -A` (Plan 07 §9's stray-scratch hazard) · gate verdicts carry `retry_mode` (§2.2) · no correction may direct a history rewrite (tripwire 15) or security-code weakening (tripwire 14) · race/isolation evidence only via `pnpm --filter @hmis/core exec jest --passWithNoTests <path> -t "<name>"` with isolation confirmed from OUTPUT (tripwire 19) · every fail-first criterion carries the §2.8 fallback · after any infra halt, check whether the dead agent pushed before resuming · no scout or audit runs tests concurrently with a pipeline task (tripwire 20).
- **Mutant discipline block for every brief:** verbatim from Plan 07's Pipeline Notes (scratch-file mutants, self-contained specs, isolated runs, DIED/SURVIVED with counts, *measure* rows report the rate, scratch deleted before counts and commit, §2.12 branches, never fix a survivor silently).
- **Halt conditions (owner-set, in every brief):** a third migration · a required-DIED surviving because shipped code is wrong · a file outside the Files list · any frozen-path edit · amend/force-push of pushed history · scope drift toward corporate/TPA billing, e-invoicing, PSP APIs, IPD deposit policy, or collections automation (the dues worklist and the advance instrument are the whole allowance) · any attempt to "align" the two ratified error-body conventions.
- **Deviations-not-to-fix in every brief:** gate reports 01–07 §4/§5 (the `code: message` prefix on patients/tariff bodies · the open error-code sets · tariff m2/m4/m9 deferrals · `workflow.controller.ts:142`'s bare-`at` ordering — STILL not this plan's, billing touches no workflow read surface · `qr.test.ts`'s flake · the OPD realtime carry-forwards §10.4–10.7 · `registerPatient`'s wall-clock `dob` — routed to a patients-module owner, NOT absorbed here) · `fmtIst`/`useDebounced` copies in frozen OPD screens (residue recorded in T13).
- **Go-live items this plan creates (for the gate report's carried-forward list):** `seed:billing` per environment · CA review of every `billing_config` threshold against its statutory anchor + `caSigned` flip + `validate:billing` ok=true before the first live invoice (D-17) · the five approval types registered (or seed-confirmed) + `billing_manager`/`cashier` role grants · counter hardware check: wedge scanners against the picker lane at UAT · the FY-rollover check in the first April week · `runDailyClose` joins Plan 11's pg-boss list as the SIXTH unscheduled sweep · Plan 09 consumes `payment.received`/`payment.refunded` for the accrual ledger · Plan 10 subscribes to `cash_threshold.*`/`variance.flagged`/`day.closed` for owner notifications (the legacy daily-collection message lands there) · IPD phase consumes the advance instrument for deposits and the OPD→IPD carry-forward allocation.
- **Events note:** exactly the 20 D-Events names, all `module: "billing"`; the dispatcher stays unscheduled until Plan 11; no billing realtime topics this plan (screens poll — a deliberate scope line).
