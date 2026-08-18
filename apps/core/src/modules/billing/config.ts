import { eq } from "drizzle-orm";
import { z } from "zod";
import { billingConfig } from "../../kernel/db/schema";
import { listServices } from "../tariff";
import { BillingError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * D-17 — the single audited config row. Every threshold in this module is DATA a CA revises
 * against its statutory anchor, never a constant (C-2 cash law, the refund bank-transfer floor,
 * credit/outstanding caps, PSP fee basis points, recon tolerance, document-series prefixes, the
 * OPD fee branch). A missing row hard-fails every billing write with `billing_not_configured`
 * (T1's errors.ts closed union — frozen outside this task's Files list).
 */
export const SERIES_KEYS = ["invoice", "receipt", "credit_note", "voucher"] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];

const outstandingCapModeSchema = z.enum(["off", "warn", "block"]);
const feeBpsSchema = z.object({
  upi: z.number().int().nonnegative(),
  card: z.number().int().nonnegative(),
});
// A LOOSE string->string map, deliberately NOT `Partial<Record<SeriesKey,...>>` at the zod layer:
// a config missing one of the four canonical keys is a shape a WRITE may legally hold — it is a
// COMPLETENESS question, checked by validateBillingConfig/validate:billing below, never a shape
// one. A strict-shape schema here would make the "seriesPrefixes missing a key" break
// unconstructable through the public API, which defeats the point of the gate that catches it.
const seriesPrefixesSchema = z.record(z.string(), z.string().min(1));
const chargeRulesSchema = z.object({
  opdConsult: z.object({ new: z.string().min(1), renewal: z.string().min(1) }),
});

export type FeeBps = z.infer<typeof feeBpsSchema>;
export type ChargeRules = z.infer<typeof chargeRulesSchema>;

export type BillingConfig = {
  cashWarnPaise: number;
  cashBlockPaise: number;
  panThresholdPaise: number;
  refundBankAbovePaise: number;
  creditCapPaise: number;
  outstandingCapPaise: number;
  outstandingCapMode: "off" | "warn" | "block";
  feeBps: FeeBps;
  reconTolerancePaise: number;
  seriesPrefixes: Partial<Record<SeriesKey, string>>;
  chargeRules: ChargeRules;
  degradedTender: boolean;
  caSigned: boolean;
};

export async function loadBillingConfig(db: Db | Tx): Promise<BillingConfig> {
  const rows = await db.select().from(billingConfig).where(eq(billingConfig.id, "main"));
  const row = rows[0];
  if (!row) throw new BillingError("billing_not_configured", "billing_config row 'main' is missing — run seed:billing");
  // No shape re-validation of the jsonb columns here: every writer (updateBillingConfig below,
  // and seed-billing.ts's initial insert) already ran the SAME schemas this file defines, so a
  // stored row is valid by construction. T1's errors.ts (frozen outside this task) carries no
  // dedicated "config shape" code to raise if it somehow weren't.
  return {
    cashWarnPaise: row.cashWarnPaise,
    cashBlockPaise: row.cashBlockPaise,
    panThresholdPaise: row.panThresholdPaise,
    refundBankAbovePaise: row.refundBankAbovePaise,
    creditCapPaise: row.creditCapPaise,
    outstandingCapPaise: row.outstandingCapPaise,
    outstandingCapMode: row.outstandingCapMode as "off" | "warn" | "block",
    feeBps: row.feeBps as FeeBps,
    reconTolerancePaise: row.reconTolerancePaise,
    seriesPrefixes: row.seriesPrefixes as Partial<Record<SeriesKey, string>>,
    chargeRules: row.chargeRules as ChargeRules,
    degradedTender: row.degradedTender,
    caSigned: row.caSigned,
  };
}

export type BillingConfigPatch = Partial<BillingConfig>;

const configPatchSchema = z
  .object({
    cashWarnPaise: z.number().int().positive(),
    cashBlockPaise: z.number().int().positive(),
    panThresholdPaise: z.number().int().positive(),
    refundBankAbovePaise: z.number().int().positive(),
    creditCapPaise: z.number().int().nonnegative(),
    outstandingCapPaise: z.number().int().nonnegative(),
    outstandingCapMode: outstandingCapModeSchema,
    feeBps: feeBpsSchema,
    reconTolerancePaise: z.number().int().nonnegative(),
    seriesPrefixes: seriesPrefixesSchema,
    chargeRules: chargeRulesSchema,
    degradedTender: z.boolean(),
    caSigned: z.boolean(),
  })
  .partial();

/**
 * The admin patch (T11's PUT /billing/config, out of this task's scope). Validation happens
 * BEFORE the row is touched — the OPD updateOpdConfig shape — so a bad shape never lands; a
 * failing patch throws the raw ZodError (no dedicated "invalid config" BillingErrorCode exists in
 * T1's closed union, which sits outside this task's Files list to extend). `billing_config`
 * carries no `updatedBy` column (unlike opd_config), so — unlike updateOpdConfig — this takes no
 * actor.
 */
export async function updateBillingConfig(tx: Tx, patch: BillingConfigPatch, now: Date = new Date()): Promise<BillingConfig> {
  const checked = configPatchSchema.parse(patch);
  const rows = await tx
    .update(billingConfig)
    .set({ ...checked, updatedAt: now })
    .where(eq(billingConfig.id, "main"))
    .returning({ id: billingConfig.id });
  if (rows.length === 0) throw new BillingError("billing_not_configured", "billing_config row 'main' is missing — run seed:billing");
  return loadBillingConfig(tx);
}

export type ConfigError = { code: string; detail: string };

/**
 * D-17 go-live gate (§19), the M1 lesson applied to billing: every check below is built on
 * `loadBillingConfig` (this module's OWN runtime loader) plus `listServices` (tariff's OWN
 * runtime loader) — never a hand-rolled query — so the gate sees exactly what issueInvoice and
 * the fee-branch guard will see at billing time. Read-only; accumulates ConfigErrors and never
 * throws (validate-billing-config.ts prints them and exits 1 on any).
 */
export async function validateBillingConfig(db: Db): Promise<{ ok: boolean; errors: ConfigError[] }> {
  const errors: ConfigError[] = [];

  let cfg: BillingConfig;
  try {
    cfg = await loadBillingConfig(db);
  } catch (e) {
    errors.push({
      code: e instanceof BillingError ? e.code : "billing_config_load_failed",
      detail: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, errors };
  }

  // chargeRules — every fee-branch service must exist AND be active, read through
  // `listServices(db)`, tariff's own runtime loader (the M1 shape: never a raw `services` query).
  const svcRows = await listServices(db);
  const byId = new Map(svcRows.map((s) => [s.id, s]));
  const branches: [string, string][] = [
    ["new", cfg.chargeRules.opdConsult.new],
    ["renewal", cfg.chargeRules.opdConsult.renewal],
  ];
  for (const [branch, serviceId] of branches) {
    const svc = byId.get(serviceId);
    if (!svc) {
      errors.push({
        code: "charge_rule_service_missing",
        detail: `charge_rules.opdConsult.${branch} names service ${serviceId}, which does not exist in services`,
      });
    } else if (!svc.active) {
      errors.push({
        code: "charge_rule_service_inactive",
        detail: `charge_rules.opdConsult.${branch} names service "${svc.code}" (${serviceId}), which is INACTIVE`,
      });
    }
  }

  if (cfg.cashWarnPaise >= cfg.cashBlockPaise) {
    errors.push({
      code: "cash_threshold_inverted",
      detail: `cash_warn_paise (${cfg.cashWarnPaise}) must be strictly less than cash_block_paise (${cfg.cashBlockPaise})`,
    });
  }

  for (const key of SERIES_KEYS) {
    if (!cfg.seriesPrefixes[key]) {
      errors.push({ code: "series_prefix_missing", detail: `series_prefixes has no entry for "${key}"` });
    }
  }

  return { ok: errors.length === 0, errors };
}
