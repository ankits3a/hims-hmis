import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { testCfg } from "../../../test/helpers/billing";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { patients, phiAccessLog } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { issuePrescription } from "./prescriptions";
import { patientRxHistory, patientVitalsHistory } from "./history";
import type { RxLine } from "./prescriptions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07d T1 — THE TWO CROSS-VISIT HISTORIES, and the three things DD5 says they must inherit.
 *
 * Before this task there was NO way to read a prior prescription at all: the only cross-encounter
 * prescription query in the tree was the private one inside `runRxChecks`, used for interaction
 * checking and never exposed. So these two endpoints are the largest widening of record access
 * since 07a closed the confidentiality hole — which is exactly why every assertion below is about
 * the gate, the log and the merge chain rather than about the rows.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");  // 09:30 IST
const TUE = new Date("2026-08-18T04:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };
const LINES: RxLine[] = [
  { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false },
];

async function grantConfidentialRead(db: Db, roleKey: string): Promise<void> {
  const registry = new ModuleRegistry();
  registry.install({
    key: "patients", title: "Patients", menu: [],
    permissions: ["patients.confidential.read"], subscriptions: [],
  });
  await syncPermissions(db, registry);
  await grantPermissionToRole(db, registry, roleKey, "patients.confidential.read");
}

describe("opd cross-visit history (07d T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let mrd: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let open: { id: string; uhid: string };
  let sealed: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    mrd = await mkUser(db, "mrd1", ["mrd_t"]);
    // Vitals are a WORKFLOW transition (`registered→waiting`) whose declared roles are
    // vitals_desk / nurse / doctor — the record-keeper role cannot take them, which is correct.
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    await grantConfidentialRead(db, "mrd_t");
    open = await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540101" });
    sealed = await mkPatient(db, mrd.actor, {
      name: "Priya Confidential", phone: "9111111121", isConfidential: true, alias: "Guest One",
    });
  });

  /** Open a visit, take vitals, and (optionally) issue a prescription — the whole clinical path. */
  async function visit(patientId: string, at: Date, withRx: boolean): Promise<string> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, at);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, at);
    if (withRx) {
      await callNext(db, dra.actor, opened.sessionId, at);
      await startConsultation(db, dra.actor, opened.encounter.id, at);
      await issuePrescription(db, dra.actor, testCfg, opened.encounter.id, { lines: LINES }, at);
    }
    return opened.encounter.id;
  }

  const accesses = (surface: string) =>
    db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, surface));

  it("returns every prescription across visits, newest first, with the issuing doctor", async () => {
    await visit(open.id, MON, true);
    await visit(open.id, TUE, true);

    const items = await patientRxHistory(db, dra.actor, open.id);
    expect(items).toHaveLength(2);
    expect(items[0]!.issuedAt.getTime()).toBeGreaterThan(items[1]!.issuedAt.getTime());
    // The ISSUING DOCTOR is named, and it matters: E-7 says a prescription from a doctor who has
    // left must still be readable, because authorship is history rather than a permission.
    expect(items[0]!.doctorName).toBe("Dr dra");
    expect(items[0]!.doctorId).toBe(dra.doctorId);
    expect(items[0]!.serviceDate).toBe("2026-08-18");
    expect(Array.isArray(items[0]!.lines)).toBe(true);
  });

  /** A trend read backwards is a trend nobody sees — vitals come back OLDEST first, deliberately. */
  it("returns every vitals reading across visits, OLDEST first, so it reads as a trend", async () => {
    await visit(open.id, MON, false);
    await visit(open.id, TUE, false);

    const items = await patientVitalsHistory(db, dra.actor, open.id);
    expect(items).toHaveLength(2);
    expect(items[0]!.serviceDate).toBe("2026-08-17");
    expect(items[1]!.serviceDate).toBe("2026-08-18");
    expect(items[0]!.sbp).toBe(118);
  });

  /**
   * A1 — THE ASSERTION 07a EXISTS FOR, ONE PHASE LATER. A phase that widens record access without
   * widening the gate is the defect 07a closed; these two endpoints are the widest access this
   * application has ever offered.
   */
  it("A1: a sealed patient's history is refused, with the SAME answer an absent patient gives", async () => {
    await visit(sealed.id, MON, true);

    await expect(patientRxHistory(db, clerk.actor, sealed.id)).rejects.toMatchObject({ code: "patient_not_found" });
    await expect(patientVitalsHistory(db, clerk.actor, sealed.id)).rejects.toMatchObject({ code: "patient_not_found" });
    // …and the refusal is indistinguishable from one for a patient who does not exist (07a DD2),
    // because a distinct refusal confirms existence to a caller who may not know it.
    await expect(patientRxHistory(db, clerk.actor, "01NOSUCHPATIENT000000000A"))
      .rejects.toMatchObject({ code: "patient_not_found" });

    // The holder of `patients.confidential.read` reads it.
    expect(await patientRxHistory(db, mrd.actor, sealed.id)).toHaveLength(1);
    expect(await patientVitalsHistory(db, mrd.actor, sealed.id)).toHaveLength(1);
  });

  /**
   * A2 — EVERY NEW READ WRITES AN ACCESS-LOG ROW, and the two surfaces are named separately from
   * the encounter-scoped ones. "What did they actually see" is the only question the log exists for,
   * and one visit's vitals is a different answer from every reading this person has ever had.
   */
  it("A2: each history read logs its OWN surface, and a refusal logs nothing", async () => {
    await visit(open.id, MON, true);

    await patientRxHistory(db, dra.actor, open.id);
    await patientVitalsHistory(db, dra.actor, open.id);

    const rx = await accesses("opd.rx_history");
    const vitals = await accesses("opd.vitals_history");
    expect(rx).toHaveLength(1);
    expect(vitals).toHaveLength(1);
    expect(rx[0]!.actorId).toBe(dra.userId);
    expect(rx[0]!.patientId).toBe(open.id);

    // A REFUSAL PRODUCED NO PHI, so it writes no row — a row naming a patient the reader was
    // refused would be a leak inside the audit log itself.
    await expect(patientRxHistory(db, clerk.actor, sealed.id)).rejects.toThrow();
    expect(await accesses("opd.rx_history")).toHaveLength(1);
  });

  it("A2: reading a SEALED patient's history is logged as sealed", async () => {
    await visit(sealed.id, MON, true);
    await patientRxHistory(db, mrd.actor, sealed.id);

    const rows = await accesses("opd.rx_history");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sealed).toBe(true);
  });

  /**
   * A3 — THE MERGE CHAIN. A patient merged since their last visit has history under the loser id,
   * and a history that silently truncates at a merge is worse than none: the doctor sees a shorter
   * list and has no reason to doubt it.
   */
  it("A3: history spans the merge chain, from either id", async () => {
    const loser = await mkPatient(db, clerk.actor, { name: "Ramesh Old", phone: "9876540102" });
    await visit(loser.id, MON, true);
    await visit(open.id, TUE, true);
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: open.id })
      .where(eq(patients.id, loser.id));

    const fromWinner = await patientRxHistory(db, dra.actor, open.id);
    expect(fromWinner).toHaveLength(2);
    expect(fromWinner.map((i) => i.serviceDate)).toEqual(["2026-08-18", "2026-08-17"]);

    // The loser id resolves to the same history — it is the same person.
    expect((await patientRxHistory(db, dra.actor, loser.id)).map((i) => i.prescriptionId))
      .toEqual(fromWinner.map((i) => i.prescriptionId));
    expect(await patientVitalsHistory(db, dra.actor, open.id)).toHaveLength(2);
  });

  it("a patient with no history at all is an empty list, not an error", async () => {
    expect(await patientRxHistory(db, dra.actor, open.id)).toEqual([]);
    expect(await patientVitalsHistory(db, dra.actor, open.id)).toEqual([]);
  });
});
