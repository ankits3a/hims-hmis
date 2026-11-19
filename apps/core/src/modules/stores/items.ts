import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { raiseNotice } from "../../kernel/alerts/notices";
import { itemCategories, itemUoms, items, storesItemRequests } from "../../kernel/db/schema";
import { BATCH_MANDATORY_CLASSES, MaterialsError, createStore, findStoreByCode, registerItem, similarNames } from "../materials";
import { recordAct, requireMasters, requireShelf, requireShelfAct } from "./access";
import { StoresError } from "./errors";
import { STORES_ITEM_CLASSES, TRACK_MODES } from "./types";
import type {
  CategoryRow, ImportRefusal, ImportResult, ItemRequestView, RegisterStoresItemInput, StoresImportRow, StoresItemView, TrackMode,
} from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S1 (#1111) — THE NON-DRUG ITEM MASTER, on the one `items` table (decisions 1–5).
 *
 * A Stores item is an `items` row registered through `materials.registerItem`, plus the four S1 columns:
 * a category, a tracking mode, its search aliases and `patient_billable = false`. "A Stores item" is
 * therefore exactly `track_mode IS NOT NULL and class <> 'drug'`: pharmacy items carry no track mode and
 * are never listed, searched or stocked here.
 */

const SYSTEM: Actor = { type: "system", id: "stores-seed" };

/** Decision 3: the twelve seeded top categories, English and Hindi. The materials head adds the sub-categories. */
export const STORES_TOP_CATEGORIES: readonly { code: string; name: string; nameHi: string }[] = [
  { code: "GEN", name: "General and sundries", nameHi: "सामान्य सामान" },
  { code: "HSK", name: "Housekeeping and sanitation", nameHi: "सफ़ाई और हाउसकीपिंग" },
  { code: "STN", name: "Stationery and printed forms", nameHi: "स्टेशनरी और छपे फ़ॉर्म" },
  { code: "ELE", name: "Electrical", nameHi: "बिजली का सामान" },
  { code: "PLM", name: "Plumbing and civil", nameHi: "प्लंबिंग और सिविल" },
  { code: "ITP", name: "IT and peripherals", nameHi: "आईटी और उपकरण" },
  { code: "FUR", name: "Furniture and fixtures", nameHi: "फ़र्नीचर और फ़िक्सचर" },
  { code: "BME", name: "Biomedical spares", nameHi: "बायोमेडिकल पुर्ज़े" },
  { code: "PCC", name: "Non-billable patient-care consumables", nameHi: "मरीज़ देखभाल का सामान (बिल से बाहर)" },
  { code: "LIN", name: "Linen and uniforms", nameHi: "लिनन और वर्दी" },
  { code: "KIT", name: "Kitchen provisions (dry stock)", nameHi: "रसोई का सूखा सामान" },
  { code: "GAS", name: "Medical gases and lab reagents (non-billable)", nameHi: "मेडिकल गैस और लैब रीएजेंट" },
];

/** Decision 6: the central non-drug store and the night store, seeded once per site. */
export const CENTRAL_STORE_CODE = "GEN-MAIN";
export const NIGHT_STORE_CODE = "GEN-NIGHT";

const storesItemWhere = and(isNotNull(items.trackMode), ne(items.class, "drug"), isNull(items.mergedIntoItemId));

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

function normalAliases(raw: readonly string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((a) => a.trim().replace(/\s+/g, " ")).filter((a) => a !== ""))];
}

// ═══════════════════════════════ categories ═══════════════════════════════

export async function listCategories(db: Db | Tx): Promise<CategoryRow[]> {
  return db.select({
    id: itemCategories.id, code: itemCategories.code, name: itemCategories.name, nameHi: itemCategories.nameHi,
    parentId: itemCategories.parentId, active: itemCategories.active,
  }).from(itemCategories).orderBy(asc(itemCategories.code));
}

export async function createCategory(
  db: Db, actor: Actor, input: { code: string; name: string; nameHi?: string | null; parentId?: string | null }, now: Date = new Date(),
): Promise<{ categoryId: string }> {
  await requireMasters(db, actor);
  const code = input.code.trim();
  const name = input.name.trim();
  if (code === "" || name === "") throw new StoresError("category_required", "a category needs a code and a name");
  return withTx(db, async (tx) => {
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const [parent] = await tx.select().from(itemCategories).where(eq(itemCategories.id, parentId));
      if (parent === undefined) throw new StoresError("unknown_category", `category ${parentId} not found`);
      // Decision 3: two levels. A sub-category never has children.
      if (parent.parentId !== null) throw new StoresError("category_too_deep", "a sub-category cannot have sub-categories (two levels)");
    }
    const categoryId = newId();
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(itemCategories).values({
          id: categoryId, code, name, nameHi: input.nameHi?.trim() || null, parentId, createdBy: actor.id, updatedBy: actor.id,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoresError("duplicate_code", `a category with code "${code}" already exists`);
      throw e;
    }
    await recordAct(tx, actor, now, { act: "create_category", after: { categoryId, code, name, parentId } });
    return { categoryId };
  });
}

/**
 * The twelve top categories, the central store `GEN-MAIN` (kept by `storekeeper`, the keeper list that keeps
 * pharmacists out: they hold `materials.stock.receive`) and the night store. Idempotent: run by
 * `seed:materials` on every deploy, and nothing that already exists is touched.
 */
export async function seedStoresMasters(
  db: Db, actor: Actor = SYSTEM, siteId = "main",
): Promise<{ categories: number; centralStoreId: string; nightStoreId: string }> {
  const now = new Date();
  return withTx(db, async (tx) => {
    let categories = 0;
    for (const c of STORES_TOP_CATEGORIES) {
      const inserted = await tx.insert(itemCategories).values({
        id: newId(), code: c.code, name: c.name, nameHi: c.nameHi, parentId: null, createdBy: actor.id, updatedBy: actor.id,
      }).onConflictDoNothing().returning({ id: itemCategories.id });
      categories += inserted.length;
    }
    const ensure = async (code: string, name: string, attributes: Record<string, unknown>): Promise<string> => {
      const found = await findStoreByCode(tx, code, siteId);
      if (found !== undefined) return found.id;
      const { resourceId } = await createStore(tx, actor, { code, name, siteId, attributes });
      await recordAct(tx, actor, now, { act: "create_store", storeId: resourceId, after: { code, kind: attributes.kind } });
      return resourceId;
    };
    const centralStoreId = await ensure(CENTRAL_STORE_CODE, "Central store (non-drug)", {
      domain: "stores", kind: "central", custodianRoles: ["storekeeper"], serviceHours: "09:00-17:00",
    });
    const nightStoreId = await ensure(NIGHT_STORE_CODE, "Night store (non-drug)", {
      domain: "stores", kind: "night", custodianRoles: ["duty_manager", "nursing_supervisor"], suppliedBy: centralStoreId,
    });
    return { categories, centralStoreId, nightStoreId };
  });
}

// ═══════════════════════════════ items ═══════════════════════════════

type CheckedItem = { klass: string; categoryId: string; trackMode: TrackMode };

/** The refusals of decisions 2–4, in the order a person fixes them: what the thing is, then where it is filed. */
async function checkStoresItem(
  db: Db | Tx, input: { class: string; patientBillable?: boolean; categoryId: string | null; trackMode: string | null },
): Promise<CheckedItem> {
  if (input.class === "implant" || input.patientBillable === true) {
    throw new StoresError("patient_billable_refused", "an item that can appear on a patient's bill stays with pharmacy (ruling 0099 Q1)", { class: input.class });
  }
  if (!(STORES_ITEM_CLASSES as readonly string[]).includes(input.class)) {
    throw new StoresError("not_stores_class", `class "${input.class}" is not a Stores class`, { class: input.class });
  }
  if (input.categoryId === null || input.categoryId === "") throw new StoresError("category_required", "every Stores item has one category");
  const [category] = await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.id, input.categoryId));
  if (category === undefined) throw new StoresError("unknown_category", `category ${input.categoryId} not found`);
  if (input.trackMode === null || !(TRACK_MODES as readonly string[]).includes(input.trackMode)) {
    throw new StoresError("track_mode_required", "a Stores item is expensed, shelf or durable");
  }
  return { klass: input.class, categoryId: input.categoryId, trackMode: input.trackMode as TrackMode };
}

async function insertStoresItem(tx: Tx, actor: Actor, input: RegisterStoresItemInput, checked: CheckedItem): Promise<string> {
  let itemId: string;
  try {
    ({ itemId } = await tx.transaction((sp) => registerItem(sp, actor, {
      code: input.code.trim(), name: input.name.trim(), class: checked.klass, baseUom: input.baseUom,
      batchTracked: (BATCH_MANDATORY_CLASSES as readonly string[]).includes(checked.klass),
      hsnCode: input.hsnCode ?? null, gstRateBps: input.gstRateBps ?? null,
      uoms: input.issuePack === null || input.issuePack === undefined ? [] : [{
        uom: input.issuePack.uom, toBaseMultiplier: input.issuePack.multiplier, isIssueUom: true, isPurchaseUom: false,
      }],
    })));
  } catch (e) {
    if (e instanceof MaterialsError && e.code === "duplicate_code") throw new StoresError("duplicate_code", e.message);
    throw e;
  }
  await tx.update(items).set({
    categoryId: checked.categoryId, trackMode: checked.trackMode, searchAliases: normalAliases(input.searchAliases), patientBillable: false,
  }).where(eq(items.id, itemId));
  return itemId;
}

export async function registerStoresItem(db: Db, actor: Actor, input: RegisterStoresItemInput, now: Date = new Date()): Promise<{ itemId: string }> {
  await requireMasters(db, actor);
  const checked = await checkStoresItem(db, input);
  return withTx(db, async (tx) => {
    const itemId = await insertStoresItem(tx, actor, input, checked);
    await recordAct(tx, actor, now, {
      act: "register_item", itemId, after: { code: input.code, class: checked.klass, categoryId: checked.categoryId, trackMode: checked.trackMode },
    });
    return { itemId };
  });
}

/** The Stores item, or `unknown_item` / `not_stores_item`. */
export async function requireStoresItem(db: Db | Tx, itemId: string): Promise<typeof items.$inferSelect & { trackMode: TrackMode }> {
  const [row] = await db.select().from(items).where(eq(items.id, itemId));
  if (row === undefined) throw new StoresError("unknown_item", `item ${itemId} not found`, { itemId });
  if (row.trackMode === null || row.class === "drug" || row.mergedIntoItemId !== null) {
    throw new StoresError("not_stores_item", `${row.code} is not a Stores item`, { itemId });
  }
  return { ...row, trackMode: row.trackMode as TrackMode };
}

/** Category, track-mode and alias edits, each its own event with before and after (decision 11). */
export async function updateStoresItem(
  db: Db, actor: Actor, itemId: string, patch: { categoryId?: string; trackMode?: TrackMode; searchAliases?: string[] }, reason: string | null,
  now: Date = new Date(),
): Promise<void> {
  await requireMasters(db, actor);
  await withTx(db, async (tx) => {
    const item = await requireStoresItem(tx, itemId);
    if (patch.categoryId !== undefined && patch.categoryId !== item.categoryId) {
      await checkStoresItem(tx, { class: item.class, categoryId: patch.categoryId, trackMode: item.trackMode });
      await tx.update(items).set({ categoryId: patch.categoryId, updatedBy: actor.id, updatedAt: now }).where(eq(items.id, itemId));
      await recordAct(tx, actor, now, { act: "category", itemId, before: item.categoryId, after: patch.categoryId, reason });
    }
    if (patch.trackMode !== undefined && patch.trackMode !== item.trackMode) {
      if (!(TRACK_MODES as readonly string[]).includes(patch.trackMode)) throw new StoresError("track_mode_required", "expensed, shelf or durable");
      await tx.update(items).set({ trackMode: patch.trackMode, updatedBy: actor.id, updatedAt: now }).where(eq(items.id, itemId));
      await recordAct(tx, actor, now, { act: "track_mode", itemId, before: item.trackMode, after: patch.trackMode, reason });
    }
    if (patch.searchAliases !== undefined) {
      const next = normalAliases(patch.searchAliases);
      if (next.join("\u0001") !== item.searchAliases.join("\u0001")) {
        await tx.update(items).set({ searchAliases: next, updatedBy: actor.id, updatedAt: now }).where(eq(items.id, itemId));
        await recordAct(tx, actor, now, { act: "aliases", itemId, before: item.searchAliases, after: next, reason });
      }
    }
  });
}

async function issuePacks(db: Db | Tx, itemIds: readonly string[]): Promise<Map<string, { uom: string; multiplier: number }>> {
  const out = new Map<string, { uom: string; multiplier: number }>();
  if (itemIds.length === 0) return out;
  const rows = await db.select({ itemId: itemUoms.itemId, uom: itemUoms.uom, m: itemUoms.toBaseMultiplier }).from(itemUoms)
    .where(and(inArray(itemUoms.itemId, [...itemIds]), eq(itemUoms.isIssueUom, true)));
  for (const r of rows) {
    const cur = out.get(r.itemId);
    if (cur === undefined || r.m > cur.multiplier) out.set(r.itemId, { uom: r.uom, multiplier: r.m });
  }
  return out;
}

async function viewsOf(db: Db | Tx, where: ReturnType<typeof and>, limit?: number): Promise<StoresItemView[]> {
  const q = db.select({
    id: items.id, code: items.code, name: items.name, class: items.class, baseUom: items.baseUom, categoryId: items.categoryId,
    categoryName: itemCategories.name, trackMode: items.trackMode, searchAliases: items.searchAliases, active: items.active,
  }).from(items).leftJoin(itemCategories, eq(itemCategories.id, items.categoryId)).where(where).orderBy(asc(items.name), asc(items.code));
  const rows = limit === undefined ? await q : await q.limit(limit);
  const packs = await issuePacks(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r, trackMode: r.trackMode as TrackMode,
    issuePack: packs.get(r.id) ?? { uom: r.baseUom, multiplier: 1 },
  }));
}

/** Decision 2: Stores items only — never a drug, never a pharmacy item (no track mode). */
export async function listStoresItems(db: Db | Tx, filter: { categoryId?: string } = {}): Promise<StoresItemView[]> {
  return viewsOf(db, and(storesItemWhere, filter.categoryId === undefined ? undefined : eq(items.categoryId, filter.categoryId)));
}

/**
 * Decision 5: a request is steered to the master. The name, the code and every alias match ("kachra
 * dabba" finds the dustbin); four digits typed alone match the END of the code, the fallback a storekeeper
 * reads off a label.
 */
export async function searchStoresItems(db: Db | Tx, q: string): Promise<StoresItemView[]> {
  const term = q.trim().toLowerCase().replace(/\s+/g, " ");
  if (term === "") return [];
  if (/^\d{4}$/.test(term)) {
    return viewsOf(db, and(storesItemWhere, eq(items.active, true), sql`lower(${items.code}) like ${`%${term}`}`), 30);
  }
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return viewsOf(db, and(storesItemWhere, eq(items.active, true), sql`(
    lower(${items.name}) like ${like} or lower(${items.code}) like ${like}
    or exists (select 1 from unnest(${items.searchAliases}) as a(alias) where lower(a.alias) like ${like})
  )`), 30);
}

/**
 * Decision 10: the register loaded from a sheet. Every row is checked (class, category, track mode, code,
 * and the duplicate check `similarNames` against the master AND the rows above it); a dry run creates
 * nothing; each refusal names its 1-based row. A real run creates the clean rows in one transaction and
 * appends one `import` event.
 */
export async function importStoresItems(
  db: Db, actor: Actor, rows: readonly StoresImportRow[], opts: { dryRun: boolean }, now: Date = new Date(),
): Promise<ImportResult> {
  await requireMasters(db, actor);
  const cats = new Map((await listCategories(db)).map((c) => [c.code.toLowerCase(), c.id]));
  const existing = await db.select({ code: items.code, name: items.name, storesItem: sql<boolean>`${items.trackMode} is not null` }).from(items);
  const codes = new Set(existing.map((e) => e.code.toLowerCase()));
  const names = existing.filter((e) => e.storesItem).map((e) => e.name);
  const refusals: ImportRefusal[] = [];
  const clean: { input: RegisterStoresItemInput; checked: CheckedItem; row: number }[] = [];
  for (const [i, r] of rows.entries()) {
    const row = i + 1;
    try {
      const checked = await checkStoresItem(db, {
        class: r.class.trim(), categoryId: cats.get(r.category.trim().toLowerCase()) ?? "", trackMode: r.trackMode.trim(),
      }).catch((e: unknown) => {
        // An unknown category code reads as a missing one to `checkStoresItem`; name it as the sheet's.
        if (e instanceof StoresError && e.code === "category_required" && r.category.trim() !== "") {
          throw new StoresError("unknown_category", `no category with code "${r.category}"`);
        }
        throw e;
      });
      if (r.code.trim() === "" || r.name.trim() === "" || r.baseUom.trim() === "") {
        refusals.push({ row, code: "incomplete_row", message: "code, name and unit are required" });
        continue;
      }
      if (codes.has(r.code.trim().toLowerCase())) {
        refusals.push({ row, code: "duplicate_code", message: `code ${r.code} already exists` });
        continue;
      }
      const like = names.find((n) => similarNames(n, r.name));
      if (like !== undefined) {
        refusals.push({ row, code: "duplicate_item", message: `looks like "${like}", already on the master` });
        continue;
      }
      codes.add(r.code.trim().toLowerCase());
      names.push(r.name);
      clean.push({
        row, checked,
        input: {
          code: r.code, name: r.name, class: checked.klass, baseUom: r.baseUom.trim(), categoryId: checked.categoryId, trackMode: checked.trackMode,
          searchAliases: (r.aliases ?? "").split(";"),
        },
      });
    } catch (e) {
      if (e instanceof StoresError) { refusals.push({ row, code: e.code, message: e.message }); continue; }
      throw e;
    }
  }
  if (opts.dryRun) return { dryRun: true, created: 0, wouldCreate: clean.length, refusals };
  if (clean.length === 0) return { dryRun: false, created: 0, wouldCreate: 0, refusals };
  await withTx(db, async (tx) => {
    const lines: Record<string, unknown>[] = [];
    for (const c of clean) lines.push({ row: c.row, itemId: await insertStoresItem(tx, actor, c.input, c.checked), code: c.input.code });
    await recordAct(tx, actor, now, { act: "import", after: lines.length, lines });
  });
  return { dryRun: false, created: clean.length, wouldCreate: clean.length, refusals };
}

// ═══════════════════════════════ "Not in the list" ═══════════════════════════════

export async function requestNewItem(
  db: Db, actor: Actor, input: { name: string; note?: string | null; shelfId: string }, now: Date = new Date(),
): Promise<{ requestId: string }> {
  const shelf = await requireShelf(db, input.shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  const name = input.name.trim();
  if (name === "") throw new StoresError("item_id_required", "say what the item is");
  return withTx(db, async (tx) => {
    const requestId = newId();
    await tx.insert(storesItemRequests).values({
      id: requestId, name, note: input.note?.trim() || null, requestedBy: actor.id, shelfId: shelf.id, departmentId: shelf.departmentId, createdAt: now,
    });
    await recordAct(tx, actor, now, { act: "new_item_request", storeId: shelf.id, refId: requestId, after: name, reason: input.note ?? null });
    return { requestId };
  });
}

export async function listNewItemRequests(db: Db, actor: Actor, filter: { status?: string } = {}): Promise<ItemRequestView[]> {
  await requireMasters(db, actor);
  const rows = await db.select().from(storesItemRequests)
    .where(filter.status === undefined ? undefined : eq(storesItemRequests.status, filter.status))
    .orderBy(desc(storesItemRequests.createdAt)).limit(200);
  const master = rows.length === 0 ? [] : await listStoresItems(db);
  return rows.map((r) => ({
    id: r.id, name: r.name, note: r.note, status: r.status as ItemRequestView["status"], requestedBy: r.requestedBy,
    shelfId: r.shelfId, departmentId: r.departmentId, resolvedItemId: r.resolvedItemId, createdAt: r.createdAt.toISOString(),
    similar: r.status === "open" ? master.filter((m) => similarNames(m.name, r.name) || m.name.toLowerCase().includes(r.name.toLowerCase())).slice(0, 5)
      .map((m) => ({ itemId: m.id, code: m.code, name: m.name })) : [],
  }));
}

/** The head creates the item (`created`) or points to one (`use_existing`); the requester gets exactly one notice. */
export async function resolveNewItemRequest(
  db: Db, actor: Actor, requestId: string, input: { outcome: "created" | "use_existing"; itemId: string }, now: Date = new Date(),
): Promise<void> {
  await requireMasters(db, actor);
  await withTx(db, async (tx) => {
    const [req] = await tx.select().from(storesItemRequests).where(eq(storesItemRequests.id, requestId)).for("update");
    if (req === undefined) throw new StoresError("unknown_request", `request ${requestId} not found`);
    if (req.status !== "open") throw new StoresError("request_closed", "this request is already resolved");
    const item = await requireStoresItem(tx, input.itemId);
    await tx.update(storesItemRequests).set({ status: input.outcome, resolvedItemId: item.id, resolvedBy: actor.id, resolvedAt: now })
      .where(eq(storesItemRequests.id, requestId));
    await recordAct(tx, actor, now, { act: "resolve_request", storeId: req.shelfId, itemId: item.id, refId: requestId, after: input.outcome });
    await raiseNotice(tx as unknown as Db, {
      userId: req.requestedBy, kind: "stores.item_request",
      title: input.outcome === "created" ? "Item added" : "Use existing item",
      body: item.name, refType: "stores_item_request", refId: requestId, sourceKey: `stores-item-request:${requestId}`, at: now,
    });
  });
}
