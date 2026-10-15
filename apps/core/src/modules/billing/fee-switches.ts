import { eq, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { billingConfig, labOrderables } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { listPriceList } from "../tariff";
import { FEE_KINDS, feeOffNow, lastFeeFlip, loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { feeSwitchChanged } from "./events";
import type { ChargeRules, FeeKind } from "./config";
import type { PricingContext } from "../tariff";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE FEE SWITCHES (owner, 2026-10-01) ═══
 *
 * Two fees can be switched off and on by the billing office: the OPD consultation fee and the
 * laboratory's test fees. Off means FREE — and the two reach "free" by different roads, because
 * they are billed differently:
 *
 *   · `opdConsult` — the visit has no fee at all (`feeServiceFor` answers null). No invoice is
 *     issued, the door guards pass, the queue shows it as free. The existing review-visit road.
 *   · `lab` — the order is still BILLED, at ₹0 a test (`withFeeSwitches` below). The lab needs its
 *     invoice: the report interlock, the cancel path and the day book all read one.
 *
 * Switching a fee ON charges what the active tariff says. The price itself is not set here — a
 * price change is a tariff version, with its own approval.
 */
export type FeeSwitchView = { kind: FeeKind; off: boolean; changedAt: string | null; changedBy: string | null };
export type FeeSwitchesView = {
  switches: FeeSwitchView[];
  /** What the consultation costs when it is charged, from the active tariff; null where unpriced. */
  consultPaise: { new: number | null; renewal: number | null };
};

export async function feeSwitchesView(db: Db, now: Date = new Date()): Promise<FeeSwitchesView> {
  const { chargeRules } = await loadBillingConfig(db);
  const prices = new Map((await listPriceList(db, now)).map((row) => [row.serviceId, row.pricePaise]));
  return {
    switches: FEE_KINDS.map((kind) => {
      const last = lastFeeFlip(chargeRules, kind);
      return { kind, off: last?.off ?? false, changedAt: last?.at ?? null, changedBy: last?.by ?? null };
    }),
    consultPaise: {
      new: prices.get(chargeRules.opdConsult.new) ?? null,
      renewal: prices.get(chargeRules.opdConsult.renewal) ?? null,
    },
  };
}

/**
 * The ONE writer of a flip. A named person only; the row is locked so two taps cannot both append;
 * a tap that changes nothing writes nothing and audits nothing.
 */
export async function setFeeSwitch(db: Db, actor: Actor, kind: FeeKind, off: boolean, now: Date = new Date()): Promise<FeeSwitchesView> {
  if (actor.type !== "user") throw new BillingError("fee_not_applicable", "a fee is switched by a named person");
  await withTx(db, async (tx) => {
    const rows = await tx.select({ chargeRules: billingConfig.chargeRules }).from(billingConfig).where(eq(billingConfig.id, "main")).for("update");
    const stored = rows[0]?.chargeRules as ChargeRules | undefined;
    if (stored === undefined) throw new BillingError("billing_not_configured", "billing_config row 'main' is missing — run seed:billing");
    if (feeOffNow(stored, kind) === off) return;
    const flips = [...(stored.feeSwitches?.[kind] ?? []), { at: now.toISOString(), off, by: actor.id }];
    const chargeRules: ChargeRules = { ...stored, feeSwitches: { ...stored.feeSwitches, [kind]: flips } };
    await tx.update(billingConfig).set({ chargeRules, updatedAt: now }).where(eq(billingConfig.id, "main"));
    await appendEvent(tx, feeSwitchChanged.make({ actor, payload: { kind, off } }));
  });
  return feeSwitchesView(db, now);
}

/**
 * The pricing half of the `lab` switch: while it is off, every line that is a LABORATORY TEST prices
 * at ₹0 — including a test the tariff has not priced yet, which would otherwise refuse the whole
 * order with `tariff_item_missing`. "A laboratory test" is membership of `lab_orderables`, the lab's
 * own catalogue; imaging shares the `investigation` tax category and is not touched.
 *
 * Quote and invoice both price through here, so they cannot disagree. An unconfigured billing module
 * has no switches and prices exactly as before.
 */
export async function withFeeSwitches(db: Db, base: PricingContext, serviceIds: string[]): Promise<PricingContext> {
  let rules: ChargeRules;
  try {
    rules = (await loadBillingConfig(db)).chargeRules;
  } catch (e) {
    if (e instanceof BillingError) return base;
    throw e;
  }
  if (!feeOffNow(rules, "lab") || serviceIds.length === 0) return base;
  const tests = await db.select({ serviceId: labOrderables.serviceId }).from(labOrderables).where(inArray(labOrderables.serviceId, [...new Set(serviceIds)]));
  if (tests.length === 0) return base;
  const items = { ...base.tariff.items };
  for (const test of tests) items[test.serviceId] = 0;
  return { ...base, tariff: { ...base.tariff, items } };
}
