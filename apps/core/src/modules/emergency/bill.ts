import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  ER_INTENTS, ER_MLC_FREE_BY_LAW, ER_OBSERVATION_BLOCK_HOURS, ER_OBSERVATION_FREE_HOURS, ER_OPEN_STATES, ER_ROAD_ACCIDENT_CAP_PAISE,
  ER_ROAD_ACCIDENT_DAYS, ER_SERVICE_CODES, erIsInFuture, newId,
} from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  erAdvances, erBills, erChargeLines, erEpisodes, erEventAccounts, erMedIssues, erMlcs, erPayerClaims, receiptTenders, receipts, services,
  stockBatches,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { issueInvoice, recordReceiptInTx } from "../billing";
import { carryErAdvanceIn, carryErLineIn } from "../ipd";
import { itemUomRows, packPriceOf, saleAmountPaise } from "../materials";
import { istDayString } from "../../kernel/approvals/cumulative";
import { getPatientSummaries } from "../patients";
import { loadPricingContext, priceInvoiceLines } from "../tariff";
import { lockEpisode, onceEr, provenanceOf, readEpisode, requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { erAdvanceTaken, erBillSettled, erEventAccountOpened, erLinesPriced, erPayerSet } from "./events";
import { ER_BILL } from "./names";
import type { Actor, ErBill, ErBillDesk, ErIntentName, ErPayerKind } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 6 (#813, decision 0076) — THE ER BILL. Money lives here and on the ER bill desk only; no clinical intent, read
 * or screen imports this file (decision 0058 — the clinical sources are scanned for money words).
 *
 * - The ER tariff's lines (0076 §1): `er.registration` at arrival and `er.physician` when the ER doctor is named — once
 *   per visit (`er_charge_lines_visit_fee_ux`); `er.observation` at departure — one line, qty = the 6-hour blocks
 *   STARTED after the first 6 hours. Drugs and consumables at the batch MRP (`priceErLines`, the `ER-DRUG` carrier
 *   service); a missing rate is re-priced from the tariff in force.
 * - The stabilisation gate (0076 §2): while the patient is IN the department, no advance and no settlement before
 *   "stabilised" (`not_stabilised`). After departure the bill settles whatever happened clinically.
 * - The split by payer (0076 §3): self — all the patient's; PM-JAY, BNSS s.397, a mass-casualty event — all the payer's;
 *   road-accident cashless — the payer's up to ₹1.5 lakh for lines within 7 days of the accident, the patient's beyond.
 *   BNSS s.397 can never leave a patient-payable line (`patient_payable_forbidden`).
 * - Settle (`settleErBill`, after departure): ONE billing invoice for the patient's share (composite healthcare supply),
 *   the ER advances applied first, the tenders on it; or DUES against a signed undertaking — the invoice HELD until paid
 *   (`holdUntilPaid`, never `credit_extended`: decision 0013). The payer's share becomes an `er_payer_claims` row: the TPA
 *   desk's seam (filed by hand, 0076 §3). An episode handed to a unit is settled by the IP bill (`rolled_to_ip`).
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

const HOUR = 3_600_000;
const OPEN: readonly string[] = ER_OPEN_STATES;

export async function erServiceId(db: Db | Tx, code: string): Promise<string | null> {
  return (await (db as Db).select({ id: services.id }).from(services).where(eq(services.code, code)))[0]?.id ?? null;
}

// ═══════════════════════════════════════════ the ER tariff's own lines ═══════════════════════════════════════════

/** Observation (0076 §1): after the first 6 hours, one block per STARTED 6 hours — 6 h 1 min is one, 12 h 1 min is two. */
export function observationBlocks(arrivedAt: Date, until: Date): number {
  const over = until.getTime() - arrivedAt.getTime() - ER_OBSERVATION_FREE_HOURS * HOUR;
  return over <= 0 ? 0 : Math.ceil(over / (ER_OBSERVATION_BLOCK_HOURS * HOUR));
}

/** One line of the ER bill: a stored ER charge line, or one of the ER tariff's own visit lines (derived, never stored). */
export type BillLine = {
  id: string; source: string; serviceId: string | null; qty: number; amountPaise: number | null; status: string; postedAt: Date;
};

/**
 * The ER tariff's own lines (0076 §1), DERIVED from the episode — never stored, so a line cannot drift from the facts:
 * ER registration (every visit but a body brought dead), the ER physician fee (once the ER doctor of record is named),
 * and observation (one line, qty = the 6-hour blocks started after the first 6, until departure or now). Their ids are
 * stable (`er-reg:<episode>` …): the IP bill carries each once at admission.
 */
export async function visitFeeLines(db: Db | Tx, e: EpisodeRow, now: Date): Promise<BillLine[]> {
  if (e.state === "brought_dead") return [];
  const until = e.departedAt ?? now;
  const out: BillLine[] = [];
  const add = async (kind: "registration" | "physician" | "observation", qty: number, at: Date) => {
    const serviceId = await erServiceId(db, ER_SERVICE_CODES[kind]);
    const amount = serviceId === null ? null : await repriceOf(db, serviceId, qty, at);
    out.push({
      id: `er-${kind}:${e.id}`, source: `er.${kind}`, serviceId, qty, amountPaise: amount, status: amount === null ? "rate_missing" : "posted", postedAt: at,
    });
  };
  await add("registration", 1, e.arrivedAt);
  if (e.doctorId !== null) await add("physician", 1, e.seenAt ?? e.arrivedAt);
  const blocks = observationBlocks(e.arrivedAt, until);
  if (blocks > 0) await add("observation", blocks, until);
  return out;
}

// ═══════════════════════════════════════════ pricing ═══════════════════════════════════════════

/**
 * A drug issue's price: for each batch taken from, its MRP for the PACK the MRP names (`mrp_uom`) spread over the base
 * units taken — whole packs at the MRP, loose units at the pack price per base unit floored (the materials loose-MRP
 * rule, `saleAmountPaise`). ER review 3 (2026-10-15): the MRP is NOT per base unit — ₹500 a box of 10 is ₹50 a vial.
 * An MRP-less batch, or an MRP in a unit the item does not have → null (the bill desk's rate-missing line).
 */
async function issueMrpPaise(tx: Db | Tx, issueId: string): Promise<number | null> {
  const issue = (await (tx as Db).select({ batches: erMedIssues.batches, itemId: erMedIssues.itemId }).from(erMedIssues).where(eq(erMedIssues.id, issueId)))[0];
  if (issue === undefined || issue.itemId === null) return null;
  const picks = issue.batches as { batchId: string; qty: number }[];
  if (picks.length === 0) return null;
  const rows = await (tx as Db).select({ id: stockBatches.id, mrp: stockBatches.mrpPaise, mrpUom: stockBatches.mrpUom }).from(stockBatches)
    .where(inArray(stockBatches.id, picks.map((p) => p.batchId)));
  const uoms = await itemUomRows(tx as Db, issue.itemId);
  let total = 0;
  for (const p of picks) {
    const b = rows.find((r) => r.id === p.batchId);
    if (b === undefined) return null;
    let pack;
    try { pack = packPriceOf(uoms, b.mrp, b.mrpUom); } catch { return null; }
    if (pack === null) return null;
    total += saleAmountPaise({ mrpPaise: pack.paise, packMultiplier: pack.baseUnits, qtyBase: p.qty }).amountPaise;
  }
  return total;
}

/** Prices what can be priced now: drugs at their batch MRP; a missing rate from the tariff in force. In the caller's transaction. */
export async function priceLinesIn(tx: Tx, e: EpisodeRow, at: Date): Promise<{ priced: number; stillMissing: number }> {
  const open = await tx.select().from(erChargeLines).where(and(
    eq(erChargeLines.episodeId, e.id), inArray(erChargeLines.status, ["rate_missing", "rate_pending"]),
  )).for("update");
  const drug = await erServiceId(tx, ER_SERVICE_CODES.drug);
  let priced = 0;
  for (const l of open) {
    let amount: number | null = null;
    let serviceId = l.serviceId;
    if (l.source === "er.issue" && l.issueId !== null) {
      amount = await issueMrpPaise(tx, l.issueId);
      serviceId = drug;
    } else if (l.serviceId !== null) {
      amount = await repriceOf(tx, l.serviceId, l.qty, at);
    }
    if (amount === null || serviceId === null) continue;
    await tx.update(erChargeLines).set({ status: "posted", amountPaise: amount, serviceId }).where(eq(erChargeLines.id, l.id));
    priced += 1;
  }
  return { priced, stillMissing: open.length - priced };
}

async function repriceOf(tx: Db | Tx, serviceId: string, qty: number, at: Date): Promise<number | null> {
  try {
    const ctx = await loadPricingContext(tx as Db, { at });
    const svc = ctx.services[serviceId];
    if (svc === undefined || !svc.active || ctx.tariff.items[serviceId] === undefined) return null;
    const [line] = priceInvoiceLines(ctx, [{ lineId: newId(), serviceId, qty: 1, supplyContext: "composite_healthcare" }]);
    return line === undefined ? null : line.netPaise * qty;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════ the split ═══════════════════════════════════════════

type Composed = {
  lines: BillLine[]; totalPaise: number; payerPaise: number; patientPaise: number; unpriced: number;
  /** The patient's share, line by line (billing's invoice lines). */
  patientLines: { line: BillLine; paise: number }[];
};

/** The bill as it stands: the visit lines and the live stored lines (not reversed, not moved), split by payer. */
export async function composeErBill(db: Db | Tx, e: EpisodeRow, now: Date = new Date()): Promise<Composed> {
  const stored = await (db as Db).select().from(erChargeLines)
    .where(and(eq(erChargeLines.episodeId, e.id), notInArray(erChargeLines.status, ["reversed", "moved"]))).orderBy(asc(erChargeLines.postedAt));
  const lines: BillLine[] = [...await visitFeeLines(db, e, now), ...stored.map((l) => ({
    id: l.id, source: l.source, serviceId: l.serviceId, qty: l.qty, amountPaise: l.amountPaise, status: l.status, postedAt: l.postedAt,
  }))].sort((x, y) => x.postedAt.getTime() - y.postedAt.getTime());
  const priced = lines.filter((l) => l.status === "posted" && l.amountPaise !== null);
  const unpriced = lines.length - priced.length;
  const payer = e.payer as ErPayerKind;
  let room = payer === "road_accident" ? (e.coverCapPaise ?? ER_ROAD_ACCIDENT_CAP_PAISE) : Number.POSITIVE_INFINITY;
  const patientLines: Composed["patientLines"] = [];
  let payerPaise = 0;
  let totalPaise = 0;
  for (const l of priced) {
    const amount = l.amountPaise!;
    totalPaise += amount;
    if (payer === "self") { patientLines.push({ line: l, paise: amount }); continue; }
    if (payer !== "road_accident") { payerPaise += amount; continue; }
    // Road accident: covered while within 7 days of the accident and under the cap; the rest is the patient's.
    const inWindow = e.coverUntil === null || l.postedAt.getTime() <= e.coverUntil.getTime();
    const covered = inWindow ? Math.min(amount, room) : 0;
    room -= covered;
    payerPaise += covered;
    if (amount - covered > 0) patientLines.push({ line: l, paise: amount - covered });
  }
  return { lines, totalPaise, payerPaise, patientPaise: totalPaise - payerPaise, unpriced, patientLines };
}

// ═══════════════════════════════════════════ set_er_payer ═══════════════════════════════════════════

async function billOf(db: Db | Tx, episodeId: string) {
  return (await (db as Db).select().from(erBills).where(eq(erBills.episodeId, episodeId)))[0];
}

export async function setErPayer(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"set_er_payer">> {
  const input: Input<"set_er_payer"> = ER_INTENTS.set_er_payer.input.parse(raw);
  await requireErPermission(db, actor, ER_BILL);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "set_er_payer", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (await billOf(tx, e.id) !== undefined) throw new ErRefusal("bill_settled");
    if ((input.payer === "pmjay" || input.payer === "road_accident") && input.schemeRef === undefined) throw new ErRefusal("payer_ref_needed");
    if (input.payer === "bnss_free") {
      const m = (await tx.select({ category: erMlcs.category }).from(erMlcs).where(eq(erMlcs.episodeId, e.id)))[0];
      if (m === undefined || !ER_MLC_FREE_BY_LAW.includes(m.category as never)) throw new ErRefusal("bnss_needs_mlc");
    }
    if (input.payer === "mci_event") {
      const acc = input.eventAccountId === undefined ? undefined
        : (await tx.select({ id: erEventAccounts.id }).from(erEventAccounts).where(eq(erEventAccounts.id, input.eventAccountId)))[0];
      if (acc === undefined) throw new ErRefusal("event_account_not_found");
    }
    const accident = input.accidentAt === undefined ? e.arrivedAt : new Date(input.accidentAt);
    const coverUntil = input.payer === "road_accident" ? new Date(accident.getTime() + ER_ROAD_ACCIDENT_DAYS * 24 * HOUR) : null;
    const coverCapPaise = input.payer === "road_accident" ? ER_ROAD_ACCIDENT_CAP_PAISE : null;
    await tx.update(erEpisodes).set({
      payer: input.payer, payerRef: input.schemeRef ?? null, coverUntil, coverCapPaise,
      eventAccountId: input.payer === "mci_event" ? input.eventAccountId! : null, updatedAt: at,
    }).where(eq(erEpisodes.id, e.id));
    await appendEvent(tx, erPayerSet.make({
      payload: { episodeId: e.id, payer: input.payer, provenance: provenanceOf(actor) }, actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { episodeId: e.id, payer: input.payer, coverCapPaise, coverUntil: coverUntil?.toISOString() ?? null };
  }), at);
}

/** BNSS s.397: an MLC of sexual assault or acid attack is free by law, whatever payer the desk recorded. */
async function freeByLaw(db: Db | Tx, episodeId: string): Promise<boolean> {
  const m = (await (db as Db).select({ category: erMlcs.category }).from(erMlcs).where(eq(erMlcs.episodeId, episodeId)))[0];
  return m !== undefined && ER_MLC_FREE_BY_LAW.includes(m.category as never);
}

/** The episode with its free-by-law status folded into the payer (the desk cannot make a BNSS case patient-payable). */
async function effective(db: Db | Tx, e: EpisodeRow): Promise<EpisodeRow> {
  return (await freeByLaw(db, e.id)) ? { ...e, payer: "bnss_free" } : e;
}

/** THE GATE: in the department and not yet stabilised → no money act (0076 §2). */
function gate(e: EpisodeRow): void {
  if (OPEN.includes(e.state) && e.stabilisedAt === null) throw new ErRefusal("not_stabilised");
}

// ═══════════════════════════════════════════ take_er_advance ═══════════════════════════════════════════

export async function takeErAdvance(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"take_er_advance">> {
  const input: Input<"take_er_advance"> = ER_INTENTS.take_er_advance.input.parse(raw);
  await requireErPermission(db, actor, ER_BILL);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "take_er_advance", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await effective(tx, await lockEpisode(tx, input.episodeId));
    gate(e);
    // ER review 3: an episode already rolled to the IP bill takes its money there (its ER advances became deposits).
    if (e.outcome === "admitted") throw new ErRefusal("rolled_to_ip", { admissionId: e.admissionId });
    if (await billOf(tx, e.id) !== undefined) throw new ErRefusal("bill_settled");
    if (e.payer === "pmjay" || e.payer === "bnss_free" || e.payer === "mci_event") throw new ErRefusal("payer_pays_nothing", { payer: e.payer });
    const receipt = await recordReceiptInTx(tx, actor, {
      patientId: e.patientId,
      tenders: [{ mode: input.tender.tender, amountPaise: input.tender.amountPaise, ...(input.tender.ref === undefined ? {} : { refText: input.tender.ref }) }],
      note: `ER advance ${e.episodeNo}; paid by ${input.payerName}`,
    }, at, { purpose: "er_advance" });
    await tx.insert(erAdvances).values({ id: newId(), episodeId: e.id, receiptId: receipt.receiptId, amountPaise: receipt.totalPaise, takenBy: actor.id, takenAt: at });
    await appendEvent(tx, erAdvanceTaken.make({
      payload: { episodeId: e.id, receiptId: receipt.receiptId, amountPaise: receipt.totalPaise, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { receiptId: receipt.receiptId, receiptNo: receipt.receiptNo, amountPaise: receipt.totalPaise };
  }), at);
}

// ═══════════════════════════════════════════ price_er_lines ═══════════════════════════════════════════

export async function priceErLines(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"price_er_lines">> {
  const input: Input<"price_er_lines"> = ER_INTENTS.price_er_lines.input.parse(raw);
  await requireErPermission(db, actor, ER_BILL);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "price_er_lines", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (await billOf(tx, e.id) !== undefined) throw new ErRefusal("bill_settled");
    const r = await priceLinesIn(tx, e, at);
    await appendEvent(tx, erLinesPriced.make({
      payload: { episodeId: e.id, priced: r.priced, stillMissing: r.stillMissing, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return r;
  }), at);
}

// ═══════════════════════════════════════════ settle_er_bill ═══════════════════════════════════════════

export async function settleErBill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"settle_er_bill">> {
  const input: Input<"settle_er_bill"> = ER_INTENTS.settle_er_bill.input.parse(raw);
  await requireErPermission(db, actor, ER_BILL);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "settle_er_bill", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await effective(tx, await lockEpisode(tx, input.episodeId));
    gate(e);
    if (OPEN.includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    if (e.outcome === "admitted") throw new ErRefusal("rolled_to_ip", { admissionId: e.admissionId });
    if (await billOf(tx, e.id) !== undefined) throw new ErRefusal("bill_settled");
    const c = await composeErBill(tx, e, at);
    if (c.unpriced > 0) throw new ErRefusal("lines_unpriced", { count: c.unpriced });
    const tendered = (input.tenders ?? []).reduce((s, t) => s + t.amountPaise, 0);
    if (e.payer === "bnss_free" && (tendered > 0 || input.settlement !== "nothing_payable")) throw new ErRefusal("patient_payable_forbidden");
    const advances = await tx.select().from(erAdvances).where(eq(erAdvances.episodeId, e.id));
    const advancePaise = advances.reduce((s, a) => s + a.amountPaise, 0);
    const lines = c.patientLines.map(({ line, paise }) => ({
      lineId: `er-${line.id}`, serviceId: line.serviceId!, qty: 1, prepaidUnitPaise: paise, supplyContext: "composite_healthcare" as const,
    }));
    if (input.settlement === "nothing_payable" && c.patientPaise > 0) throw new ErRefusal("tender_short", { patientPaise: c.patientPaise });
    const held = Math.min(advancePaise, c.patientPaise);
    const owed = c.patientPaise - held;
    if (input.settlement === "paid" && tendered < owed) throw new ErRefusal("tender_short", { owedPaise: owed, tenderedPaise: tendered });
    if (input.settlement === "dues" && input.undertaking === undefined) throw new ErRefusal("undertaking_needed");
    const duesPaise = input.settlement === "dues" ? Math.max(0, owed - tendered) : 0;
    let invoice: { invoiceId: string; invoiceNo: string } | null = null;
    if (lines.length > 0) {
      const settleFrom: { receiptId: string; amountPaise: number }[] = [];
      let left = held;
      for (const a of advances) {
        if (left <= 0) break;
        const take = Math.min(left, a.amountPaise);
        settleFrom.push({ receiptId: a.receiptId, amountPaise: take });
        left -= take;
      }
      const tenders = (input.tenders ?? []).map((t) => ({ mode: t.tender, amountPaise: t.amountPaise, ...(t.ref === undefined ? {} : { refText: t.ref }) }));
      const issued = await issueInvoice(tx as unknown as Db, actor, {
        draftId: newId(), patientId: e.patientId, lines,
        ...(settleFrom.length > 0 ? { settleFromReceipts: settleFrom } : {}),
        ...(tenders.length > 0 ? { receipt: { tenders, note: `ER bill ${e.episodeNo}` } } : {}),
        ...(duesPaise > 0 ? { holdUntilPaid: { reason: `ER dues ${e.episodeNo} — undertaking ${input.undertaking?.documentRef ?? ""}` } } : {}),
      }, at);
      invoice = { invoiceId: issued.invoiceId, invoiceNo: issued.invoiceNo };
    }
    let claimId: string | null = null;
    if (c.payerPaise > 0 || e.payer === "mci_event") {
      claimId = newId();
      await tx.insert(erPayerClaims).values({
        id: claimId, episodeId: e.id, payer: e.payer, payerRef: e.payerRef, eventAccountId: e.eventAccountId, amountPaise: c.payerPaise,
        status: "to_file", createdAt: at,
      });
    }
    const paidPaise = Math.min(tendered, owed) + held;
    await tx.insert(erBills).values({
      id: newId(), episodeId: e.id, settlement: input.settlement, payer: e.payer, totalPaise: c.totalPaise, payerPaise: c.payerPaise,
      patientPaise: c.patientPaise, paidPaise, duesPaise, invoiceId: invoice?.invoiceId ?? null, invoiceNo: invoice?.invoiceNo ?? null,
      undertaking: input.undertaking ?? null, settledBy: actor.id, settledAt: at,
    });
    await appendEvent(tx, erBillSettled.make({
      payload: { episodeId: e.id, settlement: input.settlement, duesPaise, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return {
      episodeId: e.id, invoiceNo: invoice?.invoiceNo ?? null, totalPaise: c.totalPaise, payerPaise: c.payerPaise, patientPaise: c.patientPaise,
      paidPaise, duesPaise, claimId,
    };
  }), at);
}

// ═══════════════════════════════════════════ the mass-casualty event account ═══════════════════════════════════════════

export async function openErEventAccount(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"open_er_event_account">> {
  const input: Input<"open_er_event_account"> = ER_INTENTS.open_er_event_account.input.parse(raw);
  await requireErPermission(db, actor, ER_BILL);
  const at = opts.now ?? new Date();
  if (input.startedAt !== undefined && erIsInFuture(input.startedAt, at)) throw new ErRefusal("time_in_future");
  return onceEr(db, actor, "open_er_event_account", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const id = newId();
    await tx.insert(erEventAccounts).values({ id, name: input.name, startedAt: input.startedAt === undefined ? at : new Date(input.startedAt), openedBy: actor.id, openedAt: at });
    await appendEvent(tx, erEventAccountOpened.make({ payload: { eventAccountId: id, provenance: provenanceOf(actor) }, actor, correlationId: id, occurredAt: at }));
    return { eventAccountId: id, name: input.name };
  }), at);
}

// ═══════════════════════════════════════════ reads: the ER bill desk ═══════════════════════════════════════════

async function billView(db: Db, actor: Actor, e0: EpisodeRow, now: Date): Promise<ErBill> {
  const e = await effective(db, e0);
  const c = await composeErBill(db, e, now);
  const [p] = await getPatientSummaries(db, actor, [e.patientId]);
  const settled = await billOf(db, e.id);
  const advancePaise = (await db.select().from(erAdvances).where(eq(erAdvances.episodeId, e.id))).reduce((s, a) => s + a.amountPaise, 0);
  const names = new Map((await db.select({ id: services.id, name: services.name }).from(services)
    .where(inArray(services.id, [...new Set(c.lines.flatMap((l) => (l.serviceId === null ? [] : [l.serviceId])))].concat(["-"])))).map((r) => [r.id, r.name] as const));
  return {
    episodeId: e.id, episodeNo: e.episodeNo, patientLabel: p === undefined ? "" : (p.restricted ? p.alias : p.name) ?? p.uhid, uhid: p?.uhid ?? "",
    state: e.state, outcome: e.outcome, stabilised: e.stabilisedAt !== null, payer: e.payer as ErPayerKind,
    coverCapPaise: e.coverCapPaise, coverUntil: e.coverUntil?.toISOString() ?? null,
    lines: c.lines.map((l) => ({
      lineId: l.id, source: l.source, name: l.serviceId === null ? l.source : names.get(l.serviceId) ?? l.source, qty: l.qty,
      amountPaise: l.amountPaise, status: l.status, postedAt: l.postedAt.toISOString(),
    })),
    totalPaise: c.totalPaise, payerPaise: c.payerPaise, patientPaise: c.patientPaise, advancePaise,
    balancePaise: settled === undefined ? Math.max(0, c.patientPaise - advancePaise) : settled.duesPaise, unpriced: c.unpriced,
    settled: settled === undefined ? null : {
      settlement: settled.settlement, invoiceNo: settled.invoiceNo, paidPaise: settled.paidPaise, duesPaise: settled.duesPaise, at: settled.settledAt.toISOString(),
    },
  };
}

export async function readErBill(db: Db, actor: Actor, episodeId: string, opts: Opts = {}): Promise<ErBill> {
  await requireErPermission(db, actor, ER_BILL);
  return billView(db, actor, await readEpisode(db, episodeId), opts.now ?? new Date());
}

/** The desk: departed episodes not yet settled (not handed to a unit, not brought dead), then those still in the department. */
export async function readErBillDesk(db: Db, actor: Actor, opts: Opts = {}): Promise<ErBillDesk> {
  await requireErPermission(db, actor, ER_BILL);
  const now = opts.now ?? new Date();
  const departed = await db.select().from(erEpisodes).where(and(
    eq(erEpisodes.state, "departed"), sql`${erEpisodes.outcome} is distinct from 'admitted'`,
    sql`not exists (select 1 from er_bills b where b.episode_id = ${erEpisodes.id})`,
  )).orderBy(desc(erEpisodes.departedAt)).limit(100);
  const inside = await db.select().from(erEpisodes).where(inArray(erEpisodes.state, [...ER_OPEN_STATES])).orderBy(asc(erEpisodes.arrivedAt)).limit(100);
  return {
    toSettle: await Promise.all(departed.map((e) => billView(db, actor, e, now))),
    inDepartment: await Promise.all(inside.map((e) => billView(db, actor, e, now))),
    serverNow: now.toISOString(),
  };
}

/** The TPA desk's seam (0076 §3): the payer claims still to file. */
export async function listErClaims(db: Db | Tx): Promise<(typeof erPayerClaims.$inferSelect)[]> {
  return (db as Db).select().from(erPayerClaims).where(eq(erPayerClaims.status, "to_file")).orderBy(asc(erPayerClaims.createdAt));
}

// ═══════════════════════════════════════════ roll-over to the IP bill ═══════════════════════════════════════════

/**
 * 0076 §1, spec §4.6 — at admission EVERY ER line rolls into the IP running bill with its ER service date, once: the
 * visit lines (registration, physician, observation) and the stored procedure and drug lines (drugs priced at their
 * batch MRP first) as `ipd.er` lines; the order lines go through IPD's order seam (lane 5). Each stored line is marked
 * `moved` with its IP line. In the caller's transaction (the episode locked), before the departure.
 */
export async function rollErLinesIn(tx: Tx, actor: Actor, e: EpisodeRow, admissionId: string, at: Date): Promise<number> {
  await priceLinesIn(tx, e, at);
  let carried = 0;
  for (const v of await visitFeeLines(tx, { ...e, departedAt: at }, at)) {
    if (v.serviceId === null) continue;
    await carryErLineIn(tx, actor, admissionId, { erChargeLineId: v.id, serviceId: v.serviceId, qty: v.qty, serviceDate: istDayString(v.postedAt) }, at);
    carried += 1;
  }
  // ER review 3: an issue still `rate_pending` (no MRP on its batch) rolls over too, on the drug carrier service — the IP
  // desk's rate-missing exception — never left behind on an episode that can no longer be settled in the ER.
  const drugCarrier = await erServiceId(tx, ER_SERVICE_CODES.drug);
  const stored = await tx.select().from(erChargeLines).where(and(
    eq(erChargeLines.episodeId, e.id), inArray(erChargeLines.source, ["er.issue", "er.procedure"]), inArray(erChargeLines.status, ["posted", "rate_missing", "rate_pending"]),
  )).for("update");
  for (const l of stored) {
    const serviceId = l.serviceId ?? (l.source === "er.issue" ? drugCarrier : null);
    if (serviceId === null) continue;
    const drug = l.source === "er.issue" && l.amountPaise !== null;
    const ipLine = await carryErLineIn(tx, actor, admissionId, {
      erChargeLineId: l.id, serviceId, qty: drug ? 1 : l.qty, serviceDate: istDayString(l.postedAt),
      ...(drug ? { prepaidUnitPaise: l.amountPaise! } : {}),
    }, at);
    await tx.update(erChargeLines).set({ status: "moved", movedToAdmissionId: admissionId, movedIpdLineId: ipLine }).where(eq(erChargeLines.id, l.id));
    carried += 1;
  }
  // ER review 3: every ER advance becomes a deposit of the admission (applied by the discharge bill), once.
  for (const a of await tx.select().from(erAdvances).where(eq(erAdvances.episodeId, e.id))) {
    const r = (await tx.select({ no: receipts.receiptNo }).from(receipts).where(eq(receipts.id, a.receiptId)))[0];
    const t = (await tx.select({ mode: receiptTenders.mode }).from(receiptTenders).where(eq(receiptTenders.receiptId, a.receiptId)))[0];
    await carryErAdvanceIn(tx, admissionId, {
      advanceId: a.id, receiptId: a.receiptId, receiptNo: r?.no ?? a.receiptId, amountPaise: a.amountPaise, tender: t?.mode ?? "cash",
      payerName: "ER advance", takenBy: a.takenBy, takenAt: a.takenAt,
    });
  }
  return carried;
}
