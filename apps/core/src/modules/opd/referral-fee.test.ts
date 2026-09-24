import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { opdEncounters } from "../../kernel/db/schema";
import { abandonVisit, openVisit, reviewAnchorFor } from "./encounters";
import { continuityDoctorFor } from "./continuity";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { completeConsultation, startConsultation } from "./consultation";
import { referInternally } from "./referral";
import { OpdVisitsController } from "./opd-visits.controller";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER RULING 2026-09-24 (money; 01-CONSULT-ENGINE.md §1.1 item 9): a patient who consults the
 * referred department within 7 days of an internal referral pays no fee — the follow-up-days method,
 * with the referral itself as the anchor. After 7 days the ordinary new/renewal fee applies.
 *
 * Mon 17 Aug 2026 09:30 IST is the referral. Day 7 is Mon 24 Aug; day 8 is Tue 25 Aug (IST days).
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const DAY7 = new Date("2026-08-24T05:00:00.000Z");
const DAY8 = new Date("2026-08-25T05:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("the referral fee — free in the referred department for 7 days", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let fo: Awaited<ReturnType<typeof mkUser>>; // abandoning a visit is front_office's transition
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drp: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dept2Id: string;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    dept2Id = m.dept2Id;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: m.roomId });
    drp = await mkDoctor(db, { username: "drp", departmentId: dept2Id, roomId: m.room2Id });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    fo = await mkUser(db, "fo1", ["front_office"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
  });

  /** Dr A sees the patient on Monday and refers them to Dr P's department. */
  async function refer(): Promise<{ fromId: string; toId: string; visitType: string }> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    await startConsultation(db, dra.actor, opened.encounter.id, MON);
    // The service, not the route: the route stamps the wall clock, and this test needs Monday.
    const res = await referInternally(db, dra.actor, opened.encounter.id, { departmentId: dept2Id, doctorId: drp.doctorId, reason: "Wheeze — assess asthma" }, MON);
    return { fromId: opened.encounter.id, toId: res.encounterId, visitType: res.visitType };
  }

  it("the visit a referral opens is free, and it records which visit referred it", async () => {
    const r = await refer();
    expect(r.visitType).toBe("revisit");
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, r.toId));
    expect(row!.visitType).toBe("revisit");
    expect(row!.referredFromEncounterId).toBe(r.fromId);
  });

  it("the patient who misses the referral visit and comes back on day 7 is still free; on day 8 the normal fee applies", async () => {
    const r = await refer();
    await abandonVisit(db, fo.actor, r.toId, "did not wait", MON);
    const day7 = await openVisit(db, clerk.actor, { patientId, departmentId: dept2Id, doctorId: drp.doctorId }, DAY7);
    expect(day7.visitType).toBe("revisit");
    await abandonVisit(db, fo.actor, day7.encounter.id, "left", DAY7);
    const day8 = await openVisit(db, clerk.actor, { patientId, departmentId: dept2Id, doctorId: drp.doctorId }, DAY8);
    // Never seen in that department: after the window it is a first visit there, charged as `new`.
    expect(day8.visitType).toBe("new");
  });

  it("the window belongs to the referred department only: the referring department is unchanged", async () => {
    await refer();
    // The referring visit is still open (not completed), so Dr A's department has no anchor of its own.
    const back = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, DAY7);
    expect(back.visitType).toBe("new");
  });

  it("a desk that picks 'internal doctor' as the referral source does NOT make the visit free", async () => {
    const v = await openVisit(db, clerk.actor, {
      patientId, departmentId: dept2Id, doctorId: drp.doctorId, referralSource: "internal_doctor", referrerName: "Dr A",
    }, MON);
    expect(v.visitType).toBe("new");
    const later = await openVisit(db, clerk.actor, { patientId, departmentId: dept2Id, doctorId: drp.doctorId }, DAY7);
    expect(later.visitType).toBe("new");
  });

  it("a browser cannot claim a referral: the open-visit route drops `referredFromEncounterId` from its body", async () => {
    const r = await refer();
    const ctl = new OpdVisitsController(db, {} as never);
    // Dept A: the referral's window is Dr P's department's, so only the forged field could free this.
    const v = await ctl.open(clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId, referredFromEncounterId: r.fromId });
    expect(v.visitType).toBe("new");
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, v.encounter.id));
    expect(row!.referredFromEncounterId).toBeNull();
  });

  it("a visit with no referral is unchanged: a completed consult still anchors its own 7 days", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: dept2Id, doctorId: drp.doctorId }, MON);
    expect(opened.visitType).toBe("new");
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, drp.actor, opened.sessionId, MON);
    await startConsultation(db, drp.actor, opened.encounter.id, MON);
    await completeConsultation(db, drp.actor, opened.encounter.id, { testsOrderedReturnToday: false }, MON);
    expect((await openVisit(db, clerk.actor, { patientId, departmentId: dept2Id, doctorId: drp.doctorId }, DAY7)).visitType).toBe("revisit");
    expect((await openVisit(db, clerk.actor, { patientId, departmentId: dept2Id, doctorId: drp.doctorId }, DAY8)).visitType).toBe("renewal");
  });

  it("the fee quote names the referral, not a review: who referred, on which day, free until when", async () => {
    const r = await refer();
    const [row] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, r.toId));
    expect(await reviewAnchorFor(db, row!)).toEqual({
      via: "referral", doctorName: "Dr dra", seenOn: "2026-08-17", windowEndsOn: "2026-08-24",
    });
  });

  it("the desk's continuity hint says the referred doctor and 'would be revisit' inside the window, and nothing after it", async () => {
    const r = await refer();
    await abandonVisit(db, fo.actor, r.toId, "did not wait", MON);
    const hint = await continuityDoctorFor(db, clerk.actor, { patientId, departmentId: dept2Id }, DAY7);
    expect(hint).toMatchObject({ doctorId: drp.doctorId, seenOn: "2026-08-17", windowEndsOn: "2026-08-24", followUpDays: 7, wouldBe: "revisit" });
    expect(await continuityDoctorFor(db, clerk.actor, { patientId, departmentId: dept2Id }, DAY8)).toBeNull();
  });
});
