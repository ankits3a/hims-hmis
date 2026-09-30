import { and, eq, gt, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { breakGlassGrants } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { breakGlassUsed, sodViolationBlocked } from "./events";
import { SodViolationError } from "./sod";
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

/**
 * DECIDED 2026-09-28 (standard separation of duties) — nobody reviews their own break-glass. Since
 * the owner ruling of the same day the Medical Superintendent holds both `auth.break_glass.use`
 * and `.review`, so without this the person who opened a sealed record could also clear the review.
 *
 * `assertNotSodPair` is NOT used: it refuses unless the pair is a seeded `sod_pairs` row, and a
 * review route must not start failing on a deployment whose SoD seed has not been re-run. The
 * refusal takes the same shape instead — the `sod.violation_blocked` event in its own transaction,
 * then `SodViolationError` — so every controller that already maps that error maps this one.
 */
const BREAK_GLASS_SOD_PAIR = "break_glass_user_reviewer";

export async function recordReview(db: Db, grantId: string, reviewer: Actor, note: string): Promise<void> {
  const [grant] = await db
    .select({ userId: breakGlassGrants.userId })
    .from(breakGlassGrants)
    .where(eq(breakGlassGrants.id, grantId));
  if (grant !== undefined && reviewer.type === "user" && grant.userId === reviewer.id) {
    await withTx(db, (tx) =>
      appendEvent(
        tx,
        sodViolationBlocked.make({
          actor: reviewer,
          payload: {
            pairKey: BREAK_GLASS_SOD_PAIR,
            actorAType: "user",
            actorAId: grant.userId,
            actorBType: reviewer.type,
            actorBId: reviewer.id,
          },
        }),
      ),
    );
    throw new SodViolationError(BREAK_GLASS_SOD_PAIR);
  }
  await db
    .update(breakGlassGrants)
    .set({ reviewedAt: new Date(), reviewedBy: reviewer.id, reviewNote: note })
    .where(eq(breakGlassGrants.id, grantId));
}
