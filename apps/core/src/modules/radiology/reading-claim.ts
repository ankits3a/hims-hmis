import { and, eq, inArray } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { users } from "../../kernel/db/schema/auth";
import { RadiologyError } from "./errors";
import { imagingReadingClaimed } from "./events";
import { CLAIM_WINDOW_MS, READING_WRITE } from "./reading";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * #1081 — **"DR X IS READING", WITHOUT A PACS; AND A STUDY GIVEN TO A NAMED READER.**
 *
 * ═══ THE CLAIM IS A LABEL, NOT A LOCK ═══
 *
 * Before #1081 the label was derived only from the image-view log, which only `openImages` writes and
 * which needs a published viewer — so a hospital without a PACS never saw it. Now opening a study in
 * the reading room claims it: `reading_claimed_by` and `reading_claimed_at` on the study, and the event
 * `imaging.reading_claimed`. The reader's autosave refreshes their own claim (`autosaveDraft`). It lapses
 * 60 minutes after it was last written and ends at signature (the reads stop showing it).
 *
 * A live claim by somebody else is NOT taken by opening (DECIDED: a glance at a study must not move the
 * label off the radiologist actually reading it — the standard RIS "locked by" behaviour). The screen
 * shows "Dr X is reading" with one Take over tap, which is `takeOver: true` here, and the event names
 * who was there. Nothing is refused: a second reader may always read, draft and sign.
 *
 * Events are appended for a new claim and a take-over, never for a reader refreshing their own live
 * claim (one row per open would bury the hand-overs the log exists to show).
 */

/** Studies a reader can claim: the images are in and no report has been signed. */
const CLAIMABLE_STATUSES = ["acquired", "reported"];
const SIGNED_STATUSES = ["signed", "awaiting_cosign", "superseded", "amended"];

export type ClaimResult = {
  claimed: boolean;
  /** A live claim by somebody else that this call did not take (no `takeOver`). */
  heldBy: { userId: string; name: string; since: Date } | null;
  /** Who held it before this claim — named in the event; null for a fresh claim or one's own. */
  previousReaderId: string | null;
};

async function assertReader(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user") throw new RadiologyError("forbidden", `a ${actor.type} actor does not read images`);
  if (!(await hasPermission(exec, actor.id, READING_WRITE, "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${READING_WRITE}`);
  }
}

export async function claimReading(
  tx: Tx, actor: Actor, input: { studyId: string; now?: Date; takeOver?: boolean },
): Promise<ClaimResult> {
  await assertReader(tx, actor);
  const now = input.now ?? new Date();
  /** The row lock orders two readers opening one study at the same instant: one claims, one sees it held. */
  const [study] = await (tx as unknown as Db).select({
    id: imagingStudies.id, patientId: imagingStudies.patientId, encounterNo: imagingStudies.encounterNo,
    status: imagingStudies.status, claimedBy: imagingStudies.readingClaimedBy, claimedAt: imagingStudies.readingClaimedAt,
  }).from(imagingStudies).where(eq(imagingStudies.id, input.studyId)).for("update");
  if (!study) throw new RadiologyError("unknown_study", `no study ${input.studyId}`, { studyId: input.studyId });

  const none: ClaimResult = { claimed: false, heldBy: null, previousReaderId: null };
  if (!CLAIMABLE_STATUSES.includes(study.status)) return none;
  const signed = await (tx as unknown as Db).select({ id: imagingReports.id }).from(imagingReports)
    .where(and(eq(imagingReports.studyId, study.id), inArray(imagingReports.status, SIGNED_STATUSES))).limit(1);
  if (signed.length > 0) return none;

  const live = study.claimedBy !== null && study.claimedAt !== null
    && now.getTime() - study.claimedAt.getTime() < CLAIM_WINDOW_MS;
  if (live && study.claimedBy === actor.id) {
    await tx.update(imagingStudies).set({ readingClaimedAt: now }).where(eq(imagingStudies.id, study.id));
    return { claimed: true, heldBy: null, previousReaderId: null };
  }
  if (live && input.takeOver !== true) {
    const [who] = await (tx as unknown as Db).select({ name: users.fullName }).from(users).where(eq(users.id, study.claimedBy!));
    return { claimed: false, heldBy: { userId: study.claimedBy!, name: who?.name ?? study.claimedBy!, since: study.claimedAt! }, previousReaderId: null };
  }

  const previousReaderId = study.claimedBy !== null && study.claimedBy !== actor.id ? study.claimedBy : null;
  await tx.update(imagingStudies).set({ readingClaimedBy: actor.id, readingClaimedAt: now })
    .where(eq(imagingStudies.id, study.id));
  await appendEvent(tx, imagingReadingClaimed.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: { studyId: study.id, readerId: actor.id, previousReaderId, tookOver: live },
    correlationId: study.id, occurredAt: now,
  }));
  return { claimed: true, heldBy: null, previousReaderId };
}

/** The consultant's grant (`radiology.reports.amend`) — the spec adds no permission for assignment. */
export const ASSIGN_PERMISSION = "radiology.reports.amend";

/**
 * A consultant gives a study to a named reader, or takes it back (`readerId: null`). The study then
 * sits on that reader's "my list" whatever its pool. The reader must be somebody who writes reports.
 */
export async function assignReader(
  tx: Tx, actor: Actor, input: { studyId: string; readerId: string | null; now?: Date },
): Promise<{ studyId: string; assignedReaderId: string | null }> {
  if (actor.type !== "user") throw new RadiologyError("forbidden", `a ${actor.type} actor does not assign studies`);
  if (!(await hasPermission(tx, actor.id, ASSIGN_PERMISSION, "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${ASSIGN_PERMISSION}`);
  }
  const [study] = await (tx as unknown as Db).select({ id: imagingStudies.id }).from(imagingStudies)
    .where(eq(imagingStudies.id, input.studyId)).for("update");
  if (!study) throw new RadiologyError("unknown_study", `no study ${input.studyId}`, { studyId: input.studyId });
  if (input.readerId !== null) {
    const [person] = await (tx as unknown as Db).select({ id: users.id }).from(users).where(eq(users.id, input.readerId));
    if (!person || !(await hasPermission(tx, input.readerId, READING_WRITE, "hospital"))) {
      throw new RadiologyError(
        "not_a_reader", `${input.readerId} does not write imaging reports — a study is assigned to a reader`,
        { readerId: input.readerId },
      );
    }
  }
  await tx.update(imagingStudies).set({ assignedReaderId: input.readerId }).where(eq(imagingStudies.id, study.id));
  return { studyId: study.id, assignedReaderId: input.readerId };
}
