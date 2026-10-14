import { and, asc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdChargeExceptions, ipdChargeLines, ipdEmarIssues, ipdEmarReturns, services } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { BillingError, creditShare, previewInvoice } from "../billing";
import { PharmacyError, gstCategoryMap, invoiceInputsOf, priceBatchLine } from "../pharmacy";
import { TariffError, loadPricingContext } from "../tariff";
import { provenanceOf } from "./admission-core";
import { lineIsBilled } from "./bill-cover";
import { chargeException, chargeReversed } from "./charge-events";
import { evaluateDepositLadderSafely } from "./deposit-ladder";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * #787 — MEDICINES ISSUED TO THE WARD ON THE RUNNING BILL. The eMAR's `issueMed` and `returnMed` call in here, inside their
 * own transaction and under the admission's advisory lock (both take it first, `emar.ts` `lockOrderIn`), so the stock
 * movement and the money commit or roll back together.
 *
 * - ISSUE: one `ipd.pharmacy` line per issued batch (component `pharmacy`), marked with the inpatient order, the issue, the
 *   batch and the units (`qty`). THE PRICE IS THE PHARMACY COUNTER'S OWN: `priceBatchLine` (pharmacy `bill.ts` — batch MRP per
 *   base unit, the NPPA ceiling, the loose-MRP ruling, the sale item's standing discount, GST carved out of the MRP) priced
 *   by billing's `previewInvoice`, exactly as the OPD counter's bill is, at the issue instant. A pack residue (a strip
 *   whose MRP does not divide) is folded into the batch's one line, money summed, as the counter shows one row per drug.
 * - MISSING PRICE: no sale item, no MRP, no GST slab, no tariff in force, or a price of ₹0 raises a `rate_missing`
 *   exception (key `<admission>:<date>:pharmacy:<issue>.<batch>`, `error_code` = the pharmacy's / tariff's own code) and
 *   posts nothing — never ₹0 silently. The bill desk's Retry and every nightly run re-price it (`retryDrugExceptionsIn`),
 *   for the units still with the patient.
 * - RETURN (DECIDED — the shape; the money is the spec's): the lines are append-only and every reader treats a reversal as
 *   the whole line, so a return REVERSES the batch's live line and, when units stay with the patient, posts the next line of
 *   the chain (`drug_seq` + 1) for the kept units at the ORIGINAL line's price — billing's cumulative `creditShare` over
 *   the first line, so repeated returns never leak a paisa and today's MRP is never read. No edit, no delete.
 * - RETURN AFTER THE BILL: a line a settled bill took is never reversed behind the invoice — a `return_after_bill`
 *   decision goes to the bill desk naming the line and the return. Billing voids the bill (#763) and reverses the line
 *   (`reverseChargeLine` then credits exactly the returned units and re-posts the kept ones), or keeps the charge
 *   (`keepOrderCharge`) with a reason.
 * - RE-ISSUE ($ owner to confirm): `lost` / `damaged` — the replacement is charged like any issue and flagged
 *   `reissue_lost_damaged` on the bill desk; billing waives it (`reverseChargeLine`) or keeps it, with a reason.
 *   `extra_supply` is charged normally, no flag.
 * - Never charged: the patient's own medicine (no stock, no line; `emar.ts` does not call in). A give marked entered in
 *   error and a narcotic wastage change nothing here — the charge is at issue, and the unit was issued.
 * - No money leaves this file towards a nurse, a doctor or a pharmacist: the eMAR's answers and events are unchanged.
 */

type LineRow = typeof ipdChargeLines.$inferSelect;
const SOURCE = "ipd.pharmacy" as const;
const COMPONENT = "pharmacy" as const;
const RATE_REASONS = ["rate_missing", "tariff_missing"] as const;

type Amounts = { grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; netPaise: number };
type DrugPrice =
  | ({ ok: true; serviceId: string; serviceCode: string; serviceName: string; tariffVersionId: string; unitPaise: number; gstRateBps: number; gstExempt: boolean } & Amounts)
  | { ok: false; code: string };

/**
 * THE COUNTER'S PRICE for `units` of one batch: pharmacy `priceBatchLine` → billing `previewInvoice` — the two calls the OPD
 * counter's bill makes (`pharmacy/bill.ts` `previewDispenseBill`). No patient is named: a member benefit is contested ONCE,
 * by billing, when the final invoice is priced (DECIDED — a counter here would never be consumed).
 */
async function priceDrugUnits(exec: Db | Tx, line: { itemId: string; batchId: string; qtyBase: number }, at: Date): Promise<DrugPrice> {
  const db = exec as unknown as Db;
  try {
    const priced = await priceBatchLine(db, await gstCategoryMap(db), line, at);
    const draft = await previewInvoice(db, { lines: invoiceInputsOf(priced), roundingRule: "exact" }, at);
    const main = draft.lines.find((l) => l.lineId === priced.input.lineId);
    if (main === undefined) return { ok: false, code: "price_unknown" };
    const sum = (f: (l: (typeof draft.lines)[number]) => number): number => draft.lines.reduce((t, l) => t + f(l), 0);
    const grossPaise = sum((l) => l.grossPaise);
    // A price of nothing is a missing price (an MRP typed as 0) — never a silent ₹0 line.
    if (grossPaise <= 0) return { ok: false, code: "price_zero" };
    const code = (await db.select({ code: services.code }).from(services).where(eq(services.id, main.serviceId)))[0]?.code ?? main.serviceId;
    return {
      ok: true, serviceId: main.serviceId, serviceCode: code, serviceName: main.serviceName, tariffVersionId: draft.tariffVersionId,
      unitPaise: main.unitPaise, gstRateBps: main.gst.rateBps, gstExempt: main.gst.exempt,
      grossPaise, discountPaise: sum((l) => l.discountPaise), taxablePaise: sum((l) => l.taxableBasePaise),
      cgstPaise: sum((l) => l.gst.cgstPaise), sgstPaise: sum((l) => l.gst.sgstPaise), netPaise: sum((l) => l.netPaise),
    };
  } catch (e) {
    // The pharmacy's, the tariff's and billing's own refusals are a price the bill desk must fix; anything else is a fault.
    if (e instanceof PharmacyError || e instanceof TariffError || e instanceof BillingError) return { ok: false, code: e.code };
    throw e;
  }
}

const rateKey = (admissionId: string, date: string, issueId: string, batchId: string): string => `${admissionId}:${date}:${COMPONENT}:${issueId}.${batchId}`;
const reissueKey = (l: LineRow): string => `${l.admissionId}:${l.serviceDate}:${COMPONENT}:${l.id}:reissue`;
const returnKey = (l: LineRow, returnId: string): string => `${l.admissionId}:${l.serviceDate}:${COMPONENT}:${l.id}:return_billed:${returnId}`;

/** Records (or re-sees) a pharmacy exception / decision; the event goes out once, when the row is new. */
async function raise(
  tx: Tx, actor: Actor, a: AdmissionRow, x: { key: string; date: string; reason: "rate_missing" | "return_after_bill" | "reissue_lost_damaged"; serviceCode: string | null; versionId: string | null; errorCode?: string }, at: Date,
): Promise<void> {
  const fresh = await tx.insert(ipdChargeExceptions).values({
    id: newId(), key: x.key, admissionId: a.id, serviceDate: x.date, component: COMPONENT, billedClass: null, serviceCode: x.serviceCode,
    reason: x.reason, tariffVersionId: x.versionId, errorCode: x.errorCode ?? null, firstSeenAt: at, lastSeenAt: at,
  }).onConflictDoUpdate({ target: ipdChargeExceptions.key, set: { lastSeenAt: at, ...(x.errorCode === undefined ? {} : { errorCode: x.errorCode }) } })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  if (fresh[0]?.inserted !== true) return;
  await appendEvent(tx, chargeException.make({
    payload: { admissionId: a.id, serviceDate: x.date, component: COMPONENT, reason: x.reason, serviceCode: x.serviceCode, provenance: provenanceOf(actor) },
    actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
  }));
}

type DrugLine = { orderId: string; issueId: string; itemId: string; batchId: string; units: number; serviceDate: string; reissueReason: string | null };

/**
 * One issued batch on the running bill (`drug_seq` 0), or its `rate_missing` exception. `priceAt` is the issue instant; a
 * Retry prices as of it and, where no price was in force then (the tariff activated since), as of now.
 */
async function postDrugLineIn(tx: Tx, actor: Actor, a: AdmissionRow, d: DrugLine, priceAt: readonly Date[], at: Date): Promise<string | null> {
  let price: DrugPrice = { ok: false, code: "price_unknown" };
  for (const when of priceAt) {
    price = await priceDrugUnits(tx, { itemId: d.itemId, batchId: d.batchId, qtyBase: d.units }, when);
    if (price.ok) break;
  }
  const key = rateKey(a.id, d.serviceDate, d.issueId, d.batchId);
  if (!price.ok) {
    await raise(tx, actor, a, { key, date: d.serviceDate, reason: "rate_missing", serviceCode: null, versionId: null, errorCode: price.code }, at);
    return null;
  }
  const id = newId();
  const inserted = await tx.insert(ipdChargeLines).values({
    id, admissionId: a.id, patientId: a.patientId, serviceDate: d.serviceDate, component: COMPONENT, billedClass: null,
    serviceId: price.serviceId, serviceCode: price.serviceCode, serviceName: price.serviceName, tariffVersionId: price.tariffVersionId,
    qty: d.units, unitPaise: price.unitPaise, grossPaise: price.grossPaise, discountPaise: price.discountPaise, taxablePaise: price.taxablePaise,
    cgstPaise: price.cgstPaise, sgstPaise: price.sgstPaise, netPaise: price.netPaise, gstRateBps: price.gstRateBps, gstExempt: price.gstExempt,
    source: SOURCE, orderId: d.orderId, issueId: d.issueId, batchId: d.batchId, drugSeq: 0, postedBy: actor.id, postedAt: at,
  }).onConflictDoNothing().returning();
  const line = inserted[0];
  if (line === undefined) return null;
  await tx.update(ipdChargeExceptions).set({ resolvedAt: at, resolvedLineId: id }).where(and(eq(ipdChargeExceptions.key, key), isNull(ipdChargeExceptions.resolvedAt)));
  if (d.reissueReason === "lost" || d.reissueReason === "damaged") {
    await raise(tx, actor, a, { key: reissueKey(line), date: line.serviceDate, reason: "reissue_lost_damaged", serviceCode: line.serviceCode, versionId: line.tariffVersionId }, at);
  }
  return id;
}

/** The same batch picked twice is one line. */
function byBatch(batches: readonly { batchId: string; qty: number }[]): { batchId: string; qty: number }[] {
  const out = new Map<string, number>();
  for (const b of batches) out.set(b.batchId, (out.get(b.batchId) ?? 0) + b.qty);
  return [...out].map(([batchId, qty]) => ({ batchId, qty }));
}

export type DrugIssueCharge = {
  orderId: string; issueId: string; itemId: string; batches: readonly { batchId: string; qty: number }[]; reissueReason: string | null; at: Date;
};

/**
 * A ward issue's lines, in the issue's transaction under the admission lock the caller holds. Then the deposit ladder
 * re-checks (a savepoint; a failure is logged only). Answers ids only — no money goes back to the eMAR.
 */
export async function postDrugIssueChargesIn(tx: Tx, actor: Actor, a: AdmissionRow, input: DrugIssueCharge): Promise<{ posted: string[]; missing: number }> {
  const serviceDate = istDayString(input.at);
  const posted: string[] = [];
  let missing = 0;
  for (const b of byBatch(input.batches)) {
    const id = await postDrugLineIn(tx, actor, a, {
      orderId: input.orderId, issueId: input.issueId, itemId: input.itemId, batchId: b.batchId, units: b.qty, serviceDate, reissueReason: input.reissueReason,
    }, [input.at], input.at);
    if (id === null) missing += 1; else posted.push(id);
  }
  if (posted.length > 0) await evaluateDepositLadderSafely(tx as unknown as Db, a.id, input.at, "ward issue");
  return { posted, missing };
}

/** The batch's chain of lines, oldest first, and the one still live (its newest, unless that one is reversed). */
async function chainOf(tx: Tx, issueId: string, batchId: string): Promise<{ first: LineRow; live: LineRow | null } | null> {
  const chain = await tx.select().from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.issueId, issueId), eq(ipdChargeLines.batchId, batchId), eq(ipdChargeLines.source, SOURCE)))
    .orderBy(asc(ipdChargeLines.drugSeq));
  const first = chain[0];
  const last = chain.at(-1);
  if (first === undefined || last === undefined) return null;
  const reversed = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(eq(ipdChargeLines.reversalOf, last.id)))[0];
  return { first, live: reversed === undefined ? last : null };
}

async function insertReversal(tx: Tx, actor: Actor, line: LineRow, reason: string, at: Date): Promise<string> {
  const id = newId();
  await tx.insert(ipdChargeLines).values({
    ...line, id, source: "ipd.reversal", reversalOf: line.id, reason: reason.slice(0, 500),
    unitPaise: -line.unitPaise, grossPaise: -line.grossPaise, discountPaise: -line.discountPaise, taxablePaise: -line.taxablePaise,
    cgstPaise: -line.cgstPaise, sgstPaise: -line.sgstPaise, netPaise: -line.netPaise, postedBy: actor.id, postedAt: at,
  });
  await appendEvent(tx, chargeReversed.make({
    payload: { admissionId: line.admissionId, chargeLineId: line.id, reversalLineId: id, provenance: provenanceOf(actor) },
    actor, correlationId: line.admissionId, patientId: line.patientId, encounterId: line.admissionId, occurredAt: at,
  }));
  return id;
}

/**
 * The next line of a batch's chain: `keep` units at the FIRST line's price. Gross, discount and the two tax heads are the
 * first line's less billing's cumulative share for the units that went back, so any sequence of returns ends at exactly
 * the first line's amount for the units kept (and at nothing when all of it came back).
 */
async function insertKept(tx: Tx, actor: Actor, first: LineRow, after: LineRow, keep: number, at: Date): Promise<string> {
  const gone = creditShare({
    grossPaise: first.grossPaise, discountPaise: first.discountPaise, taxableBasePaise: first.taxablePaise, cgstPaise: first.cgstPaise,
    sgstPaise: first.sgstPaise, qty: first.qty,
  }, 0, first.qty - keep);
  // An MRP holds its GST: the patient pays the charged amount (gross less discount) to the paisa, and the tax is carved
  // OUT of it — so the taxable value is what is left, never a third independently rounded share.
  const grossPaise = first.grossPaise - gone.grossPaise;
  const discountPaise = first.discountPaise - gone.discountPaise;
  const netPaise = grossPaise - discountPaise;
  const cgstPaise = first.cgstPaise - gone.cgstPaise;
  const sgstPaise = first.sgstPaise - gone.sgstPaise;
  const id = newId();
  await tx.insert(ipdChargeLines).values({
    ...first, id, qty: keep, grossPaise, discountPaise,
    taxablePaise: netPaise - cgstPaise - sgstPaise, cgstPaise, sgstPaise, netPaise, drugSeq: (after.drugSeq ?? 0) + 1,
    reason: "units kept after a return to pharmacy", postedBy: actor.id, postedAt: at,
  });
  return id;
}

export type DrugReturnOutcome = "credited" | "billed" | "not_charged";

/**
 * Units came back to the pharmacy (the eMAR's `returnMed`, in its transaction, under the admission lock it holds). Per
 * batch: never charged (own medicine, a missing rate still open, a line billing already reversed) → nothing; the live
 * line is on a settled bill → the `return_after_bill` decision, nothing reversed; else the reversal and the kept units.
 */
export async function postDrugReturnCreditsIn(
  tx: Tx, actor: Actor, a: AdmissionRow, input: { issueId: string; returnId: string; batches: readonly { batchId: string; qty: number }[]; reason: string; at: Date },
): Promise<DrugReturnOutcome[]> {
  const out: DrugReturnOutcome[] = [];
  let credited = false;
  for (const b of byBatch(input.batches)) {
    const chain = await chainOf(tx, input.issueId, b.batchId);
    if (chain === null || chain.live === null) { out.push("not_charged"); continue; }
    const { first, live } = chain;
    if (await lineIsBilled(tx, a.id, live.id)) {
      await raise(tx, actor, a, { key: returnKey(live, input.returnId), date: live.serviceDate, reason: "return_after_bill", serviceCode: live.serviceCode, versionId: live.tariffVersionId }, input.at);
      out.push("billed");
      continue;
    }
    // Returns that waited on a bill since voided are credited with this one — their decision named this line, and
    // it is about to be reversed, so nothing would ever credit them afterwards.
    const waited = await takeWaitingReturnsIn(tx, live, input.at, "credited with a later return");
    const units = Math.min(b.qty + waited, live.qty);
    await insertReversal(tx, actor, live, `returned to pharmacy (${String(units)} of ${String(live.qty)}): ${input.reason}`, input.at);
    if (live.qty - units > 0) await insertKept(tx, actor, first, live, live.qty - units, input.at);
    credited = true;
    out.push("credited");
  }
  // A return lowers the patient-payable total: the deposit ladder re-checks (a savepoint; a failure is logged only).
  if (credited) await evaluateDepositLadderSafely(tx as unknown as Db, a.id, input.at, "ward return");
  return out;
}

/** The units of one batch a return row took back (its `batches` list). */
function unitsOf(batches: readonly { batchId: string; qty: number }[], batchId: string): number {
  return batches.filter((b) => b.batchId === batchId).reduce((t, b) => t + b.qty, 0);
}

/** Closes the `return_after_bill` decisions waiting on a line and answers the units those returns took back from its batch. */
async function takeWaitingReturnsIn(tx: Tx, line: LineRow, at: Date, note: string): Promise<number> {
  const waiting = await tx.update(ipdChargeExceptions).set({ resolvedAt: at, resolutionNote: note.slice(0, 500) }).where(and(
    eq(ipdChargeExceptions.admissionId, line.admissionId), isNull(ipdChargeExceptions.resolvedAt), eq(ipdChargeExceptions.reason, "return_after_bill"),
    like(ipdChargeExceptions.key, `%:${line.id}:return_billed:%`),
  )).returning({ key: ipdChargeExceptions.key });
  if (waiting.length === 0) return 0;
  const rows = await tx.select({ batches: ipdEmarReturns.batches }).from(ipdEmarReturns).where(inArray(ipdEmarReturns.id, waiting.map((x) => x.key.split(":").at(-1)!)));
  return rows.reduce((t, r) => t + unitsOf(r.batches, line.batchId ?? ""), 0);
}

/**
 * Billing REVERSED a pharmacy line (`reverseChargeLine`, after the reversal row is in): its open decisions close.
 * - `return_after_bill` (the bill was voided first): the returns that waited are credited now — the units they took back
 *   stay off, and the kept units are re-posted at the first line's price. Billing never credits more than came back.
 * - `reissue_lost_damaged`: the reversal IS the waiver.
 * A plain reversal with nothing waiting is the whole line off the bill.
 */
export async function settleDrugLineReversalIn(tx: Tx, actor: Actor, line: LineRow, at: Date, reason: string): Promise<void> {
  if (line.source !== SOURCE || line.issueId === null || line.batchId === null) return;
  const back = await takeWaitingReturnsIn(tx, line, at, `credited: ${reason}`);
  if (back > 0) {
    const first = (await chainOf(tx, line.issueId, line.batchId))?.first ?? line;
    if (line.qty - back > 0) await insertKept(tx, actor, first, line, line.qty - back, at);
  }
  await tx.update(ipdChargeExceptions).set({ resolvedAt: at, resolutionNote: `waived: ${reason}`.slice(0, 500) }).where(and(
    eq(ipdChargeExceptions.key, reissueKey(line)), isNull(ipdChargeExceptions.resolvedAt),
  ));
}

/** Billing KEEPS a pharmacy line (`keepOrderCharge`): its open decisions close with the reason; the line is untouched. */
export async function keepDrugLineIn(tx: Tx, line: LineRow, at: Date, note: string): Promise<number> {
  const done = await tx.update(ipdChargeExceptions).set({ resolvedAt: at, resolutionNote: note.slice(0, 500) }).where(and(
    eq(ipdChargeExceptions.admissionId, line.admissionId), isNull(ipdChargeExceptions.resolvedAt),
    inArray(ipdChargeExceptions.reason, ["return_after_bill", "reissue_lost_damaged"]), like(ipdChargeExceptions.key, `%:${line.id}:%`),
  )).returning({ id: ipdChargeExceptions.id });
  return done.length;
}

/**
 * The bill desk's Retry and every nightly run (`charges.ts` `postAdmissionCharges`, under the admission lock): an issued
 * batch whose price was missing is priced again — for the units still with the patient (issued less returned); all of it
 * back, or the patient's own medicine, closes the record with nothing to charge.
 */
export async function retryDrugExceptionsIn(tx: Tx, actor: Actor, a: AdmissionRow, at: Date): Promise<number> {
  const open = await tx.select().from(ipdChargeExceptions).where(and(
    eq(ipdChargeExceptions.admissionId, a.id), isNull(ipdChargeExceptions.resolvedAt), eq(ipdChargeExceptions.component, COMPONENT),
    inArray(ipdChargeExceptions.reason, [...RATE_REASONS]),
  ));
  let posted = 0;
  for (const x of open) {
    const [issueId, batchId] = (x.key.split(":")[3] ?? "").split(".");
    if (issueId === undefined || batchId === undefined || x.serviceDate === null) continue;
    const issue = (await tx.select().from(ipdEmarIssues).where(eq(ipdEmarIssues.id, issueId)))[0];
    if (issue === undefined) continue;
    const returns = await tx.select({ batches: ipdEmarReturns.batches }).from(ipdEmarReturns).where(eq(ipdEmarReturns.issueId, issue.id));
    const units = unitsOf(issue.batches, batchId) - returns.reduce((t, r) => t + unitsOf(r.batches, batchId), 0);
    if (issue.ownMedicine || issue.itemId === null || units <= 0) {
      await tx.update(ipdChargeExceptions).set({ resolvedAt: at, resolutionNote: "nothing left to charge" }).where(eq(ipdChargeExceptions.id, x.id));
      continue;
    }
    const id = await postDrugLineIn(tx, actor, a, {
      orderId: issue.orderId, issueId: issue.id, itemId: issue.itemId, batchId, units, serviceDate: x.serviceDate, reissueReason: issue.reissueReason,
    }, [issue.issuedAt, at], at);
    if (id !== null) posted += 1;
  }
  return posted;
}

/**
 * The final invoice prices a pharmacy line `taxInclusive` (the MRP holds its GST). Billing's engine starts a line from the
 * tariff version's price when the version carries one, so a service the version prices is handed the frozen amount as a
 * prepaid quote and every other one as its batch price — these are the services of the first kind, as of `at`.
 */
export async function versionPricedServices(db: Db | Tx, serviceIds: readonly string[], at: Date): Promise<Set<string>> {
  if (serviceIds.length === 0) return new Set();
  const items = (await loadPricingContext(db as unknown as Db, { at })).tariff.items;
  return new Set(serviceIds.filter((id) => items[id] !== undefined));
}
