import { z } from "zod";
import { couponSource, membershipSource } from "../sources";
import { manualDiscountSource, standingRuleSource } from "../../tariff";
import type { GstCategoryConfig, PricingContext, ServiceInfo } from "../../tariff";
import type { ResolvedInstruments } from "../instruments";

/**
 * PLAN 09'S OWN GOLDEN HARNESS (T2), and it is a NEW harness rather than an extension of Plan 06's.
 *
 * `modules/tariff/fixture-schema.ts` is inside the directory this phase freezes in full (DD2), and
 * extending it would mean changing both its discriminated union and its pinned fixture manifest —
 * two edits to a frozen money module to add a case that has nothing to do with the tariff engine.
 * So the DISCIPLINE is copied and the FILE is not:
 *
 *   - `workings: z.string().min(20)` — a fixture that does not SHOW its arithmetic fails to PARSE,
 *     which is the only mechanism this project has found that keeps a golden file from silently
 *     becoming a snapshot of whatever the code happened to do;
 *   - the manifest is pinned by NAME and the directory is asserted to contain nothing else, so
 *     neither a renamed fixture nor a `.JSON` straggler can hide (`golden.test.ts`);
 *   - the expectation is a FULL deep-equal of the `PricedLine`, never a partial match.
 *
 * ═══ EVERY VALUE IN EVERY FIXTURE WAS INVENTED HERE (DD3 / owner ruling O-9) ═══
 *
 * The out-of-git partner book may not be transcribed into a tracked file and a fixture is a
 * tracked file. Each fixture therefore tests a CLASS — a contest, a cap hit, a window boundary, a
 * zero line — with codes, names, rates and people written fresh in this repository. A class does
 * not care which invented name carries it.
 */
const paise = z.number().int().nonnegative();
const workings = z.string().min(20); // a fixture without real arithmetic shown FAILS to parse
const iso = z.string().datetime();

const serviceInfo = z.object({
  id: z.string(), code: z.string(), name: z.string(), category: z.string(),
  regulated: z.boolean(), active: z.boolean(),
});
const gstCategory = z.object({
  category: z.string(), sacCode: z.string(), exempt: z.boolean(), rateBps: z.number().int(),
  specialRule: z.enum(["room_rent_daily_threshold"]).nullable(), thresholdPaise: paise.nullable(),
});
const ruleConfig = z.object({
  ruleKey: z.string(), title: z.string(), kind: z.enum(["percent_bps", "flat_paise"]),
  value: z.number().int().positive(),
  discountCategory: z.enum(["charity", "scheme", "negotiated_corporate", "employee"]),
  requiredTag: z.string().nullable(), serviceCategory: z.string().nullable(), serviceId: z.string().nullable(),
});
const configSchema = z.object({
  asOf: iso, // THE money moment — the one time authority the sources read (see instruments.ts)
  tariff: z.object({ versionId: z.string(), versionNo: z.number().int(), items: z.record(z.string(), paise) }),
  services: z.array(serviceInfo),
  regulatedPrices: z.record(z.string(), z.object({ mrpPaise: paise.nullable(), ceilingPaise: paise.nullable() })),
  gstCategories: z.array(gstCategory),
  gstSettings: z.object({ compositeHealthcareExempt: z.boolean(), caSigned: z.boolean() }),
  rules: z.array(ruleConfig),
  manualCaps: z.record(z.string(), z.object({ maxBps: z.number().int(), approvalAboveBps: z.number().int().nullable() })),
  tags: z.array(z.string()),
});

const benefitScope = z.object({
  serviceCategories: z.array(z.string()).nullable(),
  serviceIds: z.array(z.string()).nullable(),
});
const benefitTerm = z.object({
  benefitKey: z.string(), title: z.string(), kind: z.enum(["percent_bps", "flat_paise"]),
  value: z.number().int().nonnegative(), capPaise: paise.nullable(), scope: benefitScope,
});
const resolvedMembership = z.object({
  instanceId: z.string(), planId: z.string(), planTitle: z.string(), cardCode: z.string(),
  status: z.enum(["active", "expired", "suspended", "cancelled"]),
  validFrom: iso, validTo: iso, benefits: z.array(benefitTerm),
});
const resolvedCoupon = z.object({
  couponId: z.string(), code: z.string(), title: z.string(), instanceId: z.string().nullable(),
  benefit: benefitTerm, minBillPaise: paise, validFrom: iso, validTo: iso,
  weekdayMask: z.number().int().min(0).max(127),
  windowStartMinute: z.number().int().min(0).max(1439).nullable(),
  windowEndMinute: z.number().int().min(0).max(1439).nullable(),
  status: z.enum(["active", "retired"]),
});
/** T3's output, as JSON. Timestamps are ISO here and `Date`s in the value the sources see. */
const resolvedSchema = z.object({
  patientId: z.string().nullable(),
  memberships: z.array(resolvedMembership),
  coupons: z.array(resolvedCoupon),
  billGrossPaise: paise,
});

const lineInput = z.object({
  lineId: z.string(), serviceId: z.string(), qty: z.number().int().positive(),
  supplyContext: z.enum(["standalone", "composite_healthcare"]).optional(),
  manualDiscount: z.object({
    discountCategory: z.enum(["charity", "scheme", "negotiated_corporate", "employee"]),
    kind: z.enum(["percent_bps", "flat_paise"]), value: z.number().int().positive(), reason: z.string(),
  }).nullable().optional(),
});

export const fixtureSchema = z.object({
  name: z.string(),
  specRefs: z.array(z.string()).min(1),
  config: configSchema,
  resolved: resolvedSchema,
  lines: z.array(lineInput).min(1),
  /** One entry per line, in order; `line` deep-equals the full `PricedLine`. */
  expected: z.array(z.object({ workings, line: z.unknown() })).min(1),
});
export type GoldenFixture = z.infer<typeof fixtureSchema>;

/** The resolved value, with its ISO timestamps rehydrated — exactly what T3 will hand T4. */
export function instrumentsFromFixture(resolved: z.infer<typeof resolvedSchema>): ResolvedInstruments {
  return {
    patientId: resolved.patientId,
    billGrossPaise: resolved.billGrossPaise,
    memberships: resolved.memberships.map((m) => ({
      ...m, validFrom: new Date(m.validFrom), validTo: new Date(m.validTo),
    })),
    coupons: resolved.coupons.map((c) => ({
      ...c, validFrom: new Date(c.validFrom), validTo: new Date(c.validTo),
    })),
  };
}

/**
 * The pricing context a fixture describes, WITH the two instrument sources composed onto it in the
 * DD2 order — `[rule, manual, membership, coupon]`. That array order is tie-break precedence and
 * the ruling behind it is in `sources.ts`; this is the one place the harness fixes it, so a fixture
 * cannot quietly test a different order from the one billing will ship.
 */
export function contextFromFixture(
  config: z.infer<typeof configSchema>,
  resolved: ResolvedInstruments,
): PricingContext {
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
    sources: [standingRuleSource, manualDiscountSource, membershipSource(resolved), couponSource(resolved)],
    tags: config.tags,
  };
}
