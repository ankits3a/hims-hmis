# Pharmacy P1 — a medicine is sold at its printed MRP, and the GST is inside it (2026-09-16)

**Lane** `formulary` worktree (`/opt/hmis-lanes/formulary/hmis`), branch
`lane/pharmacy-gst-inclusive`, cut from `origin/main` @ `e12cebae`. Opened under the owner's
instruction of 2026-09-16 (night): *"keep working towards the milestone & goals one by one in the
pharmacy module inside the roadmap … Once the Pharmacy module is built based on roadmap, I will
deploy."*

**Why this first.** ROADMAP-v2 and the pharmacy launch notes name exactly one blocker for opening
the counter: GST on tax-inclusive MRP. Everything else on the pharmacy list is either built (16c)
or gated (16d on IPD, 16e on the interaction-dataset licence, 16f on live data and a gateway).

---

## 1. THE DEFECT, MEASURED ON `origin/main`

The chain for a counter sale:
1. `pharmacy/price.ts` `priceForBatch` sets `batchUnitPaise` to the printed MRP per base unit, and
   `capUnitPaise` to `min(MRP, NPPA ceiling)` per base unit.
2. The tariff engine sets `unitPaise` to `min(version price, batchUnitPaise, capUnitPaise)`.
3. `tariff/pricing.ts` computes `taxableBasePaise = gross − discount` and `netPaise = taxable + CGST +
   SGST`, with the GST **added on top**.

So a 12% item with a printed MRP of ₹100 bills **₹112**, above the price printed on the strip. The
only configuration that bills the MRP today is `exempt: true` on the category (`seed-tariff.ts`,
marked `DEV PLACEHOLDER — CA sign-off required`), and that reports zero output tax. The runbook's
§2.2 commissioning step, "set the real slabs", arms the overcharge.

## 2. THE LAW, AND THE HOUSE DECISIONS TAKEN UNDER IT

Owner ruling 2026-09-16: *"use great indian hospital standards whenever in confusion"*. This is
the owner's own ruling class (law). Nothing below is a new policy; each line is what the statute
already says or what follows from it. The **rates** stay with the CA (§19), as before.

- **L1. A printed MRP includes all taxes.** The Legal Metrology (Packaged Commodities) Rules, 2011
  define the retail sale price as the maximum price inclusive of all taxes. A medicine may not be
  sold above it.
- **L2. An NPPA ceiling price is notified before GST.** NPPA notifications under DPCO 2013 state
  the ceiling "exclusive of Goods and Services Tax applicable, if any". The lawful maximum for a
  scheduled formulation is therefore `ceiling + GST at its rate`.
- **DECIDED P1-1.** On a pharmacy line, every price term is compared **on the inclusive basis**:
  the batch MRP as printed, the ceiling converted (`floor(ceiling × (1 + rate))`, so rounding can
  only favour the patient), and the hospital's own tariff price for a drug, which is quoted as what
  the patient pays. The charge is the lowest of these, and the patient pays exactly that.
- **DECIDED P1-2.** The taxable value and the tax are **back-calculated** from the charged
  (post-discount) amount.
  - Each half is `CGST = SGST = round(charged × rate / (2 × (1 + rate)))`, and the taxable value is
    `charged − CGST − SGST`.
  - So `net == charged`, exactly, and the halves are equal.
  - For about 15% of amounts, no equal-halves split lands exactly on `taxHead(taxable)` (measured by
    brute force over ₹0–₹3,000 at 5%, 12%, 18% and 28%): the parity of `charged` forbids it. The
    difference is then at most 1 paisa per half, and that bound is pinned by a test.
- **DECIDED P1-3.** An exempt category, or a composite healthcare supply, charges the same amount
  with no tax: the taxable value is the whole charge.
- **DECIDED P1-4. It is a per-line flag, not a category property.** `InvoiceLineInput.taxInclusive`
  is admitted only on a `pharmacy*` category, like `batchUnitPaise`. Only the pharmacy counter sets
  it.
  - Tariff, billing and partners goldens use the `pharmacy` category as a generic taxable stand-in
    (g01, g03, g07, g08 and others). Changing the category's meaning would rewrite goldens this
    lane does not own, and a flag keeps every other line exactly as it was.
- **DECIDED P1-5. The regulated-price path converts too.** A `regulated_prices.ceiling_paise` on a
  tax-inclusive line is converted the same way (L2). A regulated `mrp_paise` is an MRP (L1) and is
  used as it stands.

## 3. TASKS

- **T1 (tariff, additive).**
  - `InvoiceLineInput.taxInclusive?: boolean`.
  - `money.ts`: `inclusiveTaxHead`, `inclusiveOf`.
  - `pricing.ts`: the back-calculation, the regulated-ceiling conversion, and the refusal
    `tax_inclusive_not_allowed` on a non-pharmacy line.
  - No existing expectation changes.
- **T2 (pharmacy).**
  - `priceForBatch` takes a required `taxRateBps`. It converts the ceiling and returns the inclusive
    ceiling beside the notified one.
  - `bill.ts` reads the category's configured rate (`listGstCategories`) and sets
    `taxInclusive: true`. The line's `price_winner` needs no change: a won ceiling arrives as the
    caller's cap, and that already maps to `ceiling`.
  - Fixture file and counter tests updated.
- **T3 (prose).** The go-live runbook's §2.2: setting a real slab is now safe. The seed's
  placeholder comment gets the same correction.

## 3.1 AS BUILT, AND WHAT PROVES IT

- **Tariff.**
  - `taxInclusive` on `InvoiceLineInput`.
  - `inclusiveTaxHead` and `inclusiveOf` in `money.ts`.
  - `flatExemption` in `gst.ts`: the one exemption predicate. `computeGst` and the engine both ask
    it, so there is no second copy.
  - The engine reads the GST config early **only for an inclusive line**, so every other line keeps
    its refusal order.
  - `serviceCategoriesByIds`: a bounded read for the category of the services asked for.
- **Pharmacy.**
  - `priceForBatch` takes a required `taxRateBps` and returns `ceilingInclusivePaisePerBase`.
  - `batchTermsPerBase` is the rate-free part, used by hand-over, whose ledger event records the
    MRP as printed and the ceiling as notified.
  - `bill.ts` reads each line's configured rate (0 when exempt) and sets `taxInclusive`.
- **The pinned bill** (`t4.test.ts`) used to assert ₹268.80 for twenty tablets printed at ₹240.00.
  It now asserts ₹240.00, with the carve-out (₹214.28 + ₹12.86 + ₹12.86). The ceiling-capped line
  is unchanged at ₹31.50, now an inclusive ₹10.50 a tablet.
- **Engine tests.**
  - 7 new: 12%, 5%, exempt and composite, discount, regulated ceiling, the refusal, and a property
    over 4 rates × 2,858 amounts (net equals charged, halves equal, each half within 1 paisa).
  - Every existing tariff, billing and partners golden is unchanged.
  - 104 suites and 1,098 tests are green: tariff, pharmacy, billing, partners, OT, materials, the
    pharmacy e2e and seeds, and the module census.
- **Mutants (8, predicted, all killed):**

| # | mutant | predicted | result |
|---|---|---|---|
| G1 | tax added, not carved | 5 engine tests | **4**: the ceiling test's net is 8,960 either way. Prediction wrong by one; killed |
| G2 | regulated ceiling not converted | ceiling test | 1 |
| G3 | ceiling rounded up | 5% fixture | 1 |
| G4 | `price.ts` compares the notified ceiling | between-ceiling fixture | 2 (A2 property too) |
| G5 | the bill drops the flag | t4 | 1 |
| G6 | the bill converts at nil | t4 | 1 |
| G7 | guard open | refusal test | 1 |
| G8 | a composite supply still carved | exempt/composite test | 1 |

## 4. NAMED, NOT BUILT

- **Implants (Plan 15, OT).** An implant's MRP is also tax-inclusive (L1), and a stent's or knee's
  NPPA ceiling is notified before GST (L2). The OT discharge bill prices from the same engine,
  without the flag. That is the OT module's to take up, and it is reported to the owner.
- **Rupee rounding of the invoice total** (`roundTotalToRupee`) can round a counter bill up by up
  to 49 paise, above the sum of the MRPs. It is billing's rule, and it applies to every counter.
- **The CA still signs the rates** (which slab each medicine is in). This phase changes only how a
  rate is applied.
