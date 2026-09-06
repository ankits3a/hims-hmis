import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { transition } from "../../kernel/workflow/instances";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { istDayString } from "../../kernel/approvals/cumulative";
import { IMAGE_ARRIVALS, imagingOutsideStudies, imagingStudies } from "../../kernel/db/schema/radiology";
import { IMAGING_MODALITIES } from "./kinds";
import { RadiologyError } from "./errors";
import { imagingOutsideStudyRegistered } from "./events";
import { requireStudyType } from "./study-types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { ImageArrival } from "../../kernel/db/schema/radiology";
import type { ImagingModality } from "./kinds";

/**
 * PLAN 18a-iii T4 — **THE OUTSIDE STUDY: a film from another centre, and the dose we must not log.**
 *
 * 18b left `imageSource: "outside"` in the enum with nothing behind it and deferred the register here
 * by name (its D8). This closes that.
 *
 * ═══ THE HAZARD THIS FUNCTION EXISTS TO REMOVE, STATED PLAINLY ═══
 *
 * Before this task, the only route to a reportable study was `recordAcquired` — and it accepted
 * `imageSource: "outside"`. For an `ionising: true` study type it then DEMANDED a dose and wrote a
 * row into the AERB radiation dose register naming **our** device
 * (`acquisition.ts` → `recordDose({ deviceResourceId: study.deviceResourceId, … })`).
 *
 * A CT performed at another hospital, reported by us, would therefore have put that hospital's
 * exposure into the statutory register an AERB inspector reads, against a machine that never ran.
 * That is not a data-quality problem; it is a false entry in a legal record. `recordAcquired` now
 * REFUSES `outside` and names this door, so there is exactly one way in and it logs no dose.
 *
 * ═══ WHAT THIS DOES NOT DO, AND EACH IS A DECISION ═══
 *
 *   · **No dose, ever.** There was no exposure on our premises. The negative is the test that
 *     matters: after registering an outside CT, `radiation_dose_register` has no row.
 *   · **No device, no AERB licence check.** `assertDeviceLicensed` asks whether OUR machine may run.
 *     No machine of ours ran.
 *   · **No charge, and no bill decision (D6).** An outside study has no acquisition, so it posts
 *     nothing. Whether the hospital charges a READING fee for somebody else's film is a tariff row
 *     and a money decision — §7's, parked, and deliberately not assumed here.
 *
 *     Two queues could have filled with these and neither does, both MEASURED rather than assumed:
 *     `acquired_unbilled` is raised inside `recordAcquired` (`acquisition.ts:580`), which this path
 *     never calls; and the daily close's `orphanScan` (`billing/daily-close.ts:295`) iterates
 *     `listVisits` — OPD encounters and their consultation fees — and reads no imaging table at all.
 *     So an outside study appears in no counter's worklist as an anomaly. That matters more than it
 *     sounds: a queue that fills every day with rows nobody can action is a queue the floor learns
 *     to scroll past, and it takes the real entries with it.
 *   · **No images.** D5: this is a record of a document. Upload belongs with 18b-ii's storage tiering.
 *   · **No gates.** A gate is a control on an exposure about to happen. Nothing is about to happen.
 */

export type OutsideStudyRow = typeof imagingOutsideStudies.$inferSelect;

export type RegisterOutsideStudyInput = {
  studyId: string;
  centreName: string;
  /** THEIR date, `YYYY-MM-DD`. A date on a film label, never an instant. */
  studyDate: string;
  modality: ImagingModality;
  externalAccessionNo?: string | null;
  arrival: ImageArrival;
  notes?: string | null;
  now?: Date;
};

/** The provenance for one study, or null when the study is ours. */
export async function outsideStudyFor(
  exec: Db | Tx, studyId: string,
): Promise<OutsideStudyRow | null> {
  const rows = await (exec as Db)
    .select().from(imagingOutsideStudies).where(eq(imagingOutsideStudies.studyId, studyId));
  return rows[0] ?? null;
}

export async function registerOutsideStudy(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: RegisterOutsideStudyInput,
): Promise<{ outsideStudyId: string; studyId: string }> {
  const now = input.now ?? new Date();

  const rows = await tx.select().from(imagingStudies).where(eq(imagingStudies.id, input.studyId));
  const study = rows[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${input.studyId}`, { studyId: input.studyId });

  if (study.status !== "scheduled") {
    throw new RadiologyError(
      "bad_transition",
      `study ${study.id} is ${study.status} — an outside study is registered before anything else `
      + "happens to it, because nothing else is going to",
      { studyId: study.id, status: study.status },
    );
  }
  /**
   * ═══ THE THREE REFUSALS THAT KEEP THIS DOOR FROM BECOMING A WAY PAST ACQUISITION ═══
   *
   * The new `scheduled → acquired` edge could, in principle, walk a REAL examination past the
   * machine, the gates and the dose. It cannot walk one past these: a study that has been given a
   * machine, put on a diary or started on the table is ours, and ours is not what this door is for.
   * A real study that has done none of those has also produced no images, so nothing is skipped.
   */
  if (study.deviceResourceId !== null) {
    throw new RadiologyError(
      "bad_transition",
      `study ${study.id} has been assigned one of our machines — an outside study uses none`,
      { studyId: study.id, deviceResourceId: study.deviceResourceId },
    );
  }
  if (study.scheduledAt !== null) {
    throw new RadiologyError(
      "bad_transition",
      `study ${study.id} holds a slot on our diary — cancel the booking before registering it as an `
      + "outside examination",
      { studyId: study.id },
    );
  }
  if (study.acquisitionStartedAt !== null || study.acquiredAt !== null) {
    throw new RadiologyError(
      "bad_transition",
      `study ${study.id} was performed here — it cannot also have been performed elsewhere`,
      { studyId: study.id },
    );
  }

  if (!(IMAGE_ARRIVALS as readonly string[]).includes(input.arrival)) {
    throw new RadiologyError("evidence_invalid", `"${input.arrival}" is not a way images arrive`);
  }
  if (!(IMAGING_MODALITIES as readonly string[]).includes(input.modality)) {
    throw new RadiologyError("evidence_invalid", `"${input.modality}" is not an imaging modality`);
  }
  const centreName = input.centreName.trim();
  if (centreName === "") {
    throw new RadiologyError(
      "evidence_invalid",
      "an outside study names the centre that performed it — that name is the whole point of the record",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.studyDate)) {
    throw new RadiologyError("invalid_date", `"${input.studyDate}" is not a YYYY-MM-DD study date`);
  }
  /**
   * Their date may be years old — a comparison film from 2019 is the ordinary case and the reason
   * this register is worth keeping. It may not be in the future: a film nobody has taken yet is a
   * typo, and this is the same refusal `gates.ts` makes of every piece of evidence it ages.
   */
  if (input.studyDate > istDayString(now)) {
    throw new RadiologyError(
      "invalid_date",
      `the outside study is dated ${input.studyDate}, which has not happened yet`,
      { studyDate: input.studyDate },
    );
  }

  /**
   * The modality the referral was raised under and the modality on the film must agree. A CT film
   * registered against an ultrasound referral would be reported under the wrong template, priced
   * under the wrong service, and would read as an ultrasound in every worklist in the building.
   */
  const studyType = await requireStudyType(tx, study.studyTypeCode);
  if (studyType.modality !== input.modality) {
    throw new RadiologyError(
      "modality_mismatch",
      `the referral is for ${studyType.modality} (${study.studyTypeCode}) and the film is `
      + `${input.modality} — register it against a referral of the right modality`,
      { referral: studyType.modality, film: input.modality },
    );
  }

  const outsideStudyId = newId();
  await tx.insert(imagingOutsideStudies).values({
    id: outsideStudyId,
    studyId: study.id,
    centreName,
    studyDate: input.studyDate,
    modality: input.modality,
    externalAccessionNo: input.externalAccessionNo?.trim() || null,
    arrival: input.arrival,
    notes: input.notes?.trim() || null,
    recordedBy: actor.id,
    recordedAt: now,
  });

  /**
   * ═══ THE ORDER ENVELOPE, AND THE DEFECT THAT READING FOUND AND NO TEST OF MINE WOULD HAVE ═══
   *
   * `placed → completed` is NOT a legal item transition (`kernel/orders/transitions.ts`): the arc is
   * `placed → in_progress → completed`. The ordinary path advances to `in_progress` inside
   * `startAcquisition` — *"the patient reached the gantry"* — and to `completed` inside
   * `publishReport`.
   *
   * This door skips `startAcquisition` entirely, so without this line the item would sit at `placed`
   * for ever and **`publishReport` would throw `an order item cannot move placed → completed`**. The
   * outside study could be drafted and signed and never published: the referring doctor's order
   * would stay open on a case that was finished, and the failure would arrive at the last step, in
   * front of the radiologist, on a study that had already consumed a reporting slot.
   *
   * `in_progress` is the honest state and the transition's own comment says why: *"the department
   * picked the work up."* It did — the film is on the radiologist's desk.
   */
  await advanceOrderItem(tx, actor, decls, study.orderItemId, "in_progress", {});

  await transition(tx, study.workflowInstanceId, "acquired", actor);
  /**
   * `acquired_at` is when the film reached US, not when the other centre took it — their date is
   * `study_date` on the provenance row and the two are frequently years apart. Confusing them would
   * make every turnaround-time report in the module read as though we had sat on the case.
   *
   * `image_source` is the 18b column this task finally gives a meaning, and there is no
   * `study_instance_uid`: `resolveStudyInstanceUid` refuses one for `outside` because there is no
   * DICOM study of ours to name.
   */
  await tx.update(imagingStudies)
    .set({ status: "acquired", acquiredAt: now, imageSource: "outside" })
    .where(eq(imagingStudies.id, study.id));

  await appendEvent(
    tx,
    imagingOutsideStudyRegistered.make({
      actor,
      patientId: study.patientId,
      encounterId: study.encounterNo,
      payload: {
        studyId: study.id, outsideStudyId, centreName, studyDate: input.studyDate,
        modality: input.modality, arrival: input.arrival,
      },
    }),
  );

  return { outsideStudyId, studyId: study.id };
}
