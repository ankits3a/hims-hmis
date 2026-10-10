import { eq } from "drizzle-orm";
import { z } from "zod";
import { billingConfig } from "../../kernel/db/schema";
import { activePricePaise, listServices } from "../tariff";
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
/**
 * ═══ THE FEE SWITCHES (owner, 2026-10-01) ═══
 *
 * *"The OPD consultation fee is currently zero, tests are free right now. Add a system (a toggle
 * option) to enable/disable any fees."* A switch is a LEDGER OF FLIPS and not a boolean, because
 * the question a visit asks is "was this fee being charged when I was opened?" — a patient who
 * walked in while consultation was free must not be held at the doctor's door because the owner
 * switched charging on while they sat in the hall. No flips at all means the fee is charged.
 *
 * The flips live inside `charge_rules` because they ARE charge rules, and so that every reader of
 * the fee branch (`feeServiceFor`'s four callers) sees them with no new argument. They are written
 * ONLY by `setFeeSwitch` (fee-switches.ts), which names the actor and appends the audit event;
 * `updateBillingConfig` below carries the stored flips over whatever a patch says.
 */
export const FEE_KINDS = ["opdConsult", "lab", "imaging"] as const;
export type FeeKind = (typeof FEE_KINDS)[number];
const feeFlipSchema = z.object({ at: z.string().datetime(), off: z.boolean(), by: z.string().min(1) });
export type FeeFlip = z.infer<typeof feeFlipSchema>;
const feeSwitchesSchema = z.object({
  opdConsult: z.array(feeFlipSchema), lab: z.array(feeFlipSchema),
  // `imaging` (owner, 2026-10-10, decision 0065): off = an imaging study needs no bill to start.
  imaging: z.array(feeFlipSchema),
}).partial();
const chargeRulesSchema = z.object({
  // `revisit` (owner, 2026-10-05): optional. Absent, a revisit is free exactly as before; present,
  // it is charged only while the active tariff prices it above ₹0 (`chargeRulesAt`).
  opdConsult: z.object({ new: z.string().min(1), renewal: z.string().min(1), revisit: z.string().min(1).optional() }),
  feeSwitches: feeSwitchesSchema.optional(),
});

/**
 * THE REVISIT FEE (owner, 2026-10-05) — the charge rules as they apply at `at`. A revisit service is
 * wired by `seed:billing` long before anybody prices it, so a wired service whose active price is
 * missing or ₹0 is dropped here and the revisit stays on the free road, byte-for-byte as before.
 * Rules with no revisit service are returned as they are, with no read. Every reader of the fee
 * branch (`feeServiceFor`'s callers) passes its rules through this first.
 */
export async function chargeRulesAt(exec: Db | Tx, rules: ChargeRules, at: Date): Promise<ChargeRules> {
  const revisit = rules.opdConsult.revisit;
  if (revisit === undefined) return rules;
  const paise = await activePricePaise(exec, revisit, at);
  if (paise !== null && paise > 0) return rules;
  return { ...rules, opdConsult: { new: rules.opdConsult.new, renewal: rules.opdConsult.renewal } };
}

/** The latest flip, or null when the fee has never been switched (it is charged). */
export function lastFeeFlip(rules: ChargeRules, kind: FeeKind): FeeFlip | null {
  const flips = rules.feeSwitches?.[kind] ?? [];
  return flips[flips.length - 1] ?? null;
}
/** Is this fee switched off as things stand? Reads no clock: the last flip is the present. */
export function feeOffNow(rules: ChargeRules, kind: FeeKind): boolean {
  return lastFeeFlip(rules, kind)?.off ?? false;
}
/** Was this fee switched off at `at`? The last flip at or before it decides. */
export function feeOffAt(rules: ChargeRules, kind: FeeKind, at: Date): boolean {
  let off = false;
  for (const flip of rules.feeSwitches?.[kind] ?? []) {
    if (new Date(flip.at).getTime() > at.getTime()) break;
    off = flip.off;
  }
  return off;
}

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
  if (checked.chargeRules !== undefined) {
    // The fee switches have ONE writer, `setFeeSwitch`, which audits. A config patch that names the
    // fee branch keeps whatever flips are stored: it can neither erase the ledger nor forge a flip.
    const stored = await tx.select({ chargeRules: billingConfig.chargeRules }).from(billingConfig).where(eq(billingConfig.id, "main")).for("update");
    const storedRules = stored[0]?.chargeRules as ChargeRules | undefined;
    const kept = storedRules?.feeSwitches;
    // A patch written before the revisit fee existed names only new + renewal; it keeps the stored
    // revisit service rather than silently un-wiring it.
    const revisit = checked.chargeRules.opdConsult.revisit ?? storedRules?.opdConsult.revisit;
    const opdConsult = { ...checked.chargeRules.opdConsult, ...(revisit === undefined ? {} : { revisit }) };
    checked.chargeRules = { opdConsult, ...(kept === undefined ? {} : { feeSwitches: kept }) };
  }
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
    ...(cfg.chargeRules.opdConsult.revisit === undefined ? [] : [["revisit", cfg.chargeRules.opdConsult.revisit] as [string, string]]),
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
