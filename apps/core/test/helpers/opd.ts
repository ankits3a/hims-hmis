import { eq } from "drizzle-orm";
import { createUser } from "../../src/kernel/auth/identity";
import { createSession } from "../../src/kernel/auth/sessions";
import { assignRole } from "../../src/kernel/auth/permissions";
import { seedSodPairs } from "../../src/kernel/auth/sod";
import { activateDefinition, approveDefinition, createDraft } from "../../src/kernel/workflow/definitions";
import { registrationConfig, roles, sodPairs, opdConfig, opdDepartments, opdDoctors, opdDoctorSchedules, resources } from "../../src/kernel/db/schema";
import { withTx } from "../../src/kernel/db/client";
import { loadConfig } from "../../src/kernel/config";
import { newId } from "@hmis/contracts";
import { registerPatient } from "../../src/modules/patients";
import { DEFAULT_DANGER_RANGES, DEFAULT_FOLLOW_UP_EXTENSION_DAYS, DEFAULT_LETTERHEAD } from "../../src/modules/opd/config";
import { OPD_VISIT_DEFINITION_JSON } from "../../src/modules/opd/workflow-def";
import { openVisit } from "../../src/modules/opd/encounters";
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

/** The four users a Class-A activation needs; named so a suite can grant them extra roles if it must. */
export const OPD_DEF_USERS = ["opd_def_drafter", "opd_def_owner", "opd_def_ms", "opd_def_activator"] as const;

/** Class A activation exactly as the go-live runbook does it: drafter, owner + MS approvals, a distinct activator. Idempotent per suite: call once per beforeEach after truncateAll. */
export async function activateOpdVisitDefinition(db: Db): Promise<{ definitionId: string }> {
  if ((await db.select({ k: sodPairs.pairKey }).from(sodPairs)).length === 0) await seedSodPairs(db);
  const drafter = await mkUser(db, OPD_DEF_USERS[0], []);
  const owner = await mkUser(db, OPD_DEF_USERS[1], ["owner"]);
  const ms = await mkUser(db, OPD_DEF_USERS[2], ["medical_superintendent"]);
  const activator = await mkUser(db, OPD_DEF_USERS[3], []);
  const { definitionId } = await createDraft(db, drafter.actor, OPD_VISIT_DEFINITION_JSON);
  await approveDefinition(db, owner.actor, { definitionId, roleKey: "owner", note: "go-live activation" });
  await approveDefinition(db, ms.actor, { definitionId, roleKey: "medical_superintendent", note: "go-live activation" });
  await activateDefinition(db, activator.actor, definitionId);
  return { definitionId };
}

export async function seedOpdMasters(db: Db): Promise<{ deptId: string; dept2Id: string; roomId: string; room2Id: string }> {
  const deptId = newId(); const dept2Id = newId(); const roomId = newId(); const room2Id = newId();
  await db.insert(opdDepartments).values([
    { id: deptId, code: "MED", name: "General Medicine", createdBy: "t", updatedBy: "t" },
    { id: dept2Id, code: "PED", name: "Paediatrics", createdBy: "t", updatedBy: "t" },
  ]);
  // PLAN 13 T6 — rooms are REGISTRY rows now. Seeded directly rather than through `createResource`
  // because this helper runs outside a transaction and every suite that calls it wants two rooms,
  // not two rooms and four events; `kind`/`status` are spelled here so a reader of any OPD suite can
  // see what a room now IS.
  await db.insert(resources).values([
    { id: roomId, kind: "room", code: "12", name: "Room 12", status: "available", createdBy: "t", updatedBy: "t" },
    { id: room2Id, kind: "room", code: "14", name: "Room 14", status: "available", createdBy: "t", updatedBy: "t" },
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

/**
 * PLAN 16a T8 — one real OPD encounter, for suites that need the PRESCRIPTION BOOK to exist
 * without being about how it is written.
 *
 * `opd_prescriptions.encounter_id` carries a foreign key, so a fixture that invented ids is
 * refused by the database — correctly. This helper lives here rather than in the calling suite
 * because a MODULE may only import another module's `index.ts` (spec §4, lint-enforced), and
 * `openVisit` is an OPD internal; a test helper is the sanctioned place for cross-module wiring,
 * which is what every import above it already does.
 */
export async function openOpdVisit(
  db: Db,
  args: { clerk: Actor; patientId: string; departmentId: string; doctorId: string },
  at: Date,
): Promise<{ encounterId: string; sessionId: string }> {
  const opened = await openVisit(
    db, args.clerk,
    { patientId: args.patientId, departmentId: args.departmentId, doctorId: args.doctorId },
    at,
  );
  return { encounterId: opened.encounter.id, sessionId: opened.sessionId };
}
