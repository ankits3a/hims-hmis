import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { creditShare } from "./credit-share";
import { settlementState } from "./settlement";
import { totalInvoice } from "./totals";
import type { PricedLine } from "../tariff";

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
