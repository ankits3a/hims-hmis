import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { startInstance } from "../../kernel/workflow/instances";
import { orderPlaced } from "../../kernel/orders/events";
import { RadiologyError } from "./errors";
import { IMAGING_STUDY_DEF_KEY } from "./workflow-def";
import { studyTypeByService } from "./study-types";
import { pcpndtApplicability } from "./applicability";
import { patients } from "../../kernel/db/schema/patients";
import type { Db, Tx } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/**
 * PLAN 18a T3 — **THE `order.placed` CONSUMER, AND IT IS WHERE A STUDY IS BORN.**
 *
 * `placeImagingOrder` writes an ORDER; this writes the STUDIES. The split is the order envelope's
 * own design (phase 0): the kernel owns "what was asked for" and the claiming module owns "what the
 * department is going to do about it", and the seam between them is an event rather than a call so
 * that a module can be added without the kernel learning its name.
 *
 * ═══ THE ACCESSION IS MINTED HERE, BEFORE THE STUDY HAS A SLOT ═══
 *
 * `X` from `EPISODE_SERIES.imaging_study`, at study creation. A study therefore has its number
 * from the moment it exists — before it is scheduled, before it is checked in, before a device is
 * chosen. That matters at a counter: the number is what a patient is told, what a film is labelled
 * with and what a report is filed under, and a number that appeared only at scheduling would leave
 * every unscheduled study unnameable.
 *
 * ═══ REDELIVERY CREATES NOTHING, AND THE DATABASE IS WHAT MAKES THAT TRUE ═══
 *
 * `imaging_studies.order_item_id` is UNIQUE. The bus is at-least-once, so this handler WILL see the
 * same `order.placed` twice, and A7's second leg is exactly that. The guard is a read of the
 * existing rows plus that unique constraint behind it — not a flag, not a cursor, and not a trust
 * in the dispatcher's bookkeeping.
 */
export const RADIOLOGY_ORDER_PLACED_CONSUMER = "radiology.order_placed";

export type OrderPlacedPayload = {
  orderId: string;
  orderNo: string;
  kind: string;
  patientId: string;
  encounterNo: string;
  groupId: string;
  itemIds: string[];
};

export type CreatedStudy = { studyId: string; accessionNo: string; orderItemId: string };

/**
 * Creates one study per item, IN THE ORDER `itemIds` LISTS THEM.
 *
 * A7's mutant is keying studies on `orderId` alone, and the consequence it names is that a two-item
 * order gets one study — a patient booked for a chest X-ray and an abdomen ultrasound who is
 * scanned once. The loop below is per ITEM for that reason, and the assertion walks the array.
 */
export async function handleOrderPlaced(
  tx: Tx,
  payload: OrderPlacedPayload,
): Promise<CreatedStudy[]> {
  if (payload.kind !== "imaging") return [];

  /**
   * ═══ THE IDEMPOTENCE LEG, READ BEFORE ANYTHING IS WRITTEN (A7) ═══
   *
   * Any item that already has a study means this event has been seen. Returning the EXISTING rows
   * rather than an empty array keeps the handler's answer the same on every delivery, which is what
   * makes it safe for a caller to act on the return value at all.
   */
  const existing = await (tx as unknown as Db)
    .select({
      studyId: imagingStudies.id,
      accessionNo: imagingStudies.accessionNo,
      orderItemId: imagingStudies.orderItemId,
    })
    .from(imagingStudies)
    .where(inArray(imagingStudies.orderItemId, payload.itemIds));
  if (existing.length > 0) return existing;

  const items = await (tx as unknown as Db)
    .select({
      /**
       * F60 — `restricted` is NOT selected any more. It was the old source of `form_f_required`,
       * and after the applicability rule moved here nothing read it; leaving it would have been the
       * same dead select this phase deleted from `read.ts` in the same commit.
       */
      id: orderItems.id, serviceId: orderItems.serviceId,
    })
    .from(orderItems)
    .where(inArray(orderItems.id, payload.itemIds));
  const itemById = new Map(items.map((i) => [i.id, i]));

  const orderRows = await (tx as unknown as Db)
    .select({ priority: orders.priority, serviceDate: orders.serviceDate })
    .from(orders)
    .where(eq(orders.id, payload.orderId));
  const order = orderRows[0];
  if (!order) {
    throw new RadiologyError("unknown_study", `no order ${payload.orderId}`, { payload });
  }

  /** F60 — the patient's own facts, read once for the whole order. */
  const patientRows = await (tx as unknown as Db)
    .select({ sex: patients.sex, dob: patients.dob, dobEstimated: patients.dobEstimated })
    .from(patients).where(eq(patients.id, payload.patientId));
  const patient = patientRows[0];
  if (!patient) {
    throw new RadiologyError("unknown_study", `no patient ${payload.patientId}`, { payload });
  }

  const byService = await studyTypeByService(tx);
  const created: CreatedStudy[] = [];

  /** `for…of` over `payload.itemIds`, NOT over the rows the select returned — order is the assertion. */
  for (const itemId of payload.itemIds) {
    const item = itemById.get(itemId);
    if (!item) {
      throw new RadiologyError("unknown_study", `order item ${itemId} is not on order ${payload.orderId}`);
    }
    const studyType = byService.get(item.serviceId);
    if (!studyType) {
      throw new RadiologyError(
        "unknown_study_type",
        `service ${item.serviceId} is named by no study type in the active book`,
        { serviceId: item.serviceId },
      );
    }

    /**
     * F60 — the Act's rule, for every path that reaches a study. **F52, second pass: on the day of
     * the scan AND on today, applicable if either says so.** `serviceDate` is a client string and
     * it is the `asOf` for the age band; back-dating it by sixteen years made a 24-year-old six and
     * exempted her scan from the register. Evaluating both days removes the incentive rather than
     * policing the input, and an honest backfill agrees with itself.
     */
    const facts = { sex: patient.sex, dob: patient.dob, dobEstimated: patient.dobEstimated };
    const type = { pcpndtApplicable: studyType.pcpndt_applicable };
    const onServiceDate = pcpndtApplicability(
      facts, type, new Date(`${order.serviceDate}T00:00:00.000Z`),
    );
    const applicability = onServiceDate.applicable
      ? onServiceDate
      : pcpndtApplicability(facts, type, new Date());

    const accessionNo = await nextEpisodeNo(tx, "imaging_study", order.serviceDate);
    const studyId = newId();

    /**
     * The study's own workflow instance (`imaging_study`), started at `scheduled`. It is started
     * HERE rather than at scheduling because the machine's first state IS `scheduled` and a study
     * with no instance would be a row nothing could advance — T5's check-in and T7's acquisition
     * both drive this instance and neither creates it.
     */
    const instance = await startInstance(tx, IMAGING_STUDY_DEF_KEY, {
      type: "imaging_study",
      id: studyId,
      patientId: payload.patientId,
      encounterId: payload.encounterNo,
    });

    await tx.insert(imagingStudies).values({
      id: studyId,
      orderItemId: itemId,
      orderId: payload.orderId,
      patientId: payload.patientId,
      encounterNo: payload.encounterNo,
      studyTypeCode: studyType.code,
      serviceId: item.serviceId,
      accessionNo,
      priority: order.priority,
      workflowInstanceId: instance.instanceId,
      /**
       * ═══ F60 (CLOSE REVIEW) — THE CONTRACT'S SECOND PLACEMENT PATH EVALUATED NOTHING ═══
       *
       * This was `formFRequired: item.restricted`, on the reasoning that the flag *"was set at
       * PLACEMENT by the applicability rule, so there is one decision and not two"*. That is true
       * of `POST /radiology/orders` and of NOTHING ELSE. §6.1 promises a second, equally blessed
       * path — *"or by `placeOrder` from a module with `radiology.orders.place`"* — and names Plan
       * 26 as a consumer that *"composes imaging orders and gets studies for free"*. On that path
       * `restricted` defaults to `false`, so an antenatal package's obstetric ultrasound arrived
       * here with `form_f_required: false`: no `form_f` gate at check-in, `assertFormFRecorded`
       * short-circuiting, and the scan performed and reported **with no entry in the statutory
       * register and no refusal anywhere on the path.**
       *
       * The rule is now evaluated HERE, where every path converges, from the study type's own flag
       * and the patient's record — the same inputs `place.ts` uses and the same function. That is
       * still one decision: `place.ts` sets `restricted` for the ORDER ENVELOPE's confidentiality
       * (a ward's list omits the row), and this sets `form_f_required` for the REGISTER. They agree
       * on the ordinary path because they read the same rule, and on the kernel path only this one
       * runs — which is the correct direction for the half with the criminal statute behind it.
       */
      formFRequired: applicability.applicable,
    });

    created.push({ studyId, accessionNo, orderItemId: itemId });
  }

  return created;
}

/** The `Handler` `workerConsumers` registers. Its own transaction — the `accrualConsumer` shape. */
export function orderPlacedConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== orderPlaced.name) return;
    const payload = e.payload as OrderPlacedPayload;
    if (payload.kind !== "imaging") return;
    await withTx(db, (tx) => handleOrderPlaced(tx, payload));
  };
}
