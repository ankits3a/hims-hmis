import { and, eq } from "drizzle-orm";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems } from "../../kernel/db/schema/orders";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { assignResource, releaseResource } from "../../kernel/resources/registry";
import { transition } from "../../kernel/workflow/instances";
import { istDayString } from "../../kernel/approvals/cumulative";
import { appendEvent } from "../../kernel/events/append";
import { assertFormFRecorded, assertMachineRegistered, assertPersonRegistered } from "../pcpndt";
import { assertDeviceLicensed, recordDose } from "../aerb";
import { RADIOLOGY_RESOURCE_KINDS } from "./kinds";
import { isValidDicomUid, mintStudyInstanceUid } from "./uid";
import { RadiologyError } from "./errors";
import { imagingStudyAcquired } from "./events";
import { evaluateReadiness } from "./gates";
import { assertContrastPermissible } from "./contrast";
import { authorisationOf, encounterPayer, hasBillDecision, raiseBillDecision } from "./money";
import { activeDoseReferenceLevels, drlFor, requireStudyType } from "./study-types";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { ImageSource } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18a T7 — **ACQUISITION: the patient is on the table, and the ORDER OF OPERATIONS IS THE
 * WHOLE TASK.**
 *
 * §5 T7 states the sequence and every step of it is load-bearing:
 *
 *     evaluateReadiness true → authorisationOf not null (DD12) → assertMachineRegistered +
 *     assertPersonRegistered when form_f_required → assignResource(device) → advanceOrderItem
 *     (in_progress) → status = 'in_acquisition'
 *
 * ═══ WHY `assignResource` COMES BEFORE `advanceOrderItem` (A1) ═══
 *
 * A1's mutant advances the item FIRST, and what it leaves behind is the tell: a refused start with
 * an `in_progress` order item nobody is scanning — and whose CANCEL now demands a reason, because
 * T4's `cancelStudy` treats `in_acquisition` as the band where film was spent. The whole call runs
 * in ONE transaction so a refusal rolls back everything; putting the guard that most often refuses
 * FIRST is what keeps the rollback boring.
 *
 * `assignResource` takes the row lock (`lockResource`) and refuses `in_use`, `down`, `qa_blocked`,
 * `maintenance` and `retired` — spike S3 measured that, which is why this file writes no status
 * check of its own for the OCCUPANCY question. T4's `assertDeviceBookable` exists for a different
 * question (a booking on Thursday assigns nothing today).
 *
 * ═══ WHY `assertFormFRecorded` IS FIRST IN `recordAcquired` (A2) ═══
 *
 * A2's mutant moves it after the dose write, and H8 is what that costs: a partial row, with an
 * accession and a dose, for a scan whose statutory declaration was never completed. **Nothing is
 * written until the register has answered** — not the accession, not the dose, not the event.
 */

/** The states a study may START acquisition from. `ready` and nothing else — B7's whole point. */
const STARTABLE_FROM = ["ready"];

export type StartAcquisitionResult = {
  studyId: string;
  status: string;
  authorisedBy: string;
  deviceResourceId: string;
};

async function loadStudy(exec: Db | Tx, studyId: string) {
  const rows = await (exec as Db).select().from(imagingStudies).where(eq(imagingStudies.id, studyId));
  const study = rows[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  return study;
}

/**
 * A1/A4 — the patient goes on the machine.
 *
 * The IST calendar day of the scan is derived from the SERVER clock (F52) and used
 * only by the PCPNDT registration window, which is a legal date rather than an instant.
 */
export async function startAcquisition(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: { studyId: string; now?: Date },
): Promise<StartAcquisitionResult> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);

  if (study.deviceResourceId === null) {
    throw new RadiologyError("bad_transition", `study ${input.studyId} has no device`, { studyId: input.studyId });
  }

  /**
   * ═══ (1) READINESS, AND IT RUNS BEFORE THE STATUS GATE ON PURPOSE ═══
   *
   * The obvious ordering — refuse anything that is not already `ready`, then evaluate — is WRONG,
   * and the first draft of this file had it. `evaluateReadiness` is the ONLY thing that moves
   * `checked_in → ready` (`workflow-def.ts` gives that edge to `system` alone), so a study whose
   * last gate was cleared a millisecond ago is still `checked_in` until somebody evaluates it. A
   * status check in front would refuse it `bad_transition` — a console showing every gate green and
   * a start button that says the study is in the wrong state.
   *
   * Evaluating first also makes the refusal INFORMATIVE: `not_ready` naming the open gates is
   * something a technologist can act on, where `bad_transition` naming a status is not.
   */
  const readiness = await evaluateReadiness(tx, study.id);
  if (readiness.open.length > 0) {
    throw new RadiologyError(
      "not_ready",
      `study ${input.studyId} still has open safety gates: ${readiness.open.join(", ")}`,
      { studyId: input.studyId, open: readiness.open },
    );
  }
  if (!STARTABLE_FROM.includes(readiness.state)) {
    throw new RadiologyError(
      "bad_transition",
      `study ${input.studyId} is ${readiness.state} — only a READY study goes on the machine`,
      { studyId: input.studyId, status: readiness.state },
    );
  }

  /** (2) DD12a — WHY this scan is allowed to start. `null` is the cashier's screen, not an error. */
  const payer = await encounterPayer(tx, study.encounterNo);
  const authorisedBy = authorisationOf(study, payer);
  if (authorisedBy === null) {
    throw new RadiologyError(
      "payment_required",
      `study ${input.studyId} is a self-pay ${study.priority} scan with no invoice line — take the `
      + "money, or record it as stat if this is an emergency (DD12a)",
      { studyId: input.studyId, priority: study.priority, intendedPayer: payer.intendedPayer },
    );
  }

  /**
   * (3) THE ACT. A PCPNDT-applicable scan happens on a registered machine, performed by a
   * registered person, or it does not happen. Both are re-evaluated HERE rather than trusted from
   * check-in: a registration can lapse and a doctor can be struck off between the two.
   */
  if (study.formFRequired) {
    /**
     * ═══ F52 (CLOSE REVIEW) — THE STATUTORY DATE IS THE SERVER'S, NEVER THE CALLER'S ═══
     *
     * `onDate` used to arrive in the request body, validated only as `^\d{4}-\d{2}-\d{2}$`, and
     * went straight into the registration-window comparison. Nothing bounded it, compared it to the
     * clock, or checked it against `scheduled_at`. **Two ways in, and only one needed bad intent:**
     *
     *   · a technologist refused `machine_not_registered` retries with `{"onDate":"2026-03-01"}`
     *     and the scan proceeds on a lapsed registration — the offence the renewal deadline exists
     *     to prevent, defeated by an unvalidated string;
     *   · **and without any intent at all**, the shipped console sent
     *     `new Date().toISOString().slice(0, 10)` — the browser's **UTC** day. IST is +05:30, so
     *     between 00:00 and 05:30 IST that is YESTERDAY. A registration expiring 31 March passed at
     *     02:00 IST on 1 April: the plan's own decisive E1 scenario — the 02:00 suspected ectopic —
     *     hour for hour.
     *
     * It is now derived here, from the same clock every other guard in this function reads. The
     * house rule already existed twice (the kernel's `istDayString`, which `ist-clock-parity.test.ts` exists to keep the only one);
     * this file simply was not following it.
     */
    const onDate = istDayString(now);
    const { registrationId } = await assertMachineRegistered(tx, study.deviceResourceId, onDate);
    await assertPersonRegistered(tx, actor.id, registrationId);
  }

  /**
   * ═══ (3a) PLAN 18c T1 / D3 — THE OTHER STATUTE: AERB LICENCES THE MACHINE ═══
   *
   * An examination that uses ionising radiation happens on equipment AERB has licensed, or it does
   * not happen. It sits HERE, beside the Act's own gate and before `assignResource`, for the reason
   * the paragraph above gives: a refusal that arrives after the machine is occupied and the images
   * exist is not a refusal, it is a record of an offence.
   *
   * **The date is the server's IST day, never the caller's** — F52's whole lesson, and it applies
   * with identical force to a licence window: a technologist refused `device_not_licensed` must not
   * be able to retry with last year's date, and the browser's UTC day is yesterday between 00:00
   * and 05:30 IST.
   *
   * `ionising` comes from the STUDY TYPE, which is the one place that knows whether this
   * examination emits (F18's finding, and `recordAcquired` reads the same source for the dose
   * CHECK). Ultrasound and MRI never reach this line, because AERB licences neither.
   */
  const acqStudyType = await requireStudyType(tx, study.studyTypeCode);
  if (acqStudyType.ionising) {
    await assertDeviceLicensed(tx, study.deviceResourceId, istDayString(now));
  }

  /**
   * (4) THE MACHINE, and the kernel's row lock is what makes two consoles produce one winner. A1's
   * mutant runs (5) before this line.
   */
  await assignResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, study.deviceResourceId, {
    occupantType: "imaging_study", occupantRef: study.id, at: now,
  });

  /**
   * ═══ (5) THE ENVELOPE, AND IT MOVES AT MOST ONCE ═══
   *
   * `in_progress` is DD4's projection onto the order the doctor placed. The kernel's item machine is
   * `placed → in_progress | cancelled` and `in_progress → completed | cancelled` — **there is no way
   * back to `placed`** (measured: `advance.test.ts` pins the four legal edges). So a study that was
   * started, ABORTED and started again finds its item already `in_progress`, and advancing it a
   * second time would be refused `illegal_transition` for a scan that is legitimately restarting.
   *
   * Reading the item's status and skipping is the honest shape rather than swallowing the error: the
   * envelope's statement is *"the department is working on this order"*, and it has been true
   * continuously since the first start. See `abortAcquisition` for the other half.
   */
  const itemRows = await (tx as unknown as Db)
    .select({ status: orderItems.status }).from(orderItems).where(eq(orderItems.id, study.orderItemId));
  if (itemRows[0]?.status === "placed") {
    await advanceOrderItem(tx, actor, decls, study.orderItemId, "in_progress", {});
  }

  await transition(tx, study.workflowInstanceId, "in_acquisition", actor);
  await tx.update(imagingStudies)
    .set({ status: "in_acquisition", acquisitionStartedAt: now, authorisedBy })
    .where(eq(imagingStudies.id, study.id));

  return {
    studyId: study.id, status: "in_acquisition", authorisedBy,
    deviceResourceId: study.deviceResourceId,
  };
}

export type RecordAcquiredInput = {
  studyId: string;
  imageSource: ImageSource;
  /**
   * 18b T2 / D3 — the DICOM Study Instance UID. For `pacs` it is REQUIRED and defaults to the one
   * minted from the study id (the same value the worklist export carried), so an MWL-fed modality
   * and the console agree without a lookup; a no-MWL machine's own UID is accepted if DICOM-valid.
   * For `no_pacs_images` and `outside` a UID is refused — there is no DICOM study to name.
   */
  studyInstanceUid?: string | null;
  /** M4 — an IONISING study carries at least one of these. `doseManual` is provenance, not an excuse. */
  doseCtdivol?: number | null;
  doseDlp?: number | null;
  doseDap?: number | null;
  fluoroSeconds?: number | null;
  doseManual?: boolean;
  contrastGiven?: boolean;
  contrastAgent?: string | null;
  contrastVolumeMl?: number | null;
  repeatOfStudyId?: string | null;
  repeatReason?: string | null;
  /** E11 — the PAPER instant for a downtime backfill. `lateEntry` is DERIVED from it, never typed. */
  acquiredAt?: Date;
  now?: Date;
};

/** E11 / phase 0 E13 — a backfill more than this far from the clock is a LATE ENTRY, and says so. */
export const LATE_ENTRY_MINUTES = 30;

/**
 * 18b T2 / D3 — which UID the row gets, or why none. Pure, so the controller's shape and the
 * service's rule cannot drift: `pacs` → the caller's DICOM-valid UID or the minted one; anything
 * else → null, and a caller who typed one is refused rather than silently dropped.
 */
export function resolveStudyInstanceUid(
  studyId: string, input: Pick<RecordAcquiredInput, "imageSource" | "studyInstanceUid">,
): string | null {
  const typed = input.studyInstanceUid ?? null;
  if (input.imageSource !== "pacs") {
    if (typed !== null) {
      throw new RadiologyError(
        "invalid_study_instance_uid",
        `image source ${input.imageSource} names no DICOM study, so a Study Instance UID cannot be recorded against it`,
        { studyId, imageSource: input.imageSource, studyInstanceUid: typed },
      );
    }
    return null;
  }
  if (typed === null) return mintStudyInstanceUid(studyId);
  if (!isValidDicomUid(typed)) {
    throw new RadiologyError(
      "invalid_study_instance_uid",
      `"${typed}" is not a DICOM UID (PS3.5 §9.1: numeric components, no leading zeros, at most 64 characters)`,
      { studyId, studyInstanceUid: typed },
    );
  }
  return typed;
}

/**
 * A2/A3/A5/A6/A7 — the images exist.
 *
 * The status compare-and-set at the end is what makes `imaging.study_acquired` fire EXACTLY ONCE
 * (A6): a double-clicked console produces one event, because the second call finds the study
 * `acquired` and is refused before it reaches the emit.
 */
export async function recordAcquired(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: RecordAcquiredInput,
): Promise<{ studyId: string; accessionNo: string; studyInstanceUid: string | null; billDecisionIds: string[] }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);

  /** A6 — the second call is refused here, before anything is written or emitted. */
  if (["acquired", "reported", "published"].includes(study.status)) {
    throw new RadiologyError(
      "already_acquired",
      `study ${input.studyId} is already ${study.status} — a second acquisition would count one patient's dose twice`,
      { studyId: input.studyId, status: study.status },
    );
  }
  if (study.status !== "in_acquisition") {
    throw new RadiologyError(
      "bad_transition",
      `study ${input.studyId} is ${study.status} and is not on the machine`,
      { studyId: input.studyId, status: study.status },
    );
  }

  /**
   * ═══ A2 — THE REGISTER ANSWERS FIRST, AND NOTHING IS WRITTEN UNTIL IT DOES ═══
   *
   * `assertFormFRecorded` demands a **recorded** form, not merely an open one. Its own header
   * carries H8's argument; what matters here is only that it is the FIRST statement in the body.
   */
  await assertFormFRecorded(tx, study.id, study.formFRequired);

  const studyType = await requireStudyType(tx, study.studyTypeCode);

  /**
   * ═══ F18 — `ionising` IS SNAPSHOTTED HERE, AND UNTIL THIS COMMIT NOTHING WROTE IT ═══
   *
   * The column defaulted `false` on every study ever created, which made
   * `imaging_studies_dose_ck` — M4's whole control — VACUOUS: the CHECK reads this column, so an
   * ionising CT with no dose passed it. Two shipped comments disagreed about who should write the
   * column (`radiology.ts` says at creation, `definitions.ts` says at acquisition) and neither did.
   *
   * Written HERE because the CHECK fires on `acquired_at`: snapshotting at acquisition satisfies
   * both readings and needs no change to T3's consumer. It comes from the ACTIVE study-type body,
   * which is the one place that knows whether this examination uses ionising radiation.
   */
  const ionising = studyType.ionising;

  /** M4 — the CHECK enforces this at the database; the refusal here names the field instead of the constraint. */
  const doseGiven = [input.doseCtdivol, input.doseDlp, input.doseDap, input.fluoroSeconds]
    .some((v) => v !== undefined && v !== null);
  if (ionising && !doseGiven) {
    throw new RadiologyError(
      "dose_required",
      `${study.studyTypeCode} is an ionising examination and was acquired with no dose recorded — `
      + "`doseManual` records that a human read the console, it does not excuse the number (M4)",
      { studyId: study.id, studyTypeCode: study.studyTypeCode },
    );
  }

  /**
   * ═══ CONTRAST: THE GATES DECIDE, AND THIS IS T5's OWED HALF ═══
   *
   * T5 opens the three contrast gates only for `contrast_option: 'required'`, because whether an
   * `optional` study receives contrast is decided at THIS console and a gate opened at check-in for
   * a scan that turns out to need none is a gate the floor learns to click past. T5 recorded the
   * obligation: **T7 refuses `contrastGiven` on a study whose contrast gates are not terminal.**
   */
  /**
   * ═══ 18a-iii T4 — `outside` IS REFUSED HERE, AND THE REASON IS A STATUTORY REGISTER ═══
   *
   * 18b put `outside` in `IMAGE_SOURCES` and left nothing behind it, so this console accepted it.
   * For an `ionising: true` study type the block below then demanded a dose and wrote a
   * `radiation_dose_register` row naming **our** `deviceResourceId` — which means a CT performed at
   * another hospital, reported by us, would have entered ANOTHER HOSPITAL'S EXPOSURE into the
   * statutory register an AERB inspector reads, against a machine that never ran.
   *
   * Nothing caught it because nothing was wrong at either end on its own: 18b's enum value is
   * correct, and 18a's dose write is correct for every study that actually happened here. The defect
   * lived in the fact that one door served both.
   *
   * So there is now one door each. An outside film goes through `registerOutsideStudy`, which
   * records provenance, reaches `acquired` on its own workflow edge, and logs no dose at all.
   */
  if (input.imageSource === "outside") {
    throw new RadiologyError(
      "outside_study_only",
      `study ${study.id} was recorded with imageSource "outside" at the acquisition console — a film `
      + "from another centre is registered through the outside-study register, which records the "
      + "centre that performed it and writes NO radiation dose against our machine (18a-iii T4/D5)",
      { studyId: study.id },
    );
  }

  const studyInstanceUid = resolveStudyInstanceUid(study.id, input);
  const contrastGiven = input.contrastGiven ?? false;
  /**
   * ═══ 18a-iii T1 — THE THREE REFUSALS MOVED TO `contrast.ts`, VERBATIM ═══
   *
   * They used to be sixty lines here: the F67 allergy re-read at the injection, the
   * `contrast_option: 'none'` study type, and the consent gate that must be terminal. 18a-iii adds
   * a SECOND door through which contrast facts are written (`recordContrastAdministration`, for the
   * injection the abandoned scan never reaches), and two doors asking the safety question
   * separately is how one of them ends up asking a slightly different one. `contrast.ts` carries
   * the code and the argument for each refusal; this call is the only thing that changed here.
   */
  if (contrastGiven) {
    await assertContrastPermissible(tx, study, studyType);
  }
  /**
   * F56 — the CHECK forbids the agent AND the volume; the guard tested only the agent, so
   * `{contrastGiven:false, contrastVolumeMl:50}` passed zod, passed here, and violated
   * `imaging_studies_contrast_ck` at the UPDATE. A PostgresError is not one of `toHttp`'s families,
   * so the technologist got a bare **500** where `contrast_mismatch` (422) naming the field was
   * available — the exact 500-escape `errors.ts` was written to prevent, and which this repository
   * has now shipped four times. The two fields are symmetric in the constraint and were asymmetric
   * in the code.
   */
  if (!contrastGiven && (input.contrastAgent ?? null) !== null) {
    throw new RadiologyError(
      "contrast_mismatch", "a contrast agent was named on a study where contrast was not given",
    );
  }
  if (!contrastGiven && (input.contrastVolumeMl ?? null) !== null) {
    throw new RadiologyError(
      "contrast_mismatch", "a contrast VOLUME was recorded on a study where contrast was not given",
    );
  }

  /** D6 — the pointer and the reason are one fact; the CHECK says so and this names the field. */
  const repeatOf = input.repeatOfStudyId ?? null;
  const repeatReason = input.repeatReason ?? null;
  if ((repeatOf === null) !== (repeatReason === null)) {
    throw new RadiologyError(
      "reason_required", "a repeat exposure carries BOTH the study it repeats and the reason (D6)",
    );
  }

  /** E11 — `lateEntry` is DERIVED from the delta and never typed by a human. */
  const acquiredAt = input.acquiredAt ?? now;
  const lateEntry = Math.abs(now.getTime() - acquiredAt.getTime()) > LATE_ENTRY_MINUTES * 60_000;

  /**
   * A6's CAS. Conditional on the status this call validated against, so two concurrent consoles
   * produce one winner and one `already_acquired` rather than two events and a doubled dose.
   */
  let updated: { id: string }[];
  try {
    updated = await tx.update(imagingStudies)
    .set({
      status: "acquired", acquiredAt, acquiredBy: actor.id, lateEntry,
      imageSource: input.imageSource, ionising, studyInstanceUid,
      doseCtdivol: input.doseCtdivol?.toString() ?? null,
      doseDlp: input.doseDlp?.toString() ?? null,
      doseDap: input.doseDap?.toString() ?? null,
      fluoroSeconds: input.fluoroSeconds ?? null,
      doseManual: input.doseManual ?? false,
      contrastGiven,
      contrastAgent: input.contrastAgent ?? null,
      contrastVolumeMl: input.contrastVolumeMl?.toString() ?? null,
      repeatOfStudyId: repeatOf, repeatReason,
    })
    .where(and(eq(imagingStudies.id, study.id), eq(imagingStudies.status, "in_acquisition")))
    .returning({ id: imagingStudies.id });
  } catch (e) {
    // 18b T2 — `imaging_studies_study_uid_ux`: one DICOM study is one HMIS study, never two.
    if ((e as { code?: unknown }).code === "23505" && studyInstanceUid !== null) {
      throw new RadiologyError(
        "duplicate_study_instance_uid",
        `Study Instance UID ${studyInstanceUid} already names another study — a console that typed `
        + "a UID from the previous patient's screen, or the same DICOM study acquired twice",
        { studyId: study.id, studyInstanceUid },
      );
    }
    throw e;
  }
  if (updated.length === 0) {
    throw new RadiologyError(
      "already_acquired",
      `study ${study.id} was acquired by somebody else while this was being recorded`,
      { studyId: study.id },
    );
  }

  /**
   * ═══ PLAN 18c T3 / D5 — THE AERB DOSE REGISTER, IN THIS TRANSACTION ═══
   *
   * 18a's §6 promised 18c *"a projection of the dose columns"* and 18c's D5 refused the projection:
   * the cath lab (63) records a fluoroscopy dose against a procedure and radiation oncology (64)
   * against a fraction, and a register that JOINED `imaging_studies` would have had one source for
   * ever. So radiology WRITES the row, here, inside the CAS it just won — a dose that was registered
   * and an examination that was not cannot exist separately, and the unique index on
   * `(source, source_ref)` means a retried transaction cannot count the dose twice (A6's own
   * comment: "a double-click double-emits and 18c counts the dose twice").
   *
   * **The comparison is made HERE and stored as a fact**, because this module holds the published
   * reference levels and `aerb` must not read a radiology definition to learn about them. A level
   * republished next year must not change what this examination was measured against.
   *
   * Non-ionising examinations write NO row: an ultrasound has no dose and a register full of zeroes
   * for USG would bury the CTs an RSO is looking for.
   */
  if (ionising) {
    const levels = await activeDoseReferenceLevels(tx);
    /**
     * CLOSE REVIEW — the level is chosen from what this examination actually MEASURED, so a book
     * naming both CTDIvol and DLP for one study type cannot decide the verdict by array order.
     */
    const measuredQuantities = {
      ctdivol: input.doseCtdivol ?? null,
      dlp: input.doseDlp ?? null,
      dap: input.doseDap ?? null,
      fluoro_seconds: input.fluoroSeconds ?? null,
    };
    const level = drlFor(levels, study.studyTypeCode, studyType.modality, measuredQuantities);
    const measured = level === null ? null : measuredQuantities[level.quantity];
    await recordDose(tx, actor, {
      source: "imaging",
      sourceRef: study.id,
      patientId: study.patientId,
      deviceResourceId: study.deviceResourceId,
      modality: studyType.modality,
      procedureCode: study.studyTypeCode,
      doseCtdivol: input.doseCtdivol ?? null,
      doseDlp: input.doseDlp ?? null,
      doseDap: input.doseDap ?? null,
      fluoroSeconds: input.fluoroSeconds ?? null,
      doseManual: input.doseManual ?? false,
      /**
       * A level exists but this examination carried no number of that QUANTITY — a CT with a DLP
       * where the level is set on CTDIvol — is `null`, not `false`. There is nothing to compare,
       * and a verdict of "under" would be a claim nobody measured.
       */
      drl: level === null || measured === null
        ? null
        : { quantity: level.quantity, value: level.value, over: measured > level.value },
      occurredAt: acquiredAt,
    });
  }

  await transition(tx, study.workflowInstanceId, "acquired", actor);
  /**
   * ═══ THE ENVELOPE ITEM IS *NOT* COMPLETED HERE — §6.2 / DD4, AND THE FIRST DRAFT GOT IT WRONG ═══
   *
   * `workflow-def.ts` states the pairing: *"`in_acquisition` is where `advanceOrderItem(…
   * 'in_progress')` fires (the patient is on the table), `published` is where `'completed'` does (a
   * signed report is visible in the app)"*, and §6.2's CONTRACT repeats it for every downstream
   * plan. This function completed the item at ACQUISITION, which closes the doctor's order the
   * moment the images exist and before anybody has read them — an order that reads DONE while the
   * study sits unreported in the radiologist's queue.
   *
   * Caught by T9's §6 confirmation pass rather than by any test, because every test that asserted
   * `completed` did so AFTER a publish, where both behaviours agree. `publishReport` owns it.
   */

  /** A7 — the machine goes back on the diary. Skipping this is the `0036`-class trap m4 exists for. */
  await releaseResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, study.deviceResourceId!, { at: now });

  await appendEvent(tx, imagingStudyAcquired.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: {
      studyId: study.id, accessionNo: study.accessionNo, orderItemId: study.orderItemId,
      serviceId: study.serviceId, contrastGiven, repeatOfStudyId: repeatOf,
      imageSource: input.imageSource, deviceResourceId: study.deviceResourceId!,
      studyInstanceUid,
    },
  }));

  /**
   * ═══ A5 — THE BILL DECISIONS, AND ONLY WHEN A FACT DIVERGED ═══
   *
   * Three of DD12b's four are raised here; the fourth (`performed_then_cancelled`) is T4's
   * `cancelStudy`. `hasBillDecision` guards each one so a redelivery cannot raise a second.
   */
  const billDecisionIds: string[] = [];
  const raise = async (kind: Parameters<typeof raiseBillDecision>[2]["kind"], detail: Record<string, unknown>) => {
    if (await hasBillDecision(tx, study.id, kind)) return;
    const { billDecisionId } = await raiseBillDecision(tx, actor, { studyId: study.id, kind, detail });
    billDecisionIds.push(billDecisionId);
  };

  /** D2 — the with-contrast service was billed and the contrast was not given. */
  if (!contrastGiven && studyType.contrast_option === "required") {
    await raise("contrast_not_given", { studyTypeCode: study.studyTypeCode, serviceId: study.serviceId });
  }
  /** D6 — a repeat exposure is a second scan and usually not a second charge. */
  if (repeatOf !== null) {
    await raise("repeat_no_charge", { repeatOfStudyId: repeatOf, reason: repeatReason });
  }
  /** I1 — images exist and nothing was billed. The `stat` lane is exactly how this happens. */
  if (study.invoiceLineId === null && study.authorisedBy !== "daycare" && study.authorisedBy !== "payer_branch") {
    await raise("acquired_unbilled", { authorisedBy: study.authorisedBy, priority: study.priority });
  }

  return { studyId: study.id, accessionNo: study.accessionNo, studyInstanceUid, billDecisionIds };
}

/**
 * The way back out of acquisition, and it is NOT a cancel: the patient could not tolerate the scan,
 * or the machine faulted mid-series. The study returns to `ready` and keeps its slot, its accession
 * and its gates — `workflow-def.ts` declares that edge for this reason.
 */
export async function abortAcquisition(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: { studyId: string; reason: string; now?: Date },
): Promise<{ studyId: string; status: string }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  if (study.status !== "in_acquisition") {
    throw new RadiologyError(
      "bad_transition", `study ${input.studyId} is ${study.status} and is not on the machine`,
      { studyId: input.studyId, status: study.status },
    );
  }
  if (input.reason.trim() === "") {
    throw new RadiologyError("reason_required", "an aborted acquisition carries a reason");
  }
  await transition(tx, study.workflowInstanceId, "ready", actor, { note: input.reason });
  await tx.update(imagingStudies)
    /**
     * ═══ F53, SECOND PASS — THE ABORT USED TO ERASE THE FACT THAT THE PATIENT WAS ON THE MACHINE ═══
     *
     * This wrote `acquisitionStartedAt: null`, and F53's fix had just made that column the operand
     * for `performed_then_cancelled`. So the clinically natural route for F53's OWN scenario —
     * contrast injected, patient reacts, radiographer clicks **Abort** and then **Cancel** — came
     * out with `fromAcquisition === false` and raised nothing. The counter was never asked whether
     * the patient pays, and the only trace was a workflow note.
     *
     * `acquisition_started_at` means *"this patient went on this machine"*, and an abort does not
     * make that untrue. It is left standing, so a later cancel still knows. A re-start overwrites
     * it with the newer instant, which is the right answer for a study that goes on twice.
     */
    .set({ status: "ready" })
    .where(eq(imagingStudies.id, study.id));
  /**
   * ═══ THE ENVELOPE STAYS `in_progress`, AND THAT IS NOT AN OMISSION ═══
   *
   * The first draft rolled the item back to `placed` and the kernel refused it: the item machine has
   * no `in_progress → placed` edge, by design. That refusal is the right answer rather than an
   * obstacle. An abort is not the department giving the order back — the patient is still on the
   * list, the slot is still held, the accession is unchanged, and the scan is about to be retried.
   * *"The department is working on this order"* has been true throughout, and the envelope should go
   * on saying so.
   *
   * What DOES move is the study and the machine: `ready` again, and the device released, so somebody
   * else can use the room while this patient is settled. Abandoning the scan for good is
   * `cancelStudy` (T4), which is the transition that carries a reason to the envelope.
   */
  await releaseResource(tx, actor, RADIOLOGY_RESOURCE_KINDS, study.deviceResourceId!, {
    at: now, reason: input.reason,
  });
  return { studyId: study.id, status: "ready" };
}
