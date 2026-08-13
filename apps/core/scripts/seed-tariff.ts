import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { upsertGstCategory, upsertGstSettings } from "../src/modules/tariff/gst-config";
import { upsertAdjustmentRule } from "../src/modules/tariff/rules";
import type { Actor } from "@hmis/contracts";

/**
 * Seeds/updates the dev GST config + D-8 manual-discount caps (idempotent — the
 * seed-registration.ts convention: onConflictDoUpdate under the hood, safe to re-run).
 *
 * EVERY value below is a DEV PLACEHOLDER — CA sign-off required (§19). These are NOT
 * authoritative tax data; `gst_settings.caSigned` stays false until the go-live CA sign-off
 * runbook step flips it. This script creates no tariff version and no service — config rows only.
 *
 * Usage: DATABASE_URL=postgres://... pnpm --filter @hmis/core seed:tariff
 */
const actor: Actor = { type: "system", id: "seed" };

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    await withTx(db, async (tx) => {
      // gst_settings 'main' — DEV PLACEHOLDER — CA sign-off required (§19).
      await upsertGstSettings(tx, actor, {
        compositeHealthcareExempt: true, // DEV PLACEHOLDER — CA sign-off required (§19)
        caSigned: false, // DEV PLACEHOLDER — CA sign-off required (§19): flips only via the CA sign-off runbook step
      });

      // Five gst_config category rows (CONFIG_A) — every rate/threshold is a DEV PLACEHOLDER —
      // CA sign-off required (§19). Exempt categories still carry their would-be rateBps
      // deliberately (D4/§3.14 defense: "exempt flag honored" vs "rate happens to be zero").
      await upsertGstCategory(tx, actor, {
        category: "consultation",
        sacCode: "999312", // DEV PLACEHOLDER — CA sign-off required (§19)
        exempt: true, // DEV PLACEHOLDER — CA sign-off required (§19)
        rateBps: 1800, // DEV PLACEHOLDER — CA sign-off required (§19): would-be rate, category is exempt
        specialRule: null,
        thresholdPaise: null,
      });
      await upsertGstCategory(tx, actor, {
        category: "procedure",
        sacCode: "999312", // DEV PLACEHOLDER — CA sign-off required (§19)
        exempt: true, // DEV PLACEHOLDER — CA sign-off required (§19)
        rateBps: 1800, // DEV PLACEHOLDER — CA sign-off required (§19): would-be rate, category is exempt
        specialRule: null,
        thresholdPaise: null,
      });
      await upsertGstCategory(tx, actor, {
        category: "room_rent",
        sacCode: "999311", // DEV PLACEHOLDER — CA sign-off required (§19)
        exempt: false, // DEV PLACEHOLDER — CA sign-off required (§19)
        rateBps: 500, // DEV PLACEHOLDER — CA sign-off required (§19)
        specialRule: "room_rent_daily_threshold",
        thresholdPaise: 500000, // DEV PLACEHOLDER — CA sign-off required (§19): ₹5,000/day (D-3)
      });
      await upsertGstCategory(tx, actor, {
        category: "pharmacy",
        sacCode: "3004", // DEV PLACEHOLDER — CA sign-off required (§19)
        exempt: false, // DEV PLACEHOLDER — CA sign-off required (§19)
        rateBps: 1200, // DEV PLACEHOLDER — CA sign-off required (§19)
        specialRule: null,
        thresholdPaise: null,
      });
      await upsertGstCategory(tx, actor, {
        category: "device",
        sacCode: "9021", // DEV PLACEHOLDER — CA sign-off required (§19)
        exempt: false, // DEV PLACEHOLDER — CA sign-off required (§19)
        rateBps: 500, // DEV PLACEHOLDER — CA sign-off required (§19)
        specialRule: null,
        thresholdPaise: null,
      });

      // Four D-8 manual-discount cap rows — every bps value is a DEV PLACEHOLDER — CA sign-off
      // required (§19).
      await upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-CHARITY",
        sourceKey: "manual",
        title: "Charity discount cap",
        params: {
          discountCategory: "charity",
          maxBps: 2500, // DEV PLACEHOLDER — CA sign-off required (§19)
          approvalAboveBps: 1000, // DEV PLACEHOLDER — CA sign-off required (§19)
        },
      });
      await upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-EMPLOYEE",
        sourceKey: "manual",
        title: "Employee discount cap",
        params: {
          discountCategory: "employee",
          maxBps: 1000, // DEV PLACEHOLDER — CA sign-off required (§19)
          approvalAboveBps: null, // DEV PLACEHOLDER — CA sign-off required (§19): no approval escalation configured
        },
      });
      await upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-SCHEME",
        sourceKey: "manual",
        title: "Scheme discount cap",
        params: {
          discountCategory: "scheme",
          maxBps: 1500, // DEV PLACEHOLDER — CA sign-off required (§19)
          approvalAboveBps: 1000, // DEV PLACEHOLDER — CA sign-off required (§19)
        },
      });
      await upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-NEGOTIATED-CORPORATE",
        sourceKey: "manual",
        title: "Negotiated corporate discount cap",
        params: {
          discountCategory: "negotiated_corporate",
          maxBps: 2000, // DEV PLACEHOLDER — CA sign-off required (§19)
          approvalAboveBps: 1500, // DEV PLACEHOLDER — CA sign-off required (§19)
        },
      });
    });
    console.log(
      "tariff config seeded: gst_settings 'main', 5 gst_config categories, 4 manual-discount caps " +
        "(ALL DEV PLACEHOLDERS — CA sign-off required, §19)",
    );
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // the shipped seed-admin.ts convention: a failed seed exits non-zero, loudly
