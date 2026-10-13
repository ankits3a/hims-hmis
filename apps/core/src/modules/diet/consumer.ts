import { z } from "zod";
import { IPD_ADMISSION_ENDED_EVENT_NAMES, IPD_TRANSFER_ACCEPTED_EVENT_NAME } from "../ipd";
import { IPD_ADMITTED_EVENT, IPD_BED_SWAPPED_EVENT, OT_BOOKED_EVENT, OT_CANCELLED_EVENT } from "./names";
import { endStay, liftOtNpo, npoForOtBooking } from "./orders";
import { reconcileAdmission } from "./trays";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/**
 * `diet.reconcile` — the worker's consumer for the events that move a tray:
 *   · IPD admitted, transfer accepted, bed swapped → `reconcileAdmission` (a late tray on the new ward's built list,
 *     the old ward's tray withdrawn and that ward TOLD when its list was printed);
 *   · IPD discharged / LAMA / absconded / deceased → `endStay` (order ended, trays withdrawn from every list ahead);
 *   · OT `daycare.booked` → NPO for the surgery day; OT `case.cancelled` → that NPO lifts and the ward is told.
 * Only ids are read from the payloads; every act re-reads IPD live and is idempotent (at-least-once delivery, and the
 * dispatcher's look-back re-reads recent history once on a fresh cursor).
 */
const Admission = z.looseObject({ admissionId: z.string().min(1) });
const Swap = z.looseObject({ admissionIdA: z.string().min(1), admissionIdB: z.string().min(1) });
const Booked = z.looseObject({ caseId: z.string().min(1), patientId: z.string().min(1), listDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const Cancelled = z.looseObject({ caseId: z.string().min(1) });

const ENDED: ReadonlySet<string> = new Set(IPD_ADMISSION_ENDED_EVENT_NAMES);

export async function handleDietEvent(db: Db, e: DispatchedEvent, now: Date = new Date()): Promise<void> {
  if (e.name === OT_BOOKED_EVENT) {
    const p = Booked.safeParse(e.payload);
    if (p.success) await npoForOtBooking(db, p.data, now);
    return;
  }
  if (e.name === OT_CANCELLED_EVENT) {
    const p = Cancelled.safeParse(e.payload);
    if (p.success) await liftOtNpo(db, p.data.caseId, now);
    return;
  }
  if (e.name === IPD_BED_SWAPPED_EVENT) {
    const p = Swap.safeParse(e.payload);
    if (!p.success) return;
    await reconcileAdmission(db, p.data.admissionIdA, now);
    await reconcileAdmission(db, p.data.admissionIdB, now);
    return;
  }
  const p = Admission.safeParse(e.payload);
  if (!p.success) return;
  if (ENDED.has(e.name)) {
    await endStay(db, p.data.admissionId, now);
    return;
  }
  if (e.name === IPD_ADMITTED_EVENT || e.name === IPD_TRANSFER_ACCEPTED_EVENT_NAME) {
    await reconcileAdmission(db, p.data.admissionId, now);
  }
}

/** The `Handler` `workerConsumers` registers for `diet.reconcile`. */
export function dietConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => { await handleDietEvent(db, e); };
}
