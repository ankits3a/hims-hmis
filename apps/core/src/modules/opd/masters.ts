import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { opdDepartments, opdDoctors, opdRooms, users } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type DepartmentRow = typeof opdDepartments.$inferSelect;
export type RoomRow = typeof opdRooms.$inferSelect;
export type DoctorRow = typeof opdDoctors.$inferSelect;

function requireUserActor(actor: Actor): void {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "only a user actor may write OPD masters");
}

export async function createDepartment(tx: Tx, actor: Actor, input: { code: string; name: string }): Promise<{ departmentId: string }> {
  requireUserActor(actor);
  const id = newId();
  const rows = await tx
    .insert(opdDepartments)
    .values({ id, code: input.code, name: input.name, createdBy: actor.id, updatedBy: actor.id })
    .onConflictDoNothing({ target: opdDepartments.code })
    .returning({ id: opdDepartments.id });
  if (rows.length === 0) throw new OpdError("duplicate_department_code", `department code "${input.code}" already exists`);
  return { departmentId: id };
}

export async function updateDepartment(tx: Tx, actor: Actor, id: string, patch: { name?: string; active?: boolean }): Promise<void> {
  requireUserActor(actor);
  const existing = await tx.select().from(opdDepartments).where(eq(opdDepartments.id, id));
  if (!existing[0]) throw new OpdError("unknown_department", `department ${id} not found`);
  await tx.update(opdDepartments).set({ ...patch, updatedBy: actor.id, updatedAt: new Date() }).where(eq(opdDepartments.id, id));
}

export async function listDepartments(db: Db, opts: { activeOnly?: boolean } = {}): Promise<DepartmentRow[]> {
  const rows = await db.select().from(opdDepartments).orderBy(opdDepartments.name);
  return opts.activeOnly ? rows.filter((r) => r.active) : rows;
}

export async function createRoom(tx: Tx, actor: Actor, input: { code: string; name: string; floor?: string }): Promise<{ roomId: string }> {
  requireUserActor(actor);
  const id = newId();
  const rows = await tx
    .insert(opdRooms)
    .values({ id, code: input.code, name: input.name, floor: input.floor ?? null, createdBy: actor.id, updatedBy: actor.id })
    .onConflictDoNothing({ target: opdRooms.code })
    .returning({ id: opdRooms.id });
  if (rows.length === 0) throw new OpdError("duplicate_room_code", `room code "${input.code}" already exists`);
  return { roomId: id };
}

export async function updateRoom(tx: Tx, actor: Actor, id: string, patch: { name?: string; floor?: string | null; active?: boolean }): Promise<void> {
  requireUserActor(actor);
  const existing = await tx.select().from(opdRooms).where(eq(opdRooms.id, id));
  if (!existing[0]) throw new OpdError("unknown_room", `room ${id} not found`);
  await tx.update(opdRooms).set({ ...patch, updatedBy: actor.id, updatedAt: new Date() }).where(eq(opdRooms.id, id));
}

export async function listRooms(db: Db, opts: { activeOnly?: boolean } = {}): Promise<RoomRow[]> {
  const rows = await db.select().from(opdRooms).orderBy(opdRooms.code);
  return opts.activeOnly ? rows.filter((r) => r.active) : rows;
}

export async function createDoctor(
  tx: Tx,
  actor: Actor,
  input: { username: string; displayName: string; registrationNo?: string; departmentId: string; specialty?: string },
): Promise<{ doctorId: string; userId: string }> {
  requireUserActor(actor);
  const userRows = await tx.select().from(users).where(eq(users.username, input.username));
  const user = userRows[0];
  if (!user) throw new OpdError("unknown_user", `no user with username "${input.username}"`);

  const deptRows = await tx.select().from(opdDepartments).where(eq(opdDepartments.id, input.departmentId));
  const dept = deptRows[0];
  if (!dept) throw new OpdError("unknown_department", `department ${input.departmentId} not found`);
  if (!dept.active) throw new OpdError("department_inactive", `department ${input.departmentId} is inactive`);

  const id = newId();
  const rows = await tx
    .insert(opdDoctors)
    .values({
      id,
      userId: user.id,
      displayName: input.displayName,
      registrationNo: input.registrationNo ?? null,
      departmentId: input.departmentId,
      specialty: input.specialty ?? null,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    .onConflictDoNothing({ target: opdDoctors.userId })
    .returning({ id: opdDoctors.id });
  if (rows.length === 0) throw new OpdError("user_already_doctor", `user "${input.username}" already has a doctor profile`);
  return { doctorId: id, userId: user.id };
}

export async function updateDoctor(
  tx: Tx,
  actor: Actor,
  id: string,
  patch: { displayName?: string; registrationNo?: string | null; departmentId?: string; specialty?: string | null; active?: boolean },
): Promise<void> {
  requireUserActor(actor);
  const existing = await tx.select().from(opdDoctors).where(eq(opdDoctors.id, id));
  if (!existing[0]) throw new OpdError("unknown_doctor", `doctor ${id} not found`);
  if (patch.departmentId !== undefined) {
    const deptRows = await tx.select().from(opdDepartments).where(eq(opdDepartments.id, patch.departmentId));
    const dept = deptRows[0];
    if (!dept) throw new OpdError("unknown_department", `department ${patch.departmentId} not found`);
    if (!dept.active) throw new OpdError("department_inactive", `department ${patch.departmentId} is inactive`);
  }
  await tx.update(opdDoctors).set({ ...patch, updatedBy: actor.id, updatedAt: new Date() }).where(eq(opdDoctors.id, id));
}

export async function listDoctors(db: Db, opts: { departmentId?: string; activeOnly?: boolean } = {}): Promise<DoctorRow[]> {
  const rows = await db.select().from(opdDoctors).orderBy(opdDoctors.displayName);
  return rows.filter(
    (r) => (opts.departmentId === undefined || r.departmentId === opts.departmentId) && (!opts.activeOnly || r.active),
  );
}

export async function getDoctor(db: Db, id: string): Promise<DoctorRow | null> {
  const rows = await db.select().from(opdDoctors).where(eq(opdDoctors.id, id));
  return rows[0] ?? null;
}

export async function doctorForUser(db: Db | Tx, userId: string): Promise<DoctorRow | null> {
  const rows = await db.select().from(opdDoctors).where(eq(opdDoctors.userId, userId));
  return rows[0] ?? null;
}
