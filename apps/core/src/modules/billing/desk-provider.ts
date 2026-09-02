import { and, eq, inArray } from "drizzle-orm";
import { cashierSessions, invoices, receiptTenders, receipts } from "../../kernel/db/schema";
import { enteredInErrorDocIds } from "./daily-close";
import { liveExpectedCashPaise } from "./sessions";
import { formatPaise } from "../../kernel/report/money";
import type { TenderTotals } from "./daily-close";
import type { DeskCard, DeskProvider, DeskProviderCtx, DeskStat, ReportSection } from "../../kernel/desk/types";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 07c T2 — THE CASHIER'S OWN DAY, AND THE SPIKE (S1) THIS PHASE COULD NOT SHIP WITHOUT.
 *
 * `dayBook` sums `receipt_tenders` HOSPITAL-WIDE and takes no actor. Before this file the only
 * self-scoped screen in the entire application was `billing-session.tsx` — one cashier's open
 * drawer — and there was no way for a person to see what THEY collected on a day that is closed.
 *
 * ═══ S1: THE SLICE MUST RECONCILE TO THE DAY BOOK, OR THE REPORT IS WRONG ═══
 *
 * The reconciliation is not a nicety, it is the acceptance test: summed over every cashier, this
 * function must equal `dayBook(day).receipts.byMode` exactly. Two things make that true rather than
 * approximately true, and both are the kind of detail that silently breaks it:
 *
 *   1. **The same entered-in-error exclusion.** `enteredInErrorDocIds` is IMPORTED from
 *      `daily-close.ts` rather than re-written here. Money that was never really received cannot
 *      appear in one report and not the other, and two hand-written exclusions drift.
 *   2. **The same day grain.** `receipts.service_day` is the stored IST day, so both sides cut the
 *      day identically. A `received_at BETWEEN` window would be a second, subtly different
 *      definition of "the day" — and it is the one that goes wrong at 23:55.
 *
 * ═══ SELF-SCOPED, AND THE PERMISSION SAYS SO ═══
 *
 * `billing.session.own` — the permission that already means "your own drawer". A cashier holding it
 * sees their own collections; nothing here reads another cashier's, because the only actor in scope
 * is `ctx.actor` and there is nowhere to put a second one.
 */
type Mode = keyof TenderTotals;
const MODES: readonly Mode[] = ["cash", "upi", "card"];

export type CashierDay = {
  receipts: number;
  totalPaise: number;
  byMode: TenderTotals;
  invoicesIssued: number;
  invoicedPaise: number;
};

/** One cashier's collections for one IST day. Exported: the S1 reconciliation test sums it. */
export async function cashierDay(exec: Db | Tx, userId: string, day: string): Promise<CashierDay> {
  const receiptRows = await exec
    .select({ id: receipts.id, totalPaise: receipts.totalPaise })
    .from(receipts)
    .where(and(eq(receipts.serviceDay, day), eq(receipts.receivedBy, userId)));
  const dead = await enteredInErrorDocIds(exec, "receipt", receiptRows.map((r) => r.id));
  const live = receiptRows.filter((r) => !dead.has(r.id));

  const byMode: TenderTotals = { cash: 0, upi: 0, card: 0 };
  if (live.length > 0) {
    const tenderRows = await exec
      .select({ mode: receiptTenders.mode, amountPaise: receiptTenders.amountPaise })
      .from(receiptTenders)
      .where(inArray(receiptTenders.receiptId, live.map((r) => r.id)));
    for (const t of tenderRows) {
      if (t.mode === "cash" || t.mode === "upi" || t.mode === "card") byMode[t.mode] += t.amountPaise;
    }
  }

  const invoiceRows = await exec
    .select({ id: invoices.id, netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(and(eq(invoices.serviceDay, day), eq(invoices.issuedBy, userId)));
  const deadInvoices = await enteredInErrorDocIds(exec, "invoice", invoiceRows.map((r) => r.id));
  const liveInvoices = invoiceRows.filter((r) => !deadInvoices.has(r.id));

  return {
    receipts: live.length,
    totalPaise: live.reduce((n, r) => n + r.totalPaise, 0),
    byMode,
    invoicesIssued: liveInvoices.length,
    invoicedPaise: liveInvoices.reduce((n, r) => n + r.netPayablePaise, 0),
  };
}

/**
 * FD-1 T3 — THE DRAWER on the collections card: the session this person holds open, its float,
 * and the cash it should hold now (`liveExpectedCashPaise`, the close's own formula — D5). No
 * session open says so in words; a cashier with a drawer sees "counted at close, against this".
 */
async function drawerStats(ctx: DeskProviderCtx): Promise<DeskStat[]> {
  const open = await ctx.db.select().from(cashierSessions)
    .where(and(eq(cashierSessions.cashierUserId, ctx.actor.id), inArray(cashierSessions.status, ["open", "closing"])));
  const session = open[0];
  // DECIDED: a stat's value is a figure, never a word to translate — the open/closing state is the
  // session screen's; the tile carries the two numbers a cashier is asked about, or one dash.
  if (session === undefined) return [{ key: "desk.billing.noDrawer", value: "—", href: "/billing/session" }];
  const expected = await liveExpectedCashPaise(ctx.db, session);
  return [
    { key: "desk.billing.float", value: formatPaise(session.openingFloatPaise), href: "/billing/session" },
    { key: "desk.billing.expectedCash", value: formatPaise(expected), href: "/billing/session" },
  ];
}

async function collectionsCard(ctx: DeskProviderCtx): Promise<DeskCard> {
  const d = await cashierDay(ctx.db, ctx.actor.id, ctx.date);
  const drawer = await drawerStats(ctx);
  return {
    key: "billing.myCollections",
    band: "today",
    titleKey: "desk.billing.myCollections",
    stats: [
      { key: "desk.billing.collected", value: formatPaise(d.totalPaise), href: "/billing/session" },
      { key: "desk.billing.receipts", value: String(d.receipts), href: "/my-day" },
      /*
       * CASH IS ON ITS OWN, and that is not a layout choice. It is the only tender a person can be
       * short of at the end of a shift: UPI and card reconcile against a statement, cash reconciles
       * against a drawer somebody has to count. The figure a cashier needs at 20:00 is this one.
       */
      { key: "desk.billing.cash", value: formatPaise(d.byMode.cash), href: "/billing/session" },
      ...drawer,
    ],
  };
}

async function collectionsSection(ctx: DeskProviderCtx): Promise<ReportSection> {
  const d = await cashierDay(ctx.db, ctx.actor.id, ctx.date);
  /*
   * ONE ROW PER TENDER MODE plus a total, rather than a row per receipt. A cashier's shift report
   * is reconciled against a drawer and three settlement statements — that is four numbers, and a
   * list of ninety receipts is what the day book is for. NO PATIENT IDENTITY appears here at all,
   * which is why this section needs no aliasing: there is nobody in it.
   */
  return {
    key: "billing.myCollections",
    titleKey: "report.billing.myCollections",
    columnKeys: ["report.col.mode", "report.col.amount"],
    rows: MODES.map((m) => [`report.mode.${m}`, formatPaise(d.byMode[m])]),
    totals: ["report.col.total", formatPaise(d.byMode.cash + d.byMode.upi + d.byMode.card)],
  };
}

export const billingDeskProvider: DeskProvider = {
  key: "billing.desk",
  permission: "billing.session.own",
  load: async (ctx) => [await collectionsCard(ctx)],
  report: async (ctx) => [await collectionsSection(ctx)],
  /**
   * PLAN 07c T8 — the counters a brief can add up over six months. MONEY IS PAISE, integers, for
   * the reason the contract in `desk/types.ts` gives: a float sum of half a year of collections is
   * a rounding argument nobody can win.
   */
  facts: async (ctx) => {
    const d = await cashierDay(ctx.db, ctx.actor.id, ctx.date);
    return {
      "billing.receipts": d.receipts,
      "billing.collectedPaise": d.totalPaise,
      "billing.cashPaise": d.byMode.cash,
      "billing.upiPaise": d.byMode.upi,
      "billing.cardPaise": d.byMode.card,
      "billing.invoicesIssued": d.invoicesIssued,
      "billing.invoicedPaise": d.invoicedPaise,
    };
  },
};
