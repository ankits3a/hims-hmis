import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../src/kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterAssignments, rosterPeriods, users,
} from "../../src/kernel/db/schema";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../src/kernel/resources";
import { seedOrgDepartments, seedRosterPositions } from "../../src/modules/roster";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";

/**
 * E0.1 TASK ENGINE — a small hospital for the task tests: three support staff, two services
 * supervisors, a floor with two rooms, and a published roster the test fills with duties. Every
 * instant is relative to the caller's `t0` (taken from the real clock by the test), never a pinned date.
 */
export const W1 = "01TASKWORKER0000000000000W1";
export const W2 = "01TASKWORKER0000000000000W2";
export const W3 = "01TASKWORKER0000000000000W3";
export const SUP1 = "01TASKSUPERVISOR00000000S1";
export const SUP2 = "01TASKSUPERVISOR00000000S2";
export const actorOf = (id: string): Actor => ({ type: "user", id });
const SEEDER: Actor = { type: "system", id: "tasks-fixture" };

export type TaskHospital = { floorId: string; roomA: string; roomB: string; periodId: string; departmentId: string };

export const minutes = (t0: Date, m: number): Date => new Date(t0.getTime() + m * 60_000);

/** Round the real clock down to a whole minute, so windows read cleanly. */
export const clockNow = (): Date => new Date(Math.floor(Date.now() / 60_000) * 60_000);

export async function seedTaskHospital(db: Db, t0: Date): Promise<TaskHospital> {
  await db.insert(roles).values([
    { key: "support_staff", title: "Support Staff" },
    { key: "services_supervisor", title: "Services Supervisor" },
    // The roles the roster's position master names (`seedRosterPositions` refuses without them).
    ...["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"].map((key) => ({ key, title: key })),
  ]).onConflictDoNothing();
  await db.insert(permissions).values(["tasks.view", "tasks.work", "tasks.supervise"].map((permission) => ({ permission, module: "tasks" })))
    .onConflictDoNothing();
  await db.insert(rolePermissions).values([
    { roleKey: "support_staff", permission: "tasks.work" },
    { roleKey: "services_supervisor", permission: "tasks.view" },
    { roleKey: "services_supervisor", permission: "tasks.work" },
    { roleKey: "services_supervisor", permission: "tasks.supervise" },
  ]).onConflictDoNothing();
  for (const [id, name] of [[W1, "worker.one"], [W2, "worker.two"], [W3, "worker.three"], [SUP1, "sup.one"], [SUP2, "sup.two"]] as const) {
    await db.insert(users).values({ id, username: name, fullName: name, staffCode: `T-${id.slice(-4)}`, passwordHash: "x" });
  }
  await db.insert(roleAssignments).values([
    { id: "RA-T-W1", userId: W1, roleKey: "support_staff", scopeType: "hospital", scopeId: null },
    { id: "RA-T-W2", userId: W2, roleKey: "support_staff", scopeType: "hospital", scopeId: null },
    { id: "RA-T-W3", userId: W3, roleKey: "support_staff", scopeType: "hospital", scopeId: null },
    { id: "RA-T-S1", userId: SUP1, roleKey: "services_supervisor", scopeType: "hospital", scopeId: null },
    { id: "RA-T-S2", userId: SUP2, roleKey: "services_supervisor", scopeType: "hospital", scopeId: null },
  ]);

  const { floorId, roomA, roomB } = await withTx(db, async (tx) => {
    const floor = await createResource(tx, SEEDER, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F2", name: "Floor 2" });
    const a = await createResource(tx, SEEDER, KERNEL_RESOURCE_KINDS, { kind: "room", code: "201", name: "Room 201", parentId: floor.resourceId });
    const b = await createResource(tx, SEEDER, KERNEL_RESOURCE_KINDS, { kind: "room", code: "202", name: "Room 202", parentId: floor.resourceId });
    return { floorId: floor.resourceId, roomA: a.resourceId, roomB: b.resourceId };
  });

  await seedOrgDepartments(db);
  await seedRosterPositions(db);
  const departmentId = (await db.select({ id: orgDepartments.id }).from(orgDepartments).limit(1))[0]!.id;
  const periodId = newId();
  await db.insert(rosterPeriods).values({
    id: periodId, scopeType: "department", scopeId: departmentId, departmentId, title: "Support staff",
    startsAt: minutes(t0, -24 * 60), endsAt: minutes(t0, 24 * 60), version: 1, status: "published",
    coversPositions: ["staff_nurse"], publishedAt: t0, publishedBy: SUP1, contentHash: "fixture", createdBy: SUP1, updatedBy: SUP1,
  });
  return { floorId, roomA, roomB, periodId, departmentId };
}

/** A published presence duty for `userId` from `from` to `to` (minutes relative to t0). */
export async function putOnDuty(db: Db, h: TaskHospital, userId: string, from: Date, to: Date): Promise<string> {
  const id = newId();
  await db.insert(rosterAssignments).values({
    id, periodId: h.periodId, userId, positionKey: "staff_nurse", startsAt: from, endsAt: to, mode: "presence", kind: "duty",
    departmentId: h.departmentId, coverScope: "department", effective: true, lineageId: id,
    proposedByActorId: SUP1, createdBy: SUP1, updatedBy: SUP1,
  });
  return id;
}

export async function userName(db: Db, id: string): Promise<string> {
  return (await db.select({ n: users.fullName }).from(users).where(eq(users.id, id)))[0]!.n;
}
