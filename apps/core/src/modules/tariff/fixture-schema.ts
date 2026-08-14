import { z } from "zod";
import { manualDiscountSource, standingRuleSource } from "./contest";
import type { GstCategoryConfig, PricingContext, ServiceInfo } from "./types";
const paise = z.number().int().nonnegative();
const workings = z.string().min(20); // a fixture without real arithmetic shown FAILS to parse
const serviceInfo = z.object({ id: z.string(), code: z.string(), name: z.string(), category: z.string(), regulated: z.boolean(), active: z.boolean() });
const gstCategory = z.object({ category: z.string(), sacCode: z.string(), exempt: z.boolean(), rateBps: z.number().int(),
  specialRule: z.enum(["room_rent_daily_threshold"]).nullable(), thresholdPaise: paise.nullable() });
const ruleConfig = z.object({ ruleKey: z.string(), title: z.string(), kind: z.enum(["percent_bps", "flat_paise"]), value: z.number().int().positive(),
  discountCategory: z.enum(["charity", "scheme", "negotiated_corporate", "employee"]), requiredTag: z.string().nullable(),
  serviceCategory: z.string().nullable(), serviceId: z.string().nullable() });
const configSchema = z.object({
  asOf: z.string(), // ISO
  tariff: z.object({ versionId: z.string(), versionNo: z.number().int(), items: z.record(z.string(), paise) }),
  services: z.array(serviceInfo),
  regulatedPrices: z.record(z.string(), z.object({ mrpPaise: paise.nullable(), ceilingPaise: paise.nullable() })),
  gstCategories: z.array(gstCategory),
  gstSettings: z.object({ compositeHealthcareExempt: z.boolean(), caSigned: z.boolean() }),
  rules: z.array(ruleConfig),
  manualCaps: z.record(z.string(), z.object({ maxBps: z.number().int(), approvalAboveBps: z.number().int().nullable() })),
  tags: z.array(z.string()),
});
const lineInput = z.object({ lineId: z.string(), serviceId: z.string(), qty: z.number().int().positive(),
  supplyContext: z.enum(["standalone", "composite_healthcare"]).optional(),
  manualDiscount: z.object({ discountCategory: z.enum(["charity", "scheme", "negotiated_corporate", "employee"]),
    kind: z.enum(["percent_bps", "flat_paise"]), value: z.number().int().positive(), reason: z.string() }).nullable().optional() });
export const fixtureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("price"), name: z.string(), specRefs: z.array(z.string()).min(1), caFlag: z.string().optional(),
    config: configSchema, lines: z.array(lineInput).min(1),
    expected: z.array(z.object({ workings, line: z.unknown() })).min(1) }), // line deep-equals the full PricedLine
  z.object({ kind: z.literal("price_error"), name: z.string(), specRefs: z.array(z.string()).min(1),
    config: configSchema, lines: z.array(lineInput).min(1),
    expected: z.object({ workings, errorCode: z.string() }) }),
]);
export type GoldenFixture = z.infer<typeof fixtureSchema>;

export function contextFromFixture(config: z.infer<typeof configSchema>): PricingContext {
  const services: Record<string, ServiceInfo> = {};
  for (const s of config.services) services[s.id] = s;
  const categories: Record<string, GstCategoryConfig> = {};
  for (const c of config.gstCategories) categories[c.category] = c;
  return {
    asOf: new Date(config.asOf),
    tariff: config.tariff,
    services,
    regulatedPrices: config.regulatedPrices,
    gst: { categories, settings: config.gstSettings },
    rules: config.rules,
    manualCaps: config.manualCaps,
    sources: [standingRuleSource, manualDiscountSource], // the shipped order — tie-break precedence (D3)
    tags: config.tags,
  };
}
