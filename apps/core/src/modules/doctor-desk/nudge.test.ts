import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedConfirmedUnits } from "../../../test/helpers/units";
import { mkUser } from "../../../test/helpers/opd";
import {
  doctorDeskNudges, labAnalytes, labCriticalCalls, labResults, orderItems, orders, patients, registrationConfig,
  rosterTeamMemberships, services,
} from "../../kernel/db/schema";
import { teamByCode } from "../roster";
import { nudge } from "./nudge";
import type { Db } from "../../kernel/db/client";

/**
 * #891 review — the nudge row, its bell row and the link between them are ONE transaction: a bell
 * that fails to write must not leave a nudge behind (which would answer `already_nudged` to a retry
 * of a nudge nobody ever received).
 */
describe("doctor-desk — a nudge is all or nothing", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  const AT = new Date("2026-10-06T10:00:00+05:30");
  let sr = "";
  let key = "";

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedConfirmedUnits(db);
    const u2 = (await teamByCode(db, "MED-U2"))!.id;
    sr = (await mkUser(db, "nd_sr", [])).id;
    const jr = (await mkUser(db, "nd_jr", [])).id;
    const since = new Date("2026-01-01T00:00:00+05:30");
    await db.insert(rosterTeamMemberships).values([
      { id: newId(), teamId: u2, userId: sr, positionKey: "unit_sr", grade: "senior_resident", roleInTeam: "senior_resident", kind: "parent", startsAt: since, createdBy: "t", updatedBy: "t" },
      { id: newId(), teamId: u2, userId: jr, positionKey: "ward_jr", grade: "jr1", roleInTeam: "junior_resident", kind: "parent", startsAt: since, createdBy: "t", updatedBy: "t" },
    ]);
    const patientId = newId();
    await db.insert(patients).values({ id: patientId, uhid: "HMS-00000001-5", name: "Patient Alpha", sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" });
    const serviceId = newId();
    await db.insert(services).values({ id: serviceId, code: "ELEC", name: "Electrolytes", category: "investigation", createdBy: "t", updatedBy: "t" });
    const analyteId = newId();
    await db.insert(labAnalytes).values({ id: analyteId, code: "K", nameEn: "Potassium", resultType: "numeric", unit: "mmol/L", createdBy: "t", updatedBy: "t" });
    const orderId = newId(); const itemId = newId(); const resultId = newId(); const callId = newId();
    await db.insert(orders).values({
      id: orderId, orderNo: "L00000001", orderGroupId: orderId, kind: "lab", patientId, encounterNo: "V2610060001", serviceDate: "2026-10-06",
      priority: "routine", authority: "clinician", orderedByType: "user", orderedById: jr, orderingClinicianId: jr, placedAt: AT,
    });
    await db.insert(orderItems).values({ id: itemId, orderId, serviceId });
    await db.insert(labResults).values({ id: resultId, orderItemId: itemId, analyteId, valueNumeric: "6.4", unit: "mmol/L", flag: "HH", enteredByType: "user", enteredById: "t", entryMode: "manual", verificationStatus: "verified", verifiedBy: "t", verifiedAt: AT });
    await db.insert(labCriticalCalls).values({ id: callId, resultId, openedBy: "t", openedAt: AT });
    key = `lab_critical:${callId}`;
  });

  it("a bell that fails to write leaves no nudge, and the retry goes through", async () => {
    const failing = { raise: async (): Promise<boolean> => { throw new Error("bell down"); } };
    await expect(nudge(db, { type: "user", id: sr }, key, AT, failing)).rejects.toThrow("bell down");
    expect(await db.select().from(doctorDeskNudges)).toHaveLength(0);
    const ok = await nudge(db, { type: "user", id: sr }, key, AT);
    const rows = await db.select().from(doctorDeskNudges);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(ok.nudgeId);
    expect(rows[0]!.alertId).not.toBeNull();
  });
});
