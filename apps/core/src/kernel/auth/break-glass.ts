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

export async function hasActiveBreakGlass(db: Db, userId: string, patientId?: string): Promise<boolean> {
  const rows = await db
    .select({ patientId: breakGlassGrants.patientId })
    .from(breakGlassGrants)
    .where(and(eq(breakGlassGrants.userId, userId), gt(breakGlassGrants.expiresAt, new Date())));
  return rows.some((g) => g.patientId === null || (patientId !== undefined && g.patientId === patientId));
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
