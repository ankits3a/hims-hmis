# tariff — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/tariff.md`. Paths are relative to `apps/core/src/modules/tariff/` unless they start
with a module name or `kernel/`. Citations name a file and a symbol, never a line number.
Update this file in the same PR when you change a flow, an invariant or a trap below.
Owner rulings on prices and fees: `docs/decisions/` (fee switches and consult prices: 0021).

## 1. Purpose

Owns the price list (services, versioned tariff items, regulated MRP/ceiling rows), GST config and discount rules.
Its engine is a pure, synchronous pricer: `PricingContext` + invoice lines in, `PricedLine[]` out. Billing and others compose it; tariff has no module dependencies.

## 2. Key files

- `pricing.ts` — `priceLine`: the whole per-line pipeline (checks, clamps, contest, GST). `priceInvoiceLines` is just a `map`.
- `context.ts` — `loadPricingContext` (all I/O, takes `Db`, never `Tx`) and `validateTariffConfig` (go-live gate that smoke-prices every active service).
- `contest.ts` — `runContest`, `standingRuleSource` (rules table) and `manualDiscountSource` (caller's ask vs caps).
- `gst.ts` — `computeGst`, `flatExemption`. `gst-config.ts` — read/upsert of `gst_config` and `gst_settings`.
- `money.ts` — all integer paise math: `assertPaise`, `divHalfUp`, `taxHead`, `inclusiveTaxHead`, `inclusiveOf`, `roundTotalToRupee`.
- `versions.ts` — draft/submit/activate state machine, `resolveActiveTariffVersion`, `activePricePaise`.
- `approval-types.ts` — registers the `tariff_revision` approval type and its `approval_tariff_revision` workflow definition.
- `services.ts` — services CRUD, `appendRegulatedPrice` (append-only), `resolveRegulatedPrices`, `listPriceList`.
- `rules.ts` — `adjustment_rules` CRUD and `loadRuleConfig`. `simulation.ts` — `simulateRevision` (old vs draft context).
- `types.ts` — `PricingContext`, `InvoiceLineInput`, `PricedLine`, `RegulatedClamp`. `errors.ts` — `TariffError` codes and HTTP mapping.
- `tariff.controller.ts` — routes and permission strings. `manifest.ts` — the five `tariff.*` permissions and the service search provider.

## 3. Main flows

### 3a. Price an invoice line
Entry: `loadPricingContext(db, {at, tags})` in `context.ts`, then `priceInvoiceLines(ctx, lines)` in `pricing.ts` (caller: `billing/invoices.ts`).

1. `loadPricingContext` resolves the active version (`resolveActiveTariffVersion`), or a pinned `tariffVersionId`. A non-activated version needs `allowDraft`, else `version_not_active`.
2. It loads items, services, `resolveRegulatedPrices(at)`, GST categories and settings, and `loadRuleConfig(at)`. `ctx.sources` is `[standingRuleSource, manualDiscountSource]`.
3. Callers extend `ctx.sources` by spread (`billing/invoices.ts`: membership, coupon, item-discount, sale-discount sources). Array order is the tie-break precedence.
4. `priceLine` validates qty (positive safe integer), service known and active, `batchUnitPaise` and `taxInclusive` allowed only for categories starting `pharmacy`.
5. Unit price = version item price. If `batchUnitPaise` is lower, or the item is missing, it stands in (`boundApplied: "batch_mrp"`). A missing item with no batch price is `tariff_item_missing`.
6. Regulated clamp (see 3c), then `capUnitPaise` clamp (`caller_cap`). Gross = unit × qty.
7. `runContest(ctx, line, gross)`: every source proposes, rejected or zero candidates are dropped, and ONE winner is picked (highest amount; ties by source order, then `ruleKey`, nulls last). Discounts never stack.
8. Charged = gross − winner amount. Then `computeGst` (CGST = SGST = `taxHead`) or the inclusive path. `netPaise` = taxable base + CGST + SGST.
9. The caller rounds the invoice total ONCE with `roundTotalToRupee` (`billing/totals.ts`).

Contest of adjustments:
- `manualDiscountSource` rejects an ask over the cap (`over_cap`) or with no cap row (`unknown_category`). A rejected candidate records the amount ASKED, not the clamped one.
- `requiresApproval` is set when the amount exceeds `approvalAboveBps`.

### 3b. Draft → submit → approve → activate
Routes: `tariff.controller.ts`, `versions/:id/...`.

1. Draft: `createDraftVersion` (next `versionNo`, optional `copyFromVersionId` copies items). `setTariffItem` upserts items, draft only. Permission `tariff.versions.draft`.
2. Submit: `submitVersion` requires `draft` and ≥1 item. A conditional UPDATE flips it to `submitted`, then `requestApproval(kernel)` with subject `tariff_version`, and `approvalId` is stored (no FK).
3. Approve: tariff has no approve function. The kernel `approveRequest`/`rejectRequest` (`kernel/approvals/decisions`) decide; the approver role is `owner`. A caller in this repo: `billing/consult-prices.ts` `decideConsultPrices`.
4. Activate: `activateVersion(db, actor, id, effectiveFrom)` — permission `tariff.versions.activate`. Checks in order:
   - status is `submitted`;
   - approval exists and is not `pending`;
   - approval subject equals this version;
   - actor is neither drafter nor submitter (`sod_drafter_activator`);
   - a rejected approval marks the version `rejected` and throws `approval_rejected`.
5. Inside `withTx`: row lock on all `submitted`/`activated` versions (`order by id for update`), `effectiveFrom` strictly greater than every other activated version's, conditional UPDATE to `activated`, then event `tariffRevisionApplied`.
6. Direct road: `activateVersionDirectly` skips approval. It needs a reason, a `user` actor, and a draft made by the SAME actor. Event `tariffRevisionAppliedDirectly`. Only caller: `billing/consult-prices.ts` `changeConsultPricesNow` (owner ruling 2026-10-05).

### 3c. Regulated price clamps
In `priceLine`, only for `svc.regulated`:
- Missing `regulated_prices` row, or a row with neither bound, throws `regulated_price_missing`.
- `unitPaise = min(tariff, MRP, ceiling)`. Each bound that is strictly lower becomes the unit price, and `regulatedClamp.boundApplied` records which.
- Rows come from `resolveRegulatedPrices(at)`: latest `effectiveFrom ≤ at`, ties by `seq`. `appendRegulatedPrice` only inserts, and needs at least one bound.
- Inclusive pharmacy lines convert the ceiling with `inclusiveOf` before comparing. The MRP is NOT converted.
- `capUnitPaise` is applied after, to any service, with `<` not `<=`.

## 4. Invariants and traps

- **Paise only.** `assertPaise` (`money.ts`) rejects non-integers and negatives. `priceLine` re-asserts `gross` and the taxable base, so a bad custom source fails loudly.
- **Rounding.** `divHalfUp` is integer-only, half up. `taxHead` = `divHalfUp(base × bps, 20000)` per head. `roundTotalToRupee` rounds once per document. Credit notes round their own total (comment in `billing/credit-notes.ts`).
- **Inclusive GST.** Allowed only for `pharmacy*` categories (`tax_inclusive_not_allowed`). Head = `inclusiveTaxHead`; taxable = charged − 2 × head, so the three parts sum exactly (gap ≤ 1 paisa a head, see `money.ts` comment). A category with `specialRule` refuses inclusive (`gst_config_invalid`). `inclusiveOf` floors; it may only lower a ceiling.
- **Exempt.** `flatExemption`: composite supply (setting `compositeHealthcareExempt`) or `cfg.exempt`. Room rent is taxable only if the charged amount > `thresholdPaise × qty` (post-discount; pinned by golden G13 in `golden.test.ts`).
- **Context is read outside transactions.** `loadPricingContext` and `loadRuleConfig` take `Db`. Callers load before their tx, then price purely (`billing/invoices.ts`, `ot/booking.ts`).
- **Activation timing.** `activateVersion` does not require `effectiveFrom` ≥ now; only strict monotonicity. A future date is legal. `resolveActiveTariffVersion` picks the latest `activated` with `effectiveFrom ≤ at`.
- **Approval binding.** `approval_id` has no FK. The subject check in `activateVersion` is the only guard. Do not reorder the subject, SoD and rejected checks (comments cite audit B1).
- **Locking.** Do not add a separate target-row lock before the set lock in `activateVersion` (deadlock 40P01). `versions.contention.test.ts` guards this.
- **Approval type must be registered.** `registerTariffApprovalTypes` runs from `scripts/seed-tariff.ts`. Without it `submitVersion` throws `unknown_type`.
- **Rule windows.** `loadRuleConfig` skips rows outside `validFrom`/`validTo` and parses params with zod. Corrupt params throw at billing time by design. Two active manual caps for one category: the later row wins.
- **Contest rules.** Rules are pre-capped at gross. The manual cap compares the ASK with exact integer math (`raw × 10000 > maxBps × gross`), never rounded.
- **Errors.** Throw `TariffError` with a code; HTTP status comes from `tariffHttpStatus`. Other modules' http layers map it (`lab/lab-http.ts`, `radiology/radiology-http.ts`).
- **Go-live gate.** `validateTariffConfig` is used by `kernel/ops/validate.ts` and `scripts/validate-tariff-config.ts`. A new category, regulated service or rule param must pass it.
- **Tests that pin behaviour.** `golden.test.ts` and `test/tariff-lifecycle.e2e.test.ts`. Both are needed to change pricing or the lifecycle.

## 5. Callers outside tariff (via `../tariff` index only)

- `billing/invoices.ts` — `loadPricingContext`, `priceInvoiceLines`, `percentAmount`, `assertPaise`. Extends `ctx.sources`.
- `billing/totals.ts` — `roundTotalToRupee`. `billing/credit-notes.ts` — `loadRuleConfig`, `DISCOUNT_CATEGORIES`, `percentAmount`.
- `billing/consult-prices.ts` — `createDraftVersion`, `setTariffItem`, `submitVersion`, `activateVersion`, `activateVersionDirectly`, `getVersion`, `resolveActiveTariffVersion`, `listServices`.
- `billing/config.ts` — `activePricePaise`. `billing/fee-switches.ts` — `listPriceList`. `billing/sale-discount.ts`, `billing/benefit-sources.ts` — `AdjustmentSource` types.
- `billing/cash-math.ts`, `billing/cash-law.ts`, `billing/receipts.ts`, `billing/refunds.ts`, `billing/sessions.ts`, `billing/credit-share.ts` — `assertPaise`, `divHalfUp`.
- `ot/booking.ts` — `loadPricingContext`, `priceInvoiceLines` (pinned package quote). `ot/bill.ts` — imports `loadPricingContext`.
- `membership/sources.ts`, `membership/instruments.ts`, `membership/entitlements.ts` — `AdjustmentSource`, `percentAmount`, `assertPaise`.
- `partners/sources.ts`, `partners/accrual.ts`, `partners/attribution.ts` — `AdjustmentSource`, `percentAmount`, `divHalfUp`.
- `pharmacy/price.ts` — `inclusiveOf`. `pharmacy/bill.ts` — `listGstCategories`, `serviceCategoriesByIds`. `pharmacy/gst-slab.ts` — `serviceCategoriesByIds`, `updateService`. `pharmacy/sale-items.ts` — `createService`, `listServices`.
- `radiology/setup.ts`, `radiology/advised.ts`, `radiology/supervisor.ts` — `listPriceList` (and `listGstCategories`, `listServices` in setup). `lab/verify.ts` — `TariffError`.
- `kernel/ops/validate.ts` — `validateTariffConfig`. `kernel/modules/manifests.ts`, `kernel/worker/worker.module.ts` — `tariffManifest`.
