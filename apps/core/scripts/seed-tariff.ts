import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { gstSettings } from "../src/kernel/db/schema";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { listGstCategories, upsertGstCategory, upsertGstSettings } from "../src/modules/tariff/gst-config";
import { listAdjustmentRules, upsertAdjustmentRule } from "../src/modules/tariff/rules";
import { registerTariffApprovalTypes } from "../src/modules/tariff/approval-types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * Seeds the dev GST config + D-8 manual-discount caps, and registers the `tariff_revision`
 * approval type.
 *
 * ═══ PLAN 11g / DD2 — SKIP-IF-PRESENT, BECAUSE "IDEMPOTENT" WAS NOT THE PROPERTY NEEDED ═══
 *
 * This script used to write every row below through `upsertGstSettings` / `upsertGstCategory` /
 * `upsertAdjustmentRule`, all three of which are `onConflictDoUpdate`. That is idempotent BY
 * VALUE — run it twice, get the same rows — and it is NOT non-destructive, which is a different
 * property and the one the deploy path needs. `deploy.sh` now runs this script on every deploy
 * (DD2's first half), and under the old behaviour every deploy would have silently restored DEV
 * PLACEHOLDER tax rates and discount caps over whatever a CA had corrected. **A deploy must never
 * be able to overwrite a corrected money or tax value.**
 *
 * So each row is now written only when it is ABSENT, and the report line says which — the
 * `seed-billing.ts` / `seed-opd.ts` house convention ("exists — left untouched"). The MODULE
 * functions keep their upsert semantics exactly: they are what the tariff routes and
 * `PUT /billing/config` use to change a value ON PURPOSE, and narrowing them would break the
 * repair path. The change belongs in the SEED, where the intent is "establish", not in the
 * module, where the intent is "set".
 *
 * EVERY value below is a DEV PLACEHOLDER — CA sign-off required (§19). These are NOT
 * authoritative tax data; `gst_settings.caSigned` stays false until the go-live CA sign-off
 * runbook step flips it. This script creates no tariff version and no service — config rows and
 * one approval-type registration only.
 *
 * Usage: DATABASE_URL=postgres://... pnpm --filter @hmis/core seed:tariff
 */
const actor: Actor = { type: "system", id: "seed" };
// `registerTariffApprovalTypes` needs a "user"-typed actor whose id differs from its fixed system
// drafter's; neither checks a real `users` row (no FK on draftedBy/activatedBy), so a fixed script
// identity is sufficient — the `seed-billing.ts` `activator` precedent, verbatim.
const activator: Actor = { type: "user", id: "seed-tariff" };

/**
 * CONFIG_A — the five GST category rows. Every rate/threshold is a DEV PLACEHOLDER — CA sign-off
 * required (§19). Exempt categories still carry their would-be `rateBps` deliberately (D4/§3.14
 * defence: "exempt flag honoured" reads differently from "rate happens to be zero").
 */
const GST_CATEGORIES = [
  {
    category: "consultation",
    sacCode: "999312", // DEV PLACEHOLDER — CA sign-off required (§19)
    exempt: true, // DEV PLACEHOLDER — CA sign-off required (§19)
    rateBps: 1800, // DEV PLACEHOLDER — CA sign-off required (§19): would-be rate, category is exempt
    specialRule: null,
    thresholdPaise: null,
  },
  {
    category: "procedure",
    sacCode: "999312", // DEV PLACEHOLDER — CA sign-off required (§19)
    exempt: true, // DEV PLACEHOLDER — CA sign-off required (§19)
    rateBps: 1800, // DEV PLACEHOLDER — CA sign-off required (§19): would-be rate, category is exempt
    specialRule: null,
    thresholdPaise: null,
  },
  {
    category: "room_rent",
    sacCode: "999311", // DEV PLACEHOLDER — CA sign-off required (§19)
    exempt: false, // DEV PLACEHOLDER — CA sign-off required (§19)
    rateBps: 500, // DEV PLACEHOLDER — CA sign-off required (§19)
    specialRule: "room_rent_daily_threshold" as const,
    thresholdPaise: 500000, // DEV PLACEHOLDER — CA sign-off required (§19): ₹5,000/day (D-3)
  },
  {
    category: "pharmacy",
    sacCode: "3004", // DEV PLACEHOLDER — CA sign-off required (§19)
    exempt: false, // DEV PLACEHOLDER — CA sign-off required (§19)
    rateBps: 1200, // DEV PLACEHOLDER — CA sign-off required (§19)
    specialRule: null,
    thresholdPaise: null,
  },
  {
    category: "device",
    sacCode: "9021", // DEV PLACEHOLDER — CA sign-off required (§19)
    exempt: false, // DEV PLACEHOLDER — CA sign-off required (§19)
    rateBps: 500, // DEV PLACEHOLDER — CA sign-off required (§19)
    specialRule: null,
    thresholdPaise: null,
  },
];

/** The four D-8 manual-discount cap rows — every bps value is a DEV PLACEHOLDER (§19). */
const DISCOUNT_CAPS = [
  {
    ruleKey: "CAP-CHARITY",
    sourceKey: "manual" as const,
    title: "Charity discount cap",
    params: {
      discountCategory: "charity",
      maxBps: 2500, // DEV PLACEHOLDER — CA sign-off required (§19)
      approvalAboveBps: 1000, // DEV PLACEHOLDER — CA sign-off required (§19)
    },
  },
  {
    ruleKey: "CAP-EMPLOYEE",
    sourceKey: "manual" as const,
    title: "Employee discount cap",
    params: {
      discountCategory: "employee",
      maxBps: 1000, // DEV PLACEHOLDER — CA sign-off required (§19)
      approvalAboveBps: null, // DEV PLACEHOLDER — CA sign-off required (§19): no approval escalation configured
    },
  },
  {
    ruleKey: "CAP-SCHEME",
    sourceKey: "manual" as const,
    title: "Scheme discount cap",
    params: {
      discountCategory: "scheme",
      maxBps: 1500, // DEV PLACEHOLDER — CA sign-off required (§19)
      approvalAboveBps: 1000, // DEV PLACEHOLDER — CA sign-off required (§19)
    },
  },
  {
    ruleKey: "CAP-NEGOTIATED-CORPORATE",
    sourceKey: "manual" as const,
    title: "Negotiated corporate discount cap",
    params: {
      discountCategory: "negotiated_corporate",
      maxBps: 2000, // DEV PLACEHOLDER — CA sign-off required (§19)
      approvalAboveBps: 1500, // DEV PLACEHOLDER — CA sign-off required (§19)
    },
  },
];

export type SeedTariffReport = {
  settings: "seeded" | "left untouched";
  categoriesSeeded: string[];
  categoriesLeft: string[];
  capsSeeded: string[];
  capsLeft: string[];
};

/**
 * DD2 — every write below is CONDITIONAL ON ABSENCE, and that is the whole point of this function
 * (see the file header). It is exported so `test/seed-tariff.test.ts` can drive it twice against
 * one database and read what the second run did, rather than asserting on a console transcript.
 */
export async function seedTariffConfig(db: Db): Promise<SeedTariffReport> {
  const settingsRows = await db.select({ id: gstSettings.id }).from(gstSettings).where(eq(gstSettings.id, "main"));
  const settingsPresent = settingsRows.length > 0;
  const haveCategories = new Set((await listGstCategories(db)).map((c) => c.category));
  const haveCaps = new Set((await listAdjustmentRules(db)).map((r) => r.ruleKey));

  const report: SeedTariffReport = {
    settings: settingsPresent ? "left untouched" : "seeded",
    categoriesSeeded: GST_CATEGORIES.filter((c) => !haveCategories.has(c.category)).map((c) => c.category),
    categoriesLeft: GST_CATEGORIES.filter((c) => haveCategories.has(c.category)).map((c) => c.category),
    capsSeeded: DISCOUNT_CAPS.filter((r) => !haveCaps.has(r.ruleKey)).map((r) => r.ruleKey),
    capsLeft: DISCOUNT_CAPS.filter((r) => haveCaps.has(r.ruleKey)).map((r) => r.ruleKey),
  };

  await withTx(db, async (tx) => {
    if (!settingsPresent) {
      // gst_settings 'main' — DEV PLACEHOLDER — CA sign-off required (§19).
      await upsertGstSettings(tx, actor, {
        compositeHealthcareExempt: true, // DEV PLACEHOLDER — CA sign-off required (§19)
        caSigned: false, // DEV PLACEHOLDER — CA sign-off required (§19): flips only via the CA sign-off runbook step
      });
    }
    for (const cfg of GST_CATEGORIES) {
      if (haveCategories.has(cfg.category)) continue;
      await upsertGstCategory(tx, actor, cfg);
    }
    for (const rule of DISCOUNT_CAPS) {
      if (haveCaps.has(rule.ruleKey)) continue;
      await upsertAdjustmentRule(tx, actor, rule);
    }
  });

  return report;
}

function describe(seeded: string[], left: string[]): string {
  const parts: string[] = [];
  if (seeded.length > 0) parts.push(`seeded ${seeded.join(", ")}`);
  if (left.length > 0) parts.push(`${left.join(", ")} exist — left untouched`);
  return parts.length > 0 ? parts.join("; ") : "none declared";
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await seedTariffConfig(db);
    console.log(`gst_settings 'main': ${report.settings}`);
    console.log(`gst_config: ${describe(report.categoriesSeeded, report.categoriesLeft)}`);
    console.log(`manual-discount caps: ${describe(report.capsSeeded, report.capsLeft)}`);
    if (report.categoriesSeeded.length > 0 || report.settings === "seeded") {
      console.log("newly seeded rows are ALL DEV PLACEHOLDERS — CA sign-off required (§19)");
    }

    // The SoD pair rows the workflow drafter/activator check reads must exist before the
    // registration below can draft-then-activate a definition (kernel/auth/sod.ts). `seedSodPairs`
    // is an ensure and `seed:billing` already calls it; running it here makes THIS script
    // self-sufficient rather than dependent on seed order.
    await seedSodPairs(db);
    await registerTariffApprovalTypes(db, activator);
    console.log("approval type ensured: tariff_revision (report D7 gap 2 — nothing registered it before)");
  } finally {
    await pool.end();
  }
}
// Guarded so `test/seed-tariff.test.ts` can import `seedTariffConfig` without the script running
// itself on import — the `seed-roles.ts` / `seed-admin.ts` house convention. `tsx
// scripts/seed-tariff.ts` still runs it: apps/core declares no `"type": "module"`, so this file is
// CommonJS and `require.main` is this module.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  }); // the shipped seed-admin.ts convention: a failed seed exits non-zero, loudly
}
