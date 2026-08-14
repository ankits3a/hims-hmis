import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { adjustmentRules } from "../../kernel/db/schema";
import { TariffError } from "./errors";
import { DISCOUNT_CATEGORIES } from "./types";
import type { AdjustmentRuleConfig, ManualCaps } from "./types";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * D-8 standing-rule params (contest.ts's standingRuleSource, key "rule"). Stored in
 * adjustment_rules.params as the zod-PARSED object, never the raw input. No coercing schema
 * helper anywhere (§3.19) — money/bps fields at this boundary are hand-typed integers, coercion
 * here is a live logic bug.
 */
export const ruleParamsSchema = z
  .object({
    kind: z.enum(["percent_bps", "flat_paise"]),
    value: z.number().int().min(1),
    discountCategory: z.enum(DISCOUNT_CATEGORIES),
    requiredTag: z.string().min(1).nullable(),
  })
  .refine((p) => p.kind !== "percent_bps" || p.value <= 10000, {
    message: "percent_bps value must be an integer basis-points amount <= 10000 (100%)",
    path: ["value"],
  });

/** D-8 manual-discount cap params (contest.ts's manualDiscountSource, key "manual"). No coercing schema helper (§3.19). */
export const manualCapParamsSchema = z.object({
  discountCategory: z.enum(DISCOUNT_CATEGORIES),
  maxBps: z.number().int().min(0).max(10000),
  approvalAboveBps: z.number().int().min(0).max(10000).nullable(),
});

export type AdjustmentRuleRow = typeof adjustmentRules.$inferSelect;

/** Upsert keyed on the unique rule_key (adjustment_rules_key_ux); params validated by sourceKey's schema. */
export async function upsertAdjustmentRule(
  tx: Tx,
  actor: Actor,
  input: {
    ruleKey: string;
    sourceKey: "rule" | "manual";
    title: string;
    params: unknown;
    serviceCategory?: string | null;
    serviceId?: string | null;
    validFrom?: Date | null;
    validTo?: Date | null;
    active?: boolean;
  },
): Promise<{ id: string }> {
  let parsedParams: unknown;
  if (input.sourceKey === "rule") {
    const parsed = ruleParamsSchema.safeParse(input.params);
    if (!parsed.success) {
      throw new TariffError("invalid_rule_params", `rule "${input.ruleKey}": ${parsed.error.message}`);
    }
    parsedParams = parsed.data;
  } else {
    const parsed = manualCapParamsSchema.safeParse(input.params);
    if (!parsed.success) {
      throw new TariffError("invalid_rule_params", `rule "${input.ruleKey}": ${parsed.error.message}`);
    }
    parsedParams = parsed.data;
  }

  const rows = await tx
    .insert(adjustmentRules)
    .values({
      id: newId(),
      ruleKey: input.ruleKey,
      sourceKey: input.sourceKey,
      title: input.title,
      params: parsedParams,
      serviceCategory: input.serviceCategory ?? null,
      serviceId: input.serviceId ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      active: input.active ?? true,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: adjustmentRules.ruleKey,
      set: {
        sourceKey: input.sourceKey,
        title: input.title,
        params: parsedParams,
        serviceCategory: input.serviceCategory ?? null,
        serviceId: input.serviceId ?? null,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        active: input.active ?? true,
        updatedBy: actor.id,
        updatedAt: new Date(),
      },
    })
    .returning({ id: adjustmentRules.id });
  return { id: rows[0]!.id };
}

export async function listAdjustmentRules(db: Db, opts?: { sourceKey?: string }): Promise<AdjustmentRuleRow[]> {
  if (opts?.sourceKey !== undefined) {
    return db.select().from(adjustmentRules).where(eq(adjustmentRules.sourceKey, opts.sourceKey));
  }
  return db.select().from(adjustmentRules);
}

/**
 * Active rows valid at `at` (boundary: equal is included, the D5 resolution convention),
 * params parsed under their source's schema. "rule" rows become AdjustmentRuleConfig entries;
 * "manual" rows key ManualCaps by their params' discountCategory. Ordered by id ASC (ULIDs =
 * creation order) so the last-write-wins cap assignment below is deterministic — among duplicate
 * active manual rows for one category the NEWEST row wins, the same last-inserted-wins convention
 * as resolveRegulatedPrices (C2/M4); validateTariffConfig separately surfaces duplicates as
 * duplicate_manual_cap.
 */
export async function loadRuleConfig(
  db: Db,
  at: Date,
): Promise<{ rules: AdjustmentRuleConfig[]; manualCaps: ManualCaps }> {
  const rows = await db
    .select()
    .from(adjustmentRules)
    .where(eq(adjustmentRules.active, true))
    .orderBy(asc(adjustmentRules.id));
  const rules: AdjustmentRuleConfig[] = [];
  const manualCaps: ManualCaps = {};
  for (const row of rows) {
    if (row.validFrom !== null && row.validFrom > at) continue;
    if (row.validTo !== null && row.validTo < at) continue;
    if (row.sourceKey === "rule") {
      const parsed = ruleParamsSchema.parse(row.params);
      rules.push({
        ruleKey: row.ruleKey,
        title: row.title,
        kind: parsed.kind,
        value: parsed.value,
        discountCategory: parsed.discountCategory,
        requiredTag: parsed.requiredTag,
        serviceCategory: row.serviceCategory,
        serviceId: row.serviceId,
      });
    } else if (row.sourceKey === "manual") {
      const parsed = manualCapParamsSchema.parse(row.params);
      manualCaps[parsed.discountCategory] = { maxBps: parsed.maxBps, approvalAboveBps: parsed.approvalAboveBps };
    }
  }
  return { rules, manualCaps };
}
