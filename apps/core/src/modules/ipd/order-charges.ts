import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdAdmissions, ipdChargeExceptions, ipdChargeLines } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { BillingError, feeOffAt, loadBillingConfig, registerEpisodeChargeSink } from "../billing";
import { admissionAdvisoryLock, provenanceOf, readAdmission } from "./admission-core";
import { IPD_PLACED_STATES } from "./admission-place";
import { lineIsBilled, liveBills } from "./bill-cover";
import { chargeReversed } from "./charge-events";
import { postOrderLineIn, raiseException } from "./charges";
import { evaluateDepositLadderSafely } from "./deposit-ladder";
import { IPD_ADMISSION_NO_RE, IPD_ADMISSION_PREFIX } from "./encounter";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeChargeSink, EpisodeReverseOutcome, EpisodeStanding } from "../billing";

/**
 * #785 — LAB AND IMAGING ORDERS ON THE RUNNING BILL. An order placed on a live admission (`IP26-000123`) — from rounds
 * (`placeIpOrder`) or any other door that names the admission number (the ordering door, the lab desk, the radiology
 * desk) — is charged here, as `ipd.order` lines of `ipd_charge_lines`, and never as a held invoice: the department asks
 * billing's episode charge sink (`registerEpisodeChargeSink`, prefix `IP`) before it would issue one.
 *
 * - STANDING: `live` while the stay is placed (`IPD_PLACED_STATES`); `ended` once it is not — the department refuses a NEW
 *   order on it (a reflex test of an earlier sample still posts: the supplementary bill takes it).
 * - POSTING: one line per order item, priced from the admission's locked tariff version, marked with the department
 *   order and the order item (`charges.ts` `postOrderLineIn`). An absent item or a switched-off service is a `rate_missing`
 *   exception; an explicit ₹0 item, or a scan while the imaging fee is off (decision 0067), posts a ₹0 line.
 * - CANCELLATION (DECIDED): cancelled before the work — no sample collected (lab), the study not on the machine (imaging);
 *   the department says which (`workStarted`) — posts a REVERSAL line
 *   (never an edit or a delete). Cancelled later posts nothing: the work was done, and billing reverses with a reason
 *   through `ipd.charges.reverse` if it should not stand. A line a settled bill already took is left to billing (void the
 *   bill first, #763) — never reversed behind the invoice. An unposted item (its rate was missing) closes its exception.
 * - Nothing here refuses for money: the department's own workflow runs whatever the bill says.
 */
const LIVE: ReadonlySet<string> = new Set(IPD_PLACED_STATES);

async function admissionByNo(exec: Db | Tx, encounterNo: string): Promise<{ id: string; state: string } | undefined> {
  if (!IPD_ADMISSION_NO_RE.test(encounterNo)) return undefined;
  return (await (exec as Db).select({ id: ipdAdmissions.id, state: ipdAdmissions.state })
    .from(ipdAdmissions).where(eq(ipdAdmissions.admissionNo, encounterNo)))[0];
}

export async function ipdOrderStanding(exec: Db | Tx, encounterNo: string): Promise<EpisodeStanding> {
  const a = await admissionByNo(exec, encounterNo);
  if (a === undefined) return null;
  return LIVE.has(a.state) ? "live" : "ended";
}

/**
 * Review of 47cd79f5 (item 11, LOCK ORDER): every door takes the ADMISSION's advisory lock first — before it writes a row of
 * its own — and reads the standing under it, the order the admission's own acts use (rounds `lockAdmission`, discharge,
 * the nightly posting). Re-entrant on the same transaction.
 */
export async function lockIpdOrderStanding(tx: Tx, encounterNo: string): Promise<EpisodeStanding> {
  const pre = await admissionByNo(tx, encounterNo);
  if (pre === undefined) return null;
  await admissionAdvisoryLock(tx, pre.id);
  return ipdOrderStanding(tx, encounterNo);
}

/** Decision 0067: was the imaging fee switched off at this instant? An unconfigured billing module charges. */
async function imagingFreeAtOrder(exec: Db | Tx, at: Date): Promise<boolean> {
  try {
    return feeOffAt((await loadBillingConfig(exec as Db)).chargeRules, "imaging", at);
  } catch (e) {
    if (e instanceof BillingError) return false;
    throw e;
  }
}

export type IpdOrderPostResult = { posted: string[]; supplementary: boolean };

/**
 * Posts the order's lines under the admission lock (review item 6: the standing and the bills are re-read UNDER the lock).
 * An order the department accepted is always posted — an admission that ended, or settled its final bill, between the
 * department's check and this lock gets the lines all the same, and they are the SUPPLEMENTARY bill's (`supplementary`:
 * a live bill exists, so `bill-cover.ts` leaves these lines to the next bill). Then the deposit ladder re-checks (caught).
 */
export async function postIpdOrderCharges(
  tx: Tx, actor: Actor, input: { encounterNo: string; department: "lab" | "imaging"; items: readonly { orderId: string; orderItemId: string; serviceId: string }[]; at: Date },
): Promise<IpdOrderPostResult> {
  const found = await admissionByNo(tx, input.encounterNo);
  if (found === undefined || input.items.length === 0) return { posted: [], supplementary: false };
  await admissionAdvisoryLock(tx, found.id);
  let a = await readAdmission(tx, found.id);
  const supplementary = (await liveBills(tx, a.id)).length > 0;
  const serviceDate = istDayString(input.at);
  // Review item 3 (decision 0067 is not limited to OPD): a scan ordered while imaging is free posts at ₹0, as OPD's does.
  const free = input.department === "imaging" && await imagingFreeAtOrder(tx, input.at);
  const cache = new Map();
  const posted: string[] = [];
  for (const item of input.items) {
    const id = await postOrderLineIn(tx, actor, a, { ...item, component: input.department, serviceDate, free }, input.at, cache);
    if (id !== null) posted.push(id);
    if (a.tariffVersionId === null) a = await readAdmission(tx, found.id); // pinned by the first line
  }
  // Review: re-run the deposit ladder for this admission now (a savepoint on this transaction; a failure is logged only).
  if (posted.length > 0) await evaluateDepositLadderSafely(tx as unknown as Db, a.id, input.at, "order");
  return { posted, supplementary };
}

/**
 * A cancelled order item (review items 4, 5, 8): the ADMISSION lock is taken first, then the line and its reversal are read.
 * - never posted (its rate was missing): the open exception closes (`not_posted`);
 * - work started: nothing is reversed; a LAB line raises the `order_cancelled_after_work` bill-desk decision (radiology
 *   raises its own `performed_then_cancelled`);
 * - the line is on a settled bill: nothing is reversed behind the invoice; `order_cancelled_after_bill` goes to the bill
 *   desk naming the order item — billing voids / re-bills (#763 / #775) or keeps it (`keepOrderCharge`);
 * - else: a reversal line (`reversed`).
 */
export async function reverseIpdOrderCharge(
  tx: Tx, actor: Actor, input: { orderItemId: string; workStarted: boolean; reason: string; at: Date },
): Promise<{ outcome: EpisodeReverseOutcome }> {
  const head = (await tx.select({ admissionId: ipdChargeLines.admissionId }).from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.orderItemId, input.orderItemId), eq(ipdChargeLines.source, "ipd.order"))))[0]
    ?? (await tx.select({ admissionId: ipdChargeExceptions.admissionId }).from(ipdChargeExceptions)
      .where(and(inArray(ipdChargeExceptions.component, ["lab", "imaging"]), like(ipdChargeExceptions.key, `%:${input.orderItemId}`))))[0];
  if (head === undefined) return { outcome: "none" };
  await admissionAdvisoryLock(tx, head.admissionId);
  const line = (await tx.select().from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.orderItemId, input.orderItemId), eq(ipdChargeLines.source, "ipd.order"))))[0];
  if (line === undefined) {
    const closed = await tx.update(ipdChargeExceptions).set({ resolvedAt: input.at, resolutionNote: "order cancelled" }).where(and(
      inArray(ipdChargeExceptions.component, ["lab", "imaging"]), isNull(ipdChargeExceptions.resolvedAt),
      like(ipdChargeExceptions.key, `%:${input.orderItemId}`),
    )).returning({ id: ipdChargeExceptions.id });
    return { outcome: closed.length > 0 ? "not_posted" : "none" };
  }
  const done = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(eq(ipdChargeLines.reversalOf, line.id)))[0];
  if (done !== undefined) return { outcome: "none" };
  const a = await readAdmission(tx, line.admissionId);
  const decision = async (reason: "order_cancelled_after_bill" | "order_cancelled_after_work") => raiseException(tx, actor, a, {
    date: line.serviceDate, component: line.component as "lab" | "imaging", billedClass: null, code: line.serviceCode, reason,
    versionId: line.tariffVersionId, orderItemId: line.orderItemId!,
  }, input.at);
  if (await lineIsBilled(tx, line.admissionId, line.id)) {
    await decision("order_cancelled_after_bill");
    return { outcome: "billed" };
  }
  if (input.workStarted) {
    if (line.component === "lab") await decision("order_cancelled_after_work");
    return { outcome: "work_done" };
  }
  const id = newId();
  await tx.insert(ipdChargeLines).values({
    ...line, id, source: "ipd.reversal", reversalOf: line.id, reason: `order cancelled before the work: ${input.reason}`.slice(0, 500),
    unitPaise: -line.unitPaise, grossPaise: -line.grossPaise, discountPaise: -line.discountPaise, taxablePaise: -line.taxablePaise,
    cgstPaise: -line.cgstPaise, sgstPaise: -line.sgstPaise, netPaise: -line.netPaise, postedBy: actor.id, postedAt: input.at,
  });
  await appendEvent(tx, chargeReversed.make({
    payload: { admissionId: line.admissionId, chargeLineId: line.id, reversalLineId: id, provenance: provenanceOf(actor) },
    actor, correlationId: line.admissionId, patientId: line.patientId, encounterId: line.admissionId, occurredAt: input.at,
  }));
  return { outcome: "reversed" };
}

/** True when the order item is charged on a running bill: its line, or an open / closed missing-rate record for it. */
export async function ipdCoversOrderItem(exec: Db | Tx, orderItemId: string): Promise<boolean> {
  const line = (await (exec as Db).select({ id: ipdChargeLines.id }).from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.orderItemId, orderItemId), eq(ipdChargeLines.source, "ipd.order"))))[0];
  if (line !== undefined) return true;
  const x = (await (exec as Db).select({ id: ipdChargeExceptions.id }).from(ipdChargeExceptions).where(and(
    inArray(ipdChargeExceptions.component, ["lab", "imaging"]), inArray(ipdChargeExceptions.reason, ["rate_missing", "tariff_missing"]),
    like(ipdChargeExceptions.key, `%:${orderItemId}`),
  )))[0];
  return x !== undefined;
}

export const ipdOrderChargeSink: EpisodeChargeSink = {
  standing: ipdOrderStanding,
  lock: lockIpdOrderStanding,
  post: async (tx, actor, input) => { await postIpdOrderCharges(tx, actor, input); },
  reverse: async (tx, actor, input) => (await reverseIpdOrderCharge(tx, actor, input)).outcome,
  covers: ipdCoversOrderItem,
};

/** Registered by `IpdModule` (API); exported so a suite may register it without booting Nest. */
export function registerIpdOrderChargeSink(): () => void {
  return registerEpisodeChargeSink(IPD_ADMISSION_PREFIX, ipdOrderChargeSink);
}
