import { and, asc, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { BMW_CATEGORIES, BMW_ON_SITE_STATES, bmwClockLevel, bmwGapFlagged } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { bmwBags, bmwDisputes, bmwManifests, resources } from "../../kernel/db/schema";
import { BmwError } from "./errors";
import type {
  BmwBagCard, BmwBoardView, BmwCategory, BmwDisputeCard, BmwHandlerView, BmwManifestCard, BmwPlace, BmwWardGeneration,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { BagRow } from "./intents";

/**
 * THE READ MODELS: the supervisor's board, the handler's phone and one bag by its scan. No patient, no money.
 */
type Place = { name: string; floorName: string | null };

/** Each place's own name and the FLOOR above it (walked up the registry), the `tasks/reads.ts` walk. */
async function placesOf(db: Db, ids: readonly string[]): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ start: string; kind: string; name: string; depth: number }>(sql`
    with recursive up as (
      select r.id as start, r.id, r.parent_id, r.kind, r.name, 0 as depth
        from resources r where r.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      union all
      select up.start, p.id, p.parent_id, p.kind, p.name, up.depth + 1
        from resources p join up on p.id = up.parent_id where up.depth < 8
    )
    select start, kind, name, depth from up order by depth`);
  for (const r of rows.rows) {
    const cur = out.get(r.start) ?? { name: "", floorName: null };
    if (Number(r.depth) === 0) cur.name = r.name;
    else if (r.kind === "floor" && cur.floorName === null) cur.floorName = r.name;
    out.set(r.start, cur);
  }
  return out;
}

export async function bagCards(db: Db, rows: readonly BagRow[]): Promise<BmwBagCard[]> {
  const places = await placesOf(db, [...new Set(rows.map((r) => r.placeResourceId))]);
  return rows.map((r) => ({
    id: r.id, barcode: r.barcode, category: r.category as BmwCategory, cytotoxic: r.cytotoxic, state: r.state as BmwBagCard["state"],
    placeResourceId: r.placeResourceId, placeName: places.get(r.placeResourceId)?.name ?? "", floorName: places.get(r.placeResourceId)?.floorName ?? null,
    generatedAt: r.generatedAt.toISOString(), deptWeightGrams: r.deptWeightGrams, centralWeightGrams: r.centralWeightGrams,
    centralGap: r.centralWeightGrams !== null && r.deptWeightGrams !== null && bmwGapFlagged(r.deptWeightGrams, r.centralWeightGrams),
    storageInAt: r.storageInAt?.toISOString() ?? null, handedOverAt: r.handedOverAt?.toISOString() ?? null,
    manifestId: r.manifestId, cbwtfWeightGrams: r.cbwtfWeightGrams, version: r.version,
  }));
}

export async function bagByBarcode(db: Db, barcode: string): Promise<BmwBagCard> {
  const row = (await db.select().from(bmwBags).where(eq(bmwBags.barcode, barcode.trim().toUpperCase())))[0];
  if (row === undefined) throw new BmwError("unknown_bag", { barcode });
  return (await bagCards(db, [row]))[0]!;
}

/**
 * DECIDED: the CBWTF collects once a day at 10:00 IST (the usual contract slot in Bihar). The board shows the next
 * one; a missed pickup shows as bags crossing 36 and 48 hours on the same board.
 */
export const BMW_PICKUP_IST = { hour: 10, minute: 0 };

export function nextPickupAt(now: Date): Date {
  const { start } = istDayWindow(now);
  const today = new Date(start.getTime() + (BMW_PICKUP_IST.hour * 60 + BMW_PICKUP_IST.minute) * 60_000);
  return today > now ? today : new Date(today.getTime() + 86_400_000);
}

const ON_SITE_SHOWN = 300;

export async function bmwBoard(db: Db, now: Date = new Date()): Promise<BmwBoardView> {
  const onSiteRows = await db.select().from(bmwBags).where(inArray(bmwBags.state, [...BMW_ON_SITE_STATES]))
    .orderBy(asc(bmwBags.generatedAt)).limit(ON_SITE_SHOWN);
  const onSite = await bagCards(db, onSiteRows);
  const { start, end } = istDayWindow(now);
  const todayRows = await db.select({
    place: bmwBags.placeResourceId, category: bmwBags.category,
    bags: sql<number>`count(*)::int`, grams: sql<number>`coalesce(sum(${bmwBags.deptWeightGrams}), 0)::int`,
  }).from(bmwBags).where(and(gte(bmwBags.generatedAt, start), lt(bmwBags.generatedAt, end)))
    .groupBy(bmwBags.placeResourceId, bmwBags.category);
  const places = await placesOf(db, [...new Set(todayRows.map((r) => r.place))]);
  const byPlace = new Map<string, BmwWardGeneration>();
  for (const r of todayRows) {
    const w = byPlace.get(r.place) ?? {
      placeResourceId: r.place, placeName: places.get(r.place)?.name ?? "", bags: 0, grams: 0,
      byCategory: Object.fromEntries(BMW_CATEGORIES.map((c) => [c, 0])) as Record<BmwCategory, number>,
    };
    w.bags += r.bags;
    w.grams += r.grams;
    w.byCategory[r.category as BmwCategory] += r.bags;
    byPlace.set(r.place, w);
  }
  const today = [...byPlace.values()].sort((a, b) => (b.grams - a.grams) || a.placeName.localeCompare(b.placeName));

  const disputeRows = await db.select({ d: bmwDisputes, no: bmwManifests.manifestNo }).from(bmwDisputes)
    .innerJoin(bmwManifests, eq(bmwManifests.id, bmwDisputes.manifestId))
    .where(eq(bmwDisputes.state, "open")).orderBy(asc(bmwDisputes.openedAt)).limit(50);
  const disputes: BmwDisputeCard[] = disputeRows.map(({ d, no }) => ({
    id: d.id, manifestId: d.manifestId, manifestNo: no, category: d.category as BmwCategory, deptGrams: d.deptGrams,
    cbwtfGrams: d.cbwtfGrams, gapBasisPoints: d.gapBasisPoints, state: d.state as "open", openedAt: d.openedAt.toISOString(),
  }));

  const last = (await db.select().from(bmwManifests).orderBy(desc(bmwManifests.handedOverAt)).limit(1))[0];
  const lastManifest: BmwManifestCard | null = last === undefined ? null : {
    id: last.id, manifestNo: last.manifestNo, cbwtfName: last.cbwtfName, vehicleNo: last.vehicleNo, handedOverAt: last.handedOverAt.toISOString(),
    bags: last.bagCount, deptGrams: Object.values(last.totals).reduce((n, t) => n + t.deptGrams, 0), cbwtfRecorded: last.cbwtfRecordedAt !== null,
  };
  const levels = onSite.map((b) => bmwClockLevel(b.generatedAt, now));
  return {
    serverNow: now.toISOString(),
    onSite,
    counts: {
      onSite: onSite.length,
      warning: levels.filter((l) => l === "warning").length,
      alert: levels.filter((l) => l === "alert").length,
      stored: onSite.filter((b) => b.state === "stored").length,
      generatedToday: today.reduce((n, w) => n + w.bags, 0),
      gramsToday: today.reduce((n, w) => n + w.grams, 0),
    },
    today, disputes, nextPickupAt: nextPickupAt(now).toISOString(), lastManifest,
  };
}

/** Places a bag can be generated at: every live registry node but a bed (a bed's waste is its ward's). */
export async function bmwPlaces(db: Db): Promise<BmwPlace[]> {
  const rows = await db.select({ id: resources.id, kind: resources.kind, code: resources.code, name: resources.name }).from(resources)
    .where(and(ne(resources.kind, "bed"), ne(resources.status, "retired"))).orderBy(asc(resources.name)).limit(400);
  const places = await placesOf(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, floorName: places.get(r.id)?.floorName ?? null }));
}

export async function bmwHandlerView(db: Db, userId: string, now: Date = new Date()): Promise<BmwHandlerView> {
  const { start } = istDayWindow(now);
  const recentRows = await db.select().from(bmwBags)
    .where(and(gte(bmwBags.updatedAt, start), or(eq(bmwBags.generatedBy, userId), eq(bmwBags.collectedBy, userId), eq(bmwBags.storedBy, userId))))
    .orderBy(desc(bmwBags.updatedAt)).limit(8);
  return { serverNow: now.toISOString(), places: await bmwPlaces(db), recent: await bagCards(db, recentRows) };
}
