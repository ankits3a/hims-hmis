import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { withTx } from "../client";
import {
  opdAppointments, opdConfig, opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions,
  opdVitals, patients, registrationConfig, resources,
} from "./index";
import type { Db } from "../client";

const AUDIT = { createdBy: "t", updatedBy: "t" };

describe("opd schema (migration 0010)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seedDoctor(): Promise<{ deptId: string; roomId: string; doctorId: string }> {
    await db.insert(opdDepartments).values({ id: "D1", code: "MED", name: "General Medicine", ...AUDIT });
    // PLAN 13 T6/T7 — a room is a REGISTRY row and `opd_doctor_schedules.room_id` /
    // `opd_queue_sessions.room_id` name `resources(id)`. `opd_rooms` no longer exists at all after
    // `0033`, so there is no other table this fixture could seed.
    await db.insert(resources).values({ id: "R1", kind: "room", code: "12", name: "Room 12", status: "available", ...AUDIT });
    await db.insert(opdDoctors).values({ id: "DOC1", userId: "U1", displayName: "Dr A", departmentId: "D1", ...AUDIT });
    return { deptId: "D1", roomId: "R1", doctorId: "DOC1" };
  }
  async function seedPatient(id: string): Promise<void> {
    await db.insert(patients).values({ id, uhid: `HMS-0000000${id.slice(-1)}-0`, name: "P", sex: "other", createdBy: "t", updatedBy: "t" });
  }

  it("service_date round-trips as a YYYY-MM-DD STRING (mode: string) — no timezone shift", async () => {
    const { doctorId } = await seedDoctor();
    await db.insert(opdQueueSessions).values({ id: "S1", doctorId, serviceDate: "2026-08-15", status: "not_started" });
    const rows = await db.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, "S1"));
    expect(rows[0]!.serviceDate).toBe("2026-08-15");
    expect(typeof rows[0]!.serviceDate).toBe("string");
  });

  it("appointments: the partial unique index arbitrates one live booking per (doctor, slot_start)", async () => {
    const { doctorId, deptId } = await seedDoctor();
    await seedPatient("P1"); await seedPatient("P2"); await seedPatient("P3");
    const slot = new Date("2026-08-17T05:00:00.000Z"); // 10:30 IST
    const base = { doctorId, departmentId: deptId, serviceDate: "2026-08-17", slotStart: slot, slotEnd: new Date(slot.getTime() + 600_000), bookedBy: "t", updatedBy: "t" };
    await db.insert(opdAppointments).values({ id: "A1", appointmentNo: "AFX-A1", patientId: "P1", status: "cancelled", ...base });
    await db.insert(opdAppointments).values({ id: "A2", appointmentNo: "AFX-A2", patientId: "P2", status: "booked", ...base }); // cancelled A1 does not block
    await expect(
      db.insert(opdAppointments).values({ id: "A3", appointmentNo: "AFX-A3", patientId: "P3", status: "booked", ...base }),
    ).rejects.toMatchObject({ code: "23505" });
    const claimed = await db.insert(opdAppointments).values({ id: "A4", appointmentNo: "AFX-A4", patientId: "P3", status: "needs_rebooking", ...base }).onConflictDoNothing().returning({ id: opdAppointments.id });
    expect(claimed).toEqual([]); // needs_rebooking is inside the live set
  });

  it("queue entries carry a database-side bigserial seq that climbs in insertion order inside one transaction", async () => {
    const { doctorId } = await seedDoctor();
    await seedPatient("P1");
    await db.insert(opdQueueSessions).values({ id: "S1", doctorId, serviceDate: "2026-08-15", status: "in" });
    await db.insert(opdEncounters).values({ id: "E1", visitNo: "VFX-E1", patientId: "P1", workflowInstanceId: "WI1", doctorId, serviceDate: "2026-08-15", visitType: "new", openedBy: "t", updatedBy: "t" });
    const seqs = await withTx(db, async (tx) => {
      const out: number[] = [];
      for (const [id, token] of [["Q1", 1], ["Q2", 2], ["Q3", 3]] as const) {
        const r = await tx.insert(opdQueueEntries).values({ id, sessionId: "S1", encounterId: "E1", tokenNo: token, kind: "walk_in", status: "waiting_vitals" }).returning({ seq: opdQueueEntries.seq });
        out.push(r[0]!.seq);
      }
      return out;
    });
    expect(seqs[1]! - seqs[0]!).toBe(1);
    expect(seqs[2]! - seqs[1]!).toBe(1);
    expect(typeof seqs[0]).toBe("number");
  });

  it("vitals doubles round-trip exactly (38.4, 12.5) and jsonb flags survive", async () => {
    const { doctorId } = await seedDoctor();
    await seedPatient("P1");
    await db.insert(opdEncounters).values({ id: "E1", visitNo: "VFX-E1", patientId: "P1", workflowInstanceId: "WI1", doctorId, serviceDate: "2026-08-15", visitType: "new", openedBy: "t", updatedBy: "t" });
    await db.insert(opdVitals).values({ id: "V1", encounterId: "E1", patientId: "P1", tempC: 38.4, weightKg: 12.5, dangerFlags: [{ vital: "tempC", value: 38.4, bound: "max", limit: 38.0 }], band: "child_1_5", recordedBy: "t" });
    const rows = await db.select().from(opdVitals).where(eq(opdVitals.id, "V1"));
    expect(rows[0]!.tempC).toBe(38.4);
    expect(rows[0]!.weightKg).toBe(12.5);
    expect(rows[0]!.dangerFlags).toEqual([{ vital: "tempC", value: 38.4, bound: "max", limit: 38.0 }]);
  });

  it("truncateAll clears the OPD chain that FKs into patients (§3.12: same statement)", async () => {
    const { doctorId } = await seedDoctor();
    await seedPatient("P1");
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
    await db.insert(opdEncounters).values({ id: "E1", visitNo: "VFX-E1", patientId: "P1", workflowInstanceId: "WI1", doctorId, serviceDate: "2026-08-15", visitType: "new", openedBy: "t", updatedBy: "t" });
    await db.insert(opdConfig).values({ id: "main", followUpExtensionDays: [15, 21, 30], dangerRanges: { bands: [] }, letterhead: { name: "X", addressLines: [] }, updatedBy: "t" });
    await truncateAll(db); // throws "cannot truncate a table referenced in a foreign key constraint" if the statement is wrong
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from opd_encounters`)).rows as [{ n: number }];
    expect(n).toBe(0);
    const [{ p }] = (await db.execute(sql`select count(*)::int as p from patients`)).rows as [{ p: number }];
    expect(p).toBe(0);
  });
});
