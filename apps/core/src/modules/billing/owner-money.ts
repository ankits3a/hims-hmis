import { and, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { monthSoFar } from "@hmis/contracts";
import type { DayRange, DrawerState, OwnerMoney, TenderSplit } from "@hmis/contracts";
import { cashierSessions, invoices, opdEncounters, receiptTenders, receipts, refundVouchers, users } from "../../kernel/db/schema";
import { enteredInErrorDocIds } from "./daily-close";
import { encounterFeeStatuses } from "./fee-status";
import { IST_OFFSET_MS, istDay } from "./time";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE OWNER'S MONEY PAGE, IN ONE READ ═══ (owner, 2026-10-09: "Money today in detail … week, month,
 * custom … today vs same weekday last week; month so far vs last month").
 *
 * COUNTS AND SUMS ONLY — no patient, no invoice or receipt number. The only names are staff: whose
 * drawer a session is. Read-only; the route holds `billing.reports.read`, the day book's own gate.
 *
 * THE SAME TWO RULES AS THE DAY BOOK (`daily-close.ts`), so a day here reconciles to it exactly:
 *   · receipts and invoices are cut on their stored `service_day`; vouchers on the IST window they
 *     were paid in;
 *   · an `entered-in-error` receipt or invoice is not a document (`enteredInErrorDocIds`).
 *
 * A DRAWER IN WORDS: `open` — not counted yet; otherwise the stored variance decides `exact`, `short`
 * or `excess`. The amount beside it is what that session's live receipts in the range took, by any
 * tender. This read is the supervisor's: a cashier never reaches it (blind count, decision 0014).
 */
const CHUNK = 5_000;
const DAY_MS = 86_400_000;

async function withoutDead<T extends { id: string }>(exec: Db | Tx, docType: string, rows: T[]): Promise<T[]> {
  const dead = new Set<string>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    for (const id of await enteredInErrorDocIds(exec, docType, rows.slice(i, i + CHUNK).map((r) => r.id))) dead.add(id);
  }
  return rows.filter((r) => !dead.has(r.id));
}

type LiveReceipt = { id: string; totalPaise: number; cashierSessionId: string };
async function liveReceipts(exec: Db | Tx, range: DayRange): Promise<LiveReceipt[]> {
  const rows = await exec.select({ id: receipts.id, totalPaise: receipts.totalPaise, cashierSessionId: receipts.cashierSessionId })
    .from(receipts).where(and(gte(receipts.serviceDay, range.from), lte(receipts.serviceDay, range.to)));
  return withoutDead(exec, "receipt", rows);
}
const total = (rows: readonly { totalPaise: number }[]): number => rows.reduce((n, r) => n + r.totalPaise, 0);

export function drawerState(status: string, variancePaise: number | null): DrawerState {
  if (status === "open" || variancePaise === null) return "open";
  return variancePaise === 0 ? "exact" : variancePaise < 0 ? "short" : "excess";
}

export async function ownerMoney(
  exec: Db | Tx, range: DayRange, compare: DayRange | null, now: Date = new Date(),
): Promise<OwnerMoney> {
  const today = istDay(now);
  const live = await liveReceipts(exec, range);

  const byMode: TenderSplit = { cash: 0, upi: 0, card: 0 };
  for (let i = 0; i < live.length; i += CHUNK) {
    const tenders = await exec.select({ mode: receiptTenders.mode, amountPaise: receiptTenders.amountPaise })
      .from(receiptTenders).where(inArray(receiptTenders.receiptId, live.slice(i, i + CHUNK).map((r) => r.id)));
    for (const t of tenders) if (t.mode === "cash" || t.mode === "upi" || t.mode === "card") byMode[t.mode] += t.amountPaise;
  }

  /* The drawers that took money in the range — and, when the range reaches today, every drawer still open. */
  const taken = new Map<string, number>();
  for (const r of live) taken.set(r.cashierSessionId, (taken.get(r.cashierSessionId) ?? 0) + r.totalPaise);
  const sessionRows = new Map<string, typeof cashierSessions.$inferSelect>();
  const ids = [...taken.keys()];
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const s of await exec.select().from(cashierSessions).where(inArray(cashierSessions.id, ids.slice(i, i + CHUNK)))) sessionRows.set(s.id, s);
  }
  if (range.to >= today) {
    for (const s of await exec.select().from(cashierSessions).where(inArray(cashierSessions.status, ["open", "closing"]))) sessionRows.set(s.id, s);
  }
  const cashierIds = [...new Set([...sessionRows.values()].map((s) => s.cashierUserId))];
  const names = cashierIds.length === 0 ? new Map<string, string>()
    : new Map((await exec.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, cashierIds))).map((u) => [u.id, u.fullName]));
  const cashiers = [...sessionRows.values()]
    .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime() || a.id.localeCompare(b.id))
    .map((s) => {
      const state = drawerState(s.status, s.variancePaise);
      return {
        name: names.get(s.cashierUserId) ?? s.cashierUserId, openedDay: istDay(s.openedAt),
        collectedPaise: taken.get(s.id) ?? 0, state, variancePaise: state === "open" ? null : s.variancePaise,
      };
    });

  const start = new Date(Date.parse(`${range.from}T00:00:00.000Z`) - IST_OFFSET_MS);
  const end = new Date(Date.parse(`${range.to}T00:00:00.000Z`) - IST_OFFSET_MS + DAY_MS);
  const vouchers = await exec.select({ amountPaise: refundVouchers.amountPaise }).from(refundVouchers)
    .where(and(eq(refundVouchers.status, "paid"), gte(refundVouchers.paidAt, start), lt(refundVouchers.paidAt, end)));

  const invoiceRows = await withoutDead(exec, "invoice", await exec.select({ id: invoices.id, discountPaise: invoices.discountPaise })
    .from(invoices).where(and(gte(invoices.serviceDay, range.from), lte(invoices.serviceDay, range.to))));

  const bypassed = await exec.select({ id: opdEncounters.id, visitType: opdEncounters.visitType }).from(opdEncounters)
    .where(and(gte(opdEncounters.serviceDate, range.from), lte(opdEncounters.serviceDate, range.to), isNotNull(opdEncounters.feeBypassBy)));
  const fee = await encounterFeeStatuses(exec, bypassed);

  const m = monthSoFar(today);
  return {
    from: range.from, to: range.to,
    collectedPaise: total(live), receipts: live.length, byMode,
    previous: compare === null ? null : { ...compare, collectedPaise: total(await liveReceipts(exec, compare)) },
    month: {
      now: { ...m.now, collectedPaise: total(await liveReceipts(exec, m.now)) },
      before: { ...m.before, collectedPaise: total(await liveReceipts(exec, m.before)) },
    },
    cashiers,
    refunds: { count: vouchers.length, amountPaise: vouchers.reduce((n, v) => n + v.amountPaise, 0) },
    discountsPaise: invoiceRows.reduce((n, r) => n + r.discountPaise, 0),
    letThroughUnpaid: bypassed.filter((e) => fee.get(e.id) === "unsettled").length,
  };
}
