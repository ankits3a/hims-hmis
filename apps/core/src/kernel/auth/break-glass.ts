import { and, eq, gt, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { breakGlassGrants } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { breakGlassUsed } from "./events";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export async function useBreakGlass(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  input: { patientId?: string; reason: string },
): Promise<{ grantId: string; expiresAt: Date }> {
  const grantId = newId();
  const expiresAt = new Date(Date.now() + cfg.breakGlassTtlMinutes * 60_000);
  await withTx(db, async (tx) => {
    await tx.insert(breakGlassGrants).values({
      id: grantId,
      userId: actor.id,
      patientId: input.patientId ?? null,
      reason: input.reason,
      expiresAt,
    });
    await appendEvent(
      tx,
      breakGlassUsed.make({
        actor,
        patientId: input.patientId,
        payload: { grantId, patientId: input.patientId, reason: input.reason, expiresAt: expiresAt.toISOString() },
      }),
    );
  });
  return { grantId, expiresAt };
}

/**
 * PLAN 07a T3 — the grant ITSELF, not just its existence.
 *
 * `hasActiveBreakGlass` answers "may they"; this answers "and under what stated justification",
 * which is the half the PHI access log needs. A break-glass read that records no reason is a read
 * whose only defence is that somebody clicked a button.
 *
 * A grant with a NULL `patient_id` is hospital-wide — the shape a night emergency actually takes,
 * where the person needing the record cannot always name the patient id first. Expiry is enforced
 * here rather than by a sweep, so a lapsed grant stops working at the instant it lapses.
 */
export async function activeBreakGlass(
  db: Db, userId: string, patientId?: string,
): Promise<{ id: string; reason: string } | null> {
  const rows = await db
    .select({ id: breakGlassGrants.id, patientId: breakGlassGrants.patientId, reason: breakGlassGrants.reason })
    .from(breakGlassGrants)
    .where(and(eq(breakGlassGrants.userId, userId), gt(breakGlassGrants.expiresAt, new Date())));
  // A patient-scoped grant is preferred over a hospital-wide one: it is the more specific
  // justification, and it is the one a reviewer wants quoted back to them.
  const scoped = rows.find((g) => patientId !== undefined && g.patientId === patientId);
  const wide = rows.find((g) => g.patientId === null);
  const hit = scoped ?? wide;
  return hit ? { id: hit.id, reason: hit.reason } : null;
}

export async function hasActiveBreakGlass(db: Db, userId: string, patientId?: string): Promise<boolean> {
  return (await activeBreakGlass(db, userId, patientId)) !== null;
}

export type BreakGlassReviewItem = {
  id: string; userId: string; patientId: string | null; reason: string; createdAt: Date; expiresAt: Date;
};

export async function pendingReviews(db: Db): Promise<BreakGlassReviewItem[]> {
  return db
    .select({
      id: breakGlassGrants.id,
      userId: breakGlassGrants.userId,
      patientId: breakGlassGrants.patientId,
      reason: breakGlassGrants.reason,
      createdAt: breakGlassGrants.createdAt,
      expiresAt: breakGlassGrants.expiresAt,
    })
    .from(breakGlassGrants)
    .where(isNull(breakGlassGrants.reviewedAt))
    .orderBy(breakGlassGrants.createdAt);
}

export async function recordReview(db: Db, grantId: string, reviewer: Actor, note: string): Promise<void> {
  await db
    .update(breakGlassGrants)
    .set({ reviewedAt: new Date(), reviewedBy: reviewer.id, reviewNote: note })
    .where(eq(breakGlassGrants.id, grantId));
}
