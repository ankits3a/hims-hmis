import { asc, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdEncounterDiagnoses, opdEncounters, registrationConfig } from "../../kernel/db/schema";
import { getVisit, openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { completeConsultation, saveConsultNote, startConsultation } from "./consultation";
import { listCodedDiagnoses } from "./diagnosis-history";
import { getPrescriptionPrint, issuePrescription } from "./prescriptions";
import { OpdQueueController } from "./opd-queue.controller";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ A DIAGNOSIS IS WORDS AND A CODE, AND THE TWO MUST NOT BE ABLE TO DRIFT ═══
 *
 * Owner, 2026-09-14: the diagnosis field takes SEVERAL tags. Chief complaint solved that with no
 * schema change — tags join with " · " into the column already there. A diagnosis cannot, because
 * each tag may carry an ICD-10 code and some will not: two parallel " · " strings of different
 * lengths leave every reader guessing which code belongs to which tag, and on a claim that guess
 * is one patient's code against another patient's diagnosis.
 *
 * So `opd_encounter_diagnoses` is the structured truth and the encounter's `diagnosis` /
 * `icd10_code` columns are DERIVED from it — which is what the tests below actually pin. Nothing
 * here trusts the client to send three consistent things.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("the diagnoses of one encounter", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    patientId = (await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540111" })).id;
  });

  async function inConsult(): Promise<string> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    await startConsultation(db, dra.actor, opened.encounter.id, MON);
    return opened.encounter.id;
  }

  const rowsOf = async (encounterId: string) => db
    .select().from(opdEncounterDiagnoses)
    .where(eq(opdEncounterDiagnoses.encounterId, encounterId))
    .orderBy(asc(opdEncounterDiagnoses.seq));

  const encounterOf = async (id: string) => (await db.select().from(opdEncounters).where(eq(opdEncounters.id, id)))[0]!;

  it("X1: each tag becomes a row in the doctor's own order, keeping its own code", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [
        { text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9" },
        { text: "Type 2 diabetes mellitus without complications", icd10Code: "E11.9" },
        { text: "?viral exanthem — review in 3 days", icd10Code: null },
      ],
    }, MON);

    expect((await rowsOf(id)).map((r) => [r.seq, r.text, r.icd10Code])).toEqual([
      [0, "Acute upper respiratory infection, unspecified", "J06.9"],
      [1, "Type 2 diabetes mellitus without complications", "E11.9"],
      [2, "?viral exanthem — review in 3 days", null],
    ]);
  });

  it("X2: the display columns are DERIVED, and a client that contradicts them does not win", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [{ text: "Essential (primary) hypertension", icd10Code: "I10" }],
      /* A client sending all three could send three that disagree; these two are ignored. */
      diagnosis: "something else entirely",
      icd10Code: "Z99.9",
    }, MON);

    const enc = await encounterOf(id);
    expect(enc.diagnosis).toBe("Essential (primary) hypertension");
    expect(enc.icd10Code).toBe("I10");
  });

  it("X3: the encounter's code is the FIRST one present — the primary, even behind a free-typed tag", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [
        { text: "fever since 3 days, worse at night", icd10Code: null },
        { text: "Urinary tract infection, site not specified", icd10Code: "N39.0" },
      ],
    }, MON);

    const enc = await encounterOf(id);
    // The claim carries ONE code and this is which one it is. The prose keeps both tags.
    expect(enc.icd10Code).toBe("N39.0");
    expect(enc.diagnosis).toBe("fever since 3 days, worse at night · Urinary tract infection, site not specified");
  });

  it("X4: the comma is NOT a separator — a doctor writes commas inside one diagnosis", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [{ text: "Fever, unspecified", icd10Code: "R50.9" }],
    }, MON);
    // One tag, not two. " · " is the separator precisely because a doctor never types it.
    expect((await rowsOf(id))).toHaveLength(1);
    expect((await encounterOf(id)).diagnosis).toBe("Fever, unspecified");
  });

  it("X5: editing REPLACES — a tag the doctor deleted leaves no row behind", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [
        { text: "Acute bronchitis, unspecified", icd10Code: "J20.9" },
        { text: "Gastro-esophageal reflux disease without esophagitis", icd10Code: "K21.9" },
      ],
    }, MON);
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [{ text: "Acute bronchitis, unspecified", icd10Code: "J20.9" }],
    }, MON);

    // A MERGE would have left the reflux row on the record after the doctor removed it from screen.
    expect((await rowsOf(id)).map((r) => r.icd10Code)).toEqual(["J20.9"]);
    expect((await encounterOf(id)).icd10Code).toBe("J20.9");
  });

  it("X6: clearing the field clears the rows AND the columns", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, { diagnoses: [{ text: "Low back pain, unspecified", icd10Code: "M54.50" }] }, MON);
    await saveConsultNote(db, dra.actor, id, { diagnoses: [] }, MON);

    expect(await rowsOf(id)).toEqual([]);
    const enc = await encounterOf(id);
    expect(enc.diagnosis).toBeNull();
    expect(enc.icd10Code).toBeNull();
  });

  it("X7: a note that says NOTHING about diagnoses leaves what is recorded alone", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, { diagnoses: [{ text: "Essential (primary) hypertension", icd10Code: "I10" }] }, MON);
    /* Saving the advice must not be a way to silently erase the diagnosis. */
    await saveConsultNote(db, dra.actor, id, { advice: "Low salt diet. Review in 2 weeks." }, MON);

    expect((await rowsOf(id)).map((r) => r.icd10Code)).toEqual(["I10"]);
    expect((await encounterOf(id)).icd10Code).toBe("I10");
  });

  it("X8: an older caller sending only prose still works, and writes uncoded rows", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, { diagnosis: "Acute gastritis · Dehydration" }, MON);

    expect((await rowsOf(id)).map((r) => [r.text, r.icd10Code])).toEqual([
      ["Acute gastritis", null],
      ["Dehydration", null],
    ]);
  });

  it("X9: the rows survive the completion, and the event's code is the one on the record", async () => {
    const id = await inConsult();
    await completeConsultation(db, dra.actor, id, {
      note: { diagnoses: [{ text: "Unspecified asthma, uncomplicated", icd10Code: "J45.909" }] },
      testsOrderedReturnToday: false,
    }, MON);

    expect((await rowsOf(id)).map((r) => r.icd10Code)).toEqual(["J45.909"]);
    const enc = await encounterOf(id);
    expect(enc.status).toBe("completed");
    // `consultationCompleted` carries icd10Code off this very column, so the event cannot disagree.
    expect(enc.icd10Code).toBe("J45.909");
  });

  /*
    ═══ WHICH EYE (board "Ophthal", 2026-09-23: "each eye-code asks which eye") ═══

    ICD-10 has no laterality, so the eye is stored BESIDE the code — and only where the code is an
    eye code (`isEyeCode`, `@hmis/contracts`). An eye on an ear or a chest code means nothing, so the
    server drops it whatever the client sent. An eye code with no eye is legal: no gate is ruled.
  */
  const CATARACT = { text: "Senile nuclear cataract", icd10Code: "H25.1" };
  const DR = { text: "Type 2 diabetes mellitus with ophthalmic complications", icd10Code: "E11.3" };

  it("X10: an eye code keeps its eye; the same eye on a non-eye code is stored as null", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [
        { ...CATARACT, laterality: "od" },
        { ...DR, laterality: "os" },
        { text: "Essential (primary) hypertension", icd10Code: "I10", laterality: "od" },
        { text: "Otitis externa", icd10Code: "H60.9", laterality: "ou" },
        { text: "red eye, typed", icd10Code: null, laterality: "ou" },
      ],
    }, MON);
    expect((await rowsOf(id)).map((r) => [r.icd10Code, r.laterality])).toEqual([
      ["H25.1", "od"], ["E11.3", "os"], ["I10", null], ["H60.9", null], [null, null],
    ]);
  });

  it("X11: a note without an eye leaves it null — and the old shape still writes rows", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, { diagnoses: [CATARACT] }, MON);
    expect((await rowsOf(id)).map((r) => r.laterality)).toEqual([null]);
    await saveConsultNote(db, dra.actor, id, { diagnosis: "Cataract" }, MON);
    expect((await rowsOf(id)).map((r) => [r.text, r.laterality])).toEqual([["Cataract", null]]);
  });

  it("X12: the ROUTE keeps the field — zod strips an unknown key, so the controller is where it could vanish", async () => {
    const id = await inConsult();
    const ctl = new OpdQueueController(db, testCfg as never);
    await ctl.note(dra.actor, id, { diagnoses: [{ ...CATARACT, laterality: "ou" }] });
    expect((await rowsOf(id)).map((r) => r.laterality)).toEqual(["ou"]);
    await expect(ctl.note(dra.actor, id, { diagnoses: [{ ...CATARACT, laterality: "left" }] })).rejects.toThrow();
  });

  it("X13: every reader of the coded rows returns the eye — the visit, the coded history, the print and the e-Rx", async () => {
    const id = await inConsult();
    await saveConsultNote(db, dra.actor, id, {
      diagnoses: [{ ...CATARACT, laterality: "od" }, { text: "Essential (primary) hypertension", icd10Code: "I10" }],
    }, MON);

    /* Reopening the note: without the eye here, the next autosave would send it back blank. */
    const visit = await getVisit(db, dra.actor, id);
    expect(visit!.diagnoses).toEqual([
      { ...CATARACT, laterality: "od" }, { text: "Essential (primary) hypertension", icd10Code: "I10", laterality: null },
    ]);
    expect((await listCodedDiagnoses(db, patientId)).map((d) => [d.code, d.laterality])).toEqual([["H25.1", "od"], ["I10", null]]);

    const issued = await issuePrescription(db, dra.actor, testCfg, id, {
      lines: [{ drug: "Moxifloxacin 0.5% eye drops", dose: "1 drop", route: "topical", frequency: "QID", durationDays: 7, instructions: null, noSubstitution: false, eye: "od" }],
    }, MON);
    const print = await getPrescriptionPrint(db, testCfg, dra.actor, issued.prescriptionId);
    expect(print.encounter.diagnoses).toEqual(visit!.diagnoses);

    /* The Condition's bodySite is the primary code's eye, coded in the SNOMED the eye lines already use. */
    const bundle = (await db.execute(sql`select document from opd_prescriptions where id = ${issued.prescriptionId}`)).rows[0]!["document"] as {
      entry: { resource: Record<string, unknown> }[];
    };
    const condition = bundle.entry.map((e) => e.resource).find((r) => r["resourceType"] === "Condition")!;
    expect(condition["bodySite"]).toEqual([{ coding: [{ system: "http://snomed.info/sct", code: "18944008", display: "Right eye structure" }], text: "RIGHT EYE" }]);
  });
});
