import { asc, desc, eq } from "drizzle-orm";
import { linenItems, linenVendorRates } from "../../kernel/db/schema";
import { licenceCalendar } from "./plantcost";
import { uniformRoles } from "./uniforms";
import { vendorCards } from "./vendor";
import type { LinenSetupView, LinenStream } from "@hmis/contracts";
import type { Exec } from "./intents";

/**
 * LD-2 setup (#1014) — the one read the laundry setup screen draws from: each vendor with its turnaround, GST and rate
 * card (newest first), every active linen item with its replacement-cost source (stores item, item-master price), the
 * plant licences on the calendar, and the roles issued uniforms. The acts are the LD-2 ones (`vendor.ts`, `plantcost.ts`,
 * `uniforms.ts`).
 */
export async function linenSetupView(exec: Exec, now: Date): Promise<LinenSetupView> {
  const vendors = await vendorCards(exec);
  const rates = await exec.select().from(linenVendorRates).orderBy(asc(linenVendorRates.itemCode), desc(linenVendorRates.effectiveFrom));
  const items = await exec.select().from(linenItems).where(eq(linenItems.active, true)).orderBy(asc(linenItems.sort), asc(linenItems.code));
  return {
    serverNow: now.toISOString(),
    vendors: vendors.map((v) => ({
      ...v,
      rates: rates.filter((r) => r.linenVendorId === v.id).map((r) => ({ itemCode: r.itemCode, ratePaise: r.ratePaise, effectiveFrom: r.effectiveFrom })),
    })),
    items: items.map((i) => ({ code: i.code, name: i.name, stream: i.stream as LinenStream, pricePaise: i.pricePaise, materialsItemId: i.materialsItemId })),
    licences: await licenceCalendar(exec, now),
    uniformRoles: await uniformRoles(exec),
  };
}
