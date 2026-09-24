import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyShortBook, users } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { findStoreByCode, itemsByIds } from "../materials";
import { OPD_PHARMACY_STORE_CODE } from "./config";
import { PharmacyError } from "./errors";
import { shortBookNoted, shortBookResolved } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P1 — THE SHORT BOOK ═══
 *
 * The approved parity plan (`docs/superpowers/plans/2026-09-24-pharmacy-healthray-parity.md`, P1):
 * "out of X" said at the counter is kept, with who and when, until somebody orders it, receives it
 * or dismisses it. Three doors write here and all three are a PERSON's act:
 *   - the desk's `N` key (a one-field sheet, prefilled with the focused line's drug);
 *   - a declined line's sheet, when the reason is that the drug is not stocked or short;
 *   - the counter agent's `draft_short_book_entry` DRAFT, once the pharmacist taps confirm. The
 *     agent's tool never calls this; it only drafts (the plan's rule: `draft_*`, never `post_*`).
 *
 * One open row per drug per store, held by two partial unique indexes (by item, or by the
 * lower-cased name when there is no item). A second note of the same shortage is answered with the
 * row already open — `created: false` — so two pharmacists meeting the same empty shelf do not
 * double the reorder list. The insert is `on conflict do nothing` and the read follows it, so the
 * race between them is settled by the index and not by a read-then-write.
 */
export type ShortBookSource = "desk" | "agent" | "reorder";
export type ShortBookResolution = "ordered" | "received" | "dismissed";
export type ShortBookEntry = typeof pharmacyShortBook.$inferSelect;
export type ShortBookView = ShortBookEntry & { notedByName: string | null };

export type AddShortBookInput = {
  itemId?: string | null;
  drugName: string;
  qtyWanted?: number | null;
  source: ShortBookSource;
  dispenseId?: string | null;
  /** The counter's store; the OPD counter's when absent. */
  storeCode?: string;
};

async function storeIdOf(db: Db | Tx, code: string | undefined): Promise<string> {
  const store = await findStoreByCode(db, code ?? OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new PharmacyError("store_missing", `no store ${code ?? OPD_PHARMACY_STORE_CODE}`);
  return store.id;
}

export async function addShortBookEntry(
  db: Db, actor: Actor, input: AddShortBookInput, now: Date,
): Promise<{ entry: ShortBookEntry; created: boolean }> {
  const itemId = input.itemId ?? null;
  let drugName = input.drugName.trim().replace(/\s+/g, " ");
  if (itemId !== null) {
    const item = (await itemsByIds(db, [itemId])).get(itemId);
    if (item === undefined) throw new PharmacyError("unknown_item", `no item ${itemId}`);
    /* The item's own name, not what the screen said: the reorder list must read the same row the store does. */
    drugName = item.name;
  }
  if (drugName.length < 2 || drugName.length > 120) {
    throw new PharmacyError("invalid_short_book_entry", "name the drug that is short — two to 120 characters");
  }
  const qty = input.qtyWanted ?? null;
  if (qty !== null && (!Number.isSafeInteger(qty) || qty <= 0)) {
    throw new PharmacyError("invalid_short_book_entry", "a quantity wanted is a whole number above zero, or left blank");
  }
  const storeResourceId = await storeIdOf(db, input.storeCode);
  return withTx(db, async (tx) => {
    const id = newId();
    const inserted = await tx.insert(pharmacyShortBook).values({
      id, storeResourceId, itemId, drugName, qtyWanted: qty, source: input.source,
      dispenseId: input.dispenseId ?? null, notedBy: actor.id, notedAt: now,
    }).onConflictDoNothing().returning();
    const row = inserted[0];
    if (row === undefined) {
      const open = await tx.select().from(pharmacyShortBook).where(and(
        eq(pharmacyShortBook.storeResourceId, storeResourceId), isNull(pharmacyShortBook.resolvedAt),
        itemId !== null ? eq(pharmacyShortBook.itemId, itemId)
          : and(isNull(pharmacyShortBook.itemId), sql`lower(${pharmacyShortBook.drugName}) = lower(${drugName})`),
      ));
      const existing = open[0];
      if (existing === undefined) throw new Error("short book: the insert conflicted and no open row was found");
      return { entry: existing, created: false };
    }
    await appendEvent(tx, shortBookNoted.make({
      occurredAt: now, actor, correlationId: row.id,
      payload: { entryId: row.id, storeResourceId, itemId, drugName, qtyWanted: qty, source: input.source, dispenseId: row.dispenseId },
    }));
    return { entry: row, created: true };
  });
}

/** The open rows of a counter's store, oldest first — the order they were met in. */
export async function listOpenShortBook(db: Db | Tx, storeCode?: string): Promise<ShortBookView[]> {
  const storeResourceId = await storeIdOf(db, storeCode);
  const rows = await db.select().from(pharmacyShortBook)
    .where(and(eq(pharmacyShortBook.storeResourceId, storeResourceId), isNull(pharmacyShortBook.resolvedAt)))
    .orderBy(asc(pharmacyShortBook.notedAt), asc(pharmacyShortBook.id));
  const ids = [...new Set(rows.map((r) => r.notedBy))];
  const names = ids.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.fullName]));
  return rows.map((r) => ({ ...r, notedByName: names.get(r.notedBy) ?? null }));
}

export async function resolveShortBookEntry(
  db: Db, actor: Actor, entryId: string, resolution: ShortBookResolution, now: Date,
): Promise<ShortBookEntry> {
  return withTx(db, async (tx) => {
    const updated = await tx.update(pharmacyShortBook)
      .set({ resolvedAt: now, resolvedBy: actor.id, resolution })
      .where(and(eq(pharmacyShortBook.id, entryId), isNull(pharmacyShortBook.resolvedAt)))
      .returning();
    const row = updated[0];
    if (row === undefined) {
      const found = await tx.select({ id: pharmacyShortBook.id }).from(pharmacyShortBook).where(eq(pharmacyShortBook.id, entryId));
      if (found.length === 0) throw new PharmacyError("unknown_short_book_entry", `no short-book entry ${entryId}`);
      throw new PharmacyError("short_book_resolved", "this shortage was already closed");
    }
    await appendEvent(tx, shortBookResolved.make({
      occurredAt: now, actor, correlationId: row.id,
      payload: { entryId: row.id, storeResourceId: row.storeResourceId, resolution },
    }));
    return row;
  });
}
