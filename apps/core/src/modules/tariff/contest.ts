import { assertPaise, percentAmount } from "./money";
import type { AdjustmentCandidate, AdjustmentSource, InvoiceLineInput, PricingContext } from "./types";

export const standingRuleSource: AdjustmentSource = {
  key: "rule",
  propose(ctx, line, grossPaise) {
    const svc = ctx.services[line.serviceId];
    if (!svc) return [];
    const out: AdjustmentCandidate[] = [];
    const rules = [...ctx.rules].sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0));
    for (const r of rules) {
      if (r.requiredTag !== null && !ctx.tags.includes(r.requiredTag)) continue;
      if (r.serviceCategory !== null && r.serviceCategory !== svc.category) continue;
      if (r.serviceId !== null && r.serviceId !== line.serviceId) continue;
      const raw = r.kind === "percent_bps" ? percentAmount(grossPaise, r.value) : r.value;
      out.push({
        sourceKey: "rule", ruleKey: r.ruleKey, kind: r.kind, discountCategory: r.discountCategory,
        amountPaise: Math.min(raw, grossPaise), reason: r.title, requiresApproval: false, rejected: null,
      });
    }
    return out;
  },
};

export const manualDiscountSource: AdjustmentSource = {
  key: "manual",
  propose(ctx, line, grossPaise) {
    const md = line.manualDiscount;
    if (!md) return [];
    // The one money input that arrives from a CALLER rather than from zod-parsed config: guard it
    // here so a programmatic caller (Plan 08) can never float a fractional paise into the contest
    // (M3). Integer guard holds for both kinds — bps values are integers too.
    assertPaise(md.value, "manual discount value");
    const raw = md.kind === "percent_bps" ? percentAmount(grossPaise, md.value) : md.value;
    const amount = Math.min(raw, grossPaise);
    const base: AdjustmentCandidate = {
      sourceKey: "manual", ruleKey: null, kind: md.kind, discountCategory: md.discountCategory,
      amountPaise: amount, reason: md.reason, requiresApproval: false, rejected: null,
    };
    const caps = ctx.manualCaps[md.discountCategory];
    // Rejected candidates record the amount that was ASKED — the D-8 audit record (types.ts
    // contract; M2). Never the gross-clamped amount.
    if (!caps) return [{ ...base, amountPaise: raw, rejected: { code: "unknown_category", detail: `no cap configured for "${md.discountCategory}"` } }];
    // Governance checks are EXACT RATIONAL comparisons — never rounded (D1). The cap compares the
    // ASK: at a 100% cap an over-gross ask must reject as over_cap, never be silently clamped to
    // gross and accepted (D3: "recorded as rejected, never silently clamped"). For every
    // maxBps < 10000 this is provably identical to the old clamped-operand check.
    if (raw * 10000 > caps.maxBps * grossPaise) {
      return [{ ...base, amountPaise: raw, rejected: { code: "over_cap", detail: `${raw}p exceeds ${caps.maxBps}bps of ${grossPaise}p` } }];
    }
    const requiresApproval = caps.approvalAboveBps !== null && amount * 10000 > caps.approvalAboveBps * grossPaise;
    return [{ ...base, requiresApproval }];
  },
};

/** Best-single-benefit (§7): one winner per line; ties break by ctx.sources order, then ruleKey asc (nulls last). */
export function runContest(
  ctx: PricingContext, line: InvoiceLineInput, grossPaise: number,
): { candidates: AdjustmentCandidate[]; winner: AdjustmentCandidate | null } {
  const order = new Map<string, number>();
  ctx.sources.forEach((s, i) => order.set(s.key, i));
  const candidates: AdjustmentCandidate[] = [];
  for (const source of ctx.sources) candidates.push(...source.propose(ctx, line, grossPaise));
  const valid = candidates.filter((c) => c.rejected === null && c.amountPaise > 0);
  valid.sort((a, b) => {
    if (a.amountPaise !== b.amountPaise) return b.amountPaise - a.amountPaise;
    const ai = order.get(a.sourceKey) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.sourceKey) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    if (a.ruleKey === null && b.ruleKey === null) return 0; // nulls last, spelled out — no sentinel characters
    if (a.ruleKey === null) return 1;
    if (b.ruleKey === null) return -1;
    return a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0;
  });
  return { candidates, winner: valid[0] ?? null };
}
