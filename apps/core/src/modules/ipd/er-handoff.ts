import { and, eq, inArray } from "drizzle-orm";
import { ipdAdmissions } from "../../kernel/db/schema";
import { admissionAdvisoryLock, readAdmission } from "./admission-core";
import { cancelAdmissionIn } from "./admissions";
import { insertLine, lockedVersion, postOrderLineIn, pricingFor, raiseException } from "./charges";
import { TariffError, priceInvoiceLines } from "../tariff";
import { IpdRefusal } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ER lane 5 (#812, spec SPEC-emergency §3.10) — THE ER's HAND-OFF SEAMS INTO AN ADMISSION. The emergency module raises the
 * admission through IPD's own intents (`requestAdmission` source `er`, or `emergencyAdmit` with a bed) and then calls these,
 * in its transaction:
 *
 * - `stampErHandOffIn`: the ER gate instant (`er_arrived_at`) and "stabilised" (when the ER recorded it and the admission
 *   has none) copied onto the admission — the IPD record starts at the door, not at the admission desk.
 * - `carryErOrderLinesIn`: the ER's lab and imaging order lines onto the IP running bill when the patient leaves the ER
 *   for the bed — through `postOrderLineIn`, so each is priced on the admission's locked tariff, one line per order item
 *   ever (`ipd_charge_lines_order_ux`), dated the ER service date, and a missing rate is the bill desk's `rate_missing`.
 *   Under the admission's advisory lock (the order seam's lock order). Returns order item id → IPD line id (null when the
 *   rate was missing).
 */
export async function stampErHandOffIn(
  tx: Tx, input: { admissionId: string; erArrivedAt: Date; stabilisedAt: Date | null },
): Promise<void> {
  await admissionAdvisoryLock(tx, input.admissionId);
  const a = await readAdmission(tx, input.admissionId);
  await tx.update(ipdAdmissions).set({
    erArrivedAt: input.erArrivedAt,
    ...(a.stabilisedAt === null && input.stabilisedAt !== null ? { stabilisedAt: input.stabilisedAt } : {}),
  }).where(eq(ipdAdmissions.id, a.id));
}

export async function carryErOrderLinesIn(
  tx: Tx, actor: Actor, admissionId: string,
  items: readonly { orderId: string; orderItemId: string; serviceId: string; component: "lab" | "imaging"; serviceDate: string }[], at: Date,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (items.length === 0) return out;
  await admissionAdvisoryLock(tx, admissionId);
  let a = await readAdmission(tx, admissionId);
  const cache = new Map();
  for (const item of items) {
    out.set(item.orderItemId, await postOrderLineIn(tx, actor, a, item, at, cache));
    if (a.tariffVersionId === null) a = await readAdmission(tx, admissionId);
  }
  return out;
}

/** The state of an admission the ER handed a patient to (the boarding sweep reads it; null when unknown). */
export async function erAdmissionState(db: Db | Tx, admissionId: string): Promise<string | null> {
  return (await (db as Db).select({ state: ipdAdmissions.state }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]?.state ?? null;
}

/** The ER episode's still-open admission request (source `er`, raised by `hand_to_unit` for this episode), if any. */
export async function erOpenAdmissionFor(db: Db | Tx, erEpisodeId: string): Promise<{ id: string; state: string } | undefined> {
  return (await (db as Db).select({ id: ipdAdmissions.id, state: ipdAdmissions.state }).from(ipdAdmissions).where(and(
    eq(ipdAdmissions.source, "er"), eq(ipdAdmissions.sourceRef, erEpisodeId), inArray(ipdAdmissions.state, ["requested", "reserved"]),
  )))[0];
}

/**
 * The patient left the ER some other way while boarding: the open request is cancelled through IPD's own cancel
 * (`cancelAdmissionIn`, the `cancel_admission` intent's body). A deposit already taken is never stranded: the request
 * is then left for the admission desk to refund and cancel (`held_deposit`).
 */
export async function cancelErAdmissionIn(tx: Tx, actor: Actor, admissionId: string, note: string, at: Date): Promise<"cancelled" | "not_open" | "held_deposit"> {
  const a = (await tx.select({ state: ipdAdmissions.state }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined || (a.state !== "requested" && a.state !== "reserved")) return "not_open";
  try {
    await tx.transaction(async (sp) => { await cancelAdmissionIn(sp as unknown as Tx, actor, admissionId, "clinical_change", note, at); });
    return "cancelled";
  } catch (e) {
    if (e instanceof IpdRefusal && e.code === "deposit_not_refunded") return "held_deposit";
    throw e;
  }
}

/**
 * ER lane 6 (#813, 0076 §1: "on admission, the ER lines roll into the IP running bill") — ONE ER LINE that is not an
 * order (registration, physician fee, observation, a procedure, a drug at its batch MRP) onto the running bill as an
 * `ipd.er` line, component `er`, dated the ER service day, priced on the admission's locked tariff (a drug at the MRP the
 * ER priced it, `prepaidUnitPaise`). One IP line per ER line ever (`ipd_charge_lines_er_line_ux`). A service with no rate
 * raises the bill desk's `rate_missing` exception (keyed by the ER line) and posts nothing. Returns the IP line id or null.
 */
export async function carryErLineIn(
  tx: Tx, actor: Actor, admissionId: string,
  line: { erChargeLineId: string; serviceId: string; qty: number; prepaidUnitPaise?: number; serviceDate: string }, at: Date,
): Promise<string | null> {
  await admissionAdvisoryLock(tx, admissionId);
  const db = tx as unknown as Db;
  const a = await readAdmission(tx, admissionId);
  const versionId = await lockedVersion(db, a);
  if (a.tariffVersionId === null && versionId !== null) await tx.update(ipdAdmissions).set({ tariffVersionId: versionId }).where(eq(ipdAdmissions.id, a.id));
  const fresh = await readAdmission(tx, admissionId);
  const missing = async (code: string | null, reason: "rate_missing" | "tariff_missing") => {
    await raiseException(tx, actor, fresh, {
      date: line.serviceDate, component: "er", billedClass: null, code, reason, versionId, orderItemId: line.erChargeLineId,
    }, at);
    return null;
  };
  if (versionId === null) return missing(null, "tariff_missing");
  const ctx = await pricingFor(db, new Map(), versionId, at);
  const svc = ctx.services[line.serviceId];
  if (svc === undefined) return missing(line.serviceId, "rate_missing");
  if (line.prepaidUnitPaise === undefined && (ctx.tariff.items[svc.id] === undefined || !svc.active)) return missing(svc.code, "rate_missing");
  let priced;
  try {
    [priced] = priceInvoiceLines(ctx, [{
      lineId: line.erChargeLineId, serviceId: svc.id, qty: line.qty, supplyContext: "composite_healthcare",
      ...(line.prepaidUnitPaise === undefined ? {} : { prepaidUnitPaise: line.prepaidUnitPaise }),
    }]);
  } catch (e) {
    if (e instanceof TariffError) return missing(svc.code, "rate_missing");
    throw e;
  }
  return insertLine(tx, {
    admission: fresh, serviceDate: line.serviceDate, component: "er", billedClass: null, priced: priced!, code: svc.code, versionId,
    source: "ipd.er", erChargeLineId: line.erChargeLineId, actor, at,
  });
}
