import { and, eq, inArray, sql } from "drizzle-orm";
import { resources, stockReservations } from "../../kernel/db/schema";
import { createStore, findStoreByCode, uomsByItems } from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE LOOSE TRAY AND THE DAMAGE TRAY (owner ruling 2026-10-03) ═══
 *
 * Loose tablets that come back on a return are not thrown away by default. Each counter store has two
 * child stores, made the first time a loose return needs one:
 *
 *   - `loose`  — "can be given": every tablet still sealed in its blister pocket, a batch at least
 *     `RETURN_MIN_SHELF_DAYS` from expiry and not recalled (the return's own checks). When a new
 *     prescription needs loose tablets, the pick takes them from here FIRST (`pick.ts`) instead of
 *     cutting a fresh strip.
 *   - `damage` — "not to be given": a torn pocket, or our own mistake that the pharmacist judged unfit.
 *     Nothing is ever picked from it. It leaves through the destruction write-off (medical
 *     superintendent's approval, BMW manifest — `materials/write-offs.ts`).
 *
 * They are ordinary materials stores (`attributes.looseTray`), so the batch, expiry, recall freeze,
 * FEFO and the ledger hold for every loose tablet exactly as for a strip. They are NOT crash-cart trays
 * (`attributes.tray`, `trays.ts`).
 */
export type LooseTrayKind = "loose" | "damage";
export const LOOSE_TRAY_KINDS: readonly LooseTrayKind[] = ["loose", "damage"];

const TRAY_SUFFIX: Record<LooseTrayKind, string> = { loose: "LOOSE", damage: "DAMAGE" };
const TRAY_NAME: Record<LooseTrayKind, string> = { loose: "Loose tray (can be given)", damage: "Damage tray (not to be given)" };

/** The store's loose-tray children that exist, by kind. */
export async function looseTraysOf(db: Db | Tx, storeId: string): Promise<Partial<Record<LooseTrayKind, string>>> {
  const rows = await db.select({ id: resources.id, kind: sql<string>`${resources.attributes}->>'looseTray'` }).from(resources)
    .where(and(eq(resources.parentId, storeId), eq(resources.kind, "store"), sql`${resources.attributes}->>'looseTray' is not null`));
  const out: Partial<Record<LooseTrayKind, string>> = {};
  for (const r of rows) if (r.kind === "loose" || r.kind === "damage") out[r.kind] = r.id;
  return out;
}

/** The store's tray of `kind`, made on first use (code `<STORE>-LOOSE` / `<STORE>-DAMAGE`). */
export async function ensureLooseTray(tx: Tx, actor: Actor, storeId: string, kind: LooseTrayKind): Promise<string> {
  const have = (await looseTraysOf(tx, storeId))[kind];
  if (have !== undefined) return have;
  const [parent] = await tx.select({ code: resources.code }).from(resources).where(eq(resources.id, storeId));
  const code = `${parent?.code ?? "STORE"}-${TRAY_SUFFIX[kind]}`;
  const clash = await findStoreByCode(tx, code);
  if (clash !== undefined) return clash.id;
  const { resourceId } = await createStore(tx, actor, { code, name: TRAY_NAME[kind], parentId: storeId, attributes: { looseTray: kind } });
  return resourceId;
}

/** The smallest issue pack above one base unit (a strip of 10), or undefined when the item has none. */
export async function stripSizeOf(db: Db | Tx, itemId: string): Promise<number | undefined> {
  const packs = ((await uomsByItems(db, [itemId])).get(itemId) ?? []).filter((u) => u.isIssueUom && u.toBaseMultiplier > 1).map((u) => u.toBaseMultiplier);
  return packs.length === 0 ? undefined : Math.min(...packs);
}

/** Which of these reservations were taken at a loose tray: the desk says "from the loose tray" for them. */
export async function reservationsAtLooseTray(db: Db, storeId: string, reservationIds: readonly string[]): Promise<Set<string>> {
  const trays = await looseTraysOf(db, storeId);
  const ids = reservationIds.filter((id) => id !== "");
  if (trays.loose === undefined || ids.length === 0) return new Set();
  const rows = await db.select({ id: stockReservations.id }).from(stockReservations)
    .where(and(inArray(stockReservations.id, ids), eq(stockReservations.resourceId, trays.loose)));
  return new Set(rows.map((r) => r.id));
}
