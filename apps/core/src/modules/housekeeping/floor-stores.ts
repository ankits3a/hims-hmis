import { asc, eq, inArray } from "drizzle-orm";
import { hkMonth, hkMonthWindow, linkFloorStoreInput } from "@hmis/contracts";
import { hkFloorStores, resources } from "../../kernel/db/schema";
import { occupiedBedDays } from "../ipd";
import { listStores, requireStore, storeReceipts } from "../materials";
import { HousekeepingRefusal } from "./errors";
import { parse } from "./setup";
import type { Actor, HkConsumablesView, HkFloorConsumables, HkFloorStoreView } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * HK-2 (#974, decision 0086) — FLOOR STORES AND THE MONTHLY CONSUMABLES. Each floor's housekeeping cupboard is a materials
 * sub-store (its custodian the floor supervisor). The supervisor raises an indent on the central store, the store keeper
 * issues it, the floor receives it: the existing indent → transfer → receipt flow, no new stock path. Housekeeping only
 * links the floor to its store and reads what the store RECEIVED in the IST month (DECIDED: issue to the floor books the
 * expense; there is no per-use count), valued at the batch's landed cost on the transfer. A floor with IPD beds also gets
 * its cost per occupied bed-day (ipd's midnight census); any other floor shows the total only.
 */
export async function linkFloorStore(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<HkFloorStoreView> {
  const input = parse(linkFloorStoreInput, raw);
  const floor = (await db.select({ kind: resources.kind, name: resources.name }).from(resources).where(eq(resources.id, input.floorId)))[0];
  if (floor?.kind !== "floor") throw new HousekeepingRefusal("not_a_floor", { floorId: input.floorId });
  let storeName: string;
  try {
    storeName = (await requireStore(db, input.storeId)).name;
  } catch {
    throw new HousekeepingRefusal("not_a_store", { storeId: input.storeId });
  }
  const holder = (await db.select({ floorId: hkFloorStores.floorId }).from(hkFloorStores).where(eq(hkFloorStores.storeId, input.storeId)))[0];
  if (holder !== undefined && holder.floorId !== input.floorId) throw new HousekeepingRefusal("store_taken", { storeId: input.storeId });
  const values = { storeId: input.storeId, updatedBy: actor.id, updatedAt: now };
  await db.insert(hkFloorStores).values({ floorId: input.floorId, ...values }).onConflictDoUpdate({ target: hkFloorStores.floorId, set: values });
  return { floorId: input.floorId, floorName: floor.name, storeId: input.storeId, storeName };
}

/** Every floor with its housekeeping store (or none yet), and the stores that may be linked. */
export async function floorStoresView(db: Db): Promise<{ floors: HkFloorStoreView[]; stores: { id: string; code: string; name: string }[] }> {
  const floors = await db.select({ id: resources.id, name: resources.name }).from(resources).where(eq(resources.kind, "floor")).orderBy(asc(resources.code)).limit(500);
  const links = await db.select().from(hkFloorStores);
  const stores = await listStores(db);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const linkOf = new Map(links.map((l) => [l.floorId, l.storeId]));
  return {
    floors: floors.map((f) => {
      const storeId = linkOf.get(f.id) ?? null;
      return { floorId: f.id, floorName: f.name, storeId, storeName: storeId === null ? null : storeName.get(storeId) ?? null };
    }),
    stores: stores.map((s) => ({ id: s.id, code: s.code, name: s.name })),
  };
}

export async function floorConsumables(db: Db, month: string, now: Date = new Date()): Promise<HkConsumablesView> {
  if (!hkMonth.safeParse(month).success) throw new HousekeepingRefusal("bad_month", { month });
  const { start, end } = hkMonthWindow(month);
  const links = await db.select().from(hkFloorStores);
  if (links.length === 0) return { month, floors: [], totalPaise: 0 };
  const ids = [...new Set(links.flatMap((l) => [l.floorId, l.storeId]))];
  const names = new Map((await db.select({ id: resources.id, name: resources.name, code: resources.code }).from(resources)
    .where(inArray(resources.id, ids))).map((r) => [r.id, r]));
  const receipts = await storeReceipts(db, links.map((l) => l.storeId), start, end);
  const floors: HkFloorConsumables[] = [];
  for (const l of links) {
    const lines = receipts.filter((r) => r.storeId === l.storeId)
      .map((r) => ({ itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, baseUom: r.baseUom, qty: r.qty, valuePaise: r.valuePaise }));
    const totalPaise = lines.reduce((s, x) => s + x.valuePaise, 0);
    const census = await occupiedBedDays(db, l.floorId, start, end, now);
    const bedDays = census.beds > 0 ? census.occupiedBedDays : null;
    floors.push({
      floorId: l.floorId, floorName: names.get(l.floorId)?.name ?? "", storeId: l.storeId, storeName: names.get(l.storeId)?.name ?? "",
      items: lines, totalPaise, beds: census.beds, occupiedBedDays: bedDays,
      costPerBedDayPaise: bedDays !== null && bedDays > 0 ? Math.round(totalPaise / bedDays) : null,
    });
  }
  floors.sort((a, b) => (names.get(a.floorId)?.code ?? "").localeCompare(names.get(b.floorId)?.code ?? ""));
  return { month, floors, totalPaise: floors.reduce((s, f) => s + f.totalPaise, 0) };
}
