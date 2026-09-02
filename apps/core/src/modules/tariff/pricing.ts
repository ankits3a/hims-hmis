import { TariffError } from "./errors";
import { assertPaise } from "./money";
import { runContest } from "./contest";
import { computeGst } from "./gst";
import type { InvoiceLineInput, PricedLine, PricingContext, RegulatedClamp } from "./types";

/** PURE + SYNCHRONOUS (§7, §18): no I/O, no clock, no randomness — same ctx+lines in, same PricedLine[] out. */
export function priceInvoiceLines(ctx: PricingContext, lines: InvoiceLineInput[]): PricedLine[] {
  return lines.map((line) => priceLine(ctx, line));
}

function priceLine(ctx: PricingContext, line: InvoiceLineInput): PricedLine {
  if (!Number.isSafeInteger(line.qty) || line.qty <= 0) throw new TariffError("invalid_qty", `line ${line.lineId}: qty must be a positive integer`);
  const svc = ctx.services[line.serviceId];
  if (!svc) throw new TariffError("unknown_service", `line ${line.lineId}: service ${line.serviceId}`);
  if (!svc.active) throw new TariffError("service_inactive", `line ${line.lineId}: service ${line.serviceId}`);
  // PLAN 16c T0b — a `pharmacy*` line may carry its batch MRP as the list price; any other category
  // is refused before a price is even looked up (see `InvoiceLineInput.batchUnitPaise`).
  if (line.batchUnitPaise !== undefined) {
    if (!svc.category.startsWith("pharmacy")) {
      throw new TariffError("batch_price_not_allowed", `line ${line.lineId}: ${line.serviceId} is "${svc.category}", and only a pharmacy line prices from a batch`);
    }
    assertPaise(line.batchUnitPaise, `line ${line.lineId}: batchUnitPaise`);
  }
  const versionPaise = ctx.tariff.items[line.serviceId];
  if (versionPaise === undefined && line.batchUnitPaise === undefined) {
    throw new TariffError("tariff_item_missing", `line ${line.lineId}: no price for ${line.serviceId} in version ${ctx.tariff.versionId}`);
  }
  // `tariffPaise` is what the clamp record calls the starting price: the version's, or the batch's when it stood in.
  const tariffPaise = versionPaise ?? (line.batchUnitPaise as number);
  assertPaise(tariffPaise, "tariff price");

  // C-3: min(tariff, MRP, NPPA ceiling). The hard block IS the min — no path may exceed the ceiling.
  let unitPaise = tariffPaise;
  let regulatedClamp: RegulatedClamp | null = null;
  if (line.batchUnitPaise !== undefined && (versionPaise === undefined || line.batchUnitPaise < versionPaise)) {
    unitPaise = line.batchUnitPaise;
    regulatedClamp = { boundApplied: "batch_mrp", tariffPaise, mrpPaise: null, ceilingPaise: null, batchUnitPaise: line.batchUnitPaise };
  }
  if (svc.regulated) {
    const rp = ctx.regulatedPrices[line.serviceId];
    if (!rp) throw new TariffError("regulated_price_missing", `line ${line.lineId}: ${line.serviceId} is regulated but has no effective MRP/ceiling row`);
    // Defense in depth: appendRegulatedPrice refuses a row with neither bound, but a row that
    // arrives around the API (bulk load, data fix) must not silently no-op the C-3 hard block.
    // Both comparisons are '== null' — undefined from a hand-built context is refused too (audit
    // m5), while a legal bound of 0 paise still survives (0 == null is false).
    if (rp.mrpPaise == null && rp.ceilingPaise == null) {
      throw new TariffError("regulated_price_missing", `line ${line.lineId}: ${line.serviceId} has a regulated_prices row with no MRP and no ceiling`);
    }
    const bounds: { boundApplied: "mrp" | "ceiling"; value: number }[] = [];
    if (rp.mrpPaise !== null) bounds.push({ boundApplied: "mrp", value: rp.mrpPaise });
    if (rp.ceilingPaise !== null) bounds.push({ boundApplied: "ceiling", value: rp.ceilingPaise });
    for (const b of bounds) {
      if (b.value < unitPaise) {
        unitPaise = b.value;
        regulatedClamp = { boundApplied: b.boundApplied, tariffPaise, mrpPaise: rp.mrpPaise, ceilingPaise: rp.ceilingPaise };
      }
    }
  }
  /**
   * PLAN 15 T7 / DD11 — THE CALLER'S BOUND, in the SAME `min` chain and after the regulated ones.
   *
   * It applies to EVERY service, regulated or not, because the case it exists for is an implant
   * whose service is deliberately NOT regulated (Plan 15 F4: `regulated_prices` is keyed by service
   * and an implant's lawful maximum is keyed by batch). Placing it outside the `svc.regulated`
   * branch is therefore the point rather than an oversight.
   *
   * `<` and not `<=`: a cap EQUAL to the tariff changes no price and should not claim a bound was
   * applied — which is exactly the `tariff = MRP = ceiling` coincidence §2.102 warns about, and the
   * reason `bill.ts`'s note can say "tariff" honestly.
   */
  if (line.capUnitPaise !== undefined) {
    assertPaise(line.capUnitPaise, `line ${line.lineId}: capUnitPaise`);
    if (line.capUnitPaise < unitPaise) {
      unitPaise = line.capUnitPaise;
      regulatedClamp = {
        boundApplied: "caller_cap", tariffPaise,
        mrpPaise: regulatedClamp?.mrpPaise ?? null,
        ceilingPaise: regulatedClamp?.ceilingPaise ?? null,
        capUnitPaise: line.capUnitPaise,
        ...(line.batchUnitPaise !== undefined ? { batchUnitPaise: line.batchUnitPaise } : {}),
      };
    } else if (regulatedClamp !== null) {
      regulatedClamp = { ...regulatedClamp, capUnitPaise: line.capUnitPaise };
    }
  }

  const grossPaise = unitPaise * line.qty;
  assertPaise(grossPaise, "gross");

  const { candidates, winner } = runContest(ctx, line, grossPaise);
  const discountPaise = winner?.amountPaise ?? 0;
  const taxableBasePaise = grossPaise - discountPaise;
  // Engine-side belt on D2's "candidates are pre-capped at gross": ctx.sources is an open plugin
  // array (Plan 09 registers more) — a source proposing an over-gross winner must fail LOUDLY
  // here, never flow a negative or fractional base into GST (M3).
  assertPaise(taxableBasePaise, "taxable base");

  const cfg = ctx.gst.categories[svc.category];
  if (!cfg) throw new TariffError("gst_config_missing", `no gst_config row for category "${svc.category}"`);
  const gst = computeGst({ cfg, settings: ctx.gst.settings, line, taxableBasePaise, qty: line.qty });

  return {
    lineId: line.lineId, serviceId: svc.id, serviceName: svc.name, category: svc.category,
    qty: line.qty, unitPaise, grossPaise, regulatedClamp, candidates, winner,
    discountPaise, taxableBasePaise, gst, netPaise: taxableBasePaise + gst.cgstPaise + gst.sgstPaise,
  };
}
