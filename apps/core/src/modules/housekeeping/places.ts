import { and, eq, inArray, sql } from "drizzle-orm";
import { hkAreas } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * HK-1 (#973) — where a place sits: its chain up the resource register (bed → ward → floor), its floor, and the nearest
 * housekeeping area on that chain. A bed clean's area is the bed's ward or room when that is an area; a toilet round's
 * is the toilet itself.
 */
export type Exec = Db | Tx;
export type PlaceLink = { id: string; kind: string; name: string; code: string; parentId: string | null };
export type AreaRow = typeof hkAreas.$inferSelect;

/** The place and its ancestors, nearest first. */
export async function ancestry(exec: Exec, resourceId: string): Promise<PlaceLink[]> {
  const rows = await (exec as Db).execute<{ id: string; kind: string; name: string; code: string; parent_id: string | null; depth: number }>(sql`
    with recursive chain(id, kind, name, code, parent_id, depth) as (
      select id, kind, name, code, parent_id, 0 from resources where id = ${resourceId}
      union all
      select r.id, r.kind, r.name, r.code, r.parent_id, c.depth + 1 from resources r join chain c on r.id = c.parent_id where c.depth < 12
    )
    select id, kind, name, code, parent_id, depth from chain order by depth`);
  return rows.rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, code: r.code, parentId: r.parent_id }));
}

export const floorIn = (chain: readonly PlaceLink[]): string | null => chain.find((p) => p.kind === "floor")?.id ?? null;

/** The active areas on the chain, nearest first. */
export async function areasOn(exec: Exec, chain: readonly PlaceLink[]): Promise<AreaRow[]> {
  if (chain.length === 0) return [];
  const rows = await (exec as Db).select().from(hkAreas)
    .where(and(inArray(hkAreas.resourceId, chain.map((p) => p.id)), eq(hkAreas.active, true)));
  const depth = new Map(chain.map((p, i) => [p.id, i]));
  return rows.sort((a, b) => depth.get(a.resourceId)! - depth.get(b.resourceId)!);
}

/** The nearest active area holding this place, or null (the place is not looked after by area: legacy tap). */
export async function areaOfPlace(exec: Exec, resourceId: string | null): Promise<{ area: AreaRow; chain: PlaceLink[] } | null> {
  if (resourceId === null) return null;
  const chain = await ancestry(exec, resourceId);
  const area = (await areasOn(exec, chain))[0];
  return area === undefined ? null : { area, chain };
}
