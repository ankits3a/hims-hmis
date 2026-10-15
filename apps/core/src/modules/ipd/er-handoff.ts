import { eq } from "drizzle-orm";
import { ipdAdmissions } from "../../kernel/db/schema";
import { admissionAdvisoryLock, readAdmission } from "./admission-core";
import { postOrderLineIn } from "./charges";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

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
