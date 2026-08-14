import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureSchema, contextFromFixture } from "./fixture-schema";
import { priceInvoiceLines } from "./pricing";
import { simulateRevision } from "./simulation";
import { TariffError } from "./errors";
import { taxHead } from "./money";
import type { GstCategoryConfig, GstSettings, InvoiceLineInput, PricedLine, PricedLineGst } from "./types";

const dir = join(__dirname, "golden", "fixtures");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

test("the fixture set is complete (an empty dir must never pass vacuously)", () => {
  expect(files.length).toBe(13); // g01–g13 (T6's 12 price/price_error fixtures + g12's simulate fixture from T7); Plans 08/09 bump again as they add cases
});

for (const file of files) {
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
  test(`golden ${file}: ${fixture.name}`, () => {
    const ctx = contextFromFixture(fixture.config);
    if (fixture.kind === "price_error") {
      expect.assertions(2);
      try { priceInvoiceLines(ctx, fixture.lines); } catch (e) {
        expect(e).toBeInstanceOf(TariffError);
        expect((e as TariffError).code).toBe(fixture.expected.errorCode);
      }
      return;
    }
    if (fixture.kind === "simulate") {
      const draftCtx = contextFromFixture(fixture.draftConfig);
      expect(simulateRevision(ctx, draftCtx, fixture.lines)).toEqual(fixture.expected.report);
      return;
    }
    const priced = priceInvoiceLines(ctx, fixture.lines);
    expect(priced.length).toBe(fixture.expected.length);
    priced.forEach((line, i) => expect(line).toEqual(fixture.expected[i]?.line)); // FULL deep-equal — no partial matching
  });
}

/**
 * The mutation check (ledger §5 mutant pattern): the mutant lives HERE, in the test file — no shipped
 * file is copied, moved, edited or temporarily broken to prove the harness has teeth. This is a copy of
 * computeGst's body (gst.ts) with ONE deletion: the `if (cfg.exempt) return …category_exempt` branch.
 */
function mutantComputeGst(args: {
  cfg: GstCategoryConfig; settings: GstSettings; line: InvoiceLineInput; taxableBasePaise: number; qty: number;
}): PricedLineGst {
  const { cfg, settings, line, taxableBasePaise, qty } = args;
  const zero = { sacCode: cfg.sacCode, rateBps: cfg.rateBps, cgstPaise: 0, sgstPaise: 0 };
  if (line.supplyContext === "composite_healthcare" && settings.compositeHealthcareExempt) {
    return { ...zero, exempt: true, exemptReason: "composite_healthcare" };
  }
  // MUTATION: the `if (cfg.exempt) return { ...zero, exempt: true, exemptReason: "category_exempt" };` branch is deleted.
  if (cfg.specialRule === "room_rent_daily_threshold") {
    if (cfg.thresholdPaise === null) throw new TariffError("gst_config_invalid", `category "${cfg.category}" has the room-rent rule but no thresholdPaise`);
    if (!(taxableBasePaise > cfg.thresholdPaise * qty)) {
      return { ...zero, exempt: true, exemptReason: "room_rent_at_or_below_threshold" };
    }
  }
  const head = taxHead(taxableBasePaise, cfg.rateBps);
  return { sacCode: cfg.sacCode, rateBps: cfg.rateBps, exempt: false, exemptReason: null, cgstPaise: head, sgstPaise: head };
}

test("the harness kills a no-exemption mutant", () => {
  const g01 = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, "g01-baseline-exempt.json"), "utf8")));
  if (g01.kind !== "price") throw new Error("g01 must be a price fixture");
  const ctx = contextFromFixture(g01.config);
  const line = g01.lines[0];
  const cfg = ctx.gst.categories["consultation"];
  const expectedGst = (g01.expected[0]?.line as PricedLine | undefined)?.gst;
  if (!line || !cfg || !expectedGst) throw new Error("g01 must carry one consultation line with a full expected gst block");
  // G01's would-be rate is 1800bps on a base of 50000: a mutant that ignores `exempt` charges
  // divHalfUp(50000 × 1800, 20000) = 4500 per head where the fixture's Book value is 0 — so G01's
  // full deep-equal kills it. That is what makes the nonzero would-be rate load-bearing (§3.14).
  const mutantGst = mutantComputeGst({ cfg, settings: ctx.gst.settings, line, taxableBasePaise: 50000, qty: 1 });
  expect(mutantGst.cgstPaise).toBe(4500);
  expect(expectedGst.cgstPaise).toBe(0);
  expect(mutantGst).not.toEqual(expectedGst);
});
