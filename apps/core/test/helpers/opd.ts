import { eq } from "drizzle-orm";
import { createUser } from "../../src/kernel/auth/identity";
import { createSession } from "../../src/kernel/auth/sessions";
import { assignRole } from "../../src/kernel/auth/permissions";
import { registrationConfig, roles, opdConfig, opdDepartments, opdDoctors, opdDoctorSchedules, opdRooms } from "../../src/kernel/db/schema";
import { withTx } from "../../src/kernel/db/client";
import { loadConfig } from "../../src/kernel/config";
import { newId } from "@hmis/contracts";
import { registerPatient } from "../../src/modules/patients";
import { DEFAULT_DANGER_RANGES, DEFAULT_FOLLOW_UP_EXTENSION_DAYS, DEFAULT_LETTERHEAD } from "../../src/modules/opd/config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { RegisterPatientInput } from "../../src/modules/patients";

export const testCfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

/** opd_config 'main' with the shipped defaults (+ registration_config so registerPatient works). */
export async function seedOpdBase(db: Db, over: { perkEveryNth?: number | null; slotMinutes?: number; extensionCap?: number; maxSkips?: number } = {}): Promise<void> {
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
  await db.insert(opdConfig).values({
    id: "main",
    slotMinutes: over.slotMinutes ?? 10,
    followUpExtensionDays: DEFAULT_FOLLOW_UP_EXTENSION_DAYS,
    extensionCapPerDoctorPerMonth: over.extensionCap ?? 30,
    maxSkipsBeforeLeft: over.maxSkips ?? 3,
    perkEveryNth: over.perkEveryNth ?? null,
    dangerRanges: DEFAULT_DANGER_RANGES,
    letterhead: DEFAULT_LETTERHEAD,
    updatedBy: "t",
  });
}

export async function ensureRole(db: Db, key: string): Promise<void> {
  await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
}

/** A user holding the given role keys at hospital scope, with a live session token. */
export async function mkUser(db: Db, username: string, roleKeys: string[]): Promise<{ id: string; token: string; actor: Actor }> {
  const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
  for (const key of roleKeys) {
    await ensureRole(db, key);
    await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
  }
  const { token } = await createSession(db, testCfg, id);
  return { id, token, actor: { type: "user", id } };
}

export async function seedOpdMasters(db: Db): Promise<{ deptId: string; dept2Id: string; roomId: string; room2Id: string }> {
  const deptId = newId(); const dept2Id = newId(); const roomId = newId(); const room2Id = newId();
  await db.insert(opdDepartments).values([
    { id: deptId, code: "MED", name: "General Medicine", createdBy: "t", updatedBy: "t" },
    { id: dept2Id, code: "PED", name: "Paediatrics", createdBy: "t", updatedBy: "t" },
  ]);
  await db.insert(opdRooms).values([
    { id: roomId, code: "12", name: "Room 12", createdBy: "t", updatedBy: "t" },
    { id: room2Id, code: "14", name: "Room 14", createdBy: "t", updatedBy: "t" },
  ]);
  return { deptId, dept2Id, roomId, room2Id };
}

/** A doctor user + profile (+ optional weekly template). Defaults: Mon–Sat 09:00–13:00 in the given room. */
export async function mkDoctor(
  db: Db,
  input: { username: string; departmentId: string; roomId: string; weekdays?: number[]; start?: string; end?: string; displayName?: string },
): Promise<{ doctorId: string; userId: string; actor: Actor; token: string }> {
  const u = await mkUser(db, input.username, ["doctor"]);
  const doctorId = newId();
  await db.insert(opdDoctors).values({
    id: doctorId, userId: u.id, displayName: input.displayName ?? `Dr ${input.username}`, registrationNo: "BMC/12345",
    departmentId: input.departmentId, createdBy: "t", updatedBy: "t",
  });
  const weekdays = input.weekdays ?? [1, 2, 3, 4, 5, 6];
  if (weekdays.length > 0) {
    await db.insert(opdDoctorSchedules).values(weekdays.map((weekday) => ({
      id: newId(), doctorId, weekday, startTime: input.start ?? "09:00", endTime: input.end ?? "13:00", roomId: input.roomId,
      validFrom: "2026-01-01", createdBy: "t",
    })));
  }
  return { doctorId, userId: u.id, actor: u.actor, token: u.token };
}

export async function mkPatient(db: Db, actor: Actor, over: Partial<RegisterPatientInput> = {}): Promise<{ id: string; uhid: string }> {
  const { patient } = await withTx(db, (tx) =>
    registerPatient(tx, actor, { name: "Asha Devi", sex: "female", phone: "9876543210", ageYears: 30, ...over }),
  );
  return { id: patient.id, uhid: patient.uhid };
}

export async function doctorRow(db: Db, doctorId: string) {
  const rows = await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId));
  return rows[0]!;
}
