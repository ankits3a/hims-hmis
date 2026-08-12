import { and, eq, isNull, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { tempRoleGrants } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { emergencyElevationUsed, tempRoleGranted, tempRoleExpired } from "./events";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export async function grantTempRole(
  db: Db,
  cfg: AppConfig,
  grantor: Actor,
  input: { userId: string; roleKey: string; reason: string; ttlMinutes: number },
): Promise<{ grantId: string; expiresAt: Date }> {
  if (grantor.type === "user" && grantor.id === input.userId) {
    throw new Error("self-grant is not allowed here — use emergencyElevate, which events emergency_elevation.used");
  }
  const ttl = Math.min(input.ttlMinutes, cfg.tempRoleMaxTtlMinutes);
  const grantId = newId();
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  await withTx(db, async (tx) => {
    await tx.insert(tempRoleGrants).values({
      id: grantId, userId: input.userId, roleKey: input.roleKey,
      grantedBy: grantor.id, kind: "granted", reason: input.reason, expiresAt,
    });
    await appendEvent(
      tx,
      tempRoleGranted.make({
        actor: grantor,
        payload: {
          grantId, userId: input.userId, roleKey: input.roleKey,
          grantedBy: grantor.id, kind: "granted", reason: input.reason,
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );
  });
  return { grantId, expiresAt };
}

export async function emergencyElevate(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  input: { roleKey: string; reason: string; ttlMinutes: number },
): Promise<{ grantId: string; expiresAt: Date }> {
  const ttl = Math.min(input.ttlMinutes, cfg.tempRoleMaxTtlMinutes);
  const grantId = newId();
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  await withTx(db, async (tx) => {
    await tx.insert(tempRoleGrants).values({
      id: grantId, userId: actor.id, roleKey: input.roleKey,
      grantedBy: actor.id, kind: "emergency", reason: input.reason, expiresAt,
    });
    await appendEvent(
      tx,
      emergencyElevationUsed.make({
        actor,
        payload: { grantId, roleKey: input.roleKey, reason: input.reason, expiresAt: expiresAt.toISOString() },
      }),
    );
    await appendEvent(
      tx,
      tempRoleGranted.make({
        actor,
        payload: {
          grantId, userId: actor.id, roleKey: input.roleKey,
          grantedBy: actor.id, kind: "emergency", reason: input.reason,
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );
  });
  return { grantId, expiresAt };
}

export async function sweepExpiredTempRoles(db: Db): Promise<number> {
  const due = await db
    .select()
    .from(tempRoleGrants)
    .where(and(lte(tempRoleGrants.expiresAt, new Date()), isNull(tempRoleGrants.expiredEventAt)));
  for (const grant of due) {
    await withTx(db, async (tx) => {
      await appendEvent(
        tx,
        tempRoleExpired.make({
          actor: { type: "system", id: "temp-role-sweep" },
          payload: { grantId: grant.id, userId: grant.userId, roleKey: grant.roleKey },
        }),
      );
      await tx.update(tempRoleGrants).set({ expiredEventAt: new Date() }).where(eq(tempRoleGrants.id, grant.id));
    });
  }
  return due.length;
}
