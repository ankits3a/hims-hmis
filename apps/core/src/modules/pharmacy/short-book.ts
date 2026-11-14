import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDemand, pharmacyShortBook, users } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { medicinesByIds, resolveDrugTexts } from "../formulary";
import { findStoreByCode, itemsByIds, listItems, survivorsOf } from "../materials";
import { OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE } from "./config";
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
 * A fourth door (spec #1064, below) is a patient's ask the counter could not meet: source `counter`, raised by
 * `recordDemand`, never by `addShortBookEntry`.
 *
 * One open row per drug per store, held by two partial unique indexes (by item, or by the
 * lower-cased name when there is no item). A second note of the same shortage is answered with the
 * row already open — `created: false` — so two pharmacists meeting the same empty shelf do not
 * double the reorder list. The insert is `on conflict do nothing` and the read follows it, so the
 * race between them is settled by the index and not by a read-then-write.
 */
export type ShortBookSource = "desk" | "agent" | "reorder" | "counter";
export type ShortBookResolution = "ordered" | "received" | "dismissed";
export type ShortBookEntry = typeof pharmacyShortBook.$inferSelect;
export type ShortBookView = ShortBookEntry & { notedByName: string | null };

export type AddShortBookInput = {
  itemId?: string | null;
  drugName: string;
  qtyWanted?: number | null;
  /** A person's note; `counter` rows come only from `recordDemand`. */
  source: Exclude<ShortBookSource, "counter">;
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
  // PHARMACY P6 — a shortage noted against an item merged into another is the survivor's shortage.
  const itemId = input.itemId == null ? null : ((await survivorsOf(db, [input.itemId])).get(input.itemId) ?? input.itemId);
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

// ═══════════════════════════════════ SPEC #1064 — LOST DEMAND ═══════════════════════════════════

/**
 * ═══ A MEDICINE ASKED FOR AND NOT SUPPLIED ═══
 *
 * Spec `docs/specs/1064-lost-demand.md` (owner approved 2026-11-14). Four doors write one `pharmacy_demand` row each:
 *   - `desk_decline` — an OPD desk line declined with the reason code `not_in_stock` (`verify.ts` `declineLine`);
 *   - `counter_search` — the walk-in counter's "Note as asked for" after a search that found no stock, or nothing;
 *   - `counter_short` — the same note after a cart line larger than the stock (`short_stock`);
 *   - `balance_owed` — a line picked short that leaves a balance (`pick.ts`), for the owed quantity.
 *
 * A demand for a CATALOGUE item (the hospital has an item for it) raises the short book at that store, source
 * `counter`: the open row's asked count and quantity rise, or a row is opened. One statement under the open-row index
 * (`pharmacy_short_book_open_item_ux`), so two counters meeting the same empty shelf at once cannot open two rows. A
 * name the catalogue does not carry is a demand only — the office's Missed sales report lists it apart, a new-item
 * request. No patient is written: the ticket may link it, nothing names the person.
 */
export type DemandSource = "desk_decline" | "counter_search" | "counter_short" | "balance_owed";
export type DemandRow = typeof pharmacyDemand.$inferSelect;
export type DemandInput = {
  source: DemandSource;
  storeResourceId: string;
  /** The hospital's item, when it has one; its formulary medicine comes with it. */
  itemId: string | null;
  medicineId?: string | null;
  /** The name as said or typed: required when there is no item, ignored when there is one. */
  typedName?: string | null;
  qtyBase: number;
  dispenseId?: string | null;
};
export type DemandResult = { demand: DemandRow; shortBook: { entry: ShortBookEntry; created: boolean } | null };

const cleanName = (text: string): string => text.trim().replace(/\s+/g, " ");

/** Inside the caller's transaction: the demand row, and for a catalogue item the short book's raise. */
export async function recordDemand(tx: Tx, actor: Actor, input: DemandInput, now: Date): Promise<DemandResult> {
  const qty = input.qtyBase;
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new PharmacyError("qty_required", "a quantity asked for is a whole number above zero");
  // PHARMACY P6 — an item merged into another is the survivor's demand.
  const itemId = input.itemId == null ? null : ((await survivorsOf(tx, [input.itemId])).get(input.itemId) ?? input.itemId);
  const item = itemId === null ? undefined : (await itemsByIds(tx, [itemId])).get(itemId);
  if (itemId !== null && item === undefined) throw new PharmacyError("unknown_item", `no item ${itemId}`);
  const typedName = item !== undefined ? null : cleanName(input.typedName ?? "");
  if (typedName !== null && (typedName.length < 2 || typedName.length > 120)) {
    throw new PharmacyError("invalid_short_book_entry", "name the medicine asked for — two to 120 characters");
  }
  const medicineId = item?.formularyMedicineId ?? input.medicineId ?? null;

  let shortBook: DemandResult["shortBook"] = null;
  if (item !== undefined) {
    const id = newId();
    const [row] = await tx.insert(pharmacyShortBook).values({
      id, storeResourceId: input.storeResourceId, itemId: item.id, drugName: item.name, qtyWanted: null, source: "counter",
      dispenseId: input.dispenseId ?? null, notedBy: actor.id, notedAt: now, askedCount: 1, askedQtyBase: qty,
    }).onConflictDoUpdate({
      target: [pharmacyShortBook.storeResourceId, pharmacyShortBook.itemId],
      targetWhere: sql`${pharmacyShortBook.resolvedAt} is null and ${pharmacyShortBook.itemId} is not null`,
      set: { askedCount: sql`${pharmacyShortBook.askedCount} + 1`, askedQtyBase: sql`${pharmacyShortBook.askedQtyBase} + ${qty}` },
    }).returning();
    if (row === undefined) throw new Error("short book: the raise returned no row");
    const created = row.id === id;
    if (created) {
      await appendEvent(tx, shortBookNoted.make({
        occurredAt: now, actor, correlationId: row.id,
        payload: { entryId: row.id, storeResourceId: row.storeResourceId, itemId: row.itemId, drugName: row.drugName, qtyWanted: null, source: "counter", dispenseId: row.dispenseId },
      }));
    }
    shortBook = { entry: row, created };
  }

  const [demand] = await tx.insert(pharmacyDemand).values({
    id: newId(), storeResourceId: input.storeResourceId, itemId: item?.id ?? null, medicineId, typedName, qtyAskedBase: qty,
    source: input.source, dispenseId: input.dispenseId ?? null, shortBookEntryId: shortBook?.entry.id ?? null, notedBy: actor.id, notedAt: now,
  }).returning();
  return { demand: demand!, shortBook };
}

export type AskedForInput = {
  source: "counter_search" | "counter_short";
  /** The shelf row's item, when the search found the medicine (with no stock, or not enough). */
  itemId?: string | null;
  medicineId?: string | null;
  /** What was typed, when the search found nothing. */
  typedName?: string | null;
  /** Base units; one when not said. */
  qtyBase?: number | null;
  /** The counter's store: the walk-in counter's when absent, else the OPD counter's. */
  storeCode?: string;
};

const SELL = "pharmacy.retail.sell";

/**
 * The walk-in counter's "Note as asked for": one tap from a search with no stock, from a search that found nothing,
 * or from a `short_stock` refusal. A typed name is looked up once more — an item called exactly that (by name or
 * code) is the catalogue's, so it raises the short book; anything else is a demand only, with the formulary's
 * medicine kept when the name names exactly one.
 */
export async function noteAskedFor(db: Db, actor: Actor, input: AskedForInput, now: Date): Promise<DemandResult> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, SELL, "hospital"))) {
    throw new PharmacyError("permission_denied", `noting a medicine asked for needs ${SELL}`, { permission: SELL });
  }
  const code = input.storeCode ?? RETAIL_PHARMACY_STORE_CODE;
  const store = await findStoreByCode(db, code);
  if (store === undefined || (store.code !== RETAIL_PHARMACY_STORE_CODE && store.code !== OPD_PHARMACY_STORE_CODE)) {
    throw new PharmacyError("store_missing", `${code} is not a pharmacy counter's store`);
  }
  let itemId = input.itemId ?? null;
  let medicineId = input.medicineId ?? null;
  const typed = cleanName(input.typedName ?? "");
  if (itemId === null) {
    if (typed === "") throw new PharmacyError("invalid_short_book_entry", "name the medicine asked for — two to 120 characters");
    const needle = typed.toLowerCase();
    const named = (await listItems(db, { class: "drug", active: true, search: typed }))
      .filter((i) => i.mergedIntoItemId === null && (i.name.toLowerCase() === needle || i.code.toLowerCase() === needle));
    if (named.length === 1) itemId = named[0]!.id;
    else if (medicineId === null) medicineId = (await resolveDrugTexts(db, [typed])).get(typed)?.medicineId ?? null;
  }
  if (itemId === null && medicineId !== null && !(await medicinesByIds(db, [medicineId])).has(medicineId)) {
    throw new PharmacyError("unresolved_medicine", `no medicine ${medicineId}`);
  }
  return withTx(db, (tx) => recordDemand(tx, actor, {
    source: input.source, storeResourceId: store.id, itemId, medicineId, typedName: typed === "" ? null : typed, qtyBase: input.qtyBase ?? 1,
  }, now));
}
