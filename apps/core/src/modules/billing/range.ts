import { and, count, eq, gte, inArray, lte, notExists, sql, sum } from "drizzle-orm";
import {
  creditNotes, enteredInErrorMarks, invoiceLines, invoices, receiptTenders, receipts,
} from "../../kernel/db/schema";
import { dropEmptyBuckets } from "../../kernel/desk/range";
import type { RangeBucket, RangeCtx, RangeDimension, RangeKey } from "../../kernel/desk/range";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * PHASE STAFF-REPORTS T5 — THE MONEY, BIFURCATED.
 *
 * The owner asked for "a money collection bifurcation report". D9's axes, in order: tender mode,
 * service head, clinical department, payer, cashier session. This delivers every one billing can key
 * from its OWN tables — and names the one it cannot.
 *
 * ═══ THE MEASURES MUST MATCH `cashierDay` EXACTLY, OR T3'S PARITY TEST IS A LIE ═══
 *
 * `billing.collectedPaise` and its siblings are computed by `cashierDay`, stored per person per day,
 * and summed across months. This query must return the same numbers for the same window or the two
 * instruments disagree — which is the failure `range-parity.test.ts` exists to catch. Three things
 * `cashierDay` does that a naive rewrite would not:
 *
 *   1. **It cuts on `service_day`**, the stored IST day, never on `created_at`. The file it lives in
 *      says why: *"an `issued_at BETWEEN` window is a second and subtly different definition of the
 *      day, and it is the one that goes wrong at 23:55."*
 *   2. **It EXCLUDES entered-in-error documents.** A voided receipt is not money. This was the trap
 *      of the two — the date axis is documented and obvious, and the void filter is neither. A range
 *      query that counted voided receipts would break parity for a reason the failure output would
 *      not explain, because the numbers would simply be slightly too big.
 *   3. **It sums receipt totals, and subtracts no credit note and no refund.**
 *
 * ═══ NET IS DERIVED, NOT MEASURED — D7, CORRECTED HERE ═══
 *
 * The plan ruled that "collection is NET: gross receipts minus credit notes and refund vouchers".
 * That is right about the REPORT and wrong about the MEASURE. `billing.collectedPaise` has been
 * gross-of-live-receipts for six months of stored history, so a range query that netted refunds out
 * would disagree with the pulse **by design** — and a reconciliation test that fails deliberately is
 * worse than none, because it teaches people to ignore it.
 *
 * So the measures stay primitive and separable — `collectedPaise`, `creditedPaise` — and net is a
 * subtraction the screen and the CSV perform. It is also the better report: a hospital wants to see
 * what was refunded, not one number that has quietly absorbed it.
 *
 * ═══ WHAT THIS CANNOT KEY, AND WHY IT IS NOT FAKED ═══
 *
 * **Money by clinical DEPARTMENT and by DOCTOR is not delivered here.** A receipt has a cashier and
 * a day; an invoice adds a payer and an encounter ID. Neither carries a department, and the route
 * from `invoices.encounter_id` to a department runs through OPD's tables.
 *
 * It is reachable — billing already imports from `../opd` — but it is a real piece of work (resolve
 * the window's distinct encounters, then re-key), not a line. It is named in the plan as its own
 * task rather than approximated here, because the approximation available is to attribute a whole
 * invoice to one department, and an invoice can carry lines from several.
 */

/** Receipts answer to a cashier and a day, and to nothing else on this list. */
function receiptColumn(d: RangeDimension): PgColumn | null {
  switch (d) {
    case "userId": return receipts.receivedBy;
    case "day": return receipts.serviceDay;
    default: return null;
  }
}

/** An invoice adds the payer — `intended_payer` is where a TPA or PMJAY bill declares itself. */
function invoiceColumn(d: RangeDimension): PgColumn | null {
  switch (d) {
    case "userId": return invoices.issuedBy;
    case "day": return invoices.serviceDay;
    case "payer": return invoices.intendedPayer;
    default: return null;
  }
}

/** And a line adds the service head, denormalised onto the line at the time it was billed. */
function lineColumn(d: RangeDimension): PgColumn | null {
  return d === "serviceCategory" ? invoiceLines.category : invoiceColumn(d);
}

/**
 * THE VOID FILTER, AS AN ANTI-JOIN. `cashierDay` fetches the ids and filters in JS, which is right
 * for one cashier's one day and wrong for a year: this runs over a range. The RESULT is what parity
 * requires, not the method.
 */
function notVoided(docType: string, idColumn: PgColumn): SQL {
  return notExists(
    sql`(select 1 from ${enteredInErrorMarks}
         where ${enteredInErrorMarks.docType} = ${docType}
           and ${enteredInErrorMarks.docId} = ${idColumn})`,
  );
}

/** A NULL column is an ABSENT dimension, never the string "null". */
function keyFrom(row: Record<string, string | null>, dims: readonly RangeDimension[]): RangeKey {
  const key: RangeKey = {};
  for (const d of dims) {
    const v = row[d];
    if (v !== null && v !== undefined) key[d] = String(v);
  }
  return key;
}

/** Postgres returns `sum()` as a string (bigint), and `null` for an empty group. */
const paise = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export async function billingRange(ctx: RangeCtx): Promise<RangeBucket[]> {
  const { db, filters, groupBy } = ctx;

  /* Money has no visit type. A caller filtering by one is asking about consultations, and a receipt
   * cannot satisfy that — returning it anyway would add a number that does not answer the question. */
  if (filters.visitType !== undefined) return [];
  /* Nor a department or a doctor: see this file's header. Filtering by one must return no money
   * rather than ALL the money, which is what ignoring an unsupported filter would do. */
  if (filters.departmentId !== undefined || filters.doctorId !== undefined) return [];

  const dimsFor = (pick: (d: RangeDimension) => unknown): RangeDimension[] =>
    groupBy.filter((d) => pick(d) !== null);

  // ── receipts: the count, the money taken, and the tender split ────────────────────────────────
  const rDims = dimsFor(receiptColumn);
  const rCols = rDims.map((d) => ({ d, col: receiptColumn(d)! }));
  const receiptWhere = and(
    gte(receipts.serviceDay, filters.from),
    lte(receipts.serviceDay, filters.to),
    ...(filters.userIds !== undefined ? [inArray(receipts.receivedBy, filters.userIds)] : []),
    notVoided("receipt", receipts.id),
  );

  const receiptRows = await db
    .select({
      ...Object.fromEntries(rCols.map(({ d, col }) => [d, col])),
      n: count(),
      total: sum(receipts.totalPaise),
    } as Record<string, unknown> as { n: SQL<number>; total: SQL<string | null> })
    .from(receipts)
    .where(receiptWhere)
    .groupBy(...rCols.map((c) => c.col));

  /*
   * THE TENDER SPLIT IS GROUPED BY MODE ALWAYS, exactly as OPD groups by visit type always — one
   * query gives both the split and a total that cannot drift from it.
   */
  const tenderRows = await db
    .select({
      ...Object.fromEntries(rCols.map(({ d, col }) => [d, col])),
      mode: receiptTenders.mode,
      amount: sum(receiptTenders.amountPaise),
    } as Record<string, unknown> as { mode: SQL<string>; amount: SQL<string | null> })
    .from(receiptTenders)
    .innerJoin(receipts, eq(receiptTenders.receiptId, receipts.id))
    .where(receiptWhere)
    .groupBy(...rCols.map((c) => c.col), receiptTenders.mode);

  // ── invoices: what was billed, and to whom it was meant to go ─────────────────────────────────
  const iDims = dimsFor(invoiceColumn);
  const iCols = iDims.map((d) => ({ d, col: invoiceColumn(d)! }));
  const invoiceWhere = and(
    gte(invoices.serviceDay, filters.from),
    lte(invoices.serviceDay, filters.to),
    ...(filters.userIds !== undefined ? [inArray(invoices.issuedBy, filters.userIds)] : []),
    ...(filters.payer !== undefined ? [eq(invoices.intendedPayer, filters.payer)] : []),
    notVoided("invoice", invoices.id),
  );

  const invoiceRows = await db
    .select({
      ...Object.fromEntries(iCols.map(({ d, col }) => [d, col])),
      n: count(),
      net: sum(invoices.netPayablePaise),
    } as Record<string, unknown> as { n: SQL<number>; net: SQL<string | null> })
    .from(invoices)
    .where(invoiceWhere)
    .groupBy(...iCols.map((c) => c.col));

  // ── the service head ──────────────────────────────────────────────────────────────────────────
  const lDims = dimsFor(lineColumn);
  const lCols = lDims.map((d) => ({ d, col: lineColumn(d)! }));
  const lineRows = await db
    .select({
      ...Object.fromEntries(lCols.map(({ d, col }) => [d, col])),
      gross: sum(invoiceLines.grossPaise),
    } as Record<string, unknown> as { gross: SQL<string | null> })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .where(and(
      invoiceWhere,
      ...(filters.serviceCategory !== undefined ? [eq(invoiceLines.category, filters.serviceCategory)] : []),
    ))
    .groupBy(...lCols.map((c) => c.col));

  // ── credit notes: what came back out ──────────────────────────────────────────────────────────
  /*
   * A credit note has `issued_at` and NO `service_day`, so its IST day is computed here with the
   * house idiom (`at time zone 'Asia/Kolkata'`, as `pharmacy/queue.ts` and `ot/bill.ts` use) rather
   * than a hand-rolled offset — `ist-clock-parity.test.ts` keeps a census of those and reddens on a
   * new one.
   *
   * IT IS A SEPARATE MEASURE AND NEVER SUBTRACTED HERE. See the header: net is the reader's
   * subtraction, because `collectedPaise` is gross in six months of stored facts.
   */
  const creditIstDay = sql<string>`(${creditNotes.issuedAt} at time zone 'Asia/Kolkata')::date`;
  const cCols = groupBy
    .filter((d) => d === "userId" || d === "day")
    .map((d) => ({ d, col: d === "userId" ? (creditNotes.issuedBy as PgColumn | SQL<string>) : creditIstDay }));
  const creditRows = await db
    .select({
      ...Object.fromEntries(cCols.map(({ d, col }) => [d, col])),
      net: sum(creditNotes.netPaise),
    } as Record<string, unknown> as { net: SQL<string | null> })
    .from(creditNotes)
    .where(and(
      gte(creditIstDay, sql`${filters.from}::date`),
      lte(creditIstDay, sql`${filters.to}::date`),
      ...(filters.userIds !== undefined ? [inArray(creditNotes.issuedBy, filters.userIds)] : []),
      notVoided("credit_note", creditNotes.id),
    ))
    .groupBy(...cCols.map((c) => c.col));

  const rows = (xs: unknown[]): (Record<string, string | null> & Record<string, never>)[] =>
    xs as (Record<string, string | null> & Record<string, never>)[];

  return dropEmptyBuckets([
    ...rows(receiptRows).map((r) => ({
      key: keyFrom(r, rDims),
      measures: {
        "billing.receipts": Number((r as unknown as { n: number }).n),
        "billing.collectedPaise": paise((r as unknown as { total: unknown }).total),
      },
    })),
    ...rows(tenderRows).flatMap((r) => {
      const mode = (r as unknown as { mode: string }).mode;
      const measure = TENDER_MEASURE[mode];
      if (measure === undefined) return [];
      return [{
        key: keyFrom(r, rDims),
        measures: { [measure]: paise((r as unknown as { amount: unknown }).amount) },
      }];
    }),
    ...rows(invoiceRows).map((r) => ({
      key: keyFrom(r, iDims),
      measures: {
        "billing.invoicesIssued": Number((r as unknown as { n: number }).n),
        "billing.invoicedPaise": paise((r as unknown as { net: unknown }).net),
      },
    })),
    ...rows(lineRows).map((r) => ({
      key: keyFrom(r, lDims),
      measures: { "billing.lineGrossPaise": paise((r as unknown as { gross: unknown }).gross) },
    })),
    ...rows(creditRows).map((r) => ({
      key: keyFrom(r, cCols.map((c) => c.d)),
      measures: { "billing.creditedPaise": paise((r as unknown as { net: unknown }).net) },
    })),
  ]);
}

/** The three tender modes the desk takes. Anything else is counted in the total and not split out. */
const TENDER_MEASURE: Record<string, string | undefined> = {
  cash: "billing.cashPaise",
  upi: "billing.upiPaise",
  card: "billing.cardPaise",
};
