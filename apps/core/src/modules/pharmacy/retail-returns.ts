import { eq } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { invoices, pharmacyRetailSaleLines, pharmacyRetailSales } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withIdempotency } from "../billing";
import { RETAIL_RETURN_REF_TYPE } from "./config";
import { PharmacyError } from "./errors";
import { retailLineReturned } from "./events";
import { PHARMACY_IDEMPOTENT_ROUTES } from "./pharmacy-http";
import { getRetailSale, requirePermission } from "./retail";
import { judgeReturnAct, judgeReturnLines, requireReturnTaker, restockAndRefund } from "./returns";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RetailSaleView } from "./retail";
import type { ReturnInput } from "./returns";

/**
 * ═══ PHARMACY P19b — A SEALED PACK COMES BACK TO THE WALK-IN COUNTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p19b-retail-returns.md`. The counter's
 * P6 policy (doc 16 O-7), clause for clause, on a `pharmacy_retail_sales` row: a walk-in sale, or a
 * paper dispense entered after an outage (P20), at either counter's store.
 *
 * - **The clock** runs from `sold_at`, when the medicine left (for a paper dispense, the time on the
 *   sheet).
 * - **The pack goes back where it came from**: a `return` row into the sale's own store, on the
 *   same batch, `ref_type = pharmacy_retail_return` and `ref_id` = the sale LINE. Those rows are also
 *   how "already returned" is counted. No new table.
 * - **The money** is P6's: a `refund` credit note for exactly the returned quantity, and the refund
 *   REQUESTED; billing's approval and the cashier's voucher pay it.
 * - **No licence check (RB-4).** A return sells nothing. A customer's refund does not wait on the
 *   shop's Form 20/21 renewal, and a restocked pack cannot be sold again until the licence is current.
 * - **The H1 register is not touched (RB-5).** Its row records the supply, as on the counter; the
 *   return is this event and the credit note.
 */
export type RetailReturnInput = ReturnInput;
export type RetailReturnResult = { sale: RetailSaleView; creditNoteId: string; creditNoteNo: string; refundApprovalId: string };

const SELL = "pharmacy.retail.sell";

/** The sale a bill belongs to: the customer brings the bill back, and its number finds the sale. */
export async function findRetailSaleByInvoiceNo(db: Db, actor: Actor, invoiceNo: string): Promise<RetailSaleView> {
  await requirePermission(db, actor, SELL, "finding a walk-in sale by its bill");
  const no = invoiceNo.trim();
  const [hit] = no === "" ? [] : await db.select({ id: pharmacyRetailSales.id }).from(pharmacyRetailSales)
    .innerJoin(invoices, eq(invoices.id, pharmacyRetailSales.invoiceId))
    .where(eq(invoices.invoiceNo, no));
  if (hit === undefined) throw new PharmacyError("unknown_retail_sale", `no walk-in sale or paper dispense carries bill ${no}`);
  return getRetailSale(db, actor, hit.id);
}

export async function acceptRetailReturn(
  db: Db, actor: Actor, saleId: string, input: RetailReturnInput, idempotencyKey: string | undefined, now: Date,
): Promise<RetailReturnResult> {
  const userId = await requirePermission(db, actor, SELL, "taking back a walk-in sale's pack");
  const done = await withIdempotency(db, { actorId: userId, route: PHARMACY_IDEMPOTENT_ROUTES.retailReturn, key: idempotencyKey }, { saleId, ...input }, async () => {
    const [sale] = await db.select().from(pharmacyRetailSales).where(eq(pharmacyRetailSales.id, saleId));
    if (sale === undefined) throw new PharmacyError("unknown_retail_sale", `walk-in sale ${saleId} not found`);
    await requireReturnTaker(db, actor, now);
    const reason = judgeReturnAct(input, sale.soldAt, now);
    const lines = await db.select().from(pharmacyRetailSaleLines).where(eq(pharmacyRetailSaleLines.saleId, sale.id));
    const plan = await judgeReturnLines(db, lines.map((l) => ({
      id: l.id, lineIdx: l.lineIdx, qtyBase: l.qtyBase, itemId: l.itemId, batchId: l.batchId, invoiceLineId: l.invoiceLineId,
    })), input.lines, RETAIL_RETURN_REF_TYPE, now);

    return withTx(db, async (tx) => {
      const result = await restockAndRefund(tx, actor, {
        storeId: sale.storeResourceId, refType: RETAIL_RETURN_REF_TYPE, patientId: sale.patientId, encounterId: null,
        invoiceId: sale.invoiceId, plan, reason, reasonClass: input.reasonClass, now,
      });
      await appendEvent(tx, retailLineReturned.make({
        occurredAt: now, actor, patientId: sale.patientId, correlationId: sale.id,
        payload: {
          saleId: sale.id, patientId: sale.patientId, storeResourceId: sale.storeResourceId,
          channel: sale.channel as "walk_in" | "downtime", lines: result.returned, sealedIntact: true, reason,
          reasonClass: input.reasonClass, creditNoteId: result.creditNoteId, refundApprovalId: result.refundApprovalId,
        },
      }));
      return { creditNoteId: result.creditNoteId, creditNoteNo: result.creditNoteNo, refundApprovalId: result.refundApprovalId };
    });
  }, now);
  return { sale: await getRetailSale(db, actor, saleId), ...done };
}
