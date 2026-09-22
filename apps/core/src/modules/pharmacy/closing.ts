import { and, eq, inArray } from "drizzle-orm";
import { allocations, invoices, pharmacyRegH1, receiptTenders, receipts } from "../../kernel/db/schema";
import { PharmacyError } from "./errors";
import { getDispenseRow, linesOf, userNames } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ WHAT CLOSED — the approved Desk board's three boxes on the done screen ═══
 *
 * THE TICKET (what was handed over, by whom, when, and what changed on the way), THE MONEY (the
 * invoice, the receipt, the tenders and the tax inside the price) and THE REGISTERS (the Schedule
 * H1 rows this dispense wrote, and how many batches left the shelf). The shipped desk said
 * "Ramesh Paswan has their medicine. P-1 · ₹103.00 · 2 lines" and nothing else — so the one moment
 * a pharmacist can still catch a wrong batch or a missing register row showed neither.
 *
 * Read once, when the ticket is done. Every figure is read back off the rows that were written:
 * the invoice's own totals, the receipt's own tenders, the register's own rows.
 */
export type Closing = {
  ticket: {
    dispenseNo: string | null; claimedByName: string | null; claimedAt: Date | null; handedOverAt: Date | null;
    lines: number; substituted: number; declined: number;
  };
  money: {
    invoiceNo: string; netPayablePaise: number; cgstPaise: number; sgstPaise: number;
    receiptNo: string | null; changeGivenPaise: number; tenders: { mode: string; amountPaise: number; refText: string | null }[];
  } | null;
  registers: { h1Rows: number; batches: number };
};

export async function closingFor(db: Db, actor: Actor, dispenseId: string): Promise<Closing> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "handed_over" && d.status !== "billed") {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}; nothing has closed yet`, { status: d.status });
  }
  const lines = await linesOf(db, dispenseId);
  const names = await userNames(db, [d.claimedBy]);

  let money: Closing["money"] = null;
  if (d.invoiceId !== null) {
    const [inv] = await db.select({
      invoiceNo: invoices.invoiceNo, netPayablePaise: invoices.netPayablePaise,
      cgstPaise: invoices.cgstPaise, sgstPaise: invoices.sgstPaise,
    }).from(invoices).where(eq(invoices.id, d.invoiceId));
    if (inv !== undefined) {
      /* The receipt that paid THIS invoice, through the `apply` allocation that ties the two together. */
      const [paid] = await db.select({ receiptId: receipts.id, receiptNo: receipts.receiptNo, changeGivenPaise: receipts.changeGivenPaise })
        .from(allocations).innerJoin(receipts, eq(receipts.id, allocations.receiptId))
        .where(and(eq(allocations.invoiceId, d.invoiceId), eq(allocations.kind, "apply")));
      const tenders = paid === undefined ? [] : await db
        .select({ mode: receiptTenders.mode, amountPaise: receiptTenders.amountPaise, refText: receiptTenders.refText })
        .from(receiptTenders).where(eq(receiptTenders.receiptId, paid.receiptId));
      money = {
        invoiceNo: inv.invoiceNo, netPayablePaise: inv.netPayablePaise, cgstPaise: inv.cgstPaise, sgstPaise: inv.sgstPaise,
        receiptNo: paid?.receiptNo ?? null, changeGivenPaise: paid?.changeGivenPaise ?? 0, tenders,
      };
    }
  }

  const lineIds = lines.map((l) => l.id);
  const h1 = lineIds.length === 0 ? [] : await db.select({ id: pharmacyRegH1.id }).from(pharmacyRegH1)
    .where(inArray(pharmacyRegH1.dispenseLineId, lineIds));

  return {
    ticket: {
      dispenseNo: d.dispenseNo, claimedByName: names.get(d.claimedBy ?? "") ?? null, claimedAt: d.claimedAt,
      handedOverAt: d.handedOverAt, lines: lines.length,
      substituted: lines.filter((l) => l.substitutionType === "generic").length,
      declined: lines.filter((l) => l.status === "declined").length,
    },
    money,
    registers: { h1Rows: h1.length, batches: new Set(lines.map((l) => l.batchId).filter((b): b is string => b !== null)).size },
  };
}
