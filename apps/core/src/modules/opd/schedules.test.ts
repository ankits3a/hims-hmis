import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdDoctorLeaves } from "../../kernel/db/schema";
import { updateRoom } from "./masters";
import { availableSlots, listDoctorSchedules, replaceDoctorSchedules } from "./schedules";
import type { Db } from "../../kernel/db/client";

describe("opd schedules", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); await seedOpdBase(db); });

  it("replaceDoctorSchedules inserts N active rows and deactivates the previous set (no delete path)", async () => {
    const admin = await mkUser(db, "admin1", ["opd_admin"]);
    const { deptId, roomId } = await seedOpdMasters(db);
    const doc = await mkDoctor(db, { username: "doc1", departmentId: deptId, roomId, weekdays: [] });

    const first = await withTx(db, (tx) =>
      replaceDoctorSchedules(tx, admin.actor, doc.doctorId, [
        { weekday: 1, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01" },
        { weekday: 2, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01" },
      ]),
    );
    expect(first.scheduleIds).toHaveLength(2);
    let active = await listDoctorSchedules(db, doc.doctorId, { activeOnly: true });
    expect(active).toHaveLength(2);

    const second = await withTx(db, (tx) =>
      replaceDoctorSchedules(tx, admin.actor, doc.doctorId, [
        { weekday: 3, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01" },
      ]),
    );
    expect(second.scheduleIds).toHaveLength(1);
    active = await listDoctorSchedules(db, doc.doctorId, { activeOnly: true });
    expect(active).toHaveLength(1);
    expect(active[0]!.weekday).toBe(3);

    const all = await listDoctorSchedules(db, doc.doctorId);
    expect(all).toHaveLength(3); // 2 old (now inactive) + 1 new active — no delete path
    expect(all.filter((r) => !r.active)).toHaveLength(2);
  });

  it("refuses overlapping templates, invalid times, an unknown/inactive room, and non-user actors", async () => {
    const admin = await mkUser(db, "admin2", ["opd_admin"]);
    const { deptId, roomId } = await seedOpdMasters(db);
    const doc = await mkDoctor(db, { username: "doc2", departmentId: deptId, roomId, weekdays: [] });

    await expect(
      withTx(db, (tx) =>
        replaceDoctorSchedules(tx, admin.actor, doc.doctorId, [
          { weekday: 1, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01" },
          { weekday: 1, startTime: "10:30", endTime: "12:00", roomId, validFrom: "2026-01-01" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_schedule" });

    await expect(
      withTx(db, (tx) =>
        replaceDoctorSchedules(tx, admin.actor, doc.doctorId, [
          { weekday: 1, startTime: "25:00", endTime: "26:00", roomId, validFrom: "2026-01-01" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_schedule" });

    await expect(
      withTx(db, (tx) =>
        replaceDoctorSchedules(tx, admin.actor, doc.doctorId, [
          { weekday: 1, startTime: "11:00", endTime: "09:00", roomId, validFrom: "2026-01-01" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_schedule" });

    await expect(
      withTx(db, (tx) =>
        replaceDoctorSchedules(tx, admin.actor, doc.doctorId, [
          { weekday: 1, startTime: "09:00", endTime: "11:00", roomId: "no-such-room", validFrom: "2026-01-01" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "unknown_room" });

    await withTx(db, (tx) => updateRoom(tx, admin.actor, roomId, { active: false }));
    await expect(
      withTx(db, (tx) =>
        replaceDoctorSchedules(tx, admin.actor, doc.doctorId, [
          { weekday: 1, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "unknown_room" });

    const systemActor = { type: "system" as const, id: "sys" };
    await expect(
      withTx(db, (tx) =>
        replaceDoctorSchedules(tx, systemActor, doc.doctorId, [
          { weekday: 1, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("availableSlots on the default Mon–Sat 09:00–13:00 template: 24 slots, booked flag, leave empties", async () => {
    const admin = await mkUser(db, "admin3", ["opd_admin"]);
    const { deptId, roomId } = await seedOpdMasters(db);
    const doc = await mkDoctor(db, { username: "doc3", departmentId: deptId, roomId }); // default Mon–Sat 09:00–13:00
    const patient = await mkPatient(db, admin.actor);
    const now = new Date("2026-08-17T00:00:00.000Z"); // Monday

    let slots = await availableSlots(db, doc.doctorId, "2026-08-17", now);
    expect(slots).toHaveLength(24); // 240 min / 10
    expect(slots[0]!.start.toISOString()).toBe("2026-08-17T03:30:00.000Z");
    expect(slots.every((s) => !s.booked)).toBe(true);

    await db.insert(opdAppointments).values({
      id: newId(),
      patientId: patient.id,
      doctorId: doc.doctorId,
      departmentId: deptId,
      serviceDate: "2026-08-17",
      slotStart: new Date("2026-08-17T03:40:00.000Z"),
      slotEnd: new Date("2026-08-17T03:50:00.000Z"),
      status: "booked",
      bookedBy: "t",
      updatedBy: "t",
    });
    slots = await availableSlots(db, doc.doctorId, "2026-08-17", now);
    expect(slots[1]!.booked).toBe(true);
    expect(slots.filter((s) => s.booked)).toHaveLength(1);

    await db.insert(opdDoctorLeaves).values({
      id: newId(), doctorId: doc.doctorId, fromDate: "2026-08-17", toDate: "2026-08-17",
      reason: "leave", status: "scheduled", createdBy: "t",
    });
    slots = await availableSlots(db, doc.doctorId, "2026-08-17", now);
    expect(slots).toEqual([]);
  });
});
