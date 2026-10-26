import { eq } from "drizzle-orm";
import { CANTEEN_GST_CATEGORIES, CANTEEN_MEAL_SERVICE_CODE, newId } from "@hmis/contracts";
import { gstConfig, services } from "../../kernel/db/schema";
import { CANTEEN_DIET_SERVICE_CODE } from "../ipd";
import type { Db } from "../../kernel/db/client";

/**
 * The canteen's rows other modules read, put in by migration 0262 and, for a truncated test database, by the test
 * fixture: the `gst_config` rows of decision 0088 (also in migration 0262) and the two tariff services an IPD-bill meal
 * posts against — `CANTEEN_MEAL` (canteen food, 5%) and `CANTEEN_DIET` (in-patient diet, exempt). The price is always
 * the canteen's (a prepaid quote), so neither needs a tariff item. Idempotent: an existing row is never changed (finance
 * and the CA own the rates once set).
 */
const GST_ROWS = [
  { category: CANTEEN_GST_CATEGORIES.food, sacCode: "996331", exempt: false, rateBps: 500 },
  { category: CANTEEN_GST_CATEGORIES.rent, sacCode: "997212", exempt: false, rateBps: 1800 },
  { category: CANTEEN_GST_CATEGORIES.inpatientDiet, sacCode: "999311", exempt: true, rateBps: 500 },
] as const;

const SERVICES = [
  { code: CANTEEN_MEAL_SERVICE_CODE, name: "Canteen meal (attendant)", category: CANTEEN_GST_CATEGORIES.food },
  { code: CANTEEN_DIET_SERVICE_CODE, name: "Patient meal (in-patient diet)", category: CANTEEN_GST_CATEGORIES.inpatientDiet },
] as const;

export async function seedCanteenBasics(db: Db): Promise<{ gstRows: number; services: number }> {
  let gstRows = 0;
  let made = 0;
  for (const r of GST_ROWS) {
    const ins = await db.insert(gstConfig).values({ ...r, updatedBy: "seed:canteen" }).onConflictDoNothing().returning({ c: gstConfig.category });
    gstRows += ins.length;
  }
  for (const s of SERVICES) {
    if ((await db.select({ id: services.id }).from(services).where(eq(services.code, s.code))).length > 0) continue;
    await db.insert(services).values({ id: newId(), code: s.code, name: s.name, category: s.category, createdBy: "seed:canteen", updatedBy: "seed:canteen" });
    made += 1;
  }
  return { gstRows, services: made };
}
