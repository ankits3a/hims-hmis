import { asc, eq } from "drizzle-orm";
import { pharmacyAuthorisations } from "../../kernel/db/schema";
import { authorisationKey } from "./refusals";
import type { RefusalBook } from "./refusals";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PD-9 — the reads `verify`, the pre-check and the ticket view share, kept apart from the writes in
 * `authorisations.ts` so the check can import them without importing the request path that itself
 * runs the check.
 */
export type AuthorisationRow = typeof pharmacyAuthorisations.$inferSelect;

/** Every AUTHORISED hit on this dispense, as `refusalsOf` reads them. */
export async function authorisedKeysFor(db: Db | Tx, dispenseId: string): Promise<Set<string>> {
  const rows = await db.select({ lineIdx: pharmacyAuthorisations.lineIdx, book: pharmacyAuthorisations.book, about: pharmacyAuthorisations.about, status: pharmacyAuthorisations.status })
    .from(pharmacyAuthorisations).where(eq(pharmacyAuthorisations.dispenseId, dispenseId));
  return new Set(rows.filter((r) => r.status === "authorised").map((r) => authorisationKey(r.lineIdx, r.book as RefusalBook, r.about)));
}

/** Every request on this dispense, oldest first — the ticket draws them on their lines. */
export async function authorisationsOf(db: Db | Tx, dispenseId: string): Promise<AuthorisationRow[]> {
  return db.select().from(pharmacyAuthorisations).where(eq(pharmacyAuthorisations.dispenseId, dispenseId)).orderBy(asc(pharmacyAuthorisations.requestedAt));
}
