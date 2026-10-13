import { z } from "zod";
import { IPD_ADMISSION_ENDED_EVENT_NAMES, IPD_TRANSFER_ACCEPTED_EVENT_NAME } from "../ipd";
import { Logger } from "@nestjs/common";
import { IPD_ADMITTED_EVENT, IPD_BED_SWAPPED_EVENT, OT_BOOKED_EVENT, OT_CANCELLED_EVENT, OT_LIST_PUBLISHED_EVENT } from "./names";
import { endStay, liftOtNpo, npoForOtBooking, syncOtNpo } from "./orders";
import { reconcileAdmission } from "./trays";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/**
 * `diet.reconcile` — the worker's consumer for the events that move a tray:
 *   · IPD admitted, transfer accepted, bed swapped → `reconcileAdmission` (a late tray on the new ward's built list,
 *     the old ward's tray withdrawn and that ward TOLD when its list was printed);
 *   · IPD discharged / LAMA / absconded / deceased → `endStay` (order ended, trays withdrawn from every list ahead);
 *   · OT `daycare.booked` → NPO for the surgery day; OT `case.cancelled` → that NPO lifts and the ward is told;
 *     OT `list.published` → that day's cases re-read (a postponed case's NPO moves to its new date).
 * Only ids are read from the payloads; every act re-reads IPD live and is idempotent (at-least-once delivery, and the
 * dispatcher's look-back re-reads recent history once on a fresh cursor).
 */
const Admission = z.looseObject({ admissionId: z.string().min(1) });
const Swap = z.looseObject({ admissionIdA: z.string().min(1), admissionIdB: z.string().min(1) });
const Booked = z.looseObject({ caseId: z.string().min(1), patientId: z.string().min(1), listDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const Cancelled = z.looseObject({ caseId: z.string().min(1) });

const ENDED: ReadonlySet<string> = new Set(IPD_ADMISSION_ENDED_EVENT_NAMES);

const Published = z.looseObject({ listDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const log = new Logger("diet.reconcile");

/** Review item 13: a payload diet cannot read is LOGGED and THROWN, so the dispatcher retries (never a silent skip). */
function read<T>(schema: z.ZodType<T>, e: DispatchedEvent): T {
  const p = schema.safeParse(e.payload);
  if (p.success) return p.data;
  const msg = `diet.reconcile cannot read ${e.name} (seq ${String(e.seq)}): ${p.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
  log.error(msg);
  throw new Error(msg);
}

export async function handleDietEvent(db: Db, e: DispatchedEvent, now: Date = new Date()): Promise<void> {
  if (e.name === OT_BOOKED_EVENT) {
    await npoForOtBooking(db, read(Booked, e), now);
    return;
  }
  if (e.name === OT_CANCELLED_EVENT) {
    await liftOtNpo(db, read(Cancelled, e).caseId, now);
    return;
  }
  if (e.name === OT_LIST_PUBLISHED_EVENT) {
    await syncOtNpo(db, { listDate: read(Published, e).listDate }, now);
    return;
  }
  if (e.name === IPD_BED_SWAPPED_EVENT) {
    const p = read(Swap, e);
    await reconcileAdmission(db, p.admissionIdA, now);
    await reconcileAdmission(db, p.admissionIdB, now);
    return;
  }
  if (ENDED.has(e.name)) {
    await endStay(db, read(Admission, e).admissionId, now);
    return;
  }
  if (e.name === IPD_ADMITTED_EVENT || e.name === IPD_TRANSFER_ACCEPTED_EVENT_NAME) {
    await reconcileAdmission(db, read(Admission, e).admissionId, now);
  }
}

/** Review item 7: at deploy the seeded cursor skips OT bookings made before it; every live case from today gets its NPO. */
export async function backfillOtNpo(db: Db, now: Date = new Date()): Promise<number> {
  return syncOtNpo(db, {}, now);
}

/** The `Handler` `workerConsumers` registers for `diet.reconcile`. */
export function dietConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => { await handleDietEvent(db, e); };
}
