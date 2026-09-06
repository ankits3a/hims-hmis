import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { resources } from "../../kernel/db/schema/resources";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition } from "../../kernel/workflow/instances";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { DEVICE_MODALITY_ATTRIBUTE, DEVICE_PORTABLE_ATTRIBUTE, SCHEDULABLE_DEVICE_STATUSES } from "./kinds";
import { RadiologyError } from "./errors";
import { imagingStudyScheduled } from "./events";
import { appendEvent } from "../../kernel/events/append";
import { requireStudyType } from "./study-types";
import { raiseBillDecision } from "./money";
import { releaseResource } from "../../kernel/resources/registry";
import { RADIOLOGY_RESOURCE_KINDS } from "./kinds";
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
  /**
   * 18a-iii T3 / D4 — the ward and bed, when the machine goes to the patient. `undefined` leaves
   * whatever the row already holds; `null` clears it, which is what a reschedule back into the
   * department means.
   */
  bedsideLocation?: string | null;
};

export type ScheduleResult = {
  studyId: string;
  deviceResourceId: string;
  scheduledAt: Date;
  accessionNo: string;
};

type DeviceRow = { id: string; status: string; code: string; name: string; attributes: Record<string, unknown> };

/**
 * ═══ A REFUSAL NAMES THE MACHINE THE WAY THE PERSON READING IT KNOWS IT ═══
 *
 * Every sentence below used to open `device 01M1VRJ4QVQWNA2V3X8YYK62MF …`. A receptionist reads
 * these at a counter and a technologist reads them at a console; neither has any way to map a ULID
 * to a room, and "which machine" is the only thing they need in order to act. The id stays in
 * `detail`, where a client reads it.
 *
 * This is the sweep for the fix that landed as an INSTANCE in `aerb/licences.ts`
 * (`assertDeviceLicensed`). A census of `device ${` across radiology and aerb found ELEVEN sites and
 * that fix closed one — the same "a fix aimed at an instance closes the instance" shape the close
 * review's second pass exists to catch, caught here against my own change.
 */
function machineLabel(device: { code: string; name: string }): string {
  return `${device.code} (${device.name})`;
}

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
    .select({
      id: resources.id, status: resources.status, code: resources.code, name: resources.name,
      attributes: resources.attributes, kind: resources.kind,
    })
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
      `${machineLabel(device)} is ${device.status} and cannot take bookings`,
      { deviceResourceId, status: device.status },
    );
  }
  const deviceModality = device.attributes[DEVICE_MODALITY_ATTRIBUTE];
  if (deviceModality !== modality) {
    throw new RadiologyError(
      "modality_mismatch",
      `${machineLabel(device)} is a ${String(deviceModality)} machine and this study is ${modality}`,
      { deviceResourceId, deviceModality, studyModality: modality },
    );
  }
  return {
    id: device.id, status: device.status, code: device.code, name: device.name,
    attributes: device.attributes,
  };
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
 * ═══ F55 (CLOSE REVIEW) — THE SLOT WAS A POINT, AND EVERY STUDY TYPE DECLARES A LENGTH ═══
 *
 * `imaging_studies_slot_ux` collides only on an EXACT-equal `scheduled_at`, so booking an MRI-BRAIN
 * (`duration_min: 45`) at 10:00 and another at 10:15 on the same magnet produced two rows, no
 * unique violation and no `slot_taken`. Two patients told to arrive fifteen minutes apart for a
 * forty-five-minute scan on one machine, discovered at 10:15 with both in the waiting room.
 *
 * `duration_min` was declared on every study type, validated by the body schema and seeded with
 * real values — and **read by nothing in the entire tree.** The index was the right mechanism keyed
 * on the wrong quantity.
 *
 * ═══ WHY A LOCK AND A QUERY RATHER THAN AN EXCLUSION CONSTRAINT ═══
 *
 * The natural answer is `EXCLUDE USING gist (device WITH =, tstzrange(...) WITH &&)`, and it is the
 * better one — but it needs the `btree_gist` extension, which needs a privilege this deployment's
 * database user does not have and which would make the migration fail on a box nobody could debug
 * from the error. So: the DEVICE ROW is locked first, which serialises every booking for that
 * machine, and the overlap is then a plain query that cannot race. The exact-instant unique index
 * stays as the last line of defence and as the thing that would catch a future caller who skips
 * this path. **Named rather than implied: an exclusion constraint is the right fix the day the
 * extension is available.**
 */
async function assertSlotFree(
  tx: Tx,
  deviceResourceId: string,
  scheduledAt: Date,
  durationMin: number,
  studyId: string,
): Promise<void> {
  /**
   * The lock. Every booking for this machine queues behind it, so the read below is stable.
   *
   * It also carries the machine's CODE and NAME, so the clash refusal below can name the room
   * rather than a ULID. That costs nothing: this row is read and locked either way.
   */
  const locked = await (tx as unknown as Db)
    .select({ id: resources.id, code: resources.code, name: resources.name })
    .from(resources).where(eq(resources.id, deviceResourceId)).for("update");

  const start = scheduledAt;
  const end = new Date(scheduledAt.getTime() + durationMin * 60_000);
  const clash = await (tx as unknown as Db)
    .select({
      id: imagingStudies.id, accessionNo: imagingStudies.accessionNo,
      scheduledAt: imagingStudies.scheduledAt, durationMin: imagingStudies.durationMin,
    })
    .from(imagingStudies)
    .where(and(
      eq(imagingStudies.deviceResourceId, deviceResourceId),
      inArray(imagingStudies.status, [...LIVE_SLOT_STATUSES]),
      ne(imagingStudies.id, studyId),
      sql`${imagingStudies.scheduledAt} < ${end.toISOString()}`,
      sql`${imagingStudies.scheduledAt} + make_interval(mins => ${imagingStudies.durationMin}) > ${start.toISOString()}`,
    ))
    .limit(1);

  if (clash[0]) {
    throw new RadiologyError(
      "slot_taken",
      `${locked[0] ? machineLabel(locked[0]) : `device ${deviceResourceId}`} is busy with ${clash[0].accessionNo} from `
      + `${clash[0].scheduledAt?.toISOString() ?? "?"} for ${String(clash[0].durationMin)} minutes — `
      + `this ${String(durationMin)}-minute study overlaps it`,
      {
        deviceResourceId, scheduledAt: start.toISOString(), durationMin,
        clashesWith: clash[0].accessionNo,
      },
    );
  }
}

/** The statuses that HOLD a slot — the same three the partial unique excludes, stated once. */
const LIVE_SLOT_STATUSES = ["scheduled", "checked_in", "ready", "in_acquisition"] as const;

/**
 * A1/A2/A3 — books a study onto a device at an instant.
 *
 * The write is a plain UPDATE and the collision is the INDEX's answer, never a pre-read. That is
 * what makes two concurrent callers produce one winner and one `slot_taken` rather than two
 * bookings that both passed a check a microsecond apart.
 */
/**
 * ═══ 18a-iii T3 / D4 — WHERE THIS STUDY HAPPENS, AND THE ONE RULE ABOUT IT ═══
 *
 * A bedside location may only sit on a device carrying `attributes.portable`. The rule is
 * **one-directional on purpose**: a portable unit wheeled into a department room is an ordinary
 * thing and takes no bedside location, so the reverse ("a portable device must have a place") would
 * be false on a real case. A study is portable because it has a PLACE, not because of its machine.
 *
 * **It is evaluated on the EFFECTIVE value rather than the caller's**, which is what makes it whole:
 * `undefined` means "leave what the row holds", so a study already carrying "Ward 3, Bed 12" and
 * being moved to the CT is refused rather than silently keeping a place the gantry cannot go to.
 * Clearing it is explicit — `bedsideLocation: null`.
 *
 * The refusal names the MACHINE, not the field: the recoverable action is picking a different
 * machine, because the CT does not come to the ward.
 */
function resolveBedside(
  device: DeviceRow,
  current: string | null,
  input: ScheduleInput,
): string | null {
  const effective = input.bedsideLocation === undefined
    ? current
    : (input.bedsideLocation?.trim() || null);
  if (effective !== null && device.attributes[DEVICE_PORTABLE_ATTRIBUTE] !== true) {
    throw new RadiologyError(
      "device_not_portable",
      `${machineLabel(device)} is not a portable unit and cannot be taken to a bedside — book a `
      + "portable machine, or clear the bedside location and bring the patient to the department",
      { deviceResourceId: device.id, bedsideLocation: effective },
    );
  }
  return effective;
}

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
  const device = await assertDeviceBookable(tx, input.deviceResourceId, studyType.modality);
  await assertSlotFree(tx, input.deviceResourceId, input.scheduledAt, studyType.duration_min, study.id);
  const bedsideLocation = resolveBedside(device, study.bedsideLocation, input);

  try {
    await tx.update(imagingStudies)
      .set({
        deviceResourceId: input.deviceResourceId,
        scheduledAt: input.scheduledAt,
        /** F55 — the length is snapshotted, so a later book edit cannot move a booked slot. */
        durationMin: studyType.duration_min,
        bedsideLocation,
      })
      .where(eq(imagingStudies.id, input.studyId));
  } catch (e) {
    if (isSlotCollision(e)) {
      throw new RadiologyError(
        "slot_taken",
        `${machineLabel(device)} already has a live booking at that time`,
        { deviceResourceId: input.deviceResourceId, scheduledAt: input.scheduledAt.toISOString() },
      );
    }
    throw e;
  }

  /**
   * ═══ F46 (CLOSE REVIEW) — THE EVENT THAT WAS DECLARED, FROZEN AND EMITTED BY NOBODY ═══
   *
   * `imaging.study_scheduled` was declared in `events.ts`, frozen into §6/§8 as a payload
   * downstream plans may write against, and documented in its own header as the input to **18b's
   * modality worklist file** and **22c-F's appointment card**, with §7 E26 routing 18a-iii's
   * rebooking cascade over it. Nothing raised it. The only references in the tree were its own
   * declaration and a schema test that parses a payload no code ever builds.
   *
   * **Emitting it on BOTH the book and the move is also DD5's audit answer** — *"when was this
   * moved, off what slot"*. The payload carries the NEW slot and the keys §8.10 freezes; the OLD
   * slot is the previous event for the same study, which is what an event log is for. That answers
   * the question without widening a frozen payload, which a successor would have to live with.
   */
  await appendEvent(tx, imagingStudyScheduled.make({
    actor,
    patientId: study.patientId,
    encounterId: study.encounterNo,
    payload: {
      studyId: study.id,
      orderItemId: study.orderItemId,
      patientId: study.patientId,
      deviceResourceId: input.deviceResourceId,
      scheduledAt: input.scheduledAt.toISOString(),
      studyTypeCode: study.studyTypeCode,
    },
  }));

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
  const device = await assertDeviceBookable(tx, input.deviceResourceId, studyType.modality);
  await assertSlotFree(tx, input.deviceResourceId, input.scheduledAt, studyType.duration_min, study.id);
  /**
   * 18a-iii T3 — **the same call, and this is the hole it closes.** A guard placed only on
   * `scheduleStudy` would let a ward study booked on the portable trolley be RESCHEDULED onto the
   * CT with its bedside location intact, and the row would then say a fixed gantry went to bed 12.
   * `resolveBedside` evaluates the EFFECTIVE value — the caller's, or the one already on the row —
   * so moving to a fixed machine refuses until the place is explicitly cleared.
   */
  const bedsideLocation = resolveBedside(device, study.bedsideLocation, input);

  try {
    await tx.update(imagingStudies)
      .set({
        deviceResourceId: input.deviceResourceId,
        scheduledAt: input.scheduledAt,
        durationMin: studyType.duration_min,
        bedsideLocation,
      })
      .where(eq(imagingStudies.id, input.studyId));
  } catch (e) {
    if (isSlotCollision(e)) {
      throw new RadiologyError(
        "slot_taken",
        `${machineLabel(device)} already has a live booking at that time`,
        { deviceResourceId: input.deviceResourceId, scheduledAt: input.scheduledAt.toISOString() },
      );
    }
    throw e;
  }

  /**
   * ═══ F46 (CLOSE REVIEW) — THE EVENT THAT WAS DECLARED, FROZEN AND EMITTED BY NOBODY ═══
   *
   * `imaging.study_scheduled` was declared in `events.ts`, frozen into §6/§8 as a payload
   * downstream plans may write against, and documented in its own header as the input to **18b's
   * modality worklist file** and **22c-F's appointment card**, with §7 E26 routing 18a-iii's
   * rebooking cascade over it. Nothing raised it. The only references in the tree were its own
   * declaration and a schema test that parses a payload no code ever builds.
   *
   * **Emitting it on BOTH the book and the move is also DD5's audit answer** — *"when was this
   * moved, off what slot"*. The payload carries the NEW slot and the keys §8.10 freezes; the OLD
   * slot is the previous event for the same study, which is what an event log is for. That answers
   * the question without widening a frozen payload, which a successor would have to live with.
   */
  await appendEvent(tx, imagingStudyScheduled.make({
    actor,
    patientId: study.patientId,
    encounterId: study.encounterNo,
    payload: {
      studyId: study.id,
      orderItemId: study.orderItemId,
      patientId: study.patientId,
      deviceResourceId: input.deviceResourceId,
      scheduledAt: input.scheduledAt.toISOString(),
      studyTypeCode: study.studyTypeCode,
    },
  }));

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
 * · `in_acquisition` → cancel WITH a reason, and **if the patient was on the machine (`acquisition_started_at`), a
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
   * ═══ F53 (CLOSE REVIEW) — THE OPERAND WAS `acquired_at`, AND NOTHING COULD EVER SATISFY IT ═══
   *
   * B6's rule was right and the column it read was wrong. The guard was
   * `fromAcquisition && study.acquiredAt !== null` — but `acquired_at` has exactly ONE writer
   * (`acquisition.ts`'s `recordAcquired`), and that UPDATE sets `status: 'acquired'` in the same
   * `SET`. So `in_acquisition` AND `acquired_at IS NOT NULL` is a state the system cannot produce,
   * and the fourth of DD12b's four money facts could never be raised by any input.
   *
   * Both doors were shut at once: a study that DID reach `acquired` is refused a cancel above, and
   * pointed at a bill decision no code could create. Contrast injected, first series exposed,
   * patient reacts, study abandoned — and nobody was ever asked whether the patient pays.
   *
   * **`acquisition_started_at` is the operand B6 was describing**: it is exactly "the patient went
   * on the machine", it is always non-NULL for `in_acquisition`, and film and time are spent from
   * that instant whether or not anybody reached the `acquired` button.
   *
   * It also goes through `raiseBillDecision` rather than a raw INSERT, so it emits
   * `imaging.bill_decision_raised` like the other three. The direct insert meant 18a-iii's
   * reconciliation would never have learned about it even once the guard was fixed.
   */
  let billDecisionId: string | null = null;
  if (fromAcquisition && study.acquisitionStartedAt !== null) {
    ({ billDecisionId } = await raiseBillDecision(tx, actor, {
      studyId: study.id,
      kind: "performed_then_cancelled",
      detail: {
        reason: input.reason ?? null,
        acquisitionStartedAt: study.acquisitionStartedAt.toISOString(),
        /** Who cancelled — the table carries no `raised_by`, and the queue needs to know. */
        cancelledBy: actor.id,
      },
    }));

    /**
     * F51 — AND THE MACHINE IS RELEASED. `startAcquisition` assigns the device (`in_use`, with the
     * study as its occupant); `recordAcquired` and `abortAcquisition` both release it. This third
     * and only other exit from `in_acquisition` released nothing, so a cancel on the table left the
     * room `in_use` against a cancelled study — `assignResource` then refused every later scan
     * while `SCHEDULABLE_DEVICE_STATUSES` kept the diary booking it. A CT room that accepts
     * bookings and can perform none, with the error arriving once each patient is on the table.
     */
    if (study.deviceResourceId !== null) {
      await releaseResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, study.deviceResourceId, {});
    }
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

  /**
   * ═══ F55, SECOND PASS — THE WALK-IN WALKS DOWN THE LIST ═══
   *
   * This took `candidates[0]` and handed it to `scheduleStudy`. Under the old POINT slot that
   * almost never collided; under F55's INTERVAL it collides whenever the first machine is
   * mid-examination, and the counter got a hard `slot_taken` while two other free ultrasound
   * machines stood idle — a regression introduced by the fix for the double-booking.
   *
   * `device_unavailable` is still the answer when the list is empty OR when every machine on it is
   * busy, which is the truthful sentence for a counter: not "somebody took that slot", but "there
   * is no room free right now".
   */
  /**
   * ═══ F55, SECOND PASS — THE WALK-IN WALKS DOWN THE LIST, WITHOUT WRITING TO FIND OUT ═══
   *
   * This took `candidates[0]` and handed it to `scheduleStudy`. Under the old POINT slot that
   * almost never collided; under F55's INTERVAL it collides whenever the first machine is
   * mid-examination, and the counter got a hard `slot_taken` while two other free ultrasound
   * machines stood idle — a regression introduced by the fix for the double-booking.
   *
   * **The loop asks, it does not try.** Wrapping `scheduleStudy` in a `try` and continuing on
   * `slot_taken` would work only while the refusal comes from `assertSlotFree`'s read; the moment
   * one came from the unique INDEX instead, the statement error would leave the transaction
   * aborted and every later iteration would fail with "current transaction is aborted" — a caught
   * exception that has already poisoned the work it was caught to protect. So the free machine is
   * chosen with reads alone and scheduled exactly once.
   *
   * `device_unavailable` is still the answer when the list is empty OR when every machine on it is
   * busy, which is the truthful sentence for a counter: not "somebody took that slot", but "there
   * is no room free right now".
   */
  const busy: string[] = [];
  for (const device of candidates) {
    try {
      await assertSlotFree(tx, device.id, now, studyType.duration_min, input.studyId);
    } catch (e) {
      if (e instanceof RadiologyError && e.code === "slot_taken") { busy.push(device.id); continue; }
      throw e;
    }
    return await scheduleStudy(tx, actor, {
      studyId: input.studyId,
      deviceResourceId: device.id,
      scheduledAt: now,
    });
  }
  throw new RadiologyError(
    "device_unavailable",
    candidates.length === 0
      ? `no available ${studyType.modality} machine to walk this patient onto`
      : `every available ${studyType.modality} machine is mid-examination right now `
        + `(${String(candidates.length)} checked)`,
    { modality: studyType.modality, checked: candidates.length, busy },
  );
}

/**
 * The studies a device has live on its diary, for the console and for T5's readiness view.
 *
 * ═══ F48 (CLOSE REVIEW) — IT TAKES AN ACTOR, AND IT LOGS ONE ROW PER PATIENT ═══
 *
 * The first version took no actor and wrote no `phi_access_log` row. A machine's diary is a list of
 * who is going through that room today — the same class of disclosure as the worklist, which logs —
 * and F42 already established the shape: one row per DISTINCT patient, never one per read, because
 * a partial access log is worse than none.
 */
export async function deviceDiary(
  exec: Db,
  actor: Actor,
  deviceResourceId: string,
): Promise<{ studyId: string; accessionNo: string; scheduledAt: Date | null; status: string }[]> {
  const rows = await exec
    .select({
      studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo,
      scheduledAt: imagingStudies.scheduledAt, status: imagingStudies.status,
      patientId: imagingStudies.patientId,
    })
    .from(imagingStudies)
    .where(and(
      eq(imagingStudies.deviceResourceId, deviceResourceId),
      inArray(imagingStudies.status, ["scheduled", "checked_in", "ready", "in_acquisition"]),
    ))
    .orderBy(imagingStudies.scheduledAt);

  const reason = `device diary ${deviceResourceId}, ${String(rows.length)} studies`;
  for (const patientId of new Set(rows.map((r) => r.patientId))) {
    await recordPhiAccess(exec, { actor, patientId, surface: "imaging.worklist", reason });
  }
  return rows.map((row) => {
    const { patientId: _omitted, ...rest } = row;
    void _omitted;
    return rest;
  });
}
