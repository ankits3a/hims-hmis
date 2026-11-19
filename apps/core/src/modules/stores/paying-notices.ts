import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, gte, sql } from "drizzle-orm";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { istMidnightAfter } from "../../kernel/desk/waiting";
import {
  alerts, items, purchaseOrderLines, purchaseOrders, storesBillHoldSteps, storesBillHolds, storesServiceEntries, supplierBills,
} from "../../kernel/db/schema";
import { addDays } from "../materials";
import { STORES_SES_CONFIRM, holds } from "./access";
import { usersWithRole } from "./buying-common";
import { previousMonth } from "./service-entries";
import { holdersOf } from "./tickets";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S6c (#1116, spec "Notices") — "Service to confirm / सेवा की पुष्टि करें" and "MSME bill due soon / MSME बिल
 * जल्द देय", on the worker's minute sweep (`runStoresChaser`, S3's precedent: no new job name). Each notice is sent once
 * (its source key); a supplier's name and an amount never appear in a notice — a PO or bill number only.
 *
 * Service to confirm: a live service PO whose last calendar month is not confirmed, told to the confirmers
 * (`stores.ses.confirm`) AT the department that confirmed it before. DECIDED: a service PO names no department (the
 * confirmer picks the order on the screen, S6a), so a contract's FIRST month is found on "Service to confirm" by the
 * department and is not announced; from the second month on, the department that confirmed the last sheet is told.
 *
 * MSME bill due soon: an accepted, unpaid bill of an MSME supplier due within 5 days (the desk's "Due soon"), told to the
 * payment preparers and the accounts officers; when the bill has a KEPT hold (edge case 11), also the hold's keeper and
 * the owner ("HMIS never pays around a hold", so the people who can act are told).
 */
export const SERVICE_WORDS = { toConfirm: ["Service to confirm", "सेवा की पुष्टि करें"] } as const;
export const MSME_DUE_WORDS = { dueSoon: ["MSME bill due soon", "MSME बिल जल्द देय"] } as const;
export const MSME_DUE_SOON_DAYS = 5;
const PO_LIVE = ["approved", "sent", "part_received", "received"];

type Due = { userId: string; key: string; title: string; body: string; refType: string; refId: string; kind: string };

/** Send each notice once: keys already on file are skipped before any write (the minute sweep stays cheap). */
async function sendOnce(db: Db, due: readonly Due[], now: Date): Promise<number> {
  if (due.length === 0) return 0;
  const had = new Set((await db.select({ k: alerts.sourceEventId }).from(alerts).where(inArray(alerts.sourceEventId, [...new Set(due.map((d) => d.key))])))
    .map((r) => `${r.k ?? ""}`));
  const todo = due.filter((d) => !had.has(d.key));
  let n = 0;
  if (todo.length === 0) return 0;
  await withTx(db, async (tx) => {
    for (const d of todo) {
      if (await raiseNotice(tx as unknown as Db, { userId: d.userId, kind: d.kind, title: d.title, body: d.body, refType: d.refType, refId: d.refId, sourceKey: d.key, at: now })) n += 1;
    }
  });
  return n;
}

/** Live service POs whose last month is unconfirmed, each with the department that confirmed its last sheet (or none). */
export async function servicesDue(db: Db, now: Date): Promise<{ poId: string; poNo: string; departmentId: string | null; monthKey: string; since: string }[]> {
  const month = previousMonth(istDayString(now));
  const pos = await db.selectDistinct({ id: purchaseOrders.id, poNo: purchaseOrders.poNo }).from(purchaseOrders)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id)).innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
    .where(and(inArray(purchaseOrders.status, PO_LIVE), eq(items.class, "service"))).limit(500);
  if (pos.length === 0) return [];
  const sheets = await db.select({ id: storesServiceEntries.id, po: storesServiceEntries.purchaseOrderId, key: storesServiceEntries.periodKey, dept: storesServiceEntries.departmentId, rev: storesServiceEntries.reversesId, at: storesServiceEntries.confirmedAt })
    .from(storesServiceEntries).where(inArray(storesServiceEntries.purchaseOrderId, pos.map((p) => p.id))).orderBy(desc(storesServiceEntries.confirmedAt));
  const reversed = new Set(sheets.map((s) => s.rev).filter((x): x is string => x !== null));
  const live = sheets.filter((s) => s.rev === null && !reversed.has(s.id));
  return pos.filter((p) => !live.some((s) => s.po === p.id && s.key === month.key)).map((p) => ({
    poId: p.id, poNo: p.poNo, departmentId: sheets.find((s) => s.po === p.id && s.rev === null)?.dept ?? null, monthKey: month.key, since: istMidnightAfter(month.end).toISOString(),
  }));
}

export async function sendServiceToConfirm(db: Db, now: Date = new Date()): Promise<number> {
  const due: Due[] = [];
  for (const s of await servicesDue(db, now)) {
    if (s.departmentId === null) continue;
    for (const userId of await holdersOf(db, STORES_SES_CONFIRM, { departmentId: s.departmentId })) {
      due.push({
        userId, kind: "stores.services", title: SERVICE_WORDS.toConfirm[0], body: `${SERVICE_WORDS.toConfirm[1]} · ${s.poNo}`,
        refType: "stores_ses", refId: s.departmentId, key: `stores-ses-due:${s.poId}:${s.monthKey}:${userId}`,
      });
    }
  }
  return sendOnce(db, due, now);
}

/** The reader's "Service to confirm" count for the waiting line: the due POs last confirmed at a department they confirm at. */
export async function servicesDueFor(db: Db, actor: Actor, now: Date): Promise<{ n: number; since: string | null }> {
  const due = (await servicesDue(db, now)).filter((s) => s.departmentId !== null);
  const mine: typeof due = [];
  const at = new Map<string, boolean>();
  for (const s of due) {
    if (!at.has(s.departmentId!)) at.set(s.departmentId!, await holds(db, actor, STORES_SES_CONFIRM, s.departmentId!));
    if (at.get(s.departmentId!) === true) mine.push(s);
  }
  return { n: mine.length, since: mine[0]?.since ?? null };
}

/** MSME bills accepted, unpaid and due within 5 days (or today). */
export async function msmeBillsDueSoon(db: Db, now: Date): Promise<{ id: string; billNo: string; dueDate: string }[]> {
  const today = istDayString(now);
  return db.select({ id: supplierBills.id, billNo: supplierBills.billNo, dueDate: sql<string>`${supplierBills.dueDate}` }).from(supplierBills)
    .where(and(
      inArray(supplierBills.status, ["accepted", "part_paid"]), isNull(supplierBills.cancelledAt), eq(supplierBills.msme, true), isNotNull(supplierBills.dueDate),
      gte(supplierBills.dueDate, today), lte(supplierBills.dueDate, addDays(today, MSME_DUE_SOON_DAYS)), gt(supplierBills.totalPaise, supplierBills.paidPaise),
    )).orderBy(supplierBills.dueDate).limit(500);
}

export async function sendMsmeDueSoon(db: Db, now: Date = new Date()): Promise<number> {
  const bills = await msmeBillsDueSoon(db, now);
  if (bills.length === 0) return 0;
  const preparers = [...new Set([...(await holdersOf(db, "materials.payments.prepare", "hospital")), ...(await usersWithRole(db, "accounts_officer"))])];
  const owners = await usersWithRole(db, "owner");
  const kept = await db.select({ bill: storesBillHolds.billId, by: storesBillHoldSteps.by }).from(storesBillHoldSteps)
    .innerJoin(storesBillHolds, eq(storesBillHolds.id, storesBillHoldSteps.holdId))
    .where(and(eq(storesBillHoldSteps.step, "kept"), inArray(storesBillHolds.billId, bills.map((b) => b.id))));
  const due: Due[] = [];
  for (const b of bills) {
    const keepers = kept.filter((k) => k.bill === b.id).map((k) => k.by);
    const people = [...new Set([...preparers, ...(keepers.length > 0 ? [...keepers, ...owners] : [])])].sort();
    for (const userId of people) {
      due.push({
        userId, kind: "stores.pay", title: MSME_DUE_WORDS.dueSoon[0], body: `${MSME_DUE_WORDS.dueSoon[1]} · ${b.billNo}`,
        refType: "stores_pay_due", refId: b.id, key: `stores-msme-due:${b.id}:${userId}`,
      });
    }
  }
  return sendOnce(db, due, now);
}
