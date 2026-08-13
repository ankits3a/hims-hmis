import { TariffError } from "./errors";
import { manualDiscountSource, standingRuleSource } from "./contest";
import { priceInvoiceLines } from "./pricing";
import { listServices, resolveRegulatedPrices } from "./services";
import { getVersion, resolveActiveTariffVersion } from "./versions";
import { getGstSettings, listGstCategories } from "./gst-config";
import { listAdjustmentRules, loadRuleConfig, manualCapParamsSchema, ruleParamsSchema } from "./rules";
import { DISCOUNT_CATEGORIES } from "./types";
import type { GstCategoryConfig, ManualCaps, PricingContext, ServiceInfo } from "./types";
import type { Db } from "../../kernel/db/client";

type VersionDetail = NonNullable<Awaited<ReturnType<typeof getVersion>>>;

/**
 * Builds a hermetic PricingContext for priceInvoiceLines/simulateRevision (impure loader — D5/D7).
 * The lock: an explicit tariffVersionId always wins over what `at` would otherwise resolve; it
 * must be `activated` unless `allowDraft` is set (simulation's path), else version_not_active.
 */
export async function loadPricingContext(
  db: Db,
  opts: { at: Date; tariffVersionId?: string; allowDraft?: boolean; tags?: string[] },
): Promise<PricingContext> {
  let versionDetail: VersionDetail;

  if (opts.tariffVersionId !== undefined) {
    const found = await getVersion(db, opts.tariffVersionId);
    if (!found) throw new TariffError("unknown_version", `unknown tariff version ${opts.tariffVersionId}`);
    if (found.version.status !== "activated" && !opts.allowDraft) {
      throw new TariffError(
        "version_not_active",
        `tariff version ${opts.tariffVersionId} is ${found.version.status}, not activated (pass allowDraft to load it anyway)`,
      );
    }
    versionDetail = found;
  } else {
    const resolved = await resolveActiveTariffVersion(db, opts.at);
    if (!resolved) {
      throw new TariffError("version_not_active", `no activated tariff version resolvable at ${opts.at.toISOString()}`);
    }
    const found = await getVersion(db, resolved.versionId);
    if (!found) throw new TariffError("unknown_version", `resolved tariff version ${resolved.versionId} could not be loaded`);
    versionDetail = found;
  }

  const items: Record<string, number> = {};
  for (const item of versionDetail.items) items[item.serviceId] = item.pricePaise;

  const serviceRows = await listServices(db);
  const services: Record<string, ServiceInfo> = {};
  for (const s of serviceRows) {
    services[s.id] = { id: s.id, code: s.code, name: s.name, category: s.category, regulated: s.regulated, active: s.active };
  }

  const regulatedPrices = await resolveRegulatedPrices(db, opts.at);

  const categoryRows = await listGstCategories(db);
  const categories: Record<string, GstCategoryConfig> = {};
  for (const c of categoryRows) categories[c.category] = c;
  const settings = await getGstSettings(db);

  const { rules, manualCaps } = await loadRuleConfig(db, opts.at);

  return {
    asOf: opts.at,
    tariff: { versionId: versionDetail.version.id, versionNo: versionDetail.version.versionNo, items },
    services,
    regulatedPrices,
    gst: { categories, settings },
    rules,
    manualCaps,
    sources: [standingRuleSource, manualDiscountSource],
    tags: opts.tags ?? [],
  };
}

export type ConfigError = { code: string; detail: string };

/**
 * D-17 config gate (§19): read-only, ACCUMULATES ConfigErrors and NEVER THROWS, checking in
 * order — resolvable active version · every active service priced in it · every category used
 * by an active service has a gst_config row · every regulated active service has an effective
 * regulated_prices row · every adjustment_rules.params parses under its source schema · all
 * four D-8 categories have caps rows · gst_settings present · then smoke-prices every active
 * service (qty 1, no tags/discounts) through the REAL priceInvoiceLines, converting any throw
 * (including a broken context load) into an accumulated error entry rather than raising.
 */
export async function validateTariffConfig(
  db: Db,
  at: Date,
): Promise<{ ok: boolean; errors: ConfigError[]; caSigned: boolean }> {
  const errors: ConfigError[] = [];

  const activeServices = await listServices(db, { activeOnly: true });
  const resolved = await resolveActiveTariffVersion(db, at);
  if (!resolved) {
    errors.push({ code: "version_not_active", detail: `no activated tariff version resolvable at ${at.toISOString()}` });
  }

  if (resolved) {
    const detail = await getVersion(db, resolved.versionId);
    const items: Record<string, number> = {};
    for (const item of detail?.items ?? []) items[item.serviceId] = item.pricePaise;
    for (const svc of activeServices) {
      if (items[svc.id] === undefined) {
        errors.push({
          code: "tariff_item_missing",
          detail: `active service "${svc.code}" (${svc.id}) has no price in version ${resolved.versionId}`,
        });
      }
    }
  }

  const categoryRows = await listGstCategories(db);
  const categorySet = new Set(categoryRows.map((c) => c.category));
  const usedCategories = new Set(activeServices.map((s) => s.category));
  for (const cat of usedCategories) {
    if (!categorySet.has(cat)) {
      errors.push({ code: "gst_config_missing", detail: `no gst_config row for category "${cat}" used by an active service` });
    }
  }

  const regulatedPriceMap = await resolveRegulatedPrices(db, at);
  for (const svc of activeServices) {
    if (svc.regulated && !regulatedPriceMap[svc.id]) {
      errors.push({
        code: "regulated_price_missing",
        detail: `regulated active service "${svc.code}" (${svc.id}) has no effective regulated_prices row`,
      });
    }
  }

  const manualCaps: ManualCaps = {};
  const ruleRows = await listAdjustmentRules(db);
  for (const row of ruleRows) {
    if (row.sourceKey === "rule") {
      const parsed = ruleParamsSchema.safeParse(row.params);
      if (!parsed.success) {
        errors.push({ code: "invalid_rule_params", detail: `rule "${row.ruleKey}": ${parsed.error.message}` });
      }
    } else if (row.sourceKey === "manual") {
      const parsed = manualCapParamsSchema.safeParse(row.params);
      if (!parsed.success) {
        errors.push({ code: "invalid_rule_params", detail: `rule "${row.ruleKey}": ${parsed.error.message}` });
      } else {
        manualCaps[parsed.data.discountCategory] = {
          maxBps: parsed.data.maxBps,
          approvalAboveBps: parsed.data.approvalAboveBps,
        };
      }
    } else {
      errors.push({ code: "invalid_rule_params", detail: `rule "${row.ruleKey}" has unknown sourceKey "${row.sourceKey}"` });
    }
  }
  for (const cat of DISCOUNT_CATEGORIES) {
    if (!manualCaps[cat]) {
      errors.push({ code: "manual_caps_missing", detail: `no manual discount cap configured for category "${cat}"` });
    }
  }

  let caSigned = false;
  try {
    const settings = await getGstSettings(db);
    caSigned = settings.caSigned;
  } catch (e) {
    errors.push({
      code: e instanceof TariffError ? e.code : "settings_missing",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Smoke-price every active service through the REAL engine — but the context load itself can
  // throw (e.g. a corrupted adjustment_rules.params row hard-fails loadRuleConfig by design, the
  // same as it would at billing time); guarded here too so this function still never throws.
  if (resolved) {
    try {
      const ctx = await loadPricingContext(db, { at });
      for (const svc of activeServices) {
        try {
          priceInvoiceLines(ctx, [{ lineId: `smoke-${svc.id}`, serviceId: svc.id, qty: 1 }]);
        } catch (e) {
          errors.push({
            code: e instanceof TariffError ? e.code : "smoke_price_failed",
            detail: `smoke price failed for service "${svc.code}" (${svc.id}): ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    } catch (e) {
      errors.push({
        code: e instanceof TariffError ? e.code : "context_load_failed",
        detail: `could not load pricing context for the smoke test: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return { ok: errors.length === 0, errors, caSigned };
}
