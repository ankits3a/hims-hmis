import { and, eq } from "drizzle-orm";
import { CANTEEN_GST_CATEGORIES, issueRentInvoiceInput, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { canteenRentInvoices } from "../../kernel/db/schema";
import { CanteenRefusal } from "./errors";
import { requireAny } from "./guard";
import { addOnTax, fyShort, gstRow, nextNo } from "./money";
import { CANTEEN_FINANCE } from "./names";
import { outletOf, parse } from "./setup";
import type { Actor, CanteenRentInvoice } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { Opts } from "./setup";

/**
 * D6 / D7 — THE CATERER'S RENT. The hospital lets the space and is the supplier: one tax invoice per caterer outlet per
 * month (issued on the 1st, forward charge), the outlet's monthly rent as the taxable value and `canteen_rent` (18%,
 * SAC 997212, the CA confirms) on top, CGST = SGST. The rent is the only caterer money in the hospital's figures.
 */
export async function issueRentInvoice(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<CanteenRentInvoice> {
  await requireAny(db, actor, CANTEEN_FINANCE);
  const input = parse(issueRentInvoiceInput, raw);
  const at = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const outlet = await outletOf(tx, input.outletId);
    if (outlet.kind !== "caterer" || outlet.monthlyRentPaise === null) throw new CanteenRefusal("not_caterer", { outletId: outlet.id });
    const dup = (await tx.select({ id: canteenRentInvoices.id }).from(canteenRentInvoices)
      .where(and(eq(canteenRentInvoices.outletId, outlet.id), eq(canteenRentInvoices.month, input.month))))[0];
    if (dup !== undefined) throw new CanteenRefusal("rent_already_issued", { invoiceId: dup.id });
    const row = await gstRow(tx, CANTEEN_GST_CATEGORIES.rent);
    const s = addOnTax(outlet.monthlyRentPaise, row.exempt ? 0 : row.rateBps);
    const fy = fyShort(at);
    const invoiceNo = `CNR/${fy}/${String(await nextNo(tx, "rent", fy)).padStart(6, "0")}`;
    const id = newId();
    await tx.insert(canteenRentInvoices).values({
      id, invoiceNo, outletId: outlet.id, month: input.month, sacCode: row.sacCode, taxablePaise: s.taxablePaise, cgstPaise: s.cgstPaise,
      sgstPaise: s.sgstPaise, totalPaise: s.netPaise, gstRateBps: row.exempt ? 0 : row.rateBps, issuedBy: actor.id, issuedAt: at,
    });
    return {
      invoiceId: id, invoiceNo, outletId: outlet.id, month: input.month, sacCode: row.sacCode, taxablePaise: s.taxablePaise, cgstPaise: s.cgstPaise,
      sgstPaise: s.sgstPaise, totalPaise: s.netPaise, gstRateBps: row.exempt ? 0 : row.rateBps, issuedAt: at.toISOString(),
    };
  });
}
