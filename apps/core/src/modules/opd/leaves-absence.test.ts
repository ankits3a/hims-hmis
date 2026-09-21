import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDoctor, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdDoctorLeaves, staffAbsences } from "../../kernel/db/schema";
import { listAbsences } from "../roster";
import { cancelDoctorLeave, scheduleDoctorLeave } from "./leaves";
import type { Db } from "../../kernel/db/client";

/**
 * PHASE R (R4) — **`opd_doctor_leaves` IS A PROJECTION OF `staff_absences`.**
 *
 * The two tables must agree or the hospital has two answers to "who is away", and the one it acts
 * on will be whichever the caller happened to read. So this drives the OPD's own screen — the API
 * it has always had — and asserts the roster's record from the other side.
 *
 * ═══ THE CLERK HOLDS NO ROSTER PERMISSION, AND THAT IS THE POINT ═══
 *
 * `opd_admin` has been able to schedule a consultant's leave since long before the roster existed.
 * If this write required `roster.periods.publish` the act would now fail, and the realistic repair
 * would be granting the OPD admin a string that hands them every rota in the building. The seam
 * uses `recordAbsenceUnchecked` instead, and the roster's own test pins its call sites.
 */
describe("opd — a doctor's leave is recorded as a staff absence (R4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let admin: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;

  /** Sunday 2026-08-16, 09:30 IST — before the leave window, so `toDate` is not in the past. */
  const NOW = new Date("2026-08-16T04:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    const masters = await seedOpdMasters(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: masters.deptId, roomId: masters.roomId });
    admin = await mkUser(db, "opd.admin", ["opd_admin"]);
  });

  it("writes BOTH rows, and the absence covers the inclusive days as half-open IST instants", async () => {
    const { leaveId } = await scheduleDoctorLeave(db, admin.actor, {
      doctorId: dra.doctorId, fromDate: "2026-08-18", toDate: "2026-08-20", reason: "conference at Delhi",
    }, NOW);

    const [leave] = await db.select().from(opdDoctorLeaves).where(eq(opdDoctorLeaves.id, leaveId));
    expect(leave!.absenceId).not.toBeNull();

    const [absence] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, leave!.absenceId!));
    expect(absence!.userId).toBe(dra.userId);        // the PERSON, not the opd_doctors row
    expect(absence!.status).toBe("approved");         // entered and allowed in one act at that screen
    expect(absence!.source).toBe("opd");
    expect(absence!.kind).toBe("CL");

    /**
     * THE CONVERSION, WHICH IS WHERE AN OFF-BY-ONE WOULD COST A WARD A MORNING. `toDate` is
     * INCLUSIVE on the OPD side and every roster window is half-open, so the absence must end at
     * IST midnight on the 21st — not the 20th, which would leave the doctor rostered for their
     * last day of leave.
     */
    expect(absence!.startsAt.toISOString()).toBe("2026-08-17T18:30:00.000Z"); // 18 Aug 00:00 IST
    expect(absence!.endsAt.toISOString()).toBe("2026-08-20T18:30:00.000Z");   // 21 Aug 00:00 IST
  });

  it("a doctor with no absence before has exactly one after, and the reason travels to the approver's read", async () => {
    expect(await listAbsences(db, admin.actor, { userId: dra.userId })).toEqual([]);
    await scheduleDoctorLeave(db, admin.actor, {
      doctorId: dra.doctorId, fromDate: "2026-08-18", toDate: "2026-08-18", reason: "conference at Delhi",
    }, NOW);
    const mine = await listAbsences(db, admin.actor, { userId: dra.userId });
    expect(mine).toHaveLength(1);
    // the admin both requested and approved it, so they may read the reason
    expect(mine[0]!.reason).toBe("conference at Delhi");
    // ...and somebody else may not
    const other = await mkUser(db, "stranger", ["front_office"]);
    expect((await listAbsences(db, other.actor, { userId: dra.userId }))[0]!.reason).toBeNull();
  });

  it("cancelling the leave cancels the absence it projected, in the same transaction", async () => {
    const { leaveId } = await scheduleDoctorLeave(db, admin.actor, {
      doctorId: dra.doctorId, fromDate: "2026-08-18", toDate: "2026-08-20", reason: "conference",
    }, NOW);
    const [before] = await db.select().from(opdDoctorLeaves).where(eq(opdDoctorLeaves.id, leaveId));

    await cancelDoctorLeave(db, admin.actor, leaveId);

    const [absence] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, before!.absenceId!));
    expect(absence!.status).toBe("cancelled");
    // ...so the projection cannot drift: nobody is left "away" on a leave that was called off
    expect(await listAbsences(db, admin.actor, { userId: dra.userId, statuses: ["approved"] })).toEqual([]);
  });

  it("an explicit KIND is carried through, so not every leave in the building is recorded as casual", async () => {
    const { leaveId } = await scheduleDoctorLeave(db, admin.actor, {
      doctorId: dra.doctorId, fromDate: "2026-09-01", toDate: "2026-09-30", reason: "study leave", kind: "study",
    }, NOW);
    const [leave] = await db.select().from(opdDoctorLeaves).where(eq(opdDoctorLeaves.id, leaveId));
    const [absence] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, leave!.absenceId!));
    expect(absence!.kind).toBe("study");
  });
});
