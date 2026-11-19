import { and, asc, eq, gt, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import {
  events, grns, purchaseOrders, roleAssignments, storeIndents, storesAssetUnitEvents, storesAwards, storesBillHolds, storesBuyGroupMoves, storesPrDeliveries,
  storesQuotes, storesRfqs, storesServiceEntries, supplierBillLines, supplierBills, supplierPaymentRunLines, users,
} from "../../kernel/db/schema";
import { STORES_AUDIT_READ, holds, recordAct } from "./access";
import { StoresError } from "./errors";
import { STORES_ACT_EVENT } from "./events";
import type { AuditPack, AuditPackFilter, AuditPackRow } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S2a (#1112, decision 16) — THE AUDIT PACK: for a ticket, an item, a person or a store over a window,
 * every movement, approval, act and reversal in `seq` order, with the actor and their roles, as rows (print)
 * and CSV. It reads ONE stream, the events table: every Stores act (`stores.act_recorded`, S1's single event)
 * and every materials event (`material.*`: the indent's raise and issue, the transfer's issue and receipt, a
 * discrepancy, a GRN, a write-off). Filters combine with AND. Each export writes one `audit_export` act, after
 * the read, so an export never lists itself and the next export lists it.
 *
 * Roles are the actor's role keys as held when the pack is read (the role table keeps no history).
 */
export const AUDIT_PACK_MAX_ROWS = 5000;
/** Events are partitioned by `recorded_at`; a scan or a downtime entry is recorded after it occurred, never this long before. */
const RECORDED_BEFORE_OCCURRED_MS = 24 * 60 * 60_000;
/** A cell a spreadsheet would read as a formula starts with one of these; it is written with a leading quote. */
const FORMULA_START = /^[=+\-@\t\r]/;
const CSV_HEADER = ["seq", "at", "what", "actor", "actor_name", "roles", "store", "item", "ref", "before", "after", "reason"];

export function csvCell(v: unknown): string {
  const raw = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  const s = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function storesAuditPack(db: Db, actor: Actor, filter: AuditPackFilter, now: Date = new Date()): Promise<AuditPack> {
  if (!(await holds(db, actor, STORES_AUDIT_READ))) throw new StoresError("not_permitted", "the audit pack needs stores.audit.read", { permission: STORES_AUDIT_READ });
  if (!(filter.from instanceof Date) || !(filter.to instanceof Date) || Number.isNaN(filter.from.getTime()) || Number.isNaN(filter.to.getTime()) || filter.from > filter.to) {
    throw new StoresError("bad_window", "the window is from ≤ to");
  }

  const limit = filter.limit === undefined ? AUDIT_PACK_MAX_ROWS : Math.max(1, Math.min(AUDIT_PACK_MAX_ROWS, Math.trunc(filter.limit)));
  // Only Stores' own places: a materials event is in the pack when a Stores store is its source, destination or store.
  // Pharmacy's indents, transfers and GRNs share the stream and stay out of a Stores audit.
  const storesPlaces = sql`(select r.id from resources r where r.kind = 'store' and r.attributes->>'domain' = 'stores')`;
  // S5b (#1115, D18): a purchase request's chain — its groups, RFQs, quotes, awards, the POs made from them, their GRNs
  // and the delivery tickets raised from it. The PO's and GRN's own materials events join by their correlation id.
  const prRefs = filter.prId === undefined ? null : await purchaseChain(db, filter.prId);
  // S6a (#1116, D8): a bill's money chain — its PO(s), GRNs or service entries, the bill, its holds and their releases,
  // the runs that carried it (draft, submit, authorisation) and the payments with their references.
  const billRefs = filter.billId === undefined ? null : await billChain(db, filter.billId);
  const conds = [
    // The window first: `recorded_at` prunes the monthly partitions, `occurred_at` is the window asked for.
    gte(events.recordedAt, new Date(filter.from.getTime() - RECORDED_BEFORE_OCCURRED_MS)),
    gte(events.occurredAt, filter.from), lte(events.occurredAt, filter.to),
    or(eq(events.name, STORES_ACT_EVENT), and(like(events.name, "material.%"), or(
      sql`${events.payload}->>'fromResourceId' in ${storesPlaces}`, sql`${events.payload}->>'toResourceId' in ${storesPlaces}`,
      sql`${events.payload}->>'storeResourceId' in ${storesPlaces}`,
    )), ...(prRefs === null ? [] : [and(or(like(events.name, "purchase_order.%"), like(events.name, "grn.%")), inArray(events.correlationId, prRefs))]),
    ...(billRefs === null ? [] : [and(or(
      like(events.name, "purchase_order.%"), like(events.name, "grn.%"), like(events.name, "supplier_bill.%"), like(events.name, "payment_run.%"),
      like(events.name, "supplier_payment.%"),
    ), inArray(events.correlationId, billRefs))])),
  ];
  if (billRefs !== null) {
    conds.push(or(inArray(events.correlationId, billRefs), sql`${events.payload}->>'refId' in (${sql.join(billRefs.map((r) => sql`${r}`), sql`, `)})`));
  }
  if (prRefs !== null) {
    conds.push(or(inArray(events.correlationId, prRefs), sql`${events.payload}->>'refId' in (${sql.join(prRefs.map((r) => sql`${r}`), sql`, `)})`));
  }
  if (filter.afterSeq !== undefined) conds.push(gt(events.seq, filter.afterSeq));
  if (filter.ticketId !== undefined) {
    const [ind] = await db.select({ transferId: storeIndents.transferId }).from(storeIndents).where(eq(storeIndents.id, filter.ticketId));
    const refs = [filter.ticketId, ...(ind?.transferId == null ? [] : [ind.transferId])];
    conds.push(or(inArray(events.correlationId, refs), sql`${events.payload}->>'indentId' = ${filter.ticketId}`, sql`${events.payload}->>'refId' = ${filter.ticketId}`));
  }
  if (filter.itemId !== undefined) {
    conds.push(or(sql`${events.payload}->>'itemId' = ${filter.itemId}`, sql`${events.payload}->'lines' @> ${JSON.stringify([{ itemId: filter.itemId }])}::jsonb`));
  }
  if (filter.personId !== undefined) conds.push(eq(events.actorId, filter.personId));
  if (filter.unitId !== undefined) {
    // S4b (#1114): the unit's own acts (refId = the unit), and the records its events name: the GRN line it was tagged on,
    // the transfers that carried it (and their tickets), its gate passes, its condemnations and their write-offs.
    const evs = await db.select({ refType: storesAssetUnitEvents.refType, refId: storesAssetUnitEvents.refId }).from(storesAssetUnitEvents)
      .where(eq(storesAssetUnitEvents.unitId, filter.unitId));
    const refs = new Set<string>([filter.unitId, ...evs.map((e) => e.refId).filter((x): x is string => x !== null)]);
    const transfers = evs.filter((e) => e.refType === "transfer" && e.refId !== null).map((e) => e.refId!);
    if (transfers.length > 0) for (const i of await db.select({ id: storeIndents.id }).from(storeIndents).where(inArray(storeIndents.transferId, transfers))) refs.add(i.id);
    const list = [...refs];
    conds.push(or(
      inArray(events.correlationId, list), sql`${events.payload}->>'refId' in (${sql.join(list.map((r) => sql`${r}`), sql`, `)})`,
      sql`${events.payload}->'lines' @> ${JSON.stringify([{ unitId: filter.unitId }])}::jsonb`,
    ));
  }
  if (filter.storeId !== undefined) {
    const s = filter.storeId;
    conds.push(or(
      sql`${events.payload}->>'storeId' = ${s}`, sql`${events.payload}->>'fromResourceId' = ${s}`,
      sql`${events.payload}->>'toResourceId' = ${s}`, sql`${events.payload}->>'resourceId' = ${s}`,
      // S2c (#1119): a gate pass's act sits at OUT-ON-PASS and names its source store on each line.
      sql`${events.payload}->'lines' @> ${JSON.stringify([{ storeId: s }])}::jsonb`,
    ));
  }
  const page = await db.select().from(events).where(and(...conds)).orderBy(asc(events.seq)).limit(limit + 1);
  const truncated = page.length > limit;
  const found = truncated ? page.slice(0, limit) : page;
  const nextAfterSeq = truncated ? found.at(-1)!.seq : null;

  const people = [...new Set(found.map((e) => e.actorId))];
  const names = new Map(people.length === 0 ? [] : (await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.n] as const));
  const roles = new Map<string, string[]>();
  if (people.length > 0) {
    for (const r of await db.select({ u: roleAssignments.userId, k: roleAssignments.roleKey }).from(roleAssignments).where(inArray(roleAssignments.userId, people))) {
      roles.set(r.u, [...new Set([...(roles.get(r.u) ?? []), r.k])].sort());
    }
  }
  const rows: AuditPackRow[] = found.map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const str = (k: string): string | null => (typeof p[k] === "string" ? p[k] : null);
    const isAct = e.name === STORES_ACT_EVENT;
    return {
      seq: e.seq, at: e.occurredAt.toISOString(), what: isAct ? (str("act") ?? e.name) : e.name,
      actor: { id: e.actorId, name: names.get(e.actorId) ?? e.actorId, roles: roles.get(e.actorId) ?? [] },
      storeId: str("storeId") ?? str("fromResourceId") ?? str("resourceId"),
      itemId: str("itemId"),
      ref: str("refId") ?? str("indentId") ?? str("transferId") ?? e.correlationId,
      before: isAct ? (p.before ?? null) : null,
      after: isAct ? (p.after ?? null) : (p.lines ?? p.gaps ?? (e.name === "supplier_payment.recorded"
        ? { mode: p.mode ?? null, reference: p.reference ?? null, amountPaise: p.amountPaise ?? null, paidOn: p.paidOn ?? null } : null)),
      reason: str("reason"),
    };
  });
  const csv = [CSV_HEADER.join(","), ...rows.map((r) => [
    r.seq, r.at, r.what, r.actor.id, r.actor.name, r.actor.roles.join(";"), r.storeId, r.itemId, r.ref, r.before, r.after, r.reason,
  ].map(csvCell).join(","))].join("\n") + "\n"
    + (truncated ? `# truncated at ${String(found.length)} rows; ask again with afterSeq=${String(nextAfterSeq)}\n` : "");

  const shown = {
    ticketId: filter.ticketId ?? null, itemId: filter.itemId ?? null, personId: filter.personId ?? null, storeId: filter.storeId ?? null,
    ...(filter.unitId === undefined ? {} : { unitId: filter.unitId }),
    ...(filter.prId === undefined ? {} : { prId: filter.prId }),
    ...(filter.billId === undefined ? {} : { billId: filter.billId }),
    from: filter.from.toISOString(), to: filter.to.toISOString(),
  };
  await withTx(db, (tx) => recordAct(tx, actor, now, {
    act: "audit_export", storeId: filter.storeId ?? null, itemId: filter.itemId ?? null, refId: filter.ticketId ?? filter.prId ?? filter.billId ?? null,
    after: { ...shown, rows: rows.length, truncated },
  }));
  return { filter: shown, rows, csv, truncated, nextAfterSeq };
}

/** Every record a purchase request's chain names (S5b): request, groups, RFQs, quotes, awards, POs, GRNs, delivery tickets. */
async function purchaseChain(db: Db, prId: string): Promise<string[]> {
  const refs = new Set<string>([prId]);
  const groups = (await db.selectDistinct({ g: storesBuyGroupMoves.groupId }).from(storesBuyGroupMoves).where(eq(storesBuyGroupMoves.prId, prId)))
    .map((r) => r.g).filter((g): g is string => g !== null);
  for (const g of groups) refs.add(g);
  if (groups.length > 0) {
    for (const r of await db.select({ id: storesRfqs.id }).from(storesRfqs).where(inArray(storesRfqs.groupId, groups))) refs.add(r.id);
    for (const q of await db.select({ id: storesQuotes.id }).from(storesQuotes).where(inArray(storesQuotes.groupId, groups))) refs.add(q.id);
    const awards = (await db.select({ id: storesAwards.id }).from(storesAwards).where(inArray(storesAwards.groupId, groups))).map((a) => a.id);
    for (const a of awards) refs.add(a);
    const pos = awards.length === 0 ? [] : (await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(inArray(purchaseOrders.awardId, awards))).map((p) => p.id);
    for (const p of pos) refs.add(p);
    if (pos.length > 0) for (const g of await db.select({ id: grns.id }).from(grns).where(inArray(grns.purchaseOrderId, pos))) refs.add(g.id);
  }
  for (const d of await db.select({ i: storesPrDeliveries.indentId }).from(storesPrDeliveries).where(eq(storesPrDeliveries.prId, prId))) refs.add(d.i);
  return [...refs];
}

/** Every record a supplier bill's money chain names (S6a): bill, PO(s), GRNs, service entries, holds, runs, payments. */
async function billChain(db: Db, billId: string): Promise<string[]> {
  const refs = new Set<string>([billId]);
  const [b] = await db.select({ po: supplierBills.purchaseOrderId }).from(supplierBills).where(eq(supplierBills.id, billId));
  if (b?.po != null) refs.add(b.po);
  for (const l of await db.select({ g: supplierBillLines.grnId, s: supplierBillLines.sesId }).from(supplierBillLines).where(eq(supplierBillLines.billId, billId))) {
    if (l.g !== null) refs.add(l.g);
    if (l.s !== null) refs.add(l.s);
  }
  const grnIds = [...refs];
  for (const g of await db.select({ po: grns.purchaseOrderId }).from(grns).where(inArray(grns.id, grnIds))) if (g.po !== null) refs.add(g.po);
  for (const s of await db.select({ po: storesServiceEntries.purchaseOrderId }).from(storesServiceEntries).where(inArray(storesServiceEntries.id, grnIds))) refs.add(s.po);
  for (const h of await db.select({ id: storesBillHolds.id }).from(storesBillHolds).where(eq(storesBillHolds.billId, billId))) refs.add(h.id);
  for (const r of await db.select({ run: supplierPaymentRunLines.runId, pay: supplierPaymentRunLines.paymentId }).from(supplierPaymentRunLines).where(eq(supplierPaymentRunLines.billId, billId))) {
    refs.add(r.run);
    if (r.pay !== null) refs.add(r.pay);
  }
  return [...refs];
}
