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

export type RegulatedClamp = { boundApplied: "mrp" | "ceiling"; tariffPaise: number; mrpPaise: number | null; ceilingPaise: number | null };
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
