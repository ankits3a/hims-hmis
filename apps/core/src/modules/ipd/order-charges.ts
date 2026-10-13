import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdAdmissions, ipdChargeExceptions, ipdChargeLines } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { registerEpisodeChargeSink } from "../billing";
import { admissionAdvisoryLock, provenanceOf, readAdmission } from "./admission-core";
import { IPD_PLACED_STATES } from "./admission-place";
import { lineIsBilled } from "./bill-cover";
import { chargeReversed } from "./charge-events";
import { postOrderLineIn } from "./charges";
import { IPD_ADMISSION_NO_RE, IPD_ADMISSION_PREFIX } from "./encounter";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeChargeSink, EpisodeStanding } from "../billing";

/**
 * #785 — LAB AND IMAGING ORDERS ON THE RUNNING BILL. An order placed on a live admission (`IP26-000123`) — from rounds
 * (`placeIpOrder`) or any other door that names the admission number (the ordering door, the lab desk, the radiology
 * desk) — is charged here, as `ipd.order` lines of `ipd_charge_lines`, and never as a held invoice: the department asks
 * billing's episode charge sink (`registerEpisodeChargeSink`, prefix `IP`) before it would issue one.
 *
 * - STANDING: `live` while the stay is placed (`IPD_PLACED_STATES`); `ended` once it is not — the department refuses a NEW
 *   order on it (a reflex test of an earlier sample still posts: the supplementary bill takes it).
 * - POSTING: one line per order item, priced from the admission's locked tariff version, marked with the department
 *   order and the order item (`charges.ts` `postOrderLineIn`). An unpriced service is a `rate_missing` exception, never ₹0.
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

export async function postIpdOrderCharges(
  tx: Tx, actor: Actor, input: { encounterNo: string; department: "lab" | "imaging"; items: readonly { orderId: string; orderItemId: string; serviceId: string }[]; at: Date },
): Promise<{ posted: string[] }> {
  const found = await admissionByNo(tx, input.encounterNo);
  if (found === undefined || input.items.length === 0) return { posted: [] };
  await admissionAdvisoryLock(tx, found.id);
  let a = await readAdmission(tx, found.id);
  const serviceDate = istDayString(input.at);
  const cache = new Map();
  const posted: string[] = [];
  for (const item of input.items) {
    const id = await postOrderLineIn(tx, actor, a, { ...item, component: input.department, serviceDate }, input.at, cache);
    if (id !== null) posted.push(id);
    if (a.tariffVersionId === null) a = await readAdmission(tx, found.id); // pinned by the first line
  }
  return { posted };
}

export async function reverseIpdOrderCharge(
  tx: Tx, actor: Actor, input: { orderItemId: string; workStarted: boolean; reason: string; at: Date },
): Promise<{ outcome: "reversed" | "work_done" | "billed" | "not_posted" | "none" }> {
  const line = (await tx.select().from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.orderItemId, input.orderItemId), eq(ipdChargeLines.source, "ipd.order"))))[0];
  if (line === undefined) {
    // Never posted (its rate was missing): the open exception closes — there is nothing left to charge.
    const closed = await tx.update(ipdChargeExceptions).set({ resolvedAt: input.at, resolutionNote: "order cancelled" }).where(and(
      inArray(ipdChargeExceptions.component, ["lab", "imaging"]), isNull(ipdChargeExceptions.resolvedAt),
      like(ipdChargeExceptions.key, `%:${input.orderItemId}`),
    )).returning({ id: ipdChargeExceptions.id });
    return { outcome: closed.length > 0 ? "not_posted" : "none" };
  }
  if (input.workStarted) return { outcome: "work_done" };
  await admissionAdvisoryLock(tx, line.admissionId);
  const done = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(eq(ipdChargeLines.reversalOf, line.id)))[0];
  if (done !== undefined) return { outcome: "none" };
  if (await lineIsBilled(tx, line.admissionId, line.id)) return { outcome: "billed" };
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

export const ipdOrderChargeSink: EpisodeChargeSink = {
  standing: ipdOrderStanding,
  post: async (tx, actor, input) => { await postIpdOrderCharges(tx, actor, input); },
  reverse: async (tx, actor, input) => { await reverseIpdOrderCharge(tx, actor, input); },
};

/** Registered by `IpdModule` (API); exported so a suite may register it without booting Nest. */
export function registerIpdOrderChargeSink(): () => void {
  return registerEpisodeChargeSink(IPD_ADMISSION_PREFIX, ipdOrderChargeSink);
}
