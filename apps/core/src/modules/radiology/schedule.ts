import { and, eq, inArray, sql } from "drizzle-orm";
import { imagingBillDecisions, imagingStudies } from "../../kernel/db/schema/radiology";
import { resources } from "../../kernel/db/schema/resources";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition } from "../../kernel/workflow/instances";
import { newId } from "@hmis/contracts";
import { DEVICE_MODALITY_ATTRIBUTE, SCHEDULABLE_DEVICE_STATUSES } from "./kinds";
import { RadiologyError } from "./errors";
import { requireStudyType } from "./study-types";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * PLAN 18a T4 — **SCHEDULING, RESCHEDULING, NO-SHOW AND CANCEL.**
 *
 * ═══ THE SLOT IS HELD BY A PARTIAL UNIQUE INDEX, NOT BY A READ-THEN-WRITE (A1) ═══
 *
 * `imaging_studies_slot_ux` is `(device_resource_id, scheduled_at) WHERE status NOT IN
 * ('cancelled', 'rescheduled', 'no_show')`. Two concurrent bookings for the same machine at the same
 * minute contend in POSTGRES: one commits, the other takes a unique violation which this file turns
 * into `slot_taken`. A read-then-write would let both pass the check and both insert, which is B1.
 *
 * **The `WHERE` clause is the half that is easy to lose and expensive to lose.** Without it a
 * CANCELLED booking keeps its slot for ever, and the 09:00 CT that a patient cancelled on Monday is
 * unbookable until somebody deletes a row by hand. A1's mutant is exactly that deletion.
 *
 * ═══ SCHEDULING DOES NOT ASSIGN THE DEVICE, AND THAT IS WHY IT NEEDS ITS OWN STATUS CHECK ═══
 *
 * Spike S3 measured that `assignResource` already refuses a device that is `down`, `qa_blocked`,
 * `maintenance`, `retired` or `in_use` — so acquisition (T7) gets G2 for free from the kernel. But
 * BOOKING a slot for Thursday assigns nothing today, so the kernel guard never runs and this file
 * writes the check itself (A2). `SCHEDULABLE_DEVICE_STATUSES` is the one constant both the
 * scheduler and the console read, so they cannot answer differently.
 */

/** The states a study may be scheduled FROM. `rescheduled` is terminal; a new study is not made. */
const SCHEDULABLE_FROM = ["scheduled"];

export type ScheduleInput = {
  studyId: string;
  deviceResourceId: string;
  scheduledAt: Date;
};

export type ScheduleResult = {
  studyId: string;
  deviceResourceId: string;
  scheduledAt: Date;
  accessionNo: string;
};

type DeviceRow = { id: string; status: string; attributes: Record<string, unknown> };

/**
 * A2 + A3 — the device must be a `device`, bookable, and of the study type's modality.
 *
 * Three refusals rather than one, because a counter can act on each differently: a wrong-modality
 * pick is a mis-click, a `down` machine is a call to biomedical engineering, and an unknown id is a
 * bug in whatever produced it.
 */
async function assertDeviceBookable(
  exec: Db | Tx,
  deviceResourceId: string,
  modality: string,
): Promise<DeviceRow> {
  const rows = await (exec as Db)
    .select({ id: resources.id, status: resources.status, attributes: resources.attributes, kind: resources.kind })
    .from(resources)
    .where(eq(resources.id, deviceResourceId));
  const device = rows[0];
  if (!device || device.kind !== "device") {
    throw new RadiologyError(
      "device_unavailable",
      `resource ${deviceResourceId} is not an imaging device`,
      { deviceResourceId },
    );
  }
  if (!SCHEDULABLE_DEVICE_STATUSES.includes(device.status)) {
    /**
     * A2's mutant is checking only `retired`, and the consequence it names is the Monday-09:00 CT
     * with a failed tube still taking bookings — so the rebooking cascade starts on Monday morning
     * with a waiting room already full. `down` and `qa_blocked` must stop the diary the moment
     * somebody says the tube failed or the QA phantom failed.
     */
    throw new RadiologyError(
      "device_unavailable",
      `device ${deviceResourceId} is ${device.status} and cannot take bookings`,
      { deviceResourceId, status: device.status },
    );
  }
  const deviceModality = device.attributes[DEVICE_MODALITY_ATTRIBUTE];
  if (deviceModality !== modality) {
    throw new RadiologyError(
      "modality_mismatch",
      `device ${deviceResourceId} is a ${String(deviceModality)} machine and this study is ${modality}`,
      { deviceResourceId, deviceModality, studyModality: modality },
    );
  }
  return { id: device.id, status: device.status, attributes: device.attributes };
}

/** Postgres' unique-violation SQLSTATE. A slot collision is this and nothing else. */
const UNIQUE_VIOLATION = "23505";

function isSlotCollision(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  const constraint = (e as { constraint?: unknown })?.constraint;
  return code === UNIQUE_VIOLATION && String(constraint ?? "").includes("imaging_studies_slot_ux");
}

async function loadStudy(exec: Db | Tx, studyId: string) {
  const rows = await (exec as Db).select().from(imagingStudies).where(eq(imagingStudies.id, studyId));
  const study = rows[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  return study;
}

/**
 * A1/A2/A3 — books a study onto a device at an instant.
 *
 * The write is a plain UPDATE and the collision is the INDEX's answer, never a pre-read. That is
 * what makes two concurrent callers produce one winner and one `slot_taken` rather than two
 * bookings that both passed a check a microsecond apart.
 */
export async function scheduleStudy(
  tx: Tx,
  actor: Actor,
  input: ScheduleInput,
): Promise<ScheduleResult> {
  const study = await loadStudy(tx, input.studyId);
  if (!SCHEDULABLE_FROM.includes(study.status)) {
    throw new RadiologyError(
      "bad_transition",
      `study ${input.studyId} is ${study.status} and cannot be scheduled`,
      { studyId: input.studyId, status: study.status },
    );
  }
  const studyType = await requireStudyType(tx, study.studyTypeCode);
  await assertDeviceBookable(tx, input.deviceResourceId, studyType.modality);

  try {
    await tx.update(imagingStudies)
      .set({ deviceResourceId: input.deviceResourceId, scheduledAt: input.scheduledAt })
      .where(eq(imagingStudies.id, input.studyId));
  } catch (e) {
    if (isSlotCollision(e)) {
      throw new RadiologyError(
        "slot_taken",
        `device ${input.deviceResourceId} already has a live booking at that time`,
        { deviceResourceId: input.deviceResourceId, scheduledAt: input.scheduledAt.toISOString() },
      );
    }
    throw e;
  }

  return {
    studyId: study.id,
    deviceResourceId: input.deviceResourceId,
    scheduledAt: input.scheduledAt,
    accessionNo: study.accessionNo,
  };
}

/**
 * Moves a booking. The study KEEPS its identity and its accession — a reschedule is the same scan
 * on a different machine or at a different time, not a new one, and a patient told an accession
 * number on Monday must still be able to quote it on Thursday.
 *
 * The old slot is freed by the same UPDATE that takes the new one, so there is no window in which
 * the study holds both or neither.
 */
export async function rescheduleStudy(
  tx: Tx,
  actor: Actor,
  input: ScheduleInput,
): Promise<ScheduleResult> {
  const study = await loadStudy(tx, input.studyId);
  if (!["scheduled", "checked_in"].includes(study.status)) {
    throw new RadiologyError(
      "bad_transition",
      `study ${input.studyId} is ${study.status} and cannot be rescheduled`,
      { studyId: input.studyId, status: study.status },
    );
  }
  const studyType = await requireStudyType(tx, study.studyTypeCode);
  await assertDeviceBookable(tx, input.deviceResourceId, studyType.modality);

  try {
    await tx.update(imagingStudies)
      .set({ deviceResourceId: input.deviceResourceId, scheduledAt: input.scheduledAt })
      .where(eq(imagingStudies.id, input.studyId));
  } catch (e) {
    if (isSlotCollision(e)) {
      throw new RadiologyError(
        "slot_taken",
        `device ${input.deviceResourceId} already has a live booking at that time`,
        { deviceResourceId: input.deviceResourceId, scheduledAt: input.scheduledAt.toISOString() },
      );
    }
    throw e;
  }
  return {
    studyId: study.id,
    deviceResourceId: input.deviceResourceId,
    scheduledAt: input.scheduledAt,
    accessionNo: study.accessionNo,
  };
}

/**
 * The patient did not come. `no_show` is TERMINAL on the study machine and is one of the three
 * statuses the slot index excludes, so the machine's diary frees up the moment it is recorded —
 * which is the point of recording it rather than leaving the booking to rot.
 */
export async function markNoShow(
  tx: Tx,
  actor: Actor,
  studyId: string,
): Promise<{ studyId: string; status: string }> {
  const study = await loadStudy(tx, studyId);
  if (!["scheduled", "checked_in"].includes(study.status)) {
    throw new RadiologyError(
      "bad_transition",
      `study ${studyId} is ${study.status}; only a scheduled or checked-in study can be a no-show`,
      { studyId, status: study.status },
    );
  }
  await transition(tx, study.workflowInstanceId, "no_show", actor);
  await tx.update(imagingStudies).set({ status: "no_show" }).where(eq(imagingStudies.id, studyId));
  return { studyId, status: "no_show" };
}

/**
 * ═══ A4 — CANCEL, AND THE THREE BANDS ARE NOT INTERCHANGEABLE ═══
 *
 * · `scheduled | checked_in | ready` → cancel, no reason required. Nothing has been done to the
 *   patient and nothing has been spent.
 * · `in_acquisition` → cancel WITH a reason, and **if `acquired_at` is set, a
 *   `performed_then_cancelled` bill decision** (B6). Images exist; somebody must decide whether the
 *   patient pays, and that decision belongs to the counter rather than to whoever clicked cancel.
 * · `acquired | reported | published` → **refused `already_acquired`**. A4's mutant allows it, and
 *   the consequence it names is images that exist against an order marked `cancelled` with no bill
 *   decision anywhere — I1's leak, and a study that no reconciliation can see.
 */
export async function cancelStudy(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: { studyId: string; reason?: string | null },
): Promise<{ studyId: string; billDecisionId: string | null }> {
  const study = await loadStudy(tx, input.studyId);

  if (["acquired", "reported", "published"].includes(study.status)) {
    throw new RadiologyError(
      "already_acquired",
      `study ${input.studyId} is ${study.status} — images exist, so this is a bill decision and not a cancel`,
      { studyId: input.studyId, status: study.status },
    );
  }
  if (!["scheduled", "checked_in", "ready", "in_acquisition"].includes(study.status)) {
    throw new RadiologyError(
      "bad_transition",
      `study ${input.studyId} is ${study.status} and cannot be cancelled`,
      { studyId: input.studyId, status: study.status },
    );
  }

  const fromAcquisition = study.status === "in_acquisition";
  if (fromAcquisition && (input.reason === undefined || input.reason === null || input.reason.trim() === "")) {
    throw new RadiologyError(
      "reason_required",
      "cancelling a study that is already on the machine needs a reason",
      { studyId: input.studyId },
    );
  }

  /**
   * The ORDER ITEM is cancelled through the kernel, which is what makes the order envelope's own
   * money rules run — a module that flipped its own status column and left the item `placed` would
   * leave a charge nobody cancels.
   */
  await advanceOrderItem(tx, actor, decls, study.orderItemId, "cancelled", {
    reason: input.reason ?? null,
  });
  await transition(tx, study.workflowInstanceId, "cancelled", actor);
  await tx.update(imagingStudies).set({ status: "cancelled" }).where(eq(imagingStudies.id, input.studyId));

  /**
   * B6 — the bill decision is raised on `acquired_at`, NOT on the status band. A study can be
   * `in_acquisition` with the patient on the table and nothing exposed yet; that is a cancel with
   * no money in it. The moment an acquisition instant exists, film and time were spent.
   */
  let billDecisionId: string | null = null;
  if (fromAcquisition && study.acquiredAt !== null) {
    billDecisionId = newId();
    await tx.insert(imagingBillDecisions).values({
      id: billDecisionId,
      studyId: study.id,
      kind: "performed_then_cancelled",
      detail: {
        reason: input.reason ?? null,
        acquiredAt: study.acquiredAt.toISOString(),
        /** Who cancelled — the table carries no `raised_by`, and the queue needs to know. */
        cancelledBy: actor.id,
      },
    });
  }

  return { studyId: input.studyId, billDecisionId };
}

/**
 * ═══ A3's SECOND HALF — THE WALK-IN AUTO-SLOT ═══
 *
 * A patient at the counter with an outside slip is not booked for Thursday; they are booked for
 * NOW, on whatever machine of the right modality is free. This picks the first `available` device
 * of the study type's modality and schedules at `now`.
 *
 * **`available` only, not `SCHEDULABLE_DEVICE_STATUSES`** — and the difference is deliberate. A CT
 * that is `in_use` is bookable for 15:00 and is NOT a machine to send a walk-in to at this instant,
 * because the auto-slot is an implicit promise that the patient can go through now. The scheduler
 * is wider than the walk-in on purpose.
 */
export async function autoSlotWalkIn(
  tx: Tx,
  actor: Actor,
  input: { studyId: string; now?: Date },
): Promise<ScheduleResult> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  const studyType = await requireStudyType(tx, study.studyTypeCode);

  const candidates = await (tx as unknown as Db)
    .select({ id: resources.id, attributes: resources.attributes })
    .from(resources)
    .where(and(
      eq(resources.kind, "device"),
      eq(resources.status, "available"),
      sql`${resources.attributes} ->> ${DEVICE_MODALITY_ATTRIBUTE} = ${studyType.modality}`,
    ))
    .orderBy(resources.code);

  const device = candidates[0];
  if (!device) {
    throw new RadiologyError(
      "device_unavailable",
      `no available ${studyType.modality} machine to walk this patient onto`,
      { modality: studyType.modality },
    );
  }
  return await scheduleStudy(tx, actor, {
    studyId: input.studyId,
    deviceResourceId: device.id,
    scheduledAt: now,
  });
}

/** The studies a device has live on its diary, for the console and for T5's readiness view. */
export async function deviceDiary(
  exec: Db | Tx,
  deviceResourceId: string,
): Promise<{ studyId: string; accessionNo: string; scheduledAt: Date | null; status: string }[]> {
  return await (exec as Db)
    .select({
      studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo,
      scheduledAt: imagingStudies.scheduledAt, status: imagingStudies.status,
    })
    .from(imagingStudies)
    .where(and(
      eq(imagingStudies.deviceResourceId, deviceResourceId),
      inArray(imagingStudies.status, ["scheduled", "checked_in", "ready", "in_acquisition"]),
    ))
    .orderBy(imagingStudies.scheduledAt);
}
