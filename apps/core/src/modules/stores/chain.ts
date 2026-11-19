import { asc, inArray } from "drizzle-orm";
import { storesCustodyHandoffs, storesDeliveryLines, storesTransitResolutions } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S2b (#1112, decision 7) — READING THE CUSTODY CHAIN, the receiver's answer and what became of what was
 * left in transit. Rows only; nothing here writes. `tickets.ts` builds the ticket's view from it and `custody.ts`
 * checks every act against it, so both read the one rule for "whose hands is it in".
 */
export type HandoffRow = typeof storesCustodyHandoffs.$inferSelect;
export type DeliveryRow = typeof storesDeliveryLines.$inferSelect;
export type ResolutionRow = typeof storesTransitResolutions.$inferSelect;

/** The carrier legs: a porter's take, a hand-off, a take-over. A return to the keeper closes the chain at the source. */
export const CARRIER_KINDS: readonly string[] = ["take", "hand_over", "take_over"];

export type Chain = { handoffs: HandoffRow[]; delivery: DeliveryRow[]; resolutions: ResolutionRow[] };

/** Every ticket's chain, its delivery rows and its resolutions, in the order they were recorded. */
export async function chainsOf(db: Db | Tx, indentIds: readonly string[]): Promise<Map<string, Chain>> {
  const out = new Map<string, Chain>();
  for (const id of indentIds) out.set(id, { handoffs: [], delivery: [], resolutions: [] });
  if (indentIds.length === 0) return out;
  const ids = [...indentIds];
  for (const h of await db.select().from(storesCustodyHandoffs).where(inArray(storesCustodyHandoffs.indentId, ids))
    .orderBy(asc(storesCustodyHandoffs.recordedAt), asc(storesCustodyHandoffs.id))) out.get(h.indentId)?.handoffs.push(h);
  for (const d of await db.select().from(storesDeliveryLines).where(inArray(storesDeliveryLines.indentId, ids))
    .orderBy(asc(storesDeliveryLines.lineIdx), asc(storesDeliveryLines.transferLineId))) out.get(d.indentId)?.delivery.push(d);
  for (const r of await db.select().from(storesTransitResolutions).where(inArray(storesTransitResolutions.indentId, ids))
    .orderBy(asc(storesTransitResolutions.requestedAt), asc(storesTransitResolutions.id))) out.get(r.indentId)?.resolutions.push(r);
  return out;
}

export async function chainOf(db: Db | Tx, indentId: string): Promise<Chain> {
  return (await chainsOf(db, [indentId])).get(indentId)!;
}

/** Whose hands: the newest hand-off's receiver, or the issuer when nobody has taken it. */
export function holderOf(issuedBy: string, chain: Chain): string {
  return chain.handoffs.at(-1)?.toUserId ?? issuedBy;
}

/** The last person on the chain before the receiver: the newest carrier leg's receiver, or the issuer. */
export function lastCustodianOf(issuedBy: string, chain: Chain): string {
  const carried = chain.handoffs.filter((h) => CARRIER_KINDS.includes(h.kind));
  return carried.at(-1)?.toUserId ?? issuedBy;
}

/** Everyone who carried it (the porters and whoever took it over): never its receiver. */
export function carriersOf(chain: Chain): Set<string> {
  return new Set(chain.handoffs.filter((h) => CARRIER_KINDS.includes(h.kind)).map((h) => h.toUserId));
}

export const legsOf = (chain: Chain): number => chain.handoffs.filter((h) => CARRIER_KINDS.includes(h.kind)).length;

/** A porter's "Returned undelivered" waiting for the source keeper. */
export const returningUndelivered = (chain: Chain): boolean => chain.resolutions.some((r) => r.kind === "undelivered" && r.status === "pending");
