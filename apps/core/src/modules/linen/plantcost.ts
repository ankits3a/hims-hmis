import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { fileLicenceInput, LAUNDRY_COST_CENTRE, LINEN_LICENCE_RED_DAYS, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { linenLicences, linenWashCycles } from "../../kernel/db/schema";
import { LinenError } from "./errors";
import { lock, parse, stamp, tx } from "./intents";
import { istMonthWindow, vendorMonthCost } from "./vendor";
import type { Actor, LinenChemicalUse, LinenLicenceKind, LinenLicenceRow } from "@hmis/contracts";
import type { Exec } from "./intents";

/**
 * ═══ THE PLANT'S COST AND LICENCES (LD-2, #979, D7 D8) ═══
 *
 * Chemicals: stores issues detergent and chemicals against the laundry cost centre (`stock_ledger.cost_center =
 * 'laundry'`, an outbound movement); the plant's kg washed is the dry load weighed at each cycle's finish. The read
 * divides one by the other for the month, and sets the vendor's per-kg cost beside it (accepted value ÷ kg sent).
 *
 * Licences: the wastewater (ETP) consent and the boiler licence, one live per kind, red within 60 days of expiry. The
 * hospital's compliance calendar today is radiation's (aerb, device-bound); linen keeps its own rows in the same shape
 * and shows them on the laundry desk. One hospital-wide calendar is owed (see the spec's build notes).
 */
const DAY = 24 * 3_600_000;

export async function chemicalUse(exec: Exec, month: string): Promise<LinenChemicalUse> {
  const w = istMonthWindow(month);
  const load = await exec.select({ g: sql<string>`coalesce(sum(${linenWashCycles.loadGrams}), 0)` }).from(linenWashCycles)
    .where(and(gte(linenWashCycles.finishedAt, w.start), lt(linenWashCycles.finishedAt, w.end)));
  const kg = Number(load[0]?.g ?? 0) / 1000;
  const r = await exec.execute<{ item_id: string; name: string; uom: string; qty: string; cost: string }>(sql`
    select l.item_id, i.name, i.base_uom as uom, sum(-l.qty_delta) as qty, sum(-l.qty_delta * b.landed_cost_paise) as cost
      from stock_ledger l join items i on i.id = l.item_id join stock_batches b on b.id = l.batch_id
     where l.cost_center = ${LAUNDRY_COST_CENTRE} and l.qty_delta < 0
       and l.occurred_at >= ${w.start.toISOString()}::timestamptz and l.occurred_at < ${w.end.toISOString()}::timestamptz
     group by l.item_id, i.name, i.base_uom order by i.name`);
  const items = r.rows.map((x) => {
    const qty = Number(x.qty);
    const cost = Number(x.cost);
    return {
      itemId: x.item_id, name: x.name, uom: x.uom, qty, costPaise: cost,
      perKg: kg > 0 ? Math.round((qty / kg) * 10_000) / 10_000 : 0, costPerKgPaise: kg > 0 ? Math.round(cost / kg) : 0,
    };
  });
  const totalCost = items.reduce((n, i) => n + i.costPaise, 0);
  const vendor = await vendorMonthCost(exec, month);
  return {
    month, kgWashed: kg, items, inHouseCostPerKgPaise: kg > 0 ? Math.round(totalCost / kg) : null,
    vendorKgSent: vendor.kgSent, vendorCostPerKgPaise: vendor.kgSent > 0 ? Math.round(vendor.valuePaise / vendor.kgSent) : null,
  };
}

/** File (or renew) a plant licence: the new one is live, the old one of its kind is kept as history. */
export async function fileLicence(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ id: string }> {
  const input = parse(fileLicenceInput, raw);
  if (input.validTo < input.validFrom) throw new LinenError("licence_dates");
  return tx(exec, async (t) => {
    await lock(t, `licence:${input.kind}`);
    const now = await stamp(t, nowIn);
    await t.update(linenLicences).set({ active: false }).where(and(eq(linenLicences.kind, input.kind), eq(linenLicences.active, true)));
    const row = (await t.insert(linenLicences).values({
      id: newId(), kind: input.kind, licenceNo: input.licenceNo, authority: input.authority, validFrom: input.validFrom,
      validTo: input.validTo, filedBy: actor.id, filedAt: now,
    }).returning())[0]!;
    return { id: row.id };
  });
}

/** The plant's licences on the calendar: days left by IST day; red within 60 days, expired past the date (D8). */
export async function licenceCalendar(exec: Exec, now: Date): Promise<LinenLicenceRow[]> {
  const today = Date.parse(`${istDayString(now)}T00:00:00Z`);
  const rows = await exec.select().from(linenLicences).where(eq(linenLicences.active, true)).orderBy(asc(linenLicences.validTo));
  return rows.map((l) => {
    const daysLeft = Math.round((Date.parse(`${l.validTo}T00:00:00Z`) - today) / DAY);
    return {
      id: l.id, kind: l.kind as LinenLicenceKind, licenceNo: l.licenceNo, authority: l.authority, validTo: l.validTo, daysLeft,
      state: daysLeft < 0 ? "expired" : daysLeft <= LINEN_LICENCE_RED_DAYS ? "red" : "ok",
    };
  });
}
