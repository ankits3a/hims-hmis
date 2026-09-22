import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { opdPrescriptions, pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { transition } from "../../kernel/workflow/instances";
import { getInvoice, issueInvoice, previewInvoice } from "../billing";
import { listGstCategories, serviceCategoriesByIds } from "../tariff";
import { effectiveRegulation, getBatch, itemUomRows } from "../materials";
import { getEncounter } from "../opd";
import { dispenseBilled } from "./events";
import { PharmacyError } from "./errors";
import type { DispenseRow } from "./queue";
import { priceBatchSale } from "./price";
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

type PricedLinePlan = { lineId: string; lineIdx: number } & PricedBatchLine;

/**
 * R-1 — EVERY LINE IS PRICED FROM THE BATCH IT WAS PICKED FROM: `batchUnitPaise` (the printed MRP
 * per base unit, T0b) and `capUnitPaise` (`min(MRP, ceiling)` per base unit, Plan 15 DD11). The
 * tariff engine takes the `min` with the version's contracted price itself; which term won is read
 * back off the invoice line, never re-derived (F5: the bill is the freeze).
 */
async function priceLines(db: Db, dispenseId: string, now: Date): Promise<PricedLinePlan[]> {
  const lines = await linesOf(db, dispenseId);
  const plan: PricedLinePlan[] = [];
  const gstByCategory = await gstCategoryMap(db);
  for (const line of lines) {
    if (line.status !== "open") continue;
    if (line.itemId === null || line.batchId === null || line.qtyBase === null) {
      throw new PharmacyError("dispense_not_in_state", `line ${String(line.lineIdx + 1)} has not been picked`, { lineIdx: line.lineIdx });
    }
    const priced = await priceBatchLine(db, gstByCategory, { itemId: line.itemId, batchId: line.batchId, qtyBase: line.qtyBase }, now);
    plan.push({ lineId: line.id, lineIdx: line.lineIdx, ...priced });
  }
  if (plan.length === 0) throw new PharmacyError("nothing_to_dispense", "no open line to bill");
  return plan;
}

export type GstCategoryMap = Map<string, Awaited<ReturnType<typeof listGstCategories>>[number]>;

export async function gstCategoryMap(db: Db): Promise<GstCategoryMap> {
  return new Map((await listGstCategories(db)).map((c) => [c.category, c] as const));
}

/**
 * One line of drug, priced from the batch it leaves from. Shared by the counter's bill and the
 * walk-in sale (P19), so the two can never price a strip differently.
 *
 * PHARMACY P1: the rate each line will be taxed at is read from the same GST configuration the
 * tariff engine taxes it with, so the ceiling is converted at the rate the bill applies (L2). An
 * exempt category carries no tax, so its ceiling stands as notified.
 */
export type PricedBatchLine = {
  /** The MAIN line: `qty` in base units at the loose rate. Every reader that keys on a sale line's invoice line keys on this one. */
  input: InvoiceLineInput;
  /**
   * The LOOSE-MRP RULING's pack residue (owner, 2026-09-22), or null: only when a full pack's MRP
   * does not divide into its units (₹35.50/15 → `1 × 10` paise for one strip). It follows its main
   * line on the invoice, always immediately (`invoiceInputsOf`), and is mapped to no sale line.
   */
  residual: InvoiceLineInput | null;
  winner: "batch_mrp" | "ceiling";
  /** The ruling's amount for this quantity, before any contracted tariff undercuts it. */
  amountPaise: number;
};

export async function priceBatchLine(
  db: Db, gstByCategory: GstCategoryMap, line: { itemId: string; batchId: string; qtyBase: number }, now: Date,
): Promise<PricedBatchLine> {
  const sale = await requireActiveSaleItem(db, line.itemId);
  const batch = await getBatch(db, line.batchId);
  if (batch === undefined) throw new PharmacyError("batch_not_saleable", `batch ${line.batchId} not found`);
  const [uoms, regulation] = await Promise.all([itemUomRows(db, line.itemId), effectiveRegulation(db, line.itemId, now)]);
  const category = (await serviceCategoriesByIds(db, [sale.serviceId])).get(sale.serviceId);
  const gst = category === undefined ? undefined : gstByCategory.get(category);
  if (gst === undefined) {
    throw new PharmacyError("gst_slab_unknown", `the sale item's category "${category ?? "?"}" has no GST configuration — seed or correct it before selling`, { category: category ?? null });
  }
  const price = priceBatchSale({
    uoms, batch: { mrpPaise: batch.mrpPaise, mrpUom: batch.mrpUom },
    regulation: regulation === undefined ? null : { ceilingPaise: regulation.ceilingPaise, mrpUom: regulation.mrpUom },
    taxRateBps: gst.exempt ? 0 : gst.rateBps,
  }, line.qtyBase);
  return {
    winner: price.saleWinner,
    amountPaise: price.amountPaise,
    // P1: an MRP includes its GST (L1), so the bill carves the tax out of the price, never adds it.
    input: {
      lineId: newId(), serviceId: sale.serviceId, qty: line.qtyBase,
      batchUnitPaise: price.batchUnitPaise, capUnitPaise: price.capUnitPaise, taxInclusive: true,
    },
    residual: price.residue === null ? null : {
      lineId: newId(), serviceId: sale.serviceId, qty: price.residue.qty,
      batchUnitPaise: price.residue.unitPaise, capUnitPaise: price.residue.unitPaise, taxInclusive: true,
    },
  };
}

/** The invoice lines a priced sale line becomes: its main line, then its pack residue if it has one. */
export function invoiceInputsOf(p: { input: InvoiceLineInput; residual: InvoiceLineInput | null }): InvoiceLineInput[] {
  return p.residual === null ? [p.input] : [p.input, p.residual];
}

/**
 * The stored invoice line each priced sale line's MAIN input became, in plan order — stepping over
 * the residue lines `invoiceInputsOf` put between them. `byNo` is the invoice's lines by `lineNo`.
 */
export function mainRowsOf<R>(byNo: readonly R[], priced: readonly { residual: InvoiceLineInput | null }[]): R[] {
  const out: R[] = [];
  let at = 0;
  for (const [i, p] of priced.entries()) {
    const row = byNo[at];
    if (row === undefined) throw new PharmacyError("not_found", `invoice line ${String(i + 1)} missing`);
    out.push(row);
    at += p.residual === null ? 1 : 2;
  }
  return out;
}

/**
 * Which bound set an issued invoice line's price. Read back off the line, never re-derived (F5: the
 * bill is the freeze).
 */
export function winnerOf(
  row: { regulatedClamp: unknown; unitPaise: number }, planned: { winner: "batch_mrp" | "ceiling"; batchUnitPaise?: number | null },
): "batch_mrp" | "ceiling" | "tariff" {
  const clamp = row.regulatedClamp as { boundApplied?: string } | null;
  // `batch_mrp` from the engine with a planned `ceiling` happens only under the loose-MRP ruling: the
  // two loose rates tie, and the ceiling's AMOUNT (its pack residue) is the lower — the plan knows.
  return clamp === null ? "batch_mrp"
    : clamp.boundApplied === "batch_mrp" || clamp.boundApplied === "caller_cap" ? planned.winner
      : row.unitPaise === planned.batchUnitPaise ? "batch_mrp" : "tariff";
}

/** What the window shows before a rupee is taken: the priced draft, through billing's own preview. */
export async function previewDispenseBill(db: Db, actor: Actor, dispenseId: string, now: Date): Promise<PricedDraft> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "picked" && d.status !== "billed") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not picked`, { status: d.status });
  const encounter = await getEncounter(db, d.encounterId);
  if (encounter === null) throw new PharmacyError("not_found", `encounter ${d.encounterId} not found`);
  const plan = await priceLines(db, dispenseId, now);
  void actor;
  return previewInvoice(db, { patientId: d.patientId, encounterId: encounter.id, lines: plan.flatMap(invoiceInputsOf) }, now);
}

/**
 * THE BILL, in one transaction with the dispense: `issueInvoice(tx as unknown as Db, …)` — the lab
 * desk's documented cast (`lab/desk.ts` header): billing opens its own `withTx`, which on a `Tx`
 * is a savepoint inside ours, so invoice, receipt and the dispense's `billed` state commit or roll
 * back together. `draftId` is the DISPENSE id: a retried bill for the same dispense binds to the
 * same draft and the same approvals. The invoice carries the ENCOUNTER ID (the OPD counter's shape):
 * billing accepts a visit number too, but `encounterFeeStatuses` and `listInvoices` match by id.
 */
/**
 * ═══ FD-31 — A TRANSCRIBED PRESCRIPTION IS NOT BILLED UNTIL A PHARMACIST HAS SEEN THE SLIP ═══
 *
 * Owner ruling, 2026-09-12: *"the pharmacist will cross confirm the prescription slip (either the
 * photo capture of prescription or physical prescription slip) before generating the medicine
 * bill."*
 *
 * THE WINDOW IS THE BILL, and that is the owner's word rather than an implementation convenience.
 * The claim is too early — the patient may still be walking over — and the hand-over is too late,
 * because by then the money has been taken and a correction is a refund. The bill is the last
 * moment at which nothing has been committed.
 *
 * IT APPLIES ONLY TO A TRANSCRIPTION. On a prescription the doctor keyed themselves there is
 * nothing to cross-confirm, and demanding the ceremony anyway would teach a pharmacist to click it
 * without looking — which is how a real control decays into a habit. `transcribed_by` is the
 * discriminator, read from the prescription the dispense already points at.
 */
async function requireSlipConfirmed(db: Db, d: DispenseRow): Promise<void> {
  const rows = await db
    .select({ transcribedBy: opdPrescriptions.transcribedBy })
    .from(opdPrescriptions)
    .where(eq(opdPrescriptions.id, d.prescriptionId));
  const transcribedBy = rows[0]?.transcribedBy ?? null;
  if (transcribedBy === null) return; // the doctor keyed it; there is no slip to cross-confirm
  if (d.slipConfirmedBy === null) {
    throw new PharmacyError(
      "slip_not_confirmed",
      "this prescription was typed from the doctor's paper slip — confirm the slip against it before billing",
      { transcribedBy, prescriptionId: d.prescriptionId },
    );
  }
}

export async function billDispense(db: Db, actor: Actor, dispenseId: string, input: BillInput, now: Date): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "picked") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not picked`, { status: d.status });
  await requireSlipConfirmed(db, d);
  const encounter = await getEncounter(db, d.encounterId);
  if (encounter === null) throw new PharmacyError("not_found", `encounter ${d.encounterId} not found`);
  const plan = await priceLines(db, dispenseId, now);

  const invoiceInput: IssueInvoiceInput = {
    draftId: d.id,
    patientId: d.patientId,
    encounterId: encounter.id,
    lines: plan.flatMap(invoiceInputsOf),
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
    const rows = mainRowsOf([...stored.lines].sort((a, b) => a.lineNo - b.lineNo), plan);
    for (const [i, p] of plan.entries()) {
      const row = rows[i]!;
      const winner = winnerOf(row, { winner: p.winner, batchUnitPaise: p.input.batchUnitPaise });
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
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, encounterId: d.encounterId, invoiceId: result.invoiceId, netPaise: result.totals.netPayablePaise },
    }));
  });
  return getDispense(db, actor, d.id, now);
}
