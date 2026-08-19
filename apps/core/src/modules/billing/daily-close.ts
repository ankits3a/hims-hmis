import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import {
  creditNoteLines, creditNotes, dailyCloses, enteredInErrorMarks, invoiceLines, invoices,
  receipts, receiptTenders, refundVouchers,
} from "../../kernel/db/schema";
import { listVisits } from "../opd";
import { feeServiceFor } from "./charge-rules";
import { loadBillingConfig } from "./config";
import { chargeOrphanFlagged, dayClosed } from "./events";
import { IST_OFFSET_MS, istDay } from "./time";
import type { BillingConfig } from "./config";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D9 / §11.11 — the daily close: the day book, the charge-orphan scan and the GSTR-1
 * summary. `runDailyClose` is the module's ONE unscheduled sweep (Plan 11 registers it with
 * pg-boss); `dayBook` and `gstr1Summary` serve the same numbers live to the back office.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD:
 *  1. **The claim is idempotent.** `daily_closes(day)` is taken with `ON CONFLICT DO NOTHING`, so
 *     a second run the same day appends NO second `day.closed` and NO duplicate `charge.orphan_flagged`.
 *  2. **The report layer sums STORED heads.** `gstr1Summary` folds the `cgst_paise`/`sgst_paise`
 *     the engine computed per LINE and persistence stored verbatim; it never re-applies `taxHead`
 *     to a grouped base. The two differ: the Fixture Book's b09 merges two lines of base 18875
 *     (heads 1133 each ⇒ 2266) whose merged base 37750 recomputes to 2265. Persistence has its own
 *     mutant for the same class one layer down (K18); this is K35, and they are deliberately two.
 */

/** The sweep's actor — the `workflow-timer` precedent (kernel/workflow/timers.ts). */
const DAILY_CLOSE_ACTOR: Actor = { type: "system", id: "billing-daily-close" };

const DAY_MS = 86_400_000;

/**
 * Scale seam, disclosed: `listVisits` is the OPD module's own reader (spec §4 — billing reads no
 * OPD table directly) and takes a row cap. Phase-1 OPD volume is a few hundred visits a day; a
 * hospital that outgrows this needs a paged sweep, not a bigger number.
 */
const ORPHAN_SCAN_LIMIT = 5000;

/** The UTC half-open window of an IST calendar day — the grain every timestamp column is cut on. */
function istDayWindow(day: string): { from: Date; to: Date } {
  const startMs = Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS;
  return { from: new Date(startMs), to: new Date(startMs + DAY_MS) };
}

/** Which of these documents carry an `entered-in-error` mark (the invoices.ts reader's shape). */
async function enteredInErrorDocIds(exec: Db | Tx, docType: string, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const rows = await exec
    .select({ docId: enteredInErrorMarks.docId })
    .from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, docType), inArray(enteredInErrorMarks.docId, docIds)));
  return new Set(rows.map((r) => r.docId));
}

// ---------------------------------------------------------------------------------------------
// The day book (D9)
// ---------------------------------------------------------------------------------------------

export type TenderTotals = { cash: number; upi: number; card: number };

export type DayBook = {
  day: string;
  receipts: { count: number; totalPaise: number; byMode: TenderTotals };
  degraded: { count: number; totalPaise: number }; // E-24 breakout
  invoices: { count: number; netPayablePaise: number };
  creditNotes: { count: number; netPaise: number };
  vouchersPaid: { count: number; amountPaise: number };
};

/**
 * One IST day of counter activity. Every document an `entered-in-error` mark voids is excluded:
 * money that was never really received cannot appear in the cash the drawer is reconciled against.
 * Receipts and invoices are cut on their stored `service_day` (the IST grain persistence stamps);
 * credit notes and voucher payments carry no such column and are cut on the day's UTC window.
 */
export async function dayBook(exec: Db | Tx, day: string): Promise<DayBook> {
  const { from, to } = istDayWindow(day);

  const receiptRows = await exec
    .select({ id: receipts.id, totalPaise: receipts.totalPaise, degraded: receipts.degraded })
    .from(receipts)
    .where(eq(receipts.serviceDay, day));
  const deadReceipts = await enteredInErrorDocIds(exec, "receipt", receiptRows.map((r) => r.id));
  const liveReceipts = receiptRows.filter((r) => !deadReceipts.has(r.id));

  const byMode: TenderTotals = { cash: 0, upi: 0, card: 0 };
  if (liveReceipts.length > 0) {
    const tenderRows = await exec
      .select({ mode: receiptTenders.mode, amountPaise: receiptTenders.amountPaise })
      .from(receiptTenders)
      .where(inArray(receiptTenders.receiptId, liveReceipts.map((r) => r.id)));
    for (const tender of tenderRows) {
      if (tender.mode === "cash" || tender.mode === "upi" || tender.mode === "card") {
        byMode[tender.mode] += tender.amountPaise;
      }
    }
  }
  const degradedRows = liveReceipts.filter((r) => r.degraded);

  const invoiceRows = await exec
    .select({ id: invoices.id, netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(eq(invoices.serviceDay, day));
  const deadInvoices = await enteredInErrorDocIds(exec, "invoice", invoiceRows.map((r) => r.id));
  const liveInvoices = invoiceRows.filter((r) => !deadInvoices.has(r.id));

  const creditNoteRows = await exec
    .select({ id: creditNotes.id, netPaise: creditNotes.netPaise })
    .from(creditNotes)
    .where(and(gte(creditNotes.issuedAt, from), lt(creditNotes.issuedAt, to)));
  const deadCreditNotes = await enteredInErrorDocIds(exec, "credit_note", creditNoteRows.map((r) => r.id));
  const liveCreditNotes = creditNoteRows.filter((r) => !deadCreditNotes.has(r.id));

  const voucherRows = await exec
    .select({ amountPaise: refundVouchers.amountPaise })
    .from(refundVouchers)
    .where(and(eq(refundVouchers.status, "paid"), gte(refundVouchers.paidAt, from), lt(refundVouchers.paidAt, to)));

  const sum = <T>(rows: T[], of: (row: T) => number): number => rows.reduce((total, row) => total + of(row), 0);

  return {
    day,
    receipts: { count: liveReceipts.length, totalPaise: sum(liveReceipts, (r) => r.totalPaise), byMode },
    degraded: { count: degradedRows.length, totalPaise: sum(degradedRows, (r) => r.totalPaise) },
    invoices: { count: liveInvoices.length, netPayablePaise: sum(liveInvoices, (r) => r.netPayablePaise) },
    creditNotes: { count: liveCreditNotes.length, netPaise: sum(liveCreditNotes, (r) => r.netPaise) },
    vouchersPaid: { count: voucherRows.length, amountPaise: sum(voucherRows, (r) => r.amountPaise) },
  };
}

// ---------------------------------------------------------------------------------------------
// GSTR-1 (D3's grain, one layer up)
// ---------------------------------------------------------------------------------------------

export type Gstr1Row = {
  buyerGstin: string | null; // null ⇒ the B2C bucket; a GSTIN keys its own B2B rows
  sacCode: string;
  rateBps: number;
  exempt: boolean;
  taxableBasePaise: number;
  cgstPaise: number;
  sgstPaise: number;
};

type Gstr1Fold = { taxableBasePaise: number; cgstPaise: number; sgstPaise: number };
type Gstr1Key = { buyerGstin: string | null; sacCode: string; rateBps: number; exempt: boolean };

function gstr1Key(row: Gstr1Key): string {
  return `${row.buyerGstin ?? ""}|${row.sacCode}|${row.rateBps}|${String(row.exempt)}`;
}

/**
 * Field-by-field, never `localeCompare` on the joined key: locale collation weights punctuation
 * loosely, and the B2C bucket's key begins with the separator, so the row order would depend on
 * the runner's locale. B2C (an empty GSTIN) sorts first, then each GSTIN's own rows.
 */
function gstr1Order(a: Gstr1Row, b: Gstr1Row): number {
  const gstin = [a.buyerGstin ?? "", b.buyerGstin ?? ""] as const;
  if (gstin[0] !== gstin[1]) return gstin[0] < gstin[1] ? -1 : 1;
  if (a.sacCode !== b.sacCode) return a.sacCode < b.sacCode ? -1 : 1;
  if (a.rateBps !== b.rateBps) return a.rateBps - b.rateBps;
  if (a.exempt !== b.exempt) return a.exempt ? 1 : -1;
  return 0;
}

/**
 * The period's outward supply, grouped at the GSTR-1 grain — (buyer GSTIN, sacCode, rateBps,
 * exempt) — from `from` to `to` inclusive, both IST calendar days.
 *
 * **The heads are SUMMED, never recomputed** (§15.1/§15.2 at the report layer, K35): two lines
 * that merge into one row contribute their own stored heads, and re-deriving the row's tax from
 * its merged base loses a paise on exactly the shapes the Fixture Book was built to expose.
 *
 * Credit notes NET OUT of the period they are issued in, against the group their ORIGINAL invoice
 * line belongs to — a credited line reduces the period's heads rather than rewriting an invoice
 * that is immutable by construction.
 */
export async function gstr1Summary(exec: Db | Tx, from: string, to: string): Promise<Gstr1Row[]> {
  const groups = new Map<string, Gstr1Row>();
  const fold = (key: Gstr1Key, add: Gstr1Fold, sign: 1 | -1): void => {
    const id = gstr1Key(key);
    // Built field by field: the query rows carry money columns of their own, and spreading one
    // would seed the group with a line's amounts before a single fold had been applied.
    const row = groups.get(id) ?? {
      buyerGstin: key.buyerGstin, sacCode: key.sacCode, rateBps: key.rateBps, exempt: key.exempt,
      taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
    };
    row.taxableBasePaise += sign * add.taxableBasePaise;
    row.cgstPaise += sign * add.cgstPaise;
    row.sgstPaise += sign * add.sgstPaise;
    groups.set(id, row);
  };

  const invoiceRows = await exec
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(gte(invoices.serviceDay, from), lte(invoices.serviceDay, to)));
  const deadInvoices = await enteredInErrorDocIds(exec, "invoice", invoiceRows.map((r) => r.id));
  const liveInvoiceIds = invoiceRows.map((r) => r.id).filter((id) => !deadInvoices.has(id));

  if (liveInvoiceIds.length > 0) {
    const lineRows = await exec
      .select({
        buyerGstin: invoices.buyerGstin,
        sacCode: invoiceLines.sacCode,
        rateBps: invoiceLines.rateBps,
        exempt: invoiceLines.exempt,
        taxableBasePaise: invoiceLines.taxableBasePaise,
        cgstPaise: invoiceLines.cgstPaise,
        sgstPaise: invoiceLines.sgstPaise,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(inArray(invoiceLines.invoiceId, liveInvoiceIds));
    for (const line of lineRows) fold(line, line, 1);
  }

  const window = { start: istDayWindow(from).from, end: istDayWindow(to).to };
  const creditNoteRows = await exec
    .select({ id: creditNotes.id })
    .from(creditNotes)
    .where(and(gte(creditNotes.issuedAt, window.start), lt(creditNotes.issuedAt, window.end)));
  const deadCreditNotes = await enteredInErrorDocIds(exec, "credit_note", creditNoteRows.map((r) => r.id));
  const liveCreditNoteIds = creditNoteRows.map((r) => r.id).filter((id) => !deadCreditNotes.has(id));

  if (liveCreditNoteIds.length > 0) {
    const creditRows = await exec
      .select({
        buyerGstin: invoices.buyerGstin,
        sacCode: invoiceLines.sacCode,
        rateBps: invoiceLines.rateBps,
        exempt: invoiceLines.exempt,
        taxableBasePaise: creditNoteLines.taxableBasePaise,
        cgstPaise: creditNoteLines.cgstPaise,
        sgstPaise: creditNoteLines.sgstPaise,
      })
      .from(creditNoteLines)
      .innerJoin(invoiceLines, eq(invoiceLines.id, creditNoteLines.invoiceLineId))
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(inArray(creditNoteLines.creditNoteId, liveCreditNoteIds));
    for (const line of creditRows) fold(line, line, -1);
  }

  return [...groups.values()].sort(gstr1Order);
}

// ---------------------------------------------------------------------------------------------
// The charge-orphan scan (§11.11) and the close
// ---------------------------------------------------------------------------------------------

export type ChargeOrphan = { encounterId: string; patientId: string; feeServiceId: string };

/**
 * Is this encounter's consultation fee CHARGED at all? Deliberately weaker than the gate's
 * predicate (gate.ts, which also demands settled-or-credit-extended): the sweep reports visits
 * nobody billed, not visits nobody has paid for yet — dues are a legitimate state.
 *
 * An `entered-in-error` invoice is NOT cover. Voiding the bill puts the visit back among the
 * uncharged, which is exactly the case a counter mis-key produces and the safety net exists for.
 */
async function feeCharged(exec: Db | Tx, encounterId: string, feeServiceId: string): Promise<boolean> {
  const rows = await exec
    .select({ id: invoices.id })
    .from(invoices)
    .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
    .where(and(eq(invoices.encounterId, encounterId), eq(invoiceLines.serviceId, feeServiceId)));
  const ids = [...new Set(rows.map((r) => r.id))];
  if (ids.length === 0) return false;
  const dead = await enteredInErrorDocIds(exec, "invoice", ids);
  return ids.some((id) => !dead.has(id));
}

/**
 * The day's uncharged visits (§11.11). Read from `opd_encounters` through the OPD module's own
 * `listVisits` — the same data the event log carries, on an indexed column — never from the event
 * log. Nothing here auto-charges: money is minted at the counter, and a sweep that could mint it
 * would be a far worse defect than the one it reports.
 */
async function orphanScan(db: Db, day: string, cfg: BillingConfig): Promise<ChargeOrphan[]> {
  const visits = await listVisits(db, { serviceDate: day }, ORPHAN_SCAN_LIMIT);
  const orphans: ChargeOrphan[] = [];
  for (const encounter of visits) {
    const feeServiceId = feeServiceFor(encounter, cfg.chargeRules);
    if (feeServiceId === null) continue; // revisit is FREE — there is no charge to be missing
    if (await feeCharged(db, encounter.id, feeServiceId)) continue;
    orphans.push({ encounterId: encounter.id, patientId: encounter.patientId, feeServiceId });
  }
  return orphans;
}

export type DailyCloseResult = {
  day: string;
  /** false ⇒ the day was already claimed and NOTHING was appended — no `day.closed`, no flags. */
  claimed: boolean;
  totals: DayBook;
  /** The scan's findings. Events are appended only on the run that claims the day. */
  orphans: ChargeOrphan[];
};

/**
 * The close. The claim row is taken with `ON CONFLICT DO NOTHING` inside the SAME transaction as
 * the events it authorises, so "closed twice" is not a state this module can reach: the second
 * run finds the row taken and emits nothing at all.
 */
export async function runDailyClose(db: Db, day?: string, now: Date = new Date()): Promise<DailyCloseResult> {
  const targetDay = day ?? istDay(now);
  const cfg = await loadBillingConfig(db);
  const totals = await dayBook(db, targetDay);
  const orphans = await orphanScan(db, targetDay, cfg);

  return withTx(db, async (tx) => {
    const claim = await tx
      .insert(dailyCloses)
      .values({ day: targetDay, closedAt: now, totals })
      .onConflictDoNothing({ target: dailyCloses.day })
      .returning({ day: dailyCloses.day });
    if (claim.length === 0) return { day: targetDay, claimed: false, totals, orphans };

    for (const orphan of orphans) {
      await appendEvent(tx, chargeOrphanFlagged.make({
        actor: DAILY_CLOSE_ACTOR,
        patientId: orphan.patientId,
        encounterId: orphan.encounterId,
        occurredAt: now,
        payload: {
          encounterId: orphan.encounterId,
          patientId: orphan.patientId,
          // The event catalog (T3, frozen outside this task) carries no serviceId field, so the
          // fee service the visit should have been charged for rides the reason string.
          reason: `no non-entered-in-error invoice charges fee service ${orphan.feeServiceId}`,
        },
      }));
    }
    await appendEvent(tx, dayClosed.make({
      actor: DAILY_CLOSE_ACTOR, occurredAt: now, payload: { day: targetDay, totals },
    }));
    return { day: targetDay, claimed: true, totals, orphans };
  });
}
