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
  const tariffPaise = ctx.tariff.items[line.serviceId];
  if (tariffPaise === undefined) throw new TariffError("tariff_item_missing", `line ${line.lineId}: no price for ${line.serviceId} in version ${ctx.tariff.versionId}`);
  assertPaise(tariffPaise, "tariff price");

  // C-3: min(tariff, MRP, NPPA ceiling). The hard block IS the min — no path may exceed the ceiling.
  let unitPaise = tariffPaise;
  let regulatedClamp: RegulatedClamp | null = null;
  if (svc.regulated) {
    const rp = ctx.regulatedPrices[line.serviceId];
    if (!rp) throw new TariffError("regulated_price_missing", `line ${line.lineId}: ${line.serviceId} is regulated but has no effective MRP/ceiling row`);
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
  const grossPaise = unitPaise * line.qty;
  assertPaise(grossPaise, "gross");

  const { candidates, winner } = runContest(ctx, line, grossPaise);
  const discountPaise = winner?.amountPaise ?? 0;
  const taxableBasePaise = grossPaise - discountPaise;

  const cfg = ctx.gst.categories[svc.category];
  if (!cfg) throw new TariffError("gst_config_missing", `no gst_config row for category "${svc.category}"`);
  const gst = computeGst({ cfg, settings: ctx.gst.settings, line, taxableBasePaise, qty: line.qty });

  return {
    lineId: line.lineId, serviceId: svc.id, serviceName: svc.name, category: svc.category,
    qty: line.qty, unitPaise, grossPaise, regulatedClamp, candidates, winner,
    discountPaise, taxableBasePaise, gst, netPaise: taxableBasePaise + gst.cgstPaise + gst.sgstPaise,
  };
}
