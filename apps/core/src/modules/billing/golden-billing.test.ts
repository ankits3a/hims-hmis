import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { couponSource, membershipSource } from "../membership";
import { manualDiscountSource, priceInvoiceLines, standingRuleSource } from "../tariff";
import { creditShare } from "./credit-share";
import { settlementState } from "./settlement";
import { totalInvoice } from "./totals";
import type { ResolvedInstruments } from "../membership";
import type { PricedLine, PricingContext } from "../tariff";

/**
 * The Billing Fixture Book (plan 08 Task 2), following the shipped tariff golden harness: every fixture
 * is zod-parsed at load, `workings` carries the hand derivation and is mandatory, and the set is pinned
 * by a NAME MANIFEST rather than a count — a count passes a renamed, duplicated or gutted fixture
 * (the tariff §13 residual-gap lesson). Every expected value comes from the plan document's own
 * derivations; none was read back from a run.
 */
const paise = z.number().int().nonnegative();
const workings = z.string().min(20); // a fixture without real arithmetic shown FAILS to parse
const specRefs = z.array(z.string()).min(1);

const candidate = z.object({
  sourceKey: z.string(), ruleKey: z.string().nullable(), kind: z.enum(["percent_bps", "flat_paise"]),
  discountCategory: z.enum(["charity", "scheme", "negotiated_corporate", "employee"]).nullable(),
  amountPaise: paise, reason: z.string(), requiresApproval: z.boolean(),
  rejected: z.object({ code: z.enum(["over_cap", "unknown_category"]), detail: z.string() }).nullable(),
});
const pricedLine = z.object({
  lineId: z.string(), serviceId: z.string(), serviceName: z.string(), category: z.string(),
  qty: z.number().int().positive(), unitPaise: paise, grossPaise: paise,
  regulatedClamp: z.object({
    boundApplied: z.enum(["mrp", "ceiling"]), tariffPaise: paise,
    mrpPaise: paise.nullable(), ceilingPaise: paise.nullable(),
  }).nullable(),
  candidates: z.array(candidate), winner: candidate.nullable(),
  discountPaise: paise, taxableBasePaise: paise,
  gst: z.object({
    sacCode: z.string(), rateBps: z.number().int().nonnegative(), exempt: z.boolean(),
    exemptReason: z.enum(["category_exempt", "composite_healthcare", "room_rent_at_or_below_threshold"]).nullable(),
    cgstPaise: paise, sgstPaise: paise,
  }),
  netPaise: paise,
});
const invoiceTotals = z.object({
  grossPaise: paise, discountPaise: paise, taxableBasePaise: paise, cgstPaise: paise, sgstPaise: paise,
  taxableTurnoverPaise: paise, exemptTurnoverPaise: paise,
  taxSummary: z.array(z.object({
    sacCode: z.string(), rateBps: z.number().int().nonnegative(), exempt: z.boolean(),
    taxableBasePaise: paise, cgstPaise: paise, sgstPaise: paise,
  })).min(1),
  rawTotalPaise: paise, netPayablePaise: paise, roundingPaise: z.number().int(),
});

const fixtureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("totals"), name: z.string(), specRefs, workings,
    meta: z.object({ buyerGstin: z.string(), buyerLegalName: z.string() }).optional(),
    lines: z.array(pricedLine).min(1), expected: invoiceTotals,
  }),
  z.object({
    kind: z.literal("credit"), name: z.string(), specRefs, workings,
    line: z.object({
      grossPaise: paise, discountPaise: paise, taxableBasePaise: paise,
      cgstPaise: paise, sgstPaise: paise, qty: z.number().int().positive(),
    }),
    steps: z.array(z.object({
      prevQty: z.number().int().nonnegative(), addQty: z.number().int().positive(),
      expected: z.object({
        grossPaise: paise, discountPaise: paise, taxableBasePaise: paise,
        cgstPaise: paise, sgstPaise: paise, netPaise: paise,
      }),
    })).min(1),
  }),
  z.object({
    kind: z.literal("settlement"), name: z.string(), specRefs, workings,
    cases: z.array(z.object({
      netPayablePaise: paise, creditedPaise: paise, allocatedPaise: paise,
      expected: z.object({ state: z.enum(["unpaid", "partial", "settled"]), outstandingPaise: paise }),
    })).min(1),
  }),
]);

const MONEY_FIELDS = ["grossPaise", "discountPaise", "taxableBasePaise", "cgstPaise", "sgstPaise"] as const;

const dir = join(__dirname, "golden", "fixtures");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const load = (file: string): z.infer<typeof fixtureSchema> => fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));

test("the Fixture Book is complete and NAMED — ten fixtures, each carrying its pinned name", () => {
  expect(files).toEqual([
    "b01.json", "b02.json", "b03.json", "b04.json", "b05.json",
    "b06.json", "b07.json", "b08.json", "b09.json", "b10.json",
  ]);
  expect(files.map((file) => load(file).name)).toEqual([
    "b01 — invoice heads are the SUM of the line heads (§15.1)",
    "b02 — two line heads, never one GST total split in half (§15.2)",
    "b03 — §170 rupee rounding applied once, on the raw total",
    "b04 — settlement state is derived: unpaid, partial, settled, over-collected",
    "b05 — cumulative credit shares exhaust a line of 100 over qty 3",
    "b06 — the fully worked partial refund: three steps of 3360 on a 10080 line",
    "b07 — mixed exempt and taxable lines: the turnover split nets line discounts",
    "b08 — zero-discount identity: rawTotal is Σ line netPaise",
    "b09 — GSTR-1 B2B grouping: two like lines merge, the head sum is not the group recompute",
    "b10 — a rupee-exact invoice rounds to itself",
  ]);
});

test("the fixtures directory contains NOTHING but the manifest — a .JSON straggler or stray file cannot hide", () => {
  // `files` filters .endsWith(".json") (case-sensitive), so a b99-rogue.JSON would otherwise ship invisibly.
  expect([...readdirSync(dir)].sort()).toEqual(files);
});

for (const file of files) {
  const fixture = load(file);
  test(`billing golden ${file}: ${fixture.name}`, () => {
    if (fixture.kind === "totals") {
      const lines: PricedLine[] = fixture.lines;
      expect(totalInvoice(lines)).toEqual(fixture.expected); // FULL deep-equal — no partial matching
      return;
    }
    if (fixture.kind === "credit") {
      const sums = { grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0 };
      let creditedQty = 0;
      for (const step of fixture.steps) {
        expect(step.prevQty).toBe(creditedQty); // the fixture's own steps must be consecutive
        const share = creditShare(fixture.line, step.prevQty, step.addQty);
        expect({ ...share, netPaise: share.taxableBasePaise + share.cgstPaise + share.sgstPaise }).toEqual(step.expected);
        for (const field of MONEY_FIELDS) sums[field] += share[field];
        creditedQty += step.addQty;
      }
      // The remainder-to-last invariant: steps covering the whole qty exhaust every money field EXACTLY.
      expect(creditedQty).toBe(fixture.line.qty);
      expect(sums).toEqual({
        grossPaise: fixture.line.grossPaise, discountPaise: fixture.line.discountPaise,
        taxableBasePaise: fixture.line.taxableBasePaise, cgstPaise: fixture.line.cgstPaise, sgstPaise: fixture.line.sgstPaise,
      });
      return;
    }
    for (const settlementCase of fixture.cases) {
      expect(settlementState(settlementCase.netPayablePaise, settlementCase.creditedPaise, settlementCase.allocatedPaise))
        .toEqual(settlementCase.expected);
    }
  });
}

// =============================================================================================
// PLAN 09 T4 — the composed invoice, hand-derived. DD2's two extra sources reach `totalInvoice`.
// =============================================================================================

/**
 * WHAT THIS ADDS THAT THE FIXTURE BOOK ABOVE DOES NOT, and why it is inline rather than a
 * fixture file.
 *
 * The ten fixtures above pin the INVOICE-TOTALS arithmetic over lines the engine produced with
 * Plan 06's two sources. Plan 09 appends two more (DD2), and the question this case answers is the
 * one neither book asked: does a member benefit reach the GST heads and the §170 rounding, or only
 * the discount column? It does — the taxable line's heads are computed on the POST-discount base,
 * and the invoice's own rupee rounding moves by 40 paise because of it.
 *
 * `modules/membership/golden/` (T2) owns the per-LINE contest fixtures and its manifest is pinned
 * by NAME in that suite; the fixtures directory here is pinned the same way, so a new JSON file
 * would fail two shipped assertions in files this task does not own. The case is therefore written
 * inline, with its workings in the comment where a fixture would have carried them.
 *
 * ═══ THE WORKINGS ═══
 *
 *   divHalfUp(n, d) = floor((2n + d) / 2d) · percentAmount(g, bps) = divHalfUp(g × bps, 10 000)
 *   taxHead(base, rateBps) = divHalfUp(base × rateBps, 20 000)
 *
 *   line 1 — consultation, EXEMPT, gross 50 000
 *     membership 2 000 bps → percentAmount(50 000, 2 000) = divHalfUp(100 000 000, 10 000) = 10 000
 *     the coupon is scoped to "pharmacy" and proposes nothing here
 *     winner 10 000 → base 40 000 · heads 0 (exempt) · net 40 000
 *   line 2 — pharmacy, TAXABLE at 1 200 bps, gross 30 000
 *     the membership is scoped to "consultation" and proposes nothing here
 *     coupon 1 000 bps → percentAmount(30 000, 1 000) = divHalfUp(30 000 000, 10 000) = 3 000
 *     winner 3 000 → base 27 000
 *     taxHead(27 000, 1 200) = divHalfUp(32 400 000, 20 000) = floor(1 620.5) = 1 620 per head
 *     net 27 000 + 1 620 + 1 620 = 30 240
 *
 *   invoice: gross 80 000 · discount 13 000 · base 67 000 · cgst 1 620 · sgst 1 620
 *            turnover split 27 000 taxable / 40 000 exempt
 *            raw total 40 000 + 30 240 = 70 240
 *            §170: divHalfUp(70 240, 100) × 100 = floor(702.9) × 100 = 70 200, rounding −40
 *
 * The rounding is the load-bearing number: with NO member benefit the raw total is 50 000 + 30 000
 * + 1 800 + 1 800 = 83 600, which is already rupee-exact and rounds by ZERO. A composition that
 * reached the discount column and not the heads could not produce −40.
 */
const SVC_EXEMPT = "svc-consultation";
const SVC_TAXABLE = "svc-pharmacy";

function composedContext(): PricingContext {
  const resolved: ResolvedInstruments = {
    patientId: "golden-patient",
    memberships: [{
      instanceId: "golden-instance", planId: "golden-plan", planTitle: "Invented Member Card",
      cardCode: "GB-0001", status: "active",
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-12-31T00:00:00Z"),
      benefits: [{
        benefitKey: "consult-visits", title: "Member consultation benefit", kind: "percent_bps",
        value: 2_000, capPaise: null, scope: { serviceCategories: ["consultation"], serviceIds: null },
      }],
    }],
    coupons: [{
      couponId: "golden-coupon", code: "INV-CPN-GB", title: "Invented pharmacy coupon", instanceId: null,
      benefit: {
        benefitKey: "INV-CPN-GB", title: "Invented pharmacy coupon", kind: "percent_bps",
        value: 1_000, capPaise: null, scope: { serviceCategories: ["pharmacy"], serviceIds: null },
      },
      minBillPaise: 0,
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-12-31T00:00:00Z"),
      weekdayMask: 127, windowStartMinute: null, windowEndMinute: null, status: "active",
    }],
    billGrossPaise: 80_000, // the composer's own first pass: 50 000 + 30 000, before any adjustment
  };
  return {
    asOf: new Date("2026-09-01T06:00:00Z"),
    tariff: { versionId: "golden-version", versionNo: 1, items: { [SVC_EXEMPT]: 50_000, [SVC_TAXABLE]: 30_000 } },
    services: {
      [SVC_EXEMPT]: { id: SVC_EXEMPT, code: "OPD-CONSULT", name: "Consultation", category: "consultation", regulated: false, active: true },
      [SVC_TAXABLE]: { id: SVC_TAXABLE, code: "PHARM", name: "Dispensed item", category: "pharmacy", regulated: false, active: true },
    },
    regulatedPrices: {},
    gst: {
      categories: {
        consultation: { category: "consultation", sacCode: "999312", exempt: true, rateBps: 1_800, specialRule: null, thresholdPaise: null },
        pharmacy: { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1_200, specialRule: null, thresholdPaise: null },
      },
      settings: { compositeHealthcareExempt: true, caSigned: false },
    },
    rules: [],
    manualCaps: {},
    // DD2's order, and the ORDER IS A RULING: the contest sorts by amount first and the array
    // position decides EXACT ties only. `invoices.ts` builds this same array at the money moment.
    sources: [standingRuleSource, manualDiscountSource, membershipSource(resolved), couponSource(resolved)],
    tags: [],
  };
}

test("b11 — a composed member benefit reaches the GST heads and the §170 rounding, not just the discount column", () => {
  const lines = priceInvoiceLines(composedContext(), [
    { lineId: "L1", serviceId: SVC_EXEMPT, qty: 1 },
    { lineId: "L2", serviceId: SVC_TAXABLE, qty: 1 },
  ]);

  expect(lines[0]!.winner).toMatchObject({ sourceKey: "membership", ruleKey: "consult-visits", amountPaise: 10_000 });
  expect(lines[1]!.winner).toMatchObject({ sourceKey: "coupon", ruleKey: "INV-CPN-GB", amountPaise: 3_000 });

  expect(totalInvoice(lines)).toEqual({ // FULL deep-equal — no partial matching
    grossPaise: 80_000,
    discountPaise: 13_000,
    taxableBasePaise: 67_000,
    cgstPaise: 1_620,
    sgstPaise: 1_620,
    taxableTurnoverPaise: 27_000,
    exemptTurnoverPaise: 40_000,
    taxSummary: [
      { sacCode: "999312", rateBps: 1_800, exempt: true, taxableBasePaise: 40_000, cgstPaise: 0, sgstPaise: 0 },
      { sacCode: "3004", rateBps: 1_200, exempt: false, taxableBasePaise: 27_000, cgstPaise: 1_620, sgstPaise: 1_620 },
    ],
    rawTotalPaise: 70_240,
    netPayablePaise: 70_200,
    roundingPaise: -40,
  });
});

test("b11 control — with NO instruments composed the same two lines round by ZERO", () => {
  // The negative control the case above needs: if the benefit did not reach the heads, −40 would
  // be indistinguishable from an arithmetic accident of the fixture's own prices.
  const ctx = composedContext();
  const bare = priceInvoiceLines({ ...ctx, sources: [standingRuleSource, manualDiscountSource] }, [
    { lineId: "L1", serviceId: SVC_EXEMPT, qty: 1 },
    { lineId: "L2", serviceId: SVC_TAXABLE, qty: 1 },
  ]);
  expect(bare.every((line) => line.winner === null)).toBe(true);
  expect(totalInvoice(bare)).toMatchObject({
    discountPaise: 0, cgstPaise: 1_800, sgstPaise: 1_800, rawTotalPaise: 83_600,
    netPayablePaise: 83_600, roundingPaise: 0,
  });
});
