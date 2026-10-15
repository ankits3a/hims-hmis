import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../../test/helpers/opd";
import { registrationConfig } from "../../../kernel/db/schema";
import { openVisit } from "../encounters";
import { recordVitals } from "../vitals";
import { callNext } from "../queue";
import { saveConsultNote, startConsultation } from "../consultation";
import { getPrescriptionPrint, issuePrescription } from "../prescriptions";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #607, spec SPEC-consult-complaint-button-2026-10-10 (owner APPROVED 2026-10-10):
 * "Typing in Notes sets doctorNote … the printed prescription does not show it."
 *
 * The phone's Notes drawer is the doctor's own reference (`doctor_note`). The spec moves it to its
 * own button; it must still never reach the patient's paper. The printed e-Rx is drawn ONLY from
 * `getPrescriptionPrint`'s payload (web components/rx-print.tsx renders that and nothing else), and
 * the issued FHIR document is what ABDM would carry — neither may hold the note's words. The chief
 * complaint, by contrast, IS printed, which keeps this test from passing on an empty payload.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };
const NOTE = "Private reference: query alcohol use, recheck liver enzymes next visit";

describe("#607 — the doctor's note is not printed", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("a visit with a complaint and a doctor's note: the print and the e-Rx document carry the complaint, never the note", async () => {
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    const dra = await mkDoctor(db, { username: "dra", departmentId: masters.deptId, roomId: masters.roomId });
    const clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    const vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    const patientId = (await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540111" })).id;

    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: masters.deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    await startConsultation(db, dra.actor, opened.encounter.id, MON);
    await saveConsultNote(db, dra.actor, opened.encounter.id, { chiefComplaint: "Fever", doctorNote: NOTE }, MON);

    const issued = await issuePrescription(db, dra.actor, testCfg, opened.encounter.id, {
      lines: [{ drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false }],
    }, MON);

    const print = await getPrescriptionPrint(db, testCfg, dra.actor, issued.prescriptionId);
    expect(print.encounter.chiefComplaint).toBe("Fever");
    expect(JSON.stringify(print)).not.toContain("Private reference");
    expect(Object.keys(print.encounter)).not.toContain("doctorNote");

    const doc = (await db.execute(sql`select document from opd_prescriptions where id = ${issued.prescriptionId}`)).rows[0]!["document"];
    expect(JSON.stringify(doc)).not.toContain("Private reference");
  });
});
