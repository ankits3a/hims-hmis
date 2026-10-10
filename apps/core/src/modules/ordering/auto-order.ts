import { eq, sql } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { orderItems, orders } from "../../kernel/db/schema";
import { BillingError, feeOffAt, loadBillingConfig } from "../billing";
import { labManifest } from "../lab";
import { consultationCompleted, getEncounter, paperPrescriptionTranscribed } from "../opd";
import { radiologyManifest } from "../radiology";
import { freeTestsOrdered } from "./events";
import { orderTests } from "./seam";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { OrderTestsResult } from "./seam";

/**
 * ═══ FREE TESTS ORDER THEMSELVES (owner 2026-10-10, decision 0065) ═══
 *
 * *"If the fee is toggled Free by the admin then an automatic order will be created which the lab
 * staff can add/edit and proceed for blood collection or imaging."*
 *
 * When the doctor completes the consult — or the scribe saves a paper prescription — the advised lab
 * tests are ordered if the lab fee switch was off at that moment, and the advised imaging studies if
 * the imaging switch was. Everything else stays as today: a charged test waits for the desk to order
 * and bill it, an outside test is printed on the slip.
 *
 * **A test is ordered once per visit, ever.** Anything already on an order of this visit — placed by
 * the desk, by an earlier completion, or placed and then CANCELLED by the lab — is left alone, so a
 * redelivered event, a re-completed consult or the lab's own removal never brings a test back.
 * The lab adds tests through its add-on and removes them through its cancel, as for any order.
 */
export const ORDERING_FREE_TESTS_CONSUMER = "ordering.free_tests";
export const FREE_TESTS_ACTOR: Actor = { type: "system", id: "free-tests" };
export const FREE_TESTS_PROTOCOL = "decision-0065:free-tests";

/** The two departments' order kinds, straight from their manifests (the worker installs both). */
function orderDecls(): OrderKindDecl[] {
  return [...(labManifest.orderKinds ?? []), ...(radiologyManifest.orderKinds ?? [])];
}

export async function orderFreeTests(
  db: Db,
  encounterId: string,
  doctorId: string,
  at: Date,
  decls: readonly OrderKindDecl[] = orderDecls(),
): Promise<OrderTestsResult | null> {
  let rules;
  try {
    rules = (await loadBillingConfig(db)).chargeRules;
  } catch (e) {
    if (e instanceof BillingError) return null;
    throw e;
  }
  const lab = feeOffAt(rules, "lab", at);
  const imaging = feeOffAt(rules, "imaging", at);
  if (!lab && !imaging) return null;

  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return null;
  const advised = ((encounter.advisedTests ?? []) as { serviceId: string }[]).map((a) => a.serviceId);
  if (advised.length === 0) return null;

  return await withTx(db, async (tx) => {
    /** One automatic order per visit at a time: two deliveries must not both find "nothing ordered yet". */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`free-tests:${encounter.visitNo}`}))`);
    const already = new Set((await tx.select({ serviceId: orderItems.serviceId }).from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orders.encounterNo, encounter.visitNo))).map((r) => r.serviceId));
    const fresh = [...new Set(advised)].filter((s) => !already.has(s));
    if (fresh.length === 0) return null;

    const result = await orderTests(db, FREE_TESTS_ACTOR, decls, {
      patientId: encounter.patientId, encounterNo: encounter.visitNo, serviceDate: encounter.serviceDate,
      orderingClinicianId: doctorId, serviceIds: fresh,
      indication: encounter.diagnosis?.trim() ? encounter.diagnosis.trim() : "Advised at the OPD consultation",
      protocolRef: FREE_TESTS_PROTOCOL, departments: { lab, imaging },
    }, at);
    const placed = (result.lab?.itemIds.length ?? 0) + (result.imaging?.itemIds.length ?? 0);
    if (placed > 0 || result.skipped.length > 0) {
      await appendEvent(tx, freeTestsOrdered.make({
        actor: FREE_TESTS_ACTOR, patientId: encounter.patientId, encounterId: encounter.id,
        payload: {
          encounterNo: encounter.visitNo,
          labTests: result.lab?.itemIds.length ?? 0,
          imagingTests: result.imaging?.itemIds.length ?? 0,
          outsideTests: result.routed.outside.length,
          skipped: result.skipped.length,
        },
      }));
    }
    return result;
  });
}

/** The `Handler` `workerConsumers` registers: the completed consult and the transcribed paper slip. */
export function freeTestsConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== consultationCompleted.name && e.name !== paperPrescriptionTranscribed.name) return;
    const payload = e.payload as { encounterId: string; doctorId: string };
    await orderFreeTests(db, payload.encounterId, payload.doctorId, e.occurredAt);
  };
}
