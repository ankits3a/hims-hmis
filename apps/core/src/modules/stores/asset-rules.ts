import { and, eq, inArray, sql } from "drizzle-orm";
import { grnLines, grns, itemCategories, items, storesAssetUnits, storesTagDecisions } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S4 (#1114, decision 1, ruling 0099 Q3) — WHAT GETS A TAG.
 *
 * A category's `tag_rule` is `always` (medical equipment: every unit at any value, items `track_mode = 'tagged'`),
 * `from_value` (IT and peripherals, furniture: a `durable` item whose GRN line costs ₹5,000 or more per unit before
 * GST is tagged, the rest counted) or `never`. A sub-category inherits its top category's rule when its own is weaker,
 * and `needs_calibration` the same way, so "Biomedical spares → Whole devices" can be `always` under a `never` top.
 *
 * The per-line decision is written ONCE (`stores_tag_decisions`, append-only in the database) the first time Stores
 * reads the line: the threshold it was judged against is frozen with it, so a later change of the line never rewrites
 * the past. `materials/grn.ts` `opensOwnBatch` gives every such line its own batch, so a counted and a tagged chair
 * never share a pile.
 */
export const TAG_THRESHOLD_PAISE = 500_000;

export type TagRule = "always" | "from_value" | "never";
const RANK: Record<TagRule, number> = { never: 0, from_value: 1, always: 2 };

export type CategoryRules = { tagRule: TagRule; needsCalibration: boolean; name: string; topName: string };

/** The effective rule of a category: its own or its top category's, whichever is stronger. */
export async function categoryRules(db: Db | Tx, categoryId: string | null): Promise<CategoryRules> {
  if (categoryId === null) return { tagRule: "never", needsCalibration: false, name: "", topName: "" };
  const [c] = await (db as Db).select().from(itemCategories).where(eq(itemCategories.id, categoryId));
  if (c === undefined) return { tagRule: "never", needsCalibration: false, name: "", topName: "" };
  const own = c.tagRule as TagRule;
  if (c.parentId === null) return { tagRule: own, needsCalibration: c.needsCalibration, name: c.name, topName: c.name };
  const [p] = await (db as Db).select().from(itemCategories).where(eq(itemCategories.id, c.parentId));
  const parent = (p?.tagRule ?? "never") as TagRule;
  return {
    tagRule: RANK[parent] > RANK[own] ? parent : own, needsCalibration: c.needsCalibration || (p?.needsCalibration ?? false),
    name: c.name, topName: p?.name ?? c.name,
  };
}

export async function itemRules(db: Db | Tx, itemId: string): Promise<CategoryRules & { trackMode: string | null; name: string; gstRateBps: number | null; manufacturer: string | null }> {
  const [i] = await (db as Db).select({ trackMode: items.trackMode, categoryId: items.categoryId, name: items.name, gst: items.gstRateBps, mfr: items.manufacturer })
    .from(items).where(eq(items.id, itemId));
  const rules = await categoryRules(db, i?.categoryId ?? null);
  return { ...rules, name: i?.name ?? "", trackMode: i?.trackMode ?? null, gstRateBps: i?.gst ?? null, manufacturer: i?.mfr ?? null };
}

export type TagDecision = {
  grnLineId: string; grnId: string; grnNo: string; batchId: string; itemId: string; qty: number; unitCostPaise: number; result: "tagged" | "counted";
  supplierId: string;
};

/**
 * The decision for one POSTED GRN line of a Stores item under a rule, written the first time it is asked (insert on
 * conflict do nothing, then read back: two readers at once agree). Null for a line under no rule, or not posted.
 */
export async function tagDecisionFor(db: Db | Tx, grnLineId: string, now: Date): Promise<TagDecision | null> {
  const [row] = await (db as Db).select({ line: grnLines, grnNo: grns.grnNo, status: grns.status, vendorId: grns.vendorId })
    .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).where(eq(grnLines.id, grnLineId));
  if (row === undefined || row.status !== "posted" || row.line.batchId === null || row.line.qtyAcceptedBase <= 0) return null;
  const rules = await itemRules(db, row.line.itemId);
  let rule: "always" | "from_value";
  let result: "tagged" | "counted";
  if (rules.trackMode === "tagged") {
    rule = "always"; result = "tagged";
  } else if (rules.trackMode === "durable" && rules.tagRule !== "never") {
    rule = "from_value"; result = row.line.unitCostPaise >= TAG_THRESHOLD_PAISE ? "tagged" : "counted";
  } else {
    return null;
  }
  await (db as Db).insert(storesTagDecisions).values({
    grnLineId, batchId: row.line.batchId, itemId: row.line.itemId, rule, unitCostPaise: row.line.unitCostPaise, thresholdPaise: TAG_THRESHOLD_PAISE,
    result, decidedAt: now,
  }).onConflictDoNothing();
  const [d] = await (db as Db).select().from(storesTagDecisions).where(eq(storesTagDecisions.grnLineId, grnLineId));
  return {
    grnLineId, grnId: row.line.grnId, grnNo: row.grnNo, batchId: d!.batchId, itemId: d!.itemId, qty: row.line.qtyAcceptedBase,
    unitCostPaise: d!.unitCostPaise, result: d!.result as "tagged" | "counted", supplierId: row.vendorId,
  };
}

/**
 * The batches of these items that are TAGGED: every batch of a `tagged` item, every batch a decision made tagged,
 * every batch that carries a unit. A counted issue or pass never takes from one of these.
 */
export async function taggedBatchIds(db: Db | Tx, itemIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return new Set();
  const rows = await (db as Db).execute(sql`
    select b.id from stock_batches b join items i on i.id = b.item_id
     where b.item_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
       and (i.track_mode = 'tagged'
         or exists (select 1 from stores_tag_decisions d where d.batch_id = b.id and d.result = 'tagged')
         or exists (select 1 from stores_asset_units u where u.batch_id = b.id))`);
  return new Set((rows.rows as { id: string }[]).map((r) => r.id));
}

/** Units already made on a GRN line. */
export async function unitsOfLine(db: Db | Tx, grnLineId: string): Promise<(typeof storesAssetUnits.$inferSelect)[]> {
  return (db as Db).select().from(storesAssetUnits).where(eq(storesAssetUnits.grnLineId, grnLineId));
}

/** Posted GRN lines of tagged-capable items that still owe tags (or all of them, `owing = false`), newest first. */
export async function linesUnderRule(db: Db | Tx, limit = 100): Promise<{ grnLineId: string }[]> {
  const rows = await (db as Db).select({ id: grnLines.id }).from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId))
    .innerJoin(items, eq(items.id, grnLines.itemId))
    .where(and(eq(grns.status, "posted"), inArray(items.trackMode, ["tagged", "durable"]), sql`${grnLines.qtyAcceptedBase} > 0`,
      sql`(select count(*) from stores_asset_units u where u.grn_line_id = ${grnLines.id}) < ${grnLines.qtyAcceptedBase}`))
    .orderBy(sql`${grns.postedAt} desc nulls last`).limit(limit);
  return rows.map((r) => ({ grnLineId: r.id }));
}
