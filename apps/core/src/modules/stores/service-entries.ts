import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  items, orgDepartments, purchaseOrderLines, purchaseOrders, storesServiceEntries, storesServiceEntryLines, supplierBillLines, supplierBills, vendors,
} from "../../kernel/db/schema";
import { lineGstPaise, registerServiceEntrySource } from "../materials";
import { STORES_SES_CONFIRM, departmentOf, holds, recordAct } from "./access";
import { clean, ex, nextNo, peopleNamed } from "./buying-common";
import { StoresError } from "./errors";
import type { ServiceEntryLine } from "../materials";
import type { Actor, WireServiceEntry, WireServiceToConfirm, WireSesPeriodKind, WireSesSource } from "@hmis/contracts";
import type { Exec } from "./buying-common";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S6a (#1116, decisions 2–3) — THE SERVICE ENTRY SHEET (SES), the GRN of a service.
 *
 * A service contract is a PO on `service` items (laundry per piece, an AMC, manpower, the caterer). When its period ends
 * (a month for most; the start of the term for a contract billed in advance by its own terms) the department that
 * receives the service confirms it: the lines prefilled from the PO (or the source module), one tap Confirm, or a Short
 * with the quantity and one line. One sheet per PO and period (`ses_exists`, under an advisory lock); the rows are
 * append-only (0247), so a correction is a reversing sheet naming the first (`reverses_id`; S6c `reverseServiceEntry`).
 *
 * The bill: `billDraftFromSes` mirrors materials' `billDraftFromGrn`; the bill's lines name `ses_id` and the 3-way match is
 * PO × SES × bill (materials reads the sheet through `registerServiceEntrySource`, registered below at import).
 */
const PO_LIVE = ["approved", "sent", "part_received", "received"];
const BILLS_MANAGE = "materials.bills.manage";

export type ServiceEntryInput = {
  purchaseOrderId: string;
  departmentId: string;
  period: { kind: WireSesPeriodKind; key: string; start: string; end: string };
  source: WireSesSource;
  sourceRef?: string | null;
  /** Lines as confirmed; omitted = every service line of the PO as ordered. A line below the order needs `shortReason`. */
  lines?: { itemId: string; qtyBase: number; shortReason?: string | null }[];
  note?: string | null;
};

const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** The PO's service lines (items of class `service`), with what each was ordered at. */
async function serviceLinesOf(db: Exec, poId: string): Promise<{ itemId: string; itemName: string; baseUom: string; orderedBase: number; ratePaise: number; multiplier: number; gstRateBps: number }[]> {
  const rows = await ex(db).select({ l: purchaseOrderLines, name: items.name, baseUom: items.baseUom, klass: items.class }).from(purchaseOrderLines)
    .innerJoin(items, eq(items.id, purchaseOrderLines.itemId)).where(eq(purchaseOrderLines.purchaseOrderId, poId)).orderBy(asc(items.name));
  return rows.filter((r) => r.klass === "service").map((r) => ({
    itemId: r.l.itemId, itemName: r.name, baseUom: r.baseUom, orderedBase: r.l.qtyPacks * r.l.multiplier, ratePaise: r.l.ratePaise,
    multiplier: r.l.multiplier, gstRateBps: r.l.gstRateBps,
  }));
}

/** The live (not reversed, not itself a reversal) sheet for a PO and period, if any. */
async function liveSesFor(db: Exec, poId: string, periodKey: string): Promise<string | null> {
  const reversed = ex(db).select({ id: storesServiceEntries.reversesId }).from(storesServiceEntries).where(isNotNull(storesServiceEntries.reversesId));
  const [row] = await ex(db).select({ id: storesServiceEntries.id }).from(storesServiceEntries)
    .where(and(
      eq(storesServiceEntries.purchaseOrderId, poId), eq(storesServiceEntries.periodKey, periodKey), isNull(storesServiceEntries.reversesId),
      notInArray(storesServiceEntries.id, reversed),
    )).limit(1);
  return row?.id ?? null;
}

export async function confirmServiceEntry(db: Db, actor: Actor, input: ServiceEntryInput, now: Date = new Date()): Promise<WireServiceEntry> {
  const p = input.period;
  if (!isDay(p.start) || !isDay(p.end) || p.start > p.end || p.key.trim() === "") throw new StoresError("bad_quantity", "the period is a start and an end date, in order, with a key");
  await departmentOf(db, input.departmentId);
  if (!(await holds(db, actor, STORES_SES_CONFIRM, input.departmentId))) {
    throw new StoresError("not_permitted", "Not your department", { permission: STORES_SES_CONFIRM, departmentId: input.departmentId });
  }
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId));
  if (po === undefined) throw new StoresError("unknown_po", `purchase order ${input.purchaseOrderId} not found`);
  if (!PO_LIVE.includes(po.status)) throw new StoresError("not_service_po", `purchase order ${po.poNo} is ${po.status}; a service is confirmed on an approved order`);
  const ordered = await serviceLinesOf(db, po.id);
  if (ordered.length === 0) throw new StoresError("not_service_po", `purchase order ${po.poNo} orders no service`);
  const given = new Map((input.lines ?? []).map((l) => [l.itemId, l] as const));
  for (const id of given.keys()) if (!ordered.some((o) => o.itemId === id)) throw new StoresError("not_service_po", "a line names an item the order does not", { itemId: id });
  const lines = ordered.map((o) => {
    const g = given.get(o.itemId);
    const qty = g?.qtyBase ?? o.orderedBase;
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > o.orderedBase) throw new StoresError("bad_quantity", `${o.itemName}: between 0 and ${String(o.orderedBase)}`, { itemId: o.itemId });
    const why = clean(g?.shortReason);
    if (qty < o.orderedBase && why === null) throw new StoresError("reason_required", `${o.itemName}: say why it is short`, { itemId: o.itemId });
    return { ...o, qtyBase: qty, shortReason: qty < o.orderedBase ? why!.slice(0, 200) : null };
  });

  const sesId = await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-ses:${po.id}:${p.key.trim()}`}))`);
    if ((await liveSesFor(tx, po.id, p.key.trim())) !== null) {
      throw new StoresError("ses_exists", `${po.poNo} is already confirmed for ${p.key.trim()}`, { purchaseOrderId: po.id, periodKey: p.key.trim() });
    }
    const id = newId();
    const sesNo = await nextNo(tx, "stores_ses", "SES", now);
    await tx.insert(storesServiceEntries).values({
      id, sesNo, purchaseOrderId: po.id, vendorId: po.vendorId, departmentId: input.departmentId, periodKind: p.kind, periodKey: p.key.trim(),
      periodStart: p.start, periodEnd: p.end, source: input.source, sourceRef: clean(input.sourceRef)?.slice(0, 80) ?? null, reversesId: null,
      note: clean(input.note)?.slice(0, 300) ?? null, confirmedBy: actor.id, confirmedAt: now,
    });
    await tx.insert(storesServiceEntryLines).values(lines.map((l) => ({
      id: newId(), sesId: id, itemId: l.itemId, orderedBase: l.orderedBase, qtyBase: l.qtyBase, shortReason: l.shortReason,
      ratePaise: l.ratePaise, multiplier: l.multiplier, gstRateBps: l.gstRateBps,
    })));
    await recordAct(tx, actor, now, {
      act: "ses_confirm", refId: id, reason: lines.some((l) => l.shortReason !== null) ? lines.map((l) => l.shortReason).filter((x) => x !== null).join("; ") : null,
      after: { sesNo, purchaseOrderId: po.id, departmentId: input.departmentId, periodKey: p.key.trim(), source: input.source },
      lines: lines.map((l) => ({ itemId: l.itemId, orderedBase: l.orderedBase, qtyBase: l.qtyBase })),
    });
    return id;
  });
  return getServiceEntry(db, sesId);
}

/**
 * S6c (#1116, decision 2) — a correction is a REVERSING sheet naming the first: a header row with `reverses_id` and the
 * reason, no lines. The first then counts nowhere (To book, the match, the month's "to confirm"), and the period can be
 * confirmed again. Only while the first is on no live bill (a billed service is corrected by the supplier's credit note,
 * edge case 2); never a reversal of a reversal; once per sheet. The department's confirmer, with a reason.
 */
export async function reverseServiceEntry(db: Db, actor: Actor, sesId: string, reason: string, now: Date = new Date()): Promise<WireServiceEntry> {
  const why = clean(reason);
  const first = await getServiceEntry(db, sesId);
  if (!(await holds(db, actor, STORES_SES_CONFIRM, first.department.id))) {
    throw new StoresError("not_permitted", "Not your department", { permission: STORES_SES_CONFIRM, departmentId: first.department.id });
  }
  if (why === null) throw new StoresError("reason_required", "say why the service entry is reversed");
  const id = await withTx(db, async (tx) => {
    const [h] = await tx.select().from(storesServiceEntries).where(eq(storesServiceEntries.id, sesId)).for("update");
    if (h!.reversesId !== null) throw new StoresError("not_reversible", "a reversing entry is not reversed again");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-ses:${h!.purchaseOrderId}:${h!.periodKey}`}))`);
    const [again] = await tx.select({ id: storesServiceEntries.id }).from(storesServiceEntries).where(eq(storesServiceEntries.reversesId, sesId)).limit(1);
    if (again !== undefined) throw new StoresError("already_reversed", `service entry ${h!.sesNo} is already reversed`);
    const [billed] = await tx.select({ billNo: supplierBills.billNo }).from(supplierBillLines).innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId))
      .where(and(eq(supplierBillLines.sesId, sesId), ne(supplierBills.status, "cancelled"))).limit(1);
    if (billed !== undefined) throw new StoresError("ses_already_billed", `service entry ${h!.sesNo} is on bill ${billed.billNo}; the supplier's credit note corrects it`, { billNo: billed.billNo });
    const rid = newId();
    const sesNo = await nextNo(tx, "stores_ses", "SES", now);
    await tx.insert(storesServiceEntries).values({
      id: rid, sesNo, purchaseOrderId: h!.purchaseOrderId, vendorId: h!.vendorId, departmentId: h!.departmentId, periodKind: h!.periodKind, periodKey: h!.periodKey,
      periodStart: h!.periodStart, periodEnd: h!.periodEnd, source: h!.source, sourceRef: h!.sourceRef, reversesId: sesId, note: why.slice(0, 300),
      confirmedBy: actor.id, confirmedAt: now,
    });
    await recordAct(tx, actor, now, {
      act: "ses_reverse", refId: rid, reason: why.slice(0, 300), before: { sesNo: h!.sesNo, status: "confirmed" },
      after: { sesNo, reverses: sesId, reversesNo: h!.sesNo, purchaseOrderId: h!.purchaseOrderId, periodKey: h!.periodKey },
    });
    return rid;
  });
  return getServiceEntry(db, id);
}

/** The sheets confirmed at a department (newest first), each with whether it can still be reversed. */
export async function serviceEntriesAt(db: Db, actor: Actor, departmentId: string, limit = 30): Promise<(WireServiceEntry & { reversed: boolean; reversal: boolean })[]> {
  if (!(await holds(db, actor, STORES_SES_CONFIRM, departmentId))) {
    throw new StoresError("not_permitted", "Not your department", { permission: STORES_SES_CONFIRM, departmentId });
  }
  const rows = await db.select({ id: storesServiceEntries.id, rev: storesServiceEntries.reversesId }).from(storesServiceEntries)
    .where(eq(storesServiceEntries.departmentId, departmentId)).orderBy(desc(storesServiceEntries.confirmedAt)).limit(Math.min(limit, 100));
  const reversed = new Set(rows.map((r) => r.rev).filter((x): x is string => x !== null));
  const out: (WireServiceEntry & { reversed: boolean; reversal: boolean })[] = [];
  for (const r of rows) out.push({ ...(await getServiceEntry(db, r.id)), reversed: reversed.has(r.id), reversal: r.rev !== null });
  return out;
}

export async function getServiceEntry(db: Exec, sesId: string): Promise<WireServiceEntry> {
  const [s] = await ex(db).select({ s: storesServiceEntries, poNo: purchaseOrders.poNo, legal: vendors.legalName, trade: vendors.tradeName, dCode: orgDepartments.code, dName: orgDepartments.name })
    .from(storesServiceEntries).innerJoin(purchaseOrders, eq(purchaseOrders.id, storesServiceEntries.purchaseOrderId))
    .innerJoin(vendors, eq(vendors.id, storesServiceEntries.vendorId)).innerJoin(orgDepartments, eq(orgDepartments.id, storesServiceEntries.departmentId))
    .where(eq(storesServiceEntries.id, sesId));
  if (s === undefined) throw new StoresError("unknown_ses", `service entry ${sesId} not found`);
  const lines = await ex(db).select({ l: storesServiceEntryLines, name: items.name, baseUom: items.baseUom }).from(storesServiceEntryLines)
    .innerJoin(items, eq(items.id, storesServiceEntryLines.itemId)).where(eq(storesServiceEntryLines.sesId, sesId)).orderBy(asc(items.name));
  const person = await peopleNamed(db, [s.s.confirmedBy]);
  const [billed] = await ex(db).select({ billNo: supplierBills.billNo }).from(supplierBillLines).innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId))
    .where(and(eq(supplierBillLines.sesId, sesId), ne(supplierBills.status, "cancelled"))).limit(1);
  return {
    id: s.s.id, sesNo: s.s.sesNo, purchaseOrderId: s.s.purchaseOrderId, poNo: s.poNo, vendorId: s.s.vendorId, vendorName: s.trade ?? s.legal,
    department: { id: s.s.departmentId, code: s.dCode, name: s.dName },
    period: { kind: s.s.periodKind as WireSesPeriodKind, key: s.s.periodKey, start: s.s.periodStart, end: s.s.periodEnd },
    source: s.s.source as WireSesSource, sourceRef: s.s.sourceRef,
    status: lines.some((l) => l.l.qtyBase < l.l.orderedBase) ? "short" : "confirmed",
    lines: lines.map(({ l, name, baseUom }) => ({
      itemId: l.itemId, itemName: name, baseUom, orderedBase: l.orderedBase, qtyBase: l.qtyBase, shortBase: l.orderedBase - l.qtyBase,
      shortReason: l.shortReason, ratePaise: l.ratePaise, multiplier: l.multiplier,
    })),
    confirmedBy: person(s.s.confirmedBy), confirmedAt: s.s.confirmedAt.toISOString(), billNo: billed?.billNo ?? null,
  };
}

/** One sheet, for the department that confirmed it or a payables reader. */
export async function readServiceEntry(db: Db, actor: Actor, sesId: string): Promise<WireServiceEntry> {
  const s = await getServiceEntry(db, sesId);
  if (await holds(db, actor, STORES_SES_CONFIRM, s.department.id)) return s;
  if (actor.type === "user" && (await hasPermission(db, actor.id, BILLS_MANAGE, "hospital"))) return s;
  throw new StoresError("not_permitted", "Not your department", { permission: STORES_SES_CONFIRM });
}

/** The departments this person confirms services for (their `stores.ses.confirm` grant; any for a hospital-scope holder). */
export async function myServiceDepartments(db: Db, actor: Actor): Promise<{ id: string; code: string; name: string }[]> {
  const all = await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments).orderBy(asc(orgDepartments.code));
  const out: { id: string; code: string; name: string }[] = [];
  for (const d of all) if (await holds(db, actor, STORES_SES_CONFIRM, d.id)) out.push(d);
  return out;
}

/** The previous calendar month of an IST day: key `yyyy-mm`, its first and last day. */
export function previousMonth(day: string): { key: string; start: string; end: string } {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const start = `${String(py)}-${String(pm).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10);
  return { key: start.slice(0, 7), start, end };
}

/**
 * "Service to confirm": every approved service PO whose last month is not yet confirmed, for one department the reader
 * confirms at (the quantities prefilled from the PO). The department picks the order; a "term started" contract is
 * confirmed from the same row with its own period.
 */
export async function servicesToConfirm(db: Db, actor: Actor, departmentId: string, now: Date = new Date()): Promise<WireServiceToConfirm[]> {
  const dept = await departmentOf(db, departmentId);
  if (!(await holds(db, actor, STORES_SES_CONFIRM, departmentId))) {
    throw new StoresError("not_permitted", "Not your department", { permission: STORES_SES_CONFIRM, departmentId });
  }
  const month = previousMonth(istDayString(now));
  const pos = await db.selectDistinct({ id: purchaseOrders.id, poNo: purchaseOrders.poNo, legal: vendors.legalName, trade: vendors.tradeName })
    .from(purchaseOrders).innerJoin(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .innerJoin(items, eq(items.id, purchaseOrderLines.itemId)).innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(and(inArray(purchaseOrders.status, PO_LIVE), eq(items.class, "service")))
    .orderBy(asc(purchaseOrders.poNo)).limit(200);
  const out: WireServiceToConfirm[] = [];
  for (const po of pos) {
    if ((await liveSesFor(db, po.id, month.key)) !== null) continue;
    const lines = await serviceLinesOf(db, po.id);
    out.push({
      purchaseOrderId: po.id, poNo: po.poNo, vendorName: po.trade ?? po.legal, department: { id: dept.id, code: dept.code, name: dept.name },
      period: { kind: "month", ...month }, source: "manpower_month",
      lines: lines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, baseUom: l.baseUom, qtyBase: l.orderedBase })),
    });
  }
  return out;
}

/** Sheets on no live bill — the paying desk's "To book" (with the unbilled GRNs). Oldest first. */
export async function unbilledServiceEntries(db: Db, limit = 200): Promise<{ id: string; sesNo: string; vendorId: string; vendorName: string; at: string; poNo: string }[]> {
  const billed = db.select({ id: supplierBillLines.sesId }).from(supplierBillLines).innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId))
    .where(and(ne(supplierBills.status, "cancelled"), isNotNull(supplierBillLines.sesId)));
  const reversed = db.select({ id: storesServiceEntries.reversesId }).from(storesServiceEntries).where(isNotNull(storesServiceEntries.reversesId));
  const rows = await db.select({ s: storesServiceEntries, poNo: purchaseOrders.poNo, legal: vendors.legalName, trade: vendors.tradeName }).from(storesServiceEntries)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, storesServiceEntries.purchaseOrderId)).innerJoin(vendors, eq(vendors.id, storesServiceEntries.vendorId))
    .where(and(isNull(storesServiceEntries.reversesId), notInArray(storesServiceEntries.id, billed), notInArray(storesServiceEntries.id, reversed)))
    .orderBy(asc(storesServiceEntries.confirmedAt)).limit(Math.min(limit, 500));
  return rows.map((r) => ({ id: r.s.id, sesNo: r.s.sesNo, vendorId: r.s.vendorId, vendorName: r.trade ?? r.legal, at: r.s.confirmedAt.toISOString(), poNo: r.poNo }));
}

export type SesBillDraft = {
  vendorId: string; vendorName: string; vendorGstin: string | null; sesId: string; sesNo: string; purchaseOrderId: string; poNo: string;
  vendorBillNo: string; billDate: string; interState: boolean;
  lines: { sesId: string; itemId: string; itemCode: string; itemName: string; uom: string; multiplier: number; qtyPacks: number; ratePaise: number; gstRateBps: number; expectedBase: number }[];
  expectedTotalPaise: number;
};

/**
 * What a bill for this sheet would say if the supplier billed exactly what the department confirmed at the PO's rate:
 * the prefill (decision 3, `billDraftFromGrn`'s mirror). The person types the supplier's number, date and amounts.
 * Writes nothing.
 */
export async function billDraftFromSes(db: Db, actor: Actor, sesId: string, opts: { hospitalStateCode?: string | null } = {}): Promise<SesBillDraft> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, BILLS_MANAGE, "hospital"))) {
    throw new StoresError("not_permitted", `drafting a supplier bill needs ${BILLS_MANAGE}`, { permission: BILLS_MANAGE });
  }
  const ses = await getServiceEntry(db, sesId);
  if (ses.billNo !== null) throw new StoresError("ses_already_billed", `service entry ${ses.sesNo} is already on bill ${ses.billNo}`, { billNo: ses.billNo });
  const [v] = await db.select().from(vendors).where(eq(vendors.id, ses.vendorId));
  const codes = new Map((await db.select({ id: items.id, code: items.code }).from(items).where(inArray(items.id, ses.lines.map((l) => l.itemId)))).map((i) => [i.id, i.code] as const));
  const [poLine] = await db.select({ uom: purchaseOrderLines.uom }).from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, ses.purchaseOrderId)).limit(1);
  const vendorState = v!.gstin?.slice(0, 2) ?? null;
  const lines = ses.lines.filter((l) => l.qtyBase > 0).map((l) => {
    const whole = l.qtyBase % l.multiplier === 0;
    const multiplier = whole ? l.multiplier : 1;
    return {
      sesId, itemId: l.itemId, itemCode: codes.get(l.itemId) ?? "", itemName: l.itemName, uom: whole ? (poLine?.uom ?? l.baseUom) : l.baseUom, multiplier,
      qtyPacks: l.qtyBase / multiplier, ratePaise: whole ? l.ratePaise : Math.round(l.ratePaise / l.multiplier), gstRateBps: 0, expectedBase: l.qtyBase,
    };
  });
  const gst = new Map((await db.select({ itemId: storesServiceEntryLines.itemId, g: storesServiceEntryLines.gstRateBps }).from(storesServiceEntryLines)
    .where(eq(storesServiceEntryLines.sesId, sesId))).map((r) => [r.itemId, r.g] as const));
  for (const l of lines) l.gstRateBps = gst.get(l.itemId) ?? 0;
  const expectedTotalPaise = ses.lines.reduce((s, l) => {
    const taxable = Math.round((l.qtyBase * l.ratePaise) / l.multiplier);
    return s + taxable + lineGstPaise(taxable, gst.get(l.itemId) ?? 0);
  }, 0);
  return {
    vendorId: ses.vendorId, vendorName: ses.vendorName, vendorGstin: v!.gstin, sesId, sesNo: ses.sesNo, purchaseOrderId: ses.purchaseOrderId, poNo: ses.poNo,
    vendorBillNo: "", billDate: ses.period.end, interState: vendorState !== null && opts.hospitalStateCode != null && vendorState !== opts.hospitalStateCode,
    lines, expectedTotalPaise,
  };
}

/** The reader materials matches a service bill against (decision 3): PO × SES × bill. Reversed sheets are left out. */
async function sesLines(db: Db | Tx, sesIds: readonly string[], opts: { lock: boolean }): Promise<ServiceEntryLine[]> {
  if (sesIds.length === 0) return [];
  const q = ex(db).select().from(storesServiceEntries).where(and(inArray(storesServiceEntries.id, [...sesIds]), isNull(storesServiceEntries.reversesId)));
  const heads = opts.lock ? await q.for("update") : await q;
  const reversedBy = await ex(db).select({ r: storesServiceEntries.reversesId }).from(storesServiceEntries).where(inArray(storesServiceEntries.reversesId, [...sesIds]));
  const gone = new Set(reversedBy.map((r) => r.r));
  const live = heads.filter((h) => !gone.has(h.id));
  if (live.length === 0) return [];
  const lines = await ex(db).select().from(storesServiceEntryLines).where(inArray(storesServiceEntryLines.sesId, live.map((h) => h.id))).orderBy(desc(storesServiceEntryLines.id));
  return lines.map((l) => {
    const h = live.find((x) => x.id === l.sesId)!;
    return {
      sesId: h.id, sesNo: h.sesNo, vendorId: h.vendorId, purchaseOrderId: h.purchaseOrderId, itemId: l.itemId, acceptedBase: l.qtyBase,
      ratePaise: l.ratePaise, multiplier: l.multiplier, gstRateBps: l.gstRateBps,
      acceptanceDay: h.periodKind === "term_start" ? h.periodStart : h.periodEnd,
    };
  });
}

registerServiceEntrySource({ lines: sesLines });
