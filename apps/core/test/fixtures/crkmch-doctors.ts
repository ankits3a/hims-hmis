import { eq } from "drizzle-orm";
import { withTx } from "../../src/kernel/db/client";
import { opdDepartments, orgDepartments, permissions, roleAssignments, rolePermissions, roles, users } from "../../src/kernel/db/schema";
import { DEFAULT_DEPARTMENTS } from "../../src/modules/opd";
import { createDoctor, createRoom } from "../../src/modules/opd/masters";
import { replaceDoctorSchedules } from "../../src/modules/opd/schedules";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "../../src/modules/roster";
import { loadUnitsData } from "../../scripts/setup-units";
import type { Db } from "../../src/kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 2026-10-04 — THE HOSPITAL'S OPD DOCTOR LIST AS FIXTURE DOCTORS, written the way the OPD writes them:
 * the twelve OPD clinics (`DEFAULT_DEPARTMENTS`) plus Community Medicine's (owner 2026-10-04: another
 * lane adds that OPD master and links org COMM to it — `linkCommunityMedicineClinic` does the link here,
 * after `seed:roster`); no EMO clinic, as on the real box; a user per doctor holding `doctor`, an OPD doctor profile (`createDoctor`) for everyone whose
 * department has a clinic, and their weekly OPD schedule from the sheet's days and hours
 * (`replaceDoctorSchedules`, the split Ortho session as two rows). Plus the medical superintendent who
 * publishes. Call it on an EMPTY database, BEFORE `seed:roster`, so the org departments link to the clinics.
 *
 * `rename` gives a doctor a different name in the database (the matcher's spelling cases).
 * `designationsInSpecialty` provisions the way staging was on 2026-10-04, before `designation`
 * existed: the designation typed into `specialty` ("Assistant Professor (Neurosurgeon)" for #11).
 */
export const MS_USER = "U-ms";
const CLINICS = [...DEFAULT_DEPARTMENTS, { code: "COMM", name: "Community Medicine" }];
export const CLINIC_OF: Record<string, string> = Object.fromEntries(CLINICS.map((d) => [d.code, `OPD-${d.code}`]));
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export async function seedCrkmchDoctors(
  db: Db, opts: { rename?: Record<number, string>; validFrom?: string; designationsInSpecialty?: boolean } = {},
): Promise<{ userOf: Map<number, string> }> {
  const by = { createdBy: "fixture", updatedBy: "fixture" };
  await db.insert(roles).values(["doctor", "medical_superintendent", "admin", "owner", "duty_manager", "pharmacy", "radiologist", "pathologist", "anaesthetist"]
    .map((key) => ({ key, title: key }))).onConflictDoNothing();
  await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" }))).onConflictDoNothing();
  await db.insert(rolePermissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission }))).onConflictDoNothing();
  await db.insert(users).values({ id: MS_USER, username: "ms", fullName: "Dr. Medical Superintendent", staffCode: "EMP-MS", passwordHash: "x" });
  await db.insert(roleAssignments).values({ id: "RA-ms", userId: MS_USER, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
  await db.insert(opdDepartments).values(CLINICS.map((d) => ({ id: CLINIC_OF[d.code]!, code: d.code, name: d.name, ...by })));

  const ms: Actor = { type: "user", id: MS_USER };
  const data = loadUnitsData();
  const userOf = new Map<number, string>();
  await withTx(db, async (tx) => {
    const rooms = new Map<string, string>();
    for (const d of data.doctors) {
      const name = opts.rename?.[d.sl] ?? d.name;
      const id = `U-crk-${d.sl}`;
      userOf.set(d.sl, id);
      await tx.insert(users).values({ id, username: `crk${d.sl}`, fullName: name, staffCode: `EMP-CRK-${d.sl}`, passwordHash: "x" });
      await tx.insert(roleAssignments).values({ id: `RA-crk-${d.sl}`, userId: id, roleKey: "doctor", scopeType: "hospital", scopeId: null });
      // The org code the list uses IS the OPD clinic code; Casualty (the EMO) has no clinic.
      const clinic = CLINIC_OF[d.department];
      if (clinic === undefined) continue;
      if (!rooms.has(d.department)) rooms.set(d.department, (await createRoom(tx, ms, { code: `${d.department}-1`, name: `${d.department} room 1` })).roomId);
      const specialty = opts.designationsInSpecialty === true ? (d.sl === 11 ? "Assistant Professor (Neurosurgeon)" : d.designation) : undefined;
      const { doctorId } = await createDoctor(tx, ms, {
        username: `crk${d.sl}`, displayName: name, departmentId: clinic, code: `DR-${String(d.sl).padStart(4, "0")}`,
        ...(specialty === undefined ? {} : { specialty }),
      });
      const spans = d.hours.split(",").map((h) => h.split("-") as [string, string]);
      await replaceDoctorSchedules(tx, ms, doctorId, d.days.flatMap((day) => spans.map(([startTime, endTime]) => ({
        weekday: WEEKDAY[day]!, startTime, endTime, roomId: rooms.get(d.department)!, validFrom: opts.validFrom ?? "2026-01-01",
      }))));
    }
  });
  return { userOf };
}

/** The other lane's link, until it lands: org Community Medicine runs the COMM OPD clinic. Call after `seed:roster`. */
export async function linkCommunityMedicineClinic(db: Db): Promise<void> {
  await db.update(orgDepartments).set({ opdDepartmentId: CLINIC_OF.COMM! }).where(eq(orgDepartments.code, "COMM"));
}
