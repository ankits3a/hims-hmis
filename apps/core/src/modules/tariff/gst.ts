import { TariffError } from "./errors";
import { taxHead } from "./money";
import type { GstCategoryConfig, GstSettings, InvoiceLineInput, PricedLineGst } from "./types";

export function computeGst(args: {
  cfg: GstCategoryConfig; settings: GstSettings; line: InvoiceLineInput; taxableBasePaise: number; qty: number;
}): PricedLineGst {
  const { cfg, settings, line, taxableBasePaise, qty } = args;
  const zero = { sacCode: cfg.sacCode, rateBps: cfg.rateBps, cgstPaise: 0, sgstPaise: 0 };
  if (line.supplyContext === "composite_healthcare" && settings.compositeHealthcareExempt) {
    return { ...zero, exempt: true, exemptReason: "composite_healthcare" };
  }
  if (cfg.exempt) return { ...zero, exempt: true, exemptReason: "category_exempt" };
  if (cfg.specialRule === "room_rent_daily_threshold") {
    if (cfg.thresholdPaise === null) throw new TariffError("gst_config_invalid", `category "${cfg.category}" has the room-rent rule but no thresholdPaise`);
    // D-3: taxable iff the CHARGED (post-discount) value exceeds threshold × days. Integer-safe; strictly greater
    // matches "exceeding ₹5,000/day". STATED CA ASSUMPTION (§19 gate): post-discount reading — golden G13 pins it.
    if (!(taxableBasePaise > cfg.thresholdPaise * qty)) {
      return { ...zero, exempt: true, exemptReason: "room_rent_at_or_below_threshold" };
    }
  }
  const head = taxHead(taxableBasePaise, cfg.rateBps);
  return { sacCode: cfg.sacCode, rateBps: cfg.rateBps, exempt: false, exemptReason: null, cgstPaise: head, sgstPaise: head };
}
