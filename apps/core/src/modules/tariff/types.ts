export type DiscountCategory = "charity" | "scheme" | "negotiated_corporate" | "employee"; // D-8
export const DISCOUNT_CATEGORIES = ["charity", "scheme", "negotiated_corporate", "employee"] as const;

export type ServiceInfo = { id: string; code: string; name: string; category: string; regulated: boolean; active: boolean };
export type GstCategoryConfig = {
  category: string; sacCode: string; exempt: boolean; rateBps: number;
  specialRule: "room_rent_daily_threshold" | null; thresholdPaise: number | null;
};
export type GstSettings = { compositeHealthcareExempt: boolean; caSigned: boolean };
export type AdjustmentRuleConfig = {
  ruleKey: string; title: string; kind: "percent_bps" | "flat_paise"; value: number;
  discountCategory: DiscountCategory; requiredTag: string | null;
  serviceCategory: string | null; serviceId: string | null;
};
export type ManualCaps = Partial<Record<DiscountCategory, { maxBps: number; approvalAboveBps: number | null }>>;
// flat_paise is a WHOLE-LINE amount, never per-unit (owner decision 2026-08-14). How a flat discount pro-rates on a partial refund is the billing layer's rule to state (Plan 08).
export type ManualDiscountInput = { discountCategory: DiscountCategory; kind: "percent_bps" | "flat_paise"; value: number; reason: string };

export type InvoiceLineInput = {
  lineId: string; serviceId: string; qty: number; // positive integer; days for room-rent lines
  supplyContext?: "standalone" | "composite_healthcare"; // D-3 composite supply; caller-set (Plan 08/IPD)
  manualDiscount?: ManualDiscountInput | null;
  /**
   * PLAN 15 T7 / DD11 — **A PER-LINE UNIT-PRICE CEILING THE CALLER COMPUTED, applied in the same
   * `min` chain as MRP and the NPPA ceiling.**
   *
   * It exists because the regulated clamp this system already has is keyed by SERVICE
   * (`regulated_prices.service_id`) and an implant's lawful maximum is keyed by BATCH: the same
   * plate from two consignment lots carries two printed MRPs, and no service-level row can express
   * that. So the OT module computes `min(MRP per base x qty, ceiling per base x qty)` against the
   * batch the plate actually came from and hands the result down as a bound.
   *
   * ═══ WHY NOT A MANUAL DISCOUNT, WHICH IS WHERE THIS WAS GOING ═══
   *
   * Plan 15's DD11 branch (b) proposed expressing the clamp as a `manualDiscount`. Spike Q4 read
   * `contest.ts` and found that unsafe: a manual discount is a CONTEST CANDIDATE, and
   * `manualDiscountSource` REJECTS it outright when `ctx.manualCaps[category]` has no ACTIVE row
   * (`unknown_category`) or when the ask exceeds that category's `maxBps` (`over_cap`) — after
   * which `runContest` filters rejected candidates and the line prices at FULL TARIFF. A regulated
   * ceiling that a missing configuration row silently deletes is not a ceiling. The alternative
   * repair — widening a discount category's cap to 100% so the clamp always fits — would uncap that
   * category hospital-wide to pay for a pricing bug.
   *
   * **A bound cannot be lost.** There is no config to be missing, no contest to lose, no approval
   * to be absent. It is `Math.min`, in the block whose own comment already says *"the hard block IS
   * the min — no path may exceed the ceiling"*.
   *
   * Integer paise, per UNIT (not per line): the engine multiplies by `qty` itself, exactly as it
   * does for the tariff price and the two regulated bounds, so a caller cannot get the arithmetic
   * one factor out.
   */
  capUnitPaise?: number;
  /**
   * PLAN 16c T0b — **THE LIST PRICE OF A DRUG IS THE MRP PRINTED ON ITS BATCH.**
   *
   * A pharmacy sells at the batch's MRP (capped by the NPPA ceiling, which rides `capUnitPaise`),
   * and a new drug reaches the pharmacy master without a tariff revision. So for a service whose
   * `category` starts with `pharmacy` this is the unit price when the active version carries no
   * row for it, and it JOINS THE `min` when the version does (a contracted rate below MRP still
   * wins). Integer paise per BASE UNIT, like `capUnitPaise`.
   *
   * **Refused with `batch_price_not_allowed` on every other category**: a consultation cannot be
   * re-priced by whoever composes the line. The guard is the whole point of the field.
   */
  batchUnitPaise?: number;
};

export type AdjustmentCandidate = {
  sourceKey: string; ruleKey: string | null; kind: "percent_bps" | "flat_paise";
  discountCategory: DiscountCategory | null;
  amountPaise: number; // computed benefit on THIS line, capped at gross; for rejected candidates: the amount that was ASKED (audit)
  reason: string;
  requiresApproval: boolean; // Plan 08 enforces against the approvals engine
  rejected: { code: "over_cap" | "unknown_category"; detail: string } | null; // recorded, excluded from the contest
};
export type AdjustmentSource = {
  key: string;
  propose(ctx: PricingContext, line: InvoiceLineInput, grossPaise: number): AdjustmentCandidate[]; // PURE, sync
};

export type PricingContext = {
  asOf: Date; // resolution timestamp the impure loader used; the engine never reads a clock
  tariff: { versionId: string; versionNo: number; items: Record<string, number> }; // serviceId -> pricePaise (the LOCK: exactly one version)
  services: Record<string, ServiceInfo>;
  regulatedPrices: Record<string, { mrpPaise: number | null; ceilingPaise: number | null }>;
  gst: { categories: Record<string, GstCategoryConfig>; settings: GstSettings };
  rules: AdjustmentRuleConfig[];
  manualCaps: ManualCaps;
  sources: AdjustmentSource[]; // ORDER = tie-break precedence (D3); Plan 06 ships ["rule","manual"]
  tags: string[]; // request-level eligibility tags (e.g. "employee"); Plan 08 supplies from visit/patient
};

/**
 * PLAN 15 T7 — `boundApplied` gains `"caller_cap"`. A line whose winning bound was the caller's own
 * says so, which is what lets `bill.ts` record WHICH of the three won in the invoice line's note
 * (D9) instead of inferring it from the number.
 */
export type RegulatedClamp = {
  boundApplied: "mrp" | "ceiling" | "caller_cap" | "batch_mrp";
  /** The version's price — or, when the version had none and the batch stood in, the batch price (16c T0b). */
  tariffPaise: number;
  mrpPaise: number | null;
  ceilingPaise: number | null;
  /** The caller's bound, when it was supplied. Recorded whether or not it won. */
  capUnitPaise?: number | null;
  /** The batch MRP per base unit, when a pharmacy line supplied one (16c T0b). Recorded whether or not it won. */
  batchUnitPaise?: number | null;
};
export type PricedLineGst = {
  sacCode: string; rateBps: number; exempt: boolean;
  exemptReason: "category_exempt" | "composite_healthcare" | "room_rent_at_or_below_threshold" | null;
  cgstPaise: number; sgstPaise: number;
};
export type PricedLine = {
  lineId: string; serviceId: string; serviceName: string; category: string;
  qty: number; unitPaise: number; grossPaise: number;
  regulatedClamp: RegulatedClamp | null;
  candidates: AdjustmentCandidate[]; winner: AdjustmentCandidate | null;
  discountPaise: number; taxableBasePaise: number;
  gst: PricedLineGst; netPaise: number;
};
