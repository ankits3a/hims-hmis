import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { transition } from "../../kernel/workflow/instances";
import { getInvoice, issueInvoice, previewInvoice } from "../billing";
import { effectiveRegulation, getBatch, itemUomRows } from "../materials";
import { getEncounter } from "../opd";
import { dispenseBilled } from "./events";
import { PharmacyError } from "./errors";
import { priceForBatch } from "./price";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import { requireActiveSaleItem } from "./sale-items";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { IssueInvoiceInput, PricedDraft } from "../billing";
import type { InvoiceLineInput } from "../tariff";
import type { DispenseView } from "./queue";

export type BillInput = {
  tenders: { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string }[];
  panNumber?: string;
  form60?: boolean;
  changeGivenPaise?: number;
  tags?: string[];
};

type PricedLinePlan = { lineId: string; lineIdx: number; input: InvoiceLineInput; winner: "batch_mrp" | "ceiling" };

/**
 * R-1 — EVERY LINE IS PRICED FROM THE BATCH IT WAS PICKED FROM: `batchUnitPaise` (the printed MRP
 * per base unit, T0b) and `capUnitPaise` (`min(MRP, ceiling)` per base unit, Plan 15 DD11). The
 * tariff engine takes the `min` with the version's contracted price itself; which term won is read
 * back off the invoice line, never re-derived (F5: the bill is the freeze).
 */
async function priceLines(db: Db, dispenseId: string, now: Date): Promise<PricedLinePlan[]> {
  const lines = await linesOf(db, dispenseId);
  const plan: PricedLinePlan[] = [];
  for (const line of lines) {
    if (line.status !== "open") continue;
    if (line.itemId === null || line.batchId === null || line.qtyBase === null) {
      throw new PharmacyError("dispense_not_in_state", `line ${String(line.lineIdx + 1)} has not been picked`, { lineIdx: line.lineIdx });
    }
    const sale = await requireActiveSaleItem(db, line.itemId);
    const batch = await getBatch(db, line.batchId);
    if (batch === undefined) throw new PharmacyError("batch_not_saleable", `batch ${line.batchId} not found`);
    const [uoms, regulation] = await Promise.all([itemUomRows(db, line.itemId), effectiveRegulation(db, line.itemId, now)]);
    const price = priceForBatch({
      uoms, batch: { mrpPaise: batch.mrpPaise, mrpUom: batch.mrpUom },
      regulation: regulation === undefined ? null : { ceilingPaise: regulation.ceilingPaise, mrpUom: regulation.mrpUom },
    });
    plan.push({
      lineId: line.id, lineIdx: line.lineIdx, winner: price.winner,
      input: { lineId: newId(), serviceId: sale.serviceId, qty: line.qtyBase, batchUnitPaise: price.batchUnitPaise, capUnitPaise: price.capUnitPaise },
    });
  }
  if (plan.length === 0) throw new PharmacyError("nothing_to_dispense", "no open line to bill");
  return plan;
}

/** What the window shows before a rupee is taken: the priced draft, through billing's own preview. */
export async function previewDispenseBill(db: Db, actor: Actor, dispenseId: string, now: Date): Promise<PricedDraft> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "picked" && d.status !== "billed") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not picked`, { status: d.status });
  const encounter = await getEncounter(db, d.encounterId);
  if (encounter === null) throw new PharmacyError("not_found", `encounter ${d.encounterId} not found`);
  const plan = await priceLines(db, dispenseId, now);
  void actor;
  return previewInvoice(db, { patientId: d.patientId, encounterId: encounter.id, lines: plan.map((p) => p.input) }, now);
}

/**
 * THE BILL, in one transaction with the dispense: `issueInvoice(tx as unknown as Db, …)` — the lab
 * desk's documented cast (`lab/desk.ts` header): billing opens its own `withTx`, which on a `Tx`
 * is a savepoint inside ours, so invoice, receipt and the dispense's `billed` state commit or roll
 * back together. `draftId` is the DISPENSE id: a retried bill for the same dispense binds to the
 * same draft and the same approvals. The invoice carries the ENCOUNTER ID (the OPD counter's shape):
 * billing accepts a visit number too, but `encounterFeeStatuses` and `listInvoices` match by id.
 */
export async function billDispense(db: Db, actor: Actor, dispenseId: string, input: BillInput, now: Date): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "picked") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not picked`, { status: d.status });
  const encounter = await getEncounter(db, d.encounterId);
  if (encounter === null) throw new PharmacyError("not_found", `encounter ${d.encounterId} not found`);
  const plan = await priceLines(db, dispenseId, now);

  const invoiceInput: IssueInvoiceInput = {
    draftId: d.id,
    patientId: d.patientId,
    encounterId: encounter.id,
    lines: plan.map((p) => p.input),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    receipt: {
      tenders: input.tenders,
      ...(input.panNumber === undefined ? {} : { panNumber: input.panNumber }),
      ...(input.form60 === undefined ? {} : { form60: input.form60 }),
      ...(input.changeGivenPaise === undefined ? {} : { changeGivenPaise: input.changeGivenPaise }),
    },
  };

  await withTx(db, async (tx) => {
    const result = await issueInvoice(tx as unknown as Db, actor, invoiceInput, now);
    const stored = await getInvoice(tx, result.invoiceId);
    if (stored === null) throw new PharmacyError("not_found", `invoice ${result.invoiceId} vanished inside its own transaction`);
    const byNo = [...stored.lines].sort((a, b) => a.lineNo - b.lineNo);
    for (const [i, p] of plan.entries()) {
      const row = byNo[i];
      if (row === undefined) throw new PharmacyError("not_found", `invoice line ${String(i + 1)} missing`);
      const clamp = row.regulatedClamp as { boundApplied?: string } | null;
      const winner = clamp === null || clamp.boundApplied === "batch_mrp" ? "batch_mrp"
        : clamp.boundApplied === "caller_cap" ? p.winner
          : row.unitPaise === p.input.batchUnitPaise ? "batch_mrp" : "tariff";
      await tx.update(pharmacyDispenseLines)
        .set({ invoiceLineId: row.id, unitPaise: row.unitPaise, priceWinner: winner })
        .where(eq(pharmacyDispenseLines.id, p.lineId));
    }
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "billed", invoiceId: result.invoiceId, billedAt: now })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "picked")))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while billing`);
    if (d.workflowInstanceId !== null) await transition(tx, d.workflowInstanceId, "billed", actor);
    await appendEvent(tx, dispenseBilled.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, encounterId: d.encounterId, invoiceId: result.invoiceId, netPaise: result.totals.netPayablePaise },
    }));
  });
  return getDispense(db, actor, d.id, now);
}
