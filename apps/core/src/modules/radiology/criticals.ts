import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  imagingCriticalCallAttempts, imagingCriticalFindings, imagingReports,
} from "../../kernel/db/schema/radiology";
import { users } from "../../kernel/db/schema/auth";
import { RadiologyError } from "./errors";
import { imagingCriticalAcknowledged, imagingCriticalFlagged } from "./events";
import { findingOf, readBackNamesFinding } from "./critical-ladder";
import { assertFreeTextSignable } from "./report-authoring";
import type { ImagingCriticalCategory } from "../../kernel/db/schema/radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * DD15 — **THE CRITICALS: raised at the signature or after it, closed by the clinician's read-back.**
 *
 * #1077 — split out of `reports.ts`. `report-signature.ts` raises the critical a signature, co-sign
 * or amendment carries (`flagCritical`, idempotent per report); the reading room's route raises one
 * after the fact; the reading room and the doctor's own read-back (`closed-loop.ts`) close it
 * through `acknowledgeCritical`. The ladder between the two is `critical-ladder.ts`.
 */

/**
 * A `red` finding pages a human. 18a-iii's Critical Chaser is the consumer that will not let it
 * rest; this phase records the fact and the clock so that ladder has history to tune against.
 */
export async function flagCritical(
  tx: Tx,
  actor: Actor,
  input: { reportId: string; category: ImagingCriticalCategory; communicatedTo?: string | null; now?: Date },
): Promise<{ criticalId: string }> {
  const rows = await (tx as unknown as Db).select().from(imagingReports)
    .where(eq(imagingReports.id, input.reportId));
  const report = rows[0];
  if (!report) throw new RadiologyError("unknown_study", `no report ${input.reportId}`);

  /**
   * F69 — IDEMPOTENT PER REPORT. `signReport` now raises the critical itself, and this route stays
   * for a category raised after the fact; two paths writing one fact must not be able to produce
   * two rows for one finding, or 18a-iii's chaser chases the same haematoma twice and the second
   * acknowledgement closes a loop nobody opened.
   */
  const already = await (tx as unknown as Db).select({ id: imagingCriticalFindings.id })
    .from(imagingCriticalFindings).where(eq(imagingCriticalFindings.reportId, report.id));
  if (already[0]) return { criticalId: already[0].id };

  /**
   * F79 — the free text a critical carries is checked against the lockout like any other report
   * text. `communicatedTo` is stored and travels in the event payload.
   */
  await assertFreeTextSignable(tx, report.studyId, input.communicatedTo ?? "");

  const criticalId = newId();
  await tx.insert(imagingCriticalFindings).values({
    id: criticalId,
    reportId: report.id,
    category: input.category,
    communicatedTo: input.communicatedTo ?? null,
    communicatedAt: input.communicatedTo === undefined || input.communicatedTo === null
      ? null : (input.now ?? new Date()),
  });
  await appendEvent(tx, imagingCriticalFlagged.make({
    actor,
    payload: {
      reportId: report.id, studyId: report.studyId, category: input.category,
      communicatedTo: input.communicatedTo ?? null,
    },
  }));
  return { criticalId };
}

/**
 * ═══ F76 (CLOSE REVIEW) — THE LOOP IS CLOSED BY THE CLINICIAN, NOT BY WHOEVER TYPED IT ═══
 *
 * The first version wrote `acknowledgedBy: actor.id` and had no field for the person who actually
 * received the call. `radiology.criticals.ack` is granted to `radiologist` alone, so
 * `acknowledged_by` was structurally always a radiologist and usually the signer — the loop closed
 * at both ends by one person, and `imaging.critical_acknowledged` told 18a-iii's chaser that the
 * finding *"reached a human"*. `reports.test.ts` pinned that as correct: it flagged and acknowledged
 * as the same radiologist and asserted the identity, so an implementation that refused a
 * self-acknowledgement would have failed the suite.
 *
 * Now: `acknowledgedByClinicianId` is REQUIRED and names the clinician who read the finding back;
 * the actor who recorded it is kept separately as `recordedBy`. **The clinician may not be the
 * report's signer** — a radiologist telephoning themselves is not a communication. The actor may
 * still be the radiologist, because at 02:10 the radiologist is who is at a keyboard.
 */
export async function acknowledgeCritical(
  tx: Tx,
  actor: Actor,
  input: {
    criticalId: string;
    /** F76 — the clinician who received the call and repeated it back. */
    acknowledgedByClinicianId: string;
    readBack?: string | null;
    now?: Date;
  },
): Promise<{ criticalId: string; acknowledgedAt: Date }> {
  const rows = await (tx as unknown as Db).select().from(imagingCriticalFindings)
    .where(eq(imagingCriticalFindings.id, input.criticalId));
  const critical = rows[0];
  if (!critical) throw new RadiologyError("unknown_study", `no critical finding ${input.criticalId}`);
  if (critical.acknowledgedAt !== null) {
    throw new RadiologyError("already_signed", `critical ${input.criticalId} is already acknowledged`);
  }
  /** DD15 — `red` demands a READ-BACK; the other two are satisfied by an acknowledgement. */
  if (critical.category === "red" && (input.readBack === undefined || input.readBack === null || input.readBack.trim() === "")) {
    throw new RadiologyError(
      "reason_required",
      "a RED critical is acknowledged with a read-back — the clinician repeats the finding in their own words",
      { criticalId: input.criticalId },
    );
  }
  /** The table hangs off the REPORT; the study comes from it, which keeps one owner for the link. */
  const reportRows = await (tx as unknown as Db)
    .select({
      studyId: imagingReports.studyId, signerId: imagingReports.signerId,
      impression: imagingReports.impression, body: imagingReports.body,
    })
    .from(imagingReports).where(eq(imagingReports.id, critical.reportId));
  const report = reportRows[0]!;

  /**
   * ═══ F76, SECOND PASS — A NAMED PERSON WHO DOES NOT EXIST IS NOT A CLINICIAN ═══
   *
   * The first fix separated WHO received the call from WHO typed it, and then validated the
   * clinician against exactly one thing: that they are not the signer. `acknowledged_by` is plain
   * `text` with no foreign key, so `{"acknowledgedByClinicianId": "x"}` wrote the row, emitted
   * `imaging.critical_acknowledged` naming `"x"`, and stopped 18a-iii's chaser — *"did this reach a
   * human"* answered by a string nobody typed a name into.
   *
   * The argument is F64's, one commit old and in this same phase: *"a named person who does not
   * exist is not a chaperone; it is a field that was filled in."* It applies with more force to the
   * person who received a red critical.
   */
  const clinician = await (tx as unknown as Db)
    .select({ id: users.id, active: users.active })
    .from(users).where(eq(users.id, input.acknowledgedByClinicianId));
  if (!clinician[0]) {
    throw new RadiologyError(
      "evidence_invalid",
      `${input.acknowledgedByClinicianId} is not a user of this hospital — a critical is read back `
      + "by a person, and the record of who has to name one",
      { acknowledgedByClinicianId: input.acknowledgedByClinicianId },
    );
  }
  if (clinician[0].active === false) {
    throw new RadiologyError(
      "evidence_invalid",
      `${input.acknowledgedByClinicianId} is not an active member of staff`,
      { acknowledgedByClinicianId: input.acknowledgedByClinicianId },
    );
  }

  /** F76 — the signer telephoning themselves is not a read-back. */
  if (input.acknowledgedByClinicianId === report.signerId) {
    throw new RadiologyError(
      "evidence_invalid",
      "the report's own signer cannot be the clinician who received the critical — a read-back is a "
      + "communication to somebody else",
      { criticalId: input.criticalId, signerId: report.signerId },
    );
  }
  /** F79 — the read-back is the likeliest place in the system for a verbatim sex disclosure. */
  await assertFreeTextSignable(tx, report.studyId, input.readBack ?? "");

  /**
   * ═══ 18-S RS8b — THE READ-BACK NAMES THE FINDING ═══
   *
   * The board closes a critical call "only on a correct read-back". Until now any non-empty text
   * closed a red call — "noted" was a read-back. The clinician's words must now name what the report
   * found (`critical-ladder.ts` `readBackNamesFinding`): a critical term the report states, or a word
   * of its impression. Every path that closes a call comes through here, so the doctor's own
   * read-back (RS9) meets the same rule.
   */
  const readBack = input.readBack?.trim() ?? "";
  if (readBack !== "" && !readBackNamesFinding(readBack, findingOf(report))) {
    throw new RadiologyError(
      "read_back_mismatch",
      "the read-back does not name the finding — ask the clinician to repeat what the report found, in their own "
      + "words, and type what they said",
      { criticalId: input.criticalId },
    );
  }

  const acknowledgedAt = input.now ?? new Date();
  await tx.update(imagingCriticalFindings)
    .set({
      acknowledgedBy: input.acknowledgedByClinicianId,
      recordedBy: actor.id,
      acknowledgedAt,
      readBackText: input.readBack ?? null,
    })
    .where(eq(imagingCriticalFindings.id, input.criticalId));
  /** 18-S RS8b — the closing call is the ladder's last row: who read it back, on which rung. */
  await tx.insert(imagingCriticalCallAttempts).values({
    id: newId(), criticalId: critical.id, rung: critical.ladderRung,
    calledUserId: input.acknowledgedByClinicianId, calledName: null,
    outcome: "read_back_ok", recordedBy: actor.id, at: acknowledgedAt,
  });
  await appendEvent(tx, imagingCriticalAcknowledged.make({
    actor,
    payload: {
      reportId: critical.reportId, studyId: report.studyId,
      category: critical.category, acknowledgedBy: input.acknowledgedByClinicianId,
    },
  }));
  return { criticalId: input.criticalId, acknowledgedAt };
}
