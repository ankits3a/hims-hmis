import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { seedBillingBase } from "../../../test/helpers/billing";
import { opdEncounters, opdQueueEntries, permissions, rolePermissions } from "../../kernel/db/schema";
import { completeConsultation, startConsultation } from "./consultation";
import { abandonVisit, openVisit } from "./encounters";
import { markPatientAbsent } from "./patient-absent";
import { callNext } from "./queue";
import { scanResolve } from "./scan";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE PHONE'S QUICK SCAN (owner 2026-10-08) — ONE READ, PERMISSION-CHECKED PER ACTION ═══
 *
 * The same patient is scanned by four people. What each is OFFERED differs; what the patient's
 * visit IS does not. Every leg drives the real lifecycle (open → vitals → call → consult →
 * complete) so a stage means what the desks make it mean.
 */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const TUE = new Date("2026-08-18T04:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };
const GRANTS: Record<string, string[]> = {
  front_office: ["opd.visits.read", "opd.visits.open", "opd.appointments.manage", "billing.invoice.issue", "patients.update"],
  vitals_desk: ["opd.visits.read", "opd.vitals.record"],
  doctor: ["opd.visits.read", "opd.consult"],
  nobody_much: ["opd.visits.read"],
};

describe("opd — the quick scan's one read", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let reader: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: masters.roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    reader = await mkUser(db, "reader", ["nobody_much"]);
    const all = [...new Set(Object.values(GRANTS).flat())];
    await db.insert(permissions).values(all.map((permission) => ({ permission, module: permission.split(".")[0]! }))).onConflictDoNothing();
    await db.insert(rolePermissions).values(Object.entries(GRANTS).flatMap(([roleKey, list]) => list.map((permission) => ({ roleKey, permission })))).onConflictDoNothing();
  });

  const open = async (patientId: string, doctorId: string = dra.doctorId, at: Date = MON) =>
    openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId }, at);

  it("a patient waiting for vitals: the stage is the same for everyone, the permitted actions are each caller's own", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const v = await open(asha.id);

    const nurse = await scanResolve(db, vd.actor, { by: "visit", visitNo: v.encounter.visitNo }, MON);
    expect(nurse).toMatchObject({ outcome: "visit", visit: { encounterId: v.encounter.id, stage: "vitals", vitalsDone: false, slip: "none", mine: false, tokenNo: v.tokenNo } });
    if (nurse.outcome !== "visit") throw new Error("unreachable");
    expect(nurse.permitted).toEqual(["vitals"]);
    expect(nurse.visit.patient.uhid).toBe(asha.uhid);

    const desk = await scanResolve(db, clerk.actor, { by: "visit", visitNo: v.encounter.visitNo.toLowerCase() }, MON);
    if (desk.outcome !== "visit") throw new Error("the desk did not find the visit");
    expect(desk.visit.stage).toBe("vitals");
    expect(desk.permitted).toEqual(["slip", "collect", "visit", "move", "book", "newVisit"]);
    expect(desk.permitted).not.toContain("vitals");

    // A login that may only read visits is told where the visit stands and offered nothing.
    const plain = await scanResolve(db, reader.actor, { by: "encounter", encounterId: v.encounter.id }, MON);
    expect(plain).toMatchObject({ outcome: "visit", permitted: [] });
  });

  it("'Guardian with reports' is offered on ANY visit still waiting for vitals — new, revisit or renewal — to the bay and the desk only, and never after the bay (owner 2026-10-09)", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const v = await open(asha.id);
    const offer = async (actor: typeof vd.actor): Promise<boolean | undefined> => {
      const r = await scanResolve(db, actor, { by: "encounter", encounterId: v.encounter.id }, MON);
      if (r.outcome !== "visit") throw new Error("the visit was not found");
      return r.visit.guardianOffer;
    };
    for (const visitType of ["new", "revisit", "renewal"]) {
      await db.update(opdEncounters).set({ visitType }).where(eq(opdEncounters.id, v.encounter.id));
      // The two seats the route admits — and nobody else, doctor included.
      expect([visitType, await offer(vd.actor), await offer(clerk.actor), await offer(reader.actor), await offer(dra.actor)])
        .toEqual([visitType, true, true, false, false]);
    }
    // Once the guardian has been sent on, there is nothing left to offer.
    await markPatientAbsent(db, vd.actor, v.encounter.id, { relation: "son", name: null }, MON);
    expect([await offer(vd.actor), await offer(clerk.actor)]).toEqual([false, false]);

    // …and a revisit whose vitals were TAKEN is past the bay: not offered.
    const ravi = await mkPatient(db, clerk.actor);
    const w = await open(ravi.id);
    await db.update(opdEncounters).set({ visitType: "revisit" }).where(eq(opdEncounters.id, w.encounter.id));
    await recordVitals(db, vd.actor, w.encounter.id, adultOk, MON);
    const after = await scanResolve(db, vd.actor, { by: "encounter", encounterId: w.encounter.id }, MON);
    expect(after).toMatchObject({ outcome: "visit", visit: { vitalsDone: true, guardianOffer: false } });
  });

  /**
   * Owner 2026-10-09 — *"Doctor's screens must not show money."* The card a DOCTOR's scan opens is
   * never told the fee is unpaid; the bay's and the desk's cards still are (billing is real here).
   */
  it("an unpaid visit: the bay and the desk are told, a doctor's scan is not", async () => {
    await seedBillingBase(db);
    const asha = await mkPatient(db, clerk.actor);
    const v = await open(asha.id);
    const by = { by: "encounter" as const, encounterId: v.encounter.id };

    expect(await scanResolve(db, vd.actor, by, MON)).toMatchObject({ outcome: "visit", visit: { feeUnpaid: true } });
    expect(await scanResolve(db, clerk.actor, by, MON)).toMatchObject({ outcome: "visit", visit: { feeUnpaid: true } });
    expect(await scanResolve(db, dra.actor, by, MON)).toMatchObject({ outcome: "visit", visit: { feeUnpaid: false, mine: true } });
    expect(await scanResolve(db, drb.actor, by, MON)).toMatchObject({ outcome: "visit", visit: { feeUnpaid: false, mine: false } });
  });

  it("acts on a consultation are the treating doctor's alone — another doctor keeps the brief and loses the start", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const v = await open(asha.id);
    await recordVitals(db, vd.actor, v.encounter.id, adultOk, MON);

    const own = await scanResolve(db, dra.actor, { by: "encounter", encounterId: v.encounter.id }, MON);
    if (own.outcome !== "visit") throw new Error("unreachable");
    expect(own.visit).toMatchObject({ stage: "waiting", vitalsDone: true, mine: true });
    expect(own.permitted).toEqual(expect.arrayContaining(["consult", "brief", "paper"]));

    const other = await scanResolve(db, drb.actor, { by: "encounter", encounterId: v.encounter.id }, MON);
    if (other.outcome !== "visit") throw new Error("unreachable");
    expect(other.visit.mine).toBe(false);
    expect(other.permitted).toContain("brief");
    expect(other.permitted).not.toContain("consult");
    expect(other.permitted).not.toContain("paper");
  });

  it("the stage follows the visit: called, in consultation, finished", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const v = await open(asha.id);
    await recordVitals(db, vd.actor, v.encounter.id, adultOk, MON);
    const stage = async (): Promise<string> => {
      const r = await scanResolve(db, clerk.actor, { by: "patient", patientId: asha.id }, MON);
      return r.outcome === "visit" ? r.visit.stage : r.outcome;
    };
    expect(await stage()).toBe("waiting");
    await callNext(db, dra.actor, v.sessionId, MON);
    expect(await stage()).toBe("called");
    await startConsultation(db, dra.actor, v.encounter.id, MON);
    expect(await stage()).toBe("consult");
    await completeConsultation(db, dra.actor, v.encounter.id, { testsOrderedReturnToday: false }, MON);
    // Finished today is still today's visit: the slip desk's work begins here.
    expect(await stage()).toBe("done");
  });

  it("a bare token two doctors both hold is listed, never guessed; the department the slip prints settles it", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const binod = await mkPatient(db, clerk.actor);
    const a = await open(asha.id, dra.doctorId);
    const b = await open(binod.id, drb.doctorId);
    // Two queues that hand out the same number (two departments on a real day): the second token is set to the first's.
    await db.update(opdQueueEntries).set({ tokenNo: a.tokenNo }).where(eq(opdQueueEntries.encounterId, b.encounter.id));

    const r = await scanResolve(db, vd.actor, { by: "token", tokenNo: a.tokenNo! }, MON);
    if (r.outcome !== "ambiguous") throw new Error(`expected a pick list, got ${r.outcome}`);
    expect(r.candidates.map((c) => c.encounterId).sort()).toEqual([a.encounter.id, b.encounter.id].sort());
    expect(r.candidates.map((c) => c.patient.uhid).sort()).toEqual([asha.uhid, binod.uhid].sort());

    expect(await scanResolve(db, vd.actor, { by: "token", tokenNo: 99 }, MON)).toMatchObject({ outcome: "miss", reason: "unknown" });
    expect(await scanResolve(db, vd.actor, { by: "token", tokenNo: a.tokenNo!, departmentCode: "ZZZ" }, MON)).toMatchObject({ outcome: "miss", reason: "unknown" });
  });

  it("an old slip says its day and how the visit ended; only a desk that may open a visit is offered one", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const v = await open(asha.id);
    await recordVitals(db, vd.actor, v.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, v.sessionId, MON);
    await startConsultation(db, dra.actor, v.encounter.id, MON);
    await completeConsultation(db, dra.actor, v.encounter.id, { testsOrderedReturnToday: false }, MON);

    const desk = await scanResolve(db, clerk.actor, { by: "visit", visitNo: v.encounter.visitNo }, TUE);
    expect(desk).toMatchObject({ outcome: "miss", reason: "other_day", visitNo: v.encounter.visitNo, serviceDate: "2026-08-17", status: "completed" });
    if (desk.outcome !== "miss") throw new Error("unreachable");
    expect(desk.permitted).toEqual(["book", "newVisit"]);

    const nurse = await scanResolve(db, vd.actor, { by: "visit", visitNo: v.encounter.visitNo }, TUE);
    expect(nurse).toMatchObject({ outcome: "miss", reason: "other_day", permitted: [] });

    // The same person by UHID on the next day: known, and nothing is open.
    expect(await scanResolve(db, clerk.actor, { by: "uhid", uhid: asha.uhid.toLowerCase() }, TUE)).toMatchObject({ outcome: "miss", reason: "no_visit_today", patient: { uhid: asha.uhid } });

    // Yesterday's paper for a patient who HAS a visit today lands on today's visit.
    const again = await open(asha.id, dra.doctorId, TUE);
    expect(await scanResolve(db, clerk.actor, { by: "visit", visitNo: v.encounter.visitNo }, TUE)).toMatchObject({ outcome: "visit", visit: { encounterId: again.encounter.id } });
  });

  it("a visit number nobody holds, and an abandoned visit, are misses with their reason", async () => {
    const asha = await mkPatient(db, clerk.actor);
    const v = await open(asha.id);
    expect(await scanResolve(db, clerk.actor, { by: "visit", visitNo: "V9912310001" }, MON)).toMatchObject({ outcome: "miss", reason: "unknown" });
    expect(await scanResolve(db, clerk.actor, { by: "uhid", uhid: "NOPE1" }, MON)).toMatchObject({ outcome: "miss", reason: "unknown" });
    await abandonVisit(db, clerk.actor, v.encounter.id, "left", MON);
    expect(await scanResolve(db, clerk.actor, { by: "visit", visitNo: v.encounter.visitNo }, MON)).toMatchObject({ outcome: "miss", reason: "abandoned" });
  });
});
