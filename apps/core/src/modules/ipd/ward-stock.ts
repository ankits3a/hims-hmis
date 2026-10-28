import { and, eq, inArray, sql } from "drizzle-orm";
import {
  IPD_WARD_STOCK_RETURN_DAYS, IpdRaiseWardIndentInputSchema, IpdRecordWardStockUseInputSchema, IpdSetWardParInputSchema, newId,
} from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdWardStockPar, ipdWardStockUses, ipdWardStores, items, resources, stockBalances, stockBatches } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withIdempotency } from "../billing";
import { MaterialsError, createStore, listStores, postMovements, raiseIndent, requireStore } from "../materials";
import { holdsPermission, lockAdmission, provenanceOf, requireIpdPermission } from "./admission-core";
import { admissionPlace } from "./admission-place";
import { postDrugIssueChargesIn } from "./drug-charges";
import { IpdError } from "./errors";
import { IPD_NURSING_STATES } from "./nursing";
import { IPD_NURSING_ASSIGN, IPD_WARD_STOCK_USE } from "./permissions";
import { wardIndentRaised, wardParSet, wardStockUsed } from "./ward-safety-events";
import type { Actor, IpdWardLots, IpdWardStock, IpdWardStockCatalogue, IpdWardStockOutcome } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * WM-2 (#983, decisions 0089 / 0091) — WARD STOCK. The ward is a materials STORE (`WARD-<ward code>`, made the first
 * time the in-charge sets par), not a new ledger: every movement goes through the materials ledger.
 *
 * - PAR per item per ward. The ward read shows on hand (the ward store's balances) and the shortfall to par; ONE indent
 *   (`raiseWardIndent`) asks the ward's supply store for every shortfall as one materials indent (materials' own
 *   `raiseIndent`: it moves nothing; stores issue it as a transfer). Lots at the ward expiring within 30 days, or
 *   already expired, are listed for return; stores takes them back at no cost to the ward (0091 rule 4) through the
 *   ordinary materials transfer.
 * - CHARGING (0089 rule 2, 0091 rules 1–2): `used` (on the patient) and `issued` (indented for this one patient) are
 *   charged; `wasted` needs a reason and is charged unless it was staff error (never charged) or the in-charge waives it
 *   (logged); `refused` (unopened) is not charged and never leaves the shelf. An item inside a package is recorded and
 *   not charged. An EXPIRED lot is refused outright (`ward_stock_lot_expired`): it is never used or charged.
 * - PRICE (0091 rule 1, DECIDED shape): the line is the #787 ward-issue line — one `ipd.pharmacy` line per batch priced
 *   by the pharmacy counter's own rule at the instant of use (batch MRP per unit through the item's sale service, the
 *   tariff and GST; never above MRP), with `order_id` = `issue_id` = the use (the counter's precedent). A consumable is
 *   priced the same way through its sale item. No price → the bill desk's `rate_missing` exception, never ₹0.
 */

type Opts = { now?: Date };

function once<T>(db: Db, actor: Actor, act: string, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${act}`, key: key.toLowerCase() }, body, work, now);
}

async function wardOrThrow(exec: Db | Tx, wardId: string): Promise<typeof resources.$inferSelect> {
  const ward = (await exec.select().from(resources).where(eq(resources.id, wardId)))[0];
  if (ward === undefined || (ward.kind !== "ward" && ward.kind !== "hall")) throw new IpdError("ward_not_found", "no ward has this id", { wardId });
  return ward;
}

export async function wardStoreOf(exec: Db | Tx, wardId: string): Promise<typeof ipdWardStores.$inferSelect | null> {
  return (await exec.select().from(ipdWardStores).where(eq(ipdWardStores.wardId, wardId)))[0] ?? null;
}

/** Sets par for the listed items (others keep theirs) and the supply store; makes the ward's store the first time. */
export async function setWardPar(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ wardId: string; storeId: string; supplyStoreId: string }> {
  const input = IpdSetWardParInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const at = opts.now ?? new Date();
  return once(db, actor, "set_ward_par", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const ward = await wardOrThrow(tx, input.wardId);
    await requireStore(tx, input.supplyStoreId);
    let store = await wardStoreOf(tx, ward.id);
    if (store === null) {
      const { resourceId } = await createStore(tx, actor, { code: `WARD-${ward.code}`, name: `${ward.name} ward stock` });
      await tx.insert(ipdWardStores).values({ wardId: ward.id, storeId: resourceId, supplyStoreId: input.supplyStoreId, updatedBy: actor.id, updatedAt: at });
      store = (await wardStoreOf(tx, ward.id))!;
    } else if (store.supplyStoreId !== input.supplyStoreId) {
      await tx.update(ipdWardStores).set({ supplyStoreId: input.supplyStoreId, updatedBy: actor.id, updatedAt: at }).where(eq(ipdWardStores.wardId, ward.id));
    }
    const known = new Set((await tx.select({ id: items.id }).from(items).where(inArray(items.id, input.items.map((i) => i.itemId)))).map((i) => i.id));
    const unknown = input.items.filter((i) => !known.has(i.itemId)).map((i) => i.itemId);
    if (unknown.length > 0) throw new IpdError("ward_stock_not_at_ward", "no such item", { itemIds: unknown });
    for (const i of input.items) {
      await tx.insert(ipdWardStockPar).values({ id: newId(), wardId: ward.id, itemId: i.itemId, par: i.par, updatedBy: actor.id, updatedAt: at })
        .onConflictDoUpdate({ target: [ipdWardStockPar.wardId, ipdWardStockPar.itemId], set: { par: i.par, updatedBy: actor.id, updatedAt: at } });
    }
    await appendEvent(tx, wardParSet.make({
      payload: { wardId: ward.id, storeId: store.storeId, supplyStoreId: input.supplyStoreId, items: input.items.length, provenance: provenanceOf(actor) },
      actor, correlationId: ward.id, occurredAt: at,
    }));
    return { wardId: ward.id, storeId: store.storeId, supplyStoreId: input.supplyStoreId };
  }), at);
}

/** The ward's par, on hand, shortfall, and the lots to send back (expiring within 30 days or expired). */
export async function wardStockOf(exec: Db | Tx, wardId: string, now: Date): Promise<IpdWardStock> {
  const store = await wardStoreOf(exec, wardId);
  if (store === null) return { wardId, storeId: null, supplyStoreId: null, items: [], expiring: [] };
  const pars = await exec.select().from(ipdWardStockPar).where(eq(ipdWardStockPar.wardId, wardId));
  const onHand = await exec.select({ itemId: stockBalances.itemId, qty: sql<number>`coalesce(sum(${stockBalances.qtyOnHand}), 0)::float8` })
    .from(stockBalances).where(eq(stockBalances.resourceId, store.storeId)).groupBy(stockBalances.itemId);
  const have = new Map(onHand.map((r) => [r.itemId, Number(r.qty)] as const));
  const ids = [...new Set([...pars.map((p) => p.itemId), ...onHand.map((r) => r.itemId)])];
  const names = new Map((ids.length === 0 ? [] : await exec.select({ id: items.id, code: items.code, name: items.name }).from(items).where(inArray(items.id, ids)))
    .map((i) => [i.id, i] as const));
  const today = istDayString(now);
  const lots = await exec.select({
    itemId: stockBalances.itemId, batchId: stockBalances.batchId, onHand: stockBalances.qtyOnHand, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
  }).from(stockBalances).innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId)).where(and(
    eq(stockBalances.resourceId, store.storeId), sql`${stockBalances.qtyOnHand} > 0`, sql`${stockBatches.expiryDate} is not null`,
    sql`${stockBatches.expiryDate} <= (${today}::date + ${IPD_WARD_STOCK_RETURN_DAYS}::int)`,
  ));
  const days = (d: string): number => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return {
    wardId, storeId: store.storeId, supplyStoreId: store.supplyStoreId,
    items: pars.map((p) => {
      const n = have.get(p.itemId) ?? 0;
      return { itemId: p.itemId, code: names.get(p.itemId)?.code ?? "", name: names.get(p.itemId)?.name ?? p.itemId, par: p.par, onHand: n, shortfall: Math.max(0, Math.ceil(p.par - n)) };
    }).sort((x, y) => x.name.localeCompare(y.name)),
    expiring: lots.map((l) => ({
      itemId: l.itemId, name: names.get(l.itemId)?.name ?? l.itemId, batchId: l.batchId, batchNo: l.batchNo, expiryDate: String(l.expiryDate),
      daysRemaining: days(String(l.expiryDate)), onHand: Number(l.onHand),
    })).sort((x, y) => x.daysRemaining - y.daysRemaining),
  };
}

export async function readWardStock(db: Db, actor: Actor, q: { wardId: string; now?: Date }): Promise<IpdWardStock> {
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  await wardOrThrow(db, q.wardId);
  return wardStockOf(db, q.wardId, q.now ?? new Date());
}

/** #1007 — active stores items (by name or code) and the stores, for the in-charge's par form. */
export async function readWardStockCatalogue(db: Db, actor: Actor, q: { search?: string }): Promise<IpdWardStockCatalogue> {
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const term = (q.search ?? "").trim().toLowerCase();
  const rows = await db.select({ itemId: items.id, code: items.code, name: items.name, baseUom: items.baseUom }).from(items)
    .where(and(eq(items.active, true), ...(term === "" ? [] : [sql`(lower(${items.name}) like ${`%${term}%`} or lower(${items.code}) like ${`%${term}%`})`])))
    .orderBy(items.name).limit(30);
  const stores = (await listStores(db)).map((s) => ({ id: s.id, code: s.code, name: s.name }));
  return { items: rows, stores };
}

/** #1019 — the lots on the shelf at the patient's ward now (ward-stock use), by item then expiry; expired ones marked. */
export async function readWardLots(db: Db, actor: Actor, q: { admissionId: string; now?: Date }): Promise<IpdWardLots> {
  await requireIpdPermission(db, actor, IPD_WARD_STOCK_USE);
  const now = q.now ?? new Date();
  const wardId = (await admissionPlace(db, q.admissionId))?.wardId ?? null;
  const store = wardId === null ? null : await wardStoreOf(db, wardId);
  if (store === null) return { wardId, lots: [] };
  const today = istDayString(now);
  const rows = await db.select({
    itemId: stockBalances.itemId, name: items.name, baseUom: items.baseUom, batchId: stockBalances.batchId, batchNo: stockBatches.batchNo,
    expiryDate: stockBatches.expiryDate, onHand: stockBalances.qtyOnHand,
  }).from(stockBalances).innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId)).innerJoin(items, eq(items.id, stockBalances.itemId))
    .where(and(eq(stockBalances.resourceId, store.storeId), sql`${stockBalances.qtyOnHand} > 0`));
  return {
    wardId,
    lots: rows.map((r) => ({
      ...r, expiryDate: r.expiryDate === null ? null : String(r.expiryDate), onHand: Number(r.onHand),
      expired: r.expiryDate !== null && String(r.expiryDate) < today,
    })).sort((x, y) => x.name.localeCompare(y.name) || (x.expiryDate ?? "9999").localeCompare(y.expiryDate ?? "9999")),
  };
}

/** One materials indent on the supply store for every item short of par. */
export async function raiseWardIndent(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ indentId: string; indentNo: string; lines: number }> {
  const input = IpdRaiseWardIndentInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const at = opts.now ?? new Date();
  return once(db, actor, "raise_ward_indent", input.idempotencyKey, input, async () => {
    await wardOrThrow(db, input.wardId);
    const stock = await wardStockOf(db, input.wardId, at);
    if (stock.storeId === null || stock.supplyStoreId === null) throw new IpdError("ward_store_not_set", "set the ward's par first");
    const lines = stock.items.filter((i) => i.shortfall > 0).map((i) => ({ itemId: i.itemId, qtyBase: i.shortfall }));
    if (lines.length === 0) throw new IpdError("nothing_to_indent", "nothing on this ward is short of par");
    const indent = await raiseIndent(db, actor, {
      fromResourceId: stock.storeId, toResourceId: stock.supplyStoreId, lines, note: input.note ?? "Ward par top-up",
    }, at);
    await withTx(db, (tx) => appendEvent(tx, wardIndentRaised.make({
      payload: { wardId: input.wardId, indentId: indent.id, lines: lines.length, provenance: provenanceOf(actor) }, actor, correlationId: input.wardId, occurredAt: at,
    })));
    return { indentId: indent.id, indentNo: indent.indentNo, lines: lines.length };
  }, at);
}

/** Why a use is not charged, or null when it is. */
export function notChargedWhy(u: { outcome: IpdWardStockOutcome; staffError: boolean; waived: boolean; inPackage: boolean }): string | null {
  if (u.outcome === "refused") return "refused";
  if (u.inPackage) return "in_package";
  if (u.outcome === "wasted" && u.staffError) return "staff_error";
  if (u.outcome === "wasted" && u.waived) return "waived";
  return null;
}

export async function recordWardStockUse(
  db: Db, actor: Actor, raw: unknown, opts: Opts = {},
): Promise<{ useId: string; charged: boolean; notChargedWhy: string | null; chargeLineIds: string[] }> {
  const input = IpdRecordWardStockUseInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_WARD_STOCK_USE);
  const at = opts.now ?? new Date();
  if (input.outcome === "wasted" && input.reason === undefined) throw new IpdError("waste_reason_required", "wastage is recorded with its reason");
  if (input.waive !== undefined && (input.outcome !== "wasted" || !(await holdsPermission(db, actor, IPD_NURSING_ASSIGN)))) {
    throw new IpdError("waive_needs_incharge", "only the ward in-charge waives a wastage charge");
  }
  return once(db, actor, "record_ward_stock_use", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!(IPD_NURSING_STATES as readonly string[]).includes(a.state)) throw new IpdError("patient_not_on_ward", "the patient is not on a ward bed", { state: a.state });
    const wardId = (await admissionPlace(tx, a.id))?.wardId ?? null;
    const store = wardId === null ? null : await wardStoreOf(tx, wardId);
    if (wardId === null || store === null) throw new IpdError("ward_store_not_set", "this ward has no ward stock yet");
    const batch = (await tx.select().from(stockBatches).where(eq(stockBatches.id, input.batchId)))[0];
    if (batch === undefined || batch.itemId !== input.itemId) throw new IpdError("ward_stock_not_at_ward", "this lot is not of this item", { batchId: input.batchId });
    if (batch.expiryDate !== null && String(batch.expiryDate) < istDayString(at)) {
      throw new IpdError("ward_stock_lot_expired", "this lot is past its expiry: return it to stores; it is never charged", { batchId: batch.id, expiryDate: batch.expiryDate });
    }
    const useId = newId();
    const why = notChargedWhy({ outcome: input.outcome, staffError: input.staffError === true, waived: input.waive !== undefined, inPackage: input.inPackage === true });
    if (input.outcome !== "refused") {
      try {
        await postMovements(tx, actor, [{
          resourceId: store.storeId, batchId: batch.id, qtyDelta: -input.qty, reason: "consume", refType: "ipd_ward_stock_use", refId: useId,
          patientId: a.patientId, encounterId: a.id, occurredAt: at,
        }]);
      } catch (e) {
        if (e instanceof MaterialsError) throw new IpdError("ward_stock_not_at_ward", "the ward does not hold this many of this lot", { reason: e.code });
        throw e;
      }
    }
    let chargeLineIds: string[] = [];
    let missing = false;
    if (why === null) {
      const posted = await postDrugIssueChargesIn(tx, actor, a, {
        orderId: useId, issueId: useId, itemId: input.itemId, batches: [{ batchId: batch.id, qty: input.qty }], reissueReason: null, at,
      });
      chargeLineIds = posted.posted;
      missing = posted.missing > 0;
    }
    const charged = chargeLineIds.length > 0;
    const finalWhy = why ?? (missing ? "price_missing" : null);
    await tx.insert(ipdWardStockUses).values({
      id: useId, admissionId: a.id, patientId: a.patientId, wardId, itemId: input.itemId, batchId: batch.id, qty: input.qty, outcome: input.outcome,
      reason: input.reason ?? null, staffError: input.staffError === true, inPackage: input.inPackage === true,
      waivedBy: input.waive === undefined ? null : actor.id, waivedReason: input.waive?.reason ?? null, charged, notChargedWhy: finalWhy,
      recordedBy: actor.id, at,
    });
    await appendEvent(tx, wardStockUsed.make({
      payload: {
        useId, admissionId: a.id, wardId, itemId: input.itemId, batchId: batch.id, qty: input.qty, outcome: input.outcome, charged,
        notChargedWhy: finalWhy, waived: input.waive !== undefined, provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { useId, charged, notChargedWhy: finalWhy, chargeLineIds };
  }), at);
}
