import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  formularyMedicines, itemBarcodes, itemPriceRegulations, itemUoms, items,
} from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { itemRegistered, itemUpdated } from "./events";
import type { UomRow } from "./uom";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type ItemRow = typeof items.$inferSelect;
export type ItemUomRow = typeof itemUoms.$inferSelect;
export type ItemBarcodeRow = typeof itemBarcodes.$inferSelect;
export type PriceRegulationRow = typeof itemPriceRegulations.$inferSelect;

/** An item as the admin surfaces read it: the row plus what it is measured and scanned in. */
export type ItemWithUoms = ItemRow & { uoms: ItemUomRow[]; barcodes: ItemBarcodeRow[] };

/** The `billing/sessions.ts` helper, same shape: a raw 23505 under a race becomes a typed refusal. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

/**
 * PLAN 14 T3 — the item master.
 *
 * Every writer takes `(tx, actor, …)` and appends its event inside the SAME transaction as the row
 * it describes (the `formulary/masters.ts` and `opd/masters.ts` shape). The reads at the bottom
 * take a `Db` and are what the controller (T8) and the GRN gate (T6) build on.
 *
 * ═══ DD3 IS VALIDATED IN CODE **AND** BY A CHECK, AND BOTH ARE NEEDED (A1) ═══
 *
 * `items_class_formulary_ck` makes `(class = 'drug') = (formulary_medicine_id IS NOT NULL)` a
 * database fact, defending every write path including raw SQL in a future migration. What it cannot
 * do is tell a SCREEN what went wrong: a constraint violation surfaces as
 * `items_class_formulary_ck` and a 500, which is a string no storekeeper can act on. So the rule is
 * ALSO checked here, first, and refused with `drug_needs_medicine` / `non_drug_has_medicine` —
 * codes the controller maps to a 409 and the screen renders as a sentence.
 *
 * **A1's mutant is a validator that checks only one direction**, and the direction it would drop is
 * the non-obvious one: a `consumable` pointing at a medicine. That reads harmless — the row has
 * MORE information, not less — and it is the one that would put a glove in the drug interaction
 * checker's blast radius the day something joins on that column. Its discriminating input is
 * therefore a non-drug item WITH a medicine, not a drug without one: both implementations refuse
 * the latter and only the error text differs.
 *
 * ═══ ONE UOM PER ITEM HAS MULTIPLIER 1, AND IT IS `base_uom` (A3) ═══
 *
 * This invariant cannot be a foreign key in either direction (see `schema/materials.ts`'s header on
 * `items.base_uom`), so it lives here: `registerItem` creates the base row itself, and `addItemUom`
 * refuses any second row with multiplier 1. A3's mutant accepts any positive multiplier, which
 * gives an item two bases — and then `toBase` has two answers depending on which row it finds
 * first, silently, for ever.
 */

/** The item, or `unknown_item`. Used by every writer below and by T6's gate. */
async function requireItem(tx: Tx, itemId: string): Promise<ItemRow> {
  const rows = await tx.select().from(items).where(eq(items.id, itemId));
  const row = rows[0];
  if (row === undefined) throw new MaterialsError("unknown_item", `item ${itemId} not found`);
  return row;
}

/**
 * DD3, BOTH DIRECTIONS, in one place so no caller can implement half of it (A1).
 *
 * Written as a comparison of two booleans rather than as two `if`s for the same reason the CHECK is:
 * that shape cannot be half-implemented. The two branches differ only in which error they name, and
 * naming them differently is the whole point — "this drug has no medicine" and "this glove has one"
 * are different mistakes with different fixes.
 */
async function assertDrugMedicinePairing(
  tx: Tx,
  itemClass: string,
  formularyMedicineId: string | null,
): Promise<void> {
  const isDrug = itemClass === "drug";
  const hasMedicine = formularyMedicineId !== null;
  if (isDrug && !hasMedicine) {
    throw new MaterialsError(
      "drug_needs_medicine",
      "a drug-class item must name the formulary medicine it stocks — composition, salts and the " +
        "schedule flag live there and are never copied onto the item (DD3)",
    );
  }
  if (!isDrug && hasMedicine) {
    throw new MaterialsError(
      "non_drug_has_medicine",
      `an item of class "${itemClass}" must NOT name a formulary medicine — only drug-class items ` +
        "stock one (DD3)",
      { itemClass },
    );
  }
  // Only now is the id worth resolving: a drug that named a medicine which does not exist would
  // otherwise fail on the FOREIGN KEY with a constraint name rather than a code.
  if (hasMedicine) {
    const found = await tx.select({ id: formularyMedicines.id }).from(formularyMedicines)
      .where(eq(formularyMedicines.id, formularyMedicineId));
    if (found[0] === undefined) {
      throw new MaterialsError(
        "unknown_item",
        `formulary medicine ${formularyMedicineId} not found — register the medicine in the ` +
          "formulary before stocking it as an item (16a)",
        { formularyMedicineId },
      );
    }
  }
}

export type RegisterItemInput = {
  code: string;
  name: string;
  class: string;
  baseUom: string;
  batchTracked: boolean;
  formularyMedicineId?: string | null;
  hsnCode?: string | null;
  gstRateBps?: number | null;
  serialTracked?: boolean;
  storageClass?: string;
  shelfLifeDays?: number | null;
  abcClass?: string | null;
  vedClass?: string | null;
  /** Additional units BEYOND the base. The base row is created by this function, never passed in. */
  uoms?: { uom: string; toBaseMultiplier: number; isPurchaseUom?: boolean; isIssueUom?: boolean }[];
  barcodes?: { code: string; packUom: string; vendorId?: string | null }[];
};

/**
 * Creates the item, its BASE UoM row (multiplier 1, named `baseUom`), any additional units and any
 * barcodes — one transaction, one `item.registered`.
 *
 * The base row is created HERE rather than accepted from the caller, and that is A3's structural
 * half: a caller who could pass the base row could pass one whose multiplier is not 1, or name it
 * something other than `base_uom`, and the invariant would depend on every caller remembering.
 */
export async function registerItem(
  tx: Tx,
  actor: Actor,
  input: RegisterItemInput,
): Promise<{ itemId: string }> {
  const medicineId = input.formularyMedicineId ?? null;
  await assertDrugMedicinePairing(tx, input.class, medicineId);

  const itemId = newId();
  const baseUom = input.baseUom.trim();
  if (baseUom === "") {
    throw new MaterialsError("base_uom_required", "an item must name the unit its ledger counts in (DD7)");
  }

  try {
    await tx.insert(items).values({
      id: itemId, code: input.code, name: input.name, class: input.class,
      formularyMedicineId: medicineId,
      hsnCode: input.hsnCode ?? null, gstRateBps: input.gstRateBps ?? null,
      baseUom, batchTracked: input.batchTracked,
      serialTracked: input.serialTracked ?? false,
      storageClass: input.storageClass ?? "ambient",
      shelfLifeDays: input.shelfLifeDays ?? null,
      abcClass: input.abcClass ?? null, vedClass: input.vedClass ?? null,
      createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    // `items_code_lower_ux` is an EXPRESSION index, so there is no `onConflictDoNothing` target to
    // name — the refusal is read off the violation (the `formulary/masters.ts` precedent).
    if (isUniqueViolation(e)) {
      throw new MaterialsError("duplicate_code", `an item with code "${input.code}" already exists`);
    }
    throw e;
  }

  // THE BASE ROW, ALWAYS, AND FIRST. Multiplier 1 by construction.
  await tx.insert(itemUoms).values({
    id: newId(), itemId, uom: baseUom, toBaseMultiplier: 1,
    isPurchaseUom: false, isIssueUom: true,
  });

  for (const u of input.uoms ?? []) {
    await addItemUom(tx, actor, itemId, u, { skipEvent: true });
  }
  for (const b of input.barcodes ?? []) {
    await addBarcode(tx, actor, itemId, b, { skipEvent: true });
  }

  await appendEvent(tx, itemRegistered.make({
    payload: {
      itemId, code: input.code, name: input.name, itemClass: input.class,
      baseUom, formularyMedicineId: medicineId,
    },
    actor, correlationId: itemId,
  }));
  return { itemId };
}

/**
 * Patches the item. **`class` and `formularyMedicineId` may move together and are re-validated as a
 * PAIR** — changing one without the other is exactly the state DD3 forbids, and a patch that
 * validated only the supplied field would let it through.
 *
 * `base_uom` is deliberately NOT patchable. Changing it would silently reinterpret every
 * `qty_base` already in the ledger — a strip becoming a tablet turns 100 into 100 of a different
 * thing — and there is no honest in-place fix. A new base unit is a new item.
 */
export async function updateItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  patch: {
    name?: string; class?: string; formularyMedicineId?: string | null;
    hsnCode?: string | null; gstRateBps?: number | null; serialTracked?: boolean;
    storageClass?: string; shelfLifeDays?: number | null;
    abcClass?: string | null; vedClass?: string | null; active?: boolean;
  },
): Promise<void> {
  const existing = await requireItem(tx, itemId);
  const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
  if (changed.length === 0) return;

  // The pair, re-validated against the RESULT rather than against the patch.
  const nextClass = patch.class ?? existing.class;
  const nextMedicine = patch.formularyMedicineId === undefined
    ? existing.formularyMedicineId
    : patch.formularyMedicineId;
  await assertDrugMedicinePairing(tx, nextClass, nextMedicine);

  await tx.update(items)
    .set({ ...patch, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(items.id, itemId));
  await appendEvent(tx, itemUpdated.make({ payload: { itemId, changed }, actor, correlationId: itemId }));
}

/**
 * Adds a unit of measure to an item. **Refuses a SECOND row with multiplier 1** (A3) and refuses a
 * multiplier 1 whose name is not the item's `base_uom` — the two halves of one invariant.
 *
 * `skipEvent` exists only for `registerItem`, which emits ONE `item.registered` covering everything
 * it created; without it a five-unit item would append six events describing one act.
 */
export async function addItemUom(
  tx: Tx,
  actor: Actor,
  itemId: string,
  input: { uom: string; toBaseMultiplier: number; isPurchaseUom?: boolean; isIssueUom?: boolean },
  opts: { skipEvent?: boolean } = {},
): Promise<{ itemUomId: string }> {
  const item = await requireItem(tx, itemId);
  const uom = input.uom.trim();

  if (!Number.isSafeInteger(input.toBaseMultiplier) || input.toBaseMultiplier <= 0) {
    throw new MaterialsError(
      "unknown_uom",
      `a unit's multiplier must be a positive integer, got ${String(input.toBaseMultiplier)}`,
      { uom, multiplier: input.toBaseMultiplier },
    );
  }

  // A3, and it is stated as one rule with two failing shapes rather than two rules, because the
  // mutant this kills is a validator that implements the easy half. The BASE unit is defined by
  // `items.base_uom`; a multiplier of 1 is what "base" MEANS; so the two must agree in both
  // directions or the item has two bases (or a base that converts to something else).
  const isBaseName = uom.toLowerCase() === item.baseUom.trim().toLowerCase();
  if (input.toBaseMultiplier === 1 && !isBaseName) {
    throw new MaterialsError(
      "base_uom_required",
      `"${uom}" cannot have a multiplier of 1: this item's base unit is "${item.baseUom}", and a ` +
        "second unit equal to the base gives every conversion two answers (DD7, A3)",
      { uom, baseUom: item.baseUom },
    );
  }
  if (isBaseName && input.toBaseMultiplier !== 1) {
    throw new MaterialsError(
      "base_uom_required",
      `"${uom}" IS this item's base unit, so its multiplier must be 1, not ${String(input.toBaseMultiplier)}`,
      { uom, multiplier: input.toBaseMultiplier },
    );
  }

  const itemUomId = newId();
  try {
    await tx.insert(itemUoms).values({
      id: itemUomId, itemId, uom,
      toBaseMultiplier: input.toBaseMultiplier,
      isPurchaseUom: input.isPurchaseUom ?? false,
      isIssueUom: input.isIssueUom ?? false,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new MaterialsError("duplicate_code", `item ${itemId} already has a unit named "${uom}"`);
    }
    throw e;
  }
  if (opts.skipEvent !== true) {
    await appendEvent(tx, itemUpdated.make({
      payload: { itemId, changed: ["uoms"] }, actor, correlationId: itemId,
    }));
  }
  return { itemUomId };
}

/**
 * Adds a barcode. `packUom` must be one of the item's units — a barcode naming a pack the item does
 * not have is a scan that resolves to a quantity nobody can compute.
 */
export async function addBarcode(
  tx: Tx,
  actor: Actor,
  itemId: string,
  input: { code: string; packUom: string; vendorId?: string | null },
  opts: { skipEvent?: boolean } = {},
): Promise<{ barcodeId: string }> {
  await requireItem(tx, itemId);
  const known = await tx.select({ uom: itemUoms.uom, toBaseMultiplier: itemUoms.toBaseMultiplier })
    .from(itemUoms).where(eq(itemUoms.itemId, itemId));
  const wanted = input.packUom.trim().toLowerCase();
  if (!known.some((u) => u.uom.trim().toLowerCase() === wanted)) {
    throw new MaterialsError(
      "unknown_uom",
      `barcode pack unit "${input.packUom}" is not one of this item's units`,
      { packUom: input.packUom, known: known.map((u) => u.uom) },
    );
  }

  const barcodeId = newId();
  try {
    await tx.insert(itemBarcodes).values({
      id: barcodeId, itemId, code: input.code.trim(), packUom: input.packUom.trim(),
      vendorId: input.vendorId ?? null,
    });
  } catch (e) {
    // GLOBAL uniqueness on `lower(code)`: a scanner does not know which item it is about to read,
    // so a code resolving to two items resolves to neither.
    if (isUniqueViolation(e)) {
      throw new MaterialsError("duplicate_code", `barcode "${input.code}" already belongs to an item`);
    }
    throw e;
  }
  if (opts.skipEvent !== true) {
    await appendEvent(tx, itemUpdated.make({
      payload: { itemId, changed: ["barcodes"] }, actor, correlationId: itemId,
    }));
  }
  return { barcodeId };
}

/**
 * Records an effective-dated price regulation for an item — APPEND-ONLY, exactly as
 * `regulated_prices` is (schema/materials.ts's header). A gazette revision is a NEW row; the row
 * history IS the change-control trail.
 */
export async function setPriceRegulation(
  tx: Tx,
  actor: Actor,
  itemId: string,
  input: {
    mrpDefaultPaise?: number | null; mrpUom?: string | null; ceilingPaise?: number | null;
    effectiveFrom: Date; gazetteRef?: string | null;
  },
): Promise<{ regulationId: string }> {
  await requireItem(tx, itemId);
  /**
   * The pair rule again (schema header): paise never travels without its unit.
   *
   * ═══ CLOSE REVIEW M4 — IT APPLIES TO THE CEILING TOO, AND DID NOT ═══
   *
   * Only `mrpDefaultPaise` was checked. A DPCO ceiling entered as `{ ceilingPaise: 800 }` with no
   * `mrpUom` was accepted, and `grn.ts` then FELL BACK TO THE BASE UNIT and read ₹8.00-per-strip
   * as 800 paise per TABLET. **DD8 rule 7 — which DD8 itself calls "the cheapest place to stop"
   * selling above a notified ceiling — failed OPEN by the pack multiplier**, silently, tenfold on
   * a strip of ten. A gate that fails open is worse than no gate, because it is believed.
   */
  if ((input.mrpDefaultPaise ?? null) !== null && (input.mrpUom ?? null) === null) {
    throw new MaterialsError(
      "unknown_uom",
      "an MRP was given with no unit — an MRP is printed on a pack (DD7)",
    );
  }
  if ((input.ceilingPaise ?? null) !== null && (input.mrpUom ?? null) === null) {
    throw new MaterialsError(
      "unknown_uom",
      "a ceiling was given with no unit — a notified ceiling is per pack, and without its unit the "
        + "GRN gate would read it as a per-base-unit figure and fail OPEN (DD8 rule 7)",
    );
  }
  if ((input.mrpUom ?? null) !== null) {
    const known = await tx.select({ uom: itemUoms.uom, toBaseMultiplier: itemUoms.toBaseMultiplier })
      .from(itemUoms).where(eq(itemUoms.itemId, itemId));
    const wanted = (input.mrpUom ?? "").trim().toLowerCase();
    if (!known.some((u) => u.uom.trim().toLowerCase() === wanted)) {
      throw new MaterialsError(
        "unknown_uom", `MRP unit "${input.mrpUom ?? ""}" is not one of this item's units`,
        { mrpUom: input.mrpUom, known: known.map((u) => u.uom) },
      );
    }
  }

  const regulationId = newId();
  await tx.insert(itemPriceRegulations).values({
    id: regulationId, itemId,
    mrpDefaultPaise: input.mrpDefaultPaise ?? null,
    mrpUom: input.mrpUom ?? null,
    ceilingPaise: input.ceilingPaise ?? null,
    effectiveFrom: input.effectiveFrom,
    gazetteRef: input.gazetteRef ?? null,
    createdBy: actor.id,
  });
  await appendEvent(tx, itemUpdated.make({
    payload: { itemId, changed: ["priceRegulation"] }, actor, correlationId: itemId,
  }));
  return { regulationId };
}

// ═══════════════════════════════════════ READS ═══════════════════════════════════════

/**
 * **THE REGULATION IN FORCE AT `at`, AND THE TIE-BREAK IS THE POINT (A4).**
 *
 * `order by effective_from desc, seq desc` — and the second key is not decoration. Two rows can
 * share an `effective_from`: a correction issued the same day as the thing it corrects, or two
 * gazette entries dated to the same midnight. With `effective_from` alone Postgres may return
 * EITHER, and which one it returns can change between plans, between versions, and between a table
 * that fits in memory and one that does not. `seq` is a bigserial, so "the one inserted later"
 * is a total order that exists no matter what.
 *
 * A4's mutant drops the `seq` key, and its discriminating input is two rows with the SAME
 * `effective_from` and different ceilings. **Two rows with different dates cannot discriminate** —
 * both implementations agree whenever the first key is decisive.
 *
 * `at` is the instant to ask ABOUT, never `now()`. T7's A21 turns on this: `material.consumed`
 * carries the ceiling effective at `occurredAt`, and a consumer that passed `now()` would price a
 * three-week-old implant at today's gazette.
 */
export async function effectiveRegulation(
  db: Db | Tx,
  itemId: string,
  at: Date,
): Promise<PriceRegulationRow | undefined> {
  const rows = await db.select().from(itemPriceRegulations)
    .where(and(eq(itemPriceRegulations.itemId, itemId), lte(itemPriceRegulations.effectiveFrom, at)))
    .orderBy(desc(itemPriceRegulations.effectiveFrom), desc(itemPriceRegulations.seq))
    .limit(1);
  return rows[0];
}

/** The item plus its units and barcodes, or `undefined`. */
export async function getItem(db: Db | Tx, itemId: string): Promise<ItemWithUoms | undefined> {
  const rows = await db.select().from(items).where(eq(items.id, itemId));
  const row = rows[0];
  if (row === undefined) return undefined;
  const [uoms, barcodes] = await Promise.all([
    db.select().from(itemUoms).where(eq(itemUoms.itemId, itemId)).orderBy(asc(itemUoms.toBaseMultiplier)),
    db.select().from(itemBarcodes).where(eq(itemBarcodes.itemId, itemId)).orderBy(asc(itemBarcodes.code)),
  ]);
  return { ...row, uoms, barcodes };
}

/** The item's units, in the shape `uom.ts` takes. The one read T6's gate needs per line. */
export async function itemUomRows(db: Db | Tx, itemId: string): Promise<UomRow[]> {
  return db.select({ uom: itemUoms.uom, toBaseMultiplier: itemUoms.toBaseMultiplier })
    .from(itemUoms).where(eq(itemUoms.itemId, itemId));
}

export async function listItems(
  db: Db | Tx,
  filter: { class?: string; active?: boolean; search?: string } = {},
): Promise<ItemRow[]> {
  const clauses = [];
  if (filter.class !== undefined) clauses.push(eq(items.class, filter.class));
  if (filter.active !== undefined) clauses.push(eq(items.active, filter.active));
  if (filter.search !== undefined && filter.search.trim() !== "") {
    const needle = `%${filter.search.trim().toLowerCase()}%`;
    clauses.push(sql`(lower(${items.name}) like ${needle} or lower(${items.code}) like ${needle})`);
  }
  const q = db.select().from(items).orderBy(asc(items.code));
  return clauses.length === 0 ? q : q.where(and(...clauses));
}

/**
 * What a scanner read, resolved. Returns the item AND the pack the code is on, because those are
 * two different facts and the caller needs both: the barcode says WHICH item, `packUom` says how
 * many base units one scan is worth.
 */
export async function resolveBarcode(
  db: Db | Tx,
  code: string,
): Promise<{ itemId: string; packUom: string } | undefined> {
  const rows = await db.select({ itemId: itemBarcodes.itemId, packUom: itemBarcodes.packUom })
    .from(itemBarcodes)
    .where(sql`lower(${itemBarcodes.code}) = ${code.trim().toLowerCase()}`)
    .limit(1);
  return rows[0];
}

/** Several items at once — T6's gate resolves a whole GRN's lines in one round trip. */
export async function itemsByIds(db: Db | Tx, itemIds: string[]): Promise<Map<string, ItemRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.select().from(items).where(inArray(items.id, itemIds));
  return new Map(rows.map((r) => [r.id, r]));
}
