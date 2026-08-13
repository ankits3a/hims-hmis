import { percentAmount } from "./money";
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
    const raw = md.kind === "percent_bps" ? percentAmount(grossPaise, md.value) : md.value;
    const amount = Math.min(raw, grossPaise);
    const base: AdjustmentCandidate = {
      sourceKey: "manual", ruleKey: null, kind: md.kind, discountCategory: md.discountCategory,
      amountPaise: amount, reason: md.reason, requiresApproval: false, rejected: null,
    };
    const caps = ctx.manualCaps[md.discountCategory];
    if (!caps) return [{ ...base, rejected: { code: "unknown_category", detail: `no cap configured for "${md.discountCategory}"` } }];
    // Governance checks are EXACT RATIONAL comparisons — never rounded (D1).
    if (amount * 10000 > caps.maxBps * grossPaise) {
      return [{ ...base, rejected: { code: "over_cap", detail: `${amount}p exceeds ${caps.maxBps}bps of ${grossPaise}p` } }];
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
