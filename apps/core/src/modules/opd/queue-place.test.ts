import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { opdQueueEntries } from "../../kernel/db/schema";
import { patientQueueToday } from "./queue-place";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * #657 — the profile's Today band: "token MED-2 · 2nd in line". Place in line is the doctor's own
 * ordering (`orderQueue`); only counts cross the read, never another patient's identity.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // 09:30 IST

describe("#657 patientQueueToday", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let doctorId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    clerk = await mkUser(db, "qp_clerk", ["front_office"]);
    ({ doctorId } = await mkDoctor(db, { username: "qp_dr", departmentId: deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6], displayName: "Dr Mathur" }));
  });

  const seat = async (phone: string, minutes: number) => {
    const p = await mkPatient(db, clerk.actor, { phone, name: `P ${phone}` });
    const v = await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, new Date(T0.getTime() + minutes * 60_000));
    return { patientId: p.id, ...v };
  };
  const setStatus = async (encounterId: string, status: string, eligibleMin: number) => {
    await db.update(opdQueueEntries).set({ status, eligibleAt: new Date(T0.getTime() + eligibleMin * 60_000) })
      .where(eq(opdQueueEntries.encounterId, encounterId));
  };

  it("a waiting patient gets the token and place in line; counts only", async () => {
    const a = await seat("9899000201", 0);
    const b = await seat("9899000202", 1);
    const c = await seat("9899000203", 2);
    await setStatus(a.encounterId, "waiting", 0);
    await setStatus(b.encounterId, "waiting", 1);
    await setStatus(c.encounterId, "waiting_vitals", 2);

    const now = new Date(T0.getTime() + 10 * 60_000);
    const items = await patientQueueToday(db, clerk.actor, b.patientId, now);
    expect(items).toEqual([{
      encounterId: b.encounterId, token: "MED-2", tokenNo: 2, doctorName: "Dr Mathur", departmentName: "General Medicine",
      state: "waiting", position: 2, ahead: 1,
    }]);
    const wire = JSON.stringify(items);
    expect(wire).not.toContain(a.patientId);
    expect(wire).not.toContain("9899000201");

    // Not yet in the doctor's line: the token, no place.
    expect(await patientQueueToday(db, clerk.actor, c.patientId, now)).toEqual([
      expect.objectContaining({ token: "MED-3", state: "waiting_vitals", position: null, ahead: null }),
    ]);
  });

  it("nothing live today is an empty list: a finished visit, or yesterday's token", async () => {
    const a = await seat("9899000204", 0);
    await setStatus(a.encounterId, "done", 0);
    expect(await patientQueueToday(db, clerk.actor, a.patientId, new Date(T0.getTime() + 60_000))).toEqual([]);
    const b = await seat("9899000205", 5);
    await setStatus(b.encounterId, "waiting", 5);
    expect(await patientQueueToday(db, clerk.actor, b.patientId, new Date(T0.getTime() + 86_400_000))).toEqual([]);
  });

  it("a sealed record the reader may not open is the same patient_not_found as an absent one", async () => {
    const p = await mkPatient(db, clerk.actor, { isConfidential: true, alias: "R-1", phone: "9899000206" });
    await expect(patientQueueToday(db, clerk.actor, p.id, T0)).rejects.toBeInstanceOf(OpdError);
    await expect(patientQueueToday(db, clerk.actor, "01NOSUCH00000000000000000", T0)).rejects.toMatchObject({ code: "patient_not_found" });
  });
});
