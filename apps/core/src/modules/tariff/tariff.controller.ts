import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject,
  NotFoundException, Param, Patch, Post, Put,
} from "@nestjs/common";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { ApprovalError } from "../../kernel/approvals/types";
import { WorkflowError } from "../../kernel/workflow/instances";
import { withTx } from "../../kernel/db/client";
import { regulatedPrices } from "../../kernel/db/schema";
import { TariffError } from "./errors";
import { DISCOUNT_CATEGORIES } from "./types";
import { appendRegulatedPrice, createService, listServices, updateService } from "./services";
import {
  activateVersion, createDraftVersion, getVersion, listVersions, setTariffItem, submitVersion,
} from "./versions";
import { simulateRevision } from "./simulation";
import { loadPricingContext } from "./context";
import { listAdjustmentRules, upsertAdjustmentRule } from "./rules";
import { getGstSettings, listGstCategories, upsertGstCategory, upsertGstSettings } from "./gst-config";
import type { TariffErrorCode } from "./errors";
import type { Db } from "../../kernel/db/client";

// Errors → HTTP, defined once (the patients toHttp convention). The code is folded into the
// exception message so callers (and tests) can discriminate the failure mechanism from the
// response body alone — not just the status code (§3.14b: a bare 403 proves nothing).
const NOT_FOUND_CODES = new Set<TariffErrorCode>(["unknown_service", "unknown_version", "unknown_rule"]);
const VALIDATION_CODES = new Set<TariffErrorCode>([
  "invalid_paise", "invalid_qty", "invalid_rule_params", "regulated_bounds_missing", "gst_config_invalid",
]);

function toHttp(e: unknown): never {
  if (e instanceof TariffError) {
    const message = `${e.code}: ${e.message}`;
    if (NOT_FOUND_CODES.has(e.code)) throw new NotFoundException(message);
    if (e.code === "sod_drafter_activator") throw new ForbiddenException(message);
    if (VALIDATION_CODES.has(e.code)) throw new BadRequestException(message);
    throw new ConflictException(message); // every remaining state/config code
  }
  if (e instanceof ApprovalError) throw new ConflictException(e.message);
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

/** ISO date strings are parsed explicitly — never z.coerce.date() (§3.19: coercion at a money/date boundary is a live logic bug). */
function parseIsoDate(s: string, field: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be a valid ISO date string`);
  return d;
}

const serviceCreateBody = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  regulated: z.boolean().optional(),
});

const serviceUpdateBody = z.object({
  code: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  regulated: z.boolean().optional(),
  active: z.boolean().optional(),
});

const regulatedPriceBody = z.object({
  mrpPaise: z.number().int().min(0).optional(),
  ceilingPaise: z.number().int().min(0).optional(),
  effectiveFrom: z.string().min(1),
  gazetteRef: z.string().min(1).optional(),
});

const versionCreateBody = z.object({
  notes: z.string().min(1).optional(),
  copyFromVersionId: z.string().min(1).optional(),
});

const versionItemBody = z.object({ pricePaise: z.number().int().min(0) });

const submitBody = z.object({ requestNote: z.string().min(1).optional() });

const activateBody = z.object({ effectiveFrom: z.string().min(1) });

const manualDiscountBody = z.object({
  discountCategory: z.enum(DISCOUNT_CATEGORIES),
  kind: z.enum(["percent_bps", "flat_paise"]),
  value: z.number().int().min(1),
  reason: z.string().min(1),
});

const invoiceLineBody = z.object({
  lineId: z.string().min(1),
  serviceId: z.string().min(1),
  qty: z.number().int().min(1),
  supplyContext: z.enum(["standalone", "composite_healthcare"]).optional(),
  manualDiscount: manualDiscountBody.nullable().optional(),
});

const simulateBody = z.object({
  lines: z.array(invoiceLineBody),
  at: z.string().min(1).optional(),
});

const ruleCreateBody = z.object({
  ruleKey: z.string().min(1),
  sourceKey: z.enum(["rule", "manual"]),
  title: z.string().min(1),
  params: z.unknown(),
  serviceCategory: z.string().min(1).nullable().optional(),
  serviceId: z.string().min(1).nullable().optional(),
  validFrom: z.string().min(1).nullable().optional(),
  validTo: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

const gstCategoryBody = z.object({
  sacCode: z.string().min(1),
  exempt: z.boolean(),
  rateBps: z.number().int().min(0),
  specialRule: z.enum(["room_rent_daily_threshold"]).nullable(),
  thresholdPaise: z.number().int().min(0).nullable(),
});

const gstSettingsBody = z.object({
  compositeHealthcareExempt: z.boolean().optional(),
  caSigned: z.boolean().optional(),
});

@Controller("tariff")
export class TariffController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ——— services ———

  @RequirePermission("tariff.read", "hospital")
  @Get("services")
  async listServicesRoute(): Promise<{ items: unknown[] }> {
    return { items: await listServices(this.db) };
  }

  @RequirePermission("tariff.services.manage", "hospital")
  @Post("services")
  async createServiceRoute(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ serviceId: string }> {
    const b = parsed(serviceCreateBody, body);
    try {
      return await withTx(this.db, (tx) => createService(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.services.manage", "hospital")
  @Patch("services/:id")
  async updateServiceRoute(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(serviceUpdateBody, body);
    try {
      await withTx(this.db, (tx) => updateService(tx, actor, id, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.services.manage", "hospital")
  @Post("services/:id/regulated-prices")
  async addRegulatedPriceRoute(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ id: string }> {
    const b = parsed(regulatedPriceBody, body);
    const effectiveFrom = parseIsoDate(b.effectiveFrom, "effectiveFrom");
    try {
      return await withTx(this.db, (tx) =>
        appendRegulatedPrice(tx, actor, {
          serviceId: id, mrpPaise: b.mrpPaise ?? null, ceilingPaise: b.ceilingPaise ?? null,
          effectiveFrom, gazetteRef: b.gazetteRef,
        }),
      );
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.read", "hospital")
  @Get("services/:id/regulated-prices")
  async listRegulatedPricesRoute(@Param("id") id: string): Promise<{ items: unknown[] }> {
    const items = await this.db
      .select()
      .from(regulatedPrices)
      .where(eq(regulatedPrices.serviceId, id))
      .orderBy(desc(regulatedPrices.effectiveFrom));
    return { items };
  }

  // ——— versions ———

  @RequirePermission("tariff.read", "hospital")
  @Get("versions")
  async listVersionsRoute(): Promise<{ items: unknown[] }> {
    return { items: await listVersions(this.db) };
  }

  @RequirePermission("tariff.versions.draft", "hospital")
  @Post("versions")
  async createVersionRoute(
    @CurrentActor() actor: Actor, @Body() body: unknown,
  ): Promise<{ versionId: string; versionNo: number }> {
    const b = parsed(versionCreateBody, body ?? {});
    try {
      return await withTx(this.db, (tx) => createDraftVersion(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.read", "hospital")
  @Get("versions/:id")
  async versionDetailRoute(@Param("id") id: string): Promise<unknown> {
    const found = await getVersion(this.db, id);
    if (!found) throw new NotFoundException(`unknown tariff version ${id}`);
    return found;
  }

  @RequirePermission("tariff.versions.draft", "hospital")
  @Put("versions/:id/items/:serviceId")
  async setItemRoute(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(versionItemBody, body);
    try {
      await withTx(this.db, (tx) => setTariffItem(tx, actor, id, serviceId, b.pricePaise));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.versions.draft", "hospital")
  @Post("versions/:id/submit")
  @HttpCode(200) // an action, not a creation — the assertion and this annotation are the SAME number by construction
  async submitRoute(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ approvalId: string; instanceId: string }> {
    const b = parsed(submitBody, body ?? {});
    try {
      return await withTx(this.db, (tx) => submitVersion(tx, actor, id, b.requestNote));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.versions.activate", "hospital")
  @Post("versions/:id/activate")
  @HttpCode(200) // an action, not a creation
  async activateRoute(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ versionNo: number; effectiveFrom: Date }> {
    const b = parsed(activateBody, body);
    const effectiveFrom = parseIsoDate(b.effectiveFrom, "effectiveFrom");
    try {
      return await activateVersion(this.db, actor, id, effectiveFrom);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.versions.draft", "hospital")
  @Post("versions/:id/simulate")
  @HttpCode(200) // an action, not a creation
  async simulateRoute(@Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(simulateBody, body);
    const at = b.at !== undefined ? parseIsoDate(b.at, "at") : new Date();
    try {
      const [currentCtx, draftCtx] = await Promise.all([
        loadPricingContext(this.db, { at }),
        loadPricingContext(this.db, { at, tariffVersionId: id, allowDraft: true }),
      ]);
      return simulateRevision(currentCtx, draftCtx, b.lines);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— adjustment rules ———

  @RequirePermission("tariff.read", "hospital")
  @Get("rules")
  async listRulesRoute(): Promise<{ items: unknown[] }> {
    return { items: await listAdjustmentRules(this.db) };
  }

  @RequirePermission("tariff.config.manage", "hospital")
  @Post("rules")
  async createRuleRoute(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ id: string }> {
    const b = parsed(ruleCreateBody, body);
    const validFrom = b.validFrom !== undefined && b.validFrom !== null ? parseIsoDate(b.validFrom, "validFrom") : null;
    const validTo = b.validTo !== undefined && b.validTo !== null ? parseIsoDate(b.validTo, "validTo") : null;
    try {
      return await withTx(this.db, (tx) =>
        upsertAdjustmentRule(tx, actor, {
          ruleKey: b.ruleKey, sourceKey: b.sourceKey, title: b.title, params: b.params,
          serviceCategory: b.serviceCategory ?? null, serviceId: b.serviceId ?? null,
          validFrom, validTo, active: b.active,
        }),
      );
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— GST config ———

  @RequirePermission("tariff.read", "hospital")
  @Get("gst")
  async gstConfigRoute(): Promise<{ categories: unknown[]; settings: unknown }> {
    try {
      const [categories, settings] = await Promise.all([listGstCategories(this.db), getGstSettings(this.db)]);
      return { categories, settings };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.config.manage", "hospital")
  @Put("gst/config/:category")
  async putGstCategoryRoute(
    @CurrentActor() actor: Actor, @Param("category") category: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(gstCategoryBody, body);
    try {
      await withTx(this.db, (tx) => upsertGstCategory(tx, actor, { category, ...b }));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("tariff.config.manage", "hospital")
  @Put("gst/settings")
  async putGstSettingsRoute(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(gstSettingsBody, body);
    try {
      await withTx(this.db, (tx) => upsertGstSettings(tx, actor, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }
}
