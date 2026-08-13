import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { gstConfig, gstSettings } from "../../kernel/db/schema";
import { TariffError } from "./errors";
import type { GstCategoryConfig, GstSettings } from "./types";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * D-3 GST category config — CA-configured DATA, never engine literals (§19 gate). No coercing
 * schema helper anywhere (§3.19): rateBps/thresholdPaise are hand-typed integers, coercion here
 * is a live logic bug.
 */
const gstCategorySchema = z
  .object({
    category: z.string().min(1),
    sacCode: z.string().min(1),
    exempt: z.boolean(),
    rateBps: z.number().int().min(0),
    specialRule: z.enum(["room_rent_daily_threshold"]).nullable(),
    thresholdPaise: z.number().int().min(0).nullable(),
  })
  .refine((c) => c.specialRule !== "room_rent_daily_threshold" || c.thresholdPaise !== null, {
    message: 'specialRule "room_rent_daily_threshold" requires a non-null thresholdPaise',
    path: ["thresholdPaise"],
  });

export async function upsertGstCategory(tx: Tx, actor: Actor, cfg: GstCategoryConfig): Promise<void> {
  const parsed = gstCategorySchema.safeParse(cfg);
  if (!parsed.success) {
    throw new TariffError("gst_config_invalid", `category "${cfg.category}": ${parsed.error.message}`);
  }
  const v = parsed.data;
  await tx
    .insert(gstConfig)
    .values({
      category: v.category,
      sacCode: v.sacCode,
      exempt: v.exempt,
      rateBps: v.rateBps,
      specialRule: v.specialRule,
      thresholdPaise: v.thresholdPaise,
      updatedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: gstConfig.category,
      set: {
        sacCode: v.sacCode,
        exempt: v.exempt,
        rateBps: v.rateBps,
        specialRule: v.specialRule,
        thresholdPaise: v.thresholdPaise,
        updatedBy: actor.id,
        updatedAt: new Date(),
      },
    });
}

export async function listGstCategories(db: Db): Promise<GstCategoryConfig[]> {
  const rows = await db.select().from(gstConfig);
  return rows.map((r) => ({
    category: r.category,
    sacCode: r.sacCode,
    exempt: r.exempt,
    rateBps: r.rateBps,
    specialRule: r.specialRule as "room_rent_daily_threshold" | null,
    thresholdPaise: r.thresholdPaise,
  }));
}

/** Single audited row id='main' (registration_config precedent) — loud missing-row error names the seed. */
export async function getGstSettings(db: Db): Promise<GstSettings> {
  const rows = await db.select().from(gstSettings).where(eq(gstSettings.id, "main"));
  const row = rows[0];
  if (!row) {
    throw new TariffError(
      "settings_missing",
      "gst_settings row 'main' is missing — run: pnpm --filter @hmis/core seed:tariff",
    );
  }
  return { compositeHealthcareExempt: row.compositeHealthcareExempt, caSigned: row.caSigned };
}

/** ca_signed flips only via the §19 CA sign-off runbook step — this is the mechanical upsert it calls. */
export async function upsertGstSettings(tx: Tx, actor: Actor, patch: Partial<GstSettings>): Promise<void> {
  await tx
    .insert(gstSettings)
    .values({
      id: "main",
      ...(patch.compositeHealthcareExempt !== undefined
        ? { compositeHealthcareExempt: patch.compositeHealthcareExempt }
        : {}),
      ...(patch.caSigned !== undefined ? { caSigned: patch.caSigned } : {}),
      updatedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: gstSettings.id,
      set: {
        ...(patch.compositeHealthcareExempt !== undefined
          ? { compositeHealthcareExempt: patch.compositeHealthcareExempt }
          : {}),
        ...(patch.caSigned !== undefined ? { caSigned: patch.caSigned } : {}),
        updatedBy: actor.id,
        updatedAt: new Date(),
      },
    });
}
