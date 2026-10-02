import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { opdPrescriptions, pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { transition } from "../../kernel/workflow/instances";
import { getInvoice, issueInvoice, previewInvoice, roundTotalBy } from "../billing";
import { listGstCategories, serviceCategoriesByIds } from "../tariff";
import { effectiveRegulation, getBatch, itemUomRows } from "../materials";
import { getEncounter } from "../opd";
import { dispenseBilled } from "./events";
import { quickDeskOn } from "./settings";
import { PharmacyError } from "./errors";
import type { DispenseRow } from "./queue";
import { counterPacks, mergeBillRows } from "./bill-rows";
import { priceBatchSale } from "./price";
import type { BillRowPack, RowGroup } from "./bill-rows";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import { requireActiveSaleItem } from "./sale-items";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { IssueInvoiceInput, PricedDraft } from "../billing";
import { assertDiscountCovered, pharmacyRoundingRule, quoteDiscount, requestDiscountApproval, saleDiscountPaise } from "./discount";
import type { DiscountAsk, DiscountQuote } from "./discount";
import type { InvoiceLineInput } from "../tariff";
import type { DispenseView } from "./queue";

export type BillInput = {
  tenders: { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string }[];
  panNumber?: string;
  form60?: boolean;
  changeGivenPaise?: number;
  tags?: string[];
  /**
   * GAP A3b — what goes out unpaid, on the OWNER's granted `billing_credit_owner` approval (filed by the
   * desk through `POST /billing/credit-requests` against THIS dispense's id, the draft id below).
   */
  credit?: { reason: string; approvalId: string };
  /**
   * OWNER RULING 2026-09-30 — a % (basis points) or rupees (paise) off MRP, with a reason. Up to 10% the
   * pharmacist gives it; above, `approvalId` is the in-charge's or the owner's GRANTED approval for THIS
   * dispense and THIS discount (`discount.ts`).
   */
  discount?: DiscountAsk & { approvalId?: string };
};

type PricedLinePlan = { lineId: string; lineIdx: number; itemId: string } & PricedBatchLine;

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
    plan.push({ lineId: line.id, lineIdx: line.lineIdx, itemId: line.itemId, ...priced });
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

/** A draft line as a person reads it: a drug's main line with its pack residue folded in, and its quantity in packs. */
export type DisplayPricedLine = PricedDraft["lines"][number] & { pack: BillRowPack | null };
export type DisplayDraft = Omit<PricedDraft, "lines"> & { lines: DisplayPricedLine[] };

/**
 * ONE ROW PER DRUG (loose-MRP ruling): the residue lines `invoiceInputsOf` adds are folded into their
 * main line here — money summed, never re-priced — so no screen shows "× 1 ₹0.10" as a second
 * drug. The totals are billing's, untouched.
 */
export function displayDraft(
  draft: PricedDraft, plan: readonly { input: InvoiceLineInput; residual: InvoiceLineInput | null; itemId: string }[],
  packs: ReadonlyMap<string, RowGroup["pack"]>,
): DisplayDraft {
  const groups: RowGroup[] = plan.map((p) => ({ mainId: p.input.lineId, residueId: p.residual?.lineId ?? null, pack: packs.get(p.itemId) ?? null }));
  const rows = mergeBillRows(draft.lines.map((l) => ({
    id: l.lineId, serviceName: l.serviceName, qty: l.qty, unitPaise: l.unitPaise, grossPaise: l.grossPaise,
    discountPaise: l.discountPaise, cgstPaise: l.gst.cgstPaise, sgstPaise: l.gst.sgstPaise, netPaise: l.netPaise,
  })), groups);
  const byId = new Map(draft.lines.map((l) => [l.lineId, l]));
  return {
    ...draft,
    lines: rows.map((r) => {
      const parts = r.lineIds.map((id) => byId.get(id)!);
      const main = parts[0]!;
      return {
        ...main, grossPaise: r.grossPaise, discountPaise: r.discountPaise, netPaise: r.netPaise,
        taxableBasePaise: parts.reduce((n, x) => n + x.taxableBasePaise, 0),
        gst: { ...main.gst, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise },
        pack: r.pack,
      };
    }),
  };
}

/** OWNER RULING 2026-09-30 — the tender the cashier has chosen. A split is cash plus UPI, so it is cash. */
export type TenderKind = "cash" | "upi" | "card" | "split";
export const TENDER_KINDS = ["cash", "upi", "card", "split"] as const;

export function roundingRuleForTender(tender: TenderKind) {
  return pharmacyRoundingRule([{ mode: tender === "split" ? "cash" : tender }]);
}

/**
 * The payable under each of ruling 1's two rules, from the same raw total — so the desk switches cash ↔
 * UPI without asking again, and never computes money itself. `cash` also covers a split and the owner's
 * credit (no tender); `digital` is UPI or card alone.
 */
export type TenderPayables = { cash: { netPayablePaise: number; roundingPaise: number }; digital: { netPayablePaise: number; roundingPaise: number } };

export function tenderPayables(rawTotalPaise: number): TenderPayables {
  const cash = roundTotalBy("half_up", rawTotalPaise);
  const exact = roundTotalBy("exact", rawTotalPaise);
  return {
    cash: { netPayablePaise: cash.roundedPaise, roundingPaise: cash.roundingPaise },
    digital: { netPayablePaise: exact.roundedPaise, roundingPaise: exact.roundingPaise },
  };
}

export type BillPreview = DisplayDraft & { byTender: TenderPayables; discount: DiscountQuote | null };

/** A discount priced in a preview: the sheet has not always got its reason yet, and a preview writes nothing. */
function previewAsk(ask: DiscountAsk): DiscountAsk {
  return { ...ask, reason: ask.reason.trim() === "" ? "preview" : ask.reason };
}

/**
 * What the window shows before a rupee is taken: the priced draft, through billing's own preview —
 * rounded for `tender` (cash when unsaid) and, when the discount sheet is open, with its discount and
 * who must approve it.
 */
export async function previewDispenseBill(
  db: Db, actor: Actor, dispenseId: string, now: Date, opts: { tender?: TenderKind; discount?: DiscountAsk } = {},
): Promise<BillPreview> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "picked" && d.status !== "billed") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not picked`, { status: d.status });
  const encounter = await getEncounter(db, d.encounterId);
  if (encounter === null) throw new PharmacyError("not_found", `encounter ${d.encounterId} not found`);
  const plan = await priceLines(db, dispenseId, now);
  void actor;
  const draft = await previewInvoice(db, {
    patientId: d.patientId, encounterId: encounter.id, lines: plan.flatMap(invoiceInputsOf),
    roundingRule: roundingRuleForTender(opts.tender ?? "cash"),
    ...(opts.discount === undefined ? {} : { saleDiscount: previewAsk(opts.discount) }),
  }, now);
  return {
    ...displayDraft(draft, plan, await counterPacks(db, plan.map((p) => p.itemId))),
    byTender: tenderPayables(draft.totals.rawTotalPaise),
    discount: opts.discount === undefined ? null : quoteDiscount(opts.discount, draft.totals.grossPaise, saleDiscountPaise(draft.lines)),
  };
}

/**
 * Asks for the discount on THIS dispense: priced exactly as the bill will price it, the tier read off the
 * result, and the approval filed with that tier's approver for that amount. Only a picked dispense —
 * before the pick there is no batch, so no price and nothing to approve.
 */
export async function askDispenseDiscount(
  db: Db, actor: Actor, dispenseId: string, ask: DiscountAsk, now: Date,
): Promise<{ approvalId: string; tier: DiscountQuote["tier"]; amountPaise: number }> {
  if (ask.reason.trim() === "") throw new PharmacyError("reason_required", "a discount needs a reason the approver can read");
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "picked") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not picked`, { status: d.status });
  const preview = await previewDispenseBill(db, actor, dispenseId, now, { discount: ask });
  return requestDiscountApproval(db, actor, { draftId: d.id, patientId: d.patientId, ask, quote: preview.discount! });
}

/** The dispense's discount, priced on THIS plan's lines and judged: its quote, once the approval (if any) is checked. */
export async function judgeDispenseDiscount(
  db: Db, d: { id: string; patientId: string }, encounterId: string, lines: IssueInvoiceInput["lines"], discount: NonNullable<BillInput["discount"]>, now: Date,
): Promise<{ ask: DiscountAsk; quote: DiscountQuote }> {
  const ask: DiscountAsk = { kind: discount.kind, value: discount.value, reason: discount.reason };
  const draft = await previewInvoice(db, { patientId: d.patientId, encounterId, lines, saleDiscount: ask, roundingRule: "exact" }, now);
  const quote = quoteDiscount(ask, draft.totals.grossPaise, saleDiscountPaise(draft.lines));
  await assertDiscountCovered(db, { draftId: d.id, patientId: d.patientId, ask, quote, approvalId: discount.approvalId });
  return { ask, quote };
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
  if (await quickDeskOn(db)) return; // owner ruling 2026-10-02 — quick desk mode (`settings.ts`)
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
  const lines = plan.flatMap(invoiceInputsOf);
  const judged = input.discount === undefined ? null : await judgeDispenseDiscount(db, d, encounter.id, lines, input.discount, now);

  const invoiceInput: IssueInvoiceInput = {
    draftId: d.id,
    patientId: d.patientId,
    encounterId: encounter.id,
    lines,
    // OWNER RULING 2026-09-30 (as amended) — any cash (or no tender: the owner's credit) rounds to the nearest rupee; UPI/card alone to the paisa.
    roundingRule: pharmacyRoundingRule(input.tenders),
    ...(judged === null ? {} : { saleDiscount: judged.ask }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.tenders.length === 0 ? {} : {
      receipt: {
        tenders: input.tenders,
        ...(input.panNumber === undefined ? {} : { panNumber: input.panNumber }),
        ...(input.form60 === undefined ? {} : { form60: input.form60 }),
        ...(input.changeGivenPaise === undefined ? {} : { changeGivenPaise: input.changeGivenPaise }),
      },
    }),
    ...(input.credit === undefined ? {} : { credit: { reason: input.credit.reason, approvalId: input.credit.approvalId } }),
  };

  await withTx(db, async (tx) => {
    const result = await issueInvoice(tx as unknown as Db, actor, invoiceInput, now);
    const stored = await getInvoice(tx, result.invoiceId);
    if (stored === null) throw new PharmacyError("not_found", `invoice ${result.invoiceId} vanished inside its own transaction`);
    // The bill must carry exactly the discount that was judged (and approved): anything else rolls it all back.
    if (judged !== null) assertIssuedDiscount(stored.lines, judged.quote);
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

/** The issued invoice's sale discount, read back off its stored lines, against the judged one. */
export function assertIssuedDiscount(lines: readonly { discountPaise: number; winner: unknown }[], quote: DiscountQuote): void {
  const issued = saleDiscountPaise(lines.map((l) => ({ discountPaise: l.discountPaise, winner: l.winner as { sourceKey: string } | null })));
  if (issued !== quote.amountPaise) {
    throw new PharmacyError("discount_not_bound", `the bill priced the discount at ${String(issued)}p, not the ${String(quote.amountPaise)}p judged — price it again`, {
      issuedPaise: issued, judgedPaise: quote.amountPaise,
    });
  }
}
